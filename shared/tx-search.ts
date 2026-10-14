/**
 * shared/tx-search.ts
 *
 * Finding a transaction, for `/why` (companion/src/why-menu.ts) and the app's
 * "Why is this here?" box (src/components/WhyCard.tsx): what a person typed,
 * read as words and/or an amount, and whether a row matches it. Pure.
 *
 * Words must ALL appear, ignoring case, in the description (the note without
 * its markers and transaction id) or the account name. An amount matches
 * money in and money out alike: `54.20` and `$54.20` exactly, `54` anything
 * from $54.00 to $54.99, `1,250` thousand-separated (`parseAmountCents`).
 *
 * Text is compared RAW; nothing here escapes.
 */
import { BALANCE_ADJUSTMENT_COMMENT_PREFIX, STARTING_BALANCE_COMMENT_PREFIX, descriptionFromComment } from './sync-core.js';
import { parseAmountCents } from './telegram-commands.js';

export const TX_SEARCH_PAGE_SIZE = 8;
export const TX_SEARCH_MAX_PAGES = 5;
export const TX_SEARCH_MAX_RESULTS = TX_SEARCH_PAGE_SIZE * TX_SEARCH_MAX_PAGES;
/** How far back a search reaches when it cannot read all of history. */
export const TX_SEARCH_RECENT_DAYS = 365;
export const TX_SEARCH_TOO_MANY = 'Too many matches — add a word or an amount.';

export interface TxAmountQuery {
  /** Inclusive bounds on the amount's magnitude, in cents. */
  minCents: number;
  maxCents: number;
  /** As typed, without `$` or a sign. */
  text: string;
}

export interface TxQuery {
  /** Lower-cased. */
  words: string[];
  amount: TxAmountQuery | null;
}

/** One transaction as a search shows it. */
export interface TxSearchRow {
  activityId: string;
  /** YYYY-MM-DD. */
  date: string;
  /** `txDescription` of the stored note. */
  description: string;
  /** Signed cents, money out negative. */
  amountCents: number;
  accountName: string;
}

/** The first token that reads as an amount is the amount; everything else,
 *  including a second amount-looking token, is a word. */
export function parseTxQuery(text: string): TxQuery {
  const words: string[] = [];
  let amount: TxAmountQuery | null = null;
  for (const token of (text ?? '').trim().split(/\s+/).filter(Boolean)) {
    const read: TxAmountQuery | null = amount ? null : readAmount(token);
    if (read) amount = read;
    else words.push(token.toLowerCase());
  }
  return { words, amount };
}

function readAmount(token: string): TxAmountQuery | null {
  // A sign says nothing here: amounts match money in and money out.
  const unsigned = token.replace(/^[+\-−]/, '');
  const cents = parseAmountCents(unsigned);
  if (cents === null) return null;
  const text = unsigned.replace(/^\$/, '');
  return { minCents: cents, maxCents: text.includes('.') ? cents : cents + 99, text };
}

export function isEmptyTxQuery(q: TxQuery): boolean {
  return q.words.length === 0 && q.amount === null;
}

/** A query as one line of text: the amount, then the words. The amount goes
 *  FIRST because `parseTxQuery` takes the first amount-like token as the
 *  amount, so this text parses back to the same query ("kroger 415 54.20"
 *  keeps 415 as its amount). */
export function txQueryText(q: TxQuery): string {
  return [...(q.amount ? [q.amount.text] : []), ...q.words].join(' ');
}

export function matchesTxQuery(row: Pick<TxSearchRow, 'description' | 'accountName' | 'amountCents'>, q: TxQuery): boolean {
  if (isEmptyTxQuery(q)) return false;
  if (q.amount) {
    const abs = Math.abs(Math.round(row.amountCents));
    if (abs < q.amount.minCents || abs > q.amount.maxCents) return false;
  }
  // A newline between the two, so a word cannot match across them.
  const hay = `${row.description}\n${row.accountName}`.toLowerCase();
  return q.words.every((w) => hay.includes(w));
}

export interface TxSearchResult {
  /** Newest first, at most `TX_SEARCH_MAX_RESULTS`. */
  rows: TxSearchRow[];
  /** More matched than are listed. */
  truncated: boolean;
}

export function findTransactions(rows: readonly TxSearchRow[], q: TxQuery): TxSearchResult {
  const hits = rows
    .filter((r) => matchesTxQuery(r, q))
    .sort((a, b) => (a.date === b.date
      ? (a.activityId < b.activityId ? -1 : a.activityId > b.activityId ? 1 : 0)
      : a.date < b.date ? 1 : -1));
  return { rows: hits.slice(0, TX_SEARCH_MAX_RESULTS), truncated: hits.length > TX_SEARCH_MAX_RESULTS };
}

/** One page of a list, the page clamped into range. */
export function txSearchPage<T>(items: readonly T[], page: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / TX_SEARCH_PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
  return { slice: items.slice(p * TX_SEARCH_PAGE_SIZE, (p + 1) * TX_SEARCH_PAGE_SIZE), page: p, pages };
}

/**
 * The description a person recognises: the bank's text with the sync's
 * decorations off (`descriptionFromComment`), and the add-on's own two kinds
 * of row named plainly — their notes carry an account id, not a description.
 */
export function txDescription(note: string | null | undefined): string {
  const n = note ?? '';
  if (n.startsWith(STARTING_BALANCE_COMMENT_PREFIX)) return 'Starting balance';
  if (n.startsWith(BALANCE_ADJUSTMENT_COMMENT_PREFIX)) return 'Balance adjustment';
  return descriptionFromComment(n);
}

/**
 * The one word Wealthfolio's own activity search can narrow by. Its keyword
 * is a single `LIKE '%word%'` over the note (and asset fields), never the
 * account name — so only a word that no account name contains is safe: a row
 * can match that word through its description alone. ASCII only, because
 * SQLite's LIKE ignores case for ASCII letters and nothing else. The longest
 * such word narrows the most; null when there is none.
 */
export function txSearchKeyword(q: TxQuery, accountNames: readonly string[]): string | null {
  const names = accountNames.map((n) => n.toLowerCase());
  const safe = q.words
    .filter((w) => /^[\x20-\x7e]+$/.test(w))
    .filter((w) => !names.some((n) => n.includes(w)));
  if (safe.length === 0) return null;
  return safe.reduce((best, w) => (w.length > best.length ? w : best));
}
