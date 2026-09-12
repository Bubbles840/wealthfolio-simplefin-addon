import { describe, it, expect } from 'vitest';
import { normalizeAccountSet } from './simplefin-payload.js';

describe('normalizeAccountSet', () => {
  it('names the failing account when the Bridge sends a structured errlist', () => {
    // The Discover case: for weeks the only signal was an untethered string, so
    // nothing said WHICH connection had died. `errlist` carries the account id;
    // resolving it to a name is the whole point.
    const set = normalizeAccountSet({
      errlist: [{ code: 'CONN_FAILED', msg: 'Connection to institution failed', conn_id: 'c-1', account_id: 'acct-9' }],
      accounts: [{ id: 'acct-9', name: 'Discover it Card', currency: 'USD', balance: '0', 'balance-date': 1 }],
    });
    expect(set.errors).toEqual(['Discover it Card: Connection to institution failed']);
    expect(set.errorList).toEqual([
      {
        code: 'CONN_FAILED',
        msg: 'Connection to institution failed',
        connId: 'c-1',
        accountId: 'acct-9',
        key: 'CONN_FAILED:c-1',
      },
    ]);
  });

  it('falls back to the account id when the failing account is not in the payload', () => {
    // A dead connection can stop publishing the account entirely, which is
    // exactly when the operator most needs a handle to act on.
    const set = normalizeAccountSet({
      errlist: [{ code: 'AUTH', msg: 'Reauthentication required', account_id: 'acct-gone' }],
      accounts: [],
    });
    expect(set.errors).toEqual(['Reauthentication required (account acct-gone)']);
    expect(set.errorList?.[0].key).toBe('AUTH:acct-gone');
  });

  it('keeps the legacy string errors working, and marks them as legacy', () => {
    // Older Bridges send `errors` only. Every existing consumer reads
    // `errors: string[]`, so that field must keep meaning the same thing.
    const set = normalizeAccountSet({
      errors: ['Connection to Example Bank failed'],
      accounts: [{ id: 'a', name: 'A', currency: 'USD', balance: '1', 'balance-date': 1 }],
    });
    expect(set.errors).toEqual(['Connection to Example Bank failed']);
    expect(set.errorList).toEqual([
      {
        code: 'legacy',
        msg: 'Connection to Example Bank failed',
        connId: null,
        accountId: null,
        key: 'legacy:Connection to Example Bank failed',
      },
    ]);
  });

  it('survives a payload carrying neither errors nor errlist', () => {
    // `errors` is read with a bare `for…of` downstream, so an absent field used
    // to be a TypeError rather than a quiet "nothing went wrong".
    const set = normalizeAccountSet({ accounts: [] });
    expect(set.errors).toEqual([]);
    expect(set.errorList).toEqual([]);
    expect(set.accounts).toEqual([]);
  });

  it('collapses repeats of one failure inside a single payload', () => {
    // A broken institution reports per-account, so one dead connection arrives
    // as several identical entries. The Sync page should say it once.
    const set = normalizeAccountSet({
      errlist: [
        { code: 'CONN_FAILED', msg: 'Connection failed', conn_id: 'c-1', account_id: 'a1' },
        { code: 'CONN_FAILED', msg: 'Connection failed', conn_id: 'c-1', account_id: 'a2' },
      ],
      accounts: [],
    });
    expect(set.errorList).toHaveLength(1);
    expect(set.errors).toHaveLength(1);
  });

  it('passes accounts through untouched, holdings included', () => {
    // The normalizer exists for the error half; the accounts must arrive exactly
    // as the Bridge sent them, or holdings sync silently sees nothing.
    const set = normalizeAccountSet({
      accounts: [
        {
          id: 'b1',
          name: 'Brokerage',
          currency: 'USD',
          balance: '10',
          'balance-date': 5,
          holdings: [{ symbol: 'VTI', shares: '2' }],
          transactions: [{ id: 't', posted: 1, amount: '-1', description: 'x' }],
        },
      ],
    });
    expect(set.accounts[0].holdings).toEqual([{ symbol: 'VTI', shares: '2' }]);
    expect(set.accounts[0].transactions).toHaveLength(1);
  });

  it('refuses a payload that is not an object', () => {
    expect(() => normalizeAccountSet('nope')).toThrow(/SimpleFin/i);
    expect(() => normalizeAccountSet(null)).toThrow(/SimpleFin/i);
  });
});
