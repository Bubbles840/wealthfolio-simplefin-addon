import { describe, it, expect, vi } from 'vitest';
import { SPENDING_TAXONOMY_ID } from './cash-flow-bucket.js';
import { stampChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import { paybackRowOf } from './payback.js';
import { paybackCategoriesOf, paybackOnceKey, type ListedRule, type PaybackOnceRule } from './payback-app.js';
import { filePaybackInApp, type AppPaybackChoice, type AppPaybackIo } from './payback-app-file.js';
import {
  PAYBACK_ALREADY, PAYBACK_APP_SETTING_HINT, PAYBACK_APP_UNDO_HINT, PAYBACK_APP_UPDATE_STUCK, PAYBACK_APP_UPDATE_UNSURE, PAYBACK_CATEGORY_GONE,
  PAYBACK_CHANGED, PAYBACK_COMPANION_UNKNOWN, PAYBACK_GONE, PAYBACK_GONE_STUCK, PAYBACK_LINKED, PAYBACK_MAPPING_UNREADABLE, PAYBACK_NO_UNDO,
  PAYBACK_NO_UNDO_SETTING, PAYBACK_NOT_IN_SPENDING, PAYBACK_OVERRIDE_FAILED, PAYBACK_PENDING, PAYBACK_RULE_REFUSED, PAYBACK_RUNNING,
  PAYBACK_UNAVAILABLE, PAYBACK_UNREACHABLE, PAYBACK_UPDATE_COMPANION, PAYBACK_UPDATE_REFUSED,
  paybackAlreadyFiled, paybackAppUnfiled, paybackAppUnsure, paybackFiledFirst, paybackLeftoverRule,
} from './payback-copy.js';
import type { PaybackRow } from './payback-row.js';
import {
  emptySyncOverrides, hasTxOverride, parseSyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY, SYNC_OVERRIDES_UNREADABLE_MESSAGE,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import { removalFingerprint, RemoveMappingUnreadableError } from './tx-remove.js';
import type { CashFact } from './wf-facts.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-chk', 'TRN-77');
const OTHER = accountTxKey('sfin-chk', 'TRN-1');
const ONCE = paybackOnceKey('wf-chk', 'TRN-77');
const RULE_NAME = 'Payback (one-off) — VENMO CASHOUT';
const RAW = '400 Bad Request: constraint failed: FOREIGN KEY';

const DETAILS = {
  id: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T12:00:00Z',
  amount: '14', currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: null,
};
const CATEGORIES = paybackCategoriesOf([
  { kind: 'expense', categoryId: 'cat-rest', name: 'Restaurants', path: 'Food & Dining / Restaurants' },
  { kind: 'expense', categoryId: 'cat-groc', name: 'Groceries', path: 'Food & Dining / Groceries' },
  { kind: 'expense', categoryId: 'cat-auto', name: 'Auto', path: 'Auto' },
  { kind: 'income', categoryId: 'cat-gift', name: 'Gifts', path: 'Gifts' },
]);
const RESTAURANTS: AppPaybackChoice = { activityId: 'act-7', categoryId: 'cat-rest' };
const FILED = 'Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.';

/** A rule Wealthfolio holds that is not this add-on's (a person's, or W10's). */
interface OtherRule { pattern: string; matchType: 'contains' | 'exact'; categoryId: string; activityType?: string; accountId?: string; priority: number }
type Stored = PaybackOnceRule & { seq: number };

/**
 * Wealthfolio, the add-on's secrets and its rules, in memory, every call in
 * order. Like Wealthfolio, a rule save and a re-type each set off a rule run
 * over the rows with no category, and so does `rerunRules`: the highest
 * priority wins, the oldest on a tie (upstream `match_compiled`).
 */
function world(over: {
  row?: Record<string, unknown> | null;
  secrets?: Record<string, string>;
  filing?: { taxonomyId: string; categoryId: string } | null;
  others?: OtherRule[];
  leftovers?: PaybackOnceRule[];
  inSpending?: boolean;
  grouped?: boolean;
  /** Wealthfolio's Spending is off: its rule runs file nothing. */
  rulesOff?: boolean;
  io?: Partial<AppPaybackIo>;
} = {}) {
  let row: PaybackRow | null = over.row === null ? null : paybackRowOf({ ...DETAILS, ...(over.row ?? {}) }, 'CASH');
  let filing = over.filing ? { ...over.filing, source: 'manual' } : null;
  const data = new Map(Object.entries(over.secrets ?? {}));
  const ours = new Map<string, Stored>();
  let seq = 0;
  for (const r of over.leftovers ?? []) ours.set(r.ruleKey, { ...r, seq: seq++ });
  const calls: string[] = [];
  const logged: ChangeEntry[] = [];
  const logs: string[] = [];
  const runRules = () => {
    if (over.rulesOff || !row || filing) return;
    const r = row;
    const all = [...(over.others ?? []).map((o, i) => ({ ...o, seq: -1000 + i })), ...ours.values()]
      .filter((x) => (!x.accountId || x.accountId === r.accountId) && (!x.activityType || x.activityType === r.type))
      .filter((x) => (x.matchType === 'exact' ? r.notes.toUpperCase() === x.pattern.toUpperCase() : r.notes.toUpperCase().includes(x.pattern.toUpperCase())))
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    if (all[0]) filing = { taxonomyId: SPENDING_TAXONOMY_ID, categoryId: all[0].categoryId, source: 'rule' };
  };
  const factOf = (): CashFact | null => (row && over.inSpending !== false
    ? { activityId: row.id, accountId: row.accountId, link: null, grouped: !!over.grouped, bucket: row.type === 'CREDIT' ? 'spending' : 'income', filings: filing ? [{ ...filing }] : [] }
    : null);
  const io: AppPaybackIo = {
    gate: vi.fn(async () => null),
    read: vi.fn(async (id: string) => { calls.push(`read ${id}`); return row ? { ...row } : null; }),
    feeds: vi.fn(async (wf: string) => { calls.push(`feeds ${wf}`); return ['sfin-chk']; }),
    secrets: {
      get: async (k: string) => data.get(k) ?? null,
      set: vi.fn(async (k: string, v: string) => { calls.push(`set ${k}`); data.set(k, v); }),
    },
    fact: vi.fn(async (r: PaybackRow) => { calls.push(`fact ${r.id}`); return factOf(); }),
    categories: vi.fn(async () => { calls.push('categories'); return CATEGORIES; }),
    rules: vi.fn(async (): Promise<ListedRule[]> => {
      calls.push('rules');
      return [...ours.values()].map((r) => ({ name: r.name, pattern: r.pattern, accountId: r.accountId, activityType: r.activityType, priority: r.priority }));
    }),
    saveRule: vi.fn(async (rule: PaybackOnceRule) => { calls.push(`saveRule ${rule.ruleKey}`); ours.set(rule.ruleKey, { ...rule, seq: seq++ }); runRules(); }),
    deleteRule: vi.fn(async (key: string) => { calls.push(`deleteRule ${key}`); ours.delete(key); }),
    update: vi.fn(async (w) => {
      calls.push(`update ${w.activityType}/${w.subtype}`);
      row = paybackRowOf({ ...DETAILS, ...(over.row ?? {}), activityType: w.activityType, subtype: w.subtype || null, date: w.activityDate }, 'CASH');
      runRules();
    }),
    rerunRules: vi.fn(async () => { calls.push('rerun'); runRules(); }),
    record: vi.fn(async (d: ChangeDraft) => { calls.push(`record ${d.kind}`); logged.push(stampChange(d, 'addon', NOW)); return true; }),
    log: (m: string) => { logs.push(m); },
    ...(over.io ?? {}),
  };
  const overrides = () => {
    const p = parseSyncOverrides(data.get(SYNC_OVERRIDES_SECRET_KEY));
    return p.kind === 'ok' ? p.overrides : p.kind === 'absent' ? emptySyncOverrides() : null;
  };
  return { io, data, calls, logged, logs, overrides, ours, filing: () => filing, row: () => row };
}

describe('filePaybackInApp: filing', () => {
  it('saves the one-off rule BEFORE the re-type, lets Wealthfolio file it, reads the filing back, deletes the rule and logs it', async () => {
    const w = world();
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}` });
    expect(w.calls).toEqual([
      'read act-7', 'feeds wf-chk', 'categories', 'fact act-7', 'rules', `saveRule ${ONCE}`, `set ${SYNC_OVERRIDES_SECRET_KEY}`,
      'update CREDIT/REIMBURSEMENT', 'rerun', 'fact act-7', `deleteRule ${ONCE}`, 'record payback-filed',
    ]);
    expect(w.io.saveRule).toHaveBeenCalledWith({
      ruleKey: ONCE, name: RULE_NAME, pattern: 'VENMO CASHOUT · TRN-77', matchType: 'exact', kind: 'expense', categoryId: 'cat-rest',
      activityType: 'CREDIT', accountId: 'wf-chk', priority: 1_000_000,
    });
    expect(w.io.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'act-7', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', activityDate: '2026-10-09T12:00:00Z', amount: 14 }));
    expect(w.filing()).toEqual({ taxonomyId: SPENDING_TAXONOMY_ID, categoryId: 'cat-rest', source: 'rule' });
    expect(w.ours.size).toBe(0);
    expect(w.overrides()!.tx[KEY]).toEqual({ asReimbursement: true, at: NOW.toISOString(), label: 'VENMO CASHOUT · PNC Checking' });
    expect(w.logged[0]).toMatchObject({
      kind: 'payback-filed', actor: 'you', writer: 'addon', subject: { txKeys: [KEY], activityIds: ['act-7'] },
      before: { activityType: 'DEPOSIT', subtype: null, categoryId: null },
      after: { activityType: 'CREDIT', subtype: 'REIMBURSEMENT', categoryId: 'cat-rest', categoryName: 'Restaurants', accountId: 'wf-chk' },
    });
  });

  it("wins the race with an older rule for CREDITs (W10's, at priority 50): its rule is in place before the re-type", async () => {
    const w10: OtherRule = { pattern: 'VENMO CASHOUT', matchType: 'contains', categoryId: 'cat-groc', activityType: 'CREDIT', accountId: 'wf-chk', priority: 50 };
    const w = world({ others: [w10] });
    expect((await filePaybackInApp(RESTAURANTS, w.io, NOW)).kind).toBe('filed');
    expect(w.filing()?.categoryId).toBe('cat-rest');
  });

  it('files nothing while the row is still a deposit: the rule is for CREDITs', async () => {
    const w = world();
    let filedAtSave: unknown = 'unread';
    const save = w.io.saveRule;
    w.io.saveRule = vi.fn(async (rule: PaybackOnceRule) => {
      await save(rule);
      filedAtSave = w.filing();
    });
    await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(filedAtSave).toBeNull();
    expect(w.filing()?.categoryId).toBe('cat-rest');
  });

  it('says so, and logs that category, when Wealthfolio filed it under another one first', async () => {
    const louder: OtherRule = { pattern: 'VENMO', matchType: 'contains', categoryId: 'cat-groc', activityType: 'CREDIT', priority: 2_000_000 };
    const w = world({ others: [louder] });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({
      kind: 'filed', message: `${paybackFiledFirst('Groceries')}\n${PAYBACK_APP_UNDO_HINT}`,
    });
    expect(w.logged[0].after).toMatchObject({ categoryId: 'cat-groc', categoryName: 'Groceries' });
    expect(w.ours.size).toBe(0);
  });

  it('says it is a payback with no category, and logs none, when Wealthfolio filed nothing', async () => {
    const w = world({ rulesOff: true });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({
      kind: 'partial', message: `${paybackAppUnfiled('Restaurants')}\n${PAYBACK_APP_UNDO_HINT}`,
    });
    expect(w.logged[0].after).toMatchObject({ activityType: 'CREDIT', categoryId: null, categoryName: null });
    expect(w.io.deleteRule).toHaveBeenCalledWith(ONCE);
  });

  it("goes on to read the filing back when the rule run fails: the background runs may have filed it", async () => {
    const w = world();
    w.io.rerunRules = vi.fn(async () => { throw new Error(RAW); });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}` });
    expect(w.logs.join('\n')).toContain(RAW);
  });

  it("says it can't tell when the filing cannot be read back, and logs no category", async () => {
    const w = world();
    let reads = 0;
    const fact = w.io.fact;
    w.io.fact = vi.fn(async (r: PaybackRow) => { reads += 1; if (reads > 1) throw new Error(RAW); return fact(r); });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'partial', message: `${paybackAppUnsure('Restaurants')}\n${PAYBACK_APP_UNDO_HINT}` });
    expect(out.message).not.toContain(RAW);
    expect(w.logged[0].after).toMatchObject({ categoryId: null });
    expect(w.ours.size).toBe(0);
  });

  it("says it can't tell when Wealthfolio no longer lists the row after the re-type", async () => {
    const w = world();
    let reads = 0;
    const fact = w.io.fact;
    w.io.fact = vi.fn(async (r: PaybackRow) => { reads += 1; return reads > 1 ? null : fact(r); });
    expect((await filePaybackInApp(RESTAURANTS, w.io, NOW)).message).toBe(`${paybackAppUnsure('Restaurants')}\n${PAYBACK_APP_UNDO_HINT}`);
  });

  it('names the one-off rule when it cannot be deleted; the filing stands', async () => {
    const w = world();
    w.io.deleteRule = vi.fn(async () => { throw new Error(RAW); });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}\n${paybackLeftoverRule(RULE_NAME)}` });
    expect(out.message).not.toContain(RAW);
  });

  it('says there is no Undo when the change log was not written', async () => {
    const w = world({ io: { record: vi.fn(async () => false) } });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_NO_UNDO}` });
    const thrown = world({ io: { record: vi.fn(async () => { throw new Error('quota'); }) } });
    expect(await filePaybackInApp(RESTAURANTS, thrown.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_NO_UNDO}` });
  });

  it('keeps every other override in the document', async () => {
    const w = world({ secrets: { [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(setTxOverride(emptySyncOverrides(), OTHER, 'notTransfer', NOW)) } });
    await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(hasTxOverride(w.overrides()!, OTHER, 'notTransfer')).toBe(true);
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(true);
  });

  it('writes a bare stored day back at noon UTC on it', async () => {
    const w = world({ row: { date: '2026-10-09' } });
    await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(w.io.update).toHaveBeenCalledWith(expect.objectContaining({ activityDate: '2026-10-09T12:00:00Z' }));
  });
});

describe('filePaybackInApp: one-off rules left behind', () => {
  const leftover = (txId: string, accountId = 'wf-chk'): PaybackOnceRule => ({
    ruleKey: paybackOnceKey(accountId, txId), name: `Payback (one-off) — ZELLE ${txId}`, pattern: `ZELLE ${txId} · ${txId}`, matchType: 'exact',
    kind: 'expense', categoryId: 'cat-auto', activityType: 'CREDIT', accountId, priority: 1_000_000,
  });

  it('sweeps each one by the key it rebuilds, before saving its own', async () => {
    const w = world({ leftovers: [leftover('TRN-9'), leftover('TRN-5', 'wf-sav')] });
    expect((await filePaybackInApp(RESTAURANTS, w.io, NOW)).kind).toBe('filed');
    const at = (c: string) => w.calls.indexOf(c);
    expect(at(`deleteRule ${paybackOnceKey('wf-chk', 'TRN-9')}`)).toBeLessThan(at(`saveRule ${ONCE}`));
    expect(at(`deleteRule ${paybackOnceKey('wf-sav', 'TRN-5')}`)).toBeLessThan(at(`saveRule ${ONCE}`));
    expect(w.ours.size).toBe(0);
  });

  it('carries on when the rules cannot be read, or one cannot be deleted', async () => {
    const unread = world({ io: { rules: vi.fn(async () => { throw new Error(RAW); }) } });
    expect((await filePaybackInApp(RESTAURANTS, unread.io, NOW)).kind).toBe('filed');
    expect(unread.logs.join('\n')).toContain(RAW);
    const stuck = world({ leftovers: [leftover('TRN-9')] });
    const del = stuck.io.deleteRule;
    stuck.io.deleteRule = vi.fn(async (key: string) => { if (key !== ONCE) throw new Error(RAW); return del(key); });
    expect(await filePaybackInApp(RESTAURANTS, stuck.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}` });
  });

  it('sweeps nothing when it refuses', async () => {
    const w = world({ leftovers: [leftover('TRN-9')], row: { comment: 'VENMO CASHOUT · TRN-77 · pending' } });
    await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(w.io.rules).not.toHaveBeenCalled();
    expect(w.ours.size).toBe(1);
  });
});

