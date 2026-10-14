import { describe, it, expect } from 'vitest';
import {
  buildGuessIndex, guessCategory, guessKeys, guessSinceDay, GUESS_LOOKBACK_DAYS, GUESS_MIN_FILINGS, GUESS_MIN_SHARE_PERCENT,
  type PastFiling,
} from './category-guess';

const filed = (description: string, categoryId = 'cat-gro', categoryName = 'Groceries'): PastFiling => ({ description, categoryId, categoryName });
const guess = (filings: PastFiling[], description: string) => guessCategory(buildGuessIndex(filings), description);

describe('guessCategory — the thresholds', () => {
  it('is L3’s numbers: 2 filings, 80%, a year', () => {
    expect([GUESS_MIN_FILINGS, GUESS_MIN_SHARE_PERCENT, GUESS_LOOKBACK_DAYS]).toEqual([2, 80, 365]);
  });

  it('guesses from exactly 2 filings in one category, and not from 1', () => {
    expect(guess([filed('KROGER #415'), filed('KROGER #415')], 'KROGER #415')).toEqual({ categoryId: 'cat-gro', name: 'Groceries', count: 2 });
    expect(guess([filed('KROGER #415')], 'KROGER #415')).toBeNull();
  });

  it('guesses at exactly 80% (4 of 5) and not below (3 of 4)', () => {
    const four = [filed('KROGER'), filed('KROGER'), filed('KROGER'), filed('KROGER'), filed('KROGER', 'cat-home', 'Home')];
    expect(guess(four, 'KROGER')).toEqual({ categoryId: 'cat-gro', name: 'Groceries', count: 4 });
    const three = [filed('KROGER'), filed('KROGER'), filed('KROGER'), filed('KROGER', 'cat-home', 'Home')];
    expect(guess(three, 'KROGER')).toBeNull();
    expect(guess([filed('KROGER'), filed('KROGER', 'cat-home', 'Home')], 'KROGER')).toBeNull();
  });

  it('counts charges whose reference numbers differ as one merchant, without case', () => {
    const past = [filed('NETFLIX.COM 866-579-7172', 'cat-sub', 'Subscriptions'), filed('Netflix.com 866-000-1111', 'cat-sub', 'Subscriptions')];
    expect(guess(past, 'NETFLIX.COM')).toEqual({ categoryId: 'cat-sub', name: 'Subscriptions', count: 2 });
    expect(guess(past, 'HULU 877-824-4858')).toBeNull();
  });

  it('never guesses an Amazon row — the Amazon pipeline files those', () => {
    const past = [filed('AMAZON.COM*MB3T81'), filed('AMAZON.COM*MB3T81')];
    expect(guess(past, 'AMAZON.COM*MB3T81')).toBeNull();
  });

  it('skips a category with no name rather than guessing a blank', () => {
    expect(guess([filed('KROGER', 'cat-x', ''), filed('KROGER', 'cat-x', '')], 'KROGER')).toBeNull();
  });
});

describe('guessCategory — Venmo notes', () => {
  it('tries a Venmo row by its note first, any case', () => {
    const past = [
      filed('VENMO PAYMENT 1023 · Venmo: Rent October', 'cat-rent', 'Rent'),
      filed('VENMO PAYMENT 1188 · Venmo: rent october', 'cat-rent', 'Rent'),
    ];
    expect(guess(past, 'VENMO PAYMENT 2001 · Venmo: Rent October')).toEqual({ categoryId: 'cat-rent', name: 'Rent', count: 2 });
  });

  it('falls back to the bank’s own words when the note decides nothing', () => {
    const past = [
      filed('VENMO CASHOUT · Venmo: Transfer to your bank', 'cat-tr', 'Transfers'),
      filed('VENMO CASHOUT', 'cat-tr', 'Transfers'),
    ];
    expect(guess(past, 'VENMO CASHOUT · Venmo: Something new')).toEqual({ categoryId: 'cat-tr', name: 'Transfers', count: 2 });
  });

  it('files a note and its bank words under both keys', () => {
    expect(guessKeys('VENMO PAYMENT 1023 · Venmo: Rent  October')).toEqual(['venmo:rent october', 'pattern:venmo payment']);
    expect(guessKeys('KROGER #415 12/03')).toEqual(['pattern:kroger']);
  });
});

describe('guessSinceDay', () => {
  it('is a year back, as a UTC day', () => {
    expect(guessSinceDay(new Date('2026-10-14T12:00:00Z'))).toBe('2025-10-14');
  });
});
