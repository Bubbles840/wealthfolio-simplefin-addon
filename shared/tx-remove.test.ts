import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stampChange, type ChangeDraft, type ChangeEntry } from './change-entries';
import type { ChangeLogItem } from './change-log';
import { runChangeUndo, type UndoIo } from './change-undo-run';
import { createFakeHost } from './fake-host';
import { fixRowOf, type FixRow } from './fix-row';
import { parseSkippedTransactionsStrict, SKIPPED_TRANSACTIONS_SECRET_KEY } from './skipped-transactions';
import type { HostActivity } from './sync-host';
import { accountTxKey } from './transfers';
import type { TxStoryFacts } from './tx-story';
import {
  removalFingerprint, removalOffered, removeForGood, REMOVE_CHANGED, REMOVE_DONE, REMOVE_MANAGED, REMOVE_NOT_FEED, REMOVE_PENDING,
  REMOVE_SKIP_NOTE, REMOVE_SKIP_UNREADABLE, REMOVE_UNLINK_FIRST, REMOVE_UNREACHABLE, type RemoveIo,
} from './tx-remove';

const NOW = new Date('2026-10-14T15:00:00Z');
const NOTE = 'MOBILE DEPOSIT · TRN-600';
const ROW: FixRow = {
  id: 'dup-1', accountId: 'wf-chk', accountName: 'PNC Checking', accountType: 'CASH', type: 'DEPOSIT', date: '2026-10-09',
  absCents: 60000, feeCents: 0, currency: 'USD', notes: NOTE, subtype: null, flowExternal: null, grouped: false,
};
const shown = (r: FixRow = ROW) => removalFingerprint({
  activityId: r.id, note: r.notes, absCents: r.absCents, date: r.date, activityType: r.type, accountName: r.accountName,
});
const FP = shown();
const KEY = accountTxKey('sfin-chk', 'TRN-600');

function fakeIo(over: Partial<RemoveIo> = {}, secrets: Record<string, string> = {}) {
  const data = new Map(Object.entries(secrets));
  const calls: string[] = [];
  const recorded: ChangeDraft[] = [];
  const io: RemoveIo = {
    read: vi.fn(async () => ROW),
    feeds: vi.fn(async () => ['sfin-chk']),
    linked: vi.fn(async () => false as const),
    secrets: {
      get: async (k) => data.get(k) ?? null,
      set: vi.fn(async (k: string, v: string) => { calls.push(`set ${k}`); data.set(k, v); }),
    },
    remove: vi.fn(async (id: string) => { calls.push(`remove ${id}`); }),
    record: vi.fn(async (d: ChangeDraft) => { recorded.push(d); }),
    log: vi.fn(),
    ...over,
  };
  const skipped = () => {
    const p = parseSkippedTransactionsStrict(data.get(SKIPPED_TRANSACTIONS_SECRET_KEY));
    return p.kind === 'ok' ? p.list : p.kind;
  };
  return { io, calls, recorded, skipped };
}

