/**
 * shared/dividends.ts
 *
 * A dividend the bank names the security of, booked as a Wealthfolio
 * DIVIDEND on that security instead of a cash deposit, so the Income page can
 * say which holding paid it. A DIVIDEND needs a security: written on the
 * `$CASH-<ccy>` cash symbol, Wealthfolio 3.8 accepts it but mints a phantom
 * `$CASH` security to hold it, which is why a DIVIDEND transaction rule could
 * not work before this.
 *
 * Narrow on purpose: a security is only named when a known bank wording
 * carries its ticker AND exactly one security under that ticker is found, in
 * this order (`securityFor`): the account's holdings; when it holds none under
 * the ticker (a dividend paid after the position was sold), the account's own
 * stored activity on a security under the ticker (an earlier dividend, a
 * trade); with none, the account's holdings snapshots in the weeks before the
 * dividend (a position bought and sold between two dividends). Anything less
 * stays what it was. A wrong match would credit income to the wrong holding; a
 * missed one only leaves a deposit.
 *
 * Who decides, as everywhere in the sync: a transaction rule the person wrote
 * wins. Without one, a known wording is recognised by itself.
 *
 * Once booked, a dividend stays on its security: a later sync that can't name
 * one (a failed read, the other writer not new enough yet) leaves a stored
 * DIVIDEND on a security as it is (`FeedTx.keepDividend`). Only a sync that
 * names a security moves the row.
 *
 * Pure: sync-core reads the holdings, stored rows and snapshots and writes;
 * this module only decides.
 */
import type { MappedType } from './mapper.js';
import { isCashCode } from './reconcile.js';

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

/** The securities in a holdings read (the SDK's `portfolio.getHoldings` or
 *  `snapshots.getByDate`, or `GET /holdings` / `GET /snapshots/holdings`): each
 *  holding's `instrument` id and display code. The cash line is not one: it
 *  reads back as `cash:USD` under the symbol `USD`, which is also a ticker. */
export function heldSecuritiesOf(holdings: unknown): HeldSecurity[] {
  if (!Array.isArray(holdings)) return [];
  const out: HeldSecurity[] = [];
  for (const h of holdings) {
    const row = h as { holdingType?: unknown; instrument?: { id?: unknown; symbol?: unknown } | null } | null;
    if (typeof row?.holdingType === 'string' && row.holdingType.toLowerCase() === 'cash') continue;
    const i = row?.instrument;
    if (i && typeof i.id === 'string' && i.id && !isCashCode(i.id) && typeof i.symbol === 'string' && i.symbol) out.push({ assetId: i.id, symbol: i.symbol });
  }
  return out;
}

const tickerKey = (t: string) => t.trim().toUpperCase();

/** The one held security shown under `ticker`, or null when none or more than
 *  one is (two listings can share a display code). */
export function heldSecurityFor(ticker: string, held: readonly HeldSecurity[]): HeldSecurity | null {
  const hits = held.filter((h) => tickerKey(h.symbol) === tickerKey(ticker));
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

/** A stored activity of the account's on a security: its type, bank text, and
 *  the security's asset id and display code (absent when the host reports none). */
export interface PastActivity {
  type: string;
  description: string;
  assetId: string;
  assetSymbol?: string;
}

/** The one security the account's stored activity under `ticker` is on: rows
 *  whose security shows that code (an earlier dividend, a trade), and dividends
 *  whose bank text names it. Null when they name none or more than one. */
export function pastSecurity(ticker: string, past: readonly PastActivity[]): string | null {
  const ids = new Set(past.filter((p) => pastShows(p, ticker)).map((p) => p.assetId));
  return ids.size === 1 ? [...ids][0] : null;
}

const pastShows = (p: PastActivity, ticker: string) =>
  (p.assetSymbol !== undefined && tickerKey(p.assetSymbol) === tickerKey(ticker))
  || (p.type === 'DIVIDEND' && dividendTicker(p.description) === tickerKey(ticker));

/** One holdings snapshot of the account's: its `YYYY-MM-DD` date and how many
 *  positions it holds (the SDK's `snapshots.getAll`, or `GET /snapshots`). */
export interface SnapshotDay {
  date: string;
  positionCount: number;
}

/** The snapshots in a snapshot listing (the SDK's `snapshots.getAll`, or
 *  `GET /snapshots`): each one's `snapshotDate` and `positionCount`. */
export function snapshotDaysOf(snapshots: unknown): SnapshotDay[] {
  if (!Array.isArray(snapshots)) return [];
  const out: SnapshotDay[] = [];
  for (const s of snapshots) {
    const row = s as { snapshotDate?: unknown; positionCount?: unknown } | null;
    if (typeof row?.snapshotDate === 'string' && typeof row.positionCount === 'number') out.push({ date: row.snapshotDate, positionCount: row.positionCount });
  }
  return out;
}

/** How far before a dividend its snapshots are looked at: a dividend is paid
 *  on the shares held on the record date, a few weeks before the pay date. */
export const SNAPSHOT_LOOKBACK_DAYS = 60;
/** At most this many snapshots are read for one dividend. */
export const SNAPSHOT_READS = 8;
/** The snapshot dates are listed once per account per sync, for this many days
 *  back: a dividend's own window, for any dividend a sync re-reads. */
export const SNAPSHOT_WINDOW_DAYS = 180;

/**
 * The snapshot dates worth reading for a ticker no longer held, in order: those
 * within SNAPSHOT_LOOKBACK_DAYS on or before the dividend, first each one the
 * next snapshot holds fewer positions than (a sale shows there), newest first,
 * then the rest, newest first; at most SNAPSHOT_READS.
 */
export function snapshotDatesToRead(days: readonly SnapshotDay[], dividendDate: string): string[] {
  const end = Date.parse(`${dividendDate}T00:00:00Z`);
  if (Number.isNaN(end)) return [];
  const start = end - SNAPSHOT_LOOKBACK_DAYS * 86_400_000;
  const all = [...days].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date)).sort((a, b) => a.date.localeCompare(b.date));
  const inWindow = (d: SnapshotDay) => {
    const t = Date.parse(`${d.date}T00:00:00Z`);
    return t >= start && t <= end;
  };
  const beforeDrop = new Set(all.filter((d, i) => i + 1 < all.length && all[i + 1].positionCount < d.positionCount).map((d) => d.date));
  const candidates = all.filter(inWindow).reverse();
  return [...candidates.filter((d) => beforeDrop.has(d.date)), ...candidates.filter((d) => !beforeDrop.has(d.date))]
    .slice(0, SNAPSHOT_READS)
    .map((d) => d.date);
}

