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

import { GENERIC_BANK_WORDS } from './category-guess.js';
import { categoryRulePattern } from './rule-pattern.js';

export interface SubscriptionCharge {
  /** YYYY-MM-DD. */
  date: string;
  /** Already normalized (descriptionFromComment) — grouping key and label. */
  merchant: string;
  cents: number;
  /** The Wealthfolio account charged; a charge without one is never joined to a renamed merchant. */
  accountId?: string;
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
  /** The recurring price: the MEDIAN charge, robust against one crept month —
   *  or, after a plan change (C2, 1.63), the newest charge. */
  monthlyCents: number;
  count: number;
  lastDate: string;
  lastCents: number;
  /** The charge before the newest one, when there is one — what lets the
   *  card say "$54.20 → $61.73" instead of a mute "varies". */
  prevCents?: number;
  /** True when the newest charge exceeds the typical price — the quiet $10.99
   *  → $11.99 that nothing else in a budget ever surfaces. Subscriptions
   *  only; a bill's variance is its nature. */
  creep: boolean;
  /** Absent on cubes from pre-1.36 companions — readers treat that as
   *  'subscription'. */
  kind?: RecurringKind;
  /** 1.60: the newest three charges, newest first — the "last charges" on the
   *  card's detail and in /subscriptions. Absent on older cubes; readers fall
   *  back to `lastDate`/`lastCents`. */
  recent?: Array<{ date: string; cents: number }>;
  /** 1.63 (C1): the keys of the merchants joined INTO this entry — a renamed
   *  charge's new name — never `name` itself. Absent when nothing was joined,
   *  and on older cubes. Everything outside the detector groups a charge under
   *  its own key, so each consumer that maps a charge key or a stored name to
   *  an entry treats an alias as this entry (`aliasNames`, `detectionKeys`):
   *  without it Google's renamed `GOOGLE *G1AI101M` stayed in the forecast's
   *  daily spending while the bill was also scheduled, and was offered to
   *  link and to watch as a second subscription. */
  aliases?: string[];
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

/** Two charges "agree" on a price when they sit within this fraction of each
 *  other (R9) — a repeat of the same plan, not a wandering utility bill. */
const PLAN_PRICE_AGREEMENT = 0.02;

/**
 * A one-time price step in the trailing three charges: two that agree and one
 * that is apart from them, at either end. Nick's Google One paid $5.29 for
 * three months, then upgraded on Sep 6 2026 to $21.19; the old rule saw an
 * unstable trio and filed it as a $5.29 "bill". A step is a plan change, so
 * the subscription now prices at the newest charge.
 *
 * Gas & electric (8412, 10233, 7655) has no agreeing pair, and an odd charge
 * in the MIDDLE (529, 2119, 529) is a one-off, not a step — both stay bills.
 *
 * `steppedNow` is true when the odd charge is the newest: the step landed this
 * month, so it is a rise worth flagging once. False means the step is behind us.
 */
function planChange(recent: readonly SubscriptionCharge[]): { steppedNow: boolean } | null {
  if (recent.length !== 3) return null;
  const [a, b, c] = recent.map((r) => r.cents);
  const agree = (x: number, y: number) => Math.abs(x - y) <= Math.max(x, y) * PLAN_PRICE_AGREEMENT;
  const apart = (odd: number, price: number) => Math.abs(odd - price) > price * AMOUNT_TOLERANCE;
  if (agree(a, b) && apart(c, b)) return { steppedNow: true };
  if (agree(b, c) && apart(a, b)) return { steppedNow: false };
  return null;
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/**
 * The key a merchant is grouped, hidden, confirmed and linked under: the
 * rule-flow pattern (trimmed, a bank's leading reference token and trailing
 * varying tokens dropped), or the name itself when nothing is left. Idempotent.
 *
 * Why stored choices go through it too (R6): 1.63 strips a leading reference
 * from the detector's key, so `*8712 PAYMENT LOUISVILLE GAS & ACH` became
 * `PAYMENT LOUISVILLE GAS & ACH`. A hide, watch, link or No saved under the
 * old key would silently stop applying; comparing both sides through this
 * function makes the old key and the new one the same entry.
 */
export function subscriptionKey(merchant: string): string {
  return categoryRulePattern(merchant) || merchant;
}

const BANK_WORDS = new Set(GENERIC_BANK_WORDS);

/**
 * The brand a key is known by: its first token made only of letters, 3 or
 * more (R8), that is not one of the bank's own words. `GOOGLE *G1AI101M ...`
 * is `google`; a bare reference is null.
 *
 * Why the bank's words are skipped: once the leading reference is stripped,
 * every PNC ACH row starts with `PAYMENT` (`PAYMENT LOUISVILLE GAS & ACH`),
 * and "payment" as the brand joined a cancelled insurer to a new gym that
 * happened to bill a month later at about the same price on the same account.
 * `PAYMENT LOUISVILLE GAS & ACH` is `louisville`.
 */
export function brandWord(key: string): string | null {
  return key.toLowerCase().split(/[^a-z0-9]+/).find((t) => /^[a-z]{3,}$/.test(t) && !BANK_WORDS.has(t)) ?? null;
}

/**
 * Joins a renamed charge to its old merchant. Google renamed the charge on
 * 2026-10-06 ("GOOGLE *Google One" to "GOOGLE *G1AI101M"); by Oct 22 the old
 * name had been silent 46 days and the new one had one charge, so the
 * subscription vanished. A new merchant continues an old one only when the
 * match is clear: same account, same brand word (R8), next monthly date, same
 * price, and no other candidate on either side. Ambiguity leaves both apart.
 * Each result list is oldest first, keyed by the oldest name in its chain,
 * with the keys joined into it, in chain order, as its aliases.
 * Pairs are judged against the original groups, so Map order cannot matter.
 */
function joinRenamedMerchants(
  groups: Map<string, SubscriptionCharge[]>,
): Map<string, { charges: SubscriptionCharge[]; aliases: string[] }> {
  const pairs: Array<[string, string]> = [];
  for (const [oldKey, old] of groups) {
    if (old.length < 2) continue;
    const oldLast = old[old.length - 1];
    const brand = brandWord(oldKey);
    if (!oldLast.accountId || !brand) continue;
    for (const [nextKey, next] of groups) {
      if (nextKey === oldKey) continue;
      const first = next[0];
      if (first.accountId !== oldLast.accountId || brandWord(nextKey) !== brand) continue;
      const gap = (Date.parse(`${first.date}T00:00:00Z`) - Date.parse(`${oldLast.date}T00:00:00Z`)) / DAY_MS;
      // Fails closed: a date that does not parse is a NaN gap, which no range
      // test rejects — it would join, and become the entry's last charge.
      if (!(gap >= MIN_GAP_DAYS && gap <= MAX_GAP_DAYS)) continue;
      if (Math.abs(first.cents - oldLast.cents) > oldLast.cents * AMOUNT_TOLERANCE) continue;
      pairs.push([oldKey, nextKey]);
    }
  }
  const asOld = new Map<string, number>();
  const asNext = new Map<string, number>();
  for (const [o, n] of pairs) {
    asOld.set(o, (asOld.get(o) ?? 0) + 1);
    asNext.set(n, (asNext.get(n) ?? 0) + 1);
  }
  const continuation = new Map<string, string>();
  for (const [o, n] of pairs) if (asOld.get(o) === 1 && asNext.get(n) === 1) continuation.set(o, n);
  const continued = new Set(continuation.values());

  const joined = new Map<string, { charges: SubscriptionCharge[]; aliases: string[] }>();
  for (const [key, list] of groups) {
    if (continued.has(key)) continue;
    const charges = [...list];
    const aliases: string[] = [];
    for (let k = continuation.get(key); k !== undefined; k = continuation.get(k)) {
      charges.push(...groups.get(k)!);
      aliases.push(k);
    }
    joined.set(key, { charges, aliases });
  }
  return joined;
}

/** Every key a detection answers to: its name, then the keys joined into it
 *  (F1). The cube is not validated past its required fields, so a malformed
 *  `aliases` is ignored rather than trusted. */
export function detectionKeys(d: DetectedSubscription): string[] {
  const aliases = Array.isArray(d.aliases) ? d.aliases : [];
  return [d.name, ...aliases.filter((a): a is string => typeof a === 'string' && a !== '' && a !== d.name)];
}

/** Each joined key → the name of the entry it was joined into (F1): what a
 *  charge grouped under `GOOGLE *G1AI101M …`, or a choice stored under it,
 *  belongs to. Empty for an older cube, so nothing changes there. */
export function aliasNames(detected: readonly DetectedSubscription[] | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of detected ?? []) {
    for (const alias of detectionKeys(d).slice(1)) if (!out.has(alias)) out.set(alias, d.name);
  }
  return out;
}

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
    const key = subscriptionKey(c.merchant);
    const list = byMerchant.get(key) ?? [];
    list.push(c);
    byMerchant.set(key, list);
  }

  for (const list of byMerchant.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));

  const found: DetectedSubscription[] = [];
  for (const [name, { charges: list, aliases }] of joinRenamedMerchants(byMerchant)) {
    if (list.length < 2) continue;

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

    const change = list.length >= 3 && !stable ? planChange(recent) : null;

    // Nothing with a monthly cadence vanishes any more — v1.37's rule, after
    // a plan upgrade made a real subscription's two charges "unstable" and
    // silently disappear. Stability only decides WHICH tier.
    let kind: RecurringKind;
    if (list.length >= 3) {
      kind = stable || change ? 'subscription' : 'bill';
    } else {
      kind = isKnownBrand(name) ? 'subscription' : 'possible';
    }

    found.push({
      name,
      // Across an upgrade the median is a price nobody pays — the newest
      // charge is the plan as it exists now.
      monthlyCents: change ? last.cents : (stable ? typical : (list.length >= 3 ? typical : last.cents)),
      count: list.length,
      lastDate: last.date,
      lastCents: last.cents,
      ...(list.length >= 2 ? { prevCents: list[list.length - 2].cents } : {}),
      // A step up is a rise in the month it lands, and only then.
      creep: kind === 'subscription'
        && ((stable && last.cents > typical) || (!!change?.steppedNow && last.cents > recent[1].cents)),
      kind,
      // `recent` above is the trailing three, oldest first.
      recent: [...recent].reverse().map((c) => ({ date: c.date, cents: c.cents })),
      ...(aliases.length > 0 ? { aliases } : {}),
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

/** Addon secret: candidates the user answered "yes, that's a subscription"
 *  about — rent, a utility, anything the detector could only guess at. A
 *  confirmed name counts in every money total from then on, whatever tier
 *  the detector assigns it. */
export const CONFIRMED_SUBSCRIPTIONS_SECRET_KEY = 'confirmed_subscriptions';

export function parseHiddenSubscriptions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : [];
  } catch {
    return [];
  }
}
