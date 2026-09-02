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
  /** Magnitude in cents — sign is not meaningful here; `direction` is. */
  amountCents: number;
  /** Display text, already stripped of bookkeeping decorations. */
  description: string;
  accountName: string;
  /** Which way the money moved. Optional — a status published by an older
   *  companion simply renders unsigned, as it always did. */
  direction?: 'in' | 'out';
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
 * Apply a caller's delta onto whatever is persisted RIGHT NOW, instead of
 * overwriting the secret with a stale snapshot.
 *
 * Both the addon and the companion read `uncategorized_dismissals`, let the user
 * act, and write it back — and there is no compare-and-swap on an addon secret,
 * just `get` then `set`. A plain "write what I have" from either side silently
 * erases whatever the OTHER side wrote in between: the addon overwrites with a
 * snapshot `refreshDerivedSignals` only re-reads on an interval or focus, and the
 * companion writes from TWO places of its own — a Telegram button tap, recorded
 * the moment the listener collects it, and a sync's prune. Every one of those
 * writers reads, then writes a round trip later, and there are three of them, so
 * a write from any stale copy can erase either other host's entry. That is why
 * each of them re-reads immediately before writing and replays only its delta;
 * the symptom otherwise is a row the user already dismissed reappearing as needing a category
 * — quietly, because nothing errors, one host just clobbers the other's ledger
 * entry.
 *
 * `base` is the ledger the caller read before acting; `next` is what the caller
 * wants the ledger to become. The DIFFERENCE between them is the caller's
 * intent — an id added, or an id removed (an undo, or a prune) — and only that
 * intent is replayed onto `persisted`:
 *  - in `next` but not `base`: added, so set it on the result (`next`'s value).
 *  - in `base` but not `next`: removed, so delete it from the result.
 *  - anything else — including an id `persisted` has that neither snapshot ever
 *    saw, and an id present in both `base` and `next` even with a different
 *    timestamp — is left exactly as `persisted` already has it. An id in both
 *    is not a delta; re-asserting it would let a stale `next` timestamp
 *    overwrite a fresher one the other host just wrote.
 */
export function mergeDismissals(
  persisted: DismissalLedger,
  base: DismissalLedger,
  next: DismissalLedger,
): DismissalLedger {
  const merged: DismissalLedger = { ...persisted };
  for (const id of Object.keys(next)) {
    if (!(id in base)) merged[id] = next[id];
  }
  for (const id of Object.keys(base)) {
    if (!(id in next)) delete merged[id];
  }
  return merged;
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
