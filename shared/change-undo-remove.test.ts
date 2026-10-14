import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CHANGE_KINDS, duplicateRemovedChange, reversalChange, stampChange, transactionRemovedChange, transferLinkChange, type ChangeDraft, type ChangeEntry,
  type TransactionRemovedFacts,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { changeGroupOf, changeSourceText } from './change-view.js';
import {
  planChangeUndo, undoAvailability, undoChangedSince, undoGone, UNDO_EXACT_COPY, UNDO_LINKED_REFUSAL, UNDO_MAYBE_LINKED, UNDO_NO_KEY,
  UNDO_NOT_POSSIBLE, type UndoOp,
} from './change-undo.js';
import { runChangeUndo, type UndoIo } from './change-undo-run.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { parseSkippedTransactionsStrict, SKIPPED_TRANSACTIONS_SECRET_KEY } from './skipped-transactions.js';
import type { HostActivity } from './sync-host.js';
import { hasTxOverride, parseSyncOverrides, SYNC_OVERRIDES_SECRET_KEY } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const CHECKING = { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' };
const KEY = accountTxKey('sfin-1', 'TRN-600');
const PAYLOAD = {
  accountId: 'wf-a', activityType: 'DEPOSIT', activityDate: '2026-10-09', symbol: { symbol: '$CASH-USD' }, amount: 600,
  currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-600',
};
const ALLY_KEY = accountTxKey('sfin-2', 'TRN-9');
const OUT_LEG = { account: CHECKING, txKey: KEY, description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'o1', newActivityId: 'n1' };
const IN_LEG = {
  account: { sfinId: 'sfin-2', wfId: 'wf-b', name: 'Ally' }, txKey: ALLY_KEY, description: 'FROM PNC',
  amountCents: 60000, date: '2026-10-05', oldActivityId: 'o2', newActivityId: 'n2',
};
const removed = (over: Partial<TransactionRemovedFacts> = {}): ChangeEntry => stampChange(transactionRemovedChange({
  account: CHECKING, txKeys: [KEY], activityId: 'dup-1', description: 'MOBILE DEPOSIT', amountCents: 60000, date: '2026-10-09',
  payload: PAYLOAD, ...over,
}), 'addon', new Date('2026-10-14T12:00:00Z'));

describe('the entries R2 writes', () => {
  it('records a removal as yours and undoable, under Corrections, with the full create payload', () => {
    const e = removed();
    expect(e).toMatchObject({
      actor: 'you', kind: 'transaction-removed', undoable: true, summary: 'Removed MOBILE DEPOSIT for good',
      subject: { txKeys: [KEY], activityIds: ['dup-1'], amountCents: 60000, date: '2026-10-09' },
      before: { activityId: 'dup-1', activity: PAYLOAD },
    });
    expect(CHANGE_KINDS).toContain('transaction-removed');
    expect(changeGroupOf('transaction-removed')).toBe('corrections');
    expect(changeSourceText(e)).toBe('You, in the app');
    // Its Undo writes the row and the skip list itself: no companion gate, on either surface.
    expect(undoAvailability(e, { host: 'addon', companionVersion: '1.59.2' })).toEqual({ kind: 'ready', op: 'undo' });
    expect(undoAvailability(e, { host: 'companion', companionVersion: null })).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('records a link you made as yours, with the legs the sync records — and its Undo still waits for a companion that obeys overrides', () => {
    const yours = transferLinkChange(OUT_LEG, IN_LEG, 'you');
    expect(yours).toEqual({ ...transferLinkChange(OUT_LEG, IN_LEG), actor: 'you', why: 'You linked them from the Health list' });
    const item = stampChange(yours, 'addon', NOW);
    expect(undoAvailability(item, { host: 'addon', companionVersion: '1.59.2' })).toEqual({ kind: 'update-companion', op: 'undo', text: 'Update the companion first' });
    expect(undoAvailability(item, { host: 'addon', companionVersion: '1.61.0' })).toEqual({ kind: 'ready', op: 'undo' });
    const plan = planChangeUndo(item, 'undo', {}, { latest: null });
    expect(plan).toMatchObject({ ok: true, plan: { needsSync: true, steps: [{ do: 'set-tx', txKey: KEY, flag: 'notTransfer' }, { do: 'set-tx', flag: 'notTransfer' }] } });
  });
});

describe('planning the Undo and Redo of a removal', () => {
  const back = { id: 'back-1', accountId: 'wf-a', type: 'DEPOSIT', date: '2026-10-09', absCents: 60000, comment: PAYLOAD.comment };
  const undoneBy = (e: ChangeEntry) => stampChange(reversalChange(e, 'undo', { activityId: 'back-1' }), 'addon', NOW);

  it('puts the row back first, then takes it off the skip list', () => {
    expect(planChangeUndo(removed(), 'undo', {}, { latest: null })).toEqual({
      ok: true,
      plan: {
        op: 'undo', needsSync: false, rowAfter: 'created', done: "Undone — it's back, and the bank feed can import it again.",
        steps: [{ do: 'create', write: PAYLOAD }, { do: 'unskip', account: 'sfin-1', txId: 'TRN-600' }],
      },
    });
  });

  it('takes every key it skipped back off', () => {
    const two = removed({ txKeys: [KEY, accountTxKey('sfin-old', 'TRN-600')] });
    const plan = planChangeUndo(two, 'undo', {}, { latest: null });
    expect(plan.ok && plan.plan.steps.slice(1)).toEqual([
      { do: 'unskip', account: 'sfin-1', txId: 'TRN-600' }, { do: 'unskip', account: 'sfin-old', txId: 'TRN-600' },
    ]);
  });

  it('refuses an Undo it cannot carry out', () => {
    expect(planChangeUndo(removed({ txKeys: [] }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NO_KEY });
    expect(planChangeUndo(removed({ txKeys: ['no-separator'] }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NO_KEY });
    expect(planChangeUndo(removed({ payload: { amount: 600 } }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NOT_POSSIBLE });
    for (const amount of [0, -5, NaN, '600']) {
      expect(planChangeUndo(removed({ payload: { ...PAYLOAD, amount } }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NOT_POSSIBLE });
    }
    const { currency: _c, ...noCurrency } = PAYLOAD;
    expect(planChangeUndo(removed({ payload: noCurrency }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NOT_POSSIBLE });
  });

  it('a removed duplicate shares the validator: a bad amount or no currency cannot be re-created', () => {
    const dup = (payload: Record<string, unknown>) => stampChange(duplicateRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'd1', description: 'X', amountCents: 100, date: '2026-10-09', payload,
    }), 'addon', NOW);
    expect(planChangeUndo(dup({ ...PAYLOAD, amount: 0 }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NOT_POSSIBLE });
    expect(planChangeUndo(dup({ ...PAYLOAD, currency: undefined }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NOT_POSSIBLE });
  });

  it('removes the row the Undo put back again, skip first — unless it is gone or now linked', () => {
    const e = removed();
    const latest = undoneBy(e);
    expect(planChangeUndo(e, 'redo', { row: { ...back, linked: false } }, { latest })).toEqual({
      ok: true,
      plan: {
        op: 'redo', needsSync: false, rowAfter: null, done: "Redone — it's removed and won't be imported again.",
        steps: [{ do: 'skip', account: 'sfin-1', txId: 'TRN-600' }, { do: 'delete', activityId: 'back-1' }],
      },
    });
    expect(planChangeUndo(e, 'redo', { row: null }, { latest })).toEqual({ ok: false, reason: undoGone('redo') });
    expect(planChangeUndo(e, 'redo', { row: { ...back, linked: 'confirmed' } }, { latest })).toEqual({ ok: false, reason: UNDO_LINKED_REFUSAL });
    for (const edit of [{ absCents: 60100 }, { comment: 'edited note' }, { date: '2026-10-10' }, { type: 'WITHDRAWAL' }]) {
      expect(planChangeUndo(e, 'redo', { row: { ...back, ...edit, linked: false } }, { latest })).toEqual({ ok: false, reason: undoChangedSince('redo') });
    }
  });
});

describe('Undo and Redo of a removal, on a host', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(rows: HostActivity[], secrets: Record<string, string>, seed: Partial<FakeHostSeed> = {}, failSkipWrite: () => boolean = () => false) {
    const fh = createFakeHost({ mapping: { 'sfin-1': 'wf-a' }, accountTypes: { 'wf-a': 'CASH' }, existing: new Map([['wf-a', rows]]), ...seed });
    const data = new Map(Object.entries(secrets));
    const log: ChangeEntry[] = [];
    const io: UndoIo = {
      host: fh.host,
      secrets: { get: async (k) => data.get(k) ?? null, set: async (k, v) => {
        if (k === SKIPPED_TRANSACTIONS_SECRET_KEY && failSkipWrite()) throw new Error('disk full');
        data.set(k, v);
      },
    },
      record: async (d: ChangeDraft) => { log.unshift(stampChange(d, 'addon', NOW)); },
      where: { host: 'addon', companionVersion: '1.61.0' },
    };
    const asItem = (e: ChangeEntry): ChangeLogItem => {
      const latest = log.find((x) => x.reverses?.id === e.id);
      return latest?.reverses?.op === 'undo' ? { ...e, undone: { by: latest.id, at: latest.at } } : { ...e };
    };
    const undo = (e: ChangeEntry, op: UndoOp) => runChangeUndo(asItem(e), [...log, e], op, io, 'plain', NOW);
    const skipped = () => {
      const p = parseSkippedTransactionsStrict(data.get(SKIPPED_TRANSACTIONS_SECRET_KEY));
      return p.kind === 'ok' ? p.list.map((s) => `${s.account}/${s.txId}`) : p.kind;
    };
    return { fh, undo, skipped, log, data };
  }
  const list = JSON.stringify([
    { account: 'sfin-9', txId: 'KEEP' }, { account: 'sfin-1', txId: 'TRN-600', note: 'Removed for good', at: '2026-10-14T12:00:00.000Z' },
  ]);

  it('Undo re-creates the exact row and takes it off the skip list; Redo removes it again and skips it', async () => {
    const h = harness([], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: list });
    const e = removed();
    expect(await h.undo(e, 'undo')).toEqual({ ok: true, message: "Undone — it's back, and the bank feed can import it again.", needsSync: false });
    expect(h.fh.saved[0]).toEqual({ creates: [PAYLOAD] });
    const [row] = h.fh.activities.get('wf-a')!;
    expect(row).toMatchObject({ accountId: 'wf-a', activityType: 'DEPOSIT', date: '2026-10-09', amount: 600, comment: PAYLOAD.comment });
    expect(h.skipped()).toEqual(['sfin-9/KEEP']);
    expect(h.log[0]).toMatchObject({ kind: 'transaction-removed', reverses: { id: e.id, op: 'undo' }, after: { activityId: row.id } });

    expect(await h.undo(e, 'redo')).toEqual({ ok: true, message: "Redone — it's removed and won't be imported again.", needsSync: false });
    expect(h.fh.activities.get('wf-a')).toEqual([]);
    expect(h.skipped()).toEqual(['sfin-9/KEEP', 'sfin-1/TRN-600']);
  });

  it('Redo refuses a row edited since the Undo, and deletes nothing', async () => {
    const h = harness([], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: list });
    const e = removed();
    await h.undo(e, 'undo');
    h.fh.activities.get('wf-a')![0].amount = 650;
    expect(await h.undo(e, 'redo')).toEqual({ ok: false, message: undoChangedSince('redo') });
    expect(h.fh.activities.get('wf-a')).toHaveLength(1);
    expect(h.skipped()).toEqual(['sfin-9/KEEP']);
  });

  it('Redo refuses a row the add-on cannot rule out as linked', async () => {
    const h = harness([], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: list });
    const e = removed({ payload: { ...PAYLOAD, activityType: 'TRANSFER_IN' } });
    (h.fh.host as { capabilities: { readsSourceGroupId: boolean } }).capabilities = { readsSourceGroupId: false };
    await h.undo(e, 'undo');
    expect(await h.undo(e, 'redo')).toEqual({ ok: false, message: UNDO_MAYBE_LINKED });
    expect(h.fh.activities.get('wf-a')).toHaveLength(1);
  });

  it('a corrupt skip list refuses both Undo and Redo and writes nothing', async () => {
    const h = harness([], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: '{not json' });
    const e = removed();
    for (const op of ['undo', 'redo'] as const) {
      const r = await h.undo(e, op);
      expect(r.ok).toBe(false);
    }
    expect(h.fh.saved).toEqual([]);
    expect(h.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)).toBe('{not json');
    expect(h.log).toEqual([]);
  });

  it('records an Undo whose un-skip failed, says so, and Redo then Undo finishes it', async () => {
    let failing = true;
    const h = harness([], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: list }, {}, () => failing);
    const e = removed();
    const r = await h.undo(e, 'undo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('still on the skip list');
    expect(h.log[0]).toMatchObject({ kind: 'transaction-removed', reverses: { id: e.id, op: 'undo' } });
    expect(h.fh.activities.get('wf-a')).toHaveLength(1);
    failing = false;
    expect((await h.undo(e, 'redo')).ok).toBe(true);
    expect(h.fh.activities.get('wf-a')).toEqual([]);
    expect(h.skipped()).toEqual(['sfin-9/KEEP', 'sfin-1/TRN-600']);
    expect((await h.undo(e, 'undo')).ok).toBe(true);
    expect(h.skipped()).toEqual(['sfin-9/KEEP']);
  });

  it("Redo takes the key back off the skip list when the delete fails, and the note is the removal's", async () => {
    const h = harness([], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([{ account: 'sfin-9', txId: 'KEEP' }]) });
    const e = removed();
    await h.undo(e, 'undo');
    const real = h.fh.host.saveMany.bind(h.fh.host);
    h.fh.host.saveMany = async (req) => {
      if (req.deleteIds?.length) return { created: [], errors: [{ message: 'wealthfolio down' }] } as never;
      return real(req);
    };
    const r = await h.undo(e, 'redo');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('off the skip list again');
    expect(h.skipped()).toEqual(['sfin-9/KEEP']);
    expect(h.fh.activities.get('wf-a')).toHaveLength(1);
    h.fh.host.saveMany = real;
    expect((await h.undo(e, 'redo')).ok).toBe(true);
    const stored = JSON.parse(h.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!);
    expect(stored[1]).toMatchObject({ account: 'sfin-1', txId: 'TRN-600', note: 'Removed for good' });
  });

  it('Undo of a link you made tells the sync neither half is a transfer; Redo takes that back', async () => {
    const h = harness([], {});
    const link = stampChange(transferLinkChange(OUT_LEG, IN_LEG, 'you'), 'addon', new Date('2026-10-14T12:00:00Z'));
    const told = (key: string) => {
      const p = parseSyncOverrides(h.data.get(SYNC_OVERRIDES_SECRET_KEY));
      return p.kind === 'ok' && hasTxOverride(p.overrides, key, 'notTransfer');
    };
    expect(await h.undo(link, 'undo')).toEqual({ ok: true, message: 'Undone — the next sync counts each half as spending or money in.', needsSync: true });
    expect([told(KEY), told(ALLY_KEY)]).toEqual([true, true]);
    expect(await h.undo(link, 'redo')).toEqual({ ok: true, message: 'Redone — the next sync can treat them as a transfer again.', needsSync: true });
    expect([told(KEY), told(ALLY_KEY)]).toEqual([false, false]);
  });

  it('an Undo Wealthfolio refuses as an exact copy (the row was added back by hand) changes nothing', async () => {
    const byHand: HostActivity = { id: 'hand-1', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2026-10-09', amount: 600, comment: PAYLOAD.comment, sourceGroupId: null };
    const h = harness([byHand], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: list }, { upstreamWriteRules: true });
    expect(await h.undo(removed(), 'undo')).toEqual({ ok: false, message: UNDO_EXACT_COPY });
    expect(h.fh.activities.get('wf-a')!.map((r) => r.id)).toEqual(['hand-1']);
    expect(h.skipped()).toEqual(['sfin-9/KEEP', 'sfin-1/TRN-600']);
    expect(h.log).toEqual([]);
  });
});
