import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSION_CATEGORIES } from '@wealthfolio/addon-sdk';
import { paybackFiledChange } from '../../shared/change-entries';
import { paybackOnceKey } from '../../shared/payback-app';
import {
  PAYBACK_APP_UNDO_HINT, PAYBACK_COMPANION_UNKNOWN, PAYBACK_NO_UNDO, PAYBACK_UNAVAILABLE, PAYBACK_UPDATE_COMPANION,
} from '../../shared/payback-copy';
import { SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides';
import { addonPaybackIo, appPaybacksOffered, paybackFromApp, readPaybackCategories } from './app-payback';
import { SecretsStore } from './secrets';
import { beginSync, beginWrite, REMOVE_SYNC_RUNNING } from './write-lock';

const DETAILS = {
  id: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T12:00:00Z',
  amount: '14', currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: null,
};
const CATEGORIES = [
  { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-rest', key: 'restaurants', name: 'Restaurants', path: 'Food & Dining / Restaurants' },
  { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-book', key: 'book', name: 'Sync bookkeeping', path: 'Sync bookkeeping' },
  { kind: 'income', taxonomyId: 'income_categories', categoryId: 'cat-gift', key: 'gifts', name: 'Gifts', path: 'Gifts' },
];
const ONCE = paybackOnceKey('wf-chk', 'TRN-77');
const UNKNOWN_38 = "Unknown addon host API method 'spending.searchCashActivities'";

/**
 * Wealthfolio through the add-on SDK, in memory: one cash deposit, the
 * add-on's secrets and its rules. A rule save, a re-type and `rerunRules`
 * each run the rules over a row with no category, as Wealthfolio does.
 * `v38`: the host refuses the 3.9 calls.
 */
function wealthfolio(opts: { v38?: boolean; companion?: string | null; failChangeLog?: boolean } = {}) {
  let row: Record<string, unknown> = { ...DETAILS };
  let filing: { taxonomyId: string; categoryId: string; source: string } | null = null;
  const rules = new Map<string, { ruleKey: string; name: string; pattern: string; accountId: string; activityType: string; priority: number; categoryId: string }>();
  const secrets = new Map<string, string>([['account_mapping', JSON.stringify({ 'sfin-chk': 'wf-chk' })]]);
  if (opts.companion !== null) secrets.set('companion_version', opts.companion ?? '1.62.0');
  const run = () => {
    if (filing) return;
    const hit = [...rules.values()].sort((a, b) => b.priority - a.priority)
      .find((r) => r.accountId === row.accountId && r.activityType === row.activityType && r.pattern.toUpperCase() === String(row.comment).toUpperCase());
    if (hit) filing = { taxonomyId: 'spending_categories', categoryId: hit.categoryId, source: 'rule' };
  };
  const api = {
    accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'PNC Checking', accountType: 'CASH' }]) },
    activities: {
      search: vi.fn(async (_page: number, _size: number, filters: { activityIds?: string[] }) => ({
        data: filters?.activityIds?.includes(String(row.id)) ? [{ ...row }] : [], meta: { totalRowCount: 1 },
      })),
      saveMany: vi.fn(async (req: { updates?: Array<Record<string, unknown>> }) => {
        for (const u of req.updates ?? []) row = { ...row, activityType: u.activityType, subtype: u.subtype, date: u.activityDate };
        run();
        return { created: [], updated: req.updates ?? [], errors: [] };
      }),
    },
    spending: {
      searchCashActivities: vi.fn(async (q: { accountIds?: string[] }) => {
        if (opts.v38) throw new Error(UNKNOWN_38);
        const items = q.accountIds?.includes(String(row.accountId))
          ? [{ id: row.id, accountId: row.accountId, activityType: row.activityType, activityDate: row.date, transferLinkStatus: null, sourceGroupId: null, cashFlowBucket: 'income', assignments: filing ? [filing] : [] }]
          : [];
        return { items, totalCount: items.length };
      }),
      getCategories: vi.fn(async (kind?: string) => CATEGORIES.filter((c) => !kind || c.kind === kind)),
      getRules: vi.fn(async () => [...rules.values()].map(({ ruleKey: _key, ...r }) => ({ id: 'rule-1', matchType: 'exact', kind: 'expense', createdAt: '', updatedAt: '', ...r }))),
      saveRule: vi.fn(async (r: { ruleKey: string; name: string; pattern: string; accountId: string; activityType: string; priority: number; categoryId: string }) => { rules.set(r.ruleKey, r); run(); return r; }),
      deleteRule: vi.fn(async (key: string) => { rules.delete(key); }),
      rerunRules: vi.fn(async () => { run(); return 1; }),
    },
    secrets: {
      get: vi.fn(async (k: string) => secrets.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        if (opts.failChangeLog && k.startsWith('change_log')) throw new Error('quota');
        secrets.set(k, v);
      }),
      delete: vi.fn(async (k: string) => { secrets.delete(k); }),
    },
  };
  const ctx = { api } as any;
  return { ctx, api, secrets, rules, store: new SecretsStore(ctx), filing: () => filing, row: () => row };
}

