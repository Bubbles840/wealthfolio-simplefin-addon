import { describe, it, expect, vi } from 'vitest';
import type { ChangeBucket, ChangeLogItem } from '../../shared/change-log.js';
import { runChangeUndo } from '../../shared/change-undo-run.js';
import { filePayback, makePaybackRules, type PaybackChoice } from '../../shared/payback.js';
import { removalFingerprint } from '../../shared/tx-remove.js';
import { PAYBACK_CHANGED, PAYBACK_MAPPING_UNREADABLE, PAYBACK_NO_UNDO, PAYBACK_NO_UNDO_SETTING, PAYBACK_UPDATE_ADDON, PAYBACK_UPDATE_UNSURE } from '../../shared/payback-copy.js';
import { hasTxOverride, parseSyncOverrides, SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides.js';
import { accountTxKey } from '../../shared/transfers.js';
import { INSTALLED_ADDON_VERSION_SECRET_KEY } from '../../shared/version.js';
import { companionUndoIo } from './change-undo-host.js';
import { companionPaybackBreadth, companionPaybackIo, companionPaybackRulesIo, readPaybackRow, type PaybackBreadthClient, type PaybackClient, type PaybackRulesClient } from './payback-host.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-chk', 'TRN-77');
const RESTAURANTS: PaybackChoice = { activityId: 'act-7', categoryId: 'cat-rest', categoryName: 'Restaurants', parentName: 'Food & Dining' };

type Row = Record<string, unknown> & { id: string };
const DEPOSIT: Row = {
  id: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T00:00:00+00:00',
  amount: '14', fee: '0', currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: null, sourceGroupId: null, metadata: null,
};

/** Wealthfolio over REST, in memory: exact-id search, accounts, the bulk endpoint, assignments, the add-on's secrets. */
function fakeClient(installed: string | null = '1.62.0') {
  const rows: Row[] = [{ ...DEPOSIT }];
  const data = new Map<string, string>([['account_mapping', JSON.stringify({ 'sfin-chk': 'wf-chk' })]]);
  if (installed !== null) data.set(INSTALLED_ADDON_VERSION_SECRET_KEY, installed);
  const filed = new Map<string, string>();
  const client = {
    getAddonSecret: vi.fn(async (_a: string, k: string) => data.get(k) ?? null),
    setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { data.set(k, v); }),
    getAccounts: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }]),
    searchActivities: vi.fn(async (b: { activityIdFilter?: string[] }) => rows.filter((r) => b.activityIdFilter?.includes(r.id)) as any),
    saveMany: vi.fn(async (req: { updates?: Array<Record<string, any>> }) => {
      for (const w of req.updates ?? []) {
        const r = rows.find((x) => x.id === w.id)!;
        // Wealthfolio's patch: an explicit empty subtype stores none; an OMITTED one is kept.
        Object.assign(r, {
          activityType: w.activityType, date: w.activityDate, amount: String(w.amount),
          ...('subtype' in w ? { subtype: w.subtype ? w.subtype : null } : {}),
        });
      }
      return { created: [], updated: [], errors: [] };
    }),
    assignActivityCategory: vi.fn(async (id: string, _t: string, cat: string) => { filed.set(id, cat); }),
    unassignActivityCategory: vi.fn(async (id: string) => { filed.delete(id); }),
    getActivityAssignments: vi.fn(async (id: string) => (filed.has(id) ? [{ taxonomyId: 'spending_categories', categoryId: filed.get(id)! }] : [])),
  };
  const logged = (): ChangeLogItem[] => [...data].filter(([k, v]) => k.startsWith('change_log:companion:') && v)
    .flatMap(([, v]) => (JSON.parse(v) as ChangeBucket).entries);
  const overrides = () => {
    const p = parseSyncOverrides(data.get(SYNC_OVERRIDES_SECRET_KEY));
    if (p.kind !== 'ok') throw new Error(p.kind);
    return p.overrides;
  };
  return { client: client as unknown as PaybackClient & typeof client, rows, data, filed, logged, overrides };
}

