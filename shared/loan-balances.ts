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
  /** What is owed, as a non-negative decimal string ("0" for a feed showing
   *  nothing owed). */
  balance: string;
  /** The FEED's currency, possibly blank. Only checked against the loan's: the
   *  quote is always written in the loan's own currency. */
  currency: string;
}

/** A Wealthfolio loan a feed can be linked to, as much as the decision reads. */
export interface LinkedLoan {
  id: string;
  name: string;
  currency: string;
  /** `YYYY-MM-DD`, from the loan's `origination_date`, when it has one. */
  originationDate?: string;
}

/** The loans among Wealthfolio's alternative assets (kind `liability`), from
 *  `alternativeAssets.getAll` or `GET /alternative-holdings`; anything that is
 *  not a liability with an id is dropped. */
export function linkedLoansOf(holdings: unknown): LinkedLoan[] {
  if (!Array.isArray(holdings)) return [];
  const loans: LinkedLoan[] = [];
  for (const h of holdings as Array<Record<string, unknown>>) {
    if (!h || h.kind !== 'liability' || typeof h.id !== 'string' || !h.id) continue;
    const meta = (h.metadata && typeof h.metadata === 'object' ? h.metadata : {}) as Record<string, unknown>;
    const origination = typeof meta.origination_date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(meta.origination_date)
      ? meta.origination_date.slice(0, 10) : undefined;
    loans.push({
      id: h.id,
      name: typeof h.name === 'string' ? h.name : h.id,
      currency: typeof h.currency === 'string' ? h.currency.trim() : '',
      ...(origination ? { originationDate: origination } : {}),
    });
  }
  return loans;
}

/**
 * The balance a loan's feed reports, or null when there is nothing readable:
 * no number, or no usable balance date.
 *
 * Servicers report what is owed as a negative balance, some as positive; either
 * way the loan's balance is its size. Dated like a holdings snapshot: the
 * balance's own date, on the local calendar, never after today.
 */
export function loanBalanceOf(
  account: SimplefinAccount,
  options: { timeZone?: string | null; now?: Date } = {},
): LoanBalance | null {
  const balance = canonical(account.balance ?? '');
  if (balance === null) return null;
  const at = new Date(Number(account['balance-date']) * 1000);
  if (!Number.isFinite(at.getTime())) return null;
  const day = calendarDay(at, options.timeZone);
  const today = calendarDay(options.now ?? new Date(), options.timeZone);
  return {
    date: day > today ? today : day,
    balance,
    currency: String(account.currency ?? '').trim(),
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

/** Upstream's note on the zero a loan's Close records (`LOAN_CLOSED_NOTE`). */
export const LOAN_CLOSED_NOTES = 'loan_closed';

export type LoanBalanceDecision =
  /** Recorded. */
  | 'write'
  /** The latest recorded balance on or before the date already says this. */
  | 'unchanged'
  /** The day has a balance the person recorded: theirs stands. */
  | 'theirs'
  /** The loan was closed, or confirmed at zero, on or before the date: never
   *  reopened from the feed. */
  | 'closed'
  /** The feed shows nothing owed (to the cent) on an open loan: reported, so the
   *  person can close it; never written (it would close the loan on the feed's word). */
  | 'zero'
  /** The feed's currency is set and is not the loan's: reported, not written. */
  | 'currency'
  /** The date is before the loan's origination, which Wealthfolio refuses. */
  | 'early';

/** A decimal as its size, with no sign or padding zeros: "-0100.50" → "100.5". */
function canonical(value: string | number): string | null {
  const match = /^[+-]?(\d+)(?:\.(\d*))?$/.exec(String(value).trim());
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, '');
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** A non-negative decimal string rounded half up to cents, as Wealthfolio's own
 *  Confirm balance stores it ("250000.905" → "250000.91"). */
export function toCents(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  let cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1n;
  const c = (cents % 100n).toString().padStart(2, '0');
  return canonical(`${cents / 100n}.${c}`)!;
}

const sameAmount = (a: string | number, b: string) => {
  const ca = canonical(a);
  return ca !== null && toCents(ca) === toCents(b);
};

const isZero = (value: string | number) => {
  const c = canonical(value);
  return c !== null && toCents(c) === '0';
};

const hasProvenance = (notes: string | null | undefined, provenance: string) =>
  !!notes && notes.startsWith(provenance) && (notes.length === provenance.length || notes[provenance.length] === '|');

/**
 * Whether to record `entry` on `loan`, given its recorded balances. A
 * confirmation overrides the estimate and every tagged payment from its date,
 * so the feed is written only when it says something new (`unchanged`), never
 * over the person's own word for the day (`theirs`), and never onto a closed
 * loan (`closed`) — Wealthfolio reads a balance after a close as reopening it.
 *
 * Closed is the loan's latest manual quote being a confirmed zero ("A confirmed
 * zero balance closes the loan", docs/architecture/loans.md): what Close writes,
 * and also what a person's own zero confirmation or Wealthfolio 3.9 left, with
 * or without the `loan_closed` note.
 */
export function decideLoanBalance(
  loan: LinkedLoan,
  existing: readonly LoanQuote[],
  entry: LoanBalance,
): LoanBalanceDecision {
  if (entry.currency && loan.currency && entry.currency.toUpperCase() !== loan.currency.toUpperCase()) return 'currency';
  const upTo = existing
    .filter((q) => q.dataSource === 'MANUAL' && String(q.date).slice(0, 10) <= entry.date)
    .sort((a, b) => (String(a.date).slice(0, 10) < String(b.date).slice(0, 10) ? 1 : -1));
  const latest = upTo[0];
  if (latest && (hasProvenance(latest.notes, LOAN_CLOSED_NOTES) || isZero(latest.close))) return 'closed';
  if (toCents(entry.balance) === '0') return 'zero';
  if (loan.originationDate && entry.date < loan.originationDate) return 'early';
  const sameDay = upTo.filter((q) => String(q.date).slice(0, 10) === entry.date);
  if (sameDay.some((q) => q.notes !== LOAN_BALANCE_NOTES)) return 'theirs';
  if (latest && sameAmount(latest.close, entry.balance)) return 'unchanged';
  return 'write';
}

/** The manual quote Wealthfolio saves for a confirmed balance, in the loan's
 *  currency and rounded to cents. Its id is rebuilt by Wealthfolio from the
 *  asset, the day and the source.
 *
 *  The amounts are JSON numbers, the one place this module leaves decimal
 *  strings: Wealthfolio reads a quote's amounts as floats (rust_decimal's
 *  `serde-float`), refuses a string there, and the SDK types them as numbers. */
export function loanBalanceQuote(loan: LinkedLoan, entry: LoanBalance, now = new Date()) {
  const amount = Number(toCents(entry.balance));
  return {
    id: `${loan.id}_${entry.date}_MANUAL`,
    assetId: loan.id,
    timestamp: `${entry.date}T00:00:00Z`,
    open: amount,
    high: amount,
    low: amount,
    close: amount,
    adjclose: amount,
    volume: 0,
    currency: loan.currency,
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

/** Records `entry` on `loan` unless the decision above says not to. */
export async function confirmLoanBalance(
  io: LoanBalanceIo,
  loan: LinkedLoan,
  entry: LoanBalance,
): Promise<LoanBalanceDecision> {
  const decision = decideLoanBalance(loan, await io.history(loan.id), entry);
  if (decision === 'write') await io.write(loan.id, loanBalanceQuote(loan, entry));
  return decision;
}