describe('removalOffered', () => {
  const facts = (over: Partial<TxStoryFacts> = {}, note = NOTE): TxStoryFacts => ({
    row: { activityId: 'dup-1', note, absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' },
    feed: { sfinAccountId: 'sfin-chk' }, partner: null, now: NOW, ...over,
  });

  it('offers it on a posted row from the bank feed that is not half of a transfer', () => {
    expect(removalOffered(facts())).toBe(true);
  });

  it.each([
    ['not from a feed', facts({ feed: null })],
    ['an unread mapping', facts({ failed: ['mapping'] })],
    ['an unread other half', facts({ failed: ['partner'] })],
    ['half of a transfer', facts({ partner: { accountName: 'Ally' } })],
    ['maybe half of a transfer', facts({ partner: undefined })],
    ['no tx id', facts({}, 'Typed by hand')],
    ['pending', facts({}, `${NOTE} · pending`)],
    ['a held transfer', facts({}, `↔️ In-transit transfer · ${NOTE}`)],
    ['a starting balance', facts({}, 'Starting balance · sfin-chk')],
    ['a correction', facts({}, 'Balance adjustment · sfin-chk · 2026-10-09')],
  ])('not on %s', (_why, f) => {
    expect(removalOffered(f)).toBe(false);
  });

  it('fingerprints what the story showed', () => {
    for (const over of [{ absCents: 1 }, { date: '2026-10-10' }, { type: 'WITHDRAWAL' }, { notes: 'X · TRN-600' }, { accountName: 'Other' }]) {
      expect(shown({ ...ROW, ...over })).not.toBe(FP);
    }
  });
});

describe('removeForGood', () => {
  it('skips first, then deletes, and records the row’s full create payload as yours', async () => {
    const f = fakeIo({}, { [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([{ account: 'sfin-x', txId: 'KEEP' }]) });
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: true, message: REMOVE_DONE });
    expect(f.calls).toEqual([`set ${SKIPPED_TRANSACTIONS_SECRET_KEY}`, 'remove dup-1']);
    expect(f.skipped()).toEqual([
      { account: 'sfin-x', txId: 'KEEP' }, { account: 'sfin-chk', txId: 'TRN-600', note: REMOVE_SKIP_NOTE, at: NOW.toISOString() },
    ]);
    expect(f.recorded).toEqual([expect.objectContaining({
      actor: 'you', kind: 'transaction-removed', undoable: true, summary: 'Removed MOBILE DEPOSIT for good',
      account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' },
      subject: { txKeys: [KEY], activityIds: ['dup-1'], description: 'MOBILE DEPOSIT', amountCents: 60000, date: '2026-10-09' },
      before: {
        activityId: 'dup-1',
        activity: { accountId: 'wf-chk', activityType: 'DEPOSIT', activityDate: '2026-10-09', symbol: { symbol: '$CASH-USD' }, amount: 600, currency: 'USD', comment: NOTE },
      },
    })]);
  });

  it('skips the id under every feed that maps to the account', async () => {
    const f = fakeIo({ feeds: vi.fn(async () => ['sfin-chk', 'sfin-old']) });
    await removeForGood('dup-1', FP, f.io, NOW);
    expect(f.recorded[0].subject.txKeys).toEqual([KEY, accountTxKey('sfin-old', 'TRN-600')]);
    expect(f.skipped()).toHaveLength(2);
  });

  it.each([
    ['it changed since the story showed it', { read: vi.fn(async () => ({ ...ROW, absCents: 60100 })) }, REMOVE_CHANGED],
    ['it is gone', { read: vi.fn(async () => null) }, REMOVE_CHANGED],
    ['it is half of a linked transfer', { linked: vi.fn(async () => 'confirmed' as const) }, REMOVE_UNLINK_FIRST],
    ['it may be half of a linked transfer', { linked: vi.fn(async () => 'maybe' as const) }, REMOVE_UNLINK_FIRST],
    ['no feed maps to its account', { feeds: vi.fn(async () => []) }, REMOVE_NOT_FEED],
    ['Wealthfolio cannot be reached', { read: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) }, REMOVE_UNREACHABLE],
  ] as Array<[string, Partial<RemoveIo>, string]>)('writes nothing when %s', async (_why, over, message) => {
    const f = fakeIo(over);
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: false, message });
    expect(f.calls).toEqual([]);
    expect(f.recorded).toEqual([]);
  });

  it.each([
    ['a held transfer', `↔️ In-transit transfer · ${NOTE}`, REMOVE_MANAGED],
    ['a starting balance', 'Starting balance · sfin-chk', REMOVE_MANAGED],
    ['a correction', 'Balance adjustment · sfin-chk · 2026-10-09', REMOVE_MANAGED],
    ['a row typed by hand', 'Typed by hand', REMOVE_NOT_FEED],
    ['a pending row', `${NOTE} · pending`, REMOVE_PENDING],
  ])('refuses %s', async (_why, notes, message) => {
    const row = { ...ROW, notes };
    const f = fakeIo({ read: vi.fn(async () => row) });
    expect(await removeForGood('dup-1', shown(row), f.io, NOW)).toEqual({ ok: false, message });
    expect(f.calls).toEqual([]);
  });

  it('deletes nothing when the skip list is corrupt', async () => {
    const f = fakeIo({}, { [SKIPPED_TRANSACTIONS_SECRET_KEY]: '{not json' });
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: false, message: REMOVE_SKIP_UNREADABLE });
    expect(f.io.remove).not.toHaveBeenCalled();
    expect(f.skipped()).toBe('corrupt');
  });

  it('takes back off the skip list only what it added when the delete fails', async () => {
    const f = fakeIo({ remove: vi.fn(async () => { throw new Error('locked'); }), feeds: vi.fn(async () => ['sfin-chk', 'sfin-old']) },
      { [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([{ account: 'sfin-old', txId: 'TRN-600', note: 'earlier' }]) });
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: false, message: "Couldn't remove it (locked) — nothing was changed." });
    expect(f.skipped()).toEqual([{ account: 'sfin-old', txId: 'TRN-600', note: 'earlier' }]);
    expect(f.recorded).toEqual([]);
  });

  it('says so when it cannot take the key back off either', async () => {
    const f = fakeIo({ remove: vi.fn(async () => { throw new Error('locked'); }) });
    let writes = 0;
    f.io.secrets.set = vi.fn(async () => { writes += 1; if (writes > 1) throw new Error('disk'); });
    expect((await removeForGood('dup-1', FP, f.io, NOW)).message)
      .toBe("Couldn't remove it (locked), and it stays on the skip list — the bank feed won't import it again until it's taken off.");
  });

  it('never lets the log cost the removal', async () => {
    const f = fakeIo({ record: vi.fn(async () => { throw new Error('log down'); }) });
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: true, message: REMOVE_DONE });
    expect(f.io.log).toHaveBeenCalledTimes(1);
  });
});

