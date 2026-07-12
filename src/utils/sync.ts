import { fetchAccounts } from './simplefin';
import { mapTransactionWithSource } from '../../shared/mapper';
import { detectTransferPairs } from '../../shared/transfers';
import type { TransferCandidate } from '../../shared/transfers';
import type { SimplefinAccount, SimplefinTransaction, ActivityType } from '../../shared/types';
import type { SecretsStore } from './secrets';
import type { AddonContext } from '@wealthfolio/addon-sdk';

export const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Polling for freshly computed valuations after a first import (see the
 *  second-pass block in runSync). Exported so tests can shrink the delay. */
export const VALUATION_POLL = { attempts: 6, delayMs: 2500 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SyncResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * Shared-truth guard: asks Wealthfolio whether a starting-balance entry for
 * this SimpleFin account already exists (created by any syncer). Entries are
 * dated before the account's oldest imported transaction, so sorting by date
 * ascending puts them in the first rows.
 */
async function hasExistingStartingBalance(
  ctx: AddonContext,
  wfAccountId: string,
  sfinAccountId: string,
): Promise<boolean> {
  const res = await ctx.api.activities.search(
    0, 50, { accountIds: [wfAccountId] }, '', { id: 'date', desc: false },
  );
  const marker = `Starting balance · ${sfinAccountId}`;
  return res.data.some((a) => (a.comment ?? '') === marker);
}

/**
 * Type-proof idempotency guard. Wealthfolio's duplicate check hashes the
 * activity type into its fingerprint, so a transaction re-synced under a
 * different resolved type (rule changes, account-type edits, addon upgrades,
 * transfer detection kicking in) would slip past it and import twice. Every
 * imported activity carries its SimpleFin tx id at the end of the comment —
 * collect the ids already present so fetched transactions can be skipped by
 * identity, independent of type.
 */
async function fetchExistingTxIds(ctx: AddonContext, wfAccountId: string): Promise<Set<string>> {
  const res = await ctx.api.activities.search(
    0, 500, { accountIds: [wfAccountId] }, '', { id: 'date', desc: true },
  );
  const ids = new Set<string>();
  for (const a of res.data) {
    const comment = a.comment ?? '';
    const sep = comment.lastIndexOf(' · ');
    if (sep !== -1) ids.add(comment.slice(sep + 3));
  }
  return ids;
}

// Single-flight lock: the startup catch-up, the in-app schedule, and the
// Sync Now button can otherwise overlap in the first seconds after load —
// concurrent runs could each pass the pre-import checks before the other's
// writes land. Concurrent callers share the in-progress run's result.
let syncInFlight: Promise<SyncResult> | null = null;

export interface SyncOptions {
  /** Bypass the 1-hour minimum interval (the "Sync anyway" button). */
  force?: boolean;
}

/** Distinct marker so the UI can recognise an interval skip and offer to
 *  force, rather than treating it as a generic error. */
export const INTERVAL_SKIP_MESSAGE =
  'Skipped: minimum sync interval of 1 hour not yet elapsed';

export function runSync(
  ctx: AddonContext,
  store: SecretsStore,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSyncOnce(ctx, store, opts).finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function runSyncOnce(
  ctx: AddonContext,
  store: SecretsStore,
  opts: SyncOptions,
): Promise<SyncResult> {
  const errors: string[] = [];

  // Enforce minimum interval unless the caller forces (Sync anyway)
  const lastSync = await store.getLastSyncAt();
  if (!opts.force && lastSync && Date.now() - lastSync.getTime() < MIN_SYNC_INTERVAL_MS) {
    return { imported: 0, skipped: 0, errors: [INTERVAL_SKIP_MESSAGE] };
  }

  const accessUrl = await store.getAccessUrl();
  if (!accessUrl) return { imported: 0, skipped: 0, errors: ['Not configured: no access URL'] };

  const mapping = await store.getAccountMapping();
  if (!mapping) return { imported: 0, skipped: 0, errors: ['Not configured: no account mapping'] };

  const rules = await store.getMappingRules();

  // Incremental syncs fetch since the last sync. A forced sync (Sync anyway)
  // re-pulls the full 30-day window — the reason to force is that data is
  // missing, which a since-last-sync window (often minutes wide) would not
  // recover. First sync also uses the full window. The tx-id dedup guard
  // makes the wider re-pull safe (nothing re-imports).
  const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const startDate = opts.force || !lastSync ? THIRTY_DAYS_AGO : lastSync;
  const authKey = await store.getAuthB64Key();
  const accountSet = await fetchAccounts(accessUrl, startDate, ctx.api.network, authKey);

  for (const sfErr of accountSet.errors) {
    errors.push(`SimpleFin error: ${sfErr.code} — ${sfErr.message}`);
  }

  let imported = 0;
  let skipped = 0;
  const balanceInitialized = await store.getBalanceInitialized();
  // Account types drive default typing (card refunds → CREDIT etc.)
  const wfAccounts = await ctx.api.accounts.getAll().catch(() => []);
  const wfTypes = new Map<string, string>(
    wfAccounts.map((a): [string, string] => [a.id, String(a.accountType ?? '')]),
  );

  // Current Wealthfolio balances for the one-time starting-balance
  // correction. They come from the valuations API — accounts.getAll() has no
  // balance data behind it, and treating that absence as 0 once created
  // full-balance duplicate corrections. A failed fetch or a missing
  // per-account entry skips the correction (and leaves the account
  // un-initialized so a later run retries) rather than guessing 0.
  let wfBalances: Map<string, number> | null = null;
  try {
    const mappedWfIds = [...new Set(Object.values(mapping))];
    const valuations = mappedWfIds.length > 0
      ? await ctx.api.portfolio.getLatestValuations(mappedWfIds)
      : [];
    wfBalances = new Map(
      valuations.map((v): [string, number] => [v.accountId, v.totalValue ?? 0]),
    );
  } catch {
    errors.push('Could not read account balances — starting-balance checks skipped this run');
  }

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
        accountType: wfTypes.get(wfAccountId),
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

  // Accounts whose starting balance couldn't run yet because no valuation
  // row exists (first-ever import); handled by the second pass below
  let pendingCorrections: Array<{
    sfinAccountId: string;
    wfAccountId: string;
    targetBalance: number;
    currency: string;
    date: string;
  }> = [];

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;

    try {
    // Skip transactions already imported (matched by SimpleFin tx id, so a
    // changed resolved type can never re-import one). Falls back to the
    // server's own duplicate check when the lookup fails.
    let existingTxIds = new Set<string>();
    try {
      existingTxIds = await fetchExistingTxIds(ctx, wfAccountId);
    } catch {
      // search unavailable — checkImport still catches same-type duplicates
    }
    const preparedAll = preparedByAccount.get(sfAccount.id) ?? [];
    const prepared = preparedAll.filter((p) => !existingTxIds.has(p.tx.id));
    skipped += preparedAll.length - prepared.length;
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

    // One-time starting balance so the account lands on SimpleFin's reported
    // balance instead of just the fetch window's deltas. Runs only when this
    // account's balance is actually readable; the dedup-aware windowDelta
    // (counting only about-to-import transactions) makes this self-cancelling
    // when the Docker companion already corrected the account, so running
    // both syncers stays safe.
    const importList = [...toImport];
    const canReadBalance = wfBalances !== null && wfBalances.has(wfAccountId);
    // Shared-truth guard: both syncers keep separate "already corrected"
    // ledgers, so ask Wealthfolio itself whether a correction already exists
    // before creating one — "at most one starting-balance entry per account,
    // ever" holds even if local state is lost or the companion did the work.
    let alreadyCorrected = false;
    if (canReadBalance && !balanceInitialized.includes(sfAccount.id)) {
      try {
        alreadyCorrected = await hasExistingStartingBalance(ctx, wfAccountId, sfAccount.id);
      } catch {
        // Cannot verify — fall through to the math, which self-cancels when
        // the other syncer already corrected and balances are readable
      }
    }
    if (canReadBalance && !alreadyCorrected && !balanceInitialized.includes(sfAccount.id)) {
      const signedByComment = new Map(
        transactions.map((tx) => [`${tx.description} · ${tx.id}`, parseFloat(tx.amount)]),
      );
      const targetBalance = parseFloat(sfAccount.balance);
      const windowDelta = toImport.reduce(
        (sum: number, a: any) => sum + (signedByComment.get(a.comment) ?? 0),
        0,
      );
      const currentWfBalance = wfBalances!.get(wfAccountId)!;
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
    // Mark done only when the balance was readable for this account, so a
    // skipped correction retries on a later run
    if (canReadBalance) {
      await store.addBalanceInitialized(sfAccount.id);
    } else if (wfBalances !== null && !balanceInitialized.includes(sfAccount.id)) {
      // No valuation row yet (brand-new account) — queue for the same-run
      // second pass below instead of waiting a whole sync cycle
      const oldestPosted = transactions.length > 0
        ? Math.min(...transactions.map((tx) => tx.posted))
        : Math.floor(Date.now() / 1000);
      pendingCorrections.push({
        sfinAccountId: sfAccount.id,
        wfAccountId,
        targetBalance: parseFloat(sfAccount.balance),
        currency: sfAccount.currency,
        date: new Date((oldestPosted - 24 * 60 * 60) * 1000).toISOString().split('T')[0],
      });
    }
    } catch (e: any) {
      // Isolate per-account failures (e.g. a mapping pointing at a deleted
      // Wealthfolio account) so one bad account can't abort the whole sync
      errors.push(`Account ${wfAccountId} failed: ${e?.message ?? e}`);
    }
  }

  // Second pass: a brand-new account has no valuation row until Wealthfolio's
  // async recalculation runs after its first import. Poll briefly for the
  // fresh valuation and correct in the same run. A row appearing for an
  // account that had none implies it was computed after the import above, so
  // it already reflects the imported transactions — the correction is simply
  // target − valuation.
  if (wfBalances !== null && pendingCorrections.length > 0) {
    for (
      let attempt = 0;
      attempt < VALUATION_POLL.attempts && pendingCorrections.length > 0;
      attempt++
    ) {
      await sleep(VALUATION_POLL.delayMs);
      let latest: Map<string, number>;
      try {
        const vals = await ctx.api.portfolio.getLatestValuations(
          pendingCorrections.map((p) => p.wfAccountId),
        );
        latest = new Map(vals.map((v): [string, number] => [v.accountId, v.totalValue ?? 0]));
      } catch {
        continue;
      }
      const stillPending: typeof pendingCorrections = [];
      for (const p of pendingCorrections) {
        const valuation = latest.get(p.wfAccountId);
        if (valuation === undefined) {
          stillPending.push(p);
          continue;
        }
        try {
          const alreadyDone = await hasExistingStartingBalance(ctx, p.wfAccountId, p.sfinAccountId);
          const starting = p.targetBalance - valuation;
          if (!alreadyDone && Number.isFinite(starting) && Math.abs(starting) >= 0.01) {
            const correction = {
              accountId: p.wfAccountId,
              activityType: (starting > 0 ? 'DEPOSIT' : 'WITHDRAWAL') as ActivityType,
              date: p.date,
              symbol: `$CASH-${p.currency}`,
              amount: Math.abs(Math.round(starting * 100) / 100),
              currency: p.currency,
              sourceSystem: 'simplefin' as const,
              comment: `Starting balance · ${p.sfinAccountId}`,
              isValid: true,
              isDraft: false,
            };
            await ctx.api.activities.import([correction]);
            imported += 1;
          }
          await store.addBalanceInitialized(p.sfinAccountId);
        } catch {
          stillPending.push(p);
        }
      }
      pendingCorrections = stillPending;
    }
  }

  await store.setLastSyncAt(new Date());

  return { imported, skipped, errors };
}
