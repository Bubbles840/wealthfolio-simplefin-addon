import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { accountCreatedChange, importChange, stampChange } from '../../shared/change-entries';
import type { ChangeBucket } from '../../shared/change-log';
import { SecretsStore } from './secrets';

vi.mock('./simplefin', () => ({ fetchAccounts: vi.fn() }));
import { fetchAccounts } from './simplefin';
import { applyBalanceAdjustment, applyBaselineCorrection, runSync, VALUATION_POLL } from './sync';

const NOW = new Date('2026-10-12T14:05:00Z');

/** The add-on's secrets and activities, in memory: what SecretsStore and
 *  AddonSyncHost both talk to. Imports are stored so a read-back finds them. */
function makeCtx(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed };
  const rows: any[] = [];
  let next = 1;
  const ctx = {
    api: {
      network: { request: vi.fn() },
      secrets: {
        get: vi.fn(async (k: string) => data[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
        delete: vi.fn(async (k: string) => { delete data[k]; }),
      },
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-a', name: 'Everyday Checking', accountType: 'CASH' }]) },
      portfolio: { getLatestValuations: vi.fn(async () => [{ accountId: 'wf-a', totalValue: 0 }]) },
      activities: {
        search: vi.fn(async () => ({ data: rows })),
        import: vi.fn(async (acts: any[]) => {
          for (const a of acts) rows.push({ ...a, id: `imp-${next++}` });
          return acts;
        }),
        saveMany: vi.fn(async (req: any) => ({
          created: (req.creates ?? []).map((c: any) => ({ ...c, id: `new-${next++}`, notes: c.comment })),
          updated: (req.updates ?? []).map((u: any) => ({ ...u, notes: u.comment })),
          deleted: req.deleteIds ?? [], createdMappings: [], errors: [],
        })),
      },
    },
  } as any;
  return { ctx, data, rows };
}

const bucket = (data: Record<string, string>, key: string): ChangeBucket => JSON.parse(data[key]);

describe('SecretsStore — the change log', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records something you did under the add-on’s own key for this month', async () => {
    const { ctx, data } = makeCtx();
    await new SecretsStore(ctx).recordChange(accountCreatedChange({ sfinId: 'ACT-1', wfId: 'wf-a', name: 'Citi Card', accountType: 'CREDIT_CARD' }));
    const b = bucket(data, 'change_log:addon:2026-10');
    expect(b.entries).toEqual([expect.objectContaining({
      writer: 'addon', actor: 'you', kind: 'account-created', at: NOW.toISOString(), summary: 'Created the Wealthfolio account Citi Card',
    })]);
  });

  it('hands runSync a sink with a fresh add-on run id', () => {
    const sink = new SecretsStore(makeCtx().ctx).changeLogSink(NOW);
    expect(sink.writer).toBe('addon');
    expect(sink.run).toBe(`a${NOW.getTime().toString(36)}`);
  });

  it('reads both writers’ buckets, newest first', async () => {
    const mk = (writer: 'addon' | 'companion', iso: string, n: number) => stampChange(importChange({
      account: { name: 'Checking' }, txKey: `k${n}`, activityId: `a${n}`, description: `ROW ${n}`, amountCents: -100,
      date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
    }), writer, new Date(iso));
    const { ctx } = makeCtx({
      'change_log:addon:2026-10': JSON.stringify({ v: 1, writer: 'addon', month: '2026-10', entries: [mk('addon', '2026-10-12T10:00:00Z', 1)], gaps: [] }),
      'change_log:companion:2026-10': JSON.stringify({ v: 1, writer: 'companion', month: '2026-10', entries: [mk('companion', '2026-10-12T11:00:00Z', 2)], gaps: [] }),
    });
    const read = await new SecretsStore(ctx).getChangeLog();
    expect(read!.entries.map((e) => e.subject.description)).toEqual(['ROW 2', 'ROW 1']);
  });

  it('reads null, not an empty log, when the host read fails', async () => {
    const { ctx } = makeCtx();
    ctx.api.secrets.get.mockRejectedValue(new Error('host down'));
    expect(await new SecretsStore(ctx).getChangeLog()).toBeNull();
  });

  it('Reset deletes both writers’ buckets and fallbacks for this month and the four before it', async () => {
    const { ctx, data } = makeCtx({
      'change_log:addon:2026-10': '{}',
      'change_log:companion:2026-10.2': '{}',
      'change_log:companion:2026-06': '{}',
      'change_log:addon:2026-05': '{}',
    });
    await new SecretsStore(ctx).clearAll();
    expect(data['change_log:addon:2026-10']).toBeUndefined();
    expect(data['change_log:companion:2026-10.2']).toBeUndefined();
    expect(data['change_log:companion:2026-06']).toBeUndefined();
    // Five months back is past what any writer keeps; it was cleared long ago.
    expect(data['change_log:addon:2026-05']).toBe('{}');
  });
});

