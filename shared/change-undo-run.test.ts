import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  amazonLabelChange, balanceCorrectionChange, categoryFiledChange, categoryRuleCreatedChange, duplicateRemovedChange,
  importChange, mappingRuleCreatedChange, stampChange, transferLinkChange, type ChangeDraft, type ChangeEntry,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
  UNDO_EXACT_COPY, UNDO_FROM_TELEGRAM, UNDO_LINKED_REFUSAL, UNDO_MAYBE_LINKED, UNDO_UNREACHABLE, UNDO_UPDATE_COMPANION, type UndoOp,
  type UndoVariant,
} from './change-undo.js';
import {
  maybeLinkedTransfer, runChangeUndo, UNDO_ALREADY_RUNNING, UNDO_MAPPING_RULES_UNREADABLE, UNDO_RULE_FILED_UNREADABLE, UNDO_SAVE_FAILED,
  UNDO_SKIP_NOTE, type UndoIo,
} from './change-undo-run.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from './skipped-transactions.js';
import { BALANCE_ADJUSTMENT_COMMENT_PREFIX, IN_TRANSIT_COMMENT_PREFIX, STARTING_BALANCE_COMMENT_PREFIX } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import {
  emptySyncOverrides, setTxOverride, hasAccountOverride, hasTxOverride, parseSyncOverrides, SYNC_OVERRIDES_SECRET_KEY, SYNC_OVERRIDES_UNREADABLE_MESSAGE,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const CHECKING = { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' };
const KEY = accountTxKey('sfin-1', 'tx-1');

const seedWith = (rows: HostActivity[], extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Checking' },
  existing: new Map([['wf-a', rows]]),
  ...extra,
});

/**
 * A host, its secrets and a change log in memory. `undo` runs one Undo/Redo
 * the way a surface does: off the log as it stands, recording into it.
 */
function harness(seed: FakeHostSeed, secrets: Record<string, string> = {}, more: Partial<UndoIo> = {}) {
  const fh = createFakeHost(seed);
  const data = new Map(Object.entries(secrets));
  const log: ChangeEntry[] = [];
  const set = vi.fn(async (k: string, v: string) => { data.set(k, v); });
  const io: UndoIo = {
    host: fh.host,
    secrets: { get: async (k) => data.get(k) ?? null, set },
    record: vi.fn(async (d: ChangeDraft) => { log.unshift(stampChange(d, 'companion', NOW)); }),
    where: { host: 'companion', companionVersion: null },
    ...more,
  };
  const asItem = (e: ChangeEntry): ChangeLogItem => {
    const latest = log.find((x) => x.reverses?.id === e.id);
    return latest?.reverses?.op === 'undo' ? { ...e, undone: { by: latest.id, at: latest.at } } : { ...e };
  };
  const undo = (e: ChangeEntry, op: UndoOp, variant: UndoVariant = 'plain') => runChangeUndo(asItem(e), [...log, e], op, io, variant, NOW);
  const overrides = () => {
    const p = parseSyncOverrides(data.get(SYNC_OVERRIDES_SECRET_KEY));
    if (p.kind !== 'ok') throw new Error(`overrides ${p.kind}`);
    return p.overrides;
  };
  return { fh, data, set, io, log, undo, asItem, overrides };
}

describe('runChangeUndo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const plugRow: HostActivity = {
    id: 'plug-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-12', amount: 2.15,
    comment: 'Balance adjustment · sfin-1 · 2026-10-12', sourceGroupId: null,
  };
  const plug = stampChange(balanceCorrectionChange({
    account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
    comment: 'Balance adjustment · sfin-1 · 2026-10-12',
  }), 'companion', new Date('2026-10-12T10:00:00Z'));

  it('undo → redo → undo on one entry: the row, the override and the log stay consistent', async () => {
    const h = harness(seedWith([plugRow]));
    expect(await h.undo(plug, 'undo')).toEqual({ ok: true, message: 'Undone — the correction is gone.', needsSync: false });
    expect(h.fh.activities.get('wf-a')).toEqual([]);
    expect(hasAccountOverride(h.overrides(), 'sfin-1', 'noAutoCorrect')).toBe(true);

    expect(await h.undo(plug, 'redo')).toMatchObject({ ok: true, message: 'Redone — the correction is back.' });
    const back = h.fh.activities.get('wf-a')!;
    expect(back.map((r) => [r.activityType, r.amount, r.comment])).toEqual([['TRANSFER_OUT', 2.15, 'Balance adjustment · sfin-1 · 2026-10-12']]);
    expect(hasAccountOverride(h.overrides(), 'sfin-1', 'noAutoCorrect')).toBe(false);
    expect(h.log[0].after).toMatchObject({ activityId: back[0].id });

    expect(await h.undo(plug, 'undo')).toMatchObject({ ok: true });
    expect(h.fh.activities.get('wf-a')).toEqual([]);
    expect(hasAccountOverride(h.overrides(), 'sfin-1', 'noAutoCorrect')).toBe(true);
    expect(h.log.map((e) => e.reverses)).toEqual([
      { id: plug.id, op: 'undo' }, { id: plug.id, op: 'redo' }, { id: plug.id, op: 'undo' },
    ]);
    expect(h.asItem(plug).undone).toBeDefined();
    // And a fourth tap on a stale Undo button is refused, writing nothing.
    h.set.mockClear();
    expect(await runChangeUndo({ ...plug }, [...h.log, plug], 'undo', h.io, 'plain', NOW)).toEqual({ ok: false, message: 'That one is already undone.' });
    expect(h.set).not.toHaveBeenCalled();
  });

  it('refuses to undo a filing the person re-filed since, and writes nothing', async () => {
    const assign = vi.fn(async () => {});
    const unassign = vi.fn(async () => {});
    const filing = stampChange(categoryFiledChange({
      actor: 'auto', account: CHECKING, txKey: KEY, activityId: 'act-amz', description: 'AMAZON MKTPL*2K4',
      before: null, after: { categoryId: 'cat-pc', categoryName: 'Personal Care', taxonomyId: 'spending_categories' },
    }), 'companion', NOW);
    const h = harness(seedWith([]), {}, {
      categories: { assignments: async () => [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro' }], assign, unassign },
    });
    expect(await h.undo(filing, 'undo')).toEqual({ ok: false, message: 'It has changed since — nothing was undone.' });
    expect(assign).not.toHaveBeenCalled();
    expect(unassign).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('an automatic filing undone: noAutoFile first, then the category off', async () => {
    const calls: string[] = [];
    const filing = stampChange(categoryFiledChange({
      actor: 'auto', account: CHECKING, txKey: KEY, activityId: 'act-amz', description: 'AMAZON MKTPL*2K4',
      before: null, after: { categoryId: 'cat-pc', categoryName: 'Personal Care', taxonomyId: 'spending_categories' },
    }), 'companion', NOW);
    const h = harness(seedWith([]), {}, {
      categories: {
        assignments: async () => [{ taxonomyId: 'spending_categories', categoryId: 'cat-pc' }],
        assign: async () => { calls.push('assign'); },
        unassign: async (id, tax) => { calls.push(`unassign ${id} ${tax}`); },
      },
    });
    h.set.mockImplementation(async (k: string, v: string) => { calls.push(`set ${k}`); h.data.set(k, v); });
    expect(await h.undo(filing, 'undo')).toMatchObject({ ok: true, message: 'Undone — no category.' });
    expect(calls).toEqual([`set ${SYNC_OVERRIDES_SECRET_KEY}`, 'unassign act-amz spending_categories']);
    expect(hasTxOverride(h.overrides(), KEY, 'noAutoFile')).toBe(true);
    expect(h.overrides().tx[KEY]).toMatchObject({ entryId: filing.id, label: 'AMAZON MKTPL*2K4 · Checking' });
  });

  it('a corrupt sync_overrides refuses the undo with a clear message, nothing overwritten or written', async () => {
    const link = stampChange(transferLinkChange(
      { account: CHECKING, txKey: KEY, description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1' },
      { account: { sfinId: 'sfin-2', wfId: 'wf-b', name: 'Citi' }, txKey: accountTxKey('sfin-2', 'tx-1'), description: 'PAYMENT', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2' },
    ), 'companion', NOW);
    const h = harness(seedWith([]), { [SYNC_OVERRIDES_SECRET_KEY]: '{"v":1,"tx":"broken"}' });
    expect(await h.undo(link, 'undo')).toEqual({ ok: false, message: SYNC_OVERRIDES_UNREADABLE_MESSAGE });
    expect(h.data.get(SYNC_OVERRIDES_SECRET_KEY)).toBe('{"v":1,"tx":"broken"}');
    expect(h.set).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('a duplicate Wealthfolio refuses as an exact copy: nothing changes, and it says why', async () => {
    const survivor: HostActivity = {
      id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06', amount: 21.2, comment: 'TRADER JOE S #628 · tx-1', sourceGroupId: null,
    };
    const dup = stampChange(duplicateRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-2', description: 'TRADER JOE S #628', amountCents: -2120, date: '2026-08-06',
      payload: { accountId: 'wf-a', activityType: 'WITHDRAWAL', activityDate: '2026-08-06', symbol: { symbol: '$CASH-USD' }, amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · tx-1' },
    }), 'companion', NOW);
    const h = harness(seedWith([survivor], { upstreamWriteRules: true }));
    expect(await h.undo(dup, 'undo')).toEqual({ ok: false, message: UNDO_EXACT_COPY });
    expect(h.fh.activities.get('wf-a')!.map((r) => r.id)).toEqual(['act-1']);
    expect(hasTxOverride(h.overrides(), KEY, 'keepDuplicate')).toBe(false);
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('a duplicate that differs is put back and kept', async () => {
    const dup = stampChange(duplicateRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-2', description: 'TRADER JOE S #628', amountCents: -2120, date: '2026-08-06',
      payload: { accountId: 'wf-a', activityType: 'WITHDRAWAL', activityDate: '2026-08-07', symbol: { symbol: '$CASH-USD' }, amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · tx-1' },
    }), 'companion', NOW);
    const h = harness(seedWith([], { upstreamWriteRules: true }));
    expect(await h.undo(dup, 'undo')).toEqual({ ok: true, message: 'Undone — both copies stay.', needsSync: false });
    const copy = h.fh.activities.get('wf-a')![0];
    expect(hasTxOverride(h.overrides(), KEY, 'keepDuplicate')).toBe(true);
    expect(h.log[0].after).toMatchObject({ activityId: copy.id });
  });

  const imported = stampChange(importChange({
    account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650, date: '2026-10-11',
    pending: false, activityType: 'WITHDRAWAL',
  }), 'companion', NOW);
  const importedRow = (group: string | null = null): HostActivity => ({
    id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-11', amount: 6.5, comment: 'SQ *BLUE_BOTTLE · tx-1', sourceGroupId: group,
  });

  it('an import: on the skip list, and removed; a redo takes it off the list for the next sync', async () => {
    const h = harness(seedWith([importedRow()]));
    expect(await h.undo(imported, 'undo')).toMatchObject({ ok: true, needsSync: false });
    expect(h.fh.activities.get('wf-a')).toEqual([]);
    expect(JSON.parse(h.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([{ account: 'sfin-1', txId: 'tx-1', note: UNDO_SKIP_NOTE, at: NOW.toISOString() }]);
    expect(await h.undo(imported, 'redo')).toEqual({ ok: true, message: 'Redone — the next sync imports it again.', needsSync: true });
    expect(JSON.parse(h.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([]);
  });

  it('an import whose pending row later posted under a new tx id: the skip list gets the new key, and a redo takes it off', async () => {
    const posted: HostActivity = { ...importedRow(), comment: 'SQ *BLUE_BOTTLE · tx-2' };
    const h = harness(seedWith([posted]));
    expect(await h.undo(imported, 'undo')).toMatchObject({ ok: true });
    expect(JSON.parse(h.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([{ account: 'sfin-1', txId: 'tx-2', note: UNDO_SKIP_NOTE, at: NOW.toISOString() }]);
    expect(await h.undo(imported, 'redo')).toMatchObject({ ok: true });
    expect(JSON.parse(h.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([]);
  });

  it('undo of a removed duplicate → redo targets the re-created row', async () => {
    const dup = stampChange(duplicateRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-2', description: 'TRADER JOE S #628', amountCents: -2120, date: '2026-08-06',
      payload: { accountId: 'wf-a', activityType: 'WITHDRAWAL', activityDate: '2026-08-07', symbol: { symbol: '$CASH-USD' }, amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · tx-1' },
    }), 'companion', NOW);
    const h = harness(seedWith([], { upstreamWriteRules: true }));
    expect(await h.undo(dup, 'undo')).toMatchObject({ ok: true });
    const x = h.fh.activities.get('wf-a')![0].id;
    expect(x).not.toBe('act-2');
    expect(h.log[0].after).toMatchObject({ activityId: x });
    // The redo finds the re-created row by its new id (the next re-scan removes it again).
    expect(await h.undo(dup, 'redo')).toMatchObject({ ok: true, needsSync: true });
    expect(h.log[0].after).toMatchObject({ activityId: x });
    expect(hasTxOverride(h.overrides(), KEY, 'keepDuplicate')).toBe(false);
  });

  it('refuses to remove one half of a linked pair, on either host', async () => {
    const companion = harness(seedWith([importedRow('wf-transfer-1')]));
    expect(await companion.undo(imported, 'undo')).toEqual({ ok: false, message: UNDO_LINKED_REFUSAL });
    expect(companion.set).not.toHaveBeenCalled();
    const addon = harness(seedWith([importedRow()]), { linked_groups: JSON.stringify({ [KEY]: 'wf-transfer-1' }) });
    addon.io.host = { ...addon.fh.host, capabilities: { readsSourceGroupId: false } };
    expect(await addon.undo(imported, 'undo')).toEqual({ ok: false, message: UNDO_LINKED_REFUSAL });
    expect(addon.fh.activities.get('wf-a')).toHaveLength(1);
  });

  describe('on the add-on, which cannot read groups: one half of a pair the companion linked', () => {
    const OUT_KEY = accountTxKey('sfin-1', 'tx-out');
    const LINKED = '{"flow":{"is_external":false}}';
    const outRow = (over: Partial<HostActivity> = {}): HostActivity => ({
      id: 'act-out', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-08', amount: 464.6,
      comment: 'AMAZON.COM*MB3T81 · tx-out', sourceGroupId: 'wf-transfer-9', metadata: LINKED, ...over,
    });
    const inRow = (over: Partial<HostActivity> = {}): HostActivity => ({
      id: 'act-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2026-10-09', amount: 464.6,
      comment: 'PAYMENT THANK YOU · tx-in', sourceGroupId: 'wf-transfer-9', metadata: LINKED, ...over,
    });
    /**
     * The add-on as Wealthfolio serves it: a read carries no group (ActivityDetails
     * has none), deleting one half of a linked pair deletes both, and an update to
     * one half is copied onto the other (`upstreamWriteRules`). The companion linked
     * the pair, so the add-on's own `linked_groups` ledger is EMPTY.
     */
    function addon(out: HostActivity, partner: HostActivity | null, secrets: Record<string, string> = {}) {
      const h = harness({
        mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
        accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CREDIT_CARD' },
        accountNames: { 'wf-a': 'Checking', 'wf-b': 'Amazon Store Card' },
        existing: new Map([['wf-a', [out]], ['wf-b', partner ? [partner] : []]]),
        upstreamWriteRules: true,
      }, secrets, { where: { host: 'addon', companionVersion: '1.61.0' } });
      const real = h.fh.host;
      h.io.host = {
        ...real,
        capabilities: { readsSourceGroupId: false },
        listActivities: async (wf: string) => (await real.listActivities(wf)).map((r) => ({ ...r, sourceGroupId: null })),
        saveMany: async (req) => {
          if (!req.deleteIds) return real.saveMany(req);
          const all = [...h.fh.activities.values()].flat();
          const ids = new Set<string>(req.deleteIds);
          for (const id of req.deleteIds) {
            const r = all.find((x) => x.id === id);
            if (r?.sourceGroupId) for (const o of all) if (o.sourceGroupId === r.sourceGroupId) ids.add(o.id);
          }
          return real.saveMany({ ...req, deleteIds: [...ids] });
        },
      };
      return h;
    }
    const importedOut = stampChange(importChange({
      account: CHECKING, txKey: OUT_KEY, activityId: 'act-out', description: 'AMAZON.COM*MB3T81', amountCents: -46460, date: '2026-10-08',
      pending: false, activityType: 'TRANSFER_OUT',
    }), 'addon', NOW);
    const labelledOut = stampChange(amazonLabelChange({
      account: CHECKING, txKey: OUT_KEY, activityId: 'act-out', description: 'AMAZON.COM*MB3T81', amountCents: -46460, date: '2026-10-08',
      beforeNote: 'AMAZON.COM*MB3T81 · tx-out', afterNote: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-out', label: 'Lawn & Garden',
    }), 'addon', NOW);

    it('an import undo is refused, writing nothing — Wealthfolio would delete both halves', async () => {
      const h = addon(outRow(), inRow());
      expect(await h.undo(importedOut, 'undo')).toEqual({ ok: false, message: UNDO_MAYBE_LINKED });
      expect(h.set).not.toHaveBeenCalled();
      expect(h.fh.saved).toEqual([]);
      expect(h.fh.activities.get('wf-a')).toHaveLength(1);
      expect(h.fh.activities.get('wf-b')).toHaveLength(1);
      expect(h.io.record).not.toHaveBeenCalled();
      expect(UNDO_MAYBE_LINKED).toBe('This may be half of a linked transfer — undo the link first, or undo it from Telegram: /changes');
    });

    it('an Amazon label undo is refused, writing nothing — Wealthfolio would copy the note onto the other half', async () => {
      const h = addon(outRow({ comment: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-out' }), inRow());
      expect(await h.undo(labelledOut, 'undo')).toEqual({ ok: false, message: UNDO_MAYBE_LINKED });
      expect(h.set).not.toHaveBeenCalled();
      expect(h.fh.saved).toEqual([]);
      expect(h.fh.activities.get('wf-a')![0].comment).toBe('AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-out');
      expect(h.fh.activities.get('wf-b')![0].comment).toBe('PAYMENT THANK YOU · tx-in');
    });

    it('a pair the ledger confirms keeps "Undo the transfer link first."', async () => {
      const h = addon(outRow(), inRow(), { linked_groups: JSON.stringify({ [OUT_KEY]: 'wf-transfer-9' }) });
      expect(await h.undo(importedOut, 'undo')).toEqual({ ok: false, message: UNDO_LINKED_REFUSAL });
      expect(h.set).not.toHaveBeenCalled();
      expect(h.fh.saved).toEqual([]);
    });

    it('a transfer-typed row the sync marked external is not refused', async () => {
      const h = addon(outRow({ sourceGroupId: null, metadata: '{"flow":{"is_external":true}}' }), null);
      expect(await h.undo(importedOut, 'undo')).toMatchObject({ ok: true });
      expect(h.fh.activities.get('wf-a')).toEqual([]);
    });

    it('a held in-transit placeholder is not refused', async () => {
      const h = addon(outRow({ sourceGroupId: null, metadata: undefined, comment: `${IN_TRANSIT_COMMENT_PREFIX}AMAZON.COM*MB3T81 · tx-out` }), null);
      expect(await h.undo(importedOut, 'undo')).toMatchObject({ ok: true });
      expect(h.fh.activities.get('wf-a')).toEqual([]);
    });

    it('a linked half that kept a placeholder note (its promotion was refused, then it was linked) is refused, writing nothing', async () => {
      const h = addon(outRow({ comment: `${IN_TRANSIT_COMMENT_PREFIX}AMAZON.COM*MB3T81 · tx-out` }), inRow());
      expect(await h.undo(importedOut, 'undo')).toEqual({ ok: false, message: UNDO_MAYBE_LINKED });
      expect(h.set).not.toHaveBeenCalled();
      expect(h.fh.saved).toEqual([]);
      expect(h.fh.activities.get('wf-a')).toHaveLength(1);
      expect(h.fh.activities.get('wf-b')).toHaveLength(1);
    });

    it('the companion reads the group off the row, so an unlinked transfer-typed row is never "maybe"', async () => {
      const h = harness(seedWith([outRow({ sourceGroupId: null })]));
      expect(await h.undo(importedOut, 'undo')).toMatchObject({ ok: true });
      expect(h.fh.activities.get('wf-a')).toEqual([]);
    });
  });

  it('only an unflagged, unmarked transfer-typed row may be half of a pair the add-on cannot see', () => {
    const base: HostActivity = { id: 'a', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-08', amount: 1, comment: 'ZELLE TO J SMITH · tx-1' };
    expect(maybeLinkedTransfer(base)).toBe(true);
    expect(maybeLinkedTransfer({ ...base, metadata: '{"flow":{"is_external":false}}' })).toBe(true);
    expect(maybeLinkedTransfer({ ...base, metadata: null })).toBe(true);
    expect(maybeLinkedTransfer({ ...base, activityType: 'TRANSFER_IN' })).toBe(true);
    expect(maybeLinkedTransfer({ ...base, activityType: 'WITHDRAWAL' })).toBe(false);
    expect(maybeLinkedTransfer({ ...base, metadata: '{"flow":{"is_external":true}}' })).toBe(false);
    expect(maybeLinkedTransfer({ ...base, comment: `${IN_TRANSIT_COMMENT_PREFIX}ZELLE TO J SMITH · tx-1` })).toBe(false);
    // A placeholder note on a row a link wrote (`is_external: false`) is not a placeholder.
    expect(maybeLinkedTransfer({ ...base, comment: `${IN_TRANSIT_COMMENT_PREFIX}ZELLE TO J SMITH · tx-1`, metadata: '{"flow":{"is_external":false}}' })).toBe(true);
    expect(maybeLinkedTransfer({ ...base, comment: `${IN_TRANSIT_COMMENT_PREFIX}ZELLE TO J SMITH · tx-1`, metadata: '{"flow":{"is_external":true}}' })).toBe(false);
    expect(maybeLinkedTransfer({ ...base, comment: `${STARTING_BALANCE_COMMENT_PREFIX}sfin-1` })).toBe(false);
    expect(maybeLinkedTransfer({ ...base, comment: `${BALANCE_ADJUSTMENT_COMMENT_PREFIX}sfin-1 · 2026-10-12` })).toBe(false);
  });

  it('an Amazon label: noAmazonLabel, then the old note back', async () => {
    const label = stampChange(amazonLabelChange({
      account: CHECKING, txKey: KEY, activityId: 'act-amz', description: 'AMAZON.COM*MB3T81', amountCents: -2118, date: '2026-08-06',
      beforeNote: 'AMAZON.COM*MB3T81 · tx-1', afterNote: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-1', label: 'Lawn & Garden',
    }), 'companion', NOW);
    const h = harness(seedWith([{
      id: 'act-amz', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06', amount: 21.18,
      comment: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-1', sourceGroupId: null,
    }]));
    expect(await h.undo(label, 'undo')).toMatchObject({ ok: true });
    expect(h.fh.activities.get('wf-a')![0]).toMatchObject({ comment: 'AMAZON.COM*MB3T81 · tx-1', activityType: 'WITHDRAWAL', amount: 21.18 });
    expect(hasTxOverride(h.overrides(), KEY, 'noAmazonLabel')).toBe(true);
  });

  it('a transaction rule leaves mapping_rules and comes back; an unreadable list is refused', async () => {
    const rule = { pattern: 'Payment to Ccb', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
    const other = { pattern: 'ZELLE', matchType: 'contains' as const, activityType: 'TRANSFER_IN' as const };
    const mapping = stampChange(mappingRuleCreatedChange({ rule }), 'companion', NOW);
    const h = harness(seedWith([]), { mapping_rules: JSON.stringify([rule, other]) });
    expect(await h.undo(mapping, 'undo')).toEqual({ ok: true, message: 'Undone — the rule is gone.', needsSync: true });
    expect(JSON.parse(h.data.get('mapping_rules')!)).toEqual([other]);
    expect(await h.undo(mapping, 'redo')).toMatchObject({ ok: true, needsSync: true });
    expect(JSON.parse(h.data.get('mapping_rules')!)).toEqual([other, rule]);
    const broken = harness(seedWith([]), { mapping_rules: '[{' });
    expect(await broken.undo(mapping, 'undo')).toEqual({ ok: false, message: UNDO_MAPPING_RULES_UNREADABLE });
    expect(broken.set).not.toHaveBeenCalled();
  });

  describe('category rules', () => {
    const made = (ruleId: string | null) => stampChange(categoryRuleCreatedChange({
      ruleId, name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries',
    }), 'companion', NOW);
    const rulesOver = (list: Array<{ id: string; name: string; pattern: string }>, filed: string[] | null = []) => {
      const unassign = vi.fn(async () => {});
      const io: Partial<UndoIo> = {
        categories: { assignments: async () => [], assign: vi.fn(async () => {}), unassign },
        rules: {
          list: async () => list,
          create: vi.fn(async (r) => { list.push({ id: `rule-${list.length + 8}`, name: r.name, pattern: r.pattern }); return `rule-${list.length + 7}`; }),
          remove: vi.fn(async (id: string) => { list.splice(list.findIndex((r) => r.id === id), 1); }),
          filedBy: async () => filed,
        },
      };
      return { io, unassign, list };
    };

    it('deletes by id, re-creates on a redo, and the next undo deletes the new one', async () => {
      const entry = made('rule-7');
      const r = rulesOver([{ id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S' }]);
      const h = harness(seedWith([]), {}, r.io);
      expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true, message: 'Undone — the rule is gone.' });
      expect(r.list).toEqual([]);
      expect(await h.undo(entry, 'redo')).toMatchObject({ ok: true });
      expect(h.log[0].after).toMatchObject({ ruleId: 'rule-8' });
      expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true });
      expect(h.io.rules!.remove).toHaveBeenLastCalledWith('rule-8');
    });

    it('finds a rule by name when the log has no id', async () => {
      const r = rulesOver([{ id: 'rule-x', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S' }]);
      const h = harness(seedWith([]), {}, r.io);
      expect(await h.undo(made(null), 'undo')).toMatchObject({ ok: true });
      expect(h.io.rules!.remove).toHaveBeenCalledWith('rule-x');
    });

    it('Undo rule + un-file takes its charges out too, or refuses when it cannot tell which', async () => {
      const r = rulesOver([{ id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S' }], ['a1', 'a2']);
      const h = harness(seedWith([]), {}, r.io);
      expect(await h.undo(made('rule-7'), 'undo', 'unfile')).toMatchObject({ ok: true, message: 'Undone — the rule is gone and 2 charges are back in the needs-a-category list.' });
      expect(r.unassign.mock.calls).toEqual([['a1', 'spending_categories'], ['a2', 'spending_categories']]);
      expect(h.log[0].after).toMatchObject({ unfiledActivityIds: ['a1', 'a2'] });
      const unknown = rulesOver([{ id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S' }], null);
      const h2 = harness(seedWith([]), {}, unknown.io);
      expect(await h2.undo(made('rule-7'), 'undo', 'unfile')).toEqual({ ok: false, message: UNDO_RULE_FILED_UNREADABLE });
      expect(unknown.io.rules!.remove).not.toHaveBeenCalled();
    });
  });

  it('the app: a category entry points at Telegram; an old companion blocks a sync decision', async () => {
    const filing = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: 'VENMO', before: null, after: { categoryId: 'c', categoryName: 'Dining' },
    }), 'addon', NOW);
    const app = harness(seedWith([importedRow()]), {}, { where: { host: 'addon', companionVersion: '1.59.2' } });
    expect(await app.undo(filing, 'undo')).toEqual({ ok: false, message: UNDO_FROM_TELEGRAM });
    expect(await app.undo(imported, 'undo')).toEqual({ ok: false, message: UNDO_UPDATE_COMPANION });
    expect(app.fh.activities.get('wf-a')).toHaveLength(1);
    expect(app.set).not.toHaveBeenCalled();
  });

  it('says Wealthfolio could not be reached when the re-read fails, and writes nothing', async () => {
    const h = harness(seedWith([importedRow()]));
    h.io.host = { ...h.fh.host, listActivities: async () => { throw new Error('ECONNREFUSED'); } };
    expect(await h.undo(imported, 'undo')).toEqual({ ok: false, message: UNDO_UNREACHABLE });
    expect(h.set).not.toHaveBeenCalled();
  });

  describe('honest failures', () => {
    const filing = (actor: 'auto' | 'you' = 'auto', before: { categoryId: string; categoryName: string; taxonomyId: string } | null = null) => stampChange(categoryFiledChange({
      actor, account: CHECKING, txKey: KEY, activityId: 'act-amz', description: 'AMAZON MKTPL*2K4',
      before, after: { categoryId: 'cat-pc', categoryName: 'Personal Care', taxonomyId: 'spending_categories' },
    }), 'companion', NOW);
    const current = async () => [{ taxonomyId: 'spending_categories', categoryId: 'cat-pc' }];

    it('a redo whose new row id is not read back records no stale id, and the next undo refuses cleanly', async () => {
      const h = harness(seedWith([plugRow]));
      expect(await h.undo(plug, 'undo')).toMatchObject({ ok: true });
      const real = h.io.host;
      h.io.host = { ...real, listActivities: async () => [], listOldestActivities: async () => [] };
      expect(await h.undo(plug, 'redo')).toMatchObject({ ok: true });
      h.io.host = real;
      expect(h.log[0].after?.activityId).toBeUndefined();
      const deletes = vi.spyOn(real, 'saveMany');
      expect(await h.undo(plug, 'undo')).toMatchObject({ ok: false });
      expect(deletes).not.toHaveBeenCalled();
    });

    it('a reversal that fails after the override: the override stays, nothing is logged, and it says what failed', async () => {
      const h = harness(seedWith([]), {}, { categories: { assignments: current, assign: async () => {}, unassign: async () => { throw new Error('boom'); } } });
      expect(await h.undo(filing(), 'undo')).toEqual({ ok: false, message: "Couldn't finish the undo: boom" });
      expect(hasTxOverride(h.overrides(), KEY, 'noAutoFile')).toBe(true);
      expect(h.io.record).not.toHaveBeenCalled();
    });

    it('a partial failure says what was already done', async () => {
      const before = { categoryId: 'cat-old', categoryName: 'Dining', taxonomyId: 'spending_categories' };
      const h = harness(seedWith([]), {}, { categories: { assignments: current, assign: async () => { throw new Error('nope'); }, unassign: async () => {} } });
      expect(await h.undo(filing('you', before), 'undo')).toEqual({
        ok: false, message: "Couldn't finish the undo: nope. Part of it was already done: took the category off.",
      });
      expect(h.io.record).not.toHaveBeenCalled();
    });

    const dup = stampChange(duplicateRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-2', description: 'TRADER JOE S #628', amountCents: -2120, date: '2026-08-06',
      payload: { accountId: 'wf-a', activityType: 'WITHDRAWAL', activityDate: '2026-08-06', symbol: { symbol: '$CASH-USD' }, amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · tx-1' },
    }), 'companion', NOW);
    const survivor: HostActivity = {
      id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06', amount: 21.2, comment: 'TRADER JOE S #628 · tx-1', sourceGroupId: null,
    };

    it('an exact-copy refusal keeps a keepDuplicate that was already there', async () => {
      const pre = JSON.stringify(setTxOverride(emptySyncOverrides(), KEY, 'keepDuplicate', NOW, { label: 'earlier' }));
      const h = harness(seedWith([survivor], { upstreamWriteRules: true }), { [SYNC_OVERRIDES_SECRET_KEY]: pre });
      expect(await h.undo(dup, 'undo')).toEqual({ ok: false, message: UNDO_EXACT_COPY });
      expect(hasTxOverride(h.overrides(), KEY, 'keepDuplicate')).toBe(true);
    });

    it('an exact-copy refusal whose rollback fails says so instead of claiming nothing changed', async () => {
      const h = harness(seedWith([survivor], { upstreamWriteRules: true }));
      let writes = 0;
      h.set.mockImplementation(async (k: string, v: string) => {
        if (k === SYNC_OVERRIDES_SECRET_KEY && ++writes > 1) throw new Error('disk');
        h.data.set(k, v);
      });
      const out = await h.undo(dup, 'undo');
      expect(out.ok).toBe(false);
      expect(out.ok ? '' : out.message).toContain(UNDO_EXACT_COPY);
      expect(out.ok ? '' : out.message).toContain('could not be taken back');
      expect(hasTxOverride(h.overrides(), KEY, 'keepDuplicate')).toBe(true);
    });

    it('a failed save of the overrides says nothing was changed', async () => {
      const h = harness(seedWith([]), {}, { categories: { assignments: current, assign: async () => {}, unassign: vi.fn(async () => {}) } });
      h.set.mockImplementation(async () => { throw new Error('disk'); });
      expect(await h.undo(filing(), 'undo')).toEqual({ ok: false, message: UNDO_SAVE_FAILED });
      expect(h.io.record).not.toHaveBeenCalled();
    });

    it('a double tap: one run goes through, the other is refused, and one entry is logged', async () => {
      const h = harness(seedWith([importedRow()]));
      const real = h.io.host;
      h.io.host = { ...real, listActivities: async (id: string) => { await new Promise((r) => setTimeout(r, 20)); return real.listActivities(id); } };
      const [a, b] = await Promise.all([h.undo(imported, 'undo'), h.undo(imported, 'undo')]);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      expect([a, b].find((x) => !x.ok)!.message).toBe(UNDO_ALREADY_RUNNING);
      expect(h.log).toHaveLength(1);
      expect(await h.undo(imported, 'redo')).toMatchObject({ ok: true });
    });
  });
});
