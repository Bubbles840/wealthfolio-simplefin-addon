import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stampChange, type ChangeDraft, type ChangeEntry } from './change-entries';
import type { ChangeLogItem } from './change-log';
import { runChangeUndo, type UndoIo } from './change-undo-run';
import { createFakeHost } from './fake-host';
import { fixRowOf, recreateWrite, type FixRow } from './fix-row';
import { describeLeg } from './link-pair';
import { parseSkippedTransactionsStrict, SKIPPED_TRANSACTIONS_SECRET_KEY } from './skipped-transactions';
import type { HostActivity } from './sync-host';
import { accountTxKey } from './transfers';
import type { TxStoryFacts } from './tx-story';
import {
  removalFingerprint, removalOffered, removeForGood, REMOVE_CHANGED, REMOVE_DONE, REMOVE_MANAGED, REMOVE_NOT_FEED, REMOVE_NO_UNDO, REMOVE_NO_UNDO_POSSIBLE, REMOVE_PENDING, REMOVE_RUNNING, removeUnsure,
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
        activityId: 'dup-1', addedKeys: [KEY],
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
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: true, message: REMOVE_NO_UNDO });
    expect(f.io.log).toHaveBeenCalledTimes(1);
    const line = (f.io.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(line).toContain(JSON.stringify({ keys: [KEY], payload: recreateWrite(ROW) }));
  });

  it('keeps the skip and records the removal when the delete threw after it landed', async () => {
    let reads = 0;
    const f = fakeIo({ read: vi.fn(async () => (reads++ === 0 ? ROW : null)), remove: vi.fn(async () => { throw new Error('timeout'); }) });
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: true, message: REMOVE_DONE });
    expect(f.skipped()).toHaveLength(1);
    expect(f.recorded).toHaveLength(1);
  });

  it('says it cannot tell, and keeps the skip, when the re-read after a thrown delete fails', async () => {
    let reads = 0;
    const f = fakeIo({
      read: vi.fn(async () => { if (reads++ === 0) return ROW; throw new Error('down'); }),
      remove: vi.fn(async () => { throw new Error('timeout'); }),
    });
    const out = await removeForGood('dup-1', FP, f.io, NOW);
    expect(out).toEqual({ ok: false, message: removeUnsure('down', describeLeg({ accountId: 'wf-chk', accountName: 'PNC Checking', date: '2026-10-09', absCents: 60000, comment: NOTE })) });
    expect(f.skipped()).toHaveLength(1);
    expect(f.recorded).toEqual([]);
    expect((f.io.log as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes(JSON.stringify({ keys: [KEY], payload: recreateWrite(ROW) })))).toBe(true);
  });

  it('refuses a row the host calls grouped even when linked() says no', async () => {
    const row = { ...ROW, grouped: true };
    const f = fakeIo({ read: vi.fn(async () => row) });
    expect(await removeForGood('dup-1', shown(row), f.io, NOW)).toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
    expect(f.calls).toEqual([]);
  });

  it('refuses a $0 row, which Undo could not put back, before writing', async () => {
    const row = { ...ROW, absCents: 0 };
    const f = fakeIo({ read: vi.fn(async () => row) });
    expect(await removeForGood('dup-1', shown(row), f.io, NOW)).toEqual({ ok: false, message: REMOVE_NO_UNDO_POSSIBLE });
    expect(f.calls).toEqual([]);
  });

  it('does one removal at a time per row', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const f = fakeIo({ remove: vi.fn(async () => { await gate; }) });
    const first = removeForGood('dup-1', FP, f.io, NOW);
    await new Promise((r) => setTimeout(r, 0));
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: false, message: REMOVE_RUNNING });
    release();
    expect(await first).toEqual({ ok: true, message: REMOVE_DONE });
    expect(f.io.remove).toHaveBeenCalledTimes(1);
  });

  it('records only the keys it added', async () => {
    const f = fakeIo({ feeds: vi.fn(async () => ['sfin-chk', 'sfin-old']) },
      { [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([{ account: 'sfin-old', txId: 'TRN-600' }]) });
    await removeForGood('dup-1', FP, f.io, NOW);
    expect(f.recorded[0].before).toMatchObject({ addedKeys: [KEY] });
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

  it('re-creates the exact row and takes only its own key off the skip list', async () => {
    const original: HostActivity = {
      id: 'dup-1', accountId: 'wf-chk', activityType: 'WITHDRAWAL', date: '2026-10-09', amount: 600, fee: 1.5, comment: NOTE, sourceGroupId: null,
      subtype: 'REIMBURSEMENT', metadata: JSON.stringify({ flow: { is_external: true }, tag: 'x' }),
    };
    const fh = createFakeHost({ mapping: { 'sfin-chk': 'wf-chk' }, accountTypes: { 'wf-chk': 'CASH' }, existing: new Map([['wf-chk', [original]]]) });
    const data = new Map<string, string>([[SKIPPED_TRANSACTIONS_SECRET_KEY, JSON.stringify([{ account: 'sfin-old', txId: 'TRN-600', note: 'by hand' }])]]);
    const log: ChangeEntry[] = [];
    const secrets = { get: async (k: string) => data.get(k) ?? null, set: async (k: string, v: string) => { data.set(k, v); } };
    const record = async (d: ChangeDraft) => { log.unshift(stampChange(d, 'addon', NOW)); };
    const rowOf = (a: HostActivity) => fixRowOf({ ...a, currency: 'EUR', accountName: 'PNC Checking' }, 'CASH');
    const row = rowOf(original)!;
    const io: RemoveIo = {
      read: async (id) => {
        const a = fh.activities.get('wf-chk')!.find((r) => r.id === id);
        return a ? rowOf(a) : null;
      },
      feeds: async () => ['sfin-chk', 'sfin-old'],
      linked: async () => false,
      secrets,
      remove: async (id) => {
        const res = await fh.host.saveMany({ deleteIds: [id] });
        if (res.errors.length > 0) throw new Error(res.errors.join('; '));
      },
      record,
      log: () => {},
    };
    expect((await removeForGood('dup-1', shown(row), io, NOW)).ok).toBe(true);
    expect(fh.activities.get('wf-chk')).toEqual([]);
    const afterRemove = parseSkippedTransactionsStrict(data.get(SKIPPED_TRANSACTIONS_SECRET_KEY));
    expect(afterRemove.kind === 'ok' && afterRemove.list.map((s) => `${s.account}:${s.txId}`)).toEqual(['sfin-old:TRN-600', 'sfin-chk:TRN-600']);

    const undoIo: UndoIo = { host: fh.host, secrets, record, where: { host: 'addon', companionVersion: '1.61.0' } };
    const entry = log[0] as ChangeLogItem;
    expect(await runChangeUndo(entry, log, 'undo', undoIo, 'plain', NOW)).toMatchObject({ ok: true });
    const back = fh.activities.get('wf-chk')!;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ accountId: 'wf-chk', activityType: 'WITHDRAWAL', date: '2026-10-09', amount: 600, comment: NOTE });
    const fixed = rowOf(back[0]);
    expect(fixed).toMatchObject({ feeCents: 150, subtype: 'REIMBURSEMENT', currency: 'EUR', flowExternal: true });
    expect(parseSkippedTransactionsStrict(data.get(SKIPPED_TRANSACTIONS_SECRET_KEY))).toEqual({
      kind: 'ok', list: [expect.objectContaining({ account: 'sfin-old', txId: 'TRN-600', note: 'by hand' })],
    });
  });
});