describe('a payback on the companion', () => {
  it('re-reads the row live, re-types it at its stored instant, files it and logs it in its own bucket', async () => {
    const f = fakeClient();
    const out = await filePayback(RESTAURANTS, companionPaybackIo(f.client, vi.fn()), NOW);
    expect(out.kind).toBe('filed');
    expect(f.client.searchActivities).toHaveBeenCalledWith({ page: 0, pageSize: 1, activityIdFilter: ['act-7'] });
    expect(f.client.saveMany).toHaveBeenCalledWith({ updates: [{
      id: 'act-7', accountId: 'wf-chk', activityType: 'CREDIT', activityDate: '2026-10-09T00:00:00+00:00', symbol: { symbol: '$CASH-USD' },
      amount: 14, currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: 'REIMBURSEMENT',
    }] });
    expect(f.client.assignActivityCategory).toHaveBeenCalledWith('act-7', 'spending_categories', 'cat-rest');
    expect(hasTxOverride(f.overrides(), KEY, 'asReimbursement')).toBe(true);
    expect(f.logged()).toEqual([expect.objectContaining({ writer: 'companion', actor: 'you', kind: 'payback-filed' })]);
  });

  it('M3: an assignment that landed but lost its response is read back from Wealthfolio and counted as filed', async () => {
    const f = fakeClient();
    f.client.assignActivityCategory.mockImplementation(async (id: string, _t: string, cat: string) => { f.filed.set(id, cat); throw new Error('socket hang up'); });
    const out = await filePayback(RESTAURANTS, companionPaybackIo(f.client, vi.fn()), NOW);
    expect(out.kind).toBe('filed');
    expect(f.client.getActivityAssignments).toHaveBeenCalledWith('act-7');
    expect(f.logged()[0]).toMatchObject({ kind: 'payback-filed', after: { categoryId: 'cat-rest' } });
  });

  it('says there is no Undo when the change log write is rejected (PB-I)', async () => {
    const f = fakeClient();
    const log = vi.fn();
    f.client.setAddonSecret.mockImplementation(async (_a: string, k: string, v: string) => {
      if (k.startsWith('change_log:')) throw new Error('500 from Wealthfolio');
      f.data.set(k, v);
    });
    const out = await filePayback(RESTAURANTS, companionPaybackIo(f.client, log), NOW);
    expect(out.kind).toBe('filed');
    expect(out.message).toContain(PAYBACK_NO_UNDO);
    expect(out.message).not.toContain('Undo it from /changes.');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the change log was not written'));
  });

  it('says the setting can only be taken off in the app when its record is rejected too (PB-I)', async () => {
    const f = fakeClient();
    f.client.setAddonSecret.mockImplementation(async (_a: string, k: string, v: string) => {
      if (k.startsWith('change_log:')) throw new Error('500 from Wealthfolio');
      f.data.set(k, v);
    });
    // The update fails, and so does the read that would say whether it landed.
    f.client.saveMany.mockRejectedValue(new Error('lost'));
    let reads = 0;
    const inner = f.client.searchActivities.getMockImplementation()!;
    f.client.searchActivities.mockImplementation(async (b: any) => { reads += 1; if (reads > 1) throw new Error('down'); return inner(b); });
    const out = await filePayback(RESTAURANTS, companionPaybackIo(f.client, vi.fn()), NOW);
    expect(out.message).toContain(PAYBACK_UPDATE_UNSURE);
    expect(out.message).toContain(PAYBACK_NO_UNDO_SETTING);
  });

  it.each(['{not json', '[]', '"wf-chk"', JSON.stringify({ 'sfin-chk': 7 })])(
    'an account mapping that reads as %s is unreadable in its own words, not "not from the bank feed" and not unreachable (PB-I m2)',
    async (raw) => {
      const f = fakeClient();
      f.data.set('account_mapping', raw);
      expect(await filePayback(RESTAURANTS, companionPaybackIo(f.client, vi.fn()), NOW)).toEqual({ kind: 'refused', message: PAYBACK_MAPPING_UNREADABLE });
      expect(f.client.saveMany).not.toHaveBeenCalled();
      expect(f.data.has(SYNC_OVERRIDES_SECRET_KEY)).toBe(false);
    },
  );

  it('refuses, and touches nothing, while the installed add-on is unknown', async () => {
    const f = fakeClient(null);
    expect(await filePayback(RESTAURANTS, companionPaybackIo(f.client, vi.fn()), NOW)).toEqual({ kind: 'refused', message: PAYBACK_UPDATE_ADDON });
    expect(f.client.searchActivities).not.toHaveBeenCalled();
    expect(f.client.saveMany).not.toHaveBeenCalled();
  });

  it('is undone and redone from /changes through the companion’s Undo host', async () => {
    const f = fakeClient();
    await filePayback(RESTAURANTS, companionPaybackIo(f.client, vi.fn()), NOW);
    const entry = f.logged()[0];
    const io = companionUndoIo(f.client as any, '/nope/wealthfolio.db');
    expect(await runChangeUndo(entry, [entry], 'undo', io, 'plain', NOW)).toMatchObject({ ok: true, message: "Undone — it's a deposit again, off Restaurants." });
    expect(await readPaybackRow(f.client, 'act-7')).toMatchObject({ type: 'DEPOSIT', subtype: null, instant: '2026-10-09T00:00:00+00:00' });
    expect(f.filed.has('act-7')).toBe(false);
    expect(hasTxOverride(f.overrides(), KEY, 'asReimbursement')).toBe(false);

    const undo = f.logged().find((e) => e.reverses?.op === 'undo')!;
    expect(await runChangeUndo({ ...entry, undone: { by: undo.id, at: undo.at } }, f.logged(), 'redo', io, 'plain', NOW))
      .toMatchObject({ ok: true, message: "Redone — it's a payback under Restaurants again." });
    expect(await readPaybackRow(f.client, 'act-7')).toMatchObject({ type: 'CREDIT', subtype: 'REIMBURSEMENT', instant: '2026-10-09T00:00:00+00:00' });
    expect(f.filed.get('act-7')).toBe('cat-rest');
    expect(hasTxOverride(f.overrides(), KEY, 'asReimbursement')).toBe(true);
  });

  it('refuses a row changed since the menu drew it, with nothing written (PB-B M1)', async () => {
    const f = fakeClient();
    const shown = removalFingerprint({
      activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking',
    });
    // Same bank text, other amount since the menu was drawn.
    f.rows[0].amount = '15';
    expect(await filePayback({ ...RESTAURANTS, shown }, companionPaybackIo(f.client, vi.fn()), NOW))
      .toEqual({ kind: 'refused', message: PAYBACK_CHANGED });
    expect(f.client.saveMany).not.toHaveBeenCalled();
    expect(f.client.assignActivityCategory).not.toHaveBeenCalled();
    expect(f.data.has(SYNC_OVERRIDES_SECRET_KEY)).toBe(false);
  });

  it('files when the row is as the menu drew it (the menu’s fingerprint matches the re-read)', async () => {
    const f = fakeClient();
    const shown = removalFingerprint({
      activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking',
    });
    expect((await filePayback({ ...RESTAURANTS, shown }, companionPaybackIo(f.client, vi.fn()), NOW)).kind).toBe('filed');
  });

  it('passes the companion’s log to the Undo runner (Task 4 fix round)', async () => {
    const f = fakeClient();
    await filePayback(RESTAURANTS, companionPaybackIo(f.client, vi.fn()), NOW);
    const entry = f.logged()[0];
    const log = vi.fn();
    f.client.getAddonSecret.mockImplementation(async (_a: string, k: string) => {
      if (k === INSTALLED_ADDON_VERSION_SECRET_KEY) throw new Error('secrets down');
      return f.data.get(k) ?? null;
    });
    const out = await runChangeUndo(entry, [entry], 'undo', companionUndoIo(f.client as any, '/nope/wealthfolio.db', undefined, log), 'plain', NOW);
    expect(out.ok).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('secrets down'));
  });
});