describe('the add-on records its own writes', () => {
  beforeEach(() => {
    vi.mocked(fetchAccounts).mockReset();
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a sync in the app records its imports under the add-on’s key', async () => {
    const { ctx, data } = makeCtx({
      simplefin_access_url: 'https://u:p@bridge.simplefin.org/simplefin',
      account_mapping: JSON.stringify({ 'sfin-1': 'wf-a' }),
      balance_initialized: JSON.stringify(['sfin-1']),
    });
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': NOW.getTime() / 1000,
        transactions: [{ id: 'tx-1', posted: Date.parse('2026-10-11T12:00:00Z') / 1000, amount: '-12.34', description: 'KROGER #123' }],
      }],
    } as any);
    const result = await runSync(ctx, new SecretsStore(ctx), { force: true });
    expect(result.imported).toBe(1);
    const entries = bucket(data, 'change_log:addon:2026-10').entries;
    expect(entries).toEqual([expect.objectContaining({
      kind: 'import', writer: 'addon', actor: 'auto', summary: 'Imported KROGER #123',
      run: `a${NOW.getTime().toString(36)}`,
    })]);
  });

  it('Add adjustment records a balance correction by you, with the row read back', async () => {
    const { ctx, data } = makeCtx({ account_balances: JSON.stringify({ 'sfin-1': { balance: 10, currency: 'USD', date: 1, drift: 2.15 } }) });
    await applyBalanceAdjustment(ctx, new SecretsStore(ctx), { sfinAccountId: 'sfin-1', wfAccountId: 'wf-a', currency: 'USD', amount: 2.15 });
    expect(bucket(data, 'change_log:addon:2026-10').entries).toEqual([expect.objectContaining({
      kind: 'balance-correction', actor: 'you', summary: 'Added a $2.15 balance correction to Everyday Checking',
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Everyday Checking' },
      subject: { activityIds: ['imp-1'], amountCents: 215, date: '2026-10-12' },
    })]);
  });

  it('accepting the baseline fix records the move by you, before and after', async () => {
    const { ctx, data, rows } = makeCtx();
    rows.push({ id: 'sb-1', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2026-06-19', amount: '11355.12', comment: 'Starting balance · sfin-1' });
    await applyBaselineCorrection(ctx, new SecretsStore(ctx), { sfinAccountId: 'sfin-1', wfAccountId: 'wf-a', currency: 'USD', suggestedAmount: 10055.12 });
    expect(bucket(data, 'change_log:addon:2026-10').entries).toEqual([expect.objectContaining({
      kind: 'starting-balance-moved', actor: 'you',
      summary: "Changed Everyday Checking's starting balance to $10,055.12 (was $11,355.12)",
      before: { activityId: 'sb-1', amountCents: 1135512, date: '2026-06-19', activityType: 'DEPOSIT' },
      after: { activityId: 'sb-1', amountCents: 1005512, date: '2026-06-19', activityType: 'CREDIT' },
    })]);
  });
});
