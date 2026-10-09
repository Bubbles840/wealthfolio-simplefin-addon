/**
 * shared/refused-alerts.ts
 *
 * Which refused imports have already been announced.
 *
 * A transaction Wealthfolio refuses as a duplicate is never stored, so the next
 * sync plans the same create, is refused the same way, and — before this —
 * sent the same "not imported" message again: every sync, every six hours,
 * until the transaction aged out of the bank feed. The alert exists because a
 * refusal once hid a real $1,300 withdrawal, so it must still be said; it only
 * needs saying once.
 *
 * Both writers (companion and addon) read and write the same secret, so a
 * refusal announced by one is not announced again by the other.
 */

export const REFUSED_ALERTED_SECRET_KEY = 'refused_creates_alerted';

/** Long past any bank feed's window: a refusal older than this cannot recur. */
const KEEP_DAYS = 120;

type Refusal = { txId: string; amountCents: number; date: string };

/** Identity of one refusal. The amount and date ride along so a bank that
 *  reuses a transaction id for a different charge is announced afresh. */
export function refusalKey(r: Refusal): string {
  return `${r.txId}|${r.amountCents}|${r.date}`;
}

/** `{ key: firstAnnouncedIso }`; garbage reads as empty (= announce again,
 *  the safe direction for an alert about possibly-missing money). */
export function parseAnnouncedRefusals(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** The refusals not yet announced. */
export function unannouncedRefusals<T extends Refusal>(rows: readonly T[], announced: Record<string, string>): T[] {
  return rows.filter((r) => !announced[refusalKey(r)]);
}

/** The record after announcing `rows`, with entries older than KEEP_DAYS dropped. */
export function withAnnouncedRefusals(
  announced: Record<string, string>,
  rows: readonly Refusal[],
  now: Date,
): Record<string, string> {
  const cutoff = now.getTime() - KEEP_DAYS * 86_400_000;
  const next: Record<string, string> = {};
  for (const [key, at] of Object.entries(announced)) {
    if (Date.parse(at) >= cutoff) next[key] = at;
  }
  for (const r of rows) next[refusalKey(r)] ??= now.toISOString();
  return next;
}
