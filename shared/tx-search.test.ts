import { describe, it, expect } from 'vitest';
import {
  findTransactions, isEmptyTxQuery, matchesTxQuery, parseTxQuery, txDescription, txQueryText, txSearchKeyword,
  txSearchPage, TX_SEARCH_MAX_RESULTS, type TxSearchRow,
} from './tx-search';

const row = (over: Partial<TxSearchRow> = {}): TxSearchRow => ({
  activityId: 'act-1', date: '2026-10-04', description: 'KROGER #415', amountCents: -5420, accountName: 'PNC Checking', ...over,
});

describe('parseTxQuery', () => {
  it('reads 54.20 and $54.20 as that exact amount', () => {
    expect(parseTxQuery('54.20')).toEqual({ words: [], amount: { minCents: 5420, maxCents: 5420, text: '54.20' } });
    expect(parseTxQuery('$54.20')).toEqual({ words: [], amount: { minCents: 5420, maxCents: 5420, text: '54.20' } });
  });

  it('reads a whole number as every amount in that dollar', () => {
    expect(parseTxQuery('54').amount).toEqual({ minCents: 5400, maxCents: 5499, text: '54' });
  });

  it('reads 1,250 as a thousand-separated amount', () => {
    expect(parseTxQuery('1,250').amount).toEqual({ minCents: 125000, maxCents: 125099, text: '1,250' });
  });

  it('splits words from the amount, lower-cased, whichever order they come in', () => {
    expect(parseTxQuery('Kroger 54.20')).toEqual({ words: ['kroger'], amount: { minCents: 5420, maxCents: 5420, text: '54.20' } });
    expect(parseTxQuery('$12  Heine   Brothers')).toEqual({ words: ['heine', 'brothers'], amount: { minCents: 1200, maxCents: 1299, text: '12' } });
  });

  it('reads words only, and keeps a second amount-looking token as a word', () => {
    expect(parseTxQuery('venmo jane')).toEqual({ words: ['venmo', 'jane'], amount: null });
    expect(parseTxQuery('20 30')).toEqual({ words: ['20'], amount: { minCents: 3000, maxCents: 3099, text: '30' } });
  });

  it('ignores a sign: an amount matches money in and money out', () => {
    expect(parseTxQuery('-54.20').amount).toEqual({ minCents: 5420, maxCents: 5420, text: '54.20' });
  });

  it('is empty for blank text', () => {
    expect(isEmptyTxQuery(parseTxQuery('   '))).toBe(true);
    expect(isEmptyTxQuery(parseTxQuery('54'))).toBe(false);
  });

  it('picks the amount: the first $, else the first with cents, else the last', () => {
    expect(parseTxQuery('kroger 415 54.20')).toEqual({ words: ['kroger', '415'], amount: { minCents: 5420, maxCents: 5420, text: '54.20' } });
    expect(parseTxQuery('kroger 415 54').amount?.text).toBe('54');
    expect(parseTxQuery('$415 kroger 54.20')).toEqual({ words: ['kroger', '54.20'], amount: { minCents: 41500, maxCents: 41599, text: '415' } });
  });

  it('writes a query back as $amount then the words, and that parses to the same query', () => {
    expect(txQueryText(parseTxQuery('$54.20 Kroger'))).toBe('$54.20 kroger');
    for (const t of ['kroger 415 54.20', '7 eleven 5.43', 'kroger 415 54', '$415 kroger 54.20', '54.20', 'kroger', '$1,250.50 rent']) {
      expect(parseTxQuery(txQueryText(parseTxQuery(t)))).toEqual(parseTxQuery(t));
    }
  });
});

describe('matchesTxQuery', () => {
  it('matches every word, ignoring case, in the description or the account name', () => {
    expect(matchesTxQuery(row(), parseTxQuery('kroger pnc'))).toBe(true);
    expect(matchesTxQuery(row(), parseTxQuery('kroger ally'))).toBe(false);
  });

  it('matches an amount alone, money out or money in', () => {
    expect(matchesTxQuery(row(), parseTxQuery('54.20'))).toBe(true);
    expect(matchesTxQuery(row({ amountCents: 5420 }), parseTxQuery('$54.20'))).toBe(true);
    expect(matchesTxQuery(row(), parseTxQuery('54'))).toBe(true);
    expect(matchesTxQuery(row({ amountCents: -5500 }), parseTxQuery('54'))).toBe(false);
    expect(matchesTxQuery(row(), parseTxQuery('54.21'))).toBe(false);
  });

  it('matches words and an amount together', () => {
    expect(matchesTxQuery(row(), parseTxQuery('kroger 54'))).toBe(true);
    expect(matchesTxQuery(row(), parseTxQuery('kroger 12'))).toBe(false);
  });

  it('matches nothing for an empty query', () => {
    expect(matchesTxQuery(row(), parseTxQuery(''))).toBe(false);
  });
});

describe('findTransactions', () => {
  it('lists matches newest first and stops at 40, saying there were more', () => {
    const rows = Array.from({ length: 45 }, (_, i) => row({
      activityId: `a${String(i).padStart(2, '0')}`, date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
    }));
    const found = findTransactions(rows, parseTxQuery('kroger'));
    expect(found.rows).toHaveLength(TX_SEARCH_MAX_RESULTS);
    expect(found.truncated).toBe(true);
    const dates = found.rows.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('does not truncate a short list', () => {
    const found = findTransactions([row(), row({ activityId: 'b', description: 'TARGET' })], parseTxQuery('kroger'));
    expect(found).toEqual({ rows: [row()], truncated: false });
  });
});

describe('txSearchPage', () => {
  it('pages by 8 and clamps the page', () => {
    const items = Array.from({ length: 19 }, (_, i) => i);
    expect(txSearchPage(items, 0)).toEqual({ slice: [0, 1, 2, 3, 4, 5, 6, 7], page: 0, pages: 3 });
    expect(txSearchPage(items, 9).page).toBe(2);
    expect(txSearchPage([], 0)).toEqual({ slice: [], page: 0, pages: 1 });
  });
});

describe('txDescription', () => {
  it('drops the transaction id, the pending marker and the in-transit prefix', () => {
    expect(txDescription('KROGER #415 · TRN-1')).toBe('KROGER #415');
    expect(txDescription('KROGER #415 · TRN-1 · pending')).toBe('KROGER #415');
    expect(txDescription('↔️ In-transit transfer · ONLINE TRANSFER TO ALLY · TRN-2')).toBe('ONLINE TRANSFER TO ALLY');
  });

  it('names the add-on’s own rows plainly', () => {
    expect(txDescription('Starting balance · ACT-1')).toBe('Starting balance');
    expect(txDescription('Balance adjustment · ACT-1 · 2026-10-01')).toBe('Balance adjustment');
  });

  it('keeps a hand-entered note as it is', () => {
    expect(txDescription('Rent for October')).toBe('Rent for October');
  });
});

describe('txSearchKeyword', () => {
  it('picks the longest word no account name contains', () => {
    expect(txSearchKeyword(parseTxQuery('pnc heine cafe'), ['PNC Checking'])).toBe('heine');
  });

  it('is null when every word may be an account name, or there are no words', () => {
    expect(txSearchKeyword(parseTxQuery('checking'), ['PNC Checking'])).toBeNull();
    expect(txSearchKeyword(parseTxQuery('54.20'), ['PNC Checking'])).toBeNull();
  });

  it('skips a word with non-ASCII letters, which Wealthfolio matches by case', () => {
    expect(txSearchKeyword(parseTxQuery('café'), [])).toBeNull();
  });
});
