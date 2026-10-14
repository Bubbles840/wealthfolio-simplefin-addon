import { describe, it, expect, vi } from 'vitest';
import {
  gatherHeadlineFacts, publishAuditSnapshot, runAudit, type AuditPublishClient, type AuditReaders,
} from './audit-facts.js';
import { BALANCE_READ_NOTES } from '../../shared/audit-balance.js';
import { HEADLINE_READ_NOTES } from '../../shared/audit-headline.js';
import { HEALTH_READ_NOTES } from '../../shared/audit-health.js';
import type { AuditLedger, AuditLedgerRow } from '../../shared/audit-ledger.js';
import { AUDIT_SNAPSHOT_SECRET_KEY, parseAuditSnapshot } from '../../shared/audit-snapshot.js';
import type { ReportCube } from '../../shared/report-cube.js';

/** Midday, local: this month is October wherever the suite runs. */
const NOW = new Date(2026, 9, 13, 12, 0);

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-01', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const LEDGER: AuditLedger = {
  accounts: [{ id: 'wf-chk', name: 'Checking', type: 'CASH', archived: false }, { id: 'wf-ally', name: 'Ally', type: 'CASH', archived: false }],
  rows: [
    row({ id: 'p1', absCents: 1910, notes: 'COFFEE · TRN-7 · pending' }),
    row({ id: 'p2', absCents: 1910, notes: 'LUNCH · TRN-8 · pending' }),
    row({ id: 'out', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 60000, date: '2026-10-04', notes: 'TO ALLY · TRN-1' }),
  ],
};
const CUBE: ReportCube = {
  version: 1, asOf: NOW.toISOString(), months: ['2026-10'], categories: ['Food'],
  accounts: [{ sfinId: 'sfin-chk', name: 'PNC Checking', type: 'CASH' }],
  spend: [[[100000]]], uncategorized: [[30000]], income: [[0]], budgets: [[0]], merchants: [[]], feesInterest: [0],
  netWorth: [null], liquid: [null], pool: null,
};
const SECRETS: Record<string, string> = {
  account_mapping: JSON.stringify({ 'sfin-chk': 'wf-chk' }),
  account_balances: JSON.stringify({ 'sfin-chk': { balance: 2481.07, date: Date.parse('2026-10-13T12:00:00Z') / 1000 } }),
  account_names: JSON.stringify({ 'sfin-chk': 'PNC Checking' }),
  report_cube: JSON.stringify(CUBE),
};

function readers(over: Partial<AuditReaders> = {}): AuditReaders {
  return {
    secret: async (key) => SECRETS[key] ?? null,
    valuations: async () => [{ accountId: 'wf-chk', totalValue: '2431.07' }],
    ledger: () => LEDGER,
    headlineRows: () => [],
    settings: () => ({ timezone: 'America/New_York', excludedCategoryIds: [], categoryParents: {} }),
    spendingSpent: async () => 1200,
    ...over,
  };
}
const failingSecret = (key: string): Partial<AuditReaders> => ({
  secret: async (k) => { if (k === key) throw new Error('401'); return SECRETS[k] ?? null; },
});
const boom = () => { throw new Error('database is locked'); };