/** The reads `decideDividend` may make, each only when needed. A failed read is null. */
export interface DividendReads {
  /** The account's holdings now. */
  held: () => Promise<readonly HeldSecurity[] | null>;
  /** The account's stored activity on a security. */
  past?: () => Promise<readonly PastActivity[] | null>;
  /** The account's holdings snapshots, and the securities one of them holds. */
  snapshots?: {
    days: () => Promise<readonly SnapshotDay[] | null>;
    securities: (date: string) => Promise<readonly HeldSecurity[] | null>;
  };
}

/** No reads: what a writer decides while the other writer isn't new enough. */
export const NO_DIVIDEND_READS: DividendReads = { held: async () => null };

/**
 * What a money-in row becomes, or null to leave the mapped type alone.
 *
 *  - A rule typed it DIVIDEND: a DIVIDEND on the security the text names;
 *    otherwise INTEREST, the income type that needs no security.
 *  - No rule, a plain deposit in an investment account whose text is a known
 *    dividend wording: a DIVIDEND on the security it names; otherwise left as
 *    it is.
 *
 * The security comes from `securityFor`. `date` is the dividend's bank day.
 */
export async function decideDividend(row: {
  mapped: MappedType;
  amount: number;
  accountType: string | undefined;
  description: string;
  date: string;
} & DividendReads): Promise<DividendDecision> {
  if (!isDividendRow(row)) return null;
  const ruled = row.mapped.fromRule;
  const ticker = isInvestmentAccountType(row.accountType) ? dividendTicker(row.description) : null;
  const assetId = ticker ? await securityFor(ticker, row.date, row) : null;
  if (assetId) return { type: 'DIVIDEND', assetId };
  return ruled ? { type: 'INTEREST' } : null;
}

/**
 * The one security under `ticker`, from the first source that shows the ticker
 * at all; two securities there name none, and later sources are not asked:
 *  1. the holdings now;
 *  2. the account's stored activity on a security (both writers read the same
 *     rows, so they agree);
 *  3. the first snapshot before the dividend that holds the ticker
 *     (`snapshotDatesToRead`).
 */
async function securityFor(ticker: string, date: string, reads: DividendReads): Promise<string | null> {
  const shows = (list: readonly HeldSecurity[]) => list.some((h) => tickerKey(h.symbol) === tickerKey(ticker));
  const holdings = (await reads.held()) ?? [];
  if (shows(holdings)) return heldSecurityFor(ticker, holdings)?.assetId ?? null;
  const past = reads.past ? (await reads.past()) ?? [] : [];
  if (past.some((p) => pastShows(p, ticker))) return pastSecurity(ticker, past);
  if (!reads.snapshots) return null;
  for (const day of snapshotDatesToRead((await reads.snapshots.days()) ?? [], date)) {
    const securities = await reads.snapshots.securities(day);
    if (securities && shows(securities)) return heldSecurityFor(ticker, securities)?.assetId ?? null;
  }
  return null;
}
