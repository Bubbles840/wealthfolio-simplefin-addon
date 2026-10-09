import { describe, it, expect, vi } from 'vitest';
import { gatherFindings, readSyncHealth, updateSnoozes, LEDGER_CHECK_SEEN_SECRET_KEY, type FindingsDeps } from './daily-findings.js';
import { FINDING_SNOOZES_SECRET_KEY } from '../../shared/findings.js';
import type { LedgerFacts } from '../../shared/ledger-checks.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const unixDaysAgo = (d: number) => Math.floor((NOW.getTime() - d * 86_400_000) / 1000);

const cleanFacts = (): LedgerFacts => ({
  month: '2026-10',
  cardBalances: [],
  idleRefunds: [],
  incomeReimbursements: [],
  unlinkedTransfers: [],
  groupedNonTransfers: [],
  heldTransfers: [],
  needsReview: 0,
  categories: [],
  chronicallyOver: [],
  missingLegs: [],
  cardsOpenedInCredit: [],
});

function makeDeps(secrets: Record<string, string>, facts: LedgerFacts | null = cleanFacts()) {
  const store = new Map(Object.entries(secrets));
  const deps: FindingsDeps = {
    getSecret: vi.fn(async (k: string) => store.get(k) ?? null),
    setSecret: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    installedAddonVersion: () => null,
    companionVersion: '1.57.0',
    ledgerFacts: vi.fn(() => facts),
    log: vi.fn(),
  };
  return { deps, store };
}

const healthy = { health: { lastSuccessAt: new Date(NOW.getTime() - 3_600_000).toISOString() }, healthUnreadable: false };

describe('readSyncHealth', () => {
  it('tells an unreadable secret apart from a missing one', async () => {
    // "Could not check" must never render as a clean bill of health.
    const missing = await readSyncHealth({ getSecret: async () => null });
    expect(missing).toEqual({ health: null, healthUnreadable: false });
    const unreadable = await readSyncHealth({ getSecret: async () => { throw new Error('401'); } });
    expect(unreadable).toEqual({ health: null, healthUnreadable: true });
  });
});