describe('"Make every … deposit a payback" on the companion (W10)', () => {
  it('appends the transaction rule and asks Wealthfolio for a rule that files paybacks in that account only', async () => {
    const f = fakeClient();
    const client = Object.assign(f.client, {
      listCategorizationRules: vi.fn(async () => []),
      createCategorizationRule: vi.fn(async () => 'rule-9'),
    }) as unknown as PaybackRulesClient & { createCategorizationRule: ReturnType<typeof vi.fn> };
    const out = await makePaybackRules({
      pattern: 'ACME REFUND', account: { id: 'wf-chk', name: 'PNC Checking' }, categoryId: 'cat-rest', categoryName: 'Restaurants', description: 'ACME REFUND',
    }, companionPaybackRulesIo(client, vi.fn()), NOW);
    expect(out.ok).toBe(true);
    expect(client.createCategorizationRule).toHaveBeenCalledWith({
      name: 'Telegram payback: ACME REFUND', pattern: 'ACME REFUND', categoryId: 'cat-rest', accountId: 'wf-chk', activityType: 'CREDIT',
      taxonomyId: 'spending_categories', priority: 50,
    });
    expect(JSON.parse(f.data.get('mapping_rules')!)).toEqual([{
      pattern: 'ACME REFUND', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', onlyMoneyIn: true, accountId: 'wf-chk', since: '2026-10-13',
    }]);
    expect(f.logged().map((e) => e.kind)).toEqual(['mapping-rule-created', 'category-rule-created']);
  });

  it('re-runs the transfer-takeover check itself, from the live ledger, and writes nothing when a transfer is there (PB-M m-a, M2)', async () => {
    const f = fakeClient();
    const rules = { listCategorizationRules: vi.fn(async () => []), createCategorizationRule: vi.fn(async () => 'rule-9') };
    const input = { pattern: 'ACME REFUND', account: { id: 'wf-chk', name: 'PNC Checking' }, categoryId: 'cat-rest', categoryName: 'Restaurants', description: 'ACME REFUND', sourceId: 'src' };
    const transfers = vi.fn(async () => [
      { id: 'src', accountId: 'wf-chk', activityType: 'DEPOSIT', date: '2026-10-09', amount: '14', comment: 'ACME REFUND · TRN-0' },
      { id: 't', accountId: 'wf-chk', activityType: 'TRANSFER_IN', date: '2026-10-08', amount: '50', comment: 'ACME REFUND 9 · TRN-1' },
    ]);
    const client = Object.assign(f.client, rules, { searchActivities: transfers }) as unknown as PaybackRulesClient;
    const out = await makePaybackRules(input, companionPaybackRulesIo(client, vi.fn()), NOW);
    expect(out.ok).toBe(false);
    expect(out.message).toContain('already in your ledger as transfers');
    expect(rules.createCategorizationRule).not.toHaveBeenCalled();
    expect(f.data.get('mapping_rules')).toBeUndefined();
    // A ledger that cannot be read refuses too.
    const down = Object.assign(f.client, rules, { searchActivities: vi.fn(async () => { throw new Error('down'); }) }) as unknown as PaybackRulesClient;
    expect((await makePaybackRules(input, companionPaybackRulesIo(down, vi.fn()), NOW)).ok).toBe(false);
    expect(f.data.get('mapping_rules')).toBeUndefined();
  });

  it('reads the breadth live: 90 days of the account’s money in, judged by the fresh transaction rules (I1)', async () => {
    const f = fakeClient();
    f.data.set('mapping_rules', JSON.stringify([{ pattern: 'ACME', matchType: 'contains', activityType: 'DEPOSIT' }]));
    const searchActivities = vi.fn(async () => [
      { id: 'w', accountId: 'wf-chk', activityType: 'DEPOSIT', date: '2026-10-08', amount: '14', comment: 'ACME REFUND 1 · TRN-1' },
      { id: 'f', accountId: 'wf-chk', activityType: 'CREDIT', date: '2026-10-07', amount: '9', comment: 'ACME REFUND · Venmo: Rent · TRN-2' },
      { id: 'x', accountId: 'wf-chk', activityType: 'DEPOSIT', date: '2026-10-07', amount: '2000', comment: 'ACME PAYROLL · TRN-3' },
    ]);
    const client = Object.assign(f.client, { searchActivities }) as unknown as PaybackBreadthClient;
    const out = await companionPaybackBreadth(client, {
      pattern: 'ACME REFUND', account: { id: 'wf-chk', name: 'PNC Checking' }, sourceId: 'src', description: 'ACME REFUND', waitingIds: ['w'],
    }, NOW);
    expect(out).toEqual({ ok: true, filed: 1, waiting: 1 });
    expect(searchActivities).toHaveBeenCalledWith(expect.objectContaining({ accountIdFilter: ['wf-chk'], dateFrom: '2026-07-16', dateTo: '2026-10-14' }));
  });
});
