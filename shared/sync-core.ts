import { mapTransactionWithSource } from './mapper.js';
import { detectTransferPairs } from './transfers.js';
import type { TransferCandidate } from './transfers.js';
import { planReconciliation, IN_TRANSIT_COMMENT_PREFIX } from './reconcile.js';
import type { FeedTx, ExistingRow } from './reconcile.js';
/** Re-exported from reconcile.ts (which defines it, so `changed()` can recognise
 *  the marker without importing sync-core and creating a cycle). This module owns
 *  WRITING the prefix, so importers keep finding the name here. */
export { IN_TRANSIT_COMMENT_PREFIX };
import type { ActivityType, SimplefinTransaction } from './types.js';
import type { ActivityWrite, ImportRow, LinkLeg, SyncHost, SyncStore } from './sync-host.js';

/**
 * A datable timestamp for a SimpleFin transaction: `posted` when present, else
 * `transacted_at` (pending rows frequently have `posted: 0` until they settle).
 * Rows with neither can't be dated and are dropped from the sync.
 */
export function txEpoch(tx: SimplefinTransaction): number | null {
  if (tx.posted && tx.posted > 0) return tx.posted;
  if (tx.transacted_at && tx.transacted_at > 0) return tx.transacted_at;
  return null;
}

export const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Grep token for the "SimpleFin sent us the same transaction twice" log line.
 *
 * Exported so the log's own tests pin the literal rather than re-typing it: this
 * string is the only instrument we have for finding out whether SimpleFin really
 * does repeat a transaction inside one payload, or whether the duplicate rows
 * seen in production came from two syncers racing each other (tracked as a
 * separate follow-up). A silently renamed token is a silently blinded diagnostic.
 */
export const DUPLICATE_FEED_TX_LOG_TAG = 'duplicate-feed-tx';

/**
 * Which of two feed copies of ONE transaction id survives.
 *
 * They may not be byte-identical, so the choice has to be a rule rather than an
 * accident of iteration order:
 *  1. **A posted copy always beats a pending one.** A pending row is the bank's
 *     provisional guess — its `posted` is frequently 0, its amount can still
 *     move, and importing it writes the ` · pending` suffix that a later run then
 *     has to reconcile away. If the payload already contains the settled version
 *     of the same id, taking the provisional one would be choosing strictly less
 *     information.
 *  2. **Otherwise the LAST occurrence wins.** Where both copies are equally
 *     settled the only difference that matters is a restatement (SimpleFin
 *     re-reporting an amount or a date), and a feed lists a transaction's newest
 *     word last. It is also the tie-break `Map#set`-style overwriting would give,
 *     so nothing surprising happens in the (overwhelmingly common) case where the
 *     two copies are identical.
 *
 * Either way the survivor is reconciled against the account's stored row in the
 * same pass, so picking the copy that turns out to be stale self-corrects on the
 * next sync rather than sticking.
 */
function preferFeedCopy(
  kept: SimplefinTransaction,
  next: SimplefinTransaction,
): SimplefinTransaction {
  if (!!kept.pending !== !!next.pending) return kept.pending ? next : kept;
  return next;
}

/**
 * Collapse one account's transaction list to a single entry per SimpleFin
 * transaction id, in feed order.
 *
 * WHY. `runSyncCore` plans creates by iterating this list against the rows the
 * account already holds (matched by tx id). Two copies of one id both match
 * "nothing stored yet", so both are planned as creates and both land in the SAME
 * `saveMany` batch — and Wealthfolio's duplicate guard, which does reject a
 * colliding create across requests with a 400, cannot compare two rows inside one
 * request against each other. The result is exactly what production showed on
 * 2026-07-27: two activities sharing one transaction id, reading a savings account
 * $1,297.50 low.
 *
 * PER ACCOUNT, NEVER GLOBALLY. One transaction id legitimately appears in two
 * different accounts — the two halves of an internal transfer (confirmed live:
 * `TRN-41fee96e` is the TRANSFER_OUT in one account and the TRANSFER_IN in
 * another). A global dedup would delete one half of every such pair, which is a
 * strictly worse bug than the one being fixed. Hence the `sfAccountId` argument:
 * it is only here to be logged, but its presence in the signature is the reminder
 * that a caller has to hold one account at a time.
 */
export function dedupeAccountTransactions(
  sfAccountId: string,
  transactions: SimplefinTransaction[],
): SimplefinTransaction[] {
  const byId = new Map<string, SimplefinTransaction>();
  // Ids in first-seen order, so the surviving list keeps the feed's ordering even
  // when a later copy replaces an earlier one.
  const order: string[] = [];
  for (const tx of transactions) {
    const prior = byId.get(tx.id);
    if (!prior) {
      byId.set(tx.id, tx);
      order.push(tx.id);
      continue;
    }
    const kept = preferFeedCopy(prior, tx);
    const dropped = kept === prior ? tx : prior;
    byId.set(tx.id, kept);
    const describe = (t: SimplefinTransaction) => ({
      amount: t.amount,
      pending: !!t.pending,
      posted: t.posted ?? null,
      transacted_at: t.transacted_at ?? null,
    });
    console.warn(
      `[simplefin-sync] ${DUPLICATE_FEED_TX_LOG_TAG}: SimpleFin returned transaction ${tx.id} more than once for account ${sfAccountId} — dropping the extra copy`,
      { txId: tx.id, sfAccountId, kept: describe(kept), dropped: describe(dropped) },
    );
  }
  return order.map((id) => byId.get(id)!);
}

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

/**
 * Drift an account must exceed before the user is NOTIFIED about it, when they
 * have not configured a threshold of their own.
 *
 * Emphatically not DRIFT_THRESHOLD_DOLLARS. That one is a display threshold —
 * "is this worth a line on the Sync page" — and at $1 it is tripped by ordinary
 * rounding and by any account the user is mid-way through reconciling. A
 * notification has a much higher bar: it should mean "something is actually
 * wrong with this account", which in this codebase's own history has meant
 * four-figure sums.
 */
export const DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS = 100;

/** Heal ("Reconcile balances") re-scans this far back — wider than a normal
 *  force sync — to recover transactions that a broken earlier sync missed.
 *  Just under SimpleFin's 90-day maximum: requesting exactly 90 days trips a
 *  "date range exceeds limit and was capped" notice by the time the request
 *  lands, so we stay a day inside it. */
export const HEAL_WINDOW_MS = 89 * 24 * 60 * 60 * 1000; // ~90 days, under SimpleFin's cap

/** Recurring auto-heal uses a narrower window than the one-off manual re-scan:
 *  SimpleFin recommends ≤45 days and warns wide requests may be capped, so a
 *  sync that runs every few hours stays inside that. Drift measurement and the
 *  auto-plug work on any window — only the one-time "recover old history" job
 *  needs the full 89-day reach, and that's the manual button. */
export const AUTO_HEAL_WINDOW_MS = 44 * 24 * 60 * 60 * 1000; // under SimpleFin's 45-day recommendation

/** How long a transfer-typed transaction may sit without a detected pair
 *  before we give up waiting and let it count as ordinary spending — wider
 *  than TRANSFER_MATCH_WINDOW_SECONDS (5 days) so it never fires while a
 *  normal pairing is still plausible. */
export const IN_TRANSIT_TIMEOUT_SECONDS = 10 * 24 * 60 * 60; // 10 days

/** Consecutive failed linkPair attempts on the same pair before we alert —
 *  roughly 3 sync cycles (≈18h at the default 6h SYNC_SCHEDULE). */
export const STUCK_TRANSFER_ALERT_THRESHOLD = 3;

