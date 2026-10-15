import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { importChange, stampChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import { UNDO_LINKED_REFUSAL, UNDO_MAYBE_LINKED } from './change-undo.js';
import { runChangeUndo, type UndoIo } from './change-undo-run.js';
import { createFakeHost } from './fake-host.js';
import type { HostActivity } from './sync-host.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-1', 'tx-out');
/** A transfer leg the add-on cannot see a group on, metadata unknown: the old rule says "maybe linked". */
const leg: HostActivity = { id: 'act-out', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-08', amount: 600, comment: 'TO SAVINGS · tx-out', sourceGroupId: null };
const imported = stampChange(importChange({
  account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKey: KEY, activityId: 'act-out', description: 'TO SAVINGS',
  amountCents: -60000, date: '2026-10-08', pending: false, activityType: 'TRANSFER_OUT',
}), 'addon', NOW);

/** The add-on's Undo: a host that reads no groups, and Wealthfolio's facts as `linkFact` says them. */
function addonUndo(linkFact?: UndoIo['linkFact']) {
  const fh = createFakeHost({ mapping: { 'sfin-1': 'wf-a' }, accountTypes: { 'wf-a': 'CASH' }, existing: new Map([['wf-a', [{ ...leg }]]]) });
  const data = new Map<string, string>();
  const io: UndoIo = {
    host: { ...fh.host, capabilities: { readsSourceGroupId: false } },
    secrets: { get: async (k) => data.get(k) ?? null, set: async (k, v) => { data.set(k, v); } },
    record: vi.fn(async (_d: ChangeDraft) => {}),
    where: { host: 'addon', companionVersion: '1.62.0' },
    ...(linkFact ? { linkFact } : {}),
  };
  return { fh, run: (e: ChangeEntry) => runChangeUndo(e, [e], 'undo', io, 'plain', NOW) };
}

describe('the app\'s Undo decides "linked" from Wealthfolio\'s facts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('undoes an import of a transfer leg Wealthfolio says is unlinked', async () => {
    const h = addonUndo(async () => false);
    expect(await h.run(imported)).toMatchObject({ ok: true });
    expect(h.fh.activities.get('wf-a')).toEqual([]);
  });

  it('refuses one Wealthfolio says is linked, on its word', async () => {
    const h = addonUndo(async () => 'confirmed');
    expect(await h.run(imported)).toEqual({ ok: false, message: UNDO_LINKED_REFUSAL });
    expect(h.fh.saved).toEqual([]);
  });

  it.each([
    ['without facts (a 3.8 host)', undefined],
    ['with no fact for the row', async () => null],
    ['when the facts cannot be read', async () => { throw new Error('Failed to fetch'); }],
  ])('keeps the old "maybe linked" refusal %s', async (_what, linkFact) => {
    const h = addonUndo(linkFact as UndoIo['linkFact']);
    expect(await h.run(imported)).toEqual({ ok: false, message: UNDO_MAYBE_LINKED });
  });
});
