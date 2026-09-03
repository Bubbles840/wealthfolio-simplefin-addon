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

export interface SubscriptionCharge {
  /** YYYY-MM-DD. */
  date: string;
  /** Already normalized (descriptionFromComment) — grouping key and label. */
  merchant: string;
  cents: number;
}

export interface DetectedSubscription {
  name: string;
  /** The recurring price: the MEDIAN charge, robust against one crept month. */
  monthlyCents: number;
  count: number;
  lastDate: string;
  lastCents: number;
  /** True when the newest charge exceeds the typical price — the quiet $10.99
   *  → $11.99 that nothing else in a budget ever surfaces. */
  creep: boolean;
}

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
    const list = byMerchant.get(c.merchant) ?? [];
    list.push(c);
    byMerchant.set(c.merchant, list);
  }

  const found: DetectedSubscription[] = [];
  for (const [name, list] of byMerchant) {
    if (list.length < 3) continue;
    list.sort((a, b) => (a.date < b.date ? -1 : 1));

    const last = list[list.length - 1];
    const daysSinceLast = (now.getTime() - Date.parse(`${last.date}T00:00:00Z`)) / DAY_MS;
    if (!(daysSinceLast <= ACTIVE_WITHIN_DAYS)) continue;

    const cadenced = list.every((c, i) => {
      if (i === 0) return true;
      const gap = (Date.parse(`${c.date}T00:00:00Z`) - Date.parse(`${list[i - 1].date}T00:00:00Z`)) / DAY_MS;
      return gap >= MIN_GAP_DAYS && gap <= MAX_GAP_DAYS;
    });
    if (!cadenced) continue;

    const typical = median(list.map((c) => c.cents));
    if (!list.every((c) => Math.abs(c.cents - typical) <= typical * AMOUNT_TOLERANCE)) continue;

    found.push({
      name,
      monthlyCents: typical,
      count: list.length,
      lastDate: last.date,
      lastCents: last.cents,
      creep: last.cents > typical,
    });
  }

  return found.sort((a, b) => b.monthlyCents - a.monthlyCents);
}
