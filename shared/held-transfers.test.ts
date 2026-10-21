import { describe, it, expect } from 'vitest';
import { heldTransferMessage, judgeHeldTransfer, type HeldRow, type StoredFeeds } from './held-transfers.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-19T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const WIRE: HeldRow = {
  id: 'ph-1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20,
  wfAccountId: 'wf-chk', date: '2026-09-29', txId: 'w-old', direction: 'out',
};
/** Checking current; Harbor Savings proven alive through `savAlive`. */
const feeds = (savAlive: string, over: Partial<StoredFeeds> = {}): StoredFeeds => ({
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
  balances: {
    'sfin-chk': { date: epoch('2026-10-19T12:00:00Z'), aliveThrough: epoch('2026-10-19T12:00:00Z') },
    'sfin-sav': { date: epoch(savAlive), aliveThrough: epoch(savAlive) },
  },
  names: { 'sfin-chk': 'Checking', 'sfin-sav': 'Harbor Savings' },
  ...over,
});

describe('judgeHeldTransfer: marked "not a transfer" (1.65 C fix round 1)', () => {
  const key = accountTxKey('sfin-chk', 'w-old');

  it('says it is marked, replacing any held-by reason', () => {
    const h = judgeHeldTransfer(WIRE, feeds('2026-09-30T12:00:00Z'), NOW, new Set([key]));
    expect(h.marked).toBe(true);
    expect(heldTransferMessage(h)).toBe(
      'WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — marked not a transfer; the next sync settles it',
    );
  });

  it('ignores marks for other transactions, and an empty or absent set', () => {
    const f = feeds('2026-09-30T12:00:00Z');
    expect(judgeHeldTransfer(WIRE, f, NOW, new Set(['other'])).marked).toBeUndefined();
    expect(judgeHeldTransfer(WIRE, f, NOW, new Set()).marked).toBeUndefined();
    expect(judgeHeldTransfer(WIRE, f, NOW).marked).toBeUndefined();
  });
});

describe('judgeHeldTransfer (1.65 C)', () => {
  it('names the connected account whose feed holds the leg open, and the bank transaction to act on', () => {
    expect(judgeHeldTransfer(WIRE, feeds('2026-09-30T12:00:00Z'), NOW)).toEqual({
      activityId: 'ph-1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20, direction: 'out',
      heldBy: 'Harbor Savings', txKey: accountTxKey('sfin-chk', 'w-old'), label: 'WIRE TRANSFER TO ACME LLC · Checking',
    });
  });

  it("reads the feed's balance date when an older writer stored no aliveThrough", () => {
    const f = feeds('2026-09-30T12:00:00Z');
    const old = { ...f, balances: { ...f.balances, 'sfin-sav': { date: epoch('2026-09-30T12:00:00Z') } } };
    expect(judgeHeldTransfer(WIRE, old, NOW).heldBy).toBe('Harbor Savings');
  });

  it('holds nothing when every feed is caught up, and a feed silent over 21 days holds only a leg that names it', () => {
    expect(judgeHeldTransfer(WIRE, feeds('2026-10-19T12:00:00Z'), NOW).heldBy).toBeNull();
    expect(judgeHeldTransfer(WIRE, feeds('2026-09-20T12:00:00Z'), NOW).heldBy).toBeNull();
    expect(judgeHeldTransfer({ ...WIRE, description: 'ONLINE TRANSFER TO HARBOR SAVINGS 0000' }, feeds('2026-09-20T12:00:00Z'), NOW).heldBy)
      .toBe('Harbor Savings');
  });

  it('cannot tell why, and has no transaction to act on, when the account is unmapped or nothing was stored', () => {
    const unmapped = judgeHeldTransfer({ ...WIRE, wfAccountId: 'wf-gone' }, feeds('2026-09-30T12:00:00Z'), NOW);
    expect(unmapped.txKey).toBeNull();
    expect(unmapped).not.toHaveProperty('heldBy');
    expect(judgeHeldTransfer({ ...WIRE, txId: null }, feeds('2026-09-30T12:00:00Z'), NOW).txKey).toBeNull();
    const blind = judgeHeldTransfer(WIRE, undefined, NOW);
    expect(blind).toMatchObject({ txKey: null, label: 'WIRE TRANSFER TO ACME LLC', direction: 'out' });
    expect(blind).not.toHaveProperty('heldBy');
  });
});

