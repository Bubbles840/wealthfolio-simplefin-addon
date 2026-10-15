/**
 * shared/spending-tripwire.ts
 *
 * The tripwire of 1.62 (ruling W5): after every companion sync the audit
 * snapshot (shared/audit-snapshot.ts) carries both spent figures for the
 * month — the report's (the cube's) and Wealthfolio's Spending page's
 * `headline.spent` — and since the report counts spending exactly as
 * Wealthfolio does (shared/wf-spending.ts) they should be equal. More than a
 * cent apart is a finding: the daily report says so in Brief and Full, and the
 * app's status strip shows it. It clears itself on the first sync where the
 * two agree again; it is never snoozed.
 *
 * A figure that could not be read is never read as agreement — and never as
 * a difference: nothing is said. Neither is a snapshot from another month.
 */
import { changeMoney } from './change-entries.js';
import type { HeadlineExplanation } from './audit-headline.js';
import type { AuditSnapshotRead } from './audit-snapshot.js';
import type { SelfCheckFinding } from './self-check.js';

/** Within this many cents the two figures agree. */
export const TRIPWIRE_TOLERANCE_CENTS = 1;

export type TripwireState =
  | { kind: 'agree' }
  | { kind: 'differ'; month: string; diffCents: number }
  /** A figure is unread, or the snapshot is another month's: no claim. */
  | { kind: 'unknown' };

const monthOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Compare the two figures `h` holds (less what the report does not cover), for `now`'s month. */
export function spendingTripwire(h: Pick<HeadlineExplanation, 'month' | 'reportCents' | 'wealthfolioCents' | 'reasons'> | null | undefined, now: Date): TripwireState {
  if (!h || h.month !== monthOf(now) || h.reportCents === null || h.wealthfolioCents === null || h.reasons === null) return { kind: 'unknown' };
  // LU-J: the report covers only the accounts the add-on syncs; the rest of
  // Wealthfolio's total is the headline's explained `not-covered` reason, not
  // a daily warning. Foreign-currency stays counted.
  const notCovered = h.reasons.find((r) => r.kind === 'not-covered')?.cents ?? 0;
  const diffCents = h.reportCents - h.wealthfolioCents - notCovered;
  return Math.abs(diffCents) > TRIPWIRE_TOLERANCE_CENTS ? { kind: 'differ', month: h.month, diffCents } : { kind: 'agree' };
}

/** The tripwire as the published snapshot says it; unknown when it cannot be read. */
export function snapshotTripwire(read: AuditSnapshotRead | null | undefined, now: Date): TripwireState {
  return read?.kind === 'ok' ? spendingTripwire(read.snapshot.headline, now) : { kind: 'unknown' };
}

/** "The report and Wealthfolio differ by $951.45 this month". Raw; no emoji. */
export function tripwireLine(t: TripwireState): string | null {
  return t.kind === 'differ' ? `The report and Wealthfolio differ by ${changeMoney(Math.abs(t.diffCents))} this month` : null;
}

/** The daily report's finding: printed in full in Brief and Full alike
 *  (`printsInFull`), as "⚠️ The report and Wealthfolio differ by $X this month
 *  — /audit explains". No key, so it cannot be snoozed. */
export function tripwireFinding(t: TripwireState): SelfCheckFinding | null {
  const line = tripwireLine(t);
  return line ? { kind: 'spending-differs', severity: 'warning', message: `${line} — /audit explains` } : null;
}
