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
