import { mapTransactionWithSource } from './mapper.js';
import { accountTxKey, detectTransferPairs } from './transfers.js';
import type { TransferCandidate } from './transfers.js';
import { planReconciliation, IN_TRANSIT_COMMENT_PREFIX } from './reconcile.js';
import type { FeedTx, ExistingRow } from './reconcile.js';
/** Re-exported from reconcile.ts (which defines it, so `changed()` can recognise
 *  the marker without importing sync-core and creating a cycle). This module owns
 *  WRITING the prefix, so importers keep finding the name here. */
export { IN_TRANSIT_COMMENT_PREFIX };
import {
  matchAmazonCharge, consumeAmazonMatch, amazonDescription,
} from './amazon-ledger.js';
import type { AmazonLedger } from './amazon-ledger.js';
import type { ActivityType, SimplefinTransaction } from './types.js';
import type { ActivityWrite, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';

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

/** Grep token for the "deleted an already-stored duplicate" log line. Every
 *  deletion is logged individually, so the record of what vanished survives even
 *  when the user has no Telegram configured and never opens the Sync page. */
export const DUPLICATE_PRUNE_LOG_TAG = 'duplicate-prune';

/**
 * Grep token for "the host refused a row because it already had one".
 *
 * Logged rather than surfaced. A duplicate refusal is not a failure — the row is
 * there, which is what the create wanted — so putting it on `errors` paints a red
 * "Account … failed" banner over a non-problem, which is exactly what happened when
 * a bank republished its history.
 *
 * But it is not nothing either: it means reconciliation did not recognise a row that
 * exists, so the tx-id match missed or something outside this addon wrote it. That
 * is worth being able to find later, and a log line costs nothing when nobody is
 * looking.
 */
export const DUPLICATE_REFUSAL_LOG_TAG = 'duplicate-refused';

/**
 * Note prefixes marking an activity this module wrote for its OWN bookkeeping
 * rather than as a copy of a bank transaction.
 *
 * Both are matched as prefixes and both are load-bearing for the duplicate
 * sweep, because `txIdFromComment` is naive — it hands back whatever follows the
 * last ` · `:
 *   • `Starting balance · <sfinAccountId>`   → the ACCOUNT ID as a "tx id"
 *   • `Balance adjustment · <acct> · <date>` → the DATE as a "tx id"
 * So two adjustments written on one day are indistinguishable from a duplicated
 * transaction by id alone, and a starting-balance baseline is the one row on the
 * account whose deletion would silently rewrite its entire history. They are
 * excluded by these prefixes and never by the shape of the parsed id.
 *
 * Exported (and used by the writers below) so a renamed marker cannot leave the
 * exclusion matching a string nothing writes any more.
 */
export const STARTING_BALANCE_COMMENT_PREFIX = 'Starting balance · ';
export const BALANCE_ADJUSTMENT_COMMENT_PREFIX = 'Balance adjustment · ';

/** True for an activity note this module wrote as bookkeeping — never a bank
 *  transaction, and never a candidate for the duplicate sweep. */
export function isInternalMarkerComment(text: string | null | undefined): boolean {
  const c = text ?? '';
  return (
    c.startsWith(STARTING_BALANCE_COMMENT_PREFIX) ||
    c.startsWith(BALANCE_ADJUSTMENT_COMMENT_PREFIX)
  );
}

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
/**
 * Which of ONE account's stored rows are surplus copies of the same SimpleFin
 * transaction — i.e. what the reconcile sweep should delete. Returns the rows to
 * remove; every group keeps exactly one survivor.
 *
 * Pure and host-agnostic so the delete list is testable without a host: this is
 * the function that decides to destroy financial records, and it should be
 * possible to interrogate that decision directly.
 *
 * KEEP RULE — the lexicographically LOWEST activity id. It is a property of the
 * rows themselves, so repeated runs converge on the same survivor instead of
 * oscillating between copies (which, since each run deletes "the others", would
 * churn the account's ids forever). It is also stable under the host's paging
 * order, unlike "the first one we happened to read". Wealthfolio ids are UUIDs,
 * so lowest-id is not literally oldest — what matters is that it is DETERMINISTIC,
 * and the survivor is reconciled against this run's feed in the same pass, so
 * keeping a copy that turns out to be stale is self-correcting.
 *
 * TWO INDEPENDENT SAFETY FILTERS, both required:
 *  1. Internal marker rows are excluded by NOTE PREFIX
 *     (`isInternalMarkerComment`). See that constant's note: a starting-balance
 *     baseline parses to the account id and same-day balance adjustments parse to
 *     one shared date, so id-based reasoning alone would delete real bookkeeping.
 *  2. The transaction id must be one SimpleFin reported for THIS account on THIS
 *     run (`feedTxIds`). Any Wealthfolio activity whose note contains ' · ' —
 *     including hand-entered ones like `Lunch · Tuesday` and `Coffee · Tuesday` —
 *     parses to a "tx id", and two of those are indistinguishable from a
 *     duplicated import. Demanding that the bank just vouched for the id is what
 *     keeps rows this sync never wrote out of a delete list.
 *
 * The cost of filter 2 is reach: a duplicate whose transaction has aged out of
 * even the 89-day heal window is not pruned. Accepted deliberately — the sweep
 * exists for duplicates a *feed* produced, so they are recent by construction,
 * and the alternative is a sweep that can delete rows it cannot identify.
 */
export function planDuplicatePrune<
  T extends { wfId: string; txId: string; comment?: string },
>(rows: T[], feedTxIds: Set<string>): T[] {
  const byTxId = new Map<string, T[]>();
  for (const row of rows) {
    if (isInternalMarkerComment(row.comment)) continue;
    if (!feedTxIds.has(row.txId)) continue;
    const group = byTxId.get(row.txId);
    if (group) group.push(row);
    else byTxId.set(row.txId, [row]);
  }
  const remove: T[] = [];
  for (const group of byTxId.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.wfId < b.wfId ? -1 : a.wfId > b.wfId ? 1 : 0));
    remove.push(...sorted.slice(1));
  }
  return remove;
}

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
 * How long a drift episode must have been standing before a `Fix baseline`
 * offer is allowed. A wrong baseline has been wrong since the day it was
 * written and never resolves itself; a balance that includes a posted
 * transaction the feed hasn't reported yet produces the identical constant-gap
 * signature but clears within days. Ten days — matching IN_TRANSIT_TIMEOUT's
 * notion of "longer than any ordinary settlement lag" — is long enough that
 * only the permanent kind survives.
 */
