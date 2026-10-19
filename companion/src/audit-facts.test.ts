import { describe, it, expect, vi } from 'vitest';
import * as snapshotModule from '../../shared/audit-snapshot.js';
import {
  gatherHeadlineFacts, publishAuditSnapshot, runAudit, type AuditPublishClient, type AuditReaders,
} from './audit-facts.js';
import { BALANCE_READ_NOTES } from '../../shared/audit-balance.js';
import { explainHeadline, HEADLINE_READ_NOTES } from '../../shared/audit-headline.js';
import { HEALTH_READ_NOTES } from '../../shared/audit-health.js';
import type { AuditLedger, AuditLedgerRow } from '../../shared/audit-ledger.js';
import { AUDIT_SNAPSHOT_SECRET_KEY, parseAuditSnapshot } from '../../shared/audit-snapshot.js';
import { emptySyncOverrides, notTransferEdit } from '../../shared/sync-overrides.js';
import type { ReportCube } from '../../shared/report-cube.js';
import { snapshotTripwire } from '../../shared/spending-tripwire.js';

vi.mock('../../shared/audit-snapshot.js', async (orig) => {
  const real = await orig<typeof import('../../shared/audit-snapshot.js')>();
  return { ...real, buildAuditSnapshot: vi.fn(real.buildAuditSnapshot) };
});

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
    accounts: async () => [{ id: 'wf-chk', accountType: 'CASH' }, { id: 'wf-ally', accountType: 'CASH' }],
    ledger: () => LEDGER,
    headlineRows: () => [],
    settings: () => ({ timezone: 'America/New_York', excludedCategoryIds: [], categoryParents: {}, spendingOn: true, spendingAccountIds: ['wf-chk'] }),
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
    ['the account mapping', failingSecret('account_mapping'), () => [[BALANCE_READ_NOTES.mapping], [HEADLINE_READ_NOTES.mapping], [HEALTH_READ_NOTES.mapping]]],
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

  it('lists the transfers held past 14 days for the app, with the feed that holds each, and which are marked (1.65 C)', async () => {
    const placeholder = row({
      id: 'ph-1', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 25000, date: '2026-09-20', external: true,
      notes: '↔️ In-transit transfer · WIRE TRANSFER TO ACME LLC · w-old',
    });
    const withLedger = { ledger: () => ({ ...LEDGER, rows: [...LEDGER.rows, placeholder] }) };
    const out = await runAudit(readers(withLedger), NOW);
    expect(out.held).toEqual([expect.objectContaining({
      activityId: 'ph-1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 23, direction: 'out',
      txKey: 'sfin-chk\u0000w-old', label: 'WIRE TRANSFER TO ACME LLC · PNC Checking', heldBy: null,
    })]);
    expect(out.held?.[0]).not.toHaveProperty('marked');
    expect((await runAudit(readers({ ledger: boom }), NOW)).held).toBeUndefined();

    const doc = JSON.stringify(notTransferEdit('sfin-chk\u0000w-old', 'x', NOW)(emptySyncOverrides()));
    const marked = await runAudit(readers({ ...withLedger, secret: async (k) => (k === 'sync_overrides' ? doc : SECRETS[k] ?? null) }), NOW);
    expect(marked.held?.[0]).toMatchObject({ activityId: 'ph-1', marked: true });
    const unreadable = await runAudit(readers({ ...withLedger, secret: async (k) => { if (k === 'sync_overrides') throw new Error('401'); return SECRETS[k] ?? null; } }), NOW);
    expect(unreadable.held?.[0]).toMatchObject({ activityId: 'ph-1' });
    expect(unreadable.held?.[0]).not.toHaveProperty('marked');
  });

  it('keeps cash compared when only the database is down: the type comes from REST, cards stay uncompared', async () => {
    const accounts = async () => [{ id: 'wf-chk', accountType: 'CASH' }, { id: 'wf-card', accountType: 'CREDIT_CARD' }];
    const secret = async (k: string) => (k === 'account_mapping' ? JSON.stringify({ 'sfin-chk': 'wf-chk', 'sfin-card': 'wf-card' }) : SECRETS[k] ?? null);
    const valuations = async () => [{ accountId: 'wf-chk', totalValue: '2431.07' }, { accountId: 'wf-card', totalValue: '-90' }];
    const out = await runAudit(readers({ ledger: boom, accounts, secret, valuations }), NOW);
    expect(out.balances.notes).toEqual([BALANCE_READ_NOTES.ledger]);
    expect(out.balances.accounts.find((a) => a.wfAccountId === 'wf-chk')).toMatchObject({ wealthfolioCents: 243107, offCents: 5000 });
    expect(out.balances.accounts.find((a) => a.wfAccountId === 'wf-card')).toMatchObject({ wealthfolioCents: null, offCents: null });
  });

  it('compares nothing when the account list cannot be read, and says so', async () => {
    const out = await runAudit(readers({ accounts: async () => { throw new Error('502'); } }), NOW);
    expect(out.balances.notes).toEqual([BALANCE_READ_NOTES.accounts]);
    expect(BALANCE_READ_NOTES.accounts).toBe("Couldn't read your account list just now, so no account is compared.");
    expect(out.balances.accounts[0]).toMatchObject({ wealthfolioCents: null, offCents: null });
  });

  it('leaves an account of blank or unlisted type uncompared', async () => {
    for (const accounts of [[{ id: 'wf-chk', accountType: '' }], [{ id: 'wf-chk' }], [{ id: 'other', accountType: 'CASH' }]]) {
      const out = await runAudit(readers({ accounts: async () => accounts }), NOW);
      expect(out.balances.accounts[0]).toMatchObject({ wealthfolioCents: null, offCents: null });
      expect(out.balances.notes).toEqual([]);
    }
  });

  it('lists a secret that is not an object as failed, and drops a junk valuation for its own account only', async () => {
    const odd = await runAudit(readers({ secret: async (k) => (k === 'account_balances' ? '[1]' : SECRETS[k] ?? null) }), NOW);
    expect(odd.balances.notes).toEqual([BALANCE_READ_NOTES.balances]);
    const junk = await runAudit(readers({ valuations: async () => [{ accountId: 'wf-chk', totalValue: 'n/a' }, { accountId: 'wf-ally', totalValue: '5' }] }), NOW);
    expect(junk.balances.notes).toEqual([]);
    expect(junk.balances.accounts[0]).toMatchObject({ wealthfolioCents: null, offCents: null });
  });

  it('lists a Spending page figure that is not a number as failed', async () => {
    const facts = await gatherHeadlineFacts(readers({ spendingSpent: async () => Number.NaN }), NOW);
    expect(facts.failed).toEqual(['wealthfolio']);
    expect(facts.wealthfolioCents).toBeUndefined();
  });

  it('treats a turned-off Spending page as no figure, and never asks it', async () => {
    const spendingSpent = vi.fn(async () => 0);
    const settings = () => ({ timezone: 'America/New_York', excludedCategoryIds: [], categoryParents: {}, spendingOn: false, spendingAccountIds: [] });
    const out = await runAudit(readers({ spendingSpent, settings }), NOW);
    expect(spendingSpent).not.toHaveBeenCalled();
    expect(out.headline.wealthfolioCents).toBeNull();
    expect(out.headline.notes).toEqual([HEADLINE_READ_NOTES['spending-off']]);
    expect(HEADLINE_READ_NOTES['spending-off']).toBe("Wealthfolio's Spending page is turned off or has no accounts selected, so there's nothing to compare.");
  });

  it('reads the account mapping once per run', async () => {
    const secret = vi.fn(async (k: string) => SECRETS[k] ?? null);
    await runAudit(readers({ secret }), NOW);
    expect(secret.mock.calls.filter(([k]) => k === 'account_mapping')).toHaveLength(1);
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
    expect(facts).toMatchObject({ month: '2026-10', reportCents: 130000, wealthfolioCents: 130140, excludedCategoryIds: [] });
    expect(facts).not.toHaveProperty('today');
  });

  it('carries each side’s scope: Wealthfolio’s timezone and Spending accounts, the report’s mapped accounts', async () => {
    const secret = async (k: string) => (k === 'account_mapping' ? JSON.stringify({ 'sfin-chk': 'wf-chk', 'sfin-card': 'wf-card', 'sfin-gone': '' }) : SECRETS[k] ?? null);
    const facts = await gatherHeadlineFacts(readers({ secret }), NOW);
    expect(facts).toMatchObject({ timezone: 'America/New_York', spendingAccountIds: ['wf-chk'], reportAccountIds: ['wf-chk', 'wf-card'] });
  });

  it('leaves both scopes unknown, and the month in the companion’s zone, when their reads fail', async () => {
    const facts = await gatherHeadlineFacts(readers({ settings: boom, ...failingSecret('account_mapping') }), NOW);
    expect(facts.timezone).toBeNull();
    expect(facts.spendingAccountIds).toBeUndefined();
    expect(facts.reportAccountIds).toBeUndefined();
    expect(facts.failed).toEqual(['mapping', 'settings']);
  });

  it('reads Wealthfolio’s base currency from its settings, and says nothing of it when the settings are unread', async () => {
    const settings = () => ({ timezone: 'America/New_York', baseCurrency: 'USD', excludedCategoryIds: [], categoryParents: {}, spendingOn: true, spendingAccountIds: ['wf-chk'] });
    expect((await gatherHeadlineFacts(readers({ settings }), NOW)).baseCurrency).toBe('USD');
    expect((await gatherHeadlineFacts(readers({ settings: boom }), NOW)).baseCurrency).toBeUndefined();
  });

  it('turns an unreadable account mapping into a note, not a silent empty list of reasons', async () => {
    const facts = await gatherHeadlineFacts(readers({ ...failingSecret('account_mapping') }), NOW);
    expect(facts.failed).toContain('mapping');
    expect(explainHeadline(facts).notes).toContain(HEADLINE_READ_NOTES.mapping);
  });

  it('takes the report’s figure only from a cube built this month', async () => {
    const stale = { ...CUBE, months: ['2026-09'] };
    const facts = await gatherHeadlineFacts(readers({ secret: async (k) => (k === 'report_cube' ? JSON.stringify(stale) : SECRETS[k] ?? null) }), NOW);
    expect(facts.reportCents).toBeUndefined();
    expect(facts.failed).toEqual(['report']);
  });

  it('M-2: takes the report’s figure only from a cube built in this run (a failed publish leaves an older one)', async () => {
    const olderCube = { ...CUBE, asOf: new Date(NOW.getTime() - 60_000).toISOString() };
    const rd = readers({ secret: async (k) => (k === 'report_cube' ? JSON.stringify(olderCube) : SECRETS[k] ?? null) });
    const thisRun = await gatherHeadlineFacts(rd, NOW, undefined, new Date(NOW.getTime() - 120_000));
    expect(thisRun.reportCents).toBe(130000);
    const stale = await gatherHeadlineFacts(rd, NOW, undefined, new Date(NOW.getTime() - 30_000));
    expect(stale.reportCents).toBeUndefined();
    expect(stale.failed).toEqual(['report']);
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

  it('M-2: a cube left from an earlier run makes the tripwire unknown, never a difference', async () => {
    const older = { ...CUBE, spend: [[[0]]], asOf: new Date(NOW.getTime() - 3_600_000).toISOString() };
    const rd = readers({ secret: async (k) => (k === 'report_cube' ? JSON.stringify(older) : SECRETS[k] ?? null) });
    const set = vi.fn(async () => {});
    await publishAuditSnapshot(client(set), '/db', NOW, rd, new Date(NOW.getTime() - 60_000));
    const value = (set.mock.calls[0] as unknown as [string, string, string])[2];
    expect(snapshotTripwire(parseAuditSnapshot(value), NOW)).toEqual({ kind: 'unknown' });
  });

  it('writes nothing when Wealthfolio cannot be reached, so the previous snapshot stays', async () => {
    const set = vi.fn(async () => {});
    expect(await publishAuditSnapshot(client(set), '/db', NOW, readers(failingSecret('account_mapping')))).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects, and writes nothing, when the snapshot is over budget even trimmed', async () => {
    vi.mocked(snapshotModule.buildAuditSnapshot).mockReturnValueOnce(null);
    const set = vi.fn(async () => {});
    await expect(publishAuditSnapshot(client(set), '/db', NOW, readers())).rejects.toThrow(/over budget.*keeping the previous/);
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects when the write fails, for the sync to log', async () => {
    const set = vi.fn(async () => { throw new Error('500'); });
    await expect(publishAuditSnapshot(client(set), '/db', NOW, readers())).rejects.toThrow('500');
  });
});
