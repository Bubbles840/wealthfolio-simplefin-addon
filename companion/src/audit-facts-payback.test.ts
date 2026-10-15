import { describe, it, expect } from 'vitest';
import { emptySyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides.js';
import { accountTxKey } from '../../shared/transfers.js';
import { gatherHealthFacts, type AuditReaders } from './audit-facts.js';

const KEY = accountTxKey('sfin-chk', 'TRN-77');
const FLAGGED = setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', new Date('2026-10-14T15:00:00Z'), { label: 'VENMO CASHOUT · PNC Checking' });
const readers = (secrets: Record<string, string | null>): AuditReaders => ({
  secret: async (k) => {
    if (secrets[k] === undefined) return null;
    if (secrets[k] === 'THROW') throw new Error('401');
    return secrets[k];
  },
  valuations: async () => [],
  accounts: async () => [],
  ledger: () => ({ accounts: [], rows: [] }),
  headlineRows: () => [],
  settings: () => ({ timezone: null, excludedCategoryIds: [], categoryParents: {}, spendingOn: true, spendingAccountIds: [] }),
  spendingSpent: async () => 0,
});

describe("Health's facts carry the payback setting (1.62)", () => {
  it('reads the overrides, so a payback is never offered as the other half of a transfer', async () => {
    const facts = await gatherHealthFacts(readers({ account_mapping: '{}', [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(FLAGGED) }), { accounts: [], rows: [] });
    expect(facts.overrides).toEqual(FLAGGED);
  });

  it.each<[string, string]>([['unreadable', '{oops'], ['unreachable', 'THROW']])('knows none when they are %s, and checks Health as before', async (_name, raw) => {
    const facts = await gatherHealthFacts(readers({ account_mapping: '{}', [SYNC_OVERRIDES_SECRET_KEY]: raw }), { accounts: [], rows: [] });
    expect(facts.overrides).toBeUndefined();
    expect(facts.failed).toBeUndefined();
  });
});
