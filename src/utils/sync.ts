import { fetchAccounts } from './simplefin';
import { mapTransaction } from '../../shared/mapper';
import type { SecretsStore } from './secrets';
import type { AddonContext } from '@wealthfolio/addon-sdk';

export const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface SyncResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export async function runSync(ctx: AddonContext, store: SecretsStore): Promise<SyncResult> {
  const errors: string[] = [];

  // Enforce minimum interval
  const lastSync = await store.getLastSyncAt();
  if (lastSync && Date.now() - lastSync.getTime() < MIN_SYNC_INTERVAL_MS) {
    return {
      imported: 0,
      skipped: 0,
      errors: ['Skipped: minimum sync interval of 1 hour not yet elapsed'],
    };
  }

  const accessUrl = await store.getAccessUrl();
  if (!accessUrl) return { imported: 0, skipped: 0, errors: ['Not configured: no access URL'] };

  const mapping = await store.getAccountMapping();
  if (!mapping) return { imported: 0, skipped: 0, errors: ['Not configured: no account mapping'] };

  const rules = await store.getMappingRules();

  const startDate = lastSync ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30d lookback on first sync
  const accountSet = await fetchAccounts(accessUrl, startDate);

  for (const sfErr of accountSet.errors) {
    errors.push(`SimpleFin error: ${sfErr.code} — ${sfErr.message}`);
  }

  let imported = 0;
  let skipped = 0;

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;

    const transactions = sfAccount.transactions ?? [];
    if (transactions.length === 0) continue;

    const activities = transactions.map((tx) => ({
      accountId: wfAccountId,
      activityType: mapTransaction(tx.description, parseFloat(tx.amount), rules),
      date: new Date(tx.posted * 1000).toISOString().split('T')[0],
      amount: Math.abs(parseFloat(tx.amount)),
      currency: sfAccount.currency,
      sourceSystem: 'simplefin' as const,
      comment: tx.id, // SimpleFin tx ID for reference
      isValid: true,
      isDraft: false,
    }));

    const checked = await ctx.api.activities.checkImport(wfAccountId, activities);
    const toImport = checked.filter((a: any) => a.isValid && !a.duplicateOfId);
    const dupCount = checked.length - toImport.length;
    skipped += dupCount;

    if (toImport.length > 0) {
      await ctx.api.activities.import(toImport);
      imported += toImport.length;
    }
  }

  await store.setLastSyncAt(new Date());

  return { imported, skipped, errors };
}