describe('remove, then Undo, on a host', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-creates the exact row and takes it off the skip list', async () => {
    const original: HostActivity = { id: 'dup-1', accountId: 'wf-chk', activityType: 'DEPOSIT', date: '2026-10-09', amount: 600, comment: NOTE, sourceGroupId: null };
    const fh = createFakeHost({ mapping: { 'sfin-chk': 'wf-chk' }, accountTypes: { 'wf-chk': 'CASH' }, existing: new Map([['wf-chk', [original]]]) });
    const data = new Map<string, string>();
    const log: ChangeEntry[] = [];
    const secrets = { get: async (k: string) => data.get(k) ?? null, set: async (k: string, v: string) => { data.set(k, v); } };
    const record = async (d: ChangeDraft) => { log.unshift(stampChange(d, 'addon', NOW)); };
    const io: RemoveIo = {
      read: async (id) => {
        const a = fh.activities.get('wf-chk')!.find((r) => r.id === id);
        return a ? fixRowOf({ ...a, currency: 'USD', accountName: 'PNC Checking' }, 'CASH') : null;
      },
      feeds: async () => ['sfin-chk'],
      linked: async () => false,
      secrets,
      remove: async (id) => { await fh.host.saveMany({ deleteIds: [id] }); },
      record,
      log: () => {},
    };
    expect((await removeForGood('dup-1', FP, io, NOW)).ok).toBe(true);
    expect(fh.activities.get('wf-chk')).toEqual([]);

    const undoIo: UndoIo = { host: fh.host, secrets, record, where: { host: 'addon', companionVersion: '1.61.0' } };
    const entry = log[0] as ChangeLogItem;
    expect(await runChangeUndo(entry, log, 'undo', undoIo, 'plain', NOW)).toMatchObject({ ok: true });
    const [back] = fh.activities.get('wf-chk')!;
    expect(back).toMatchObject({ accountId: 'wf-chk', activityType: 'DEPOSIT', date: '2026-10-09', amount: 600, comment: NOTE });
    expect(parseSkippedTransactionsStrict(data.get(SKIPPED_TRANSACTIONS_SECRET_KEY))).toEqual({ kind: 'ok', list: [] });
  });
});
