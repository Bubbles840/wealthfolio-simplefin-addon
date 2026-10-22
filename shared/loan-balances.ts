/**
 * shared/loan-balances.ts
 *
 * A SimpleFin account for a loan (a mortgage servicer, a car loan) has nothing
 * to import that Wealthfolio wants: the payments already arrive as withdrawals
 * from the account that paid them. What it has is the servicer's balance, and
 * a Wealthfolio loan (a liability) otherwise only knows its balance from its
 * terms, an estimate that drifts with every extra payment or rate rounding.
 *
 * Linked to a liability, the account's balance is written each sync as that
 * day's recorded balance: the same manual quote Wealthfolio's own "Confirm
 * balance" saves (`ConfirmBalance` in crates/core/src/assets/loan/actions.rs),
 * which every loan calculation takes over its estimate from that day on.
 *
 * Pure: the store reads the links, the hosts read and write the quotes.
 */
import { calendarDay } from './holdings.js';
import type { SimplefinAccount } from './types.js';

export const LOAN_LINKS_SECRET_KEY = 'loan_links';

/** SimpleFin account id → the Wealthfolio liability (asset id) it confirms. */
export type LoanLinks = Record<string, string>;

/** The stored links, dropping anything that is not a string-to-string entry. */
export function parseLoanLinks(raw: string | null | undefined): LoanLinks {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const links: LoanLinks = {};
  for (const [sfinId, assetId] of Object.entries(parsed)) {
    if (typeof assetId === 'string' && assetId.trim()) links[sfinId] = assetId.trim();
  }
  return links;
}

/**
 * Wealthfolio's provenance for a confirmed balance, with "SimpleFin" as the
 * note it shows beside it (`balance_notes` in crates/core/src/assets/loan/model.rs:
 * provenance, then `|note=` and the URL-encoded note). The note is also how the
 * sync tells its own balances from ones the person recorded.
 */
export const LOAN_BALANCE_NOTES = 'loan_event|type=balance_correction|note=SimpleFin';

/** One day's balance to record on a loan. */
export interface LoanBalance {
  /** `YYYY-MM-DD`, the feed's balance date on the local calendar. */
  date: string;
  /** What is owed, as a positive decimal string. */
  balance: string;
  currency: string;
}

/**
 * The balance a loan's feed reports, or null when there is none to record.
 *
 * Servicers report what is owed as a negative balance, some as positive; either
 * way the loan's balance is its size. A zero is left alone: it can mean paid
 * off, but it is also what a feed shows while it is broken, and recording it
 * would close the loan in Wealthfolio.
 */
export function loanBalanceOf(
  account: SimplefinAccount,
  options: { timeZone?: string | null; now?: Date } = {},
): LoanBalance | null {
  const balance = canonical(account.balance ?? '');
  if (balance === null || balance === '0') return null;
  // Dated like a holdings snapshot: the balance's own date, on the local
  // calendar, never after today.
  const day = calendarDay(new Date(account['balance-date'] * 1000), options.timeZone);
  const today = calendarDay(options.now ?? new Date(), options.timeZone);
  return {
    date: day > today ? today : day,
    balance,
    currency: account.currency,
  };
}

/** A recorded balance on the loan, as much of the quote as the decision reads. */
export interface LoanQuote {
  /** `YYYY-MM-DD` (a full timestamp is cut to its date). */
  date: string;
  close: string | number;
  dataSource: string;
  notes?: string | null;
}

export type LoanBalanceDecision = 'write' | 'unchanged' | 'theirs';

/** A decimal as its size, with no sign or padding zeros: "-0100.50" → "100.5". */
function canonical(value: string | number): string | null {
  const match = /^[+-]?(\d+)(?:\.(\d*))?$/.exec(String(value).trim());
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

const sameAmount = (a: string | number, b: string) => {
  const ca = canonical(a);
  return ca !== null && ca === canonical(b);
};

/**
 * Whether to record `entry`. Wealthfolio keeps one manual balance per loan per
 * day, so a write replaces whatever is recorded that day:
 *
 *  - `unchanged`: the day already has this balance. Writing it again would only
 *    start another portfolio recalculation.
 *  - `theirs`: the day has a balance the person recorded (any manual quote
 *    without the sync's note). Theirs stands; the feed's goes in tomorrow.
 *  - `write`: otherwise, including replacing the sync's own earlier balance.
 */
export function decideLoanBalance(existing: readonly LoanQuote[], entry: LoanBalance): LoanBalanceDecision {
  const sameDay = existing.filter((q) => String(q.date).slice(0, 10) === entry.date && q.dataSource === 'MANUAL');
  if (sameDay.some((q) => q.notes !== LOAN_BALANCE_NOTES)) return 'theirs';
  if (sameDay.some((q) => sameAmount(q.close, entry.balance))) return 'unchanged';
  return 'write';
}

/** The manual quote Wealthfolio saves for a confirmed balance. Its id is
 *  rebuilt by Wealthfolio from the asset, the day and the source.
 *
 *  The amounts are JSON numbers, the one place this module leaves decimal
 *  strings: Wealthfolio reads a quote's amounts as floats (rust_decimal's
 *  `serde-float`), refuses a string there, and the SDK types them as numbers. */
export function loanBalanceQuote(assetId: string, entry: LoanBalance, now = new Date()) {
  const amount = Number(entry.balance);
  return {
    id: `${assetId}_${entry.date}_MANUAL`,
    assetId,
    timestamp: `${entry.date}T00:00:00Z`,
    open: amount,
    high: amount,
    low: amount,
    close: amount,
    adjclose: amount,
    volume: 0,
    currency: entry.currency,
    dataSource: 'MANUAL' as const,
    createdAt: now.toISOString(),
    notes: LOAN_BALANCE_NOTES,
  };
}

export type LoanQuoteWrite = ReturnType<typeof loanBalanceQuote>;

/** The two quote calls a host supplies. */
export interface LoanBalanceIo {
  history(assetId: string): Promise<LoanQuote[]>;
  write(assetId: string, quote: LoanQuoteWrite): Promise<void>;
}

/** Records `entry` on the loan unless the decision above says not to. */
export async function confirmLoanBalance(
  io: LoanBalanceIo,
  assetId: string,
  entry: LoanBalance,
): Promise<LoanBalanceDecision> {
  const decision = decideLoanBalance(await io.history(assetId), entry);
  if (decision === 'write') await io.write(assetId, loanBalanceQuote(assetId, entry));
  return decision;
}