describe('runAudit', () => {
  it('explains the balances, the month and Health from one ledger read', async () => {
    const ledger = vi.fn(() => LEDGER);
    const out = await runAudit(readers({ ledger }), NOW);
    expect(ledger).toHaveBeenCalledTimes(1);
    expect(out.reached).toBe(true);
    expect(out.balances.accounts[0]).toMatchObject({ name: 'PNC Checking', offCents: 5000, causes: [{ kind: 'pending', cents: 3820, count: 2 }], unexplainedCents: 1180 });
    expect(out.headline).toMatchObject({ month: '2026-10', reportCents: 130000, wealthfolioCents: 120000, reasons: [], unexplainedCents: 10000 });
    expect(out.health.issues).toMatchObject([{ kind: 'incomplete-leg', key: 'leg:out', match: 'none' }]);
    expect([...out.balances.notes, ...out.headline.notes, ...out.health.notes]).toEqual([]);
  });

  it.each<[string, Partial<AuditReaders>, () => [string[], string[], string[]]]>([
    ['the account mapping', failingSecret('account_mapping'), () => [[BALANCE_READ_NOTES.mapping], [], [HEALTH_READ_NOTES.mapping]]],
    ['the bank balances', failingSecret('account_balances'), () => [[BALANCE_READ_NOTES.balances], [], []]],
    ['the account names', failingSecret('account_names'), () => [[BALANCE_READ_NOTES.names], [], []]],
    ['the report cube', failingSecret('report_cube'), () => [[], [HEADLINE_READ_NOTES.report], []]],
    ['the valuations', { valuations: async () => { throw new Error('502'); } }, () => [[BALANCE_READ_NOTES.valuations], [], []]],
    ['the ledger', { ledger: boom }, () => [[BALANCE_READ_NOTES.ledger], [], [HEALTH_READ_NOTES.ledger]]],
    ['the month’s rows', { headlineRows: boom }, () => [[], [HEADLINE_READ_NOTES.ledger], []]],
    ['the settings', { settings: boom }, () => [[], [HEADLINE_READ_NOTES.settings], []]],
    ['the Spending page', { spendingSpent: async () => { throw new Error('404'); } }, () => [[], [HEADLINE_READ_NOTES.wealthfolio], []]],
  ])('a failed read of %s becomes its note and costs only its own part', async (_what, over, notes) => {
    const out = await runAudit(readers(over), NOW);
    expect([out.balances.notes, out.headline.notes, out.health.notes]).toEqual(notes());
  });

  it('leaves an account of unknown type uncompared: without the ledger, or when the ledger does not know it', async () => {
    const noLedger = await runAudit(readers({ ledger: boom }), NOW);
    expect(noLedger.balances.accounts[0]).toMatchObject({ wealthfolioCents: null, offCents: null });
    const unknown: AuditLedger = { accounts: [{ id: 'wf-chk', name: 'Checking', type: '', archived: false }], rows: [] };
    const blank = await runAudit(readers({ ledger: () => unknown }), NOW);
    expect(blank.balances.accounts[0]).toMatchObject({ wealthfolioCents: null, offCents: null });
    const missing = await runAudit(readers({ ledger: () => ({ accounts: [], rows: [] }) }), NOW);
    expect(missing.balances.accounts[0]).toMatchObject({ wealthfolioCents: null, offCents: null });
  });

  it('lists a secret that is not an object, and a valuation it cannot read, as failed', async () => {
    const odd = await runAudit(readers({ secret: async (k) => (k === 'account_balances' ? '[1]' : SECRETS[k] ?? null) }), NOW);
    expect(odd.balances.notes).toEqual([BALANCE_READ_NOTES.balances]);
    const junk = await runAudit(readers({ valuations: async () => [{ accountId: 'wf-chk', totalValue: 'n/a' }] }), NOW);
    expect(junk.balances.notes).toEqual([BALANCE_READ_NOTES.valuations]);
  });

  it('lists a Spending page figure that is not a number as failed', async () => {
    const facts = await gatherHeadlineFacts(readers({ spendingSpent: async () => Number.NaN }), NOW);
    expect(facts.failed).toEqual(['wealthfolio']);
    expect(facts.wealthfolioCents).toBeUndefined();
  });

  it('is unreachable when not even the account mapping can be read', async () => {
    expect((await runAudit(readers(failingSecret('account_mapping')), NOW)).reached).toBe(false);
  });
});

describe('gatherHeadlineFacts', () => {
  it('asks Wealthfolio for this calendar month in its own timezone, and reads the month’s rows', async () => {
    const spendingSpent = vi.fn(async () => 1301.4);
    const headlineRows = vi.fn(() => []);
    const facts = await gatherHeadlineFacts(readers({ spendingSpent, headlineRows }), NOW);
    expect(spendingSpent).toHaveBeenCalledWith('2026-10-01T04:00:00.000Z', '2026-11-01T03:59:59.999Z');
    expect(headlineRows).toHaveBeenCalledWith('2026-10-01', '2026-11-01');
    expect(facts).toMatchObject({ month: '2026-10', today: '2026-10-13', reportCents: 130000, wealthfolioCents: 130140, excludedCategoryIds: [] });
  });

  it('takes the report’s figure only from a cube built this month', async () => {
    const stale = { ...CUBE, months: ['2026-09'] };
    const facts = await gatherHeadlineFacts(readers({ secret: async (k) => (k === 'report_cube' ? JSON.stringify(stale) : SECRETS[k] ?? null) }), NOW);
    expect(facts.reportCents).toBeUndefined();
    expect(facts.failed).toEqual(['report']);
  });
});

describe('publishAuditSnapshot', () => {
  const client = (set = vi.fn(async () => {})) => ({ setAddonSecret: set } as unknown as AuditPublishClient);

  it('writes a snapshot the app can read', async () => {
    const set = vi.fn(async () => {});
    expect(await publishAuditSnapshot(client(set), '/db', NOW, readers())).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    const [addon, key, value] = set.mock.calls[0] as unknown as [string, string, string];
    expect([addon, key]).toEqual(['simplefin-sync', AUDIT_SNAPSHOT_SECRET_KEY]);
    const read = parseAuditSnapshot(value);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.snapshot.at).toBe(NOW.toISOString());
      expect(Object.keys(read.snapshot.balances)).toEqual(['wf-chk']);
    }
  });

  it('writes nothing when Wealthfolio cannot be reached, so the previous snapshot stays', async () => {
    const set = vi.fn(async () => {});
    expect(await publishAuditSnapshot(client(set), '/db', NOW, readers(failingSecret('account_mapping')))).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects when the write fails, for the sync to log', async () => {
    const set = vi.fn(async () => { throw new Error('500'); });
    await expect(publishAuditSnapshot(client(set), '/db', NOW, readers())).rejects.toThrow('500');
  });
});
