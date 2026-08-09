/**
 * What "still needs a category" means — defined ONCE, for both syncers.
 *
 * The companion sizes its published count with this; the addon renders its list
 * with it. They must agree, because they are answering the same question in two
 * places, and during the v1.10.0 work three separate bugs came from exactly that
 * shape of duplication (a diagnostic that classified messages differently from
 * the poll; a tile that ignored the dismissals the sweep honoured; a check
 * script that disagreed with the sync). One function, imported twice.
 */

/** Dismissed activity id → when it was dismissed (ISO). */
export interface DismissalLedger {
  [activityId: string]: string;
}

/** One uncategorized transaction, as published for the addon to render. */
export interface UncategorizedRow {
  activityId: string;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  /** Magnitude in cents — sign is not meaningful here. */
  amountCents: number;
  /** Display text, already stripped of bookkeeping decorations. */
  description: string;
  accountName: string;
}

/**
 * How long a dismissal is kept.
 *
 * A dismissed row leaves the sweep window weeks before this, so entries only
 * need to outlive the window, not the account — otherwise the secret grows
 * forever.
 */
export const DISMISSAL_MAX_AGE_DAYS = 60;

/**
 * How many rows the companion publishes.
 *
 * The list is capped and the COUNT is not: a truncated list must never make the
 * tile understate the real backlog.
 */
export const UNCATEGORIZED_ROWS_CAP = 50;

/** Drop ledger entries old enough to be inert. An unparseable timestamp is
 *  dropped rather than kept forever — it can never be compared against. */
export function pruneDismissals(ledger: DismissalLedger, now: Date): DismissalLedger {
  const cutoff = now.getTime() - DISMISSAL_MAX_AGE_DAYS * 86400_000;
  const pruned: DismissalLedger = {};
  for (const [id, at] of Object.entries(ledger)) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) pruned[id] = at;
  }
  return pruned;
}

/**
 * The rows that still need a category: everything not dismissed.
 *
 * Generic over the row shape so the companion can pass its richer native row and
 * the addon its published one, without either converting first.
 */
export function visibleUncategorized<T extends { activityId: string }>(
  rows: T[],
  ledger: DismissalLedger,
): T[] {
  return rows.filter((r) => !(r.activityId in ledger));
}
