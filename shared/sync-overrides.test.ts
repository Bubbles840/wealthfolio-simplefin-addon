import { describe, it, expect, vi } from 'vitest';
import {
  clearAccountOverride, clearTxOverride, editSyncOverrides, emptySyncOverrides, hasAccountOverride, hasTxOverride,
  isUnreadableOverridesError, loadSyncOverrides, overrideRows, parseSyncOverrides, pruneTxOverrides, removeOverrideRow,
  setAccountOverride, setTxOverride, SYNC_OVERRIDES_SECRET_KEY, SYNC_OVERRIDES_UNREADABLE_MESSAGE, syncOverridesIgnoredLog, syncOverridesOrEmpty,
  SyncOverridesInvalidError, type SyncOverrides,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const OUT = accountTxKey('ACT-1f2e', 'TRN-a1b2');
const IN = accountTxKey('ACT-9c8d', 'TRN-a1b2');

/** A secrets map behind the two functions the edit path takes. */
function secrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  };
}

describe('parseSyncOverrides', () => {
  it('reads nothing stored, and the companion\'s cleared value, as absent', () => {
    expect(parseSyncOverrides(null)).toEqual({ kind: 'absent' });
    expect(parseSyncOverrides('')).toEqual({ kind: 'absent' });
    expect(parseSyncOverrides('  ')).toEqual({ kind: 'absent' });
  });

  it('reads a well-formed document, keys with the NUL separator included', () => {
    const doc: SyncOverrides = {
      v: 1,
      tx: { [OUT]: { notTransfer: true, at: '2026-10-12T09:00:00.000Z', entryId: 'c1', label: 'CITI AUTOPAY · Checking' } },
      accounts: { 'ACT-9c8d': { noOpeningFile: true, at: '2026-10-12T09:00:00.000Z', label: 'Citi Card' } },
    };
    expect(parseSyncOverrides(JSON.stringify(doc))).toEqual({ kind: 'ok', overrides: doc });
    expect(parseSyncOverrides('{"v":1}')).toEqual({ kind: 'ok', overrides: emptySyncOverrides() });
  });

  it.each([
    ['not JSON', '{v:1'],
    ['a list', '[]'],
    ['another version', '{"v":2,"tx":{},"accounts":{}}'],
    ['an unknown top-level field', '{"v":1,"tx":{},"accounts":{},"extra":1}'],
    ['a flag that is not true', `{"v":1,"tx":{"k":{"notTransfer":false,"at":"2026-10-12T09:00:00Z"}},"accounts":{}}`],
    ['a missing time', `{"v":1,"tx":{"k":{"notTransfer":true}},"accounts":{}}`],
    ['a time that is not a time', `{"v":1,"tx":{},"accounts":{"a":{"noAutoCorrect":true,"at":"yesterday"}}}`],
    ['an entry that is not an object', '{"v":1,"tx":{"k":"yes"},"accounts":{}}'],
    ['tx as a list', '{"v":1,"tx":[],"accounts":{}}'],
  ])('reads %s as corrupt', (_name, raw) => {
    expect(parseSyncOverrides(raw)).toEqual({ kind: 'corrupt' });
  });
});

