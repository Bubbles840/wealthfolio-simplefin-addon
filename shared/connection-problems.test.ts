import { describe, it, expect } from 'vitest';
import {
  bridgeSiteOf, connectionProblemClearedText, connectionProblemText, connectionProblemTitle, findConnectionProblems,
  mergeConnectionProblems, parseConnectionProblems, PROBLEM_RECORD_MAX_AGE_MS, problemKind, sanitizeProblemText,
  shownConnectionProblems, type ConnectionProblem,
} from './connection-problems.js';
import { normalizeAccountSet } from './simplefin-payload.js';

const NOW = new Date('2026-11-18T15:00:00.000Z');
const HOUR = 3_600_000;
const acct = (id: string, conn: string) => ({ id, name: id.toUpperCase(), currency: 'USD', balance: '0', 'balance-date': 1, conn_id: conn });

/** A v2 payload: Fidelity (C1: a1, a2) needs a sign-in, a3 (C3) failed a read,
 *  C2's only account is unmapped, plus a developer error and a bare gen.auth. */
const set = normalizeAccountSet({
  errlist: [
    { code: 'con.auth', msg: 'Authentication required', conn_id: 'C1' },
    { code: 'act.failed', msg: 'Failed to get account information. Try again later.', account_id: 'a3' },
    { code: 'con.auth', msg: 'Authentication required', conn_id: 'C2' },
    { code: 'gen.api', msg: 'Bad parameter' },
    { code: 'gen.auth', msg: 'No credentials provided' },
  ],
  connections: [
    { conn_id: 'C1', name: 'Fidelity NetBenefits' }, { conn_id: 'C2', name: 'Old Bank' }, { conn_id: 'C3', name: 'Ally' },
  ],
  accounts: [acct('a1', 'C1'), acct('a2', 'C1'), acct('a3', 'C3'), acct('a9', 'C2')],
});
const inUse = (id: string) => id !== 'a9';

const problem = (over: Partial<ConnectionProblem>): ConnectionProblem => ({
  key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a1', 'a2'],
  message: 'Fidelity NetBenefits: Authentication required', firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), ...over,
});

