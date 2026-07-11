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
  const authKey = await store.getAuthB64Key();
  const accountSet = await fetchAccounts(accessUrl, startDate, ctx.api.network, authKey);

  for (const sfErr of accountSet.errors) {
    errors.push(`SimpleFin error: ${sfErr.code} — ${sfErr.message}`);
  }

  let imported = 0;
  let skipped = 0;
  const balanceInitialized = await store.getBalanceInitialized();
  // Current Wealthfolio balances, read before importing, for the one-time
  // starting-balance calculation below
  const wfBalances = new Map<string, number>(
    (await ctx.api.accounts.getAll().catch(() => [])).map(
      (a): [string, number] => [a.id, a.balance ?? 0],
    ),
  );

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;

    // Pending transactions often have no posted timestamp yet (posted: 0),
    // which produces a 1970 date the server rejects. Skip them — they import
    // on a later sync once they post.
    const transactions = (sfAccount.transactions ?? []).filter(
      (tx) => !tx.pending && tx.posted > 0,
    );

    const activities = transactions.map((tx) => ({
      accountId: wfAccountId,
      activityType: mapTransaction(tx.description, parseFloat(tx.amount), rules),
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

    // Duplicate detection runs BEFORE the starting-balance calculation so the
    // correction only counts transactions that will actually be imported.
    // This makes it safe to run the addon and the Docker companion side by
    // side (even on different SimpleFin tokens): whatever the other syncer
    // already imported shows up as a duplicate here, contributes nothing to
    // the delta, and the starting balance self-cancels to zero.
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

    // One-time starting balance: transactions alone only capture the fetch
    // window's deltas, so the account balance would be wrong by whatever the
    // balance was before the window. SimpleFin reports the true current
    // balance; the correction is what's needed on top of the existing
    // Wealthfolio balance plus the about-to-be-imported deltas to land on it.
    const importList = [...toImport];
    if (!balanceInitialized.includes(sfAccount.id)) {
      const signedByComment = new Map(
        transactions.map((tx) => [`${tx.description} · ${tx.id}`, parseFloat(tx.amount)]),
      );
      const targetBalance = parseFloat(sfAccount.balance);
      const windowDelta = toImport.reduce(
        (sum: number, a: any) => sum + (signedByComment.get(a.comment) ?? 0),
        0,
      );
      const currentWfBalance = wfBalances.get(wfAccountId) ?? 0;
      const starting = targetBalance - windowDelta - currentWfBalance;
      if (Number.isFinite(starting) && Math.abs(starting) >= 0.01) {
        const oldestPosted = transactions.length > 0
          ? Math.min(...transactions.map((tx) => tx.posted))
          : Math.floor(Date.now() / 1000);
        const dayBefore = new Date((oldestPosted - 24 * 60 * 60) * 1000);
        importList.unshift({
          accountId: wfAccountId,
          activityType: starting > 0 ? 'DEPOSIT' : 'WITHDRAWAL',
          date: dayBefore.toISOString().split('T')[0],
          symbol: `$CASH-${sfAccount.currency}`,
          amount: Math.abs(Math.round(starting * 100) / 100),
          currency: sfAccount.currency,
          sourceSystem: 'simplefin' as const,
          comment: `Starting balance · ${sfAccount.id}`,
          isValid: true,
          isDraft: false,
        });
      }
    }

    if (importList.length > 0) {
      await ctx.api.activities.import(importList);
      imported += importList.length;
    }
    await store.addBalanceInitialized(sfAccount.id);
  }

  await store.setLastSyncAt(new Date());

  return { imported, skipped, errors };
}
