/**
 * shared/subscriptions.ts
 *
 * Recurring-charge detection: the pure half of the Subscriptions report.
 *
 * The bar is deliberately conservative — three charges, a monthly cadence,
 * a stable price, still active. A false positive here ("your gas station is a
 * subscription") costs more trust than a missed annual plan costs money, and
 * annual charges are exactly one line a year in the reports this feeds, so
 * monthly-only is the whole ambition. The companion runs this at cube-build
 * time and publishes only the summaries; raw charges never leave the box.
 */

import { categoryRulePattern } from './rule-pattern.js';

export interface SubscriptionCharge {
  /** YYYY-MM-DD. */
  date: string;
  /** Already normalized (descriptionFromComment) — grouping key and label. */
  merchant: string;
  cents: number;
}

/**
 * v1.36 tiers, so "catch every subscription" stops fighting "no false alarms":
 *  - 'subscription': monthly cadence, stable price — the classic case, plus
 *    known brands proven with only two charges (a sub started six weeks ago
 *    was otherwise invisible for a month).
 *  - 'bill': monthly cadence, VARYING amount — gas & electric. Recurring
 *    money, but "varies" is normal there so creep never fires.
 *  - 'possible': two monthly same-price charges from an unknown merchant —
 *    on the bubble, shown separately so the user decides.
 */
export type RecurringKind = 'subscription' | 'bill' | 'possible';

export interface DetectedSubscription {
  name: string;
  /** The recurring price: the MEDIAN charge, robust against one crept month. */
  monthlyCents: number;
  count: number;
  lastDate: string;
  lastCents: number;
  /** True when the newest charge exceeds the typical price — the quiet $10.99
   *  → $11.99 that nothing else in a budget ever surfaces. Subscriptions
   *  only; a bill's variance is its nature. */
  creep: boolean;
  /** Absent on cubes from pre-1.36 companions — readers treat that as
   *  'subscription'. */
  kind?: RecurringKind;
}

/** Names that ARE subscriptions when they recur at all — two monthly charges
 *  is proof enough here. Substring match on the trimmed merchant. */
const KNOWN_SUBSCRIPTION_BRANDS = [
  'NETFLIX', 'SPOTIFY', 'HULU', 'DISNEY', 'HBO', 'MAX.COM', 'PARAMOUNT', 'PEACOCK',
  'YOUTUBE', 'APPLE.COM/BILL', 'ICLOUD', 'AMAZON PRIME', 'PRIME VIDEO', 'AUDIBLE',
  'ADOBE', 'CLAUDE', 'ANTHROPIC', 'OPENAI', 'CHATGPT', 'GITHUB', 'GOOGLE ONE',
  'DROPBOX', 'PATREON', 'TWITCH', 'CRUNCHYROLL', 'PLANET FIT', 'ONLYFANS', 'DUOLINGO',
];

const isKnownBrand = (name: string): boolean => {
  const upper = name.toUpperCase();
  return KNOWN_SUBSCRIPTION_BRANDS.some((brand) => upper.includes(brand));
};

/** Consecutive-charge gaps that still read as "monthly": a few days early for
 *  a short month or a weekend billing shift, a few late for a retry. */
const MIN_GAP_DAYS = 24;
const MAX_GAP_DAYS = 38;
/** Every charge must sit within this fraction of the median to be a "price". */
const AMOUNT_TOLERANCE = 0.15;
/** A merchant silent this long has been cancelled — the good outcome, and not
 *  one to keep nagging about. Past MAX_GAP plus a retry week. */
const ACTIVE_WITHIN_DAYS = 45;

const DAY_MS = 86_400_000;

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export function detectSubscriptions(
  charges: readonly SubscriptionCharge[],
  now: Date,
): DetectedSubscription[] {
  const byMerchant = new Map<string, SubscriptionCharge[]>();
  for (const c of charges) {
    if (!c.merchant || !(c.cents > 0)) continue;
    // Grouped by the TRIMMED merchant (same normalizer the rule flow uses):
    // banks append varying reference tokens per charge, and exact-name
    // grouping split one real subscription into groups of one — the live
    // miss this fixes.
    const key = categoryRulePattern(c.merchant) || c.merchant;
    const list = byMerchant.get(key) ?? [];
    list.push(c);
    byMerchant.set(key, list);
  }

  const found: DetectedSubscription[] = [];
  for (const [name, list] of byMerchant) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.date < b.date ? -1 : 1));

    const last = list[list.length - 1];
    const daysSinceLast = (now.getTime() - Date.parse(`${last.date}T00:00:00Z`)) / DAY_MS;
    if (!(daysSinceLast <= ACTIVE_WITHIN_DAYS)) continue;

    // Cadence and price are judged on the TRAILING three charges (two, for a
    // young group): that is the recurrence as it exists today. History
    // further back must not veto — a payment hiccup in March, or a plan
    // upgrade, is not evidence the current monthly charge isn't one.
    const recent = list.slice(-3);
    const cadenced = recent.every((c, i) => {
      if (i === 0) return true;
      const gap = (Date.parse(`${c.date}T00:00:00Z`) - Date.parse(`${recent[i - 1].date}T00:00:00Z`)) / DAY_MS;
      return gap >= MIN_GAP_DAYS && gap <= MAX_GAP_DAYS;
    });
    if (!cadenced) continue;

    const typical = median(recent.map((c) => c.cents));
    const stable = recent.every((c) => Math.abs(c.cents - typical) <= typical * AMOUNT_TOLERANCE);

    let kind: RecurringKind;
    if (list.length >= 3) {
      kind = stable ? 'subscription' : 'bill';
    } else if (stable) {
      // Two monthly charges: proof for a name that is obviously a
      // subscription, a maybe for anything else.
      kind = isKnownBrand(name) ? 'subscription' : 'possible';
    } else {
      continue;
    }

    found.push({
      name,
      monthlyCents: typical,
      count: list.length,
      lastDate: last.date,
      lastCents: last.cents,
      creep: kind === 'subscription' && last.cents > typical,
      kind,
    });
  }

  // Real recurrences above the maybes; biggest money first within each band.
  const rank = (s: DetectedSubscription) => (s.kind === 'possible' ? 1 : 0);
  return found.sort((a, b) => rank(a) - rank(b) || b.monthlyCents - a.monthlyCents);
}

/** Addon secret: merchant names the user has dismissed from the subscription
 *  roster ("cancelled that already"). The cube keeps publishing the full
 *  detection — filtering happens at every consumer, so a restore takes effect
 *  without waiting for the next sync. */
export const HIDDEN_SUBSCRIPTIONS_SECRET_KEY = 'hidden_subscriptions';

export function parseHiddenSubscriptions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : [];
  } catch {
    return [];
  }
}
