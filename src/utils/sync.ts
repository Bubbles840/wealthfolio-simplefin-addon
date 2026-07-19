import { fetchAccounts } from './simplefin';
import { mapTransactionWithSource } from '../../shared/mapper';
import { detectTransferPairs } from '../../shared/transfers';
import type { TransferCandidate } from '../../shared/transfers';
import { planReconciliation } from '../../shared/reconcile';
import type { FeedTx, ExistingRow } from '../../shared/reconcile';
import type { SimplefinAccount, SimplefinTransaction, ActivityType } from '../../shared/types';
import type { SecretsStore, AccountBalanceInfo } from './secrets';
import type { AddonContext, ActivityCreate, ActivityUpdate } from '@wealthfolio/addon-sdk';

/**
 * A datable timestamp for a SimpleFin transaction: `posted` when present, else
 * `transacted_at` (pending rows frequently have `posted: 0` until they settle).
 * Rows with neither can't be dated and are dropped from the sync.
 */
function txEpoch(tx: SimplefinTransaction): number | null {
  if (tx.posted && tx.posted > 0) return tx.posted;
  if (tx.transacted_at && tx.transacted_at > 0) return tx.transacted_at;
  return null;
}

export const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * How far before lastSyncAt an incremental sync re-scans. Card purchases post
 * a few days late, frequently with a `posted` timestamp backdated to the
 * purchase date — earlier than lastSyncAt. SimpleFin's start-date filter is on
 * `posted`, so a window that began exactly at lastSyncAt would exclude such a
 * transaction permanently (it becomes available only after we synced, but is
 * dated before our window). Re-scanning a two-week overlap catches them once
 * they post; the tx-id dedup guard makes re-scanning already-imported rows a
 * no-op, and the 3-day transfer-pair window keeps old rows from re-pairing.
 */
export const SYNC_LOOKBACK_OVERLAP_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Only flag balance drift (SimpleFin vs Wealthfolio) beyond this, to absorb
 *  rounding and to keep the Sync page from crying wolf over pennies. */
export const DRIFT_THRESHOLD_DOLLARS = 1;

/** Heal ("Reconcile balances") re-scans this far back — wider than a normal
 *  force sync — to recover transactions that a broken earlier sync missed.
 *  Just under SimpleFin's 90-day maximum: requesting exactly 90 days trips a
 *  "date range exceeds limit and was capped" notice by the time the request
 *  lands, so we stay a day inside it. */
export const HEAL_WINDOW_MS = 89 * 24 * 60 * 60 * 1000; // ~90 days, under SimpleFin's cap

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
 * Whether a balance-adjustment entry was already inserted for this account today
 * — the once-a-day guard that stops aggressive auto-heal from stacking a second
 * adjustment on a rapid re-sync before Wealthfolio has recomputed valuations.
 */
async function hasAdjustmentToday(
  ctx: AddonContext,
  wfAccountId: string,
  sfinAccountId: string,
): Promise<boolean> {
  const res = await ctx.api.activities.search(
    0, 50, { accountIds: [wfAccountId] }, '', { id: 'date', desc: true },
  );
  const marker = `Balance adjustment · ${sfinAccountId} · ${new Date().toISOString().split('T')[0]}`;
  return res.data.some((a) => (a.comment ?? '') === marker);
}

const PENDING_SUFFIX = ' · pending';

/**
 * Reads the existing SimpleFin-sourced activities for an account into
 * `ExistingRow`s the reconciliation planner can match against. Every imported
 * activity carries its SimpleFin tx id at the end of the comment, optionally
 * followed by a ` · pending` marker — parse both back out so a row can be
 * matched by identity (independent of type) and recognised as still-pending.
 */
async function fetchExistingRows(ctx: AddonContext, wfAccountId: string): Promise<ExistingRow[]> {
  const res = await ctx.api.activities.search(
    0, 500, { accountIds: [wfAccountId] }, '', { id: 'date', desc: true },
  );
  const rows: ExistingRow[] = [];
  for (const a of res.data) {
    let comment = a.comment ?? '';
    let pending = false;
    if (comment.endsWith(PENDING_SUFFIX)) {
      pending = true;
      comment = comment.slice(0, -PENDING_SUFFIX.length);
    }
    const sep = comment.lastIndexOf(' · ');
    if (sep === -1) continue;
    const txId = comment.slice(sep + 3);
    rows.push({
      wfId: a.id,
      wfAccountId,
      txId,
      absCents: Math.round(Math.abs(parseFloat(String(a.amount ?? '0'))) * 100),
      type: String(a.activityType),
      date: new Date(a.date).toISOString().slice(0, 10),
      pending,
    });
  }
  return rows;
}

