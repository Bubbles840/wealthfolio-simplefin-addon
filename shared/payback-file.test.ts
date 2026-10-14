import { describe, it, expect, vi } from 'vitest';
import { stampChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import { removalFingerprint } from './tx-remove.js';
import { addonPaybackGate, filePayback, paybackRowOf, type PaybackChoice, type PaybackIo } from './payback.js';
import type { PaybackRow } from './payback-row.js';
import {
  PAYBACK_CHANGED, PAYBACK_GONE, PAYBACK_GONE_STUCK, PAYBACK_LINKED, PAYBACK_NO_UNDO, PAYBACK_NO_UNDO_SETTING, PAYBACK_SETTING_HINT, PAYBACK_NOT_CASH, PAYBACK_OVERRIDE_FAILED, PAYBACK_PENDING, PAYBACK_RUNNING, PAYBACK_UNREACHABLE,
  PAYBACK_UPDATE_ADDON, PAYBACK_UPDATE_REFUSED, PAYBACK_UPDATE_STUCK, PAYBACK_UPDATE_UNSURE,
} from './payback-copy.js';
import {
  emptySyncOverrides, hasTxOverride, parseSyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY, SYNC_OVERRIDES_UNREADABLE_MESSAGE,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import { INSTALLED_ADDON_VERSION_SECRET_KEY } from './version.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-chk', 'TRN-77');
const OTHER = accountTxKey('sfin-chk', 'TRN-1');
const RAW = 'assignActivityCategory failed: 400 - Income activities can only use income categories. Categories label the cash-flow bucket; they do not change it.';

const DETAILS = {
  id: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T12:00:00Z',
  amount: '14', currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: null, sourceGroupId: null,
};
const RESTAURANTS: PaybackChoice = { activityId: 'act-7', categoryId: 'cat-rest', categoryName: 'Restaurants', parentName: 'Food & Dining' };

/** Wealthfolio and the add-on's secrets, in memory, every call in order. */
function world(over: { row?: Record<string, unknown> | null; secrets?: Record<string, string>; io?: Partial<PaybackIo> } = {}) {
  let row: PaybackRow | null = over.row === null ? null : paybackRowOf({ ...DETAILS, ...(over.row ?? {}) }, 'CASH');
  const data = new Map(Object.entries({ [INSTALLED_ADDON_VERSION_SECRET_KEY]: '1.62.0', ...(over.secrets ?? {}) }));
  const calls: string[] = [];
  const logged: ChangeEntry[] = [];
  const logs: string[] = [];
  const io: PaybackIo = {
    gate: () => addonPaybackGate(async (k) => data.get(k) ?? null),
    read: vi.fn(async (id: string) => { calls.push(`read ${id}`); return row ? { ...row } : null; }),
    feeds: vi.fn(async (wf: string) => { calls.push(`feeds ${wf}`); return ['sfin-chk']; }),
    secrets: {
      get: async (k) => data.get(k) ?? null,
      set: vi.fn(async (k: string, v: string) => { calls.push(`set ${k}`); data.set(k, v); }),
    },
    update: vi.fn(async (w) => {
      calls.push(`update ${w.activityType}/${w.subtype}`);
      row = paybackRowOf({ ...DETAILS, ...(over.row ?? {}), activityType: w.activityType, subtype: w.subtype || null, date: w.activityDate }, 'CASH');
    }),
    assign: vi.fn(async (id: string, cat: string) => { calls.push(`assign ${id} ${cat}`); }),
    record: vi.fn(async (d: ChangeDraft) => { calls.push(`record ${d.kind}`); logged.push(stampChange(d, 'companion', NOW)); }),
    log: (m: string) => { logs.push(m); },
    ...(over.io ?? {}),
  };
  const overrides = () => {
    const p = parseSyncOverrides(data.get(SYNC_OVERRIDES_SECRET_KEY));
    return p.kind === 'ok' ? p.overrides : p.kind === 'absent' ? emptySyncOverrides() : null;
  };
  return { io, data, calls, logged, logs, overrides, row: () => row };
}

describe('filePayback', () => {
  it('sets the override, re-types the row, files it, logs it — in that order — and says so as the spec does', async () => {
    const w = world();
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({
      kind: 'filed',
      message: 'Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.\nUndo it from /changes.',
    });
    expect(w.calls).toEqual([
      'read act-7', 'feeds wf-chk', `set ${SYNC_OVERRIDES_SECRET_KEY}`, 'update CREDIT/REIMBURSEMENT', 'assign act-7 cat-rest', 'record payback-filed',
    ]);
    expect(w.overrides()!.tx[KEY]).toEqual({ asReimbursement: true, at: NOW.toISOString(), label: 'VENMO CASHOUT · PNC Checking' });
    expect(w.io.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'act-7', activityDate: '2026-10-09T12:00:00Z', amount: 14 }));
    expect(w.logged[0]).toMatchObject({
      kind: 'payback-filed', actor: 'you', subject: { txKeys: [KEY], activityIds: ['act-7'] },
      after: { activityType: 'CREDIT', subtype: 'REIMBURSEMENT', categoryId: 'cat-rest', categoryName: 'Restaurants', accountId: 'wf-chk' },
    });
  });

  it('keeps every other override in the document', async () => {
    const w = world({ secrets: { [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(setTxOverride(emptySyncOverrides(), OTHER, 'notTransfer', NOW)) } });
    await filePayback(RESTAURANTS, w.io, NOW);
    expect(hasTxOverride(w.overrides()!, OTHER, 'notTransfer')).toBe(true);
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(true);
  });

  it.each<[string, Record<string, string>]>([
    ['an add-on older than 1.62.0', { [INSTALLED_ADDON_VERSION_SECRET_KEY]: '1.61.0' }],
    ['an add-on the companion cannot see', { [INSTALLED_ADDON_VERSION_SECRET_KEY]: '' }],
  ])('refuses while the installed add-on is %s, naming the app’s Change log, and reads and writes nothing', async (_name, secrets) => {
    const w = world({ secrets });
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_UPDATE_ADDON });
    expect(PAYBACK_UPDATE_ADDON).toContain("the app's Change log");
    expect(w.calls).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a pending row', { comment: 'VENMO CASHOUT · TRN-77 · pending' }, PAYBACK_PENDING],
    ['half of a linked transfer', { sourceGroupId: 'wf-transfer-1' }, PAYBACK_LINKED],
  ])('writes nothing for %s', async (_name, row, message) => {
    const w = world({ row });
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message });
    expect(w.calls).toEqual(['read act-7', 'feeds wf-chk']);
  });

  it('writes nothing on a card', async () => {
    const w = world();
    w.io.read = async () => paybackRowOf(DETAILS, 'CREDIT_CARD');
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_NOT_CASH });
    expect(w.calls).toEqual(['feeds wf-chk']);
  });

  it('never overwrites an overrides document it cannot read', async () => {
    const w = world({ secrets: { [SYNC_OVERRIDES_SECRET_KEY]: '{oops' } });
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: SYNC_OVERRIDES_UNREADABLE_MESSAGE });
    expect(w.data.get(SYNC_OVERRIDES_SECRET_KEY)).toBe('{oops');
    expect(w.io.update).not.toHaveBeenCalled();
  });

  it('says it couldn’t reach Wealthfolio when the read fails, and writes nothing', async () => {
    const w = world({ io: { read: async () => { throw new Error('ECONNREFUSED'); } } });
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_UNREACHABLE });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
  });

  it('stops at an override it could not save', async () => {
    const w = world();
    w.io.secrets.set = async () => { throw new Error('500'); };
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_OVERRIDE_FAILED });
    expect(w.io.update).not.toHaveBeenCalled();
  });

  it('takes the override back when Wealthfolio refuses the re-type, so nothing changed', async () => {
    const w = world({ secrets: { [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(setTxOverride(emptySyncOverrides(), OTHER, 'notTransfer', NOW)) } });
    w.io.update = vi.fn(async () => { throw new Error('400 - nope'); });
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_UPDATE_REFUSED });
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(false);
    expect(hasTxOverride(w.overrides()!, OTHER, 'notTransfer')).toBe(true);
    expect(w.io.assign).not.toHaveBeenCalled();
    expect(w.io.record).not.toHaveBeenCalled();
    expect(w.logs.join('\n')).toContain('400 - nope');
  });

  it('says the override stays when it cannot take it back', async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error('400'); });
    let writes = 0;
    const set = w.io.secrets.set;
    w.io.secrets.set = async (k, v) => { writes += 1; if (writes > 1) throw new Error('500'); await set(k, v); };
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: `${PAYBACK_UPDATE_STUCK}\n${PAYBACK_SETTING_HINT}` });
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(true);
  });

  it('carries on when the re-type landed but its answer was lost', async () => {
    const w = world();
    const update = w.io.update;
    w.io.update = vi.fn(async (wr) => { await update(wr); throw new Error('socket hang up'); });
    expect((await filePayback(RESTAURANTS, w.io, NOW)).kind).toBe('filed');
    expect(w.io.assign).toHaveBeenCalledWith('act-7', 'cat-rest');
  });

  it('says it can’t tell, and keeps the override, when the read after a failed re-type fails too', async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error('socket hang up'); });
    let reads = 0;
    const read = w.io.read;
    w.io.read = async (id) => { reads += 1; if (reads > 1) throw new Error('ECONNRESET'); return read(id); };
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: `${PAYBACK_UPDATE_UNSURE}\n${PAYBACK_SETTING_HINT}` });
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(true);
  });

  it('says it is a payback with no category when Wealthfolio refuses the filing — never Wealthfolio’s words — and logs it so Undo works', async () => {
    const w = world();
    w.io.assign = vi.fn(async () => { throw new Error(RAW); });
    const out = await filePayback(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({
      kind: 'partial',
      message: "It's a payback now, but Wealthfolio didn't file it under Restaurants — /categorize offers it again.\nUndo it from /changes.",
    });
    expect(out.message).not.toContain('Income activities');
    expect(w.logs.join('\n')).toContain('Income activities');
    expect(w.logged[0]).toMatchObject({ summary: 'Made VENMO CASHOUT a payback', after: { categoryId: null, categoryName: null } });
  });

  it('still files when the change log cannot be written, and says there is no Undo', async () => {
    const w = world();
    w.io.record = async () => { throw new Error('quota'); };
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({
      kind: 'filed',
      message: `Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.\n${PAYBACK_NO_UNDO}`,
    });
  });

  it('files a second tap on the same row once', async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const read = w.io.read;
    w.io.read = async (id) => { await gate; return read(id); };
    const first = filePayback(RESTAURANTS, w.io, NOW);
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_RUNNING });
    release();
    expect((await first).kind).toBe('filed');
  });

  it('names the parent’s spending for a subcategory and the category’s own for a top-level one', async () => {
    const sub = await filePayback(RESTAURANTS, world().io, NOW);
    expect(sub.message).toContain('off your Food & Dining spending');
    const top = await filePayback({ ...RESTAURANTS, categoryName: 'Entertainment', parentName: null }, world().io, NOW);
    expect(top.message).toContain('under Entertainment — it takes $14 off your Entertainment spending');
  });

  it('keeps the cents of a large amount', async () => {
    const w = world({ row: { amount: '1234.56' } });
    expect((await filePayback(RESTAURANTS, w.io, NOW)).message).toContain('it takes $1,234.56 off');
  });
});