export const BASELINE_FIX_MIN_DRIFT_AGE_MS = 10 * 24 * 60 * 60 * 1000;

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
  /** Every feed transaction this run CONFIRMED as created, for the companion's
   *  import notice. Driven off the create echo, so a rejected create is not
   *  announced. Internal rows (starting balances, adjustments, plugs) never
   *  appear — they are imported outside the reconciliation plan. */
  importedTransactions: Array<{
    txId: string;
    /** SimpleFin account id — with `txId`, the account-scoped identity. */
    sfAccountId: string;
    description: string;
    amountCents: number;
    currency: string;
    accountName: string;
    activityType: string;
    pending: boolean;
    /** An unpaired transfer leg imported as a spending-neutral placeholder. */
    inTransit: boolean;
  }>;
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
    /** `young` — the episode just opened; usually the bank balance running
     *  ahead of its transaction feed, which resolves itself, so the messenger
     *  should inform rather than alarm. `aged` — the same episode has stood
     *  past the baseline-fix age without resolving, which lag does not do;
     *  sent once, with the alarm styling. */
    phase: 'young' | 'aged';
  }>;
  /**
   * Activities the reconcile sweep DELETED as surplus copies of a transaction the
   * account already held (see `planDuplicatePrune`). One entry per deleted row,
   * carrying enough to recognise what vanished without opening Wealthfolio.
   *
   * Always empty on a routine sync — the sweep only runs on heal/reconcile. It is
   * reported (and separately logged, and messaged) because automatic deletion of
   * a financial record must never be silent, even when the deletion is correct.
   */
  prunedDuplicates: Array<{
    sfinAccountId: string;
    /** Wealthfolio account name, falling back to the SimpleFin one. */
    accountName: string;
    txId: string;
    /** Bank description, with the tx-id suffix and any in-transit prefix taken
     *  back off — what the row was CALLED in Wealthfolio. */
    description: string;
    /** YYYY-MM-DD. */
    date: string;
    /** The transaction's full magnitude, taken from the FEED rather than the
     *  deleted row: an in-transit placeholder books its amount as `fee`, so the
     *  stored `amount` is 0 and reporting it would claim "$0.00 removed". */
    amountCents: number;
    currency: string;
    /** The deleted Wealthfolio activity id, so the deletion is traceable. */
    wfId: string;
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
  /**
   * Whether this run actually obtained a trustworthy drift figure.
   *
   * `drift: null` cannot answer that on its own — it is ALSO what "could not check"
   * looks like, and the two were rendered identically as a green "in sync" chip. An
   * account can be incomparable for several ordinary reasons (a pending row, a run
   * that updated or deleted anything, a pruned duplicate, a planned create that never
   * landed), and calling any of those "in sync" claims a verification that did not
   * happen. Two phantom drift episodes on the same account were read as verified
   * balances before this existed.
   *
   * Absent means unmeasured: a snapshot written by an older build has proved nothing
   * about the current state either, and every sync rewrites it.
   */
  measured?: boolean;
  /**
   * Present when this run PROVED the drift belongs to the starting-balance
   * baseline rather than to any transaction: the reconciliation plan came back
   * empty over the heal window, so every transaction the bank reports is already
   * stored and already matches, and nothing inside the window can account for
   * the gap. What remains is the one row that stands in for history we never
   * saw — so the honest repair is to correct that row, not to add a
   * `Balance adjustment` plug, which invents a transaction dated today to hide a
   * wrong constant and leaves the account permanently misattributed.
   *
   * Signed, in dollars. Offered to the user; never applied automatically.
   */
  baselineFix?: {
    activityId: string;
    currentAmount: number;
    suggestedAmount: number;
  };
  /**
   * When the displayed drift's episode opened (the drift-alert ledger's
   * `firstDetectedAt`), or null when the drift is under the alert threshold and
   * has no episode to date it by. The UI uses the age to render a young drift
   * as "waiting on the bank's feed" — with NO plug button — instead of a red
   * banner whose Add button bakes feed lag into a fake transaction.
   */
  driftSince?: string | null;
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
  const marker = `${STARTING_BALANCE_COMMENT_PREFIX}${sfinAccountId}`;
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
  const marker = `${STARTING_BALANCE_COMMENT_PREFIX}${sfinAccountId}`;
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
 * Save a plan, falling back to ROW-BY-ROW when the host refuses the batch.
 *
 * Wealthfolio's bulk endpoint is ALL-OR-NOTHING: one row it considers a
 * duplicate discards the entire batch. So a single un-importable transaction
 * strands every other transaction for that account — and silently, because the
 * run still completes, reporting `0 imported` exactly like a quiet day. Seen
 * live on 2026-08-06: a Citi card with two legitimately identical same-day
 * charges (the same $21.20 merchant twice) had its whole account batch refused.
 *
 * On any refusal the batch is re-sent one row at a time: deletes first (id-
 * addressed, so they cannot collide), then updates, then creates. Rows the bulk
 * call already stored are skipped — a partial success must not become a
 * double-create. The returned `errors` name ONLY the rows genuinely refused,
 * each with its comment so the failure is actionable rather than just a count,
 * which also keeps the caller's existing "did anything fail?" guard honest: a
 * refused row still suppresses the starting-balance adjustment, since that
 * adjustment reasons over the whole plan.
 *
 * Costs nothing on the happy path — one call, no follow-up.
 */
/**
 * "A matching activity already exists" — Wealthfolio's own dedup guard.
 *
 * NOT a failure. It means the row is there, which is the end state the create was
 * asking for. Reporting it sends the user hunting for data that was never lost, and
 * buries the refusals that ARE problems in noise that arrives every time a feed
 * republishes history.
 */
function isDuplicateRefusal(message: string): boolean {
  return /duplicate|already exists/i.test(message);
}

/** One saveMany attempt, with a THROW normalised into the returned-errors shape.
 *
 *  The two hosts fail differently and it mattered: the companion's REST adapter
 *  returns `{errors}`, while the addon's SDK adapter lets
 *  `ctx.api.activities.saveMany` throw. Handling only the first shape meant the
 *  addon path threw out of this function on its very first call — so the row-by-row
 *  fallback never ran and a whole account's batch was discarded. */
async function attemptSave(
  host: SyncHost,
  req: SaveManyRequest,
): Promise<SaveManyResult> {
  try {
    return await host.saveMany(req);
  } catch (e: any) {
    return {
      created: [],
      updated: [],
      errors: [{ action: 'save', message: String(e?.message ?? e) }],
    };
  }
}

async function saveWithRowFallback(
  host: SyncHost,
  req: SaveManyRequest,
): Promise<SaveManyResult> {
  const bulk = await attemptSave(host, req);
  if ((bulk.errors ?? []).length === 0) return bulk;

  const created = [...(bulk.created ?? [])];
  const updated = [...(bulk.updated ?? [])];
  const errors: SaveManyResult['errors'] = [];

  // What the refused batch nonetheless managed to store.
  const landedCreates = new Set(
    created.map((a) => txIdFromComment(a.comment)).filter((t): t is string => !!t),
  );
  const landedUpdates = new Set(updated.map((a) => a.id).filter((id): id is string => !!id));

  if ((req.deleteIds ?? []).length > 0) {
    const del = await attemptSave(host, { deleteIds: req.deleteIds });
    for (const e of del.errors ?? []) errors.push(e);
  }

  for (const u of req.updates ?? []) {
    if (u.id && landedUpdates.has(u.id)) continue;
    const one = await attemptSave(host, { updates: [u] });
    if ((one.errors ?? []).length === 0) {
      updated.push(...(one.updated ?? []));
    } else {
      const msg = (one.errors ?? []).map((e) => e.message).join('; ') || 'host returned no row';
      if (isDuplicateRefusal(msg)) {
        console.log(`[simplefin-sync] ${DUPLICATE_REFUSAL_LOG_TAG} (update): ${u.comment}`);
      } else {
        errors.push({ action: 'update', message: `${msg} [${u.comment}]` });
      }
    }
  }

  for (const c of req.creates ?? []) {
    const txId = txIdFromComment(c.comment);
    if (txId && landedCreates.has(txId)) continue;
    const one = await attemptSave(host, { creates: [c] });
    if ((one.errors ?? []).length === 0 && (one.created ?? []).length > 0) {
      created.push(...one.created);
    } else {
      const msg = (one.errors ?? []).map((e) => e.message).join('; ') || 'host returned no row';
      // A duplicate means the row is already there — the create's goal is met, so
      // it is neither an import (not counted in `created`) nor a failure. Logged so
      // the fact that reconcile missed an existing row is still findable.
      if (isDuplicateRefusal(msg)) {
        console.log(`[simplefin-sync] ${DUPLICATE_REFUSAL_LOG_TAG} (create): ${c.comment}`);
      } else {
        errors.push({ action: 'create', message: `${msg} [${c.comment}]` });
      }
    }
  }

  return { created, updated, errors };
}

/**
 * Correct an account's starting-balance baseline to `suggestedAmount`.
 *
 * The baseline stands for everything that predates the first sync, so a drift no
 * transaction can explain is a wrong baseline — and the fix is to rewrite that
 * one row IN PLACE. Deliberately not a `Balance adjustment` plug: a plug dates
 * the correction today, shows up as its own activity, and adds another row every
 * time it is used, while the error it covers is a constant reaching back to
 * before the account had any history at all.
 *
 * Never called from the sync. Rewriting a baseline moves a real balance, so it
 * only runs when the user accepts the offer carried on
 * `AccountBalanceSnapshot.baselineFix`.
 */
export async function applyBaselineFix(
  host: SyncHost,
  args: { wfAccountId: string; sfAccountId: string; suggestedAmount: number; currency: string },
): Promise<{ applied: boolean; error?: string }> {
  const { wfAccountId, sfAccountId, suggestedAmount, currency } = args;
  // Re-read instead of trusting the id the snapshot was built with: that
  // snapshot can be minutes old, and this writes to a financial row by id.
  const baseline = await fetchStartingBalance(host, wfAccountId, sfAccountId).catch(() => null);
  if (!baseline) return { applied: false, error: 'no starting-balance row on this account' };
  const res = await host.saveMany({
    updates: [
      {
        id: baseline.id,
        accountId: wfAccountId,
        // `amount` is a magnitude — the sign lives in the type, so a correction
        // that crosses zero has to change the type or it lands with the old one.
        activityType: suggestedAmount < 0 ? 'WITHDRAWAL' : 'DEPOSIT',
        activityDate: baseline.date,
        amount: Math.abs(Math.round(suggestedAmount * 100) / 100),
        currency,
        comment: `${STARTING_BALANCE_COMMENT_PREFIX}${sfAccountId}`,
      },
    ],
  });
  if (res.errors.length > 0) {
    return { applied: false, error: res.errors.map((e) => `${e.action}: ${e.message}`).join('; ') };
  }
  return { applied: true };
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
      comment: `${STARTING_BALANCE_COMMENT_PREFIX}${sfinAccountId}`,
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
  const marker = `${BALANCE_ADJUSTMENT_COMMENT_PREFIX}${sfinAccountId} · ${new Date().toISOString().split('T')[0]}`;
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

/** An existing row plus the three things linking needs that reconciliation
 *  doesn't: the account's currency, whatever group the host says the row is
 *  already in (only meaningful when `capabilities.readsSourceGroupId`), and the
 *  SIMPLEFIN account id. The last one is what makes the row identifiable at all
 *  once the run leaves the per-account loop: `wfAccountId` alone cannot look
 *  anything up in the `accountTxKey`-keyed maps, which are keyed by SimpleFin
 *  account id, and `txId` alone is not unique across accounts. */
type LinkableRow = ExistingRow & {
  currency: string;
  sourceGroupId?: string | null;
  sfAccountId: string;
};

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
  // CREDIT_CARD shares CASH's shape, and NOT because of the spending classifier
  // — because Wealthfolio's API rejects the type outright: "Invalid data: DEPOSIT
  // activities are not supported for credit card accounts", hit live on
  // 2026-08-07 by the in-transit placeholder for an AUTOPAY arriving at a Citi
  // card. The old note here reasoned that DEPOSIT was safe on a card since the
  // classifier already ignores it, which was true and beside the point: the row
  // never reaches the classifier.
  //
  // CREDIT is demonstrably accepted on a card — Wealthfolio writes
  // `Thankyou Points Redeemed` CREDIT rows to that same account — and the
  // amount/fee split is how cash moves for any type (`amount − fee − tax`),
  // which is what keeps the placeholder spending-neutral in both directions.
  if (accountType === 'CASH' || accountType === 'CREDIT_CARD') {
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
    comment: `${BALANCE_ADJUSTMENT_COMMENT_PREFIX}${sfinAccountId} · ${today}`,
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
    return { imported: 0, skipped: 0, errors: [INTERVAL_SKIP_MESSAGE], stuckTransferAlerts: [], importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [], prunedDuplicates: [] };
  }

  const accessUrl = await store.getAccessUrl();
  if (!accessUrl) {
    return { imported: 0, skipped: 0, errors: ['Not configured: no access URL'], stuckTransferAlerts: [], importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [], prunedDuplicates: [] };
  }

  const mapping = await store.getAccountMapping();
  if (!mapping) {
    return { imported: 0, skipped: 0, errors: ['Not configured: no account mapping'], stuckTransferAlerts: [], importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [], prunedDuplicates: [] };
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
  const importedTransactions: SyncResult['importedTransactions'] = [];

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

  // Rows the reconcile sweep deletes as surplus copies (see the prune block in
  // the per-account loop). Stays empty on a routine sync.
  const prunedDuplicates: SyncResult['prunedDuplicates'] = [];

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
  //
  // Keyed by `accountTxKey(sfAccountId, txId)` — NEVER by tx id alone. SimpleFin
  // issues one transaction id for both sides of a transfer between two connected
  // accounts, and these maps span every mapped account, so a bare key had the
  // second leg overwrite the first: one account's row written with the OTHER
  // account's bank description, and the wrong SIGN fed into both the drift
  // measurement and the starting-balance baseline.
  const descByKey = new Map<string, string>();
  const signedByKey = new Map<string, number>();

  // Amazon order categories, folded into the description below.
  //
  // An empty ledger — every user who hasn't set up mail forwarding — costs one
  // read and then nothing: `matchAmazonCharge` is skipped entirely rather than
  // called per transaction against an empty map.
  let amazonLedger = await store.getAmazonLedger().catch(() => ({} as AmazonLedger));
  let amazonLedgerChanged = false;
  const amazonEnabled = Object.keys(amazonLedger).length > 0;

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
      const key = accountTxKey(sfAccount.id, tx.id);
      // Amazon categories go on AFTER typing: `mapTransactionWithSource` above
      // matches the user's merchant rules against the bank's own text, and
      // enriching first would change what those rules see.
      let description = tx.description;
      if (amazonEnabled) {
        const hit = matchAmazonCharge(amazonLedger, {
          description: tx.description,
          amountCents: Math.round(Math.abs(amount) * 100),
          // txEpoch hands back SimpleFin's native SECONDS. Passing that as ms puts
          // every charge in 1970, outside every window, so Amazon matching just
          // silently never fires — which is precisely the failure this feature is
          // built to avoid, and is invisible without an end-to-end test.
          postedMs: txEpoch(tx)! * 1000,
          txKey: key,
        });
        if (hit) {
          description = amazonDescription(description, hit.labels, hit.partial);
          // Consumed even when this row already exists in Wealthfolio and so
          // won't be re-written: the charge for that order HAS been found, and
          // leaving the record live would offer it to the next charge of the
          // same amount.
          amazonLedger = consumeAmazonMatch(amazonLedger, hit, key);
          amazonLedgerChanged = true;
        }
      }
      descByKey.set(key, description);
      signedByKey.set(key, amount);
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
      const override = detection.typeByAccountTx.get(accountTxKey(p.sfAccountId, p.tx.id));
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
  // Per LEG, not per tx id: with a shared id a bare set could not tell "this
  // account's side of the pair is accounted for" from "some account's is".
  const pairedKeys = new Set<string>();
  for (const pair of detection.pairs) {
    pairedKeys.add(accountTxKey(pair.out.accountId, pair.out.txId));
    pairedKeys.add(accountTxKey(pair.in.accountId, pair.in.txId));
  }
  const nowSec = Math.floor(Date.now() / 1000);
  for (const prepared of preparedByAccount.values()) {
    for (const p of prepared) {
      const key = accountTxKey(p.sfAccountId, p.tx.id);
      if (!isTransferType(p.type) || pairedKeys.has(key)) continue;
      const signed = signedByKey.get(key) ?? 0;
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
  //
  // KEYED BY BARE TX ID, DELIBERATELY — the one cross-account map that is not
  // being re-keyed by (account, tx id), because it does not need to be and the
  // change would cost real user state.
  //
  //  • It cannot be ambiguous in practice. SimpleFin issues a shared id for the
  //    two sides of ONE transfer, so a shared id identifies exactly one pair; the
  //    ledger's job is "is this pair already grouped", and one entry answers it
  //    for both legs. A third occurrence of the same id — which is what it would
  //    take for two different pairs to collide here — is not a thing SimpleFin
  //    does.
  //  • Re-keying would be a MIGRATION with teeth. `linked_groups` is a persisted
  //    addon secret with live entries; under a new key format every one of them
  //    stops matching, so every already-linked pair reads as unlinked and gets
  //    re-attempted — and on the addon `linkPair` DELETES AND RE-CREATES both
  //    legs. That is a mass delete/re-create of correctly-linked financial rows
  //    to buy precision that is not needed. Same reasoning for
  //    `transfer_link_failures` below (keyed by the OUT leg's txId), where a
  //    reset would additionally throw away strike counts and re-announce a stuck
  //    pair the user has already been told about.
  //
  // If a future SimpleFin ever does reuse one id across three accounts, this is
  // the line to revisit — and it becomes a read-both-shapes/write-new migration,
  // not a silent re-key.
  const readsGroups = host.capabilities.readsSourceGroupId;
  const ledger: Record<string, string> = readsGroups ? {} : await store.getLinkedGroups();
  let ledgerChanged = false;
  // txIds whose pair the ledger already vouches for. Empty (and unused) when the
  // host can read groups back off the rows.
  const ledgerLinkedKeys = new Set<string>();
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
    for (const { out, in: inLeg } of detection.pairs) {
      const outKey = accountTxKey(out.accountId, out.txId);
      const inKey = accountTxKey(inLeg.accountId, inLeg.txId);
      // Confirmed-linked pairs (both legs on the same gid, adopted from a
      // previous run's report) are skipped — no churn, on a sync or a heal.
      //
      // Per-leg entries are unambiguous: one key per leg, always.
      const perLeg = ledger[outKey] !== undefined && ledger[outKey] === ledger[inKey];
      // A LEGACY bare-txId entry is trusted only where the two legs carry
      // DIFFERENT ids, because there one entry per id still means one per leg.
      // When SimpleFin issues ONE id for both sides, the two lookups collapse
      // into a single entry that cannot distinguish "both legs confirmed" from
      // "the echo collapsed and only one leg was grouped" — and the writer that
      // produced it could not tell either, so it is not evidence. Such a pair is
      // re-verified exactly once and rewritten in the per-leg shape below.
      const legacy = out.txId !== inLeg.txId
        && ledger[out.txId] !== undefined
        && ledger[out.txId] === ledger[inLeg.txId];
      if (perLeg || legacy) {
        ledgerLinkedKeys.add(outKey);
        ledgerLinkedKeys.add(inKey);
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

  // Every already-imported row across all accounts, keyed by
  // `accountTxKey(sfAccountId, txId)`. Used by the transfer-link step AFTER the
  // loop: both legs of a pair live in different accounts, so a pair can only be
  // assembled once every account has been read (and the host needs both legs at
  // once — Wealthfolio only forms a transfer group when it sees them together).
  //
  // THIS is the map whose collision was the expensive one. Keyed by bare tx id,
  // a shared-id pair resolved BOTH legs to the same stored row, so `linkPair` was
  // handed [leg, leg] — and a delete-and-re-create host then removed that one row
  // and created TWO in one account, manufacturing exactly the duplicate the prune
  // sweep exists to remove, while the other account's leg was never touched or
  // linked.
  const linkRowByKey = new Map<string, LinkableRow>();

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

    // ── Duplicate prune (heal/reconcile only) ────────────────────────────────
    //
    // Delete rows that are surplus copies of a transaction this account already
    // holds — the wreckage the feed dedup above now prevents, but which is
    // already sitting in production databases (a savings account reading
    // $1,297.50 low off two duplicated rows).
    //
    // ORDERING. This runs on the freshly-read snapshot and BEFORE anything else
    // in the account's pass, and the deleted rows are dropped from `existing`
    // first. That is what keeps every later step out of contact with a dead
    // `wfId`:
    //   • `linkRowByTxId` is populated from `existing` below, so it only ever
    //     learns about the survivor — the transfer-link flush and the relink
    //     sweep at the end of the run cannot hand a deleted id to `linkPair`.
    //   • `planReconciliation` sees the survivor as the account's only row for
    //     that tx id, so this run's update (or a pending-row match) targets a row
    //     that still exists — and the survivor gets reconciled against the feed
    //     in the same pass, which is why "keep the lowest id" needs no opinion
    //     about which copy is the more current.
    //   • nothing the sweep deletes can be re-created afterwards: the survivor
    //     still matches by tx id, so the feed tx does not become a create.
    // The deletes are issued as their own `saveMany({ deleteIds })` — the same
    // path the relink sweep uses — before the plan's own save, so a re-create
    // could never collide with a row being removed.
    //
    // Only on heal (`↻ Reconcile & link`, or auto-heal). `heal` rather than
    // `opts.heal` deliberately: a user who turned auto-heal on has asked for
    // exactly this kind of repair to happen unattended, and both paths re-scan a
    // wide window, which is what gives the sweep the feed evidence it needs. A
    // routine sync never deletes anything.
    let prunedThisAccount = 0;
    if (heal) {
      const feedByTxId = new Map(feed.map((t) => [t.txId, t]));
      const surplus = planDuplicatePrune(existing, new Set(feedByTxId.keys()));
      if (surplus.length > 0) {
        const surplusIds = new Set(surplus.map((r) => r.wfId));
        // Drop them from the snapshot even if the delete below fails: a row we
        // have asked the host to remove must not be a target for this run's
        // updates or links. A failed delete leaves an orphan the next reconcile
        // re-finds, which is the cheap direction to be wrong in.
        existing = existing.filter((r) => !surplusIds.has(r.wfId));
        prunedThisAccount = surplus.length;
        const del = await host.saveMany({ deleteIds: surplus.map((r) => r.wfId) });
        if ((del.errors ?? []).length > 0) {
          // The error shape doesn't say WHICH id failed, so nothing is reported
          // as pruned — claiming a deletion that may not have happened is worse
          // than reporting none and surfacing the error.
          for (const err of del.errors ?? []) {
            errors.push(`Account ${wfAccountId} duplicate-prune delete error (${err.action}): ${err.message}`);
          }
        } else {
          for (const row of surplus) {
            const feedTx = feedByTxId.get(row.txId);
            const entry = {
              sfinAccountId: sfAccount.id,
              accountName: wfNames.get(wfAccountId) || sfAccount.name,
              txId: row.txId,
              // The ROW's own description first; `descByKey` is the fallback for a
              // row whose stored note has no readable description left. The
              // account is part of that key precisely so a shared tx id cannot
              // hand back the other account's text.
              description: descriptionFromComment(row.comment)
                || (descByKey.get(accountTxKey(sfAccount.id, row.txId)) ?? ''),
              date: row.date,
              amountCents: feedTx?.absCents ?? row.absCents,
              currency: sfAccount.currency,
              wfId: row.wfId,
            };
            prunedDuplicates.push(entry);
            // Logged per row, so the record of what was deleted exists even for a
            // user with no Telegram who never opens the Sync page.
            console.warn(
              `[simplefin-sync] ${DUPLICATE_PRUNE_LOG_TAG}: deleted activity ${row.wfId} — a surplus copy of transaction ${row.txId} in account ${sfAccount.id}`,
              entry,
            );
          }
        }
      }
    }

    for (const row of existing) {
      linkRowByKey.set(accountTxKey(sfAccount.id, row.txId), {
        ...row, currency: sfAccount.currency, sfAccountId: sfAccount.id,
      });
    }
    const plan = planReconciliation(feed, existing);

    // State the post-save drift correction needs (see "windowDelta assumed" below).
    // Captured BEFORE the measurement so a rollback can put the episode ledger back
    // exactly as it was, rather than approximating it.
    const driftAlertBefore = driftAlerts[sfAccount.id];
    const driftAlertsCountBefore = balanceDriftAlerts.length;
    /** Planned-create tx ids the drift figure assumed would land, or null when the
     *  measurement did not depend on any (a normal sync, where creates are 0). */
    let driftAssumedCreates: string[] | null = null;

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
    // A correction to the starting-balance baseline, offered only when the drift
    // is PROVABLY the baseline's fault (see where it is set). Never applied here:
    // rewriting a baseline changes a real balance, so it stays an offer the user
    // accepts explicitly.
    let baselineFix: AccountBalanceSnapshot['baselineFix'];
    if (wfValuation !== undefined && Number.isFinite(sfBalance)) {
      // Drift compares SimpleFin's POSTED balance to Wealthfolio's valuation.
      // They're only comparable when the account is SETTLED: pending rows are in
      // Wealthfolio's valuation but not in SimpleFin's posted balance, and a run
      // that updates/deletes rows moves the valuation by amounts a create-only
      // delta wouldn't capture. So measure only with no pending anywhere and no
      // updates/deletes this run.
      const noPending = !feed.some((t) => t.pending) && !existing.some((r) => r.pending);
      // A duplicate pruned above moves the valuation exactly as an update or a
      // delete does, and `wfValuation` was read BEFORE the prune ran — so it
      // still counts the rows just deleted. Trusting it would report the
      // duplicate's own amount as drift, and with aggressive auto-heal on would
      // then write that amount into the account as a balance adjustment: the very
      // figure the prune just removed, put straight back. Not measurable this run.
      const createOnly =
        plan.updates.length === 0 && plan.deleteIds.length === 0 && prunedThisAccount === 0;
      // Heal re-scans wide and imports, so it must subtract what it creates
      // (lag-free: WF's balance becomes wfValuation + creates). A normal sync
      // only trusts drift when nothing was created (valuation is otherwise
      // stale), so its windowDelta is 0 by construction.
      if (noPending && createOnly && (heal || plan.creates.length === 0)) {
        const windowDelta = plan.creates.reduce(
          (sum, t) => sum + (signedByKey.get(accountTxKey(sfAccount.id, t.txId)) ?? 0),
          0,
        );
        // Remembered because windowDelta is a PREDICTION: it assumes every planned
        // create lands. A refused one makes the figure wrong by exactly its amount,
        // and the save has not happened yet, so the check has to wait for it.
        if (plan.creates.length > 0) driftAssumedCreates = plan.creates.map((t) => t.txId);
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
        // An EMPTY plan over the heal window says no STORED transaction can
        // account for the gap. Gated on `heal` because only a wide re-scan has
        // looked at enough of the feed for an empty plan to mean anything; on a
        // short routine window it would prove nothing.
        //
        // But an empty plan alone is NOT proof the baseline is wrong — learned
        // live on 2026-07-30, the day this feature shipped. A bank had POSTED a
        // $1,300 deposit that SimpleFin's transaction list had not reported yet:
        // the balance included it, the feed didn't, and the gap was constant
        // across the whole window — the exact signature this reads as a bad
        // baseline. The offer was made, taken, and the feed caught up the same
        // day: $1,300 counted twice. What tells the two apart is TIME. A wrong
        // baseline has been wrong since the day it was written and never
        // resolves itself; feed lag is new and clears in days. So the drift
        // episode must have been standing longer than lag can plausibly last
        // before the baseline gets the blame. No episode means the drift can't
        // be dated, which is treated as young, not as old.
        const planIsEmpty =
          plan.creates.length === 0 && plan.updates.length === 0 && plan.deleteIds.length === 0;
        const episode = driftAlerts[sfAccount.id];
        const driftIsLongStanding =
          episode != null &&
          Date.now() - Date.parse(episode.firstDetectedAt) >= BASELINE_FIX_MIN_DRIFT_AGE_MS;
        if (heal && planIsEmpty && driftIsLongStanding && drift != null) {
          const baseline = await fetchStartingBalance(host, wfAccountId, sfAccount.id).catch(
            () => null,
          );
          // No baseline row means there is nothing to correct — the drift is
          // real and unexplained, and a plug stays the only remedy.
          if (baseline) {
            baselineFix = {
              activityId: baseline.id,
              currentAmount: baseline.signed,
              suggestedAmount: Math.round((baseline.signed + drift) * 100) / 100,
            };
          }
        }
        // Aggressive auto-heal: plug the residual — but never a YOUNG episode.
        // A bank balance that includes posted activity the feed hasn't
        // published yet reads as drift; plugging it "fixes" the number today
        // and double-counts it when the feed catches up, whereupon the flipped
        // drift gets plugged the other way: two garbage rows, no human
        // involved. An episode has to out-live plausible lag before the plug
        // fires. Drifts too small to open an episode (under the alert
        // threshold) plug immediately — the $2-divergence case this feature
        // was built for, where waiting 10 days would make it useless.
        // At most one adjustment per account per day either way, so a stale
        // valuation on a rapid re-sync can't stack duplicates.
        const openEpisode = driftAlerts[sfAccount.id];
        // No episode yet + over the alert threshold = an episode is about to
        // open at age ZERO later this run — the youngest possible drift, not a
        // datable-as-old one. Treating it as plug-eligible would fire on the
        // very first sight of every large drift, which is the exact reflex this
        // gate exists to stop.
        const youngEpisode = openEpisode != null
          ? Date.now() - Date.parse(openEpisode.firstDetectedAt) < BASELINE_FIX_MIN_DRIFT_AGE_MS
          : driftAlertThresholdCents > 0 &&
            Math.abs(Math.round((drift ?? 0) * 100)) > driftAlertThresholdCents;
        if (heal && autoAdjust && drift != null && !youngEpisode) {
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
          // Already plugged, so there is nothing left for the user to accept —
          // and offering a baseline correction for a gap this run just filled
          // would double the fix.
          baselineFix = undefined;
        }
      }
    }
    accountBalances[sfAccount.id] = {
      balance: Number.isFinite(sfBalance) ? sfBalance : null,
      currency: sfAccount.currency,
      date: sfAccount['balance-date'],
      drift,
      // `measuredDrift` is the run's only trustworthy figure — non-null exactly when
      // the account was comparable — so it, not `drift`, decides this. `drift`
      // additionally goes null for "in sync" and for "plugged this run".
      measured: measuredDrift !== null,
      ...(baselineFix ? { baselineFix } : {}),
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
            // Just opened, so by definition young — and a young unexplainable
            // drift is usually the bank's balance ahead of its own feed.
            phase: 'young',
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
            phase: 'young',
          });
        } else if (
          !open.alertedAged &&
          Date.now() - Date.parse(open.firstDetectedAt) >= BASELINE_FIX_MIN_DRIFT_AGE_MS
        ) {
          // The episode has out-lived what feed lag can plausibly last — the
          // soft young notice was wrong to be calm, so say so once, with the
          // alarm styling. The CURRENT figure, not the opening one: ten days
          // on, the original is stale.
          driftAlerts[sfAccount.id] = { ...open, alertedAged: true };
          driftAlertsChanged = true;
          balanceDriftAlerts.push({
            sfinAccountId: sfAccount.id,
            accountName: wfNames.get(wfAccountId) || sfAccount.name,
            driftAmount: measuredDrift,
            currency: sfAccount.currency,
            bankBalance: sfBalance,
            phase: 'aged',
          });
        }
      } else if (open) {
        delete driftAlerts[sfAccount.id];
        driftAlertsChanged = true;
      }
    }
    // Dated AFTER the episode update, so a drift whose episode opened THIS run
    // still reads as young (age zero) rather than undatable.
    accountBalances[sfAccount.id].driftSince =
      driftAlerts[sfAccount.id]?.firstDetectedAt ?? null;

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
      comment: `${t.inTransit ? IN_TRANSIT_COMMENT_PREFIX : ''}${descByKey.get(accountTxKey(sfAccount.id, t.txId)) ?? ''} · ${t.txId}${t.pending ? PENDING_SUFFIX : ''}`,
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
      // Row-by-row fallback on a refusal: the bulk endpoint is all-or-nothing,
      // so one un-importable row would otherwise discard this account's whole
      // batch and report it as a quiet `0 imported`.
      const result = await saveWithRowFallback(host, {
        creates: plan.creates.map(toActivityCreate),
        updates: plan.updates.map((u) => toActivityUpdate(u.wfId, u.to)),
        deleteIds: plan.deleteIds,
      });
      // Only creates are new imports; updates/deletes are reconciliation.
      imported += result.created.length;
      for (const err of result.errors ?? []) {
        errors.push(`Account ${wfAccountId} save error (${err.action}): ${err.message}`);
      }

      /** The creates that actually reached the host — the only ones any later
       *  reasoning about "what this run changed" may believe. */
      const landedTxIds = new Set(
        result.created.map((a) => txIdFromComment(a.comment)).filter((t): t is string => !!t),
      );

      // windowDelta assumed every planned create would land, so a refused one leaves
      // the drift figure wrong by exactly its amount — reported as a gap on an
      // account whose ledger matches the bank to the penny. Seen live: a
      // re-authorised bank re-issued one $1,300 transaction under a new id, the
      // create was refused as a duplicate, and the account showed $1,300 of drift
      // that did not exist.
      //
      // The run is declared NOT MEASURABLE rather than corrected arithmetically.
      // `null` already means exactly that here, every normal sync with creates uses
      // it, and the next run measures accurately against a fresh valuation — where
      // re-deriving the figure would mean re-running the whole episode decision on a
      // number this run has not earned the right to state.
      if (driftAssumedCreates && driftAssumedCreates.some((id) => !landedTxIds.has(id))) {
        const snapshot = accountBalances[sfAccount.id];
        if (snapshot) {
          snapshot.drift = null;
          // Not just "no drift to report" — nothing was verified, and the account
          // list must not claim otherwise.
          snapshot.measured = false;
          snapshot.baselineFix = undefined;
          snapshot.driftSince = driftAlertBefore?.firstDetectedAt ?? null;
        }
        // Put the episode ledger back, so a phantom cannot open an episode (or
        // announce one) that a later run then has to reason about.
        if (driftAlertBefore === undefined) delete driftAlerts[sfAccount.id];
        else driftAlerts[sfAccount.id] = driftAlertBefore;
        balanceDriftAlerts.length = driftAlertsCountBefore;
        console.log(
          `[simplefin-sync] ${sfAccount.name}: drift not measurable — ` +
          `${driftAssumedCreates.filter((id) => !landedTxIds.has(id)).length} planned ` +
          'create(s) did not land, so the window delta it assumed is wrong.',
        );
      }
      // Recovering history older than the starting-balance baseline double-counts
      // it (the baseline already includes those rows), so net them back out.
      if ((result.errors ?? []).length === 0) {
        try {
          await adjustStartingBalanceForOlderRows(host, {
            wfAccountId,
            sfinAccountId: sfAccount.id,
            currency: sfAccount.currency,
            // LANDED creates only. This rewrites the starting balance, so netting
            // out a row that was refused moves real money for a row that does not
            // exist. It used to be shielded by the error a duplicate raised; now
            // that a duplicate is (correctly) not an error, the filter is the guard.
            created: plan.creates
              .filter((t) => !t.pending && landedTxIds.has(t.txId))
              .map((t) => ({
                date: t.date,
                signed: signedByKey.get(accountTxKey(sfAccount.id, t.txId)) ?? 0,
              })),
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
          linkRowByKey.set(accountTxKey(sfAccount.id, txId), {
            wfId: a.id, wfAccountId: t.wfAccountId, txId, absCents: t.absCents,
            type: t.type, date: t.date, pending: t.pending, currency: sfAccount.currency,
            sourceGroupId: a.sourceGroupId ?? null, sfAccountId: sfAccount.id,
          });
          // Every confirmed create is announced on the import notice. Off the
          // echo for the same reason as the large-spend alert below: a create
          // the host rejected is not in `result.created` and says nothing.
          importedTransactions.push({
            txId,
            sfAccountId: sfAccount.id,
            description: descByKey.get(accountTxKey(sfAccount.id, txId)) ?? '',
            amountCents: t.absCents,
            currency: sfAccount.currency,
            accountName: wfNames.get(t.wfAccountId) || sfAccount.name,
            activityType: t.type,
            pending: !!t.pending,
            inTransit: !!t.inTransit,
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
              description: descByKey.get(accountTxKey(sfAccount.id, txId)) ?? '',
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
        const prior = linkRowByKey.get(accountTxKey(sfAccount.id, txId));
        linkRowByKey.set(accountTxKey(sfAccount.id, txId), {
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
          sfAccountId: sfAccount.id,
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
        .reduce((sum, t) => sum + (signedByKey.get(accountTxKey(sfAccount.id, t.txId)) ?? 0), 0);
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
          comment: `${STARTING_BALANCE_COMMENT_PREFIX}${sfAccount.id}`,
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
              comment: `${STARTING_BALANCE_COMMENT_PREFIX}${p.sfinAccountId}`,
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
  // Legs handed to `linkPair` this run, keyed per LEG. Consulted by the relink
  // sweep at the end of the run, which asks "was THIS ROW already dealt with" —
  // a question a bare tx id cannot answer once two accounts share one.
  const linkedKeys = new Set<string>();
  // Each entry carries the two per-leg ledger keys alongside the legs, because
  // `LinkLeg.accountId` is the WEALTHFOLIO id while these keys are SimpleFin-
  // scoped — the leg alone cannot rebuild its own key.
  const pairsToLink: Array<{ legs: [LinkLeg, LinkLeg]; keys: [string, string] }> = [];
  const toLinkLeg = (row: LinkableRow): LinkLeg => {
    const descKey = accountTxKey(row.sfAccountId, row.txId);
    let comment = row.comment ?? `${descByKey.get(descKey) ?? ''} · ${row.txId}`;
    if (!comment.endsWith(` · ${row.txId}`)) {
      const desc = descByKey.get(descKey) ?? (comment.includes(' · ') ? comment.split(' · ')[0] : comment);
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
  for (const { out, in: inLeg } of detection.pairs) {
    // Resolved per (account, tx id). When SimpleFin gave both sides of the
    // transfer ONE id these two keys still differ — by account — which is what
    // keeps them two distinct rows in two accounts instead of one row twice.
    const outKey = accountTxKey(out.accountId, out.txId);
    const inKey = accountTxKey(inLeg.accountId, inLeg.txId);
    const outRow = linkRowByKey.get(outKey);
    const inRow = linkRowByKey.get(inKey);
    if (!outRow || !inRow) continue; // a leg isn't imported yet — links next run
    const alreadyLinked = readsGroups
      // The rows themselves say so: both in the same, non-empty group.
      ? !!outRow.sourceGroupId && outRow.sourceGroupId === inRow.sourceGroupId
      : ledgerLinkedKeys.has(outKey) && ledgerLinkedKeys.has(inKey);
    if (alreadyLinked) continue;
    // KNOWN GAP (accepted, tracked as a follow-up — not fixed here):
    // `linkedKeys` is populated BEFORE `host.linkPair` runs below, so on a
    // ledger-backed host (`readsGroups === false`) a link that then fails is
    // still recorded as linked. The relink sweep uses this same ledger to
    // decide what needs attention, so it permanently skips that pair, leaving
    // an asset-backed leg in place. The user-visible symptom is a wrong
    // account balance appearing months later with no obvious cause — which is
    // exactly why this note is here rather than left to be rediscovered from
    // the balance. Fix shape: move these two adds to after a confirmed
    // successful `linkPair`, alongside the existing `linkFailures` handling.
    linkedKeys.add(outKey);
    linkedKeys.add(inKey);
    pairsToLink.push({ legs: [toLinkLeg(outRow), toLinkLeg(inRow)], keys: [outKey, inKey] });
  }

  const linkFailures = await store.getTransferLinkFailures();
  let linkFailuresChanged = false;
  const stuckTransferAlerts: SyncResult['stuckTransferAlerts'] = [];

  let unlinkedLegs = 0;
  // Reporting the REASON a link failed is bounded, because a systematically
  // broken account would otherwise push one error per pair per sync. The
  // reasons are the diagnosis; the `unlinkedLegs` count below is the scale.
  const LINK_PROBLEM_REPORT_LIMIT = 3;
  let pairsWithReportedProblems = 0;
  for (const { legs, keys } of pairsToLink) {
    let result: LinkResult;
    try {
      result = await host.linkPair(legs);
    } catch (e: any) {
      errors.push(`Transfer-link failed (${legs[0].txId}/${legs[1].txId}): ${e?.message ?? e}`);
      continue; // leave the ledger untouched so the pair retries next run
    }
    if (!result.linked || !result.groupId) {
      unlinkedLegs += legs.length;
      // Linking is delete-then-re-create, so a refused re-create has ALREADY
      // removed both rows. That is never acceptable to report as a bare count,
      // and — unlike the summary line below — it must not wait for a heal: a
      // routine sync can lose rows too.
      if ((result.problems?.length ?? 0) > 0 && pairsWithReportedProblems < LINK_PROBLEM_REPORT_LIMIT) {
        pairsWithReportedProblems++;
        for (const p of result.problems!) {
          errors.push(`Transfer-link failed (${legs[0].txId}/${legs[1].txId}): ${p}`);
        }
      }
    }

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
    for (const [i, leg] of legs.entries()) {
      const key = keys[i];
      if (result.linked && result.groupId) {
        if (ledger[key] !== result.groupId) {
          ledger[key] = result.groupId;
          ledgerChanged = true;
        }
        // Retire the bare-txId entry this per-leg key supersedes, so the legacy
        // shape drains as pairs are confirmed rather than shadowing the new one
        // indefinitely.
        if (leg.txId in ledger) {
          delete ledger[leg.txId];
          ledgerChanged = true;
        }
      } else {
        // Purge BOTH shapes, or a stale legacy entry would keep vouching for a
        // pair whose link just failed.
        for (const stale of [key, leg.txId]) {
          if (stale in ledger) {
            delete ledger[stale];
            ledgerChanged = true;
          }
        }
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
  for (const [key, row] of linkRowByKey) {
    if (!isTransferType(row.type) || !row.assetId || linkedKeys.has(key)) continue;
    staleLegIds.push(row.wfId);
    relinkCreates.push({
      accountId: row.wfAccountId,
      activityType: row.type,
      activityDate: row.date,
      amount: row.absCents / 100,
      currency: row.currency,
      comment: row.comment ?? `${descByKey.get(key) ?? ''} · ${row.txId}`,
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
  // Written only when a match consumed something, so the common no-Amazon run
  // never touches the secret. A failure here is not worth failing the sync over:
  // the cost is that a record stays live and may be re-offered next run, which
  // the unique-match rule already makes safe.
  if (amazonLedgerChanged) {
    await store.setAmazonLedger(amazonLedger).catch((e) => {
      errors.push(`Could not save Amazon order ledger: ${String(e?.message ?? e)}`);
    });
  }

  await store.setAccountBalances(accountBalances);

  await store.setLastSyncAt(new Date());

  return {
    imported, skipped, errors, stuckTransferAlerts, importedTransactions,
    largeTransactionAlerts, balanceDriftAlerts, prunedDuplicates,
  };
}