describe('connection problems (#81)', () => {
  it('reads con.auth and gen.auth as a sign-in, everything else as other', () => {
    expect(['con.auth', 'gen.auth', 'CON.AUTH'].map(problemKind)).toEqual(['signin', 'signin', 'signin']);
    expect(['con.', 'con.weird', 'act.failed', 'act.missingdata', 'legacy'].map(problemKind)).toEqual(['other', 'other', 'other', 'other', 'other']);
  });

  it('keeps each real problem, with the accounts it reaches, and drops the rest', () => {
    expect(findConnectionProblems(set, inUse)).toEqual([
      { key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a1', 'a2'], message: 'Fidelity NetBenefits: Authentication required' },
      { key: 'act.failed:a3', code: 'act.failed', kind: 'other', connectionName: 'Ally', sfinAccountIds: ['a3'], message: 'A3: Failed to get account information. Try again later.' },
      { key: 'gen.auth:No credentials provided', code: 'gen.auth', kind: 'signin', sfinAccountIds: [], message: 'No credentials provided' },
    ]);
  });

  it('keeps a problem on a connection that lists no accounts at all (a dead feed)', () => {
    const dead = normalizeAccountSet({
      errlist: [{ code: 'con.auth', msg: 'Authentication required', conn_id: 'C7' }],
      connections: [{ conn_id: 'C7', name: 'Discover' }],
      accounts: [],
    });
    expect(findConnectionProblems(dead, () => false)).toEqual([
      { key: 'con.auth:C7', code: 'con.auth', kind: 'signin', connectionName: 'Discover', sfinAccountIds: [], message: 'Discover: Authentication required' },
    ]);
  });

  it('keeps a v1 string as other, keyed by its message, and never a window notice', () => {
    const v1 = normalizeAccountSet({ errors: ['Connection to Example Bank may need attention', 'Date range exceeds 60 days'], accounts: [] });
    expect(findConnectionProblems(v1, () => true)).toEqual([
      { key: 'legacy:Connection to Example Bank may need attention', code: 'legacy', kind: 'other', sfinAccountIds: [], message: 'Connection to Example Bank may need attention' },
    ]);
  });

  it('makes what SimpleFin sent plain, short text', () => {
    expect(sanitizeProblemText('  Sign <b>in</b>\nagain\u0007 now ')).toBe('Sign in again now');
    expect(sanitizeProblemText('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeProblemText('x'.repeat(500)).endsWith('…')).toBe(true);
  });

  it('keeps firstSeenAt while a problem is still reported, and drops one that is not', () => {
    const earlier = new Date(NOW.getTime() - 30 * HOUR).toISOString();
    const prev = { checkedAt: earlier, problems: [problem({ firstSeenAt: earlier, lastSeenAt: earlier }), problem({ key: 'gone', firstSeenAt: earlier })] };
    const found = findConnectionProblems(set, inUse);
    const next = mergeConnectionProblems(prev, found, NOW);
    expect(next.checkedAt).toBe(NOW.toISOString());
    expect(next.problems.map((p) => [p.key, p.firstSeenAt, p.lastSeenAt])).toEqual([
      ['con.auth:C1', earlier, NOW.toISOString()],
      ['act.failed:a3', NOW.toISOString(), NOW.toISOString()],
      ['gen.auth:No credentials provided', NOW.toISOString(), NOW.toISOString()],
    ]);
    expect(mergeConnectionProblems(null, [], NOW)).toEqual({ checkedAt: NOW.toISOString(), problems: [] });
  });

  it('shows a sign-in at once and anything else after 24 hours', () => {
    const record = { checkedAt: NOW.toISOString(), problems: [
      problem({}),
      problem({ key: 'young', kind: 'other', firstSeenAt: new Date(NOW.getTime() - 23 * HOUR).toISOString() }),
      problem({ key: 'old', kind: 'other', firstSeenAt: new Date(NOW.getTime() - 24 * HOUR).toISOString() }),
    ] };
    expect(shownConnectionProblems(record, NOW).map((p) => p.key)).toEqual(['con.auth:C1', 'old']);
  });

  it('shows nothing from a record older than 48 hours when asked to judge its age (the add-on)', () => {
    const stale = { checkedAt: new Date(NOW.getTime() - 49 * HOUR).toISOString(), problems: [problem({})] };
    expect(PROBLEM_RECORD_MAX_AGE_MS).toBe(48 * HOUR);
    expect(shownConnectionProblems(stale, NOW, { maxRecordAgeMs: PROBLEM_RECORD_MAX_AGE_MS })).toEqual([]);
    expect(shownConnectionProblems(stale, NOW)).toHaveLength(1);
    expect(shownConnectionProblems(null, NOW)).toEqual([]);
  });

  it('reads back what it wrote, and nothing from garbage', () => {
    const record = { checkedAt: NOW.toISOString(), problems: [problem({}), { key: 'bad' }] };
    expect(parseConnectionProblems(JSON.stringify(record))).toEqual({ checkedAt: NOW.toISOString(), problems: [problem({})] });
    expect(parseConnectionProblems('{nope')).toBeNull();
    expect(parseConnectionProblems(null)).toBeNull();
    expect(parseConnectionProblems('[]')).toBeNull();
  });

  it('links to the Bridge the access URL points at, never with its credentials', () => {
    expect(bridgeSiteOf('https://user:secret@beta-bridge.simplefin.org/simplefin')).toBe('https://beta-bridge.simplefin.org');
    expect(bridgeSiteOf('https://user:secret@www.lunchflow.app/simplefin')).toBeNull();
    expect(bridgeSiteOf('garbage')).toBeNull();
    expect(bridgeSiteOf(null)).toBeNull();
  });

  it('words each problem the same way everywhere', () => {
    expect(connectionProblemTitle(problem({}))).toBe('Fidelity NetBenefits needs you to sign in again');
    expect(connectionProblemText(problem({}))).toBe(
      "Fidelity NetBenefits needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.",
    );
    const genAuth = problem({ code: 'gen.auth', connectionName: undefined, sfinAccountIds: [], message: 'No credentials provided' });
    expect(connectionProblemTitle(genAuth)).toBe('SimpleFIN Bridge turned this sync away');
    expect(connectionProblemText(genAuth)).toBe(
      "SimpleFIN Bridge turned this sync away: No credentials provided. Until that's fixed, your accounts show the last figures SimpleFin got, not today's.",
    );
    const other = problem({ kind: 'other', code: 'act.failed', connectionName: 'Ally', message: 'A3: Failed to get account information', firstSeenAt: '2026-11-16T09:00:00.000Z' });
    expect(connectionProblemTitle(other)).toBe("Ally isn't updating");
    expect(connectionProblemText(other)).toBe(
      'SimpleFin has reported this since Nov 16: A3: Failed to get account information. Until it clears, the figures shown are the last ones SimpleFin got.',
    );
    expect(connectionProblemClearedText(problem({}))).toBe('Fidelity NetBenefits is updating again.');
    expect(connectionProblemClearedText(genAuth)).toBe('SimpleFin no longer reports: No credentials provided.');
  });

  it('words a sign-in by its CODE, not by whether a connection name is set', () => {
    const conNoName = problem({ connectionName: undefined });
    expect(connectionProblemTitle(conNoName)).toBe('A bank connection needs you to sign in again');
    expect(connectionProblemText(conNoName)).toBe(
      "A bank connection needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.",
    );
    const genNamed = problem({ code: 'gen.auth', connectionName: 'Fidelity NetBenefits', message: 'No credentials provided' });
    for (const g of [genNamed, problem({ code: 'gen.auth', connectionName: undefined, message: 'No credentials provided' })]) {
      expect(connectionProblemTitle(g)).toBe('SimpleFIN Bridge turned this sync away');
      expect(connectionProblemText(g)).toBe(
        "SimpleFIN Bridge turned this sync away: No credentials provided. Until that's fixed, your accounts show the last figures SimpleFin got, not today's.",
      );
    }
  });

  it('keeps a record exactly 48 hours old, drops it a millisecond later', () => {
    const at = (ms: number) => ({ checkedAt: new Date(NOW.getTime() - ms).toISOString(), problems: [problem({})] });
    const opts = { maxRecordAgeMs: PROBLEM_RECORD_MAX_AGE_MS };
    expect(shownConnectionProblems(at(48 * HOUR), NOW, opts)).toHaveLength(1);
    expect(shownConnectionProblems(at(48 * HOUR + 1), NOW, opts)).toEqual([]);
  });
});
