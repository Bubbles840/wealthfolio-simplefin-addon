/**
 * shared/subscription-links.ts
 *
 * "Is HULU your Hulu?" — matching a hand-added subscription to the bank's
 * name for its charges, computed by the companion at cube build (raw charges
 * never leave the box; only the suggestions ride the cube).
 *
 * A candidate is a charge from the last LINK_WINDOW_DAYS that lands within
 * LINK_DATE_SLACK_DAYS of one of the entry's due dates (rolled backwards and
 * forwards from its stored next date) and within LINK_AMOUNT_TOLERANCE of its
 * amount. Candidates are counted per MERCHANT: one merchant charging twice is
 * one candidate; two merchants is ambiguous, and an ambiguous match is worse
 * than none (the Amazon lesson), so nothing is offered.
 */
import { subscriptionKey, type SubscriptionCharge } from './subscriptions.js';
import type { SubscriptionPrefs } from './subscription-prefs.js';
import {
  addDaysIso, addPeriod, daysBetween, declinedLinkEntry, localIsoDay, type Cadence, type CubeLink,
} from './subscription-roster.js';

export const LINK_WINDOW_DAYS = 45;
export const LINK_DATE_SLACK_DAYS = 3;
export const LINK_AMOUNT_TOLERANCE = 0.15;

/** Every due date of an entry anchored at `anchor` that falls in [from, to]. */
function dueDatesBetween(anchor: string, cadence: Cadence, from: string, to: string): string[] {
  const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
  const gap = cadence === 'yearly'
    ? Number(from.slice(0, 4)) - Number(anchor.slice(0, 4))
    : monthIndex(from) - monthIndex(anchor);
  const out: string[] = [];
  // Starting one period before `from`'s month guarantees nothing is skipped.
  for (let n = gap - 1; ; n += 1) {
    const due = addPeriod(anchor, cadence, n);
    if (due > to) break;
    if (due >= from) out.push(due);
  }
  return out;
}

/**
 * `aliasOf` (aliasNames of this build's detection) maps a renamed charge's
 * key to the entry it was joined into (F1). Without it, on Oct 25 Google's
 * renamed `GOOGLE *G1AI101M …` was offered for a hand-added Google One;
 * accepting it absorbed nothing, the roster held both, and the forecast
 * scheduled two bills.
 */
export function findLinkSuggestions(
  charges: readonly SubscriptionCharge[],
  prefs: SubscriptionPrefs,
  now: Date,
  aliasOf: ReadonlyMap<string, string> = new Map(),
): CubeLink[] {
  const today = localIsoDay(now);
  const since = addDaysIso(today, -LINK_WINDOW_DAYS);
  const recent = charges.filter((c) => c.merchant && c.cents > 0 && c.date >= since && c.date <= today);
  const entryOf = (key: string) => aliasOf.get(key) ?? key;
  // A merchant linked to ANY hand-added entry is never offered again (R2-16).
  // Both sets compare under today's key: a link or a decline saved before 1.63 may
  // carry the bank's leading reference, which no longer names the merchant (R6);
  // one saved under a renamed charge's key names the entry it was joined into (F1).
  const claimed = new Set(prefs.manual.flatMap((m) => (m.merchant ? [entryOf(subscriptionKey(m.merchant))] : [])));
  const declined = new Set(prefs.declinedLinks.map((l) => declinedLinkEntry(l, aliasOf)));
  const out: CubeLink[] = [];
  for (const m of prefs.manual) {
    if (m.merchant) continue;
    const dues = dueDatesBetween(
      m.nextDate, m.cadence,
      addDaysIso(since, -LINK_DATE_SLACK_DAYS), addDaysIso(today, LINK_DATE_SLACK_DAYS),
    );
    const byMerchant = new Map<string, { date: string; cents: number }>();
    for (const c of recent) {
      if (Math.abs(c.cents - m.cents) > m.cents * LINK_AMOUNT_TOLERANCE) continue;
      if (!dues.some((d) => Math.abs(daysBetween(d, c.date)) <= LINK_DATE_SLACK_DAYS)) continue;
      // The detector's key — the joined entry's, for a renamed charge — so
      // accepting the link absorbs the detected row.
      const merchant = entryOf(subscriptionKey(c.merchant));
      if (claimed.has(merchant) || declined.has(`${m.id}|${merchant}`)) continue;
      const seen = byMerchant.get(merchant);
      if (!seen || c.date > seen.date) byMerchant.set(merchant, { date: c.date, cents: c.cents });
    }
    if (byMerchant.size !== 1) continue;
    const [[merchant, hit]] = [...byMerchant];
    out.push({ manualId: m.id, merchant, date: hit.date, cents: hit.cents });
  }
  return out;
}
