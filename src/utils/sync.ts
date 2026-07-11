import { fetchAccounts } from './simplefin';
import { mapTransactionWithSource } from '../../shared/mapper';
import { detectTransferPairs } from '../../shared/transfers';
import type { TransferCandidate } from '../../shared/transfers';
import type { SimplefinAccount, SimplefinTransaction, ActivityType } from '../../shared/types';
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
  const authKey = await store.getAuthB64Key();
  const accountSet = await fetchAccounts(accessUrl, startDate, ctx.api.network, authKey);

  for (const sfErr of accountSet.errors) {
    errors.push(`SimpleFin error: ${sfErr.code} — ${sfErr.message}`);
  }

  let imported = 0;
  let skipped = 0;
  // Account types drive default typing (card refunds → CREDIT etc.)
  const wfAccounts = await ctx.api.accounts.getAll().catch(() => []);
  const wfTypes = new Map<string, string>(
    wfAccounts.map((a): [string, string] => [a.id, String(a.accountType ?? '')]),
  );

  // Phase A: resolve activity types for every transaction across all mapped
  // accounts, so transfer pairs can be detected across account boundaries
  interface PreparedTx {
    sfAccountId: string;
    tx: SimplefinTransaction;
    type: ActivityType;
  }
  const preparedByAccount = new Map<string, PreparedTx[]>();
  const candidates: TransferCandidate[] = [];

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;
    // Pending transactions often have no posted timestamp yet (posted: 0),
    // which produces a 1970 date the server rejects. Skip them — they import
    // on a later sync once they post.
    const transactions = (sfAccount.transactions ?? []).filter(
      (tx) => !tx.pending && tx.posted > 0,
    );
    const prepared: PreparedTx[] = [];
    for (const tx of transactions) {
      const amount = parseFloat(tx.amount);
      const { type, fromRule } = mapTransactionWithSource(
        tx.description, amount, rules, wfTypes.get(wfAccountId),
      );
      prepared.push({ sfAccountId: sfAccount.id, tx, type });
      candidates.push({
        txId: tx.id, accountId: sfAccount.id, posted: tx.posted, amount, ruleTyped: fromRule,
      });
    }
    preparedByAccount.set(sfAccount.id, prepared);
  }

  const detection = detectTransferPairs(candidates);
  for (const prepared of preparedByAccount.values()) {
    for (const p of prepared) {
      const override = detection.typeByTxId.get(p.tx.id);
      if (override) p.type = override;
    }
  }

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;

    const prepared = preparedByAccount.get(sfAccount.id) ?? [];
    const transactions = prepared.map((p) => p.tx);

    const activities = prepared.map(({ tx, type }) => ({
      accountId: wfAccountId,
      activityType: type,
      date: new Date(tx.posted * 1000).toISOString().split('T')[0],
      // Wealthfolio's required symbol field; $CASH-{currency} is its reserved
      // symbol for cash activities (bare $CASH is rejected)
      symbol: `$CASH-${sfAccount.currency}`,
      amount: Math.abs(parseFloat(tx.amount)),
      currency: sfAccount.currency,
      sourceSystem: 'simplefin' as const,
      // Wealthfolio shows the comment as the cash activity's title, and the
      // comment is also hashed into the duplicate-detection key. Combining the
      // bank description with the SimpleFin tx ID gives readable titles while
      // keeping the key unique (two identical purchases on the same day must
      // not dedup against each other).
      comment: `${tx.description} · ${tx.id}`,
      isValid: true,
      isDraft: false,
    }));

    const checked = activities.length > 0
      ? await ctx.api.activities.checkImport(activities)
      : [];
    const toImport = checked
      .filter((a: any) => a.isValid && !a.duplicateOfId)
      .map((a: any) => ({ ...a, isDraft: false, isValid: true }));
    const dupCount = checked.filter((a: any) => a.isValid && a.duplicateOfId).length;
    const invalidCount = checked.filter((a: any) => !a.isValid).length;
    skipped += dupCount;
    if (invalidCount > 0) {
      errors.push(`${invalidCount} transaction(s) failed validation for account ${wfAccountId}`);
    }

    // Starting-balance corrections are deliberately NOT done here. They need
    // an accurate current-balance read, and getting that wrong once (the
    // accounts API has no balance field) created full-balance duplicate
    // entries. The Docker companion owns balance corrections — it reads the
    // valuations endpoint and tracks initialization in its own state. Addon-
    // only users can set an opening balance via the account page's
    // edit-balance control instead.
    if (toImport.length > 0) {
      await ctx.api.activities.import(toImport);
      imported += toImport.length;
    }
  }

  await store.setLastSyncAt(new Date());

  return { imported, skipped, errors };
}