describe('loading', () => {
  it('flags a corrupt document as unreadable and hands back an empty one', async () => {
    const s = secrets({ [SYNC_OVERRIDES_SECRET_KEY]: '{not json' });
    expect(await loadSyncOverrides(s.get)).toEqual({ overrides: emptySyncOverrides(), unreadable: true });
  });

  it('rejects when the read itself fails, so unreachable never reads as "no overrides"', async () => {
    await expect(loadSyncOverrides(async () => { throw new Error('ECONNREFUSED'); })).rejects.toThrow('ECONNREFUSED');
  });

  it('gives the sync an empty document for corrupt, absent and unreadable alike', async () => {
    expect(await syncOverridesOrEmpty(secrets({ [SYNC_OVERRIDES_SECRET_KEY]: 'garbage' }).get)).toEqual(emptySyncOverrides());
    expect(await syncOverridesOrEmpty(secrets().get)).toEqual(emptySyncOverrides());
    expect(await syncOverridesOrEmpty(async () => { throw new Error('down'); })).toEqual(emptySyncOverrides());
  });

  it('says once why it handed the sync an empty document — corrupt or unread — and never for absent or fine', async () => {
    const heard: string[] = [];
    const hear = (why: string) => { heard.push(why); };
    const s = secrets({ [SYNC_OVERRIDES_SECRET_KEY]: 'garbage' });
    expect(await syncOverridesOrEmpty(s.get, hear)).toEqual(emptySyncOverrides());
    expect(await syncOverridesOrEmpty(async () => { throw new Error('down'); }, hear)).toEqual(emptySyncOverrides());
    await syncOverridesOrEmpty(secrets().get, hear);
    await syncOverridesOrEmpty(secrets({ [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(emptySyncOverrides()) }).get, hear);
    expect(heard).toEqual(['corrupt', 'unreadable']);
    // Reading is all it does: the corrupt text stays exactly as it was.
    expect(s.store.get(SYNC_OVERRIDES_SECRET_KEY)).toBe('garbage');
    // A listener that throws costs the sync nothing.
    expect(await syncOverridesOrEmpty(s.get, () => { throw new Error('log down'); })).toEqual(emptySyncOverrides());
  });

  it('words the log line for each case', () => {
    expect(syncOverridesIgnoredLog('corrupt')).toBe(
      "[simplefin-sync] sync-overrides-ignored: your sync overrides can't be read (the stored document is corrupt), so this sync ignores them — a transfer link, import or other decision you undid may come back",
    );
    expect(syncOverridesIgnoredLog('unreadable')).toBe(
      '[simplefin-sync] sync-overrides-ignored: your sync overrides could not be read this time, so this sync ignores them — a transfer link, import or other decision you undid may come back',
    );
  });
});

describe('editSyncOverrides', () => {
  it('re-reads before writing, so an override another writer just saved is kept', async () => {
    const s = secrets();
    const edit = (o: SyncOverrides) => setTxOverride(o, OUT, 'notTransfer', NOW);
    // The other writer lands between this tab's load and its edit.
    s.store.set(SYNC_OVERRIDES_SECRET_KEY, JSON.stringify(setAccountOverride(emptySyncOverrides(), 'ACT-9c8d', 'noAutoCorrect', NOW)));
    const next = await editSyncOverrides(s.get, s.set, edit, NOW);
    expect(hasTxOverride(next, OUT, 'notTransfer')).toBe(true);
    expect(hasAccountOverride(next, 'ACT-9c8d', 'noAutoCorrect')).toBe(true);
    expect(JSON.parse(s.store.get(SYNC_OVERRIDES_SECRET_KEY)!)).toEqual(next);
  });

  it('never overwrites a corrupt document: refused with a clear message, the stored text byte-identical', async () => {
    const corrupt = '{"v":1,"tx":{"k":{"notTransfer":"yes"}}}';
    const s = secrets({ [SYNC_OVERRIDES_SECRET_KEY]: corrupt });
    const err = await editSyncOverrides(s.get, s.set, (o) => setTxOverride(o, OUT, 'notTransfer', NOW), NOW).catch((e) => e);
    expect(isUnreadableOverridesError(err)).toBe(true);
    expect(err.message).toBe(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
    expect(s.set).not.toHaveBeenCalled();
    expect(s.store.get(SYNC_OVERRIDES_SECRET_KEY)).toBe(corrupt);
  });

  it('never writes a document the parser would refuse', async () => {
    const s = secrets();
    const bad = (o: SyncOverrides) => ({ ...o, tx: { k: { notTransfer: true, at: NOW.toISOString(), label: 5 } } } as unknown as SyncOverrides);
    await expect(editSyncOverrides(s.get, s.set, bad, NOW)).rejects.toBeInstanceOf(SyncOverridesInvalidError);
    expect(s.set).not.toHaveBeenCalled();
  });

  it('drops transaction overrides older than a year on write, and keeps account switches', async () => {
    const old = new Date('2025-10-12T14:59:00Z');
    const start = setAccountOverride(setTxOverride(emptySyncOverrides(), IN, 'keepDuplicate', old), 'ACT-1f2e', 'noAutoCorrect', old);
    const s = secrets({ [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(start) });
    const next = await editSyncOverrides(s.get, s.set, (o) => setTxOverride(o, OUT, 'noAutoFile', NOW), NOW);
    expect(Object.keys(next.tx)).toEqual([OUT]);
    expect(hasAccountOverride(next, 'ACT-1f2e', 'noAutoCorrect')).toBe(true);
  });
});

describe('the pure edits', () => {
  it('sets and clears transaction flags, dropping an entry with none left', () => {
    let o = setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', NOW, { entryId: 'c1', label: 'CITI AUTOPAY · Checking' });
    o = setTxOverride(o, OUT, 'noAutoFile', NOW);
    expect(o.tx[OUT]).toEqual({ notTransfer: true, noAutoFile: true, at: NOW.toISOString(), entryId: 'c1', label: 'CITI AUTOPAY · Checking' });
    o = clearTxOverride(o, OUT, 'notTransfer');
    expect(hasTxOverride(o, OUT, 'notTransfer')).toBe(false);
    expect(hasTxOverride(o, OUT, 'noAutoFile')).toBe(true);
    o = clearTxOverride(o, OUT, 'noAutoFile');
    expect(o.tx).toEqual({});
    expect(clearTxOverride(o, 'missing', 'notTransfer')).toBe(o);
  });

  it('keeps the two legs of one shared transaction id apart', () => {
    const o = setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', NOW);
    expect(hasTxOverride(o, OUT, 'notTransfer')).toBe(true);
    expect(hasTxOverride(o, IN, 'notTransfer')).toBe(false);
  });

  it('sets and clears account flags', () => {
    let o = setAccountOverride(emptySyncOverrides(), 'ACT-9c8d', 'noOpeningFile', NOW, { label: 'Citi Card' });
    expect(hasAccountOverride(o, 'ACT-9c8d', 'noOpeningFile')).toBe(true);
    expect(hasAccountOverride(o, 'ACT-9c8d', 'noAutoCorrect')).toBe(false);
    o = clearAccountOverride(o, 'ACT-9c8d', 'noOpeningFile');
    expect(o.accounts).toEqual({});
  });

  it('never reads a key named after an Object method as an override', () => {
    expect(hasTxOverride(emptySyncOverrides(), 'constructor', 'notTransfer')).toBe(false);
    expect(hasAccountOverride(emptySyncOverrides(), '__proto__', 'noAutoCorrect')).toBe(false);
  });

  it('prunes by the time each entry was set', () => {
    const o = setTxOverride(setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', new Date('2025-10-01T00:00:00Z')), IN, 'notTransfer', NOW);
    expect(Object.keys(pruneTxOverrides(o, NOW).tx)).toEqual([IN]);
    const fresh = setTxOverride(emptySyncOverrides(), IN, 'notTransfer', NOW);
    expect(pruneTxOverrides(fresh, NOW)).toBe(fresh);
  });
});

describe('overrideRows', () => {
  it('lists one row per flag, newest first, in words', () => {
    let o = setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', new Date('2026-10-12T09:00:00Z'), { label: 'CITI AUTOPAY · Checking' });
    o = setTxOverride(o, IN, 'keepDuplicate', new Date('2026-10-11T09:00:00Z'));
    o = setAccountOverride(o, 'ACT-9c8d', 'noAutoCorrect', NOW, { label: 'Citi Card' });
    expect(overrideRows(o).map((r) => r.text)).toEqual([
      'No automatic balance corrections: Citi Card',
      'Not a transfer: CITI AUTOPAY · Checking',
      'Keep both copies: TRN-a1b2',
    ]);
  });

  it('removes exactly the row asked for', () => {
    let o = setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', NOW);
    o = setTxOverride(o, OUT, 'noAmazonLabel', NOW);
    const [first] = overrideRows(o).filter((r) => r.flag === 'noAmazonLabel');
    const next = removeOverrideRow(o, first);
    expect(overrideRows(next).map((r) => r.flag)).toEqual(['notTransfer']);
  });

  it('never removes a payback flag: that is undone from /changes', () => {
    const o = setTxOverride(emptySyncOverrides(), OUT, 'asReimbursement', NOW);
    expect(removeOverrideRow(o, overrideRows(o)[0])).toEqual(o);
  });

  describe('a flag from a newer version', () => {
    const FUTURE = '{"v":1,"tx":{"k":{"notTransfer":true,"noFuture":true,"at":"2026-10-12T09:00:00Z"}},"accounts":{"a":{"noAutoCorrect":true,"noFutureAcct":{"x":1},"at":"2026-10-12T09:00:00Z"}}}';

    it('is ignored, not corruption: the known flags read, the unknown one is kept', () => {
      const r = parseSyncOverrides(FUTURE);
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      expect(hasTxOverride(r.overrides, 'k', 'notTransfer')).toBe(true);
      expect(overrideRows(r.overrides).map((x) => x.text)).toEqual(['No automatic balance corrections: a', 'Not a transfer: k']);
      expect(r.overrides.tx.k).toHaveProperty('noFuture', true);
    });

    it('reads an account flag on a transaction as just another unknown key: ignored, never obeyed', () => {
      const r = parseSyncOverrides('{"v":1,"tx":{"k":{"noAutoCorrect":true,"at":"2026-10-12T09:00:00Z"}},"accounts":{}}');
      expect(r.kind).toBe('ok');
      expect(r.kind === 'ok' && overrideRows(r.overrides)).toEqual([]);
    });

    it('stays strict on the types of the known keys', () => {
      expect(parseSyncOverrides('{"v":1,"tx":{"k":{"noFuture":true,"notTransfer":"yes","at":"2026-10-12T09:00:00Z"}},"accounts":{}}')).toEqual({ kind: 'corrupt' });
      expect(parseSyncOverrides('{"v":1,"tx":{"k":{"noFuture":true,"label":5,"at":"2026-10-12T09:00:00Z"}},"accounts":{}}')).toEqual({ kind: 'corrupt' });
      expect(parseSyncOverrides('{"v":1,"tx":{"k":{"noFuture":true}},"accounts":{}}')).toEqual({ kind: 'corrupt' });
    });

    it('survives an edit by this version: set, clear and write never delete it', async () => {
      const s = secrets({ [SYNC_OVERRIDES_SECRET_KEY]: FUTURE });
      await editSyncOverrides(s.get, s.set, (o) => setTxOverride(o, 'k', 'noAmazonLabel', NOW), NOW);
      let stored = JSON.parse(s.store.get(SYNC_OVERRIDES_SECRET_KEY)!);
      expect(stored.tx.k).toMatchObject({ notTransfer: true, noAmazonLabel: true, noFuture: true });
      expect(stored.accounts.a.noFutureAcct).toEqual({ x: 1 });
      // Clearing the last flag this version knows leaves the entry that holds an unknown one.
      await editSyncOverrides(s.get, s.set, (o) => clearTxOverride(clearTxOverride(o, 'k', 'notTransfer'), 'k', 'noAmazonLabel'), NOW);
      await editSyncOverrides(s.get, s.set, (o) => clearAccountOverride(o, 'a', 'noAutoCorrect'), NOW);
      stored = JSON.parse(s.store.get(SYNC_OVERRIDES_SECRET_KEY)!);
      expect(stored.tx.k.noFuture).toBe(true);
      expect(stored.accounts.a.noFutureAcct).toEqual({ x: 1 });
    });
  });

  it('lists a Venmo note override in words, and a document holding one reads back', () => {
    const o = setTxOverride(emptySyncOverrides(), OUT, 'noVenmoNote', NOW, { label: 'VENMO PAYMENT 1023 · Checking' });
    expect(overrideRows(o).map((r) => r.text)).toEqual(['No Venmo note: VENMO PAYMENT 1023 · Checking']);
    expect(parseSyncOverrides(JSON.stringify(o))).toEqual({ kind: 'ok', overrides: o });
    expect(hasTxOverride(o, OUT, 'noVenmoNote')).toBe(true);
  });
});