describe('filePaybackInApp: refusals write nothing', () => {
  const nothingWritten = (w: ReturnType<typeof world>) => {
    expect(w.io.saveRule).not.toHaveBeenCalled();
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.update).not.toHaveBeenCalled();
    expect(w.io.record).not.toHaveBeenCalled();
  };

  it.each([PAYBACK_UNAVAILABLE, PAYBACK_UPDATE_COMPANION, PAYBACK_COMPANION_UNKNOWN])('refuses at the gate, in its words, reading nothing: %s', async (gate) => {
    const w = world({ io: { gate: vi.fn(async () => gate) } });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: gate });
    expect(w.calls).toEqual([]);
  });

  it("says it couldn't reach Wealthfolio when the gate itself fails", async () => {
    const w = world({ io: { gate: vi.fn(async () => { throw new Error(RAW); }) } });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_UNREACHABLE });
    expect(w.calls).toEqual([]);
  });

  it('refuses a second click on the same row while the first is filing', async () => {
    const w = world();
    let release!: () => void;
    w.io.gate = vi.fn(() => new Promise<null>((r) => { release = () => r(null); }));
    const first = filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_RUNNING });
    release();
    expect((await first).kind).toBe('filed');
  });

  it.each<[string, Parameters<typeof world>[0], string]>([
    ['a pending row', { row: { comment: 'VENMO CASHOUT · TRN-77 · pending' } }, PAYBACK_PENDING],
    ['a payback already', { row: { activityType: 'CREDIT', subtype: 'REIMBURSEMENT' } }, PAYBACK_ALREADY],
    ['a row that is gone', { row: null }, PAYBACK_GONE],
    ['an account Spending does not track', { inSpending: false }, PAYBACK_NOT_IN_SPENDING],
    ['half of a transfer Wealthfolio says is linked', { grouped: true }, PAYBACK_LINKED],
    ['a row filed under income already', { filing: { taxonomyId: 'income_categories', categoryId: 'cat-gift' } }, paybackAlreadyFiled('Gifts')],
    ['a row filed under a category it cannot name', { filing: { taxonomyId: SPENDING_TAXONOMY_ID, categoryId: 'cat-x' } }, paybackAlreadyFiled('another category')],
    ['an overrides document it cannot read', { secrets: { [SYNC_OVERRIDES_SECRET_KEY]: '{oops' } }, SYNC_OVERRIDES_UNREADABLE_MESSAGE],
  ])('refuses %s', async (_name, over, message) => {
    const w = world(over);
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message });
    nothingWritten(w);
  });

  it.each(['cat-gone', 'cat-gift'])('refuses a category that is gone or not spending (%s)', async (categoryId) => {
    const w = world();
    expect(await filePaybackInApp({ activityId: 'act-7', categoryId }, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_CATEGORY_GONE });
    nothingWritten(w);
    expect(w.io.fact).not.toHaveBeenCalled();
  });

  it('refuses a row that changed since the story showed it, and files one that did not', async () => {
    const w = world();
    expect(await filePaybackInApp({ ...RESTAURANTS, shown: 'deadbeef' }, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_CHANGED });
    nothingWritten(w);
    const shown = removalFingerprint({ activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' });
    expect((await filePaybackInApp({ ...RESTAURANTS, shown }, world().io, NOW)).kind).toBe('filed');
  });

  it.each<[string, Partial<AppPaybackIo>, string]>([
    ['the row', { read: vi.fn(async () => { throw new Error(RAW); }) }, PAYBACK_UNREACHABLE],
    ['the categories', { categories: vi.fn(async () => { throw new Error(RAW); }) }, PAYBACK_UNREACHABLE],
    ["Wealthfolio's facts", { fact: vi.fn(async () => { throw new Error(RAW); }) }, PAYBACK_UNREACHABLE],
    ['the account mapping', { feeds: vi.fn(async () => { throw new RemoveMappingUnreadableError(); }) }, PAYBACK_MAPPING_UNREADABLE],
  ])('refuses when %s cannot be read', async (_name, io, message) => {
    const w = world({ io });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message });
    nothingWritten(w);
    expect(w.logs).not.toEqual([]);
  });
});