// Single-flight lock: the startup catch-up, the in-app schedule, and the
// Sync Now button can otherwise overlap in the first seconds after load —
// concurrent runs could each pass the pre-import checks before the other's
// writes land. Concurrent callers share the in-progress run's result.
let syncInFlight: Promise<SyncResult> | null = null;

export interface SyncOptions {
  /** Bypass the 1-hour minimum interval (the "Sync anyway" button). */
  force?: boolean;
  /** Heal/Reconcile: re-scan a wide 90-day window to recover transactions
   *  that never imported, and measure residual drift lag-free (accounting for
   *  what this run imports) so the Sync page can offer a balance adjustment for
   *  anything SimpleFin can't supply. Implies force (bypasses the interval). */
  heal?: boolean;
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

  // Heal is an explicit "Reconcile" click, the persistent Auto-heal setting, or
  // Aggressive auto-heal (which also auto-plugs residual drift). Any of them
  // triggers the wide re-scan on every sync path (scheduler, startup, Sync Now).
  const autoAdjust = await store.getAutoAdjust();
  const heal = opts.heal || autoAdjust || (await store.getAutoHeal());

  // Enforce minimum interval unless the caller forces (Sync anyway) or heals
  const lastSync = await store.getLastSyncAt();
  if (!opts.force && !heal && lastSync && Date.now() - lastSync.getTime() < MIN_SYNC_INTERVAL_MS) {
    return { imported: 0, skipped: 0, errors: [INTERVAL_SKIP_MESSAGE] };
  }

  const accessUrl = await store.getAccessUrl();
  if (!accessUrl) return { imported: 0, skipped: 0, errors: ['Not configured: no access URL'] };

  const mapping = await store.getAccountMapping();
  if (!mapping) return { imported: 0, skipped: 0, errors: ['Not configured: no account mapping'] };

  const rules = await store.getMappingRules();

  // Incremental syncs fetch since the last sync, minus a lookback overlap so
  // transactions that post late with a backdated `posted` date aren't dropped
  // (see SYNC_LOOKBACK_OVERLAP_MS). A forced sync (Sync anyway) re-pulls the
  // full 30-day window — the reason to force is that data is missing, which a
  // since-last-sync window (often minutes wide) would not recover. First sync
  // also uses the full window. The tx-id dedup guard makes the wider re-pull
  // safe (nothing re-imports).
  const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const startDate = heal
    ? new Date(Date.now() - HEAL_WINDOW_MS)
    : opts.force || !lastSync
      ? THIRTY_DAYS_AGO
      : new Date(lastSync.getTime() - SYNC_LOOKBACK_OVERLAP_MS);
  const authKey = await store.getAuthB64Key();
  const accountSet = await fetchAccounts(accessUrl, startDate, ctx.api.network, authKey);