describe('a payback from the app, through the add-on SDK', () => {
  it('files it: the one-off rule, the override, the re-type, the rule run, the filing read back, the rule deleted, the entry logged', async () => {
    const w = wealthfolio();
    expect(await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' })).toEqual({
      kind: 'filed',
      message: `Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.\n${PAYBACK_APP_UNDO_HINT}`,
    });
    expect(w.api.spending.saveRule).toHaveBeenCalledWith(expect.objectContaining({ ruleKey: ONCE, matchType: 'exact', activityType: 'CREDIT', accountId: 'wf-chk', priority: 1_000_000 }));
    expect(w.api.activities.saveMany).toHaveBeenCalledWith({ updates: [expect.objectContaining({ id: 'act-7', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' })] });
    expect(w.api.spending.rerunRules).toHaveBeenCalledWith(true);
    expect(w.api.spending.deleteRule).toHaveBeenCalledWith(ONCE);
    expect(w.rules.size).toBe(0);
    expect(w.filing()).toEqual({ taxonomyId: 'spending_categories', categoryId: 'cat-rest', source: 'rule' });
    expect(w.secrets.get(SYNC_OVERRIDES_SECRET_KEY)).toContain('asReimbursement');
    const log = await w.store.getChangeLog();
    expect(log?.entries[0]).toMatchObject({ kind: 'payback-filed', writer: 'addon', after: { categoryId: 'cat-rest' } });
  });

  it('sweeps a one-off rule a failed run left behind, rebuilding its key from what getRules lists', async () => {
    const w = wealthfolio();
    const left = paybackOnceKey('wf-chk', 'TRN-9');
    w.rules.set(left, { ruleKey: left, name: 'Payback (one-off) — ZELLE', pattern: 'ZELLE · TRN-9', accountId: 'wf-chk', activityType: 'CREDIT', priority: 1_000_000, categoryId: 'cat-rest' });
    await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' });
    expect(w.api.spending.deleteRule).toHaveBeenCalledWith(left);
    expect(w.rules.size).toBe(0);
  });

  it('says there is no Undo when the change log cannot be written', async () => {
    const w = wealthfolio({ failChangeLog: true });
    const out = await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' });
    expect(out.kind).toBe('filed');
    expect(out.message.split('\n')[1]).toBe(PAYBACK_NO_UNDO);
  });

  it('is refused while a sync holds the write lock, and touches nothing', async () => {
    const w = wealthfolio();
    const end = await beginSync();
    try {
      expect(await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' })).toEqual({ kind: 'refused', message: REMOVE_SYNC_RUNNING });
    } finally {
      end();
    }
    expect(w.api.spending.saveRule).not.toHaveBeenCalled();
    expect(w.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('lets the lock go when it is done', async () => {
    const w = wealthfolio({ companion: '1.61.0' });
    await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' });
    const release = beginWrite();
    expect(release).not.toBeNull();
    release?.();
  });
});

describe('the gate, read through the SDK', () => {
  it.each<[string, Parameters<typeof wealthfolio>[0], string | null]>([
    ['a 3.9 host and a 1.62 companion', {}, null],
    ['no companion', { companion: null }, PAYBACK_UNAVAILABLE],
    ['a 1.61 companion', { companion: '1.61.0' }, PAYBACK_UPDATE_COMPANION],
    ['a 3.8 host', { v38: true }, PAYBACK_UNAVAILABLE],
  ])('%s', async (_name, opts, expected) => {
    const w = wealthfolio(opts);
    expect(await addonPaybackIo(w.ctx, w.store, () => {}).gate()).toBe(expected);
  });

  it("refuses when the companion's version cannot be read", async () => {
    const w = wealthfolio();
    const logs: string[] = [];
    const io = addonPaybackIo(w.ctx, { getCompanionVersion: vi.fn(async () => { throw new Error('secrets offline'); }) }, (m) => logs.push(m));
    expect(await io.gate()).toBe(PAYBACK_COMPANION_UNKNOWN);
    expect(logs.join('\n')).toContain('secrets offline');
  });

  it('a 1.61 companion is refused before anything is read or written', async () => {
    const w = wealthfolio({ companion: '1.61.0' });
    expect(await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' })).toEqual({ kind: 'refused', message: PAYBACK_UPDATE_COMPANION });
    expect(w.api.activities.search).not.toHaveBeenCalled();
    expect(w.api.spending.saveRule).not.toHaveBeenCalled();
  });
});

describe('whether the app offers "It\'s a payback…"', () => {
  it('only on a 3.9+ host with a companion of 1.62.0 or newer', async () => {
    const w = wealthfolio();
    expect(await appPaybacksOffered(w.ctx, '1.62.0')).toBe(true);
    expect(await appPaybacksOffered(wealthfolio({ v38: true }).ctx, '1.62.0')).toBe(false);
  });

  it.each<[string, string | null]>([['no companion', null], ['a 1.61 companion', '1.61.0']])('not with %s, and without asking the host', async (_name, version) => {
    const w = wealthfolio();
    expect(await appPaybacksOffered(w.ctx, version)).toBe(false);
    expect(w.api.spending.searchCashActivities).not.toHaveBeenCalled();
  });
});

describe('the reads a payback makes', () => {
  it('offers the spending categories by path, without the bookkeeping one', async () => {
    const w = wealthfolio();
    expect((await readPaybackCategories(w.ctx)).map((c) => c.path)).toEqual(['Food & Dining / Restaurants']);
    expect(w.api.spending.getCategories).toHaveBeenCalledWith('expense');
  });

  it("reads the row with its stored instant, and Wealthfolio's facts for it", async () => {
    const w = wealthfolio();
    const io = addonPaybackIo(w.ctx, w.store, () => {});
    const row = await io.read('act-7');
    expect(row).toMatchObject({ id: 'act-7', accountType: 'CASH', type: 'DEPOSIT', instant: '2026-10-09T12:00:00Z', absCents: 1400 });
    expect(await io.fact(row!)).toMatchObject({ activityId: 'act-7', filings: [] });
    expect(await io.read('act-missing')).toBeNull();
    expect(await io.feeds('wf-chk')).toEqual(['sfin-chk']);
  });

  it('says the facts could not be read rather than "not in Spending"', async () => {
    const w = wealthfolio();
    const io = addonPaybackIo(w.ctx, w.store, () => {});
    const row = (await io.read('act-7'))!;
    await io.gate();
    w.api.spending.searchCashActivities.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(io.fact(row)).rejects.toThrow("Wealthfolio's facts could not be read");
  });

  it('a re-type Wealthfolio answers with errors is a refusal', async () => {
    const w = wealthfolio();
    w.api.activities.saveMany.mockResolvedValueOnce({ created: [], updated: [], errors: [{ action: 'update', message: 'nope' }] } as any);
    await expect(addonPaybackIo(w.ctx, w.store, () => {}).update({ id: 'act-7', accountId: 'wf-chk', activityType: 'CREDIT', activityDate: '2026-10-09T12:00:00Z', currency: 'USD', comment: 'x' })).rejects.toThrow('nope');
  });
});

describe('the store says whether a change-log entry was written', () => {
  const draft = paybackFiledChange({
    account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKeys: ['k'], activityId: 'act-7', description: 'VENMO CASHOUT',
    amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: 'cat-rest', categoryName: 'Restaurants',
  });

  it('true when it was', async () => {
    expect(await wealthfolio().store.recordChangeStrict(draft)).toBe(true);
  });

  it('false when it was not, without throwing', async () => {
    expect(await wealthfolio({ failChangeLog: true }).store.recordChangeStrict(draft)).toBe(false);
  });
});

describe('manifest.json declares the rule calls a payback makes', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '../../manifest.json'), 'utf8')) as {
    permissions: Array<{ category: string; functions: Array<string | { name: string }>; purpose: string }>;
  };
  const spending = manifest.permissions.find((p) => p.category === 'spending')!;
  const names = spending.functions.map((f) => (typeof f === 'string' ? f : f.name));

  it('getRules, saveRule, deleteRule and rerunRules, in the spending category, which the SDK lists', () => {
    expect(names).toEqual(expect.arrayContaining(['getCategories', 'getRules', 'saveRule', 'deleteRule', 'rerunRules']));
    const known = new Set(PERMISSION_CATEGORIES.find((c) => c.id === 'spending')!.functions);
    expect(names.filter((n) => !known.has(n))).toEqual([]);
  });

  it('says what they are for', () => {
    expect(spending.purpose).toContain('payback');
  });
});