describe('filePayback — ruling PB-B', () => {
  const shownOf = (over: Record<string, unknown> = {}) => {
    const r = paybackRowOf({ ...DETAILS, ...over }, 'CASH')!;
    return removalFingerprint({ activityId: r.id, note: r.notes, absCents: r.absCents, date: r.date, activityType: r.type, accountName: r.accountName });
  };

  it('M1: files when the row is still the one the menu showed', async () => {
    const w = world();
    expect((await filePayback({ ...RESTAURANTS, shown: shownOf() }, w.io, NOW)).kind).toBe('filed');
  });

  it('M1: refuses a row that changed since the menu showed it, and writes nothing', async () => {
    const w = world();
    const out = await filePayback({ ...RESTAURANTS, shown: shownOf({ amount: '20' }) }, w.io, NOW);
    expect(out).toEqual({ kind: 'refused', message: PAYBACK_CHANGED });
    expect(PAYBACK_CHANGED).toBe('It has changed since — nothing was changed.');
    expect(w.calls).toEqual(['read act-7']);
    expect(w.io.secrets.set).not.toHaveBeenCalled();
  });

  it('M1: a row that is gone is still said to be gone', async () => {
    const w = world({ row: null });
    expect(await filePayback({ ...RESTAURANTS, shown: shownOf() }, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_GONE });
  });

  it('M2: continues to the re-type when the override write failed but its keys are there', async () => {
    const w = world();
    const set = w.io.secrets.set;
    w.io.secrets.set = vi.fn(async (k, v) => { await set(k, v); throw new Error('socket hang up'); });
    const out = await filePayback(RESTAURANTS, w.io, NOW);
    expect(out.kind).toBe('filed');
    expect(w.io.update).toHaveBeenCalled();
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(true);
  });

  it('M2: takes back only what this run added when the continued re-type is refused', async () => {
    const w = world();
    const set = w.io.secrets.set;
    let first = true;
    w.io.secrets.set = vi.fn(async (k, v) => { await set(k, v); if (first) { first = false; throw new Error('socket hang up'); } });
    w.io.update = vi.fn(async () => { throw new Error('400'); });
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_UPDATE_REFUSED });
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(false);
  });

  it('M2: still refuses when the override write failed and the keys are not there', async () => {
    const w = world();
    w.io.secrets.set = async () => { throw new Error('500'); };
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_OVERRIDE_FAILED });
    expect(w.io.update).not.toHaveBeenCalled();
  });

  it('M5: a STUCK payback is logged with no category, so /changes can undo the setting', async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error('400'); });
    let writes = 0;
    const set = w.io.secrets.set;
    w.io.secrets.set = async (k, v) => { writes += 1; if (writes > 1) throw new Error('500'); await set(k, v); };
    const out = await filePayback(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'partial', message: `${PAYBACK_UPDATE_STUCK}\n${PAYBACK_SETTING_HINT}` });
    expect(w.logged[0]).toMatchObject({ kind: 'payback-filed', subject: { txKeys: [KEY] }, after: { categoryId: null, categoryName: null } });
  });

  it('M5: an UNSURE payback is logged with no category too, and says so when the log fails', async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error('socket hang up'); });
    let reads = 0;
    const read = w.io.read;
    w.io.read = async (id) => { reads += 1; if (reads > 1) throw new Error('ECONNRESET'); return read(id); };
    await filePayback(RESTAURANTS, w.io, NOW);
    expect(w.logged[0]).toMatchObject({ kind: 'payback-filed', after: { categoryId: null } });

    const x = world();
    x.io.update = vi.fn(async () => { throw new Error('socket hang up'); });
    let n = 0;
    const read2 = x.io.read;
    x.io.read = async (id) => { n += 1; if (n > 1) throw new Error('ECONNRESET'); return read2(id); };
    x.io.record = async () => { throw new Error('quota'); };
    expect(await filePayback(RESTAURANTS, x.io, NOW)).toEqual({ kind: 'partial', message: `${PAYBACK_UPDATE_UNSURE}\n${PAYBACK_NO_UNDO_SETTING}` });
  });

  it('M6: a refused update whose re-read finds the row gone says it is gone — not "still a deposit"', async () => {
    const w = world();
    let gone = false;
    const read = w.io.read;
    w.io.read = async (id) => (gone ? null : read(id));
    w.io.update = vi.fn(async () => { gone = true; throw new Error('404'); });
    const out = await filePayback(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'refused', message: PAYBACK_GONE });
    expect(out.message).not.toContain('still a deposit');
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(false);
  });

  it('M6: and when the setting cannot be taken back either, says that in gone-row words', async () => {
    const w = world();
    let gone = false;
    const read = w.io.read;
    w.io.read = async (id) => (gone ? null : read(id));
    w.io.update = vi.fn(async () => { gone = true; throw new Error('404'); });
    let writes = 0;
    const set = w.io.secrets.set;
    w.io.secrets.set = async (k, v) => { writes += 1; if (writes > 1) throw new Error('500'); await set(k, v); };
    const out = await filePayback(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'partial', message: PAYBACK_GONE_STUCK });
    expect(out.message).not.toContain('still a deposit');
    expect(w.logged).toEqual([]);
  });

  it('M7: a gate that cannot read secrets logs the error and says it could not reach Wealthfolio', async () => {
    const w = world({ io: { gate: () => addonPaybackGate(async () => { throw new Error('keychain locked'); }) } });
    const out = await filePayback(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'refused', message: PAYBACK_UNREACHABLE });
    expect(out.message).not.toContain('Update the add-on');
    expect(w.logs.join('\n')).toContain('keychain locked');
    expect(w.calls).toEqual([]);
  });

  it('M7: an installed version that is simply too old still says to update', async () => {
    const w = world({ secrets: { [INSTALLED_ADDON_VERSION_SECRET_KEY]: '1.61.0' } });
    expect(await filePayback(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_UPDATE_ADDON });
  });
});
