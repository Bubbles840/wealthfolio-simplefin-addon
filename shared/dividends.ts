/**
 * shared/dividends.ts
 *
 * A dividend the bank names the security of, booked as a Wealthfolio
 * DIVIDEND on that security instead of a cash deposit, so the Income page can
 * say which holding paid it. Wealthfolio refuses a DIVIDEND without a security,
 * which is why a DIVIDEND transaction rule could not work before this.
 *
 * Narrow on purpose: a security is only named when a known bank wording
 * carries its ticker AND the account holds exactly one security under that
 * ticker, or, holding none, has its earlier dividends under that ticker booked
 * on exactly one (a dividend paid after the position was sold). Anything less
 * stays what it was. A wrong match would credit income to the wrong holding; a
 * missed one only leaves a deposit.
 *
 * Who decides, as everywhere in the sync: a transaction rule the person wrote
 * wins. Without one, a known wording is recognised by itself.
 *
 * Once booked, a dividend stays on its security: a later sync that can't name
 * one (the position sold since, a failed holdings read, the other writer not
 * new enough yet) leaves a stored DIVIDEND on a security as it is
 * (`FeedTx.keepDividend`). Only a sync that names a security moves the row.
 *
 * Pure: sync-core reads the holdings and stored rows and writes; this module
 * only decides.
 */
import type { MappedType } from './mapper.js';

/**
 * One bank's dividend wording. `ticker` returns the ticker the text names, or
 * null when the text is not this bank's dividend line. To add a bank: one
 * entry here, and its real wording in dividends.test.ts.
 */
export interface DividendPattern {
  bank: string;
  ticker(description: string): string | null;
}

export const DIVIDEND_PATTERNS: readonly DividendPattern[] = [
  {
    // `DIVIDEND RECEIVED VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)`
    bank: 'Fidelity',
    ticker: (d) => /^\s*DIVIDEND RECEIVED\b.*\(([A-Z][A-Z0-9.]{0,9})\)\s*\(Cash\)\s*$/i.exec(d)?.[1]?.toUpperCase() ?? null,
  },
];

/** The ticker a known dividend wording names, or null. */
export function dividendTicker(description: string): string | null {
  for (const p of DIVIDEND_PATTERNS) {
    const t = p.ticker(description);
    if (t) return t;
  }
  return null;
}

/** A security an account holds, as the holdings read reports it: Wealthfolio's
 *  asset id and its display code. */
export interface HeldSecurity {
  assetId: string;
  symbol: string;
}

/** The securities in a holdings read (the SDK's `portfolio.getHoldings`, or
 *  `GET /holdings?accountId=`): each holding's `instrument` id and display code. */
export function heldSecuritiesOf(holdings: unknown): HeldSecurity[] {
  if (!Array.isArray(holdings)) return [];
  const out: HeldSecurity[] = [];
  for (const h of holdings) {
    const i = (h as { instrument?: { id?: unknown; symbol?: unknown } | null } | null)?.instrument;
    if (i && typeof i.id === 'string' && i.id && typeof i.symbol === 'string' && i.symbol) out.push({ assetId: i.id, symbol: i.symbol });
  }
  return out;
}

/** The one held security shown under `ticker`, or null when none or more than
 *  one is (two listings can share a display code). */
export function heldSecurityFor(ticker: string, held: readonly HeldSecurity[]): HeldSecurity | null {
  const key = ticker.trim().toUpperCase();
  const hits = held.filter((h) => h.symbol.trim().toUpperCase() === key);
  return hits.length === 1 ? hits[0] : null;
}

/** An account type whose dividends this books: not cash or a card, where a
 *  DIVIDEND would drop out of the Spending page's income. */
export const isInvestmentAccountType = (accountType: string | undefined): boolean =>
  !!accountType && accountType !== 'CASH' && accountType !== 'CREDIT_CARD';

export type DividendDecision =
  | { type: 'DIVIDEND'; assetId: string }
  | { type: 'INTEREST' }
  | null;

/**
 * Whether this feature decides the row at all, from the text alone (no
 * holdings read): money in that a rule typed DIVIDEND, or that no rule typed
 * and the plain mapping calls a DEPOSIT, in an investment account, with a known
 * dividend wording. A rule typed anything else wins, as everywhere.
 */
export function isDividendRow(row: {
  mapped: MappedType;
  amount: number;
  accountType: string | undefined;
  description: string;
}): boolean {
  if (!(row.amount > 0)) return false;
  if (row.mapped.fromRule) return row.mapped.type === 'DIVIDEND';
  return row.mapped.type === 'DEPOSIT' && isInvestmentAccountType(row.accountType) && dividendTicker(row.description) !== null;
}

/** A dividend the account already has booked on a security: its bank text and
 *  that security's asset id. */
export interface PastDividend {
  description: string;
  assetId: string;
}

/** The one security this account's earlier dividends under `ticker` are booked
 *  on, or null when they name none or more than one. */
export function pastDividendSecurity(ticker: string, past: readonly PastDividend[]): string | null {
  const key = ticker.trim().toUpperCase();
  const ids = new Set(past.filter((p) => dividendTicker(p.description) === key).map((p) => p.assetId));
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * What a money-in row becomes, or null to leave the mapped type alone.
 *
 *  - A rule typed it DIVIDEND: a DIVIDEND on the security the text names;
 *    otherwise INTEREST, the income type that needs no security (a DIVIDEND
 *    without one is refused).
 *  - No rule, a plain deposit in an investment account whose text is a known
 *    dividend wording: a DIVIDEND on the security it names; otherwise left as
 *    it is.
 *
 * The security is the one holding under the ticker. When the account holds
 * none (a dividend paid after the position was sold) or the read failed, it is
 * the one security this account's earlier dividends under the ticker are booked
 * on: both writers read the same stored rows, so they agree. Two holdings under
 * the ticker name none, whatever the history says.
 *
 * `held` and `past` are read only when needed: pass functions.
 */
export async function decideDividend(row: {
  mapped: MappedType;
  amount: number;
  accountType: string | undefined;
  description: string;
  held: () => Promise<readonly HeldSecurity[] | null>;
  past?: () => Promise<readonly PastDividend[] | null>;
}): Promise<DividendDecision> {
  if (!isDividendRow(row)) return null;
  const ruled = row.mapped.fromRule;
  const ticker = isInvestmentAccountType(row.accountType) ? dividendTicker(row.description) : null;
  const assetId = ticker ? await securityFor(ticker, row.held, row.past) : null;
  if (assetId) return { type: 'DIVIDEND', assetId };
  return ruled ? { type: 'INTEREST' } : null;
}

async function securityFor(
  ticker: string,
  held: () => Promise<readonly HeldSecurity[] | null>,
  past: (() => Promise<readonly PastDividend[] | null>) | undefined,
): Promise<string | null> {
  const holdings = (await held()) ?? [];
  const key = ticker.trim().toUpperCase();
  if (holdings.some((h) => h.symbol.trim().toUpperCase() === key)) return heldSecurityFor(ticker, holdings)?.assetId ?? null;
  return past ? pastDividendSecurity(ticker, (await past()) ?? []) : null;
}