describe('filePaybackInApp: a step that fails partway says what stands', () => {
  it('stops at a rule Wealthfolio refuses, deleting it in case it landed: nothing changed', async () => {
    const w = world({ io: { saveRule: vi.fn(async () => { throw new Error(RAW); }) } });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'refused', message: PAYBACK_RULE_REFUSED });
    expect(w.io.deleteRule).toHaveBeenCalledWith(ONCE);
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.update).not.toHaveBeenCalled();
    expect(w.logs.join('\n')).toContain(RAW);
  });

  it('names the rule when its save failed and it cannot be deleted either', async () => {
    const w = world({ io: { saveRule: vi.fn(async () => { throw new Error(RAW); }), deleteRule: vi.fn(async () => { throw new Error(RAW); }) } });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: `${PAYBACK_RULE_REFUSED}\n${paybackLeftoverRule(RULE_NAME)}` });
  });

  it('takes the rule back out when the override cannot be saved', async () => {
    const w = world();
    w.io.secrets.set = vi.fn(async () => { throw new Error(RAW); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_OVERRIDE_FAILED });
    expect(w.ours.size).toBe(0);
    expect(w.io.update).not.toHaveBeenCalled();
  });

  it('carries on when the override write failed but landed', async () => {
    const w = world();
    const set = w.io.secrets.set;
    w.io.secrets.set = vi.fn(async (k: string, v: string) => { await set(k, v); throw new Error('response lost'); });
    expect((await filePaybackInApp(RESTAURANTS, w.io, NOW)).kind).toBe('filed');
  });

  it('never overwrites an overrides document that turned unreadable since it was read, and takes the rule back out', async () => {
    const w = world();
    let reads = 0;
    const get = w.io.secrets.get;
    w.io.secrets.get = async (k: string) => (k === SYNC_OVERRIDES_SECRET_KEY && ++reads > 1 ? '{oops' : get(k));
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: SYNC_OVERRIDES_UNREADABLE_MESSAGE });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.ours.size).toBe(0);
  });

  it('takes the override and the rule back when Wealthfolio refuses the re-type: nothing changed', async () => {
    const w = world({ secrets: { [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(setTxOverride(emptySyncOverrides(), OTHER, 'notTransfer', NOW)) } });
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'refused', message: PAYBACK_UPDATE_REFUSED });
    expect(out.message).not.toContain(RAW);
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(false);
    expect(hasTxOverride(w.overrides()!, OTHER, 'notTransfer')).toBe(true);
    expect(w.ours.size).toBe(0);
    expect(w.io.rerunRules).not.toHaveBeenCalled();
    expect(w.io.record).not.toHaveBeenCalled();
  });

  it('says the setting stays, and logs it with no category so Undo can take it off, when the override cannot come back off', async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    let sets = 0;
    const set = w.io.secrets.set;
    w.io.secrets.set = vi.fn(async (k: string, v: string) => { if (++sets > 1) throw new Error(RAW); return set(k, v); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: `${PAYBACK_APP_UPDATE_STUCK}\n${PAYBACK_APP_SETTING_HINT}` });
    expect(w.logged[0]).toMatchObject({ kind: 'payback-filed', after: { categoryId: null, categoryName: null } });
    expect(w.ours.size).toBe(0);
  });

  it("says it can't tell when the re-type failed and the row cannot be read again; the setting stays and is logged", async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    let reads = 0;
    const read = w.io.read;
    w.io.read = vi.fn(async (id: string) => { if (++reads > 1) throw new Error(RAW); return read(id); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: `${PAYBACK_APP_UPDATE_UNSURE}\n${PAYBACK_APP_SETTING_HINT}` });
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(true);
    expect(w.logged[0].after).toMatchObject({ categoryId: null });
    expect(w.ours.size).toBe(0);
  });

  it('says the setting can only come off in the overrides list when that log is not written either', async () => {
    const w = world({ io: { record: vi.fn(async () => false) } });
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    let reads = 0;
    const read = w.io.read;
    w.io.read = vi.fn(async (id: string) => { if (++reads > 1) throw new Error(RAW); return read(id); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: `${PAYBACK_APP_UPDATE_UNSURE}\n${PAYBACK_NO_UNDO_SETTING}` });
  });

  it('carries on when the re-type landed but its answer was lost', async () => {
    const w = world();
    const update = w.io.update;
    w.io.update = vi.fn(async (write) => { await update(write); throw new Error('response lost'); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}` });
  });

  it('says the row is gone when it went while being re-typed, taking the setting and the rule back', async () => {
    const w = world();
    let gone = false;
    const read = w.io.read;
    w.io.update = vi.fn(async () => { gone = true; throw new Error(RAW); });
    w.io.read = vi.fn(async (id: string) => (gone ? null : read(id)));
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_GONE });
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(false);
    expect(w.ours.size).toBe(0);
  });

  it('says the setting stays in the overrides list when the row is gone and it cannot come back off', async () => {
    const w = world();
    let gone = false;
    const read = w.io.read;
    w.io.update = vi.fn(async () => { gone = true; throw new Error(RAW); });
    w.io.read = vi.fn(async (id: string) => (gone ? null : read(id)));
    let sets = 0;
    const set = w.io.secrets.set;
    w.io.secrets.set = vi.fn(async (k: string, v: string) => { if (++sets > 1) throw new Error(RAW); return set(k, v); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: PAYBACK_GONE_STUCK });
  });

  it('names the one-off rule beside a refused re-type when it cannot be deleted', async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    w.io.deleteRule = vi.fn(async () => { throw new Error(RAW); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: `${PAYBACK_UPDATE_REFUSED}\n${paybackLeftoverRule(RULE_NAME)}` });
  });
});
