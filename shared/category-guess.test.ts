import { describe, it, expect } from 'vitest';
import {
  buildGuessIndex, guessCategory, guessKeys, guessSinceDay, GUESS_LOOKBACK_DAYS, GUESS_MIN_FILINGS, GUESS_MIN_SHARE_PERCENT, GENERIC_BANK_WORDS,
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

  it('keys a Venmo row by its note only — never by the bank words every payment shares', () => {
    const dinners = Array.from({ length: 9 }, (_, i) => filed(`VENMO PAYMENT ${i} · Venmo: Dinner`, 'cat-eat', 'Eating'));
    const split = [filed('VENMO PAYMENT 90 · Venmo: Rent', 'cat-rent', 'Rent'), filed('VENMO PAYMENT 91 · Venmo: Rent', 'cat-ut', 'Utilities')];
    expect(guess([...dinners, ...split], 'VENMO PAYMENT 2001 · Venmo: Rent')).toBeNull();
    expect(guess(dinners, 'VENMO PAYMENT 2001')).toBeNull();
    expect(guess(dinners, 'VENMO CASHOUT · Venmo: Something new')).toBeNull();
  });

  it('still guesses a noted row with 2+ filings at 80% under that note', () => {
    const past = [filed('VENMO PAYMENT 1 · Venmo: Rent', 'cat-rent', 'Rent'), filed('VENMO PAYMENT 2 · Venmo: Rent', 'cat-rent', 'Rent')];
    expect(guess(past, 'VENMO PAYMENT 3 · Venmo: Rent')).toEqual({ categoryId: 'cat-rent', name: 'Rent', count: 2 });
  });

  it('gives no guess from a note split 50/50', () => {
    const past = [filed('VENMO PAYMENT 1 · Venmo: Gift', 'cat-a', 'A'), filed('VENMO PAYMENT 2 · Venmo: Gift', 'cat-b', 'B')];
    expect(guess(past, 'VENMO PAYMENT 3 · Venmo: Gift')).toBeNull();
  });

  it('keys a Venmo note, and a bank row by its pattern', () => {
    expect(guessKeys('VENMO PAYMENT 1023 · Venmo: Rent  October')).toEqual(['venmo:rent october']);
    expect(guessKeys('KROGER #415 12/03')).toEqual(['pattern:kroger']);
  });
});

describe('guessCategory — generic descriptors and bad input', () => {
  it('gives generic banking words no key and no guess', () => {
    for (const d of ['POS PURCHASE 1234', 'ACH WEB 5521', 'WITHDRAWAL']) {
      expect(guessKeys(d)).toEqual([]);
      expect(guess([filed(d), filed(d)], d)).toBeNull();
    }
    expect(GENERIC_BANK_WORDS).toContain('pos');
  });

  it('still guesses a merchant behind a generic prefix', () => {
    expect(guess([filed('PAYPAL *SPOTIFY'), filed('PAYPAL *SPOTIFY')], 'PAYPAL *SPOTIFY')).not.toBeNull();
    expect(guess([filed('SQ *JOES PIZZA'), filed('SQ *JOES PIZZA')], 'SQ *JOES PIZZA')).not.toBeNull();
  });

  it('does not throw on a null or undefined description', () => {
    expect(guessKeys(null)).toEqual([]);
    expect(guess([filed('KROGER'), filed('KROGER')], undefined)).toBeNull();
    expect(guess([filed('KROGER'), filed('KROGER')], null)).toBeNull();
  });

  it('leaves a blank-named category out of the total', () => {
    const past = [filed('KROGER'), filed('KROGER'), filed('KROGER', 'cat-x', '')];
    expect(guess(past, 'KROGER')).toEqual({ categoryId: 'cat-gro', name: 'Groceries', count: 2 });
  });
});

describe('guessSinceDay', () => {
  it('is a year back, as a UTC day', () => {
    expect(guessSinceDay(new Date('2026-10-14T12:00:00Z'))).toBe('2025-10-14');
  });

  it('crosses a leap year and a month boundary', () => {
    expect(guessSinceDay(new Date('2028-03-01T00:00:00Z'))).toBe('2027-03-02');
    expect(guessSinceDay(new Date('2026-03-31T23:59:00Z'))).toBe('2025-03-31');
  });
});
