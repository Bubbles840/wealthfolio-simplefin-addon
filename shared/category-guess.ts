/**
 * shared/category-guess.ts
 *
 * The category a needs-a-category row was probably meant for (project 3, L3):
 * how you filed the same merchant before. Pure — the companion reads the
 * filings, this module only counts them.
 *
 * "The same merchant" is the rule pattern `/categorize` would build for the
 * row (`categoryRulePattern`, ./rule-pattern.ts), compared without case: two
 * Netflix charges with different reference numbers share it. A guess needs at
 * least `GUESS_MIN_FILINGS` filings under that key in the last
 * `GUESS_LOOKBACK_DAYS`, and at least `GUESS_MIN_SHARE_PERCENT` of them in one
 * category. A Venmo row (` · Venmo: <note>`) is keyed by its note only. Amazon rows get no guess: the Amazon pipeline files them.
 *
 * A guess never files anything (L4): Telegram offers it as one tap, the app
 * shows it as a hint.
 */
import { isAmazonDescription } from './amazon-ledger.js';
import { categoryRulePattern } from './rule-pattern.js';
import { isVenmoDescription, VENMO_NOTE_MARK } from './venmo-ledger.js';

export const GUESS_LOOKBACK_DAYS = 365;
export const GUESS_MIN_FILINGS = 2;
export const GUESS_MIN_SHARE_PERCENT = 80;

/** One past spending filing: the row's description (its note without the tx
 *  id — `descriptionFromComment`) and the category it was filed under. */
export interface PastFiling {
  description: string;
  categoryId: string;
  categoryName: string;
}

/** The guess: a category, its name, and how many past filings chose it. */
export interface CategoryGuess {
  categoryId: string;
  name: string;
  count: number;
}

interface Tally {
  total: number;
  byCategory: Map<string, { name: string; count: number }>;
}

export type GuessIndex = ReadonlyMap<string, Tally>;

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Words that describe HOW money moved, not who it moved to: a pattern made of
 *  only these (and numbers) is shared by unrelated merchants, so it is no key.
 *  A subscription's brand word (`brandWord`, subscriptions.ts) skips them too. */
export const GENERIC_BANK_WORDS: readonly string[] = [
  'pos', 'purchase', 'debit', 'credit', 'card', 'ach', 'web', 'withdrawal', 'deposit', 'payment',
  'transfer', 'online', 'recurring', 'check', 'atm', 'pending', 'pmt', 'pymt', 'bill', 'pay', 'the',
];
const GENERIC = new Set(GENERIC_BANK_WORDS);

const isGenericPattern = (pattern: string): boolean =>
  pattern.split(' ').filter((t) => t && !/^\d+$/.test(t)).every((t) => GENERIC.has(t));

/** The keys a description is filed and guessed under. A Venmo row is keyed by
 *  its note ONLY (every Venmo payment shares the bank's words, so those say
 *  nothing); with no note it has no key. Any other row is keyed by the rule
 *  pattern `/categorize` would build, unless that is only generic banking words. */
export function guessKeys(description: string | null | undefined): string[] {
  const text = description ?? '';
  if (isVenmoDescription(text)) {
    const at = text.indexOf(VENMO_NOTE_MARK);
    const note = at === -1 ? '' : norm(text.slice(at + VENMO_NOTE_MARK.length));
    return note ? [`venmo:${note}`] : [];
  }
  const pattern = norm(categoryRulePattern(text.trim()));
  return pattern && !isGenericPattern(pattern) ? [`pattern:${pattern}`] : [];
}

/** Count the filings once, by key and category. */
export function buildGuessIndex(filings: readonly PastFiling[]): GuessIndex {
  const index = new Map<string, Tally>();
  for (const f of filings) {
    if (!f.categoryId || !f.categoryName) continue;
    for (const key of guessKeys(f.description)) {
      const tally = index.get(key) ?? { total: 0, byCategory: new Map() };
      tally.total += 1;
      const hit = tally.byCategory.get(f.categoryId) ?? { name: f.categoryName, count: 0 };
      hit.count += 1;
      tally.byCategory.set(f.categoryId, hit);
      index.set(key, tally);
    }
  }
  return index;
}

/** The guess for a row's description, or null: too few filings, no category
 *  with 80% of them, a category with no name, or an Amazon row. */
export function guessCategory(index: GuessIndex, description: string | null | undefined): CategoryGuess | null {
  if (isAmazonDescription(description ?? '')) return null;
  for (const key of guessKeys(description)) {
    const tally = index.get(key);
    if (!tally || tally.total < GUESS_MIN_FILINGS) continue;
    for (const [categoryId, hit] of tally.byCategory) {
      if (hit.name && hit.count * 100 >= tally.total * GUESS_MIN_SHARE_PERCENT) {
        return { categoryId, name: hit.name, count: hit.count };
      }
    }
  }
  return null;
}

/** The first day (YYYY-MM-DD, UTC) whose filings count: a year back. */
export function guessSinceDay(now: Date): string {
  return new Date(now.getTime() - GUESS_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
}
