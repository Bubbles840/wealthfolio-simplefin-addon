import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { paybackFiledChange, stampChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
  COMPANION_ONLY_KINDS, REDO_FROM_TELEGRAM, UNDO_FROM_TELEGRAM, UNDO_KINDS, UNDO_UPDATE_COMPANION, undoAvailability, type UndoOp,
} from './change-undo.js';
import { runChangeUndo, UNDO_SAVE_FAILED, type UndoIo } from './change-undo-run.js';
import { createFakeHost } from './fake-host.js';
import { filePayback, paybackRowOf, type PaybackIo } from './payback.js';
import {
  PAYBACK_REDO_UNCHANGED, PAYBACK_UNDO_STUCK, PAYBACK_UNDO_STUCK_PLAIN, PAYBACK_UNDO_UNCHANGED, PAYBACK_UNREACHABLE, PAYBACK_UPDATE_ADDON, paybackRedoHalf, paybackUndoHalf,
} from './payback-copy.js';
import type { HostActivity } from './sync-host.js';
import {
  emptySyncOverrides, hasTxOverride, parseSyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY, SYNC_OVERRIDES_UNREADABLE_MESSAGE,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import { INSTALLED_ADDON_VERSION_SECRET_KEY } from './version.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-1', 'TRN-77');
const SPENDING = 'spending_categories';

const DEPOSIT: HostActivity = {
  id: 'act-7', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2026-10-09T12:00:00Z', amount: 14,
  comment: 'VENMO CASHOUT · TRN-77', sourceGroupId: null, subtype: null, metadata: null,
};

/** Wealthfolio over a fake host, the add-on's secrets, the spending assignments, and the change log. */
function harness(rows: HostActivity[] = [{ ...DEPOSIT }], secrets: Record<string, string> = {}) {
  const fh = createFakeHost({
    mapping: { 'sfin-1': 'wf-a' }, accountTypes: { 'wf-a': 'CASH' }, accountNames: { 'wf-a': 'Checking' }, existing: new Map([['wf-a', rows]]),
  });
  const data = new Map(Object.entries({ [INSTALLED_ADDON_VERSION_SECRET_KEY]: '1.62.0', ...secrets }));
  const filed = new Map<string, string>();
  /** Filings in the income taxonomy, which /categorize gives a deposit. */
  const income = new Map<string, string>();
  const logs: string[] = [];
  const log: ChangeEntry[] = [];
  const secretsIo = {
    get: async (k: string) => data.get(k) ?? null,
    set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
  };
  const record = vi.fn(async (d: ChangeDraft) => { log.unshift(stampChange(d, 'companion', NOW)); });
  /** The row as Wealthfolio reports it now, the way a payback reads it. */
  const read = async (id: string) => {
    const r = [...fh.activities.values()].flat().find((x) => x.id === id);
    return r ? paybackRowOf({ ...r, currency: 'USD', accountName: 'Checking' }, 'CASH') : null;
  };
  const categories = {
    assignments: vi.fn(async (id: string) => [
      ...(filed.has(id) ? [{ taxonomyId: SPENDING, categoryId: filed.get(id)! }] : []),
      ...(income.has(id) ? [{ taxonomyId: 'income_sources', categoryId: income.get(id)! }] : []),
    ]),
    assign: vi.fn(async (id: string, _t: string, cat: string) => { filed.set(id, cat); }),
    unassign: vi.fn(async (id: string) => { filed.delete(id); }),
  };
  const io: UndoIo = {
    host: fh.host, secrets: secretsIo, categories, paybacks: { read }, record, where: { host: 'companion', companionVersion: '1.62.0' },
    log: (m: string) => { logs.push(m); },
  };
  const paybackIo: PaybackIo = {
    gate: async () => null,
    read,
    feeds: async () => ['sfin-1'],
    secrets: secretsIo,
    update: async (w) => {
      const r = await fh.host.saveMany({ updates: [w] });
      if (r.errors.length) throw new Error(r.errors[0].message);
    },
    assign: async (id, cat) => { filed.set(id, cat); },
    record,
    log: () => {},
  };
  const asItem = (e: ChangeEntry): ChangeLogItem => {
    const latest = log.find((x) => x.reverses?.id === e.id);
    return latest?.reverses?.op === 'undo' ? { ...e, undone: { by: latest.id, at: latest.at } } : { ...e };
  };
  const undo = (e: ChangeEntry, op: UndoOp) => runChangeUndo(asItem(e), [...log], op, io, 'plain', NOW);
  const overrides = () => {
    const p = parseSyncOverrides(data.get(SYNC_OVERRIDES_SECRET_KEY));
    return p.kind === 'ok' ? p.overrides : emptySyncOverrides();
  };
  const file = async () => {
    await filePayback({ activityId: 'act-7', categoryId: 'cat-rest', categoryName: 'Restaurants', parentName: 'Food & Dining' }, paybackIo, NOW);
    return log.find((e) => e.kind === 'payback-filed')!;
  };
  return { fh, data, filed, income, logs, log, io, read, undo, overrides, file, set: secretsIo.set, record, categories };
}