describe('gatherFindings', () => {
  it('judges the sync checks and the ledger audit together, minus what is snoozed', async () => {
    const facts = cleanFacts();
    facts.idleRefunds = [{ id: 'r1', description: 'Venmo', amount: 50 }];
    const { deps } = makeDeps({
      account_balances: JSON.stringify({ sf1: { balance: 10, date: unixDaysAgo(40) } }),
      account_names: JSON.stringify({ sf1: 'Discover' }),
      [FINDING_SNOOZES_SECRET_KEY]: JSON.stringify({ 'feed-stale:Discover': '2026-11-01T00:00:00.000Z' }),
    }, facts);

    const found = await gatherFindings(deps, NOW, { recordLedgerChecks: false, ...healthy });
    expect(found.visible.map((f) => f.key)).toEqual(['idle-refund:r1']);
    expect(found.snoozed.map((f) => f.key)).toEqual(['feed-stale:Discover']);
  });

  it('names a non-card account that differs from the bank, leaving cards to the ledger audit', async () => {
    // Cards have `card-balance`, judged from the ledger itself; a second
    // finding about the same card would say the same thing twice.
    const facts = cleanFacts();
    facts.cardBalances = [{ wfId: 'wf-card', name: 'Citi', ledger: -94, bank: -94, inFlight: false }];
    const since = new Date(NOW.getTime() - 86_400_000).toISOString();
    const { deps } = makeDeps({
      account_balances: JSON.stringify({
        sf1: { balance: 500, date: unixDaysAgo(1), drift: 36.1, driftSince: since },
        sf2: { balance: -94, date: unixDaysAgo(1), drift: 36, driftSince: since },
      }),
      account_names: JSON.stringify({ sf1: 'Checking', sf2: 'Citi' }),
      account_mapping: JSON.stringify({ sf1: 'wf-chk', sf2: 'wf-card' }),
    }, facts);

    const found = await gatherFindings(deps, NOW, { recordLedgerChecks: false, ...healthy });
    expect(found.visible.map((f) => f.key)).toEqual(['balance-drift:Checking']);
  });

  it('still names a card the ledger audit skips because a transfer is in flight', async () => {
    // `card-balance` cannot judge a card mid-transfer, so the sync's own
    // measure — the old drift alert's — is the only voice left for it.
    const facts = cleanFacts();
    facts.cardBalances = [{ wfId: 'wf-card', name: 'Citi', ledger: -130, bank: -94, inFlight: true }];
    const since = new Date(NOW.getTime() - 86_400_000).toISOString();
    const { deps } = makeDeps({
      account_balances: JSON.stringify({ sf2: { balance: -94, date: unixDaysAgo(1), drift: 36, driftSince: since } }),
      account_names: JSON.stringify({ sf2: 'Citi' }),
      account_mapping: JSON.stringify({ sf2: 'wf-card' }),
    }, facts);
    const found = await gatherFindings(deps, NOW, { recordLedgerChecks: false, ...healthy });
    expect(found.visible.map((f) => f.key)).toEqual(['balance-drift:Citi']);
  });

  it('asks the ledger about every transfer the sync gave up linking, and only those', async () => {
    const { deps } = makeDeps({
      transfer_link_failures: JSON.stringify({
        'TRN-9': { count: 3, firstFailedAt: '2026-06-02T00:00:00Z', alerted: true },
        'TRN-8': { count: 1, firstFailedAt: '2026-10-08T00:00:00Z', alerted: false },
      }),
    });
    await gatherFindings(deps, NOW, { recordLedgerChecks: false, ...healthy });
    expect(deps.ledgerFacts).toHaveBeenCalledWith(expect.any(Map), NOW, ['TRN-9']);
  });

  it('names every drifting account when the ledger cannot say which are cards', async () => {
    const since = new Date(NOW.getTime() - 86_400_000).toISOString();
    const { deps } = makeDeps({
      account_balances: JSON.stringify({ sf2: { balance: -94, date: unixDaysAgo(1), drift: 36, driftSince: since } }),
      account_names: JSON.stringify({ sf2: 'Citi' }),
      account_mapping: JSON.stringify({ sf2: 'wf-card' }),
    }, null);
    const found = await gatherFindings(deps, NOW, { recordLedgerChecks: false, ...healthy });
    expect(found.visible.map((f) => f.key)).toEqual(['balance-drift:Citi']);
  });

  it('records "first seen" only for the scheduled report, never for a preview or a tap', async () => {
    // A tap at 7am stamping a "say once" finding would use it up before the
    // 8am report carried it.
    const facts = cleanFacts();
    facts.categories = [{ name: 'Shopping', budget: 100, spent: 300, largest: { id: 'p1', description: 'Amazon', amount: 116 } }];

    const preview = makeDeps({}, facts);
    await gatherFindings(preview.deps, NOW, { recordLedgerChecks: false, ...healthy });
    expect(preview.store.has(LEDGER_CHECK_SEEN_SECRET_KEY)).toBe(false);

    const scheduled = makeDeps({}, facts);
    await gatherFindings(scheduled.deps, NOW, { recordLedgerChecks: true, ...healthy });
    expect(JSON.parse(scheduled.store.get(LEDGER_CHECK_SEEN_SECRET_KEY)!)).toHaveProperty('budget-buster:p1');
  });

  it('still returns the sync checks when the ledger cannot be read', async () => {
    // A checker that cannot check must not cost the user the report.
    const { deps } = makeDeps({ unmapped_accounts: JSON.stringify([{ accountName: 'Robinhood' }]) }, null);
    (deps.ledgerFacts as any).mockImplementation(() => { throw new Error('locked'); });
    const found = await gatherFindings(deps, NOW, { recordLedgerChecks: true, ...healthy });
    expect(found.visible.map((f) => f.kind)).toEqual(['unmapped-accounts']);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('locked'));
  });
});

describe('updateSnoozes', () => {
  it('refuses to write over a snooze store it could not read', async () => {
    // Writing `{}` plus one key over an unreadable store would silently
    // un-snooze everything else.
    const setSecret = vi.fn(async () => {});
    await expect(updateSnoozes(
      { getSecret: async () => { throw new Error('401'); }, setSecret },
      NOW,
      (current) => ({ ...current, k: 'x' }),
    )).rejects.toThrow('401');
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('prunes expired snoozes on the way through', async () => {
    const { deps, store } = makeDeps({
      [FINDING_SNOOZES_SECRET_KEY]: JSON.stringify({ old: '2026-01-01T00:00:00.000Z', live: '2026-12-01T00:00:00.000Z' }),
    });
    await updateSnoozes(deps, NOW, (current) => ({ ...current, added: '2026-11-08T12:00:00.000Z' }));
    expect(Object.keys(JSON.parse(store.get(FINDING_SNOOZES_SECRET_KEY)!)).sort()).toEqual(['added', 'live']);
  });
});