/** Polling for freshly computed valuations after a first import (see the
 *  second-pass block in runSyncCore). Exported so tests can shrink the delay. */
export const VALUATION_POLL = { attempts: 6, delayMs: 2500 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Activity types that count as SPENDING for the large-transaction alert.
 *
 * Deliberately the same set the companion's spending query uses
 * (`getNativeWealthfolioSpendingBetween`: `WITHDRAWAL`, `FEE`, `TAX`), so "large
 * transaction" means the same thing as "large line on the Spending page". Every
 * omission is load-bearing rather than incidental:
 *  - `DEPOSIT` / `CREDIT` — money arriving. A big payday is not alarming, and
 *    `CREDIT` is the type `neutralAdjustmentFields` picks precisely BECAUSE
 *    Wealthfolio classifies it as Ignored (neither spending nor income), so it
 *    is also what every balance plug and CASH in-transit placeholder looks like.
 *    Alerting on it would ping the user about the sync's own bookkeeping.
 *  - `TRANSFER_IN` / `TRANSFER_OUT` — moving your own money between accounts,
 *    which the spending query excludes and Wealthfolio nets out once linked.
 *  - `ADJUSTMENT` / `UNKNOWN` and the investment types — not cash spending.
 *
 * `FEE`/`TAX` are only reachable through a user mapping rule (`mapper.ts` never
 * infers them), but a $2,000 wire fee is exactly the sort of thing this alert
 * exists for, so they are in.
 */
const SPENDING_TYPES = new Set<string>(['WITHDRAWAL', 'FEE', 'TAX']);

export interface SyncResult {
  imported: number;
  skipped: number;
  errors: string[];
  stuckTransferAlerts: Array<{ outTxId: string; description: string; amountCents: number; currency: string }>;
  /** Newly-created spending rows over the user's configured dollar threshold,
   *  for the caller to announce. Always empty when no threshold is set. */
  largeTransactionAlerts: Array<{
    txId: string;
    description: string;
    amountCents: number;
    currency: string;
    /** The Wealthfolio account the row landed in, by name (falling back to the
     *  SimpleFin account name on a host that reports no name). */
    accountName: string;
  }>;
  /** Accounts that opened a new drift episode this run — a TRUSTWORTHY drift
   *  measurement past the alert threshold that the user has not been told about
   *  yet. One entry per episode, not per sync. */
  balanceDriftAlerts: Array<{
    /** Key into the persisted drift-alert ledger, so a failed send can be rolled
     *  back to un-alerted (see the companion). */
    sfinAccountId: string;
    accountName: string;
    /** Signed: bank balance − Wealthfolio valuation, in dollars. */
    driftAmount: number;
    currency: string;
    /** What the bank says the account holds, so the message is actionable
     *  rather than merely alarming. */
    bankBalance: number;
  }>;
}

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

/** Per-account balance snapshot captured on each sync, for the Sync page.
 *  Structurally identical to the addon's stored AccountBalanceInfo. */
interface AccountBalanceSnapshot {
  balance: number | null;
  currency: string;
  date: number;
  drift: number | null;
}

/**
 * How many of an account's oldest rows the starting-balance lookups scan. The
 * marker is dated a day before the account's earliest imported transaction, so
 * it is always within the first handful of rows — a small ascending window
 * finds it on an account of any size, where the recent-first page would not.
 */
const STARTING_BALANCE_SCAN = 50;

/**
 * Shared-truth guard: asks Wealthfolio whether a starting-balance entry for
 * this SimpleFin account already exists (created by any syncer). Entries are
 * dated before the account's oldest imported transaction, so sorting by date
 * ascending puts them in the first rows.
 */
async function hasExistingStartingBalance(
  host: SyncHost,
  wfAccountId: string,
  sfinAccountId: string,
): Promise<boolean> {
  const rows = await host.listOldestActivities(wfAccountId, STARTING_BALANCE_SCAN);
  const marker = `Starting balance · ${sfinAccountId}`;
  return rows.some((a) => (a.comment ?? '') === marker);
}

/**
 * The account's starting-balance entry, if one exists, as a signed amount.
 *
 * The entry is a one-time baseline meaning "everything before this date is
 * already reflected in the bank's balance". It's calculated from the first
 * sync's window, so any transaction later imported with an EARLIER date (a wide
 * re-scan reaching further back) would be counted twice — once in the baseline
 * and again as its own activity. `adjustStartingBalanceForOlderRows` corrects
 * the baseline when that happens; this reads the row it has to correct.
 */
async function fetchStartingBalance(
  host: SyncHost,
  wfAccountId: string,
  sfinAccountId: string,
): Promise<{ id: string; date: string; signed: number } | null> {
  const rows = await host.listOldestActivities(wfAccountId, STARTING_BALANCE_SCAN);
  const marker = `Starting balance · ${sfinAccountId}`;
  const row = rows.find((a) => (a.comment ?? '') === marker);
  if (!row) return null;
  const abs = Math.abs(parseFloat(String(row.amount ?? '0')));
  return {
    id: row.id,
    date: new Date(row.date).toISOString().slice(0, 10),
    signed: String(row.activityType) === 'WITHDRAWAL' ? -abs : abs,
  };
}

/**
 * Keep the starting-balance baseline honest when a run imports transactions
 * dated BEFORE it. Those rows are already baked into the baseline, so leaving it
 * alone double-counts them (the classic symptom: an account drifts by exactly
 * the sum of the newly-recovered history). Subtracting their signed total from
 * the baseline nets them out, so the balance stays correct no matter how far
 * back a later re-scan reaches.
 */
async function adjustStartingBalanceForOlderRows(
  host: SyncHost,
  args: {
    wfAccountId: string;
    sfinAccountId: string;
    currency: string;
    /** Signed amounts of the rows just created, keyed by date (YYYY-MM-DD). */
    created: Array<{ date: string; signed: number }>;
  },
): Promise<number> {
  const { wfAccountId, sfinAccountId, currency, created } = args;
  const sb = await fetchStartingBalance(host, wfAccountId, sfinAccountId);
  if (!sb) return 0;
  const olderSum = created
    .filter((c) => c.date < sb.date)
    .reduce((sum, c) => sum + c.signed, 0);
  if (!Number.isFinite(olderSum) || Math.abs(olderSum) < 0.01) return 0;
  const nextSigned = Math.round((sb.signed - olderSum) * 100) / 100;
  await host.saveMany({
    updates: [{
      id: sb.id,
      accountId: wfAccountId,
      activityType: nextSigned >= 0 ? 'DEPOSIT' : 'WITHDRAWAL',
      activityDate: sb.date,
      symbol: { symbol: `$CASH-${currency}` },
      amount: Math.abs(nextSigned),
      currency,
      comment: `Starting balance · ${sfinAccountId}`,
    }],
  });
  return olderSum;
}

/**
 * Whether a balance-adjustment entry was already inserted for this account today
 * — the once-a-day guard that stops aggressive auto-heal from stacking a second
 * adjustment on a rapid re-sync before Wealthfolio has recomputed valuations.
 */
async function hasAdjustmentToday(
  host: SyncHost,
  wfAccountId: string,
  sfinAccountId: string,
): Promise<boolean> {
  const rows = await host.listActivities(wfAccountId);
  const marker = `Balance adjustment · ${sfinAccountId} · ${new Date().toISOString().split('T')[0]}`;
  return rows.some((a) => (a.comment ?? '') === marker);
}

export const PENDING_SUFFIX = ' · pending';

/**
 * Wealthfolio only treats a transfer group as a genuine *internal* transfer when
 * both legs carry an internal-transfer marker (`activity_has_internal_transfer_marker`
 * in `activities_service.rs`): either `metadata.flow.is_external === false`, or
 * `metadata.transfer.source === "wealthfolio"`, or a group id starting with
 * `wf-transfer-`. A shared `sourceGroupId` alone is NOT enough. We set the
 * prefix and the metadata marker so the pair validates on every path.
 */
export const TRANSFER_GROUP_PREFIX = 'wf-transfer-';
/** Mint a group id a host can stamp on both legs of a pair. The prefix is itself
 *  one of the internal-transfer markers, so it does double duty. */
export const newTransferGroupId = () => `${TRANSFER_GROUP_PREFIX}${crypto.randomUUID()}`;
/** Serialized, NOT an object: the server's `metadata` is `Option<String>` (a JSON
 *  blob), so an object 422s. Mirrors what Wealthfolio itself stores —
 *  `json!({ "flow": { "is_external": … } }).to_string()`. */
export const INTERNAL_TRANSFER_METADATA = JSON.stringify({ flow: { is_external: false } });

const TRANSFER_TYPES = new Set<string>(['TRANSFER_IN', 'TRANSFER_OUT']);

/**
 * Cash-transfer legs must be sent with NO asset/symbol at all.
 *
 * `$CASH-<ccy>` resolves to real cash for DEPOSIT/WITHDRAWAL/CREDIT, but for
 * TRANSFER_IN/TRANSFER_OUT the bulk endpoint instead creates a literal security
 * named "$CASH" (upstream issue #5). That breaks two things at once:
 *   • the holdings calculator only books cash when `asset_id` is EMPTY
 *     (`handlers/transfers.rs`), so a security-backed leg never moves the balance;
 *   • `validate_asset_shape` (`transfer_pairs.rs`) then treats the pair as a
 *     *security* transfer and rejects it unless both legs carry a quantity —
 *     which is why such pairs can't be linked, even by Wealthfolio's own linker.
 * Omitting the symbol leaves `asset_id = None`, which takes the cash branch in
 * both places: the balance moves by `amount`, and the pair validates as cash.
 */
export const isTransferType = (type: string) => TRANSFER_TYPES.has(type);

/** Recover the SimpleFin tx id an activity comment/notes ends with — the
 *  `… · <txId>` suffix (optionally followed by ` · pending`). Returns null when
 *  the text doesn't carry one (e.g. a balance-adjustment or non-synced row). */
export function txIdFromComment(text: string | null | undefined): string | null {
  let c = text ?? '';
  if (c.endsWith(PENDING_SUFFIX)) c = c.slice(0, -PENDING_SUFFIX.length);
  const sep = c.lastIndexOf(' · ');
  return sep === -1 ? null : c.slice(sep + 3);
}

/**
 * The human half of a stored comment/note: the bank's description, with every
 * bookkeeping decoration this module writes taken back off — the exact inverse of
 * `txIdFromComment`, which reads the id from the other side of the same
 * separator.
 *
 * Needed because a stored note is never display-ready. Every synced activity's
 * note is `<bank description> · <SimpleFin tx id>`, optionally with
 * ` · pending`, and an in-transit placeholder additionally carries
 * `IN_TRANSIT_COMMENT_PREFIX` in front. Rendering that raw shows a reader
 * `WHOLEFOODS #123 · TRN-a1b2c3d4-…`, which is ugly and leaks an internal id.
 *
 * `lastIndexOf`, matching `txIdFromComment` — and the side matters: everything
 * BEFORE the final separator is the description, so a description that itself
 * contains ` · ` (`COSTCO GAS · PUMP 4 · TRN-x`) survives intact and only the
 * trailing id field is dropped. Splitting on the FIRST separator instead would
 * truncate the merchant AND disagree with `txIdFromComment` about where the id
 * begins.
 *
 * A note carrying no separator at all (a hand-entered Wealthfolio activity) has
 * no id to strip and is returned as-is. A blank result is legitimate — the
 * SimpleFin description can be empty, leaving nothing but the id — so callers
 * must be able to render a row without one rather than printing an empty field.
 */
export function descriptionFromComment(text: string | null | undefined): string {
  let c = text ?? '';
  // Prefix first: it ENDS with ' · ', so leaving it on would be harmless here
  // (lastIndexOf looks at the other end) but only by luck.
  if (c.startsWith(IN_TRANSIT_COMMENT_PREFIX)) c = c.slice(IN_TRANSIT_COMMENT_PREFIX.length);
  if (c.endsWith(PENDING_SUFFIX)) c = c.slice(0, -PENDING_SUFFIX.length);
  const sep = c.lastIndexOf(' · ');
  return (sep === -1 ? c : c.slice(0, sep)).trim();
}

/** An existing row plus the two things linking needs that reconciliation
 *  doesn't: the account's currency, and whatever group the host says the row is
 *  already in (only meaningful when `capabilities.readsSourceGroupId`). */
type LinkableRow = ExistingRow & { currency: string; sourceGroupId?: string | null };

/**
 * Reads the existing SimpleFin-sourced activities for an account into
 * `ExistingRow`s the reconciliation planner can match against. Every imported
 * activity carries its SimpleFin tx id at the end of the comment, optionally
 * followed by a ` · pending` marker — parse both back out so a row can be
 * matched by identity (independent of type) and recognised as still-pending.
 *
 * `sourceGroupId` rides along verbatim for the link step; on a host whose
 * `readsSourceGroupId` capability is false it is meaningless (always null) and
 * the ledger stands in for it.
 */
async function fetchExistingRows(
  host: SyncHost,
  wfAccountId: string,
): Promise<Array<ExistingRow & { sourceGroupId?: string | null }>> {
  const data = await host.listActivities(wfAccountId);
  const rows: Array<ExistingRow & { sourceGroupId?: string | null }> = [];
  for (const a of data) {
    const pending = (a.comment ?? '').endsWith(PENDING_SUFFIX);
    const txId = txIdFromComment(a.comment);
    if (txId === null) continue;
    rows.push({
      wfId: a.id,
      wfAccountId,
      txId,
      absCents: Math.round(Math.abs(parseFloat(String(a.amount ?? '0'))) * 100),
      type: String(a.activityType),
      date: new Date(a.date).toISOString().slice(0, 10),
      pending,
      assetId: a.assetId ? String(a.assetId) : undefined,
      comment: a.comment ?? undefined,
      sourceGroupId: a.sourceGroupId ?? null,
    });
  }
  return rows;
}

/**
 * Wealthfolio classifies spending/income by activity type + account type, with
 * no per-activity budget-exclusion field reachable from the addon SDK. On a
 * CASH account, DEPOSIT counts as Income and WITHDRAWAL as Expense — so a
 * plain balance-adjustment plug would pollute the Spending page. A CREDIT
 * with no subtype classifies as Ignored there (neither spending nor income)
 * while still moving cash by `amount − fee − tax`, so it doubles as a
 * spending-neutral plug in both directions: `amount` to add cash, `fee` to
 * remove it. CREDIT_CARD/SECURITIES/CRYPTOCURRENCY don't have this problem
 * (DEPOSIT is already Ignored on a card, and every type is Ignored on
 * investment-style accounts), so they keep the simpler DEPOSIT/WITHDRAWAL
 * shape unchanged.
 */
export function neutralAdjustmentFields(
  accountType: string,
  signedAmount: number,
): { activityType: ActivityType; amount: number; fee: number } {
  const mag = Math.abs(Math.round(signedAmount * 100) / 100);
  if (accountType === 'CASH') {
    return signedAmount > 0
      ? { activityType: 'CREDIT' as ActivityType, amount: mag, fee: 0 }
      : { activityType: 'CREDIT' as ActivityType, amount: 0, fee: mag };
  }
  return {
    activityType: (signedAmount > 0 ? 'DEPOSIT' : 'WITHDRAWAL') as ActivityType,
    amount: mag,
    fee: 0,
  };
}

/** Import one dated balance-adjustment activity. `amount` is signed
 *  (SimpleFin − Wealthfolio). On CASH accounts this is a spending-neutral
 *  CREDIT (see neutralAdjustmentFields); elsewhere a DEPOSIT/WITHDRAWAL.
 *  No-op for a negligible amount. Shared by the manual button and the
 *  aggressive auto-heal path. */
export async function importAdjustmentActivity(
  host: SyncHost,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number },
): Promise<void> {
  const { sfinAccountId, wfAccountId, currency, amount } = args;
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) return;
  const today = new Date().toISOString().split('T')[0];
  const wfAccounts = await host.listAccounts().catch(() => []);
  const accountType = String(
    wfAccounts.find((a) => a.id === wfAccountId)?.accountType ?? '',
  );
  const { activityType, amount: fieldAmount, fee } = neutralAdjustmentFields(accountType, amount);
  // Built as a variable (not an inline literal) so it matches the same relaxed
  // shape the starting-balance correction uses for the import endpoint.
  const adjustment: ImportRow = {
    accountId: wfAccountId,
    sourceSystem: 'simplefin',
    activityType,
    date: today,
    symbol: `$CASH-${currency}`,
    amount: fieldAmount,
    fee,
    currency,
    comment: `Balance adjustment · ${sfinAccountId} · ${today}`,
    isValid: true,
    isDraft: false,
  };
  try {
    await host.importActivities([adjustment]);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!msg.toLowerCase().includes('duplicate')) {
      throw e;
    }
  }
}