describe('Undo and Redo of a payback', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is an exact round trip: Undo puts the deposit back as Wealthfolio had it, Redo makes it the payback again', async () => {
    const h = harness();
    const before = await h.read('act-7');
    const entry = await h.file();
    const payback = await h.read('act-7');
    expect(payback).toMatchObject({ type: 'CREDIT', subtype: 'REIMBURSEMENT', instant: '2026-10-09T12:00:00Z' });

    expect(await h.undo(entry, 'undo')).toEqual({ ok: true, message: "Undone — it's a deposit again, off Restaurants.", needsSync: false });
    expect(await h.read('act-7')).toEqual(before);
    expect(h.filed.has('act-7')).toBe(false);
    expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(false);

    expect(await h.undo(entry, 'redo')).toEqual({ ok: true, message: "Redone — it's a payback under Restaurants again.", needsSync: false });
    expect(await h.read('act-7')).toEqual(payback);
    expect(h.filed.get('act-7')).toBe('cat-rest');
    expect(h.overrides().tx[KEY]).toMatchObject({ asReimbursement: true, label: 'VENMO CASHOUT · Checking' });

    expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true });
    expect(await h.read('act-7')).toEqual(before);
    expect(h.log.filter((e) => e.reverses).map((e) => e.reverses!.op)).toEqual(['undo', 'redo', 'undo']);
  });

  it('puts back a subtype the deposit had before', async () => {
    const h = harness([{ ...DEPOSIT, subtype: 'BONUS' }]);
    const entry = await h.file();
    await h.undo(entry, 'undo');
    expect(await h.read('act-7')).toMatchObject({ type: 'DEPOSIT', subtype: 'BONUS' });
  });

  it('undoes a payback Wealthfolio never filed without touching categories', async () => {
    const h = harness();
    const entry = stampChange(paybackFiledChange({
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKeys: [KEY], activityId: 'act-7', description: 'VENMO CASHOUT',
      amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: null, categoryName: null,
    }), 'companion', NOW);
    h.fh.activities.set('wf-a', [{ ...DEPOSIT, activityType: 'CREDIT', subtype: 'REIMBURSEMENT' }]);
    expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true, message: "Undone — it's a deposit again." });
    expect(h.categories.unassign).not.toHaveBeenCalled();
  });

  it('undoes a payback setting left on a deposit (a re-type that could not be confirmed): the override comes off', async () => {
    const h = harness();
    const entry = stampChange(paybackFiledChange({
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKeys: [KEY], activityId: 'act-7', description: 'VENMO CASHOUT',
      amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: null, categoryName: null,
    }), 'companion', NOW);
    h.data.set(SYNC_OVERRIDES_SECRET_KEY, JSON.stringify(setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', NOW)));
    expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true });
    expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(false);
    expect(await h.read('act-7')).toMatchObject({ type: 'DEPOSIT', subtype: null });
  });

  it.each<[string, (h: ReturnType<typeof harness>) => void, string]>([
    ['its category moved since', (h) => { h.filed.set('act-7', 'cat-gro'); }, 'It has changed since — nothing was undone.'],
    ['it is a deposit again', (h) => { h.fh.activities.set('wf-a', [{ ...DEPOSIT }]); }, 'It has changed since — nothing was undone.'],
    ['it is gone', (h) => { h.fh.activities.set('wf-a', []); }, 'That transaction is gone — nothing was undone.'],
    ['it is half of a linked transfer now', (h) => {
      h.fh.activities.set('wf-a', [{ ...DEPOSIT, activityType: 'CREDIT', subtype: 'REIMBURSEMENT', sourceGroupId: 'g1' }]);
    }, 'Undo the transfer link first.'],
  ])('refuses an Undo when %s, and writes nothing', async (_name, change, message) => {
    const h = harness();
    const entry = await h.file();
    change(h);
    h.set.mockClear();
    const saves = h.fh.saved.length;
    expect(await h.undo(entry, 'undo')).toEqual({ ok: false, message });
    expect(h.set).not.toHaveBeenCalled();
    expect(h.fh.saved.length).toBe(saves);
    expect(h.categories.unassign).not.toHaveBeenCalled();
  });

  it('refuses a Redo of a deposit filed since, and writes nothing', async () => {
    const h = harness();
    const entry = await h.file();
    await h.undo(entry, 'undo');
    h.income.set('act-7', 'inc-other');
    h.set.mockClear();
    expect(await h.undo(entry, 'redo')).toEqual({ ok: false, message: 'It has changed since — nothing was redone.' });
    expect(h.set).not.toHaveBeenCalled();
  });

  it.each([['an add-on older than 1.62.0', '1.61.0'], ['an add-on the companion cannot see', '']])(
    'Telegram refuses Undo and Redo with %s, naming the app’s Change log, and writes nothing',
    async (_name, installed) => {
      const h = harness();
      const entry = await h.file();
      h.data.set(INSTALLED_ADDON_VERSION_SECRET_KEY, installed);
      h.set.mockClear();
      expect(await h.undo(entry, 'undo')).toEqual({ ok: false, message: PAYBACK_UPDATE_ADDON });
      expect(await runChangeUndo({ ...entry, undone: { by: 'x', at: NOW.toISOString() } }, [], 'redo', h.io, 'plain', NOW))
        .toEqual({ ok: false, message: PAYBACK_UPDATE_ADDON });
      expect(h.set).not.toHaveBeenCalled();
    },
  );

  it('the app points at Telegram, once the companion knows paybacks — and waits for one that does', () => {
    const entry: ChangeLogItem = stampChange(paybackFiledChange({
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKeys: [KEY], activityId: 'act-7', description: 'VENMO CASHOUT',
      amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: 'cat-rest', categoryName: 'Restaurants',
    }), 'companion', NOW);
    const app = (companionVersion: string | null) => ({ host: 'addon' as const, companionVersion });
    expect(UNDO_KINDS.has('payback-filed') && COMPANION_ONLY_KINDS.has('payback-filed')).toBe(true);
    expect(undoAvailability(entry, app('1.62.0'))).toEqual({ kind: 'telegram', op: 'undo', text: UNDO_FROM_TELEGRAM });
    expect(UNDO_FROM_TELEGRAM).toBe('Undo this from Telegram: /changes');
    expect(undoAvailability({ ...entry, undone: { by: 'x', at: NOW.toISOString() } }, app('1.62.0')))
      .toEqual({ kind: 'telegram', op: 'redo', text: REDO_FROM_TELEGRAM });
    expect(undoAvailability(entry, app('1.61.0'))).toEqual({ kind: 'update-companion', op: 'undo', text: UNDO_UPDATE_COMPANION });
    expect(undoAvailability(entry, app(null))).toEqual({ kind: 'none' });
    expect(undoAvailability(entry, { host: 'companion', companionVersion: '1.61.0' })).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('never overwrites an overrides document it cannot read', async () => {
    const h = harness();
    const entry = await h.file();
    h.data.set(SYNC_OVERRIDES_SECRET_KEY, '{oops');
    const saves = h.fh.saved.length;
    expect(await h.undo(entry, 'undo')).toEqual({ ok: false, message: SYNC_OVERRIDES_UNREADABLE_MESSAGE });
    expect(h.fh.saved.length).toBe(saves);
  });

  describe('a write that fails partway', () => {
    it('Undo: Wealthfolio refuses the re-type — the override goes back exactly as it was, and nothing changed', async () => {
      const h = harness();
      const entry = await h.file();
      const kept = h.overrides().tx[KEY];
      const payback = await h.read('act-7');
      h.fh.host.saveMany = async () => ({ created: [], updated: [], errors: [{ action: 'update', message: '400 - Invalid data' }] });
      const out = await h.undo(entry, 'undo');
      expect(out).toEqual({ ok: false, message: PAYBACK_UNDO_UNCHANGED });
      expect(out.message).not.toContain('Invalid data');
      expect(h.overrides().tx[KEY]).toEqual(kept);
      expect(await h.read('act-7')).toEqual(payback);
      expect(h.filed.get('act-7')).toBe('cat-rest');
      expect(h.log.some((e) => e.reverses)).toBe(false);
    });

    it('Undo: says so when the override cannot be put back either', async () => {
      const h = harness();
      const entry = await h.file();
      h.fh.host.saveMany = async () => { throw new Error('ECONNRESET'); };
      let writes = 0;
      const set = h.io.secrets.set;
      h.io.secrets.set = async (k, v) => { writes += 1; if (writes > 1) throw new Error('500'); await set(k, v); };
      expect(await h.undo(entry, 'undo')).toEqual({ ok: false, message: PAYBACK_UNDO_STUCK });
    });

    it('Undo: the category cannot come off — a deposit again, still filed, named, and recorded', async () => {
      const h = harness();
      const entry = await h.file();
      h.categories.unassign.mockRejectedValueOnce(new Error('500 Internal Server Error'));
      const out = await h.undo(entry, 'undo');
      expect(out).toEqual({ ok: false, message: paybackUndoHalf('Restaurants') });
      expect(out.message).toBe("Couldn't finish the undo — it's a deposit again, but it's still filed under Restaurants. Take that off in Wealthfolio.");
      expect(await h.read('act-7')).toMatchObject({ type: 'DEPOSIT', subtype: null });
      expect(h.filed.get('act-7')).toBe('cat-rest');
      expect(h.log[0].reverses).toEqual({ id: entry.id, op: 'undo' });
    });

    it('Redo: Wealthfolio refuses the re-type — the override it set comes back off', async () => {
      const h = harness();
      const entry = await h.file();
      await h.undo(entry, 'undo');
      h.fh.host.saveMany = async () => ({ created: [], updated: [], errors: [{ action: 'update', message: '400' }] });
      expect(await h.undo(entry, 'redo')).toEqual({ ok: false, message: PAYBACK_REDO_UNCHANGED });
      expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(false);
      expect(await h.read('act-7')).toMatchObject({ type: 'DEPOSIT' });
    });

    it('Redo: the category is refused after the re-type — a payback with no category, named', async () => {
      const h = harness();
      const entry = await h.file();
      await h.undo(entry, 'undo');
      h.categories.assign.mockRejectedValueOnce(new Error('400 - Neutral transfers cannot be categorized.'));
      const out = await h.undo(entry, 'redo');
      expect(out).toEqual({ ok: false, message: paybackRedoHalf('Restaurants') });
      expect(out.message).not.toContain('Neutral');
      expect(await h.read('act-7')).toMatchObject({ type: 'CREDIT', subtype: 'REIMBURSEMENT' });
    });

    it('keeps an override another undo set on the same row', async () => {
      const h = harness([{ ...DEPOSIT }], {
        [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(setTxOverride(emptySyncOverrides(), KEY, 'noVenmoNote', NOW)),
      });
      const entry = await h.file();
      await h.undo(entry, 'undo');
      expect(h.overrides().tx[KEY]).toMatchObject({ noVenmoNote: true });
      expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(false);
    });
  });
});

describe('Undo and Redo of a payback — fix round 1 (PB-C)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const unfiledEntry = () => stampChange(paybackFiledChange({
    account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKeys: [KEY], activityId: 'act-7', description: 'VENMO CASHOUT',
    amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: null, categoryName: null,
  }), 'companion', NOW);
  const flag = (h: ReturnType<typeof harness>) => h.data.set(
    SYNC_OVERRIDES_SECRET_KEY, JSON.stringify(setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', NOW)),
  );

  it('I1: Undo after a half-done Redo gives a deposit with no filing and no override', async () => {
    const h = harness();
    const entry = await h.file();
    await h.undo(entry, 'undo');
    h.categories.assign.mockRejectedValueOnce(new Error('400'));
    expect(await h.undo(entry, 'redo')).toEqual({ ok: false, message: paybackRedoHalf('Restaurants') });
    expect(h.filed.has('act-7')).toBe(false);
    h.categories.unassign.mockClear();
    expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true });
    expect(await h.read('act-7')).toMatchObject({ type: 'DEPOSIT', subtype: null });
    expect(h.filed.has('act-7')).toBe(false);
    expect(h.categories.unassign).not.toHaveBeenCalled();
    expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(false);
  });

  it('I1: a payback filed under a DIFFERENT spending category still refuses its Undo', async () => {
    const h = harness();
    const entry = await h.file();
    h.filed.set('act-7', 'cat-other');
    expect(await h.undo(entry, 'undo')).toEqual({ ok: false, message: 'It has changed since — nothing was undone.' });
  });

  it('I2: a deposit without the flag is refused, with no writes', async () => {
    const h = harness();
    const saves = h.fh.saved.length;
    expect(await h.undo(unfiledEntry(), 'undo')).toEqual({ ok: false, message: 'It has changed since — nothing was undone.' });
    expect(h.set).not.toHaveBeenCalled();
    expect(h.fh.saved.length).toBe(saves);
  });

  it('I2: a deposit with the flag clears only the override — no re-type, no category call', async () => {
    const h = harness();
    flag(h);
    const saves = h.fh.saved.length;
    expect(await h.undo(unfiledEntry(), 'undo')).toMatchObject({ ok: true });
    expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(false);
    expect(h.fh.saved.length).toBe(saves);
    expect(h.categories.unassign).not.toHaveBeenCalled();
  });

  it('I2: a hand-set subtype on that deposit is untouched', async () => {
    const h = harness([{ ...DEPOSIT, subtype: 'BONUS' }]);
    flag(h);
    expect(await h.undo(unfiledEntry(), 'undo')).toMatchObject({ ok: true });
    expect(await h.read('act-7')).toMatchObject({ type: 'DEPOSIT', subtype: 'BONUS' });
  });

  it('I2: an overrides document it cannot read refuses that Undo', async () => {
    const h = harness();
    h.data.set(SYNC_OVERRIDES_SECRET_KEY, '{oops');
    expect(await h.undo(unfiledEntry(), 'undo')).toEqual({ ok: false, message: SYNC_OVERRIDES_UNREADABLE_MESSAGE });
  });

  /** A secrets write that lands and then throws, once. */
  const lostOnce = (h: ReturnType<typeof harness>, lands: boolean) => {
    const set = h.io.secrets.set;
    let first = true;
    h.io.secrets.set = async (k, v) => {
      if (first) { first = false; if (lands) await set(k, v); throw new Error('socket hang up'); }
      await set(k, v);
    };
  };

  it('I3: Undo whose override write landed but lost its response carries on to the re-type', async () => {
    const h = harness();
    const entry = await h.file();
    lostOnce(h, true);
    expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true });
    expect(await h.read('act-7')).toMatchObject({ type: 'DEPOSIT' });
    expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(false);
  });

  it('I3: Undo whose override write did not land still says nothing was changed', async () => {
    const h = harness();
    const entry = await h.file();
    lostOnce(h, false);
    expect(await h.undo(entry, 'undo')).toEqual({ ok: false, message: UNDO_SAVE_FAILED });
    expect(await h.read('act-7')).toMatchObject({ type: 'CREDIT' });
  });

  it('I3: Redo whose override write landed but lost its response carries on to the re-type', async () => {
    const h = harness();
    const entry = await h.file();
    await h.undo(entry, 'undo');
    lostOnce(h, true);
    expect(await h.undo(entry, 'redo')).toMatchObject({ ok: true });
    expect(await h.read('act-7')).toMatchObject({ type: 'CREDIT', subtype: 'REIMBURSEMENT' });
    expect(h.filed.get('act-7')).toBe('cat-rest');
  });

  it('I3: Redo whose override write did not land still says nothing was changed', async () => {
    const h = harness();
    const entry = await h.file();
    await h.undo(entry, 'undo');
    lostOnce(h, false);
    expect(await h.undo(entry, 'redo')).toEqual({ ok: false, message: UNDO_SAVE_FAILED });
    expect(await h.read('act-7')).toMatchObject({ type: 'DEPOSIT' });
  });

  /** saveMany lands and then throws. */
  const lostRetype = (h: ReturnType<typeof harness>) => {
    const save = h.fh.host.saveMany.bind(h.fh.host);
    h.fh.host.saveMany = async (...a: Parameters<typeof save>) => { await save(...a); throw new Error('socket hang up'); };
  };

  it('m1: an Undo whose re-type landed but lost its response goes on to take the category off', async () => {
    const h = harness();
    const entry = await h.file();
    lostRetype(h);
    expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true, message: "Undone — it's a deposit again, off Restaurants." });
    expect(h.filed.has('act-7')).toBe(false);
    expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(false);
  });

  it('m1: a Redo whose re-type landed but lost its response goes on to file the category', async () => {
    const h = harness();
    const entry = await h.file();
    await h.undo(entry, 'undo');
    lostRetype(h);
    expect(await h.undo(entry, 'redo')).toMatchObject({ ok: true });
    expect(h.filed.get('act-7')).toBe('cat-rest');
    expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(true);
  });

  it('m1: when the row cannot be read after a failed re-type, the override still goes back and nothing is claimed', async () => {
    const h = harness();
    const entry = await h.file();
    h.fh.host.saveMany = async () => { throw new Error('ECONNRESET'); };
    const read = h.io.paybacks!.read;
    let reads = 0;
    h.io.paybacks = { read: async (id) => { reads += 1; if (reads > 1) throw new Error('ECONNRESET'); return read(id); } };
    expect(await h.undo(entry, 'undo')).toEqual({ ok: false, message: PAYBACK_UNDO_UNCHANGED });
    expect(hasTxOverride(h.overrides(), KEY, 'asReimbursement')).toBe(true);
  });

  it('m2: with no category, a stuck Undo does not say "still filed under its category"', async () => {
    const h = harness();
    const entry = unfiledEntry();
    h.fh.activities.set('wf-a', [{ ...DEPOSIT, activityType: 'CREDIT', subtype: 'REIMBURSEMENT' }]);
    flag(h);
    h.fh.host.saveMany = async () => { throw new Error('ECONNRESET'); };
    let writes = 0;
    const set = h.io.secrets.set;
    h.io.secrets.set = async (k, v) => { writes += 1; if (writes > 1) throw new Error('500'); await set(k, v); };
    const out = await h.undo(entry, 'undo');
    expect(out).toEqual({ ok: false, message: PAYBACK_UNDO_STUCK_PLAIN });
    expect(PAYBACK_UNDO_STUCK_PLAIN).not.toContain('category');
    expect(PAYBACK_UNDO_STUCK).toContain('category');
  });

  it('m3: Redo refuses a deposit filed in the INCOME taxonomy, and writes nothing', async () => {
    const h = harness();
    const entry = await h.file();
    await h.undo(entry, 'undo');
    h.income.set('act-7', 'inc-salary');
    h.set.mockClear();
    const saves = h.fh.saved.length;
    expect(await h.undo(entry, 'redo')).toEqual({ ok: false, message: 'It has changed since — nothing was redone.' });
    expect(h.set).not.toHaveBeenCalled();
    expect(h.fh.saved.length).toBe(saves);
  });

  it('gate: a failed secrets read logs the error and says it could not reach Wealthfolio — not "update the add-on"', async () => {
    const h = harness();
    const entry = await h.file();
    h.io.secrets.get = async () => { throw new Error('keychain locked'); };
    const out = await h.undo(entry, 'undo');
    expect(out).toEqual({ ok: false, message: PAYBACK_UNREACHABLE });
    expect(h.logs.join('\n')).toContain('keychain locked');
  });
});