describe('judgeHeldTransfer mirrors the sync (1.65 C fix round 1)', () => {
  it('an account missing from the last download gets no name words and no life, so it holds every leg', () => {
    const f: StoredFeeds = {
      mapping: { 'sfin-chk': 'wf-chk', 'sfin-card': 'wf-card' },
      balances: { 'sfin-chk': { date: epoch('2026-10-19T12:00:00Z'), aliveThrough: epoch('2026-10-19T12:00:00Z') } },
      names: { 'sfin-chk': 'Checking', 'sfin-card': 'Harbor Card' },
    };
    expect(judgeHeldTransfer(WIRE, f, NOW).heldBy).toBe('Harbor Card');
  });

  it('an old id a re-linked connection replaced holds nothing: its new id is the one in the download', () => {
    const f: StoredFeeds = {
      mapping: { 'sfin-chk': 'wf-chk', 'sfin-card-old': 'wf-card', 'sfin-card-new': 'wf-card' },
      balances: {
        'sfin-chk': { aliveThrough: epoch('2026-10-19T12:00:00Z') },
        'sfin-card-new': { aliveThrough: epoch('2026-10-19T12:00:00Z') },
      },
      names: { 'sfin-chk': 'Checking', 'sfin-card-old': 'Harbor Card', 'sfin-card-new': 'Harbor Card' },
    };
    expect(judgeHeldTransfer(WIRE, f, NOW).heldBy).toBeNull();
  });

  it('picks the reissued card feed that is in the download as the leg\'s own account', () => {
    const f: StoredFeeds = {
      mapping: { 'sfin-card-old': 'wf-card', 'sfin-chk': 'wf-chk', 'sfin-card-new': 'wf-card' },
      balances: {
        'sfin-chk': { aliveThrough: epoch('2026-10-19T12:00:00Z') },
        'sfin-card-new': { aliveThrough: epoch('2026-10-19T12:00:00Z') },
      },
      names: {},
    };
    expect(judgeHeldTransfer({ ...WIRE, wfAccountId: 'wf-card' }, f, NOW).txKey).toBe(accountTxKey('sfin-card-new', 'w-old'));
    const both = { ...f, balances: { ...f.balances, 'sfin-card-old': { aliveThrough: epoch('2026-10-19T12:00:00Z') } } };
    const amb = judgeHeldTransfer({ ...WIRE, wfAccountId: 'wf-card' }, both, NOW);
    expect(amb.txKey).toBeNull();
    expect(amb).not.toHaveProperty('heldBy');
  });

  it('cannot tell when the own account has no stored balance object', () => {
    const f = feeds('2026-09-30T12:00:00Z', { balances: {} });
    expect(judgeHeldTransfer(WIRE, f, NOW)).not.toHaveProperty('heldBy');
  });

  it('calls a holder with no stored name "another account"', () => {
    const f = feeds('2026-09-30T12:00:00Z', { names: { 'sfin-chk': 'Checking' } });
    const h = judgeHeldTransfer(WIRE, f, NOW);
    expect(h.heldBy).toBe('another account');
    expect(heldTransferMessage(h)).toContain("— another account's feed is behind");
  });

  it('prefers aliveThrough over the balance date, both ways', () => {
    const cur = epoch('2026-10-19T12:00:00Z');
    const old = epoch('2026-09-30T12:00:00Z');
    const f = feeds('2026-09-30T12:00:00Z');
    const aliveWins = { ...f, balances: { ...f.balances, 'sfin-sav': { date: old, aliveThrough: cur } } };
    expect(judgeHeldTransfer(WIRE, aliveWins, NOW).heldBy).toBeNull();
    const dateStale = { ...f, balances: { ...f.balances, 'sfin-sav': { date: cur, aliveThrough: old } } };
    expect(judgeHeldTransfer(WIRE, dateStale, NOW).heldBy).toBe('Harbor Savings');
  });
});

describe('heldTransferMessage (1.65 C)', () => {
  it('says why: the feed that is behind, that the next sync settles it, or nothing when it cannot tell', () => {
    const held = judgeHeldTransfer(WIRE, feeds('2026-09-30T12:00:00Z'), NOW);
    expect(heldTransferMessage(held)).toBe(
      "WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — Harbor Savings's feed is behind, so it stays on hold",
    );
    expect(heldTransferMessage({ ...held, heldBy: null })).toBe(
      'WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — the next sync settles it',
    );
    const { heldBy: _unknown, ...blind } = held;
    expect(heldTransferMessage(blind)).toBe('WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half');
  });
});

describe('judgeHeldTransfer tolerates a malformed stored name (1.65 C fix round 1)', () => {
  it('uses a name only when it is a string', () => {
    const bad = feeds('2026-09-30T12:00:00Z', { names: { 'sfin-chk': 7 as unknown as string, 'sfin-sav': { x: 1 } as unknown as string } });
    const h = judgeHeldTransfer(WIRE, bad, NOW);
    expect(h.label).toBe('WIRE TRANSFER TO ACME LLC');
    expect(h.heldBy).toBe('another account');
  });
});