  for (const sfErr of accountSet.errors) {
    // SimpleFin returns informational notices (window-size recommendations and
    // caps) in the same `errors` array. A wide heal re-scan always trips these,
    // and the data still comes back — so they aren't failures. Drop them so
    // only genuine problems (auth, connection) reach the Sync page.
    if (/\b(exceeds|recommended|was capped|date range|will be capped|may be capped)\b/i.test(String(sfErr))) {
      continue;
    }
    errors.push(`SimpleFin: ${sfErr}`);
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
  // Rebuild activity comments (create/update) from the tx id, and recover the
  // signed amount for the starting-balance window delta.
  const descByTxId = new Map<string, string>();
  const signedByTxId = new Map<string, number>();

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;
    // Keep pending rows now (they import and reconcile), dropping only rows we
    // can't date at all — no `posted` and no `transacted_at` — since those
    // would produce a 1970 date the server rejects.
    const transactions = (sfAccount.transactions ?? []).filter(
      (tx) => txEpoch(tx) !== null,
    );
    const prepared: PreparedTx[] = [];
    for (const tx of transactions) {
      const amount = parseFloat(tx.amount);
      const { type, fromRule } = mapTransactionWithSource(
        tx.description, amount, rules, wfTypes.get(wfAccountId),
      );
      prepared.push({ sfAccountId: sfAccount.id, tx, type });
      descByTxId.set(tx.id, tx.description);
      signedByTxId.set(tx.id, amount);
      // Pending transactions are provisional — exclude them from transfer
      // pairing so a not-yet-settled row can't lock in a TRANSFER typing.
      if (tx.pending) continue;
      candidates.push({
        txId: tx.id, accountId: sfAccount.id, posted: txEpoch(tx)!, amount, ruleTyped: fromRule,
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

  // Auto-link transfer pairs: stamp a shared sourceGroupId on both sides so
  // Wealthfolio treats them as an internal transfer. A local ledger (txId → gid)
  // makes this idempotent — a pair whose both sides already carry the same gid
  // is skipped so already-linked pairs produce no per-sync churn. The two sides
  // span two accounts, so groupByTxId is computed once here and applied inside
  // each account's build below. detection.pairs excludes pending rows (they are
  // not transfer candidates), so no pending side is ever linked.
  const ledger = await store.getLinkedGroups();
  let ledgerChanged = false;
  const groupByTxId = new Map<string, string>();
  for (const { outTxId, inTxId } of detection.pairs) {
    const existingGid = ledger[outTxId] ?? ledger[inTxId];
    const alreadyLinked =
      existingGid !== undefined && ledger[outTxId] === existingGid && ledger[inTxId] === existingGid;
    if (alreadyLinked) continue;
    const gid = existingGid ?? crypto.randomUUID();
    groupByTxId.set(outTxId, gid);
    groupByTxId.set(inTxId, gid);
    ledger[outTxId] = gid;
    ledger[inTxId] = gid;
    ledgerChanged = true;
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

  // Per-account SimpleFin balances (+ drift vs Wealthfolio) captured for the
  // Sync page. Persisted at the end of the run so the page shows them instantly.
  const accountBalances: Record<string, AccountBalanceInfo> = {};

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;

    try {
    const preparedAll = preparedByAccount.get(sfAccount.id) ?? [];

    // Build the feed for this account and reconcile it against the rows already
    // imported (matched by SimpleFin tx id, so a changed resolved type updates
    // in place rather than re-importing). A failed read of existing rows is
    // treated as "none" — the planner then creates everything and the host's
    // own dedup remains the backstop.
    const feed: FeedTx[] = preparedAll.map(({ tx, type }) => ({
      txId: tx.id,
      wfAccountId,
      absCents: Math.round(Math.abs(parseFloat(tx.amount)) * 100),
      type,
      date: new Date(txEpoch(tx)! * 1000).toISOString().split('T')[0],
      pending: !!tx.pending,
    }));
    let existing: ExistingRow[] = [];
    try {
      existing = await fetchExistingRows(ctx, wfAccountId);
    } catch {
      // search unavailable — proceed as if no rows exist
    }
    const plan = planReconciliation(feed, existing);

    // Feed rows that produced neither a create nor an update are already
    // imported and unchanged — count them as skipped.
    const createdTxIds = new Set(plan.creates.map((t) => t.txId));
    const updatedToTxIds = new Set(plan.updates.map((u) => u.to.txId));
    skipped += feed.filter(
      (t) => !createdTxIds.has(t.txId) && !updatedToTxIds.has(t.txId),
    ).length;

    // Capture SimpleFin's reported balance for the Sync page, plus drift vs
    // Wealthfolio. Drift is only trustworthy when nothing was imported/updated
    // this run (Wealthfolio recomputes valuations asynchronously, so a fresh
    // import wouldn't be reflected yet); otherwise leave drift null ("in sync").
    const sfBalance = parseFloat(sfAccount.balance);
    const wfValuation = wfBalances?.get(wfAccountId);
    let drift: number | null = null;
    if (wfValuation !== undefined && Number.isFinite(sfBalance)) {
      // Drift compares SimpleFin's POSTED balance to Wealthfolio's valuation.
      // They're only comparable when the account is SETTLED: pending rows are in
      // Wealthfolio's valuation but not in SimpleFin's posted balance, and a run
      // that updates/deletes rows moves the valuation by amounts a create-only
      // delta wouldn't capture. So measure only with no pending anywhere and no
      // updates/deletes this run.
      const noPending = !feed.some((t) => t.pending) && !existing.some((r) => r.pending);
      const createOnly = plan.updates.length === 0 && plan.deleteIds.length === 0;
      // Heal re-scans wide and imports, so it must subtract what it creates
      // (lag-free: WF's balance becomes wfValuation + creates). A normal sync
      // only trusts drift when nothing was created (valuation is otherwise
      // stale), so its windowDelta is 0 by construction.
      if (noPending && createOnly && (heal || plan.creates.length === 0)) {
        const windowDelta = plan.creates.reduce(
          (sum, t) => sum + (signedByTxId.get(t.txId) ?? 0),
          0,
        );
        const d = sfBalance - wfValuation - windowDelta;
        if (Math.abs(d) > DRIFT_THRESHOLD_DOLLARS) drift = Math.round(d * 100) / 100;
        // Aggressive auto-heal: plug the residual immediately — but at most one
        // adjustment per account per day, so a stale valuation on a rapid
        // re-sync (the adjustment isn't recomputed yet) can't stack duplicates.
        if (heal && autoAdjust && drift != null) {
          const alreadyToday = await hasAdjustmentToday(ctx, wfAccountId, sfAccount.id).catch(
            () => false,
          );
          if (!alreadyToday) {
            await importAdjustmentActivity(ctx, {
              sfinAccountId: sfAccount.id,
              wfAccountId,
              currency: sfAccount.currency,
              amount: drift,
            });
            imported += 1;
          }
          drift = null; // healed (or already healed today)
        }
      }
    }
    accountBalances[sfAccount.id] = {
      balance: Number.isFinite(sfBalance) ? sfBalance : null,
      currency: sfAccount.currency,
      date: sfAccount['balance-date'],
      drift,
    };

    // Wealthfolio shows the comment as the cash activity's title and hashes it
    // into its dedup key. Combining the bank description with the SimpleFin tx
    // id gives readable, unique titles; the ` · pending` suffix marks rows that
    // haven't settled so they can be reconciled when they post.
    const cashSymbol = `$CASH-${sfAccount.currency}`;
    const toActivityCreate = (t: FeedTx): ActivityCreate => {
      // Only set sourceGroupId when this tx is part of a (re)linking pair —
      // never emit an empty string for a non-member.
      const gid = groupByTxId.get(t.txId);
      return {
        accountId: t.wfAccountId,
        activityType: t.type,
        activityDate: t.date,
        // The /activities/bulk endpoint deserializes `symbol` as an
        // AssetResolutionInput object (a bare string 422s with
        // "invalid type: string, expected struct AssetResolutionInput").
        // Resolve the reserved cash asset by its $CASH-<currency> symbol.
        symbol: { symbol: cashSymbol },
        amount: t.absCents / 100,
        currency: sfAccount.currency,
        comment: `${descByTxId.get(t.txId) ?? ''} · ${t.txId}${t.pending ? PENDING_SUFFIX : ''}`,
        ...(gid ? { sourceGroupId: gid } : {}),
      };
    };
    const toActivityUpdate = (wfId: string, t: FeedTx): ActivityUpdate => ({
      ...toActivityCreate(t),
      id: wfId,
    });

    // Forced link updates: a pair member that is already imported and otherwise
    // unchanged is neither a create nor a plan update, so it won't carry the
    // gid on its own. Emit an extra update to stamp it. Guard against a txId a
    // create or plan update already covers (those pick up the gid via
    // toActivityCreate above) so we never emit two updates for one txId.
    const forcedLinkUpdates: ActivityUpdate[] = [];
    if (groupByTxId.size > 0) {
      const covered = new Set<string>([...createdTxIds, ...updatedToTxIds]);
      for (const row of existing) {
        const gid = groupByTxId.get(row.txId);
        if (!gid || covered.has(row.txId)) continue;
        forcedLinkUpdates.push({
          id: row.wfId,
          accountId: row.wfAccountId,
          activityType: row.type,
          activityDate: row.date,
          symbol: { symbol: cashSymbol },
          amount: row.absCents / 100,
          currency: sfAccount.currency,
          comment: `${descByTxId.get(row.txId) ?? ''} · ${row.txId}`,
          sourceGroupId: gid,
        });
      }
    }

    if (plan.creates.length || plan.updates.length || plan.deleteIds.length || forcedLinkUpdates.length) {
      const result = await ctx.api.activities.saveMany({
        creates: plan.creates.map(toActivityCreate),
        updates: [...plan.updates.map((u) => toActivityUpdate(u.wfId, u.to)), ...forcedLinkUpdates],
        deleteIds: plan.deleteIds,
      });
      // Only creates are new imports; updates/deletes are reconciliation.
      imported += result.created.length;
      for (const err of result.errors ?? []) {
        errors.push(`Account ${wfAccountId} save error (${err.action}): ${err.message}`);
      }
    }

    // Oldest datable timestamp for the account — used to place the one-time
    // starting-balance entry a day before the earliest transaction.
    const epochs = preparedAll
      .map((p) => txEpoch(p.tx))
      .filter((e): e is number => e !== null);
    const oldestEpoch = epochs.length > 0 ? Math.min(...epochs) : Math.floor(Date.now() / 1000);
    const dayBeforeDate = new Date((oldestEpoch - 24 * 60 * 60) * 1000).toISOString().split('T')[0];

    // One-time starting balance so the account lands on SimpleFin's reported
    // balance instead of just the fetch window's deltas. Runs only when this
    // account's balance is actually readable; the reconciliation-aware
    // windowDelta (counting only about-to-create, non-pending rows) makes this
    // self-cancelling when the Docker companion already corrected the account,
    // so running both syncers stays safe.
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
      const targetBalance = parseFloat(sfAccount.balance);
      // Pending rows are provisional and excluded from the delta — only rows we
      // are actually creating (not reconciling in place) and that have posted
      // move the balance.
      const windowDelta = plan.creates
        .filter((t) => !t.pending)
        .reduce((sum, t) => sum + (signedByTxId.get(t.txId) ?? 0), 0);
      const currentWfBalance = wfBalances!.get(wfAccountId)!;
      const starting = targetBalance - windowDelta - currentWfBalance;
      if (Number.isFinite(starting) && Math.abs(starting) >= 0.01) {
        const correction = {
          accountId: wfAccountId,
          activityType: (starting > 0 ? 'DEPOSIT' : 'WITHDRAWAL') as ActivityType,
          date: dayBeforeDate,
          symbol: `$CASH-${sfAccount.currency}`,
          amount: Math.abs(Math.round(starting * 100) / 100),
          currency: sfAccount.currency,
          sourceSystem: 'simplefin' as const,
          comment: `Starting balance · ${sfAccount.id}`,
          isValid: true,
          isDraft: false,
        };
        await ctx.api.activities.import([correction]);
        imported += 1;
      }
    }

    // Mark done only when the balance was readable for this account, so a
    // skipped correction retries on a later run
    if (canReadBalance) {
      await store.addBalanceInitialized(sfAccount.id);
    } else if (wfBalances !== null && !balanceInitialized.includes(sfAccount.id)) {
      // No valuation row yet (brand-new account) — queue for the same-run
      // second pass below instead of waiting a whole sync cycle
      pendingCorrections.push({
        sfinAccountId: sfAccount.id,
        wfAccountId,
        targetBalance: parseFloat(sfAccount.balance),
        currency: sfAccount.currency,
        date: dayBeforeDate,
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

  // Persist the link ledger once, only when a pair was newly (re)linked this
  // run, so an already-linked steady state performs no secrets write.
  if (ledgerChanged) await store.setLinkedGroups(ledger);

  await store.setAccountBalances(accountBalances);

  await store.setLastSyncAt(new Date());

  return { imported, skipped, errors };
}

/** Import one dated balance-adjustment activity. `amount` is signed
 *  (SimpleFin − Wealthfolio): positive adds a DEPOSIT, negative a WITHDRAWAL.
 *  No-op for a negligible amount. Shared by the manual button and the
 *  aggressive auto-heal path. */
async function importAdjustmentActivity(
  ctx: AddonContext,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number },
): Promise<void> {
  const { sfinAccountId, wfAccountId, currency, amount } = args;
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) return;
  const today = new Date().toISOString().split('T')[0];
  // Built as a variable (not an inline literal) so it matches the same relaxed
  // shape the starting-balance correction uses for activities.import.
  const adjustment = {
    accountId: wfAccountId,
    activityType: (amount > 0 ? 'DEPOSIT' : 'WITHDRAWAL') as ActivityType,
    date: today,
    symbol: `$CASH-${currency}`,
    amount: Math.abs(Math.round(amount * 100) / 100),
    currency,
    sourceSystem: 'simplefin' as const,
    comment: `Balance adjustment · ${sfinAccountId} · ${today}`,
    isValid: true,
    isDraft: false,
  };
  await ctx.api.activities.import([adjustment]);
}

/**
 * Manual "Add adjustment" button: true one account to SimpleFin's balance by
 * importing a one-time balance-adjustment entry for the residual the heal
 * re-scan couldn't recover, then clear its stored drift so the Sync page
 * updates immediately.
 */
export async function applyBalanceAdjustment(
  ctx: AddonContext,
  store: SecretsStore,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number },
): Promise<void> {
  if (!Number.isFinite(args.amount) || Math.abs(args.amount) < 0.01) return;
  await importAdjustmentActivity(ctx, args);
  // Clear the stored drift so the Sync page reflects the fix immediately.
  const balances = await store.getAccountBalances();
  if (balances[args.sfinAccountId]) {
    balances[args.sfinAccountId] = { ...balances[args.sfinAccountId], drift: null };
    await store.setAccountBalances(balances);
  }
}