/**
 * The host-agnostic sync run: fetch SimpleFin, reconcile every mapped account
 * against what the host already stores, import the difference, keep the
 * starting-balance baseline honest, and record per-account balances/drift.
 *
 * Everything it touches goes through `host` (Wealthfolio SDK or REST companion)
 * and `store` (persisted config/state), so the same code drives both syncers.
 */
export async function runSyncCore(
  host: SyncHost,
  store: SyncStore,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const errors: string[] = [];
  const autoAdjust = await store.getAutoAdjust();
  const heal = opts.heal || autoAdjust || (await store.getAutoHeal());
  console.log('[simplefin-sync] starting sync core', { heal, force: !!opts.force, autoAdjust });

  // Enforce minimum interval unless the caller forces (Sync anyway) or heals
  const lastSync = await store.getLastSyncAt();
  if (!opts.force && !heal && lastSync && Date.now() - lastSync.getTime() < MIN_SYNC_INTERVAL_MS) {
    return { imported: 0, skipped: 0, errors: [INTERVAL_SKIP_MESSAGE], stuckTransferAlerts: [], largeTransactionAlerts: [], balanceDriftAlerts: [] };
  }

  const accessUrl = await store.getAccessUrl();
  if (!accessUrl) {
    return { imported: 0, skipped: 0, errors: ['Not configured: no access URL'], stuckTransferAlerts: [], largeTransactionAlerts: [], balanceDriftAlerts: [] };
  }

  const mapping = await store.getAccountMapping();
  if (!mapping) {
    return { imported: 0, skipped: 0, errors: ['Not configured: no account mapping'], stuckTransferAlerts: [], largeTransactionAlerts: [], balanceDriftAlerts: [] };
  }

  const rules = await store.getMappingRules();

  // Incremental syncs fetch since the last sync, minus a lookback overlap so
  // transactions that post late with a backdated `posted` date aren't dropped
  // (see SYNC_LOOKBACK_OVERLAP_MS). A forced sync (Sync anyway) re-pulls the
  // full 30-day window — the reason to force is that data is missing, which a
  // since-last-sync window (often minutes wide) would not recover. First sync
  // also uses the full window. The tx-id dedup guard makes the wider re-pull
  // safe (nothing re-imports).
  const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const startDate = opts.heal
    ? new Date(Date.now() - HEAL_WINDOW_MS) // manual "Re-scan 90 days": full reach, occasional
    : heal
      ? new Date(Date.now() - AUTO_HEAL_WINDOW_MS) // recurring auto-heal: stay within SimpleFin's recommendation
      : opts.force || !lastSync
        ? THIRTY_DAYS_AGO
        : new Date(lastSync.getTime() - SYNC_LOOKBACK_OVERLAP_MS);
  const authKey = await store.getAuthB64Key();
  const accountSet = await host.fetchSimplefin(accessUrl, startDate, authKey);

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
  const wfAccounts = await host.listAccounts().catch(() => []);
  const wfTypes = new Map<string, string>(
    wfAccounts.map((a): [string, string] => [a.id, String(a.accountType ?? '')]),
  );
  // Names, for the alerts: `name` is optional on the SyncHost contract, so an
  // empty one falls back to the SimpleFin account name at the use site.
  const wfNames = new Map<string, string>(
    wfAccounts.map((a): [string, string] => [a.id, String(a.name ?? '')]),
  );

  // Large-transaction alerting. Absent, zero or negative means off — and off
  // means no work at all, not "collect then discard": the threshold is read once
  // here and every later step is guarded by it.
  const configuredLargeTxThreshold = await store.getLargeTransactionThreshold();
  const largeTxThresholdCents =
    configuredLargeTxThreshold != null && configuredLargeTxThreshold > 0
      ? Math.round(configuredLargeTxThreshold * 100)
      : 0;
  const largeTransactionAlerts: SyncResult['largeTransactionAlerts'] = [];

  // Balance-drift alerting. Absent falls back to the $100 default; an explicit
  // 0 or negative is the user turning it off, which is why the adapters report
  // the stored value verbatim instead of normalising it.
  const configuredDriftThreshold = await store.getDriftAlertThreshold();
  const driftAlertThreshold = configuredDriftThreshold ?? DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS;
  const driftAlertThresholdCents =
    driftAlertThreshold > 0 ? Math.round(driftAlertThreshold * 100) : 0;
  const driftAlerts = await store.getDriftAlerts();
  let driftAlertsChanged = false;
  const balanceDriftAlerts: SyncResult['balanceDriftAlerts'] = [];

  // Current Wealthfolio balances for the one-time starting-balance
  // correction. They come from the valuations API — listAccounts() has no
  // balance data behind it, and treating that absence as 0 once created
  // full-balance duplicate corrections. A failed fetch or a missing
  // per-account entry skips the correction (and leaves the account
  // un-initialized so a later run retries) rather than guessing 0.
  let wfBalances: Map<string, number> | null = null;
  try {
    const mappedWfIds = [...new Set(Object.values(mapping))];
    wfBalances = mappedWfIds.length > 0
      ? await host.latestValuations(mappedWfIds)
      : new Map<string, number>();
  } catch {
    errors.push('Could not read account balances — starting-balance checks skipped this run');
  }

  // Phase A: resolve activity types for every transaction across all mapped
  // accounts, so transfer pairs can be detected across account boundaries
  interface PreparedTx {
    sfAccountId: string;
    tx: SimplefinTransaction;
    type: ActivityType;
    /** Cents to book as `fee` rather than `amount` — set only for an in-transit
     *  placeholder, from the same neutralAdjustmentFields split balance plugs use. */
    feeCents?: number;
    /** Spending-neutral placeholder standing in for a transfer leg whose other
     *  side hasn't posted yet (drives the comment prefix). */
    inTransit?: boolean;
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
    //
    // Then collapse repeated transaction ids, BEFORE anything is planned from the
    // list: two copies of one id would otherwise both plan a create and both land
    // in one saveMany batch, which is the only way past Wealthfolio's duplicate
    // guard (see dedupeAccountTransactions). Per account — the same id is a
    // legitimate sight in two accounts, as the two legs of one transfer.
    const transactions = dedupeAccountTransactions(
      sfAccount.id,
      (sfAccount.transactions ?? []).filter((tx) => txEpoch(tx) !== null),
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

  // A transfer-typed transaction with no detected pair yet is either still in
  // transit (the other leg hasn't posted) or was never going to pair (a
  // transfer-shaped description to an untracked external account). Either way a
  // BARE transfer leg is the worst outcome: Wealthfolio only excludes a transfer
  // from spending once both legs are LINKED, and a solo leg can never be linked,
  // so it lands as spending. Import it as a spending-neutral placeholder while
  // waiting; past the timeout give up and let it count as ordinary spending.
  //
  // The placeholder's shape comes wholly from neutralAdjustmentFields, per
  // account type — CREDIT with the amount/fee split on CASH (the only place a
  // subtype-less CREDIT is established as "Ignored by the spending classifier
  // while still moving cash"), and the plain DEPOSIT/WITHDRAWAL that is already
  // Ignored on a CREDIT_CARD or investment-style account. A card genuinely
  // reaches here: mapper types a positive, payment-shaped card amount TRANSFER_IN.
  const pairedTxIds = new Set<string>();
  for (const pair of detection.pairs) {
    pairedTxIds.add(pair.outTxId);
    pairedTxIds.add(pair.inTxId);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  for (const prepared of preparedByAccount.values()) {
    for (const p of prepared) {
      if (!isTransferType(p.type) || pairedTxIds.has(p.tx.id)) continue;
      const signed = signedByTxId.get(p.tx.id) ?? 0;
      const postedAt = txEpoch(p.tx) ?? nowSec;
      if (nowSec - postedAt > IN_TRANSIT_TIMEOUT_SECONDS) {
        p.type = (signed >= 0 ? 'DEPOSIT' : 'WITHDRAWAL') as ActivityType;
        continue;
      }
      const accountType = wfTypes.get(mapping[p.sfAccountId] ?? '') ?? '';
      const { activityType, fee } = neutralAdjustmentFields(accountType, signed);
      p.type = activityType;
      p.feeCents = Math.round(fee * 100);
      p.inTransit = true;
    }
  }

  // Auto-link transfer pairs: hand both sides to `host.linkPair`, which records
  // them as one internal transfer however that host can (the addon deletes and
  // re-creates both legs under a shared marked group; the companion has a link
  // endpoint). detection.pairs excludes pending rows (they are not transfer
  // candidates), so no pending side is ever linked.
  //
  // "Already linked?" is answered one of two ways, by capability:
  //
  //  • readsSourceGroupId — the host hands back a trustworthy sourceGroupId on
  //    every row, so the rows themselves are the answer and no local bookkeeping
  //    is needed (or wanted: a second ledger could only ever go stale).
  //  • otherwise (the addon) — ActivityDetails doesn't expose sourceGroupId, so
  //    a local ledger (txId → gid) stands in. It is only WRITTEN once linkPair
  //    reports the link actually landed — never optimistically, which would let
  //    a failed/partial save get permanently (and wrongly) marked "linked", with
  //    no retry.
  const readsGroups = host.capabilities.readsSourceGroupId;
  const ledger: Record<string, string> = readsGroups ? {} : await store.getLinkedGroups();
  let ledgerChanged = false;
  // txIds whose pair the ledger already vouches for. Empty (and unused) when the
  // host can read groups back off the rows.
  const ledgerLinkedTxIds = new Set<string>();
  if (!readsGroups) {
    // One-time migration: entries whose gid predates TRANSFER_GROUP_PREFIX were
    // written optimistically (before the ledger was reconciled against what
    // Wealthfolio actually stored), so they may claim a link that never landed.
    // Drop them so those pairs get re-attempted exactly once; every gid written
    // from here on is echo-confirmed and therefore trustworthy.
    for (const [txId, gid] of Object.entries(ledger)) {
      if (!String(gid).startsWith(TRANSFER_GROUP_PREFIX)) {
        delete ledger[txId];
        ledgerChanged = true;
      }
    }
    for (const { outTxId, inTxId } of detection.pairs) {
      const existingGid = ledger[outTxId] ?? ledger[inTxId];
      // Confirmed-linked pairs (both legs on the same gid, adopted from a
      // previous run's report) are skipped — no churn, on a sync or a heal.
      if (existingGid !== undefined && ledger[outTxId] === existingGid && ledger[inTxId] === existingGid) {
        ledgerLinkedTxIds.add(outTxId);
        ledgerLinkedTxIds.add(inTxId);
      }
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

  // Per-account SimpleFin balances (+ drift vs Wealthfolio) captured for the
  // Sync page. Persisted at the end of the run so the page shows them instantly.
  const accountBalances: Record<string, AccountBalanceSnapshot> = {};

  // Every already-imported row across all accounts, keyed by SimpleFin tx id.
  // Used by the transfer-link step AFTER the loop: both legs of a pair live in
  // different accounts, so a pair can only be assembled once every account has
  // been read (and the host needs both legs at once — Wealthfolio only forms a
  // transfer group when it sees them together).
  const linkRowByTxId = new Map<string, LinkableRow>();

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
    const feed: FeedTx[] = preparedAll.map(({ tx, type, feeCents, inTransit }) => ({
      txId: tx.id,
      wfAccountId,
      absCents: Math.round(Math.abs(parseFloat(tx.amount)) * 100),
      type,
      date: new Date(txEpoch(tx)! * 1000).toISOString().split('T')[0],
      pending: !!tx.pending,
      ...(feeCents ? { feeCents } : {}),
      ...(inTransit ? { inTransit: true } : {}),
    }));
    // Typed to match what fetchExistingRows returns: these rows feed
    // `linkRowByTxId`, and the link step after the loop reads `sourceGroupId` off
    // them, so it must survive into this variable.
    let existing: Array<ExistingRow & { sourceGroupId?: string | null }> = [];
    try {
      existing = await fetchExistingRows(host, wfAccountId);
    } catch {
      // read unavailable — proceed as if no rows exist
    }
    for (const row of existing) linkRowByTxId.set(row.txId, { ...row, currency: sfAccount.currency });
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
    // The same figure as `drift`, but WITHOUT the display threshold and without
    // the "healed, so stop showing it" reset — i.e. the drift the alert may be
    // believed off. Two separate variables because `drift` conflates three
    // different states into `null`: not measurable, measurable and under $1
    // (genuinely in sync), and plugged this run. The alert has to tell them
    // apart: "in sync" must CLEAR the episode and re-arm, while "not measurable"
    // must leave it alone — clearing there would re-arm on a run that proved
    // nothing, and the next measurable run would alert all over again.
    let measuredDrift: number | null = null;
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
        // Which TRANSFER_OUT legs never moved cash, and so must be netted out of
        // the valuation or they read as drift? The answer is decided by the leg's
        // ASSET, not by whether it is linked: handlers/transfers.rs's
        // handle_transfer_out books cash on the `if asset_id.is_empty()` branch
        // only (`add_cash(state, currency, amount − fee − tax)`), and takes the
        // non-cash branch otherwise — see companion/upstream-pr.md, issue #5
        // ("WORKAROUND FOUND"), which is source-verified against upstream.
        //
        // So:
        //  • asset-free leg — booked its cash the moment it was written, linked
        //    or not. Subtracting it double-counts money already gone.
        //  • leg carrying an asset (typically the mis-resolved literal `$CASH`
        //    security, which is_cash_symbol() does NOT treat as cash) — booked
        //    nothing, so it genuinely needs compensating.
        //
        // Linking governs how Wealthfolio CLASSIFIES the pair (internal transfer
        // vs. spending), never the balance — which is why no capability check,
        // sourceGroupId, or ledger lookup belongs in this predicate. This is the
        // same property the relink sweep below keys on (`!row.assetId → skip`),
        // so the two now agree about what a broken leg is.
        //
        // LEGACY-ONLY, deliberately kept: since in-transit placeholders landed,
        // an unpaired leg is imported as a spending-neutral CREDIT/DEPOSIT, never
        // as a bare TRANSFER_OUT, and the relink sweep deletes and re-creates
        // asset-carrying legs asset-free — so no NEW data reaches this
        // subtraction. It still fires for rows written before those changes,
        // which exist in production. Do not remove the block.
        const assetBackedTransferOut = existing
          .filter((r) => r.type === 'TRANSFER_OUT' && !!r.assetId)
          .reduce((sum, r) => sum + Math.abs(r.absCents) / 100, 0);

        const adjustedWfValuation = wfValuation - assetBackedTransferOut;
        const d = sfBalance - adjustedWfValuation - windowDelta;
        // Settled, transfer-aware and lag-free — this is the only figure in the
        // run the drift alert is allowed to believe.
        measuredDrift = Math.round(d * 100) / 100;
        if (Math.abs(d) > DRIFT_THRESHOLD_DOLLARS) drift = Math.round(d * 100) / 100;
        console.log(`[simplefin-sync] ${sfAccount.name} (${sfAccount.id}):`, {
          sfBalance,
          wfValuation,
          // Logged because it is subtracted from the valuation: without it the
          // reported drift can't be reconciled against the two balances above.
          assetBackedTransferOut,
          windowDelta,
          calculatedDrift: drift,
          plan: { creates: plan.creates.length, updates: plan.updates.length, deletes: plan.deleteIds.length },
        });
        // Aggressive auto-heal: plug the residual immediately — but at most one
        // adjustment per account per day, so a stale valuation on a rapid
        // re-sync (the adjustment isn't recomputed yet) can't stack duplicates.
        if (heal && autoAdjust && drift != null) {
          const alreadyToday = await hasAdjustmentToday(host, wfAccountId, sfAccount.id).catch(
            () => false,
          );
          if (!alreadyToday) {
            try {
              await importAdjustmentActivity(host, {
                sfinAccountId: sfAccount.id,
                wfAccountId,
                currency: sfAccount.currency,
                amount: drift,
              });
              imported += 1;
            } catch (e: any) {
              const msg = String(e?.message ?? e);
              if (!msg.toLowerCase().includes('duplicate')) {
                errors.push(`Account ${wfAccountId} adjustment failed: ${msg}`);
              }
            }
          }
          // Healed (or already healed today). `measuredDrift` is cleared too, so
          // the alert treats an auto-plugged account as "nothing to say" rather
          // than either alerting (the system already fixed it, and with
          // aggressive auto-heal on it would fix-and-ping on a loop) or clearing
          // the episode (this run did not prove the account is in sync).
          drift = null;
          measuredDrift = null;
        }
      }
    }
    accountBalances[sfAccount.id] = {
      balance: Number.isFinite(sfBalance) ? sfBalance : null,
      currency: sfAccount.currency,
      date: sfAccount['balance-date'],
      drift,
    };

    // Drift episodes: open one (and announce it once) when a trustworthy figure
    // goes past the alert threshold, close it when a trustworthy figure comes
    // back under. Closing is what re-arms the alert, so a recurrence is heard
    // about again. A run with no trustworthy figure (measuredDrift === null)
    // touches nothing at all — see the note on the variable.
    if (measuredDrift !== null && driftAlertThresholdCents > 0) {
      const overThreshold = Math.abs(Math.round(measuredDrift * 100)) > driftAlertThresholdCents;
      const open = driftAlerts[sfAccount.id];
      if (overThreshold) {
        if (!open) {
          driftAlerts[sfAccount.id] = {
            driftAmount: measuredDrift,
            firstDetectedAt: new Date().toISOString(),
            alerted: true,
          };
          driftAlertsChanged = true;
          balanceDriftAlerts.push({
            sfinAccountId: sfAccount.id,
            accountName: wfNames.get(wfAccountId) || sfAccount.name,
            driftAmount: measuredDrift,
            currency: sfAccount.currency,
            bankBalance: sfBalance,
          });
        } else if (!open.alerted) {
          // A previous run queued this episode but delivery failed and the
          // companion rolled `alerted` back. Re-queue it — same episode, so
          // `firstDetectedAt` and the original figure stay put; retrying an
          // identical message cannot spam, since at most one attempt happens
          // per sync.
          driftAlerts[sfAccount.id] = { ...open, alerted: true };
          driftAlertsChanged = true;
          balanceDriftAlerts.push({
            sfinAccountId: sfAccount.id,
            accountName: wfNames.get(wfAccountId) || sfAccount.name,
            driftAmount: open.driftAmount,
            currency: sfAccount.currency,
            bankBalance: sfBalance,
          });
        }
      } else if (open) {
        delete driftAlerts[sfAccount.id];
        driftAlertsChanged = true;
      }
    }

    // Wealthfolio shows the comment as the cash activity's title and hashes it
    // into its dedup key. Combining the bank description with the SimpleFin tx
    // id gives readable, unique titles; the ` · pending` suffix marks rows that
    // haven't settled so they can be reconciled when they post.
    const cashSymbol = `$CASH-${sfAccount.currency}`;
    const toActivityCreate = (t: FeedTx): ActivityWrite => ({
      accountId: t.wfAccountId,
      activityType: t.type,
      activityDate: t.date,
      // Transfer legs carry NO asset so they land as real cash and stay pairable
      // (see isTransferType's note). Everything else resolves the reserved cash
      // asset by symbol — the /activities/bulk endpoint deserializes `symbol` as
      // an AssetResolutionInput object (a bare string 422s with "invalid type:
      // string, expected struct AssetResolutionInput").
      ...(isTransferType(t.type) ? {} : { symbol: { symbol: cashSymbol } }),
      // An in-transit placeholder books part (CASH outflow: all) of its amount as
      // `fee` — the exact shape importAdjustmentActivity uses for a spending-
      // neutral plug, where cash moves by `amount − fee − tax`. amount === 0 on
      // that side is correct and intentional.
      amount: (t.absCents - (t.feeCents ?? 0)) / 100,
      ...(t.feeCents ? { fee: t.feeCents / 100 } : {}),
      currency: sfAccount.currency,
      // The in-transit marker goes at the FRONT: txIdFromComment parses the
      // `… · <txId>` SUFFIX, and every reconciliation match depends on it.
      comment: `${t.inTransit ? IN_TRANSIT_COMMENT_PREFIX : ''}${descByTxId.get(t.txId) ?? ''} · ${t.txId}${t.pending ? PENDING_SUFFIX : ''}`,
      // Transfer-link sourceGroupId is applied later, atomically (see flush).
    });
    const toActivityUpdate = (wfId: string, t: FeedTx): ActivityWrite => ({
      ...toActivityCreate(t),
      // State the fee explicitly, even when it is 0. The server's numeric fields
      // are patch-shaped (an omitted key means "leave unchanged"), so a
      // placeholder promoting to a real transfer — or expiring to a plain
      // WITHDRAWAL — would otherwise keep its fee-side split and book the
      // wrong amount.
      fee: (t.feeCents ?? 0) / 100,
      id: wfId,
    });

    // Import only — NO transfer-link gids here. A transfer pair's two legs live
    // in different accounts, so stamping them in these per-account saveMany calls
    // never lets Wealthfolio see a complete 2-leg group (each call looks like a
    // lone leg and the group is dropped). All linking is done atomically after
    // the loop over `linkRowByTxId` (see the flush below).
    if (plan.creates.length || plan.updates.length || plan.deleteIds.length) {
      const result = await host.saveMany({
        creates: plan.creates.map(toActivityCreate),
        updates: plan.updates.map((u) => toActivityUpdate(u.wfId, u.to)),
        deleteIds: plan.deleteIds,
      });
      // Only creates are new imports; updates/deletes are reconciliation.
      imported += result.created.length;
      for (const err of result.errors ?? []) {
        errors.push(`Account ${wfAccountId} save error (${err.action}): ${err.message}`);
      }
      // Recovering history older than the starting-balance baseline double-counts
      // it (the baseline already includes those rows), so net them back out.
      if ((result.errors ?? []).length === 0) {
        try {
          await adjustStartingBalanceForOlderRows(host, {
            wfAccountId,
            sfinAccountId: sfAccount.id,
            currency: sfAccount.currency,
            created: plan.creates
              .filter((t) => !t.pending)
              .map((t) => ({ date: t.date, signed: signedByTxId.get(t.txId) ?? 0 })),
          });
        } catch (e: any) {
          errors.push(`Account ${wfAccountId} starting-balance adjust failed: ${e?.message ?? e}`);
        }
      }
      // Register rows just created so a brand-new transfer pair can be linked in
      // the same run's atomic flush (match the echoed Activity's `… · <txId>`
      // comment back to the FeedTx it was created from, using the new id).
      const createdFeedByTxId = new Map(plan.creates.map((t) => [t.txId, t]));
      for (const a of result.created ?? []) {
        const txId = txIdFromComment(a.comment);
        const t = txId ? createdFeedByTxId.get(txId) : undefined;
        if (txId && t && a.id) {
          linkRowByTxId.set(txId, {
            wfId: a.id, wfAccountId: t.wfAccountId, txId, absCents: t.absCents,
            type: t.type, date: t.date, pending: t.pending, currency: sfAccount.currency,
            sourceGroupId: a.sourceGroupId ?? null,
          });
          // Announce a large spend exactly once, off the CREATE echo.
          //
          // Fires once per SimpleFin transaction id with no ledger of its own,
          // because `planReconciliation` guarantees a given tx id can only be
          // created once: a row that already exists is matched by tx id and
          // becomes an UPDATE (so a pending row settling under the same id never
          // re-creates), and a pending row that vanishes and re-posts under a
          // FRESH id has that create *claimed* as an in-place update of the
          // pending row and removed from `plan.creates` entirely. Driven off the
          // echo rather than the plan so a create the host rejected — which is
          // not in `result.created` — says nothing.
          //
          // Both branches are pinned by tests; if either changes, this alert
          // starts repeating, so they are the ones to look at first.
          if (
            largeTxThresholdCents > 0 &&
            t.absCents > largeTxThresholdCents &&
            SPENDING_TYPES.has(t.type) &&
            // An in-transit placeholder is a transfer wearing a spending type: on
            // a non-CASH account `neutralAdjustmentFields` books it as a plain
            // WITHDRAWAL, so the type alone would let an internal transfer read
            // as a large purchase.
            !t.inTransit
          ) {
            largeTransactionAlerts.push({
              txId,
              description: descByTxId.get(txId) ?? '',
              amountCents: t.absCents,
              currency: sfAccount.currency,
              accountName: wfNames.get(t.wfAccountId) || sfAccount.name,
            });
          }
        }
      }
      // Same for rows updated IN PLACE: the snapshot registered above was read
      // before the plan ran, so it still describes the row as it was. That matters
      // most for an in-transit placeholder promoting to a real transfer — linkPair
      // re-creates both legs verbatim from what it's handed (the addon must), so a
      // stale snapshot would resurrect the placeholder's type and fee-side amount.
      // Driven off the echo, so only rows the host confirms it wrote are refreshed.
      const updatedFeedByTxId = new Map(plan.updates.map((u) => [u.to.txId, u.to]));
      for (const a of result.updated ?? []) {
        const txId = txIdFromComment(a.comment);
        const t = txId ? updatedFeedByTxId.get(txId) : undefined;
        if (!txId || !t || !a.id) continue;
        const prior = linkRowByTxId.get(txId);
        linkRowByTxId.set(txId, {
          // `comment` is deliberately left unset so toLinkLeg rebuilds a clean
          // `<description> · <txId>` — a promoted row must not keep the
          // placeholder's in-transit prefix. absCents is the FULL amount: every
          // row that reaches linkPair or the relink sweep is a real transfer leg
          // (a placeholder is never paired), which books its whole amount.
          wfId: a.id, wfAccountId: t.wfAccountId, txId, absCents: t.absCents,
          type: t.type, date: t.date, pending: t.pending, currency: sfAccount.currency,
          // An update cannot clear a stored asset, so a phantom one survives the
          // promotion — keep it visible to the relink sweep below.
          assetId: prior?.assetId,
          sourceGroupId: a.sourceGroupId ?? prior?.sourceGroupId ?? null,
        });
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
        alreadyCorrected = await hasExistingStartingBalance(host, wfAccountId, sfAccount.id);
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
        const correction: ImportRow = {
          accountId: wfAccountId,
          sourceSystem: 'simplefin',
          activityType: starting > 0 ? 'DEPOSIT' : 'WITHDRAWAL',
          date: dayBeforeDate,
          symbol: `$CASH-${sfAccount.currency}`,
          amount: Math.abs(Math.round(starting * 100) / 100),
          currency: sfAccount.currency,
          comment: `Starting balance · ${sfAccount.id}`,
          isValid: true,
          isDraft: false,
        };
        try {
          await host.importActivities([correction]);
          imported += 1;
        } catch (importErr: any) {
          // If the starting balance already exists or failed gracefully, log/ignore duplicate
          const msg = String(importErr?.message ?? importErr);
          if (!msg.toLowerCase().includes('duplicate')) {
            errors.push(`Account ${wfAccountId} starting balance import: ${msg}`);
          }
        }
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
        latest = await host.latestValuations(pendingCorrections.map((p) => p.wfAccountId));
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
          const alreadyDone = await hasExistingStartingBalance(host, p.wfAccountId, p.sfinAccountId);
          const starting = p.targetBalance - valuation;
          if (!alreadyDone && Number.isFinite(starting) && Math.abs(starting) >= 0.01) {
            const correction: ImportRow = {
              accountId: p.wfAccountId,
              sourceSystem: 'simplefin',
              activityType: starting > 0 ? 'DEPOSIT' : 'WITHDRAWAL',
              date: p.date,
              symbol: `$CASH-${p.currency}`,
              amount: Math.abs(Math.round(starting * 100) / 100),
              currency: p.currency,
              comment: `Starting balance · ${p.sfinAccountId}`,
              isValid: true,
              isDraft: false,
            };
            await host.importActivities([correction]);
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

  // Transfer linking. Only pairs whose two legs are both rows the host already
  // holds are linkable here; a brand-new pair (both legs created this run) is
  // registered above from the save echo, so it links in the same run.
  //
  // How a pair actually gets recorded is the HOST's business (`linkPair`): the
  // addon must delete and re-create both legs in one call, the companion has a
  // link endpoint. What the core owns is *which* pairs to hand over, and what to
  // remember afterwards.
  const linkedTxIds = new Set<string>();
  const pairsToLink: Array<[LinkLeg, LinkLeg]> = [];
  const toLinkLeg = (row: LinkableRow): LinkLeg => {
    let comment = row.comment ?? `${descByTxId.get(row.txId) ?? ''} · ${row.txId}`;
    if (!comment.endsWith(` · ${row.txId}`)) {
      const desc = descByTxId.get(row.txId) ?? (comment.includes(' · ') ? comment.split(' · ')[0] : comment);
      comment = `${desc} · ${row.txId}`;
    }
    return {
      wfId: row.wfId,
      accountId: row.wfAccountId,
      txId: row.txId,
      activityType: row.type,
      date: row.date,
      absCents: row.absCents,
      currency: row.currency,
      comment,
    };
  };
  for (const { outTxId, inTxId } of detection.pairs) {
    const outRow = linkRowByTxId.get(outTxId);
    const inRow = linkRowByTxId.get(inTxId);
    if (!outRow || !inRow) continue; // a leg isn't imported yet — links next run
    const alreadyLinked = readsGroups
      // The rows themselves say so: both in the same, non-empty group.
      ? !!outRow.sourceGroupId && outRow.sourceGroupId === inRow.sourceGroupId
      : ledgerLinkedTxIds.has(outTxId) && ledgerLinkedTxIds.has(inTxId);
    if (alreadyLinked) continue;
    // KNOWN GAP (accepted, tracked as a follow-up — not fixed here):
    // `linkedTxIds` is populated BEFORE `host.linkPair` runs below, so on a
    // ledger-backed host (`readsGroups === false`) a link that then fails is
    // still recorded as linked. The relink sweep uses this same ledger to
    // decide what needs attention, so it permanently skips that pair, leaving
    // an asset-backed leg in place. The user-visible symptom is a wrong
    // account balance appearing months later with no obvious cause — which is
    // exactly why this note is here rather than left to be rediscovered from
    // the balance. Fix shape: move these two adds to after a confirmed
    // successful `linkPair`, alongside the existing `linkFailures` handling.
    linkedTxIds.add(outTxId);
    linkedTxIds.add(inTxId);
    pairsToLink.push([toLinkLeg(outRow), toLinkLeg(inRow)]);
  }

  const linkFailures = await store.getTransferLinkFailures();
  let linkFailuresChanged = false;
  const stuckTransferAlerts: SyncResult['stuckTransferAlerts'] = [];

  let unlinkedLegs = 0;
  for (const legs of pairsToLink) {
    let result: { linked: boolean; groupId?: string };
    try {
      result = await host.linkPair(legs);
    } catch (e: any) {
      errors.push(`Transfer-link failed (${legs[0].txId}/${legs[1].txId}): ${e?.message ?? e}`);
      continue; // leave the ledger untouched so the pair retries next run
    }
    if (!result.linked || !result.groupId) unlinkedLegs += legs.length;

    // Track repeated failures on a genuinely-detected pair (both legs
    // present) so a persistently-rejected group — not ordinary in-transit
    // lag, which never reaches this loop — surfaces as a one-time alert.
    const failureKey = legs[0].txId;
    if (result.linked && result.groupId) {
      if (failureKey in linkFailures) {
        delete linkFailures[failureKey];
        linkFailuresChanged = true;
      }
    } else {
      const prior = linkFailures[failureKey];
      const count = (prior?.count ?? 0) + 1;
      const firstFailedAt = prior?.firstFailedAt ?? new Date().toISOString();
      const alerted = prior?.alerted ?? false;
      linkFailures[failureKey] = { count, firstFailedAt, alerted };
      linkFailuresChanged = true;
      if (count >= STUCK_TRANSFER_ALERT_THRESHOLD && !alerted) {
        linkFailures[failureKey].alerted = true;
        stuckTransferAlerts.push({
          outTxId: failureKey,
          description: `${legs[0].comment} ↔ ${legs[1].comment}`,
          amountCents: legs[0].absCents,
          currency: legs[0].currency,
        });
      }
    }

    if (readsGroups) continue; // nothing to remember — the rows carry the truth
    // Reconcile the ledger to what the host reports it actually stored: adopt
    // the real gid where the link landed, purge the txIds where it didn't so
    // they retry rather than staying wrongly marked "linked".
    for (const leg of legs) {
      if (result.linked && result.groupId) {
        if (ledger[leg.txId] !== result.groupId) {
          ledger[leg.txId] = result.groupId;
          ledgerChanged = true;
        }
      } else if (leg.txId in ledger) {
        delete ledger[leg.txId];
        ledgerChanged = true;
      }
    }
  }
  if (linkFailuresChanged) await store.setTransferLinkFailures(linkFailures);
  // Surface any leg the host silently refused to group, so a stuck transfer is
  // diagnosable without instrumenting the addon. Only on an explicit Reconcile:
  // a pair Wealthfolio keeps refusing would otherwise warn on every routine
  // sync, and the retry is harmless in the meantime.
  if (opts.heal && unlinkedLegs > 0) {
    errors.push(
      `${unlinkedLegs} transfer leg(s) could not be linked — they will be retried on the next reconcile`,
    );
  }

  // Repair legacy transfer legs that still carry an asset but are NOT part of a
  // pair being linked — e.g. a transfer to an untracked external account. They
  // can never book cash while an asset is attached, and an update can't clear it
  // (the server's `asset` field is a plain Option, not the Option<Option<…>>
  // "patch" shape its numeric fields use, so omitting it does not CLEAR a stored
  // asset). Delete and re-create asset-free instead, which is the only way to
  // make them book cash (handlers/transfers.rs only books cash when asset_id is
  // empty). No group id: there's nothing to pair them with.
  const relinkCreates: ActivityWrite[] = [];
  const staleLegIds: string[] = [];
  for (const row of linkRowByTxId.values()) {
    if (!isTransferType(row.type) || !row.assetId || linkedTxIds.has(row.txId)) continue;
    staleLegIds.push(row.wfId);
    relinkCreates.push({
      accountId: row.wfAccountId,
      activityType: row.type,
      activityDate: row.date,
      amount: row.absCents / 100,
      currency: row.currency,
      comment: row.comment ?? `${descByTxId.get(row.txId) ?? ''} · ${row.txId}`,
    });
  }
  if (relinkCreates.length > 0) {
    // Delete the old legs first so re-creating them can't collide with the
    // originals on the host's dedup.
    const del = await host.saveMany({ deleteIds: staleLegIds });
    for (const err of del.errors ?? []) {
      errors.push(`Transfer-relink delete error (${err.action}): ${err.message}`);
    }
    const result = await host.saveMany({ creates: relinkCreates });
    for (const err of result.errors ?? []) {
      errors.push(`Transfer-relink save error (${err.action}): ${err.message}`);
    }
  }

  if (ledgerChanged) await store.setLinkedGroups(ledger);

  if (driftAlertsChanged) await store.setDriftAlerts(driftAlerts);

  await store.setAccountBalances(accountBalances);

  await store.setLastSyncAt(new Date());

  return { imported, skipped, errors, stuckTransferAlerts, largeTransactionAlerts, balanceDriftAlerts };
}
