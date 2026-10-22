import { findIgnored, normalizeIgnoreRules } from './ignore-rules.js';
import { bankFirstTransferOut, genericTransferNeedsCorroboration } from './bank-first-payment.js';
import { fillFeedCurrencies } from './feed-currency.js';
import { learnedNameKeys, learnedTransferType } from './transfer-names.js';
import { mapTransactionWithSource, type MappedType } from './mapper.js';
import { REIMBURSEMENT_SUBTYPE } from './cash-flow-bucket.js';
import { accountTxKey, detectTransferPairs, TRANSFER_MATCH_WINDOW_SECONDS } from './transfers.js';
import type { TransferCandidate } from './transfers.js';
import { planReconciliation, IN_TRANSIT_COMMENT_PREFIX } from './reconcile.js';
import { accountTag, feedPrices, toHoldingsSnapshot } from './holdings.js';
import { loanBalanceOf, type LinkedLoan, type LoanLinks } from './loan-balances.js';
import type { FeedTx, ExistingRow } from './reconcile.js';
/** Re-exported from reconcile.ts (which defines it, so `changed()` can recognise
 *  the marker without importing sync-core and creating a cycle). This module owns
 *  WRITING the prefix, so importers keep finding the name here. */
export { IN_TRANSIT_COMMENT_PREFIX };
import {
  matchAmazonCharge, consumeAmazonMatch, amazonDescription,
} from './amazon-ledger.js';
import type { AmazonLedger } from './amazon-ledger.js';
import {
  consumeVenmoMatch, isReadableVenmoLedger, matchVenmoPayments, venmoDescription, type VenmoLedger, type VenmoMatch,
} from './venmo-ledger.js';
import type { AccountMapping, ActivityType, SimplefinAccount, SimplefinTransaction, UnmappedAccount } from './types.js';
import type { ActivityWrite, HoldingsSyncOutcome, HostActivity, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';
import { unlinkPairByRecreate, type UnlinkLeg, type UnlinkResult } from './link-pair.js';
import { ledgerGroupId } from './link-in-place.js';
import {
  amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange, duplicateRemovedChange,
  importChange, pendingRemovedChange, stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange,
  transferTypeChange, venmoNoteChange,
  type BaselineState, type ChangeAccount, type ChangeDraft, type ChangeEntry, type ChangeLogSink, type LinkLegFacts,
} from './change-entries.js';
import { emptySyncOverrides, hasAccountOverride, hasTxOverride, syncOverridesIgnoredLog } from './sync-overrides.js';
import { bankDayInstant } from './bank-day.js';
import { checkedLine, gateLine, requestLogIo, reserveSimplefinRequest } from './simplefin-budget.js';

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
/** The spending category the companion files a card's opening debt under
 *  (companion/src/opening-balance-category.ts), which Wealthfolio is told to
 *  leave out of spending. Here so the story can recognise that filing. */
export const OPENING_BALANCES_CATEGORY = 'Opening balances';

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

/** Grep token for "this leg was carrying its partner's identity". */
export const OVERWRITTEN_LEG_LOG_TAG = 'overwritten-leg';

/**
 * Stored transfer legs whose note — and so whose transaction id — belongs to
 * ANOTHER account's transaction, each matched to the feed transaction in THIS
 * account it really is.
 *
 * How a leg ends up like that: Wealthfolio 3.8 copies an updated leg's date and
 * note onto its linked partner (activities_service.rs, `build_counterpart_update`),
 * and the note is where the sync keeps the bank's transaction id. From then on
 * the partner reads as the other account's transaction, its own bank transaction
 * looks new, and the create is refused — the stored fingerprint still describes
 * the original — or, when the amount moved too, lands as a second copy. Live on
 * 2026-10-09: two card payments and a savings transfer carried PNC's id.
 *
 * Deliberately narrow, because matching here stops a transaction being imported:
 *  - the stored id must be one the bank reports for a DIFFERENT account on this
 *    run (`isOtherAccountsTx`) and not for this one — an id that merely aged out
 *    of every feed is an old row, not an overwritten one;
 *  - transfer-typed, posted, not one of the sync's own bookkeeping rows;
 *  - the feed transaction has no stored row, is posted, moves money the same way
 *    for the same amount, and is dated within the transfer-pairing window.
 * A match is taken only when it is the one possible (see below).
 */
export function planOverwrittenLegAdoptions<R extends ExistingRow>(
  feed: FeedTx[],
  existing: R[],
  isInflow: (txId: string) => boolean,
  isOtherAccountsTx: (txId: string) => boolean,
): Array<{ row: R; tx: FeedTx }> {
  const feedIds = new Set(feed.map((t) => t.txId));
  const storedIds = new Set(existing.map((r) => r.txId));
  const rows = existing.filter((r) =>
    !feedIds.has(r.txId) && isOtherAccountsTx(r.txId) && isTransferType(r.type)
    && !r.pending && !isInternalMarkerComment(r.comment));
  const unstored = feed.filter((t) => !storedIds.has(t.txId) && !t.pending);
  const windowDays = TRANSFER_MATCH_WINDOW_SECONDS / 86_400;
  const dayGap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  const candidatesOf = (row: R) => unstored.filter((t) =>
    t.absCents === row.absCents && isInflow(t.txId) === (row.type === 'TRANSFER_IN')
    && dayGap(t.date, row.date) <= windowDays);

  // Only an UNAMBIGUOUS match is adopted: one candidate, wanted by no other row.
  // Two same-amount transactions in the window could be this leg or a genuinely
  // new transfer, and guessing wrong would hide the new one. Left alone, both
  // still reach the planner — the new one imports, and the worst case for the
  // real one is the refusal this function exists to prevent, said once.
  const candidates = new Map(rows.map((r) => [r, candidatesOf(r)]));
  const wantedBy = new Map<string, number>();
  for (const list of candidates.values()) {
    for (const t of list) wantedBy.set(t.txId, (wantedBy.get(t.txId) ?? 0) + 1);
  }
  const out: Array<{ row: R; tx: FeedTx }> = [];
  for (const [row, list] of candidates) {
    if (list.length === 1 && wantedBy.get(list[0].txId) === 1) out.push({ row, tx: list[0] });
  }
  return out;
}

/**
 * The feed transaction as the planner should see it when its stored row is one
 * leg of a LINKED transfer: keep the stored type and date, and none of this run's
 * in-transit or expiry decisions.
 *
 * Those decisions are made from whether the partner is in THIS run's feed, and a
 * routine sync only looks back two weeks — so a linked leg whose partner posted a
 * day or two earlier routinely finds itself "unpaired" and gets rewritten as an
 * in-transit placeholder, or past ten days as a plain deposit or withdrawal. Each
 * rewrite is an update, and Wealthfolio copies an updated leg's note and date onto
 * its partner: the start of every overwritten leg `planOverwrittenLegAdoptions`
 * has to recover. A real change of amount still goes through.
 */
export function keepLinkedLegAsStored(tx: FeedTx, row: ExistingRow | undefined, linked: boolean): FeedTx {
  if (!row || !linked || !isTransferType(row.type) || row.pending || tx.pending) return tx;
  const { inTransit: _inTransit, needsReview: _needsReview, subtype: _subtype, ...rest } = tx;
  return { ...rest, type: row.type, date: row.date };
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
 *    `CREDIT` is the type `neutralAdjustmentFields` picks for a CASH inflow
 *    precisely BECAUSE Wealthfolio classifies it as Ignored (neither spending
 *    nor income). Alerting on it would ping the user about the sync's own
 *    bookkeeping.
 *  - `TRANSFER_IN` / `TRANSFER_OUT` — moving your own money between accounts,
 *    which the spending query excludes and Wealthfolio nets out once linked;
 *    since v1.49 every outflow placeholder and plug is a TRANSFER_OUT too.
 *  - `ADJUSTMENT` / `UNKNOWN` and the investment types — not cash spending.
 *
 * `FEE`/`TAX` are only reachable through a user mapping rule (`mapper.ts` never
 * infers them), but a $2,000 wire fee is exactly the sort of thing this alert
 * exists for, so they are in.
 */
const SPENDING_TYPES = new Set<string>(['WITHDRAWAL', 'FEE', 'TAX']);

/** The "no positions were written" outcome. A function, not a shared constant:
 *  every result owns its own object, so a caller mutating one can never reach
 *  back into this module. */
const noHoldings = (): HoldingsSyncOutcome => ({ imported: 0, skipped: 0, unresolvedSymbols: [] });

/** A run that sent nothing to SimpleFin and changed nothing. A function for the
 *  same reason as `noHoldings`: every result owns its arrays. */
const notDownloaded = (): SyncResult => ({
  imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [], importedTransactions: [], largeTransactionAlerts: [],
  balanceDriftAlerts: [], prunedDuplicates: [], unmappedAccounts: null, refusedCreates: [], holdingsSnapshots: noHoldings(),
});

export interface SyncResult {
  imported: number;
  skipped: number;
  errors: string[];
  /** Investment-account positions written this run. All zeroes on a host with no
   *  snapshot capability, and on a set of accounts that publishes no holdings —
   *  which is every bank and card account. */
  holdingsSnapshots: HoldingsSyncOutcome;
  /** Present only on a run the SimpleFin budget stopped (shared/simplefin-budget.ts):
   *  `checkOnly` re-checked balances against the last download, `skipped` was
   *  refused by the daily limit, the gap or an unreadable request record. `line`
   *  is the one sentence to show. Never an error: nothing went wrong.
   *  `lastAt` (checkOnly only): when the newest request was sent, epoch ms, so a
   *  Deep scan can say when it may download (F3b). */
  download?: { kind: 'checkOnly' | 'skipped'; line: string; lastAt?: number };
  /** Bank transactions this run left out because one of the user's ignore rules
   *  (shared/ignore-rules.ts) matched them. Absent on a run that returned before
   *  reading the feed, and 0 when no rule matched anything. */
  ignoredByRules?: number;
  /** Loan balances written to a linked liability this run (shared/loan-balances.ts).
   *  Absent on a run that returned before reading the feed. */
  loanBalancesRecorded?: number;
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
    /** Which way the money moved, from the FEED's signed amount — the one
     *  source that stays honest for a placeholder, whose stored type (a CASH
     *  inflow books as a bare CREDIT) says nothing about the pairing. */
    direction: 'in' | 'out';
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
    /** 1.61: the row this run created — the alert's 🔎 Why? opens its story.
     *  Absent on an alert an older build queued in the outbox. */
    activityId?: string;
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
     *  deleted row: a placeholder written before v1.49 booked its amount as
     *  `fee`, so its stored `amount` is 0 and reporting it would claim
     *  "$0.00 removed". */
    amountCents: number;
    currency: string;
    /** The deleted Wealthfolio activity id, so the deletion is traceable. */
    wfId: string;
  }>;
  /**
   * SimpleFin accounts the feed returned that no mapping points at, so this run
   * imported NOTHING from them.
   *
   * Skipping an unmapped account is correct — the user may deliberately not
   * track it — but doing so SILENTLY is not: a newly-linked bank (Robinhood
   * Gold, 2026-08-13) syncs "successfully" while none of its transactions ever
   * appear, and nothing anywhere says why. Reported so the addon can offer to
   * map it and the companion can announce it once.
   *
   * Every run recomputes this from the live feed; it is not a ledger. The
   * once-only guarantee for the Telegram notice belongs to the companion's own
   * announced-ids ledger, exactly as the drift and stuck-transfer alerts work.
   */
  /**
   * `null` when this run never LOOKED — an interval skip, or a pre-flight
   * return for missing configuration. Distinct from `[]`, which means the feed
   * was read and every account in it is mapped.
   *
   * The distinction is load-bearing, and it is the same one `measured` draws
   * for drift. The companion's notice keeps a once-only ledger keyed on these
   * ids and CLEARS it when nothing is unmapped (so a re-linked account is
   * announced again). Handing it `[]` for a run that read nothing would clear
   * that ledger on every interval-skipped startup sync — and this container is
   * restarted by hand often — re-announcing the same account indefinitely.
   */
  unmappedAccounts: UnmappedAccount[] | null;
  /**
   * Creates the host REFUSED — planned because no stored row carried that
   * transaction id, then rejected anyway by Wealthfolio's own date+amount
   * duplicate check.
   *
   * Every one of these is a transaction the bank reported and Wealthfolio does
   * not have. Usually harmless (a re-sent copy of something already stored
   * under a different id), but not always: on 2026-06-26 a REAL $1,300
   * withdrawal was refused as a duplicate of its same-amount sibling from the
   * day before, and the account sat $1,300 wrong for six weeks because nothing
   * said so. It was logged at debug level and never surfaced.
   *
   * Reported so a human can look. Deliberately not auto-retried or force-created:
   * the refusals really are duplicates most of the time, and inventing a second
   * copy of a real transaction is the worse error.
   */
  refusedCreates: Array<{
    txId: string;
    description: string;
    amountCents: number;
    currency: string;
    accountName: string;
    /** YYYY-MM-DD. */
    date: string;
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
  /**
   * Where this run's change-log entries go (shared/change-log.ts). Absent —
   * an older host, a test that does not care — means nothing is recorded and
   * nothing about the run changes. The core collects an entry for every write
   * that SUCCEEDED and appends them once, at the end, best-effort: a failed
   * append is caught here and never alters the result.
   */
  changeLog?: ChangeLogSink;
  /**
   * A person asked for this run (the Sync button, Deep scan, the companion's
   * `/sync`). In 1.64 it only turns on the add-on's whole-history card read,
   * so a manual Sync can total every card after its own saves; a scheduled run
   * leaves cards "not checked" (R7).
   */
  manual?: boolean;
}

/**
 * The badge's verdict for a card totalled AFTER a run's own saves: `d` is the
 * bank's figure minus Wealthfolio's, to the cent; inside the display threshold
 * it is "in sync" (drift null). Always `measured`: the caller only asks once it
 * has a trustworthy posted total.
 */
export function badgeVerdict(bankBalance: number, wealthfolioFigure: number): { drift: number | null; measured: true } {
  const d = Math.round((bankBalance - wealthfolioFigure) * 100) / 100;
  return { drift: Math.abs(d) > DRIFT_THRESHOLD_DOLLARS ? d : null, measured: true };
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
   * Set ONLY by the after-save card check (1.64, B2) when it fills a verdict.
   * That figure is for the account-list BADGE alone (R15): it opened no drift
   * episode, so it has no `driftSince`, and the Home banner would otherwise
   * show it red with a one-click plug that skips the young-drift guard
   * (plugging feed lag double-counts the moment the feed catches up). Readers
   * that raise banners, plugs or report findings must ignore a tagged drift.
   */
  checkedAfterSave?: true;
  /** 1.65 C: the epoch this account's feed has proven itself alive through — the
   *  later of `date` and its newest datable transaction, exactly what the
   *  in-transit hold reads; lets the companion name the feed that holds a
   *  transfer open without a download. Absent = an older writer stored it. */
  aliveThrough?: number;
  /**
   * Epoch ms when the download that produced `balance`/`date` was sent. A
   * check-only pass (C3) compares these figures against Wealthfolio's current
   * state only while no NEWER request has been sent (R16): the figures are the
   * bank's as of this moment, and a request in flight may already be changing
   * the ledger under them. A snapshot written by an older build lacks it and is
   * therefore never compared.
   */
  fetchedAt?: number;
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

/** Activity types that take money OUT of an account. A starting balance is
 *  stored as a magnitude with the sign in its type, and since v1.51 a card's
 *  opening debt is a `TRANSFER_OUT` — reading only `WITHDRAWAL` as negative
 *  turned that debt into a credit the moment anything adjusted it. */
const OUTFLOW_TYPES = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX']);
/** Money out when a re-created leg's sign must come from its stored type. */
const UNLINK_OUTFLOW_TYPES = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'INTEREST']);

const isoDay = (date: string) => new Date(date).toISOString().slice(0, 10);
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * The account's starting-balance entry, if one exists, as a signed amount —
 * plus the date of the account's earliest OTHER row, which is what the
 * baseline has to stay in front of.
 *
 * The entry is a one-time baseline meaning "everything before this date is
 * already reflected in the bank's balance". It's calculated from the first
 * sync's window, so any transaction later imported with an EARLIER date (a wide
 * re-scan reaching further back) would be counted twice — once in the baseline
 * and again as its own activity. `keepStartingBalanceOldest` corrects the
 * baseline when that happens; this reads the row it has to correct.
 *
 * The ascending scan finds it on a healthy ledger, where it is the oldest row.
 * `recent` is the fallback for the ledger this function exists to repair: a
 * backfill of more than a scan's worth of older rows pushes the baseline out of
 * that window, and a lookup that then reports "no baseline" would leave it
 * stranded after the history it stands in for.
 */
async function fetchStartingBalance(
  host: SyncHost,
  wfAccountId: string,
  sfinAccountId: string,
  recent: ReadonlyArray<{ wfId: string; comment?: string; date: string; type: string; absCents: number }> = [],
): Promise<{ id: string; date: string; signed: number; activityType: string; earliestOther: string | null } | null> {
  const rows = await host.listOldestActivities(wfAccountId, STARTING_BALANCE_SCAN);
  const marker = `${STARTING_BALANCE_COMMENT_PREFIX}${sfinAccountId}`;
  const others = rows.filter((a) => (a.comment ?? '') !== marker).map((a) => isoDay(a.date));
  const earliestOther = others.length ? others.reduce((a, b) => (a < b ? a : b)) : null;
  const row = rows.find((a) => (a.comment ?? '') === marker);
  let found: { id: string; date: string; type: string; abs: number } | null = row
    ? { id: row.id, date: isoDay(row.date), type: String(row.activityType), abs: Math.abs(parseFloat(String(row.amount ?? '0'))) }
    : null;
  if (!found) {
    const r = recent.find((a) => (a.comment ?? '') === marker);
    if (r) found = { id: r.wfId, date: r.date, type: r.type, abs: r.absCents / 100 };
  }
  if (!found) return null;
  return {
    id: found.id,
    date: found.date,
    signed: OUTFLOW_TYPES.has(found.type) ? -found.abs : found.abs,
    activityType: found.type,
    earliestOther,
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
): Promise<SaveManyResult & { deleted: string[] }> {
  const bulk = await attemptSave(host, req);
  // `deleted`: the delete ids whose request came back clean — the only deletes
  // the change log may claim. The error shape cannot say which id failed.
  if ((bulk.errors ?? []).length === 0) return { ...bulk, deleted: [...(req.deleteIds ?? [])] };

  const created = [...(bulk.created ?? [])];
  const updated = [...(bulk.updated ?? [])];
  const errors: SaveManyResult['errors'] = [];

  // What the refused batch nonetheless managed to store.
  const landedCreates = new Set(
    created.map((a) => txIdFromComment(a.comment)).filter((t): t is string => !!t),
  );
  const landedUpdates = new Set(updated.map((a) => a.id).filter((id): id is string => !!id));

  let deleted: string[] = [];
  if ((req.deleteIds ?? []).length > 0) {
    const del = await attemptSave(host, { deleteIds: req.deleteIds });
    for (const e of del.errors ?? []) errors.push(e);
    if ((del.errors ?? []).length === 0) deleted = [...req.deleteIds!];
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
        // The host's own words name the stored row it matched ("(id: …)"), which
        // is the one fact needed to find out why reconcile did not recognise it.
        console.log(`[simplefin-sync] ${DUPLICATE_REFUSAL_LOG_TAG} (create): ${c.comment} — ${msg}`);
      } else {
        errors.push({ action: 'create', message: `${msg} [${c.comment}]` });
      }
    }
  }

  return { created, updated, errors, deleted };
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
): Promise<{ applied: boolean; error?: string; change?: BaselineMove }> {
  const { wfAccountId, sfAccountId, suggestedAmount, currency } = args;
  // Re-read instead of trusting the id the snapshot was built with: that
  // snapshot can be minutes old, and this writes to a financial row by id.
  const baseline = await fetchStartingBalance(host, wfAccountId, sfAccountId).catch(() => null);
  if (!baseline) return { applied: false, error: 'no starting-balance row on this account' };
  const accountType = String(
    (await host.listAccounts().catch(() => [])).find((a) => a.id === wfAccountId)?.accountType ?? '',
  );
  // `amount` is a magnitude — the sign lives in the type, so a correction that
  // crosses zero has to change the type or it lands with the old one. Chosen by
  // the same function that wrote the row: a hard-coded DEPOSIT/WITHDRAWAL here
  // turned a neutral cash baseline back into income, and on a card wrote a type
  // the API refuses (DEPOSIT) or a purchase (WITHDRAWAL).
  const shape = startingBalanceFields(accountType, suggestedAmount, bookkeepingShapeOf(host));
  const activityType = keepBookkeepingOutflow(accountType, baseline.activityType, shape.activityType);
  const res = await host.saveMany({
    updates: [
      {
        id: baseline.id,
        accountId: wfAccountId,
        activityType,
        activityDate: bankDayInstant(baseline.date),
        // No symbol, as before: the stored asset is left as it is, and a card
        // baseline's transfer leg must never gain one (it would become the
        // phantom "$CASH" security and stop booking cash).
        amount: shape.amount,
        currency,
        comment: `${STARTING_BALANCE_COMMENT_PREFIX}${sfAccountId}`,
      },
    ],
  });
  if (res.errors.length > 0) {
    return { applied: false, error: res.errors.map((e) => `${e.action}: ${e.message}`).join('; ') };
  }
  return {
    applied: true,
    // For the change log: what the row was and what it is now.
    change: {
      activityId: baseline.id,
      before: { amountCents: Math.round(baseline.signed * 100), date: baseline.date, activityType: baseline.activityType },
      after: { amountCents: Math.round(suggestedAmount * 100), date: baseline.date, activityType },
    },
  };
}

/** A starting balance rewritten in place: the row, before and after. */
export interface BaselineMove { activityId: string; before: BaselineState; after: BaselineState }

/**
 * Keep the starting-balance baseline in front of the history it stands for.
 *
 * Two duties, one update:
 *  - AMOUNT. When a run imports transactions dated BEFORE the baseline, those
 *    rows are already baked into it, so leaving it alone double-counts them (the
 *    classic symptom: an account drifts by exactly the sum of the newly-recovered
 *    history). Subtracting their signed total nets them out, so the balance stays
 *    correct no matter how far back a later re-scan reaches.
 *  - DATE. Netting fixes today's balance but not the path to it: a baseline left
 *    on its old date sits AFTER the recovered rows, so Wealthfolio replays them
 *    against an empty account and its early history goes negative (live: Savings
 *    −$1,300 from 2026-04-23 behind a 2026-06-19 baseline). The baseline moves to
 *    the day before the earliest other row. Checked on every run, not only when
 *    rows arrive, so a ledger netted by an older version heals too.
 *
 * Moving the date moves no money. The amount changes only by the netted sum.
 */
async function keepStartingBalanceOldest(
  host: SyncHost,
  args: {
    wfAccountId: string;
    sfinAccountId: string;
    currency: string;
    /** The Wealthfolio account type, so the rewritten row keeps the shape the
     *  original was written with — without it, adjusting a neutral baseline
     *  would silently turn it back into income. */
    accountType: string;
    /** Signed amounts of the rows just created, keyed by date (YYYY-MM-DD). */
    created: Array<{ date: string; signed: number }>;
    /** The account's already-read rows: the lookup's fallback. */
    recent?: ReadonlyArray<{ wfId: string; comment?: string; date: string; type: string; absCents: number }>;
  },
): Promise<BaselineMove | null> {
  const { wfAccountId, sfinAccountId, currency, accountType, created } = args;
  const sb = await fetchStartingBalance(host, wfAccountId, sfinAccountId, args.recent);
  if (!sb) return null;
  const older = created.filter((c) => c.date <= sb.date);
  const olderSum = older.reduce((sum, c) => sum + c.signed, 0);
  const netting = Number.isFinite(olderSum) && Math.abs(olderSum) >= 0.01;
  const earliest = [sb.earliestOther, ...older.map((c) => c.date)]
    .filter((d): d is string => !!d)
    .reduce<string | null>((a, b) => (a === null || b < a ? b : a), null);
  const nextDate = earliest !== null && earliest <= sb.date ? dayBefore(earliest) : sb.date;
  if (!netting && nextDate === sb.date) return null;
  const nextSigned = netting ? Math.round((sb.signed - olderSum) * 100) / 100 : sb.signed;
  const activityType = netting
    // Through the same chooser that wrote the row, or an adjustment would
    // quietly flip a neutral baseline back into income.
    ? keepBookkeepingOutflow(accountType, sb.activityType, startingBalanceFields(accountType, nextSigned, bookkeepingShapeOf(host)).activityType)
    : sb.activityType;
  const res = await host.saveMany({
    updates: [{
      id: sb.id,
      accountId: wfAccountId,
      activityType,
      activityDate: bankDayInstant(nextDate),
      // Only a non-transfer row that is being re-shaped states its cash symbol.
      // A TRANSFER leg carrying one becomes the phantom "$CASH" security and
      // stops moving cash, and a date-only move has no reason to touch the
      // asset at all (an omitted asset is left as stored).
      ...(netting && !isTransferType(activityType) ? { symbol: { symbol: `$CASH-${currency}` } } : {}),
      amount: Math.abs(nextSigned),
      currency,
      comment: `${STARTING_BALANCE_COMMENT_PREFIX}${sfinAccountId}`,
    }],
  });
  // What moved, for the change log — only when the host took the update.
  if ((res.errors ?? []).length > 0) return null;
  return {
    activityId: sb.id,
    before: { amountCents: Math.round(sb.signed * 100), date: sb.date, activityType: sb.activityType },
    after: { amountCents: Math.round(nextSigned * 100), date: nextDate, activityType },
  };
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

/**
 * The marker for the transfer-TYPED rows the sync writes as bookkeeping — an
 * opening balance, a drift plug, an in-transit placeholder. They are transfer
 * legs only because that is the spending-neutral shape (see
 * neutralAdjustmentFields); none has a partner to pair with.
 *
 * Wealthfolio 3.8's Health page reports every posted TRANSFER_IN/OUT that is
 * not half of a valid pair as an "incomplete transfer" error, unless its
 * metadata carries `flow.is_external: true` (health/service.rs,
 * `invalid_transfer_groups_from_activities`). The flag changes nothing on the
 * Spending page — the classifier never reads it — and for performance it
 * files the row as money crossing the portfolio boundary instead of
 * "unknown", which is what an opening balance or a plug is.
 */
export const EXTERNAL_BOOKKEEPING_METADATA = JSON.stringify({ flow: { is_external: true } });

/**
 * A stored row's `flow.is_external`: `true`/`false` when set, `null` when the
 * row has metadata but no such flag (or none at all), and `undefined` when the
 * host did not report metadata or it cannot be parsed — "unknown", which no
 * caller may treat as "unset" and write over.
 */
export function flowExternalOf(metadata: unknown): boolean | null | undefined {
  if (metadata === undefined) return undefined;
  if (metadata === null || metadata === '') return null;
  let parsed: unknown = metadata;
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return undefined;
    }
  }
  const flag = (parsed as { flow?: { is_external?: unknown } } | null)?.flow?.is_external;
  return typeof flag === 'boolean' ? flag : null;
}

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
type StoredRow = ExistingRow & { sourceGroupId?: string | null; flowExternal?: boolean | null };

async function fetchExistingRows(
  host: SyncHost,
  wfAccountId: string,
): Promise<StoredRow[]> {
  const data = await host.listActivities(wfAccountId);
  const rows: StoredRow[] = [];
  for (const a of data) {
    const pending = (a.comment ?? '').endsWith(PENDING_SUFFIX);
    const txId = txIdFromComment(a.comment);
    if (txId === null) continue;
    rows.push({
      wfId: a.id,
      wfAccountId,
      txId,
      absCents: Math.round(Math.abs(parseFloat(String(a.amount ?? '0'))) * 100),
      feeCents: Math.round(Math.abs(parseFloat(String(a.fee ?? '0')) || 0) * 100),
      type: String(a.activityType),
      date: new Date(a.date).toISOString().slice(0, 10),
      pending,
      assetId: a.assetId ? String(a.assetId) : undefined,
      comment: a.comment ?? undefined,
      // Both halves of the subtype comparison have to be real or `changed()`
      // decides on one: with the feed carrying a rule's subtype and this side
      // always blank, every subtyped row differs on every sync and is rewritten
      // forever. `?? undefined` because the adapters report "none" as `null`.
      subtype: a.subtype ?? undefined,
      sourceGroupId: a.sourceGroupId ?? null,
      flowExternal: flowExternalOf(a.metadata),
    });
  }
  return rows;
}

export const EXTERNAL_MARKER_STAMP_LOG_TAG = 'external-marker-stamp';

/**
 * The sync's own unlinked transfer-typed rows that still lack the external
 * marker (see EXTERNAL_BOOKKEEPING_METADATA), as metadata-only updates. Nothing
 * is written here.
 *
 * Deliberately narrow, because a wrong stamp is worse than a missing one:
 *  - Only rows the sync authored, by note marker. A user's own transfer is
 *    theirs to link or mark.
 *  - Only rows with NO group and a flag that is known to be unset. A linked
 *    leg carries `is_external: false`; flagging one leg of a pair external
 *    makes Wealthfolio report the pair as conflicting. A host that cannot
 *    report metadata (`undefined`) gets nothing, or it would re-stamp forever.
 * The server merges metadata keys on update and keeps it when an update omits
 * it, so a stamp survives later reconciliation updates and runs once.
 */
export function planExternalMarkerStamp(rows: ReadonlyArray<StoredRow>, currency: string): ActivityWrite[] {
  const updates: ActivityWrite[] = [];
  for (const row of rows) {
    if (!isTransferType(row.type) || row.sourceGroupId || row.flowExternal !== null) continue;
    const note = row.comment ?? '';
    if (
      !note.startsWith(STARTING_BALANCE_COMMENT_PREFIX) &&
      !note.startsWith(BALANCE_ADJUSTMENT_COMMENT_PREFIX) &&
      !note.startsWith(IN_TRANSIT_COMMENT_PREFIX)
    ) continue;
    updates.push({
      id: row.wfId,
      accountId: row.wfAccountId,
      activityType: row.type,
      activityDate: bankDayInstant(row.date),
      amount: row.absCents / 100,
      currency,
      comment: note,
      metadata: EXTERNAL_BOOKKEEPING_METADATA,
    });
  }
  return updates;
}

export const AMAZON_LATE_LABEL_LOG_TAG = 'amazon-late-label';

/**
 * Existing rows whose Amazon order email was read only after the row was
 * imported, as note-only updates. Nothing is written here.
 *
 * Needed because `changed()` (shared/reconcile.ts) never compares notes: a row
 * imported while its email was unreadable — Amazon's 2026-10 format change left
 * four charges that way — kept the bare bank text forever, so the Amazon filer
 * never saw a label and the charge never got its category.
 *
 * Deliberately narrow, because a note is the user's as much as the sync's:
 *  - Only a note in the sync's own unedited form, `<bank text> · <txId>`. An
 *    edited note, a pending one, or one already labelled is left alone, which
 *    is also what makes the pass idempotent across both writers.
 *  - Never a transfer-typed or grouped row: Wealthfolio copies an updated
 *    linked leg's note onto its partner. The type is the guard that holds on
 *    both writers — the addon host never reads `sourceGroupId`
 *    (`readsSourceGroupId: false`), so a linked leg arrives there ungrouped,
 *    but only transfer-typed rows are ever linked.
 *  - Labels are only ever added. Type, date and amount are passed through, the
 *    same shape as `planExternalMarkerStamp`.
 */
export function planAmazonLateLabels(
  rows: ReadonlyArray<StoredRow>,
  labelled: ReadonlyMap<string, { bare: string; enriched: string }>,
  currency: string,
): ActivityWrite[] {
  const updates: ActivityWrite[] = [];
  for (const row of rows) {
    if (isTransferType(row.type) || row.sourceGroupId || row.pending) continue;
    const hit = labelled.get(row.txId);
    if (!hit || (row.comment ?? '') !== `${hit.bare} · ${row.txId}`) continue;
    updates.push({
      id: row.wfId,
      accountId: row.wfAccountId,
      activityType: row.type,
      activityDate: bankDayInstant(row.date),
      amount: row.absCents / 100,
      currency,
      comment: `${hit.enriched} · ${row.txId}`,
    });
  }
  return updates;
}

const VENMO_UNREADABLE_ERROR = "Couldn't read the Venmo payments list — Venmo notes are off for this sync.";

export const VENMO_LATE_NOTE_LOG_TAG = 'venmo-late-note';

/**
 * Existing rows whose Venmo email was read only after the row was imported,
 * as note-only updates (3). The very same rules as `planAmazonLateLabels` —
 * only a note in the sync's own unedited form, never a transfer-typed, grouped
 * or pending row, the note only ever added — so it is that planner, applied
 * to the rows a Venmo payment matched this run.
 */
export function planVenmoLateNotes(
  rows: ReadonlyArray<StoredRow>,
  noted: ReadonlyMap<string, { bare: string; enriched: string }>,
  currency: string,
): ActivityWrite[] {
  return planAmazonLateLabels(rows, noted, currency);
}

export const LEGACY_PLACEHOLDER_REWRITE_LOG_TAG = 'legacy-placeholder-rewrite';

/**
 * The stored rows this sync wrote in its pre-v1.49 outflow shape — a `CREDIT`
 * with `amount` 0 and the money in `fee` — restated as `TRANSFER_OUT` with the
 * real amount (see neutralAdjustmentFields for why the old shape died with
 * Wealthfolio 3.8). Returns the updates to issue; nothing is written here.
 *
 * Only rows the sync itself authored qualify, recognised by their note marker
 * (a balance plug or an in-transit placeholder): a user's own `CREDIT` with a
 * fee — a wire that cost $25, say — is exactly the row this must never touch.
 * A fee-side row still in the feed would also be caught by reconciliation, so
 * the caller applies these updates to its in-memory snapshot first and the
 * planner then sees the row as already agreeing; a row already restated has
 * no fee and never matches again, which is what makes the pass idempotent.
 *
 * `needsReview: false` because 3.8's migration flags every such row (it keeps
 * the zero amount rather than inventing a negative CREDIT). The sync wrote the
 * row and knows the figure, so it clears the flag it caused.
 */
export function planLegacyPlaceholderRewrite(
  rows: ReadonlyArray<ExistingRow>,
  currency: string,
  accountType = 'CASH',
): ActivityWrite[] {
  // Through the shared chooser: a card refuses TRANSFER_OUT (see
  // neutralAdjustmentFields), so a card row restates as a WITHDRAWAL.
  const outflowType = neutralAdjustmentFields(accountType, -1).activityType;
  const updates: ActivityWrite[] = [];
  for (const row of rows) {
    if (row.type !== 'CREDIT' || row.absCents !== 0 || !(row.feeCents && row.feeCents > 0)) continue;
    const note = row.comment ?? '';
    if (!note.startsWith(BALANCE_ADJUSTMENT_COMMENT_PREFIX) && !note.startsWith(IN_TRANSIT_COMMENT_PREFIX)) continue;
    updates.push({
      id: row.wfId,
      accountId: row.wfAccountId,
      activityType: outflowType,
      activityDate: bankDayInstant(row.date),
      amount: row.feeCents / 100,
      fee: 0,
      currency,
      comment: note,
      needsReview: false,
    });
  }
  return updates;
}

/**
 * What a solo transfer leg becomes once the in-transit window has passed and
 * no counterpart ever came: ordinary money in or out, in the type the account
 * accepts. A card refuses DEPOSIT outright (live, 2026-08-07), and a positive
 * on a card that was never a payment IS a refund, so CREDIT is both the
 * accepted and the honest type there.
 */
export function expiredTransferLegType(accountType: string, signedAmount: number): ActivityType {
  if (accountType === 'CREDIT_CARD') {
    return (signedAmount >= 0 ? 'CREDIT' : 'WITHDRAWAL') as ActivityType;
  }
  return (signedAmount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL') as ActivityType;
}

/**
 * Feed-aware guard on the give-up above: giving up is only justified when the
 * counterpart HAD its chance to appear. Returns a mapped SimpleFin account id
 * whose feed has shown no life past the leg's pairing window — the account
 * where the missing counterpart may still be hiding — or null when every other
 * mapped feed is caught up, so a demotion to ordinary spending is honest.
 *
 * "Life" is the later of the account's `balance-date` (SimpleFin freezes it
 * when a connection breaks — the live case: Discover mid-transition published
 * nothing for weeks, and a real $87.26 card payment expired into spending,
 * 2026-08-30) and its newest datable transaction (for a bank whose balance
 * timestamp trails its transaction list). A mapped account absent from the
 * feed entirely has shown no life at all. The leg's OWN account never holds —
 * its feed evidently published the leg itself.
 *
 * A held leg keeps its spending-neutral placeholder shape. While the leg stays
 * inside the fetch window this re-evaluates every run, so a feed that heals in
 * time releases the hold and the leg pairs or expires normally. If the feed
 * stays dead until the leg ages out of the window, the placeholder simply
 * remains — permanently neutral, which for a transfer whose counterpart data
 * is lost is the correct resting state (a heal re-scan can still pair it if
 * the bank backfills). The deliberate trade: a stale feed can delay or freeze
 * a genuinely-external leg as a neutral $0 placeholder, which costs a lingering
 * row; the demotion it prevents costs phantom spending in every report and a
 * manual repair.
 */
export function expiryHoldAccount(
  legSfinAccountId: string,
  legPostedEpoch: number,
  mappedSfinIds: readonly string[],
  feedAliveEpoch: ReadonlyMap<string, number>,
  dead: { nowSec: number; legDescription: string; nameWords: ReadonlyMap<string, readonly string[]> },
): string | null {
  const caughtUpBy = legPostedEpoch + TRANSFER_MATCH_WINDOW_SECONDS;
  const description = dead.legDescription.toLowerCase();
  for (const id of mappedSfinIds) {
    if (id === legSfinAccountId) continue;
    const alive = feedAliveEpoch.get(id) ?? 0;
    if (alive >= caughtUpBy) continue;
    // Disconnected, not late: a feed silent this long holds only the legs that
    // name it. Holding EVERY leg on its account froze a $3,000 Spend → Savings
    // transfer as a placeholder for six weeks behind a dead Discover feed
    // (live, 2026-09-23); the Discover payment itself stays held.
    if (dead.nowSec - alive > DEAD_FEED_SECONDS) {
      // An account absent from the feed has no name to judge by, so it keeps
      // holding: unknown is not evidence the leg is unrelated.
      const words = dead.nameWords.get(id) ?? [];
      if (words.length > 0 && !words.some((w) => description.includes(w))) continue;
    }
    return id;
  }
  return null;
}

export interface StaleTransitContext {
  wfAccountId: string;
  sfinAccountId: string;
  accountType: string;
  /** Every transaction id in this account's download (frozen keys included):
   *  those rows take the in-feed path. */
  feedTxIds: ReadonlySet<string>;
  nowSec: number;
  mappedSfinIds: readonly string[];
  feedAliveEpoch: ReadonlyMap<string, number>;
  nameWords: ReadonlyMap<string, readonly string[]>;
  /** Linked, skip-listed or payback-flagged rows: not ours to settle. */
  leaveAlone(row: ExistingRow & { sourceGroupId?: string | null; flowExternal?: boolean | null }): boolean;
  notTransfer(txId: string): boolean;
}

/**
 * Stored in-transit placeholders OUTSIDE this run's download get exactly the
 * in-feed decision (issue #13). The 10-day give-up used to run only on rows in
 * the download; an incremental sync re-downloads from the last sync minus
 * SYNC_LOOKBACK_OVERLAP_MS (14 days), so a leg not re-evaluated between day 10
 * and day 14 kept its placeholder shape forever. Same timeout, same
 * expiryHoldAccount (an absent mapped account holds), same result: the prefix
 * goes, the row is flagged Needs review (R1), and the companion's next pass
 * takes the "Sync bookkeeping" filing back out (R2). A "not a transfer" row
 * settles to ordinary at once with no hold and no flag (R3, as in the feed).
 * Linked, pending, skip-listed and payback-flagged rows, and rows Wealthfolio
 * linked in place (flow.is_external false), are left alone.
 */
export function planStaleInTransit(
  rows: ReadonlyArray<ExistingRow & { sourceGroupId?: string | null; flowExternal?: boolean | null }>,
  ctx: StaleTransitContext,
): { settle: FeedTx[]; held: Array<{ txId: string; heldBy: string }> } {
  const settle: FeedTx[] = [];
  const held: Array<{ txId: string; heldBy: string }> = [];
  // planReconciliation keys stored rows by tx id and the LAST copy wins, so
  // only that copy can be settled (one update, not two).
  const lastByTxId = new Map(rows.map((r) => [r.txId, r]));
  for (const row of rows) {
    if (lastByTxId.get(row.txId) !== row) continue;
    if (!(row.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX) || row.pending) continue;
    // A pre-v1.49 fee-side placeholder (amount 0, fee X) belongs to the legacy
    // rewrite alone: settling it here would book $0 and lose the outflow.
    if (row.absCents === 0 || (row.feeCents ?? 0) > 0) continue;
    if (ctx.feedTxIds.has(row.txId)) continue;
    if (row.sourceGroupId || row.flowExternal === false || ctx.leaveAlone(row)) continue;
    const signed = OUTFLOW_TYPES.has(row.type) ? -row.absCents : row.absCents;
    const base: FeedTx = {
      txId: row.txId, wfAccountId: ctx.wfAccountId, absCents: row.absCents,
      type: expiredTransferLegType(ctx.accountType, signed), date: row.date, pending: false,
    };
    if (ctx.notTransfer(row.txId)) { settle.push(base); continue; }
    const posted = Date.parse(bankDayInstant(row.date)) / 1000;
    if (!(ctx.nowSec - posted > IN_TRANSIT_TIMEOUT_SECONDS)) continue;
    const heldBy = expiryHoldAccount(ctx.sfinAccountId, posted, ctx.mappedSfinIds, ctx.feedAliveEpoch, {
      nowSec: ctx.nowSec, legDescription: descriptionFromComment(row.comment), nameWords: ctx.nameWords,
    });
    if (heldBy !== null) held.push({ txId: row.txId, heldBy });
    else settle.push({ ...base, needsReview: true });
  }
  return { settle, held };
}

/** A feed silent longer than this is treated as disconnected rather than
 *  behind (see expiryHoldAccount). Past the self-check's two-week stale
 *  warning, so the user has already been told about it. */
const DEAD_FEED_SECONDS = 21 * 86_400;

/** Words that pick an account out of a transfer description: its own name's
 *  and its institution's distinctive words. Generic account words ("card",
 *  "checking") would match nearly every payment, so they never count. */
const GENERIC_ACCOUNT_WORDS = new Set([
  'account', 'bank', 'card', 'cash', 'checking', 'credit', 'debit', 'everyday', 'online',
  'performance', 'platinum', 'premier', 'rewards', 'savings', 'signature', 'spend', 'visa',
  'mastercard', 'the', 'and',
]);
export function accountNameWords(name: string, orgName?: string): string[] {
  const words = `${name} ${orgName ?? ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !GENERIC_ACCOUNT_WORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

/**
 * The shape for money that must move a balance without being spending — an
 * in-transit transfer placeholder, or a drift-heal plug.
 *
 * Wealthfolio classifies spending/income by activity type + account type, with
 * no per-activity budget-exclusion field reachable from the addon SDK. On a
 * CASH account, DEPOSIT counts as Income and WITHDRAWAL as Expense — so a
 * plain plug would pollute the Spending page.
 *
 * INFLOW on CASH is a bare CREDIT: Ignored by the classifier (neither spending
 * nor income), and its `amount` is what moves cash. A card inflow is
 * TRANSFER_IN (see the card history below).
 *
 * OUTFLOW, on either account type, is a TRANSFER_OUT carrying the real amount
 * (v1.49). Until then an outflow was `CREDIT` with `amount` 0 and the money in
 * `fee`, which moved cash by `amount − fee − tax` and stayed Ignored. Wealthfolio
 * 3.8.0 ended that: `amount` is now the final cash paid or received and the
 * fee is informational ("it is not deducted again"), so that shape books
 * ZERO cash — and 3.8's one-shot migration keeps such rows at 0 and flags them
 * "Needs review" rather than restating them (a CREDIT cannot go negative).
 * TRANSFER_OUT books −amount on 3.7 (amount − fee, fee 0) and on 3.8
 * (type-directed final cash), so one shape serves both. The trade, stated
 * plainly: an UNLINKED TRANSFER_OUT on a CASH account is an Expense to
 * Wealthfolio's spending classifier (only a linked transfer is Neutral there —
 * `crates/spending/src/activity_classification.rs`, and 3.8 left no
 * cash-moving outflow type that isn't spending), so Wealthfolio's own spending
 * page shows a placeholder as an uncategorised outflow until its counterpart
 * posts and the pair links. Since 1.62 the addon's readers count what
 * Wealthfolio counts; the sync files its own unfiled bookkeeping rows under an
 * excluded "Sync bookkeeping" category (3.9+) to keep them out of both. On a card TRANSFER_OUT is
 * Ignored outright. Legacy fee-side rows are restated by
 * `planLegacyPlaceholderRewrite` on the next sync.
 *
 * CREDIT_CARD is the cell with history. DEPOSIT is rejected outright by the
 * API ("not supported for credit card accounts", live 2026-08-07). The fix
 * then moved to CREDIT because it was ACCEPTED — but on a card Wealthfolio
 * classifies EVERY CREDIT as an expense refund, subtype irrelevant
 * (docs/upstream-spending-buckets.md §2), so an inflow placeholder counted
 * as a refund of the whole payment: a $429.71 card payment showed the day's
 * spending as −$400.51 (live, 2026-08-27). A card INFLOW is therefore
 * TRANSFER_IN: Ignored by the classifier, accepted by the API, the real
 * amount visible.
 *
 * Verified live on the IMPORT endpoint too (2026-08-30, $0.05 probe on a
 * real card, then deleted): TRANSFER_IN with `$CASH-USD` lands with
 * `asset_id` null — the real-cash branch — and creates no phantom asset.
 * The same endpoint REJECTS a row without a `symbol` field, so the plug must
 * keep its cash symbol; upstream issue #5 (a literal "$CASH" security) is a
 * /activities/bulk problem, and bulk transfer legs already carry no symbol.
 * `classify_import_activity` (3.8.0) sends every type with a cash symbol down
 * the same CashMovement branch, TRANSFER_OUT included.
 *
 * A card OUTFLOW is a TRANSFER_OUT where the host takes one (Wealthfolio
 * 3.10+, `cardTransferOut`): Ignored by 3.10's classifier when unlinked,
 * marked external so Health leaves it alone, the real amount visible. On 3.8
 * and 3.9 it is a WITHDRAWAL, and it is not neutral — there is no neutral
 * option. Wealthfolio 3.8 accepts only WITHDRAWAL, TRANSFER_IN, CREDIT, FEE and
 * INTEREST on a card, on every write path (activities_service.rs,
 * `account_activity_validation_message`), and all three outflows classify as
 * spending. The TRANSFER_OUT this used to pick was refused outright (live,
 * 2026-09-23: "TRANSFER_OUT activities are not supported for credit card
 * accounts"), so a card that OPENED OWING MONEY never got its opening balance
 * at all — the write failed on every sync. A card's opening debt therefore
 * shows on Wealthfolio's own Spending page on its opening date unless it is
 * filed under a category excluded from spending; this project's readers skip
 * it by note marker either way.
 *
 * SECURITIES/CRYPTOCURRENCY keep the simpler DEPOSIT/WITHDRAWAL shape: every
 * type is Ignored on an investment-style account.
 */
/** What the host takes, for the shape of a bookkeeping row. */
export interface BookkeepingShape {
  /** Wealthfolio 3.10+: TRANSFER_OUT on a credit card. */
  cardTransferOut?: boolean;
}

/** The shape options a host's capabilities give. */
export const bookkeepingShapeOf = (host: Pick<SyncHost, 'capabilities'>): BookkeepingShape =>
  ({ cardTransferOut: !!host.capabilities.cardTransferOut });

/**
 * The type a card's bookkeeping outflow is rewritten with. A stored WITHDRAWAL
 * stays one where a 3.10 writer would choose TRANSFER_OUT: it is the same row
 * (the one-time rewrite, not a netting, converts it), and every Wealthfolio
 * takes it — so neither syncer flips a row the other wrote. The reverse is
 * not kept: a writer that chooses WITHDRAWAL may have a host that refuses
 * TRANSFER_OUT on a card (3.8, 3.9). Anything else: `chosen`.
 */
export function keepBookkeepingOutflow(accountType: string, stored: string, chosen: string): string {
  return accountType === 'CREDIT_CARD' && stored === 'WITHDRAWAL' && chosen === 'TRANSFER_OUT' ? stored : chosen;
}

export function neutralAdjustmentFields(
  accountType: string,
  signedAmount: number,
  shape: BookkeepingShape = {},
): { activityType: ActivityType; amount: number; fee: number } {
  const mag = Math.abs(Math.round(signedAmount * 100) / 100);
  if (accountType === 'CASH' || accountType === 'CREDIT_CARD') {
    if (signedAmount <= 0) {
      // A card before 3.10 refuses TRANSFER_OUT outright (see the card note
      // above), and every outflow type it accepts is spending; WITHDRAWAL is
      // the honest one there.
      return {
        activityType: (accountType === 'CREDIT_CARD' && !shape.cardTransferOut ? 'WITHDRAWAL' : 'TRANSFER_OUT') as ActivityType,
        amount: mag,
        fee: 0,
      };
    }
    return accountType === 'CREDIT_CARD'
      ? { activityType: 'TRANSFER_IN' as ActivityType, amount: mag, fee: 0 }
      : { activityType: 'CREDIT' as ActivityType, amount: mag, fee: 0 };
  }
  return {
    activityType: (signedAmount > 0 ? 'DEPOSIT' : 'WITHDRAWAL') as ActivityType,
    amount: mag,
    fee: 0,
  };
}

/**
 * The shape of a one-time starting-balance correction.
 *
 * DEPOSIT/WITHDRAWAL everywhere except a credit card, where BOTH halves of that
 * pair are wrong: the API refuses DEPOSIT on a card outright, and WITHDRAWAL
 * classifies as SPENDING — so an opening balance would book a phantom purchase
 * the size of the card's whole starting debt. On a card the row takes the same
 * spending-neutral shape the drift plugs use.
 *
 * Deliberately NOT `neutralAdjustmentFields` for every account type. On a cash
 * account that would turn an opening balance from a DEPOSIT into a bare CREDIT —
 * which is arguably more correct, since an opening balance is a baseline rather
 * than income — but it changes months-old semantics for no gain here: this
 * project's own reports already exclude starting-balance rows by their note
 * marker, so only Wealthfolio's own income view would move. That is a decision
 * to take deliberately, not as a side effect of fixing cards.
 */
export function startingBalanceFields(
  accountType: string,
  starting: number,
  hostShape: BookkeepingShape = {},
): { activityType: ActivityType; amount: number } {
  const amount = Math.abs(Math.round(starting * 100) / 100);
  if (accountType === 'CREDIT_CARD') {
    const shape = neutralAdjustmentFields(accountType, starting, hostShape);
    return { activityType: shape.activityType, amount: shape.amount };
  }
  // A positive cash baseline is a bare CREDIT, which the classifier treats as
  // `Ignored` — neither spending nor income. A DEPOSIT would be INCOME, and an
  // opening balance is not earnings: it is the statement that everything before
  // this date is already accounted for. Left as a DEPOSIT it inflated
  // Wealthfolio's own income view by the whole opening balance of every account
  // (live: $11,224.68 across two accounts, dated the day each was first synced).
  //
  // The CASH BALANCE IS UNCHANGED by this. Cash movement and classification are
  // independent: `type_directed_cash_effect` adds the amount for CREDIT exactly
  // as it does for DEPOSIT, and income types book their cash unconditionally.
  // Verified live on two rows converted the same way, after which the account
  // still reconciled with SimpleFin to the cent.
  if (accountType === 'CASH' && starting > 0) {
    return { activityType: 'CREDIT' as ActivityType, amount };
  }
  // A NEGATIVE cash baseline stays a WITHDRAWAL, because no neutral outflow
  // exists on a cash account: WITHDRAWAL, TRANSFER_OUT, FEE and TAX all
  // classify as Expense, and only a LINKED transfer escapes that. Rare enough
  // (a cash account opening below zero) not to be worth a worse shape.
  return {
    activityType: (starting > 0 ? 'DEPOSIT' : 'WITHDRAWAL') as ActivityType,
    amount,
  };
}

/** Import one dated balance-adjustment activity. `amount` is signed
 *  (SimpleFin − Wealthfolio). On CASH/CREDIT_CARD accounts this takes the
 *  placeholder shape (see neutralAdjustmentFields); elsewhere a
 *  DEPOSIT/WITHDRAWAL.
 *  No-op for a negligible amount. Shared by the manual button and the
 *  aggressive auto-heal path. */
export async function importAdjustmentActivity(
  host: SyncHost,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number },
): Promise<ImportRow | null> {
  const { sfinAccountId, wfAccountId, currency, amount } = args;
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) return null;
  const today = new Date().toISOString().split('T')[0];
  const wfAccounts = await host.listAccounts().catch(() => []);
  const accountType = String(
    wfAccounts.find((a) => a.id === wfAccountId)?.accountType ?? '',
  );
  const { activityType, amount: fieldAmount, fee } = neutralAdjustmentFields(accountType, amount, bookkeepingShapeOf(host));
  // Built as a variable (not an inline literal) so it matches the same relaxed
  // shape the starting-balance correction uses for the import endpoint.
  const adjustment: ImportRow = {
    accountId: wfAccountId,
    sourceSystem: 'simplefin',
    activityType,
    date: bankDayInstant(today),
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
    // The row written, for the change log. Null below: nothing was written.
    return adjustment;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!msg.toLowerCase().includes('duplicate')) {
      throw e;
    }
    return null;
  }
}

/**
 * The id of the row carrying `comment`, read back after an import — the
 * import endpoint reports no ids. Undefined when the read fails or finds
 * nothing: the change entry still names the row by its note.
 */
export async function rowIdByComment(
  read: () => Promise<HostActivity[]>,
  comment: string,
  /** Also match the money, when several rows can share one note (two Add
   *  adjustment taps on the same day). The LAST match wins: the newest row. */
  money?: { amount?: unknown; fee?: unknown },
): Promise<string | undefined> {
  try {
    const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
    const matches = (await read()).filter((a) => (a.comment ?? '') === comment
      && (!money || (cents(a.amount) === cents(money.amount) && cents(a.fee) === cents(money.fee))));
    return matches[matches.length - 1]?.id;
  } catch {
    return undefined;
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
  const sink = opts.changeLog;
  const changes: ChangeEntry[] = [];
  const logChange: RecordChange | null = sink
    ? (build) => {
      // Building an entry is not allowed to cost the work: a bug in a builder
      // drops that one entry, never the account's sync.
      try {
        changes.push(stampChange(build(), sink.writer, new Date(), sink.run));
      } catch (e: any) {
        console.warn(`[simplefin-sync] change log: an entry was dropped: ${String(e?.message ?? e)}`);
      }
    }
    : null;
  try {
    return await runSyncPass(host, store, opts, logChange);
  } finally {
    // Once, at the end, whatever happened above — and never at the run's
    // expense: the sink is not supposed to reject, and if it does the result
    // the caller gets is exactly the one it would have got without a log.
    if (sink && changes.length > 0) {
      try {
        await sink.append(changes);
      } catch (e: any) {
        console.warn(`[simplefin-sync] change log: ${changes.length} change(s) not recorded: ${String(e?.message ?? e)}`);
      }
    }
  }
}

/**
 * A manual Sync that lands inside the gap since the last download (C3): nothing
 * is asked of SimpleFin. Every mapped account's badge is re-checked against the
 * figures the last download kept, with Wealthfolio's CURRENT state. Writes only
 * `account_balances`, and only a verdict that CHANGED, tagged badge-only like
 * the after-save check's, with that account's stale baseline-fix offer dropped
 * (a Deep scan re-offers it); alerts, corrections and the drift-episode ledger
 * are untouched (R15). Every other entry is kept exactly as stored (F3).
 *
 * A stored figure is compared only when it carries a `fetchedAt` at or after
 * `newestRequestAt` (R16: a newer request in flight may be changing the ledger
 * under older figures) and a numeric balance. A valued account is compared with
 * its valuation less the asset-backed TRANSFER_OUT legs, unless a pending row
 * makes that unsafe; any other account whose type is known against the
 * posted-ledger total.
 * Returns the newest `fetchedAt` among the compared-fresh accounts (how old the
 * bank data is). Null means no account was COMPARED (none fresh, or the
 * stored snapshots could not be read, in which case nothing is written).
 */
export async function checkBalancesOnly(
  host: SyncHost,
  store: SyncStore,
  opts: { mapping: AccountMapping; newestRequestAt: number | null },
): Promise<{ dataAt: number | null }> {
  // A failed read writes NOTHING: rewriting from an empty document would erase
  // every balance, R16 stamp, drift episode start and baseline-fix offer.
  const read = await store.getAccountBalances().catch(() => null);
  if (read === null || read === undefined) return { dataAt: null };
  const stored = read as Record<string, AccountBalanceSnapshot>;
  const { mapping, newestRequestAt } = opts;
  const fresh = (snap: AccountBalanceSnapshot): boolean =>
    typeof snap.fetchedAt === 'number' && (newestRequestAt === null || snap.fetchedAt >= newestRequestAt) &&
    typeof snap.balance === 'number';
  const freshIds = Object.keys(stored).filter((id) => !!mapping[id] && fresh(stored[id]));
  const wfIds = [...new Set(freshIds.map((id) => mapping[id]))];

  const types = new Map<string, string>();
  if (wfIds.length > 0) {
    for (const a of await host.listAccounts().catch(() => [])) types.set(a.id, a.accountType);
  }
  const valuations = wfIds.length > 0
    ? await host.latestValuations(wfIds).catch(() => null)
    : new Map<string, number>();

  // Valued accounts: valuation less asset-backed TRANSFER_OUT legs, unless pending.
  const figures = new Map<string, number>();
  if (valuations !== null) {
    for (const wfId of wfIds) {
      const valuation = valuations.get(wfId);
      if (valuation === undefined) continue;
      const rows = await host.listActivities(wfId).catch(() => null);
      if (rows === null || rows.some((r) => (r.comment ?? '').endsWith(PENDING_SUFFIX))) continue;
      const assetBackedOut = rows
        .filter((r) => r.activityType === 'TRANSFER_OUT' && !!r.assetId && txIdFromComment(r.comment) !== null)
        .reduce((sum, r) => sum + Math.abs(parseFloat(String(r.amount ?? '0')) || 0), 0);
      figures.set(wfId, valuation - assetBackedOut);
    }
    // Not an account whose type is unknown (listAccounts failed): an untyped
    // total counts a card's interest as income (F5).
    const unvalued = wfIds.filter((id) => !valuations.has(id) && !!types.get(id));
    if (unvalued.length > 0 && host.postedLedgerTotals) {
      const totals = await host.postedLedgerTotals(unvalued.map((wfAccountId) => ({ wfAccountId, accountType: types.get(wfAccountId) ?? '' })))
        .catch(() => null);
      for (const [id, total] of totals ?? []) figures.set(id, total);
    }
  }

  // Only a verdict this pass re-measured AND found changed is written (F3). An
  // account it did not compare (not fresh, an older writer's snapshot, a read
  // that failed) keeps exactly what the download left; so does one whose
  // verdict agrees, tag or no tag: re-tagging a download's own measured drift
  // would take the Home banner, its plug and its Deep scan away while the badge
  // still said "off by $X". Nothing changed, nothing is written.
  const next: Record<string, AccountBalanceSnapshot> = { ...stored };
  let dataAt: number | null = null;
  let changed = false;
  for (const id of freshIds) {
    const snap = stored[id];
    const figure = figures.get(mapping[id]);
    if (figure === undefined || typeof snap.balance !== 'number') continue;
    dataAt = Math.max(dataAt ?? 0, snap.fetchedAt as number);
    const verdict = badgeVerdict(snap.balance, figure);
    if (snap.measured === true && snap.drift === verdict.drift) continue;
    const { baselineFix: _dropped, checkedAfterSave: _tag, ...rest } = snap;
    next[id] = { ...rest, ...verdict, checkedAfterSave: true };
    changed = true;
  }
  if (changed) await store.setAccountBalances(next);
  return { dataAt };
}

/** Records one change-log entry for a write that succeeded. */
type RecordChange = (build: () => ChangeDraft) => void;

/** A row the unlink pre-pass read, with the SimpleFin account it sits in. */
interface UnlinkSeen { sf: string; key: string; row: StoredRow }

/** A linked pair an earlier unlink re-created as ordinary rows but could not
 *  delete, confirmed for its cleanup this run. */
interface StaleUnlinkPair {
  gid: string;
  /** The old linked legs, by row: one per leg, in account order. */
  old: UnlinkSeen[];
  /** Each leg's ordinary replacement, by row, in the same order. */
  replacements: UnlinkSeen[];
}

/** What the unlink pre-pass decided, before any account is touched. */
interface UnlinkPrepass {
  /** Every account could be read. When false nothing about a pair being
   *  unlinked is decided this run: no unlink, no cleanup delete, no duplicate
   *  prune, no relink sweep, no drift measurement anywhere. */
  certain: boolean;
  /** Old linked legs kept out of every step of this run, by row id. */
  hiddenIds: Set<string>;
  /** Their groups, so a leg the pre-pass could not see is kept out too. */
  heldGids: Set<string>;
  /** Tx keys whose bank transaction stays out of the plan, so every row under
   *  them is left exactly as it is this run. */
  frozenKeys: Set<string>;
  /** Tx keys of every held pair: never paired, linked or relinked this run. */
  staleKeys: Set<string>;
  /** Tx keys of every linked pair with a `notTransfer` leg: never pruned. */
  pairKeys: Set<string>;
  /** SimpleFin accounts holding a held pair: drift is not measured there. */
  driftAccounts: Set<string>;
  /** Pairs whose old linked legs may be deleted this run. */
  cleanup: StaleUnlinkPair[];
  /** Pairs left as they are this run, and why. */
  waiting: Array<{ txIds: string[]; reason: string }>;
}

const emptyUnlinkPrepass = (): UnlinkPrepass => ({
  certain: true, hiddenIds: new Set(), heldGids: new Set(), frozenKeys: new Set(), staleKeys: new Set(),
  pairKeys: new Set(), driftAccounts: new Set(), cleanup: [], waiting: [],
});

/**
 * The unlink pre-pass: every linked pair with a `notTransfer` leg, decided per
 * PAIR across all accounts before any of them is touched.
 *
 * An unlink re-creates both legs as ordinary rows first and deletes the old
 * linked pair after (`unlinkPairByRecreate`); when that delete fails, the old
 * pair is still there next to the new rows and a later run deletes it. That
 * cleanup obeys ONE rule: an old linked leg is deleted only when, in this same
 * run, EVERY leg of its pair has a confirmed ordinary replacement row. Both
 * halves of that are identified by ROW, never by tx key alone:
 *  - a pair's legs are the transfer-typed rows in its group (the shared
 *    `sourceGroupId`, or on a host that cannot read it this app's ledger entry
 *    for the row's tx key) — exactly two, one out and one in, in two accounts.
 *    A held in-transit placeholder is never one: it was never linked, and is
 *    what the sync re-holds a leg as when its partner said "not a transfer".
 *  - a replacement is an ordinary row (not a transfer type, not a placeholder,
 *    not pending) under the leg's own tx key.
 * Anything less certain leaves the pair exactly as it is and says why: an
 * account that could not be read (then every pair with a `notTransfer` leg
 * waits), an other half not in this sync, rows that cannot be told apart, a leg
 * with no ordinary row yet. Never a delete under doubt: a stale pair waiting
 * one more sync is visible and costs nothing; a wrong delete loses a row.
 *
 * A pair with a `notTransfer` leg and no replacement yet is a plain unlink,
 * done after the account loop; it is only protected from the duplicate prune
 * here (`pairKeys`).
 */
function planUnlinkPrepass(
  seen: UnlinkSeen[],
  certain: boolean,
  gidOf: (x: UnlinkSeen) => string | undefined,
  notTransfer: (key: string) => boolean,
  describe: (x: UnlinkSeen) => string,
  /** Groups an unread account may hold a leg of: the ledger's, where the host keeps one. */
  unseenGids: string[],
): UnlinkPrepass {
  const out = { ...emptyUnlinkPrepass(), certain };
  const isPlaceholder = (r: StoredRow) => (r.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX);
  const legs = seen.filter((x) => isTransferType(x.row.type) && !isPlaceholder(x.row) && !!gidOf(x));
  const ordinary = new Map<string, UnlinkSeen[]>();
  for (const x of seen) {
    if (isTransferType(x.row.type) || isPlaceholder(x.row) || x.row.pending) continue;
    ordinary.set(x.key, [...(ordinary.get(x.key) ?? []), x]);
  }
  const gids = new Set(legs.filter((x) => notTransfer(x.key)).map((x) => gidOf(x)!));
  if (!certain) for (const g of unseenGids) gids.add(g);
  for (const gid of gids) {
    const members = legs.filter((x) => gidOf(x) === gid);
    for (const m of members) out.pairKeys.add(m.key);
    /** Kept out of this run; `frozen` also keeps their bank transactions out of the plan. */
    const hold = (frozen: boolean) => {
      out.heldGids.add(gid);
      for (const m of members) {
        out.hiddenIds.add(m.row.wfId);
        out.staleKeys.add(m.key);
        out.driftAccounts.add(m.sf);
        if (frozen) out.frozenKeys.add(m.key);
      }
    };
    if (!certain) {
      hold(true);
      continue;
    }
    // No leg re-created yet: a plain unlink, after the account loop.
    if (!members.some((m) => notTransfer(m.key) && ordinary.has(m.key))) continue;
    const types = new Set(members.map((m) => m.row.type));
    const reason = members.length < 2
      ? 'its other half is not in this sync'
      : members.length > 2 || members[0].sf === members[1].sf || !types.has('TRANSFER_OUT') || !types.has('TRANSFER_IN')
        ? 'its linked rows cannot be told apart'
        : members.filter((m) => !ordinary.has(m.key)).map((m) => `${describe(m)} has no ordinary row of its own yet`)[0];
    if (reason) {
      // Hidden, but its transactions still reach the plan: an expiring
      // placeholder or a missing row becomes the ordinary row a later run
      // can confirm.
      hold(false);
      out.waiting.push({ txIds: members.map((m) => m.row.txId), reason });
      continue;
    }
    // Frozen: the replacements stay exactly as confirmed (not re-held as a
    // placeholder, say) whether or not the delete lands.
    hold(true);
    out.cleanup.push({ gid, old: members, replacements: members.map((m) => ordinary.get(m.key)![0]) });
  }
  return out;
}

/**
 * A stored row as the create request that would make it again — what R2's
 * undo needs to put back a duplicate the prune removed.
 */
function recreatePayload(row: StoredRow, currency: string): ActivityWrite {
  return {
    accountId: row.wfAccountId,
    activityType: row.type,
    activityDate: bankDayInstant(row.date),
    ...(isTransferType(row.type) ? {} : { symbol: { symbol: `$CASH-${currency}` } }),
    amount: row.absCents / 100,
    ...(row.feeCents ? { fee: row.feeCents / 100 } : {}),
    currency,
    comment: row.comment ?? '',
    ...(row.subtype ? { subtype: row.subtype } : {}),
    ...(typeof row.flowExternal === 'boolean' ? { metadata: JSON.stringify({ flow: { is_external: row.flowExternal } }) } : {}),
  };
}

async function runSyncPass(
  host: SyncHost,
  store: SyncStore,
  opts: SyncOptions,
  logChange: RecordChange | null,
): Promise<SyncResult> {
  const errors: string[] = [];
  const autoAdjust = await store.getAutoAdjust();
  const heal = opts.heal || autoAdjust || (await store.getAutoHeal());
  console.log('[simplefin-sync] starting sync core', { heal, force: !!opts.force, autoAdjust });

  // Enforce the one-hour minimum interval on SCHEDULED runs only (C6, R18). A
  // person is governed by the 5-minute gap and the daily limit instead (below):
  // a Sync pressed 5-60 minutes after the last one used to check nothing at all.
  const lastSync = await store.getLastSyncAt();
  if (!opts.manual && !opts.force && !heal && lastSync && Date.now() - lastSync.getTime() < MIN_SYNC_INTERVAL_MS) {
    return { imported: 0, skipped: 0, errors: [INTERVAL_SKIP_MESSAGE], stuckTransferAlerts: [], importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [], prunedDuplicates: [], unmappedAccounts: null, refusedCreates: [], holdingsSnapshots: noHoldings() };
  }

  const accessUrl = await store.getAccessUrl();
  if (!accessUrl) {
    return { imported: 0, skipped: 0, errors: ['Not configured: no access URL'], stuckTransferAlerts: [], importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [], prunedDuplicates: [], unmappedAccounts: null, refusedCreates: [], holdingsSnapshots: noHoldings() };
  }

  const mapping = await store.getAccountMapping();
  if (!mapping) {
    return { imported: 0, skipped: 0, errors: ['Not configured: no account mapping'], stuckTransferAlerts: [], importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [], prunedDuplicates: [], unmappedAccounts: null, refusedCreates: [], holdingsSnapshots: noHoldings() };
  }

  // The SimpleFin budget (C1-C3). The request is recorded BEFORE the download is
  // sent (SimpleFin counts attempts, a failed one included), in the one record
  // both writers share, and it fails closed. A store with no record keeps no budget.
  const requestLog = requestLogIo(store);
  let fetchedAt = Date.now();
  if (requestLog) {
    const now = new Date();
    const gate = await reserveSimplefinRequest(requestLog, opts.manual ? 'manual' : 'scheduled', now);
    if (gate.kind === 'checkOnly') {
      const { dataAt } = await checkBalancesOnly(host, store, { mapping, newestRequestAt: gate.lastAt.getTime() });
      return { ...notDownloaded(), download: { kind: 'checkOnly', line: checkedLine(dataAt, now), lastAt: gate.lastAt.getTime() } };
    }
    if (gate.kind !== 'go') {
      const line = gateLine(gate, now)!;
      console.log(`[simplefin-sync] ${line}`);
      return { ...notDownloaded(), download: { kind: 'skipped', line } };
    }
    fetchedAt = gate.at.getTime();
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
  // `fetchedAt` (set above from the recorded request time) is stamped on every bank figure.
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
  // A blank feed currency (shared/feed-currency.ts), filled before anything
  // reads it: every row's cash asset is `$CASH-<currency>`, and `$CASH-` is
  // refused. One that cannot be filled says so once instead of once per row.
  const filledCurrencies = fillFeedCurrencies(
    accountSet.accounts,
    mapping,
    new Map(wfAccounts.map((a): [string, string | undefined] => [a.id, a.currency])),
  );
  accountSet.accounts = filledCurrencies.accounts;
  for (const account of filledCurrencies.unresolved) {
    errors.push(`SimpleFin: ${account.name || account.id} reports no currency, and its Wealthfolio account has none either, so its transactions can't be imported.`);
  }

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
  const mappedWfIds = [...new Set(Object.values(mapping))];
  try {
    wfBalances = mappedWfIds.length > 0
      ? await host.latestValuations(mappedWfIds)
      : new Map<string, number>();
  } catch {
    errors.push('Could not read account balances — starting-balance checks skipped this run');
  }
  // The accounts Wealthfolio itself VALUED, before the ledger fallback fills
  // the gaps: the after-save card check below is for the rest.
  const valuedWfIds = new Set(wfBalances?.keys() ?? []);
  // Fill the gaps the valuations API leaves, which in practice is every credit
  // card: Wealthfolio reports valuations for CASH accounts only, so a card had
  // no balance to compare against, the one-time starting-balance correction
  // could never run on one, and a card sat $235.40 short of its true opening
  // balance for five months with nothing able to notice (live, 2026-09-12).
  //
  // Only the missing ones. A valuation, where it exists, stays authoritative:
  // it is what the account page shows, and it accounts for currency conversion
  // that a bare sum of activity amounts does not.
  if (wfBalances !== null && host.ledgerBalances) {
    const missing = mappedWfIds.filter((id) => !wfBalances!.has(id));
    if (missing.length > 0) {
      try {
        for (const [id, balance] of await host.ledgerBalances(missing)) {
          wfBalances.set(id, balance);
        }
      } catch {
        // Leave them missing. `canReadBalance` then skips the correction and
        // the account stays un-initialized, which is the same conservative
        // behaviour every un-valued account had before this fallback existed.
      }
    }
  }

  // Phase A: resolve activity types for every transaction across all mapped
  // accounts, so transfer pairs can be detected across account boundaries
  interface PreparedTx {
    sfAccountId: string;
    tx: SimplefinTransaction;
    type: ActivityType;
    /** Spending-neutral placeholder standing in for a transfer leg whose other
     *  side hasn't posted yet (drives the comment prefix). */
    inTransit?: boolean;
    /** Set when this row's classification is a guess the user should confirm —
     *  see `FeedTx.needsReview`. */
    needsReview?: boolean;
    /** The subtype the matched rule assigned, resolved ONCE here and read from
     *  here by everything downstream. Omitted — never `''` — for a row no rule
     *  subtyped: the write is patch-shaped, so an explicit empty string would
     *  clear a subtype Wealthfolio set for its own reasons. Independent of
     *  `inTransit` above. */
    subtype?: string;
    /** Decided by a rule that types only rows the sync creates (a payback rule's
     *  `since`): reconciliation leaves a stored row's type and subtype as they are. */
    createOnly?: true;
    /** Nothing decided this cash money-in row's type and the plain mapping says
     *  DEPOSIT: a stored payback stays as stored (see `FeedTx.keepPayback`). */
    keepPayback?: true;
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
  /** Charges this run matched to an order, per SimpleFin account then tx id,
   *  with the bank's own text beside the labelled one — what the late-label
   *  pass needs to recognise a note written before the email was readable. */
  const amazonLabelled = new Map<string, Map<string, { bare: string; enriched: string }>>();
  const amazonEnabled = Object.keys(amazonLedger).length > 0;

  // Venmo notes (3), the same shape: an empty ledger — no Venmo mail forwarded,
  // or an older host with no reader — costs one read and then nothing.
  // An unreadable ledger (the read throws, or an entry is not a payment) is
  // never used and never written back: Venmo notes are off for this run.
  let venmoLedger: VenmoLedger = {};
  try {
    const read = await store.getVenmoLedger?.();
    if (read) {
      if (isReadableVenmoLedger(read)) venmoLedger = read;
      else errors.push(VENMO_UNREADABLE_ERROR);
    }
  } catch {
    errors.push(VENMO_UNREADABLE_ERROR);
  }
  /** What THIS run consumed (ledger key -> tx key): the only thing it writes back. */
  const venmoConsumed = new Map<string, string>();
  /** Rows this run matched to a Venmo payment, per SimpleFin account then tx
   *  id: the bank's text, the text with the note, and the note. */
  const venmoNoted = new Map<string, Map<string, { bare: string; enriched: string; note: string }>>();
  const venmoEnabled = Object.keys(venmoLedger).length > 0;

  /**
   * Accounts the feed offered that nothing is mapped to — reported, not
   * imported. Collected HERE rather than in the second pass below because this
   * loop runs unconditionally over the whole feed; the later one is reached
   * only after planning, so an early error would lose the list.
   *
   * See `SyncResult.unmappedAccounts` for why the silent `continue` this sits
   * in front of was not good enough on its own.
   */
  const unmappedAccounts: UnmappedAccount[] = [];
  /** See `SyncResult.refusedCreates`. */
  const refusedCreates: SyncResult['refusedCreates'] = [];
  /** Accounts the user has said they do not want synced. Reported as neither
   *  unmapped nor a problem — see `SyncStore.getIgnoredAccounts`. Read once
   *  per run; a failure degrades to "nothing ignored", which is the safe
   *  direction (it over-reports rather than hiding an account silently). */
  const ignoredAccountIds = new Set(
    (await store.getIgnoredAccounts?.().catch(() => [])) ?? [],
  );
  /** Loan accounts linked to a liability (shared/loan-balances.ts): not
   *  unmapped, and recorded after the accounts below. A failed read links none. */
  const loanLinks: LoanLinks = (await store.getLoanLinks?.().catch(() => ({}))) ?? {};
  /** The linked loans that still exist, by asset id; null when they could not
   *  be read (the links are then trusted, and nothing is written this run). A
   *  link to a loan that was deleted is no link: its account is unmapped again. */
  let loansById: Map<string, LinkedLoan> | null = null;
  if (Object.keys(loanLinks).length > 0 && host.listLoans && host.confirmLoanBalance) {
    try {
      loansById = new Map((await host.listLoans()).map((l) => [l.id, l]));
    } catch (e: any) {
      errors.push(`Loan balances skipped: the loans could not be read (${e?.message ?? e})`);
    }
  }
  const linkedLoan = (sfinId: string): boolean =>
    !!loanLinks[sfinId] && (loansById === null || loansById.has(loanLinks[sfinId]));
  /** Bank transactions the user has said are not real (shared/skipped-transactions.ts),
   *  per account. A failed read imports everything, as before the list existed. */
  const skippedTxKeys = new Set(
    ((await store.getSkippedTransactions?.().catch(() => [])) ?? [])
      .map((s) => accountTxKey(s.account, s.txId)),
  );
  /** The same decision made once for a whole kind of row (shared/ignore-rules.ts):
   *  every transaction a rule matches joins the set above, so it takes exactly the
   *  path a skipped one does — dropped before anything is planned, the raw feed
   *  left whole, a stored copy left for the person to delete. A failed read, or a
   *  list with no usable rule, ignores nothing. Only mapped accounts: a rule never
   *  reaches an account nothing is synced from. */
  const ignoreRules = normalizeIgnoreRules((await store.getIgnoreRules?.().catch(() => [])) ?? []);
  let ignoredByRules = 0;
  for (const hit of findIgnored(ignoreRules, accountSet.accounts, (id) => !!mapping[id])) {
    const key = accountTxKey(hit.account.id, hit.tx.id);
    if (skippedTxKeys.has(key)) continue;
    skippedTxKeys.add(key);
    ignoredByRules++;
  }
  if (ignoredByRules > 0) {
    console.log(`[simplefin-sync] ${ignoredByRules} transaction(s) left out by your ignore rules`);
  }
  /** What Undo told the sync not to do again (shared/sync-overrides.ts). A
   *  failed or corrupt read is empty: the sync then behaves as it always did. */
  // Read ONCE: two reads can disagree (the first failing, the second working),
  // which would leave `overrides` empty while `overridesUnread` is false.
  const loadedOverrides = store.readSyncOverrides ? await store.readSyncOverrides().catch(() => null) : undefined;
  const overrides = loadedOverrides === undefined
    ? (await store.getSyncOverrides?.().catch(() => null)) ?? emptySyncOverrides()
    : loadedOverrides?.overrides ?? emptySyncOverrides();
  /** The document could not be read (a failed read or a corrupt one): `overrides`
   *  above is then empty, which must not revert a payback — see below. A host
   *  without `readSyncOverrides` cannot say, and keeps today's behaviour. */
  const overridesUnread = loadedOverrides !== undefined && (!loadedOverrides || loadedOverrides.unreadable);
  if (overridesUnread) console.warn(syncOverridesIgnoredLog(loadedOverrides ? 'corrupt' : 'unreadable'));
  /** Flagged `asReimbursement` keys whose override yielded this sync (money
   *  out, or a known non-cash account) — logged where a stored payback is seen. */
  const yieldedPaybackKeys = new Set<string>();
  let paybackNoteGiven = false;
  /** A stored, settled CREDIT marked REIMBURSEMENT: what an unread overrides
   *  document leaves exactly as stored. (A pending row is not kept: it posts
   *  under a new id and must be replaced like any other.) */
  const isKeptPayback = (r: ExistingRow) => r.type === 'CREDIT' && !r.pending
    && (r.subtype ?? '').toUpperCase() === REIMBURSEMENT_SUBTYPE;

  // Keep pending rows now (they import and reconcile), dropping only rows we
  // can't date at all — no `posted` and no `transacted_at` — since those
  // would produce a 1970 date the server rejects.
  //
  // Then collapse repeated transaction ids, BEFORE anything is planned from the
  // list: two copies of one id would otherwise both plan a create and both land
  // in one saveMany batch, which is the only way past Wealthfolio's duplicate
  // guard (see dedupeAccountTransactions). Per account — the same id is a
  // legitimate sight in two accounts, as the two legs of one transfer.
  //
  // A skipped transaction goes here too, so nothing downstream plans from it.
  // `accountSet` itself is left whole: an overwritten leg is recognised by the
  // bank still reporting its partner's id, skipped or not.
  //
  // Worked out for every mapped account BEFORE the loop, because the Venmo
  // match below needs the whole run's rows at once.
  const feedOf = new Map<SimplefinAccount, SimplefinTransaction[]>();
  for (const sfAccount of accountSet.accounts) {
    if (!mapping[sfAccount.id]) continue;
    feedOf.set(sfAccount, dedupeAccountTransactions(
      sfAccount.id,
      (sfAccount.transactions ?? []).filter(
        (tx) => txEpoch(tx) !== null && !skippedTxKeys.has(accountTxKey(sfAccount.id, tx.id)),
      ),
    ));
  }

  // Which Venmo payment each bank row is, decided for the whole run at once
  // (ruling P3-K): one payment to one row, in any feed order, across accounts.
  // A posted row competes, whatever its type or override (a transfer or a
  // `noVenmoNote` row still consumes its payment, it only gets no note); a
  // pending row competes too, as a blocker that never gets a payment itself.
  const venmoMatches: Map<string, VenmoMatch> = venmoEnabled
    ? matchVenmoPayments(venmoLedger, [...feedOf].flatMap(([sfAccount, txs]) => txs.map((tx) => {
      const amount = parseFloat(tx.amount);
      return {
        description: tx.description,
        amountCents: Math.round(Math.abs(amount) * 100),
        // The sign alone, never the account type: a card's purchases are negative too.
        direction: amount < 0 ? 'out' as const : 'in' as const,
        postedMs: txEpoch(tx)! * 1000,
        txKey: accountTxKey(sfAccount.id, tx.id),
        ...(tx.pending ? { pending: true } : {}),
      };
    })))
    : new Map();

  // The learned transfer names (A5). No list (no companion, or one not yet on
  // 1.64) is an empty set and typing is exactly as before (R6).
  const learnedNames = learnedNameKeys(await store.getTransferNames?.().catch(() => null));
  // The ids of an account's stored paybacks, read lazily and once (only when a
  // learned name matches a payback candidate). A failed read is null.
  const paybackIdCache = new Map<string, Promise<Set<string> | null>>();
  const storedPaybacksOf = (wfId: string): Promise<Set<string> | null> => {
    let p = paybackIdCache.get(wfId);
    if (!p) {
      p = fetchExistingRows(host, wfId).then(
        (rows) => new Set(rows.filter((r) => r.type === 'CREDIT' && (r.subtype ?? '').toUpperCase() === REIMBURSEMENT_SUBTYPE).map((r) => r.txId)),
        () => null,
      );
      paybackIdCache.set(wfId, p);
    }
    return p;
  };

  // Each mapped account's name words, built once and BEFORE typing: typing needs
  // them to see a payment that names another connected account (spec A), and the
  // in-transit expiry hold below reads the same map.
  const nameWords = new Map<string, string[]>();
  for (const sfAccount of accountSet.accounts) {
    if (!mapping[sfAccount.id]) continue;
    nameWords.set(sfAccount.id, accountNameWords(sfAccount.name, sfAccount.org?.name));
  }

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) {
      if (ignoredAccountIds.has(sfAccount.id) || linkedLoan(sfAccount.id)) continue;
      unmappedAccounts.push({
        sfinAccountId: sfAccount.id,
        accountName: sfAccount.name,
        // SimpleFin nests the institution under `org`; guarded because the
        // schema allows an org carrying only a domain/url and no name.
        ...(sfAccount.org?.name ? { orgName: sfAccount.org.name } : {}),
      });
      continue;
    }
    // Datable, not skipped, one copy per id (see `feedOf` above).
    const transactions = feedOf.get(sfAccount) ?? [];
    const prepared: PreparedTx[] = [];
    // The row's own account never counts as "another account" (R2).
    const otherAccountWords = [...nameWords].filter(([id]) => id !== sfAccount.id).map(([, words]) => words);
    for (const tx of transactions) {
      const amount = parseFloat(tx.amount);
      const key = accountTxKey(sfAccount.id, tx.id);
      // The person undid a transfer decision on this leg (`notTransfer`):
      // neither a card-payment keyword nor a mapping rule may type it as a
      // transfer. It becomes ordinary money in or out, the type a leg whose
      // other half never arrived takes, and the rule's subtype goes with it.
      const notTransfer = hasTxOverride(overrides, key, 'notTransfer');
      // A payback you filed (`asReimbursement`, 1.62 W7): a CREDIT marked
      // REIMBURSEMENT for as long as the bank row is money in on a cash
      // account, whatever a keyword or a rule says — and never paired below,
      // which would type it a transfer. Money out, or another account type,
      // and the override yields: the row is typed as usual.
      // An UNKNOWN type (listAccounts failed) does not yield: only a known
      // non-cash type does. (An override past its year still applies until the
      // next overrides write prunes it — by design.)
      const acctType = wfTypes.get(wfAccountId);
      const flagged = hasTxOverride(overrides, key, 'asReimbursement');
      const payback = flagged && amount > 0 && (!acctType || acctType === 'CASH');
      if (flagged && !payback) yieldedPaybackKeys.add(key);
      const worded = mapTransactionWithSource(
        tx.description, amount, rules, wfTypes.get(wfAccountId), wfAccountId,
        txEpoch(tx) !== null ? new Date(txEpoch(tx)! * 1000).toISOString().split('T')[0] : undefined,
      );
      // Issue #13: "WIRE TRANSFER TO ACME LLC" is a wire to a third party, but the
      // generic phrase typed it a transfer and it waited forever for an other half.
      // Money out of a cash account worded only generically is an ordinary
      // WITHDRAWAL unless its text names another connected account (checked right
      // here; learned names promote the row further down). A real own-account transfer
      // still links: pairing by amount joins it to its other half within 5 days.
      const builtIn: MappedType = genericTransferNeedsCorroboration(tx.description, amount, acctType, worded, otherAccountWords)
        ? { type: 'WITHDRAWAL', fromRule: false }
        : worded;
      // Live, 2026-10-17: a $42.40 Citi autopay posted at PNC before Citi's half
      // existed, read as plain spending, and asked for a category. A bank-account
      // payment whose raw text names another connected account is the paying half
      // of a transfer, so it is typed one now and the in-transit path does the rest
      // (placeholder, link when the other half posts, expiry, dead-feed hold).
      // Decided HERE, before the payback and `notTransfer` handling below, so both
      // still win (R4); a mapping rule already won inside the helper.
      // `tx.description` is the bank's raw text — enrichment comes later.
      const bankFirst = bankFirstTransferOut(tx.description, amount, acctType, builtIn, otherAccountWords);
      // R13: from the bank text ALONE, before learned typing.
      const keepPayback = !payback && !builtIn.fromRule && builtIn.type === 'DEPOSIT' && amount > 0 && (!acctType || acctType === 'CASH');
      // Live, 2026-10-18: a savings -> Spend landing ("... TRANSFER CAPITAL ONE ACH
      // WEB PAYMENT") posted before the savings half and read as a plain deposit,
      // and 360 Checking's withdrawal to Performance Savings read as spending. A
      // wording the companion learned from a past LINK types the row a transfer so
      // the in-transit path holds it. Decided before the payback and notTransfer
      // handling below, so both still win. An unreadable stored-row read means no
      // learned typing, i.e. today's typing.
      let learned = bankFirst ? null : learnedTransferType(learnedNames, {
        wfAccountId, accountType: acctType, amount, mapped: builtIn, description: tx.description,
      });
      let heldAsPayback = false;
      if (learned && keepPayback) {
        const paybackIds = await storedPaybacksOf(wfAccountId);
        if (!paybackIds || paybackIds.has(tx.id)) learned = null;
        heldAsPayback = !!paybackIds && paybackIds.has(tx.id);
      }
      const mapped = bankFirst
        ? { ...builtIn, type: 'TRANSFER_OUT' as ActivityType }
        : learned ? { ...builtIn, type: learned as ActivityType } : builtIn;
      const { type, fromRule, subtype } = payback
        ? { type: 'CREDIT' as ActivityType, fromRule: true, subtype: REIMBURSEMENT_SUBTYPE as string | undefined }
        : notTransfer && isTransferType(mapped.type)
          ? { type: expiredTransferLegType(wfTypes.get(wfAccountId) ?? '', amount), fromRule: false, subtype: undefined }
          : mapped;
      prepared.push({
        sfAccountId: sfAccount.id, tx, type,
        ...(subtype ? { subtype } : {}),
        // Only when the rule's own type stands: the asReimbursement flag and the
        // notTransfer rewrite decide by themselves and may re-type a stored row.
        ...(!payback && !(notTransfer && isTransferType(mapped.type)) && mapped.createOnly ? { createOnly: true as const } : {}),
        // Neither a rule nor the flag decided: a stored payback (filed, made by hand, or
        // made by a rule since undone) is not the sync's to turn into a deposit.
        ...(keepPayback ? { keepPayback: true as const } : {}),
      });
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
        // Still matched and consumed when the person undid this charge's
        // label: the order HAS been found, and a live record would be offered
        // to the next charge of the same amount. Only the label stays off.
        if (hit && !hasTxOverride(overrides, key, 'noAmazonLabel')) {
          description = amazonDescription(description, hit.labels, hit.partial);
          if (description !== tx.description) {
            const forAccount = amazonLabelled.get(sfAccount.id) ?? new Map<string, { bare: string; enriched: string }>();
            forAccount.set(tx.id, { bare: tx.description, enriched: description });
            amazonLabelled.set(sfAccount.id, forAccount);
          }
        }
        if (hit) {
          // Consumed even when this row already exists in Wealthfolio and so
          // won't be re-written: the charge for that order HAS been found, and
          // leaving the record live would offer it to the next charge of the
          // same amount.
          amazonLedger = consumeAmazonMatch(amazonLedger, hit, key);
          amazonLedgerChanged = true;
        }
      }
      // A Venmo note goes on after typing too, matched on the bank's own text
      // (the run's one-to-one answer, `venmoMatches`), and consumed whether or
      // not the person undid it (`noVenmoNote`).
      // POSTED rows only: the sync rewrites a pending row's note when it posts,
      // and the payment stays live for the posted row (same id or a new one),
      // which gets its note at import or through the late pass.
      if (venmoEnabled && !tx.pending) {
        const hit = venmoMatches.get(key) ?? null;
        if (hit && !hasTxOverride(overrides, key, 'noVenmoNote')) {
          const enriched = venmoDescription(description, hit.note);
          if (enriched !== description) {
            const forAccount = venmoNoted.get(sfAccount.id) ?? new Map<string, { bare: string; enriched: string; note: string }>();
            forAccount.set(tx.id, { bare: description, enriched, note: hit.note });
            venmoNoted.set(sfAccount.id, forAccount);
            description = enriched;
          }
        }
        if (hit) {
          if (venmoLedger[hit.key]?.consumedBy !== key) venmoConsumed.set(hit.key, key);
          venmoLedger = consumeVenmoMatch(venmoLedger, hit, key);
        }
      }
      descByKey.set(key, description);
      signedByKey.set(key, amount);
      // Pending transactions are provisional — exclude them from transfer
      // pairing so a not-yet-settled row can't lock in a TRANSFER typing.
      if (tx.pending) continue;
      // Never paired: pairing would type it a transfer and link it again — or,
      // for a payback, turn it into a transfer leg.
      // (A stored payback a learned name matched stays out too, R13.)
      if (notTransfer || payback || heldAsPayback) continue;
      // A rule's type is never overridden by pair detection, which is why ruled
      // rows sit out of it — except a rule that already says "transfer, this way".
      // Pairing assigns that very type, so all it adds is the link; leaving such a
      // leg out meant it could NEVER link, and after ten days it expired into
      // spending regardless of the rule (live: the $500 to 360 Checking, and the
      // $600 from savings whose expiry rewrite overwrote its linked partner).
      const ruleSaysThisTransfer = type === (amount < 0 ? 'TRANSFER_OUT' : 'TRANSFER_IN');
      candidates.push({
        txId: tx.id, accountId: sfAccount.id, posted: txEpoch(tx)!, amount,
        ruleTyped: fromRule && !ruleSaysThisTransfer,
        accountType: wfTypes.get(wfAccountId),
      });
    }
    preparedByAccount.set(sfAccount.id, prepared);
  }

  // A failed overrides read keeps every stored payback as stored (below), so it
  // must not be paired either: a same-amount placeholder in another account
  // would be rewritten to meet it. Read the stored rows first; an account that
  // cannot be read contributes no keys.
  const unreadPaybackKeys = new Set<string>();
  if (overridesUnread) {
    for (const acc of accountSet.accounts) {
      const wf = mapping[acc.id];
      if (!wf || (wfTypes.get(wf) && wfTypes.get(wf) !== 'CASH')) continue;
      try {
        for (const row of await fetchExistingRows(host, wf)) {
          if (isKeptPayback(row)) unreadPaybackKeys.add(accountTxKey(acc.id, row.txId));
        }
      } catch {
        // skipped
      }
    }
  }
  const detection = detectTransferPairs(unreadPaybackKeys.size === 0
    ? candidates
    : candidates.filter((c) => !unreadPaybackKeys.has(accountTxKey(c.accountId, c.txId))));
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
  // For the feed-aware expiry hold: the epoch each mapped account's feed has
  // proven itself alive through — see expiryHoldAccount. Built once per run,
  // from data this run already fetched; no new I/O.
  const feedAliveEpoch = new Map<string, number>();
  for (const sfAccount of accountSet.accounts) {
    if (!mapping[sfAccount.id]) continue;
    let alive = sfAccount['balance-date'] ?? 0;
    for (const tx of sfAccount.transactions ?? []) {
      const e = txEpoch(tx);
      if (e !== null && e > alive) alive = e;
    }
    feedAliveEpoch.set(sfAccount.id, alive);
  }
  const mappedSfinIds = Object.keys(mapping);
  const nowSec = Math.floor(Date.now() / 1000);
  for (const prepared of preparedByAccount.values()) {
    for (const p of prepared) {
      const key = accountTxKey(p.sfAccountId, p.tx.id);
      if (!isTransferType(p.type) || pairedKeys.has(key)) continue;
      const signed = signedByKey.get(key) ?? 0;
      const postedAt = txEpoch(p.tx) ?? nowSec;
      const accountType = wfTypes.get(mapping[p.sfAccountId] ?? '') ?? '';
      const heldFor = nowSec - postedAt > IN_TRANSIT_TIMEOUT_SECONDS
        ? expiryHoldAccount(p.sfAccountId, postedAt, mappedSfinIds, feedAliveEpoch, {
          nowSec, legDescription: p.tx.description ?? '', nameWords,
        })
        : null;
      if (heldFor !== null) {
        // Past the timeout, but a counterpart feed never had its chance — keep
        // the placeholder (the young branch below) instead of booking spending.
        console.info(
          `[simplefin-sync] in-transit hold: leg ${p.tx.id} (account ${p.sfAccountId}) is past the timeout, but account ${heldFor} has published nothing past its pairing window — keeping the placeholder`,
        );
      } else if (nowSec - postedAt > IN_TRANSIT_TIMEOUT_SECONDS) {
        p.type = expiredTransferLegType(accountType, signed);
        // Booking it as ordinary spending or income is the honest reading of a
        // transfer whose other half never arrived — but it IS a guess, and the
        // inflow direction is the expensive one to get wrong: income inflates
        // the sustainable-spend figure, which tells the user to spend money they
        // do not have. So the row carries the guess to Wealthfolio's own Needs
        // review screen rather than the sync deciding in silence.
        //
        // Resting neutral instead was considered and rejected: since 3.8 no
        // cash-moving OUTFLOW type is neutral to the classifier unless the
        // transfer is linked, so a neutral outflow would count as spending
        // upstream while our own reports excluded it — two views disagreeing
        // permanently, which is worse than one honest guess that is flagged.
        p.needsReview = true;
        // The same drop as the young branch below, for the same reason and one
        // step further on: giving up on the pair turns this into an ordinary
        // deposit or withdrawal, and neither is a refund of anything. Keeping the
        // rule's subtype here would book a transfer leg against a spending
        // category — and because this leg reaches the young branch FIRST (an
        // unpaired leg always does, see the comment below), the row is
        // already stored WITHOUT a subtype by the time it expires, so what this
        // prevents is an update that ADDS one. Reconciliation only ever adds a
        // subtype, never removes one, so nothing later could take it back.
        delete p.subtype;
        continue;
      }
      p.type = neutralAdjustmentFields(accountType, signed, bookkeepingShapeOf(host)).activityType;
      p.inTransit = true;
      // Drop any rule-assigned subtype: a CASH inflow placeholder is
      // spending-neutral ONLY as a BARE CREDIT (see neutralAdjustmentFields),
      // and a refund subtype would book this balance-holding stand-in against
      // a spending category. (A transfer leg is where a subtype is simply
      // meaningless — dropped for the same reason.)
      // Reachable, not theoretical — a rule can type a leg TRANSFER_IN/OUT and
      // carry a subtype, and a ruled leg whose counterpart has not posted yet
      // lands here like any other.
      delete p.subtype;
    }
  }

  // A Venmo note never goes on a row whose FINAL type is a transfer (it may be
  // linked, and Wealthfolio copies a linked leg's note onto its partner) nor on
  // an in-transit placeholder. Decided here, once pairing and the placeholder
  // rules have typed every row; the payment stays consumed.
  for (const prepared of preparedByAccount.values()) {
    for (const p of prepared) {
      const noted = venmoNoted.get(p.sfAccountId)?.get(p.tx.id);
      if (!noted || !(isTransferType(p.type) || p.inTransit)) continue;
      descByKey.set(accountTxKey(p.sfAccountId, p.tx.id), noted.bare);
      venmoNoted.get(p.sfAccountId)!.delete(p.tx.id);
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
    /** The Wealthfolio account type, carried because this pass runs after the
     *  account loop and shapes a spending-neutral row from it. */
    accountType: string;
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

  // Which SimpleFin accounts report each transaction id on this run — every
  // account, mapped or not, since an overwritten leg's partner can sit in an
  // account that is no longer synced. Read by `planOverwrittenLegAdoptions`.
  const accountsByTxId = new Map<string, Set<string>>();
  for (const acc of accountSet.accounts) {
    for (const tx of acc.transactions ?? []) {
      let set = accountsByTxId.get(tx.id);
      if (!set) accountsByTxId.set(tx.id, (set = new Set()));
      set.add(acc.id);
    }
  }
  /** Overwritten legs this run adopted, re-linked under their own identity after the loop. */
  const overwrittenLegs: Array<{ aliasKey: string; partnerTxId: string; sfAccountId: string }> = [];
  /** Linked legs carrying `notTransfer`, kept out of their account's plan and
   *  unlinked — with their partner — after the loop. */
  const unlinkKeys = new Set<string>();
  const notTransferKey = (key: string) => hasTxOverride(overrides, key, 'notTransfer');
  /** A stored row's transfer group: its own where the host reads it, the ledger's otherwise. */
  const gidOfRow = (sf: string, row: StoredRow): string | undefined => (readsGroups
    ? row.sourceGroupId || undefined
    : ledger[accountTxKey(sf, row.txId)] ?? ledger[row.txId]);
  // Every linked pair with a `notTransfer` leg, decided per PAIR across
  // accounts before any account is touched (see planUnlinkPrepass). Only read
  // when an override could make it matter.
  let unlinkPrepass = emptyUnlinkPrepass();
  if (Object.values(overrides.tx).some((o) => o.notTransfer)) {
    const seen: UnlinkSeen[] = [];
    let certain = true;
    for (const acc of accountSet.accounts) {
      const wf = mapping[acc.id];
      if (!wf) continue;
      try {
        for (const row of await fetchExistingRows(host, wf)) seen.push({ sf: acc.id, key: accountTxKey(acc.id, row.txId), row });
      } catch {
        // Not "nothing there": an unread account may hold the other half of
        // a pair, so nothing about any of them is decided this run.
        certain = false;
      }
    }
    unlinkPrepass = planUnlinkPrepass(
      seen, certain,
      (x) => gidOfRow(x.sf, x.row),
      notTransferKey,
      (x) => descByKey.get(x.key) || descriptionFromComment(x.row.comment) || x.row.txId,
      readsGroups ? [] : Object.entries(ledger).filter(([k]) => notTransferKey(k)).map(([, g]) => g),
    );
  }
  /** Keys of transfer rows in OTHER accounts sharing a tx id with a "foreign
   *  payback" (below): left alone with it. Only a host that cannot read groups. */
  const paybackPartnerKeys = new Set<string>();
  // Only for a flagged transaction that is in THIS run's feed, and then only the accounts
  // whose feed carries that transaction id (PB-H m-b): a payback elsewhere costs nothing.
  const flaggedFeedIds = new Set<string>();
  if (!readsGroups) {
    for (const [acc, txs] of feedOf) {
      for (const t of txs) if (hasTxOverride(overrides, accountTxKey(acc.id, t.id), 'asReimbursement')) flaggedFeedIds.add(t.id);
    }
  }
  if (flaggedFeedIds.size > 0) {
    const seen: Array<{ sf: string; row: StoredRow }> = [];
    for (const acc of accountSet.accounts) {
      const wf = mapping[acc.id];
      if (!wf || !(feedOf.get(acc) ?? []).some((t) => flaggedFeedIds.has(t.id))) continue;
      try {
        for (const row of await fetchExistingRows(host, wf)) seen.push({ sf: acc.id, row });
      } catch {
        // an unread account contributes no keys
      }
    }
    for (const { sf, row } of seen) {
      const key = accountTxKey(sf, row.txId);
      const known = !unlinkPrepass.staleKeys.has(key) && (ledger[key] !== undefined || ledger[row.txId] !== undefined);
      if (!isTransferType(row.type) || !hasTxOverride(overrides, key, 'asReimbursement') || known
        || (row.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX)) continue;
      for (const other of seen) {
        // The partner: same id, same amount, the opposite leg (PB-H m-a).
        if (other.sf !== sf && other.row.txId === row.txId && isTransferType(other.row.type)
          && other.row.absCents === row.absCents && other.row.type !== row.type) {
          paybackPartnerKeys.add(accountTxKey(other.sf, other.row.txId));
        }
      }
    }
  }
  const { hiddenIds: unlinkHiddenIds, heldGids, frozenKeys, staleKeys, pairKeys, driftAccounts } = unlinkPrepass;
  /** Groups a leg was found in only by the account loop: their cleanup, if
   *  any, is no longer confirmed (a third row cannot be told apart). */
  const lateGids = new Set<string>();

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;

    try {
    const preparedAll = preparedByAccount.get(sfAccount.id) ?? [];
    /** This account, as change-log entries name it. */
    const accountRef: ChangeAccount = { sfinId: sfAccount.id, wfId: wfAccountId, name: wfNames.get(wfAccountId) || sfAccount.name };
    /** A row's signed amount in cents: the feed's when it has the row, else from the type. */
    const signedCentsOf = (txId: string, type: string, absCents: number): number => {
      const signed = signedByKey.get(accountTxKey(sfAccount.id, txId));
      return signed !== undefined ? Math.round(signed * 100) : OUTFLOW_TYPES.has(type) ? -absCents : absCents;
    };

    // Build the feed for this account and reconcile it against the rows already
    // imported (matched by SimpleFin tx id, so a changed resolved type updates
    // in place rather than re-importing). A failed read of existing rows is
    // treated as "none" — the planner then creates everything and the host's
    // own dedup remains the backstop.
    const feed: FeedTx[] = preparedAll.map(({ tx, type, inTransit, subtype, needsReview, createOnly, keepPayback }) => ({
      txId: tx.id,
      wfAccountId,
      absCents: Math.round(Math.abs(parseFloat(tx.amount)) * 100),
      type,
      date: new Date(txEpoch(tx)! * 1000).toISOString().split('T')[0],
      pending: !!tx.pending,
      ...(inTransit ? { inTransit: true } : {}),
      ...(needsReview ? { needsReview: true } : {}),
      ...(createOnly ? { createOnly: true as const } : {}),
      ...(keepPayback && type === 'DEPOSIT' && !inTransit ? { keepPayback: true as const } : {}),
      // Carried so `changed()` can compare it against the stored row — a rule
      // added after a row was imported has to reach that row as an update, and a
      // row that already agrees must not be rewritten every sync.
      ...(subtype ? { subtype } : {}),
    }));
    // Typed to match what fetchExistingRows returns: these rows feed
    // `linkRowByTxId`, and the link step after the loop reads `sourceGroupId` off
    // them, so it must survive into this variable.
    let existing: StoredRow[] = [];
    try {
      existing = await fetchExistingRows(host, wfAccountId);
    } catch {
      // read unavailable — proceed as if no rows exist
    }

    // ── Pairs the unlink pre-pass holds (see planUnlinkPrepass) ─────────────
    // Their old linked legs leave the snapshot here, so nothing below — the
    // prune, the repairs, the plan, the link step — can update or delete one.
    // Plus any leg the pre-pass could not see: one in a held group, and, when
    // an account could not be read, every linked leg the person undid.
    if (unlinkHiddenIds.size > 0 || heldGids.size > 0 || !unlinkPrepass.certain) {
      const isLinkedLeg = (r: StoredRow) => isTransferType(r.type)
        && !(r.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX) && !!gidOfRow(sfAccount.id, r);
      const held = existing.filter((r) => unlinkHiddenIds.has(r.wfId) || (isLinkedLeg(r)
        && (heldGids.has(gidOfRow(sfAccount.id, r)!) || (!unlinkPrepass.certain && notTransferKey(accountTxKey(sfAccount.id, r.txId))))));
      for (const r of held) {
        if (unlinkHiddenIds.has(r.wfId)) continue;
        const key = accountTxKey(sfAccount.id, r.txId);
        const gid = gidOfRow(sfAccount.id, r)!;
        if (heldGids.has(gid)) lateGids.add(gid);
        heldGids.add(gid);
        staleKeys.add(key);
        pairKeys.add(key);
        driftAccounts.add(sfAccount.id);
        if (!unlinkPrepass.certain) frozenKeys.add(key);
      }
      const heldIds = new Set(held.map((r) => r.wfId));
      existing = existing.filter((r) => !heldIds.has(r.wfId));
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
    // Only on heal (the `Deep scan` button, or auto re-scan). `heal` rather than
    // `opts.heal` deliberately: a user who turned auto-heal on has asked for
    // exactly this kind of repair to happen unattended, and both paths re-scan a
    // wide window, which is what gives the sweep the feed evidence it needs. A
    // routine sync never deletes anything.
    let prunedThisAccount = 0;
    // Not at all when the unlink pre-pass could not read every account: a
    // pair being unlinked may have rows here it could not see.
    if (heal && unlinkPrepass.certain) {
      const feedByTxId = new Map(feed.map((t) => [t.txId, t]));
      // Copies the person chose to keep (Undo of a removed duplicate) are left
      // out of the sweep entirely — every copy shares the one tx key.
      const surplus = planDuplicatePrune(
        existing.filter((r) => !hasTxOverride(overrides, accountTxKey(sfAccount.id, r.txId), 'keepDuplicate')
          // A pair being unlinked has, for a moment, an old linked row and its
          // ordinary replacement under one tx id: not duplicates to prune —
          // neither half of it, override or not.
          && !notTransferKey(accountTxKey(sfAccount.id, r.txId))
          && !pairKeys.has(accountTxKey(sfAccount.id, r.txId))),
        new Set(feedByTxId.keys()),
      );
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
            logChange?.(() => duplicateRemovedChange({
              account: accountRef,
              txKey: accountTxKey(sfAccount.id, row.txId),
              activityId: row.wfId,
              description: entry.description,
              amountCents: signedCentsOf(row.txId, row.type, entry.amountCents),
              date: row.date,
              payload: { ...recreatePayload(row, sfAccount.currency) },
            }));
          }
        }
      }
    }

    // ── Legacy placeholder rewrite (every mode) ──────────────────────────────
    // Runs on every sync, not just heal: on Wealthfolio 3.8 each of these rows
    // is silently booking $0, so the account reads high by the sum of them
    // until this runs — and the user cannot fix a dozen flagged rows by hand
    // faster than the next scheduled sync can. The snapshot is patched in
    // memory so `planReconciliation` below sees the restated row.
    const legacyRewrites = planLegacyPlaceholderRewrite(existing, sfAccount.currency, wfTypes.get(wfAccountId) ?? 'CASH');
    if (legacyRewrites.length) {
      try {
        const res = await host.saveMany({ updates: legacyRewrites });
        if (res.errors.length) {
          errors.push(...res.errors.map((e) => `legacy placeholder rewrite (${sfAccount.name}): ${e.message}`));
        } else {
          for (const u of legacyRewrites) {
            const row = existing.find((r) => r.wfId === u.id);
            if (row) { row.type = u.activityType; row.absCents = Math.round((u.amount ?? 0) * 100); row.feeCents = 0; }
          }
          logChange?.(() => bookkeepingChange({ step: 'legacy-placeholder', account: accountRef, activityIds: legacyRewrites.map((u) => u.id!) }));
          console.info(
            `[simplefin-sync] ${LEGACY_PLACEHOLDER_REWRITE_LOG_TAG}: restated ${legacyRewrites.length} pre-v1.49 placeholder(s) in account ${sfAccount.id} as TRANSFER_OUT with their real amounts`,
          );
        }
      } catch (e: any) {
        errors.push(`legacy placeholder rewrite (${sfAccount.name}): ${String(e?.message ?? e)}`);
      }
    }

    // ── External marker on the sync's own transfer-typed rows (every mode) ──
    // After the legacy rewrite, which is what turns an old fee-side CREDIT into
    // the TRANSFER_OUT this then marks.
    const stamps = planExternalMarkerStamp(existing, sfAccount.currency);
    if (stamps.length) {
      try {
        const res = await host.saveMany({ updates: stamps });
        if (res.errors.length) {
          errors.push(...res.errors.map((e) => `external marker (${sfAccount.name}): ${e.message}`));
        } else {
          for (const u of stamps) {
            const row = existing.find((r) => r.wfId === u.id);
            if (row) row.flowExternal = true;
          }
          logChange?.(() => bookkeepingChange({ step: 'external-marker', account: accountRef, activityIds: stamps.map((u) => u.id!) }));
          console.info(
            `[simplefin-sync] ${EXTERNAL_MARKER_STAMP_LOG_TAG}: marked ${stamps.length} opening-balance/plug/in-transit row(s) in account ${sfAccount.id} as external, so Wealthfolio stops reporting them as incomplete transfers`,
          );
        }
      } catch (e: any) {
        errors.push(`external marker (${sfAccount.name}): ${String(e?.message ?? e)}`);
      }
    }

    // ── Amazon late label (every mode) ───────────────────────────────────────
    // A charge imported before its order email was readable gets the label
    // added to its note now (see planAmazonLateLabels); the Amazon filer then
    // files it on this same companion run. The snapshot is patched so the rest
    // of the pass sees the note as written.
    const lateLabels = planAmazonLateLabels(existing, amazonLabelled.get(sfAccount.id) ?? new Map(), sfAccount.currency);
    if (lateLabels.length) {
      try {
        const res = await host.saveMany({ updates: lateLabels });
        if (res.errors.length) {
          errors.push(...res.errors.map((e) => `Amazon late label (${sfAccount.name}): ${e.message}`));
        } else {
          for (const u of lateLabels) {
            const row = existing.find((r) => r.wfId === u.id);
            if (!row) continue;
            const hit = amazonLabelled.get(sfAccount.id)?.get(row.txId);
            if (hit) {
              logChange?.(() => amazonLabelChange({
                account: accountRef,
                txKey: accountTxKey(sfAccount.id, row.txId),
                activityId: row.wfId,
                description: hit.bare,
                amountCents: signedCentsOf(row.txId, row.type, row.absCents),
                date: row.date,
                beforeNote: row.comment ?? '',
                afterNote: u.comment,
                label: amazonLabelOf(hit.bare, hit.enriched),
              }));
            }
            row.comment = u.comment;
          }
          console.info(
            `[simplefin-sync] ${AMAZON_LATE_LABEL_LOG_TAG}: added the Amazon category to ${lateLabels.length} charge(s) in account ${sfAccount.id} imported before their order email was read`,
          );
        }
      } catch (e: any) {
        errors.push(`Amazon late label (${sfAccount.name}): ${String(e?.message ?? e)}`);
      }
    }

    // ── Venmo late note (every mode) ─────────────────────────────────────────
    // The same pass for a row imported before its Venmo email was read (3).
    const lateNotes = planVenmoLateNotes(existing, venmoNoted.get(sfAccount.id) ?? new Map(), sfAccount.currency);
    if (lateNotes.length) {
      try {
        const res = await host.saveMany({ updates: lateNotes });
        if (res.errors.length) {
          errors.push(...res.errors.map((e) => `Venmo late note (${sfAccount.name}): ${e.message}`));
        } else {
          for (const u of lateNotes) {
            const row = existing.find((r) => r.wfId === u.id);
            if (!row) continue;
            const hit = venmoNoted.get(sfAccount.id)?.get(row.txId);
            if (hit) {
              logChange?.(() => venmoNoteChange({
                account: accountRef,
                txKey: accountTxKey(sfAccount.id, row.txId),
                activityId: row.wfId,
                description: hit.bare,
                amountCents: signedCentsOf(row.txId, row.type, row.absCents),
                date: row.date,
                beforeNote: row.comment ?? '',
                afterNote: u.comment,
                note: hit.note,
              }));
            }
            row.comment = u.comment;
          }
          console.info(
            `[simplefin-sync] ${VENMO_LATE_NOTE_LOG_TAG}: added the Venmo note to ${lateNotes.length} row(s) in account ${sfAccount.id} imported before their Venmo email was read`,
          );
        }
      } catch (e: any) {
        errors.push(`Venmo late note (${sfAccount.name}): ${String(e?.message ?? e)}`);
      }
    }

    // ── Legs carrying their partner's identity ────────────────────────────────
    // Matched to this account's own transaction and kept OUT of the plan: no
    // create (Wealthfolio would refuse it, or worse store a second copy) and no
    // update (an update to a linked leg overwrites its partner in turn). They are
    // re-linked under their own identity after the loop.
    /** The bank's transactions this account's plan may act on: none under a
     *  key the unlink pre-pass froze, whose rows stay exactly as they are. */
    const liveFeed = feed.filter((t) => !frozenKeys.has(accountTxKey(sfAccount.id, t.txId)));
    // A row a rule ignores is absent from `feed` for that reason alone, yet its
    // id is still in the partner account's raw feed, so it would pass for a leg
    // Wealthfolio overwrote and a new, unrelated row would be adopted into it.
    const adoptable = existing.filter((r) => !skippedTxKeys.has(accountTxKey(sfAccount.id, r.txId)));
    const adoptions = planOverwrittenLegAdoptions(
      liveFeed, adoptable,
      (txId) => (signedByKey.get(accountTxKey(sfAccount.id, txId)) ?? 0) > 0,
      (txId) => [...(accountsByTxId.get(txId) ?? [])].some((id) => id !== sfAccount.id),
    );
    const adoptedRowIds = new Set(adoptions.map((a) => a.row.wfId));
    const adoptedTxIds = new Set(adoptions.map((a) => a.tx.txId));
    const planExistingAll = existing.filter((r) => !adoptedRowIds.has(r.wfId));
    // The ledger knows tx keys, not rows: under a key whose linked leg the
    // unlink pre-pass took out of the snapshot, every row left is NOT linked
    // (a held placeholder kept as a "linked leg" would lose its marker and
    // never expire).
    const isLinkedRow = (row: ExistingRow & { sourceGroupId?: string | null }) => readsGroups
      ? !!row.sourceGroupId
      : !staleKeys.has(accountTxKey(sfAccount.id, row.txId))
        && (ledger[accountTxKey(sfAccount.id, row.txId)] !== undefined || ledger[row.txId] !== undefined);
    const isNotTransferLeg = (r: ExistingRow) => isTransferType(r.type)
      && hasTxOverride(overrides, accountTxKey(sfAccount.id, r.txId), 'notTransfer');
    // A host that cannot read groups only knows the links its own ledger
    // recorded. Any other transfer leg the person undid may be linked by the
    // companion, and updating one leg of a linked pair rewrites its partner:
    // leave it for the companion. (A held placeholder is never linked.)
    const foreign = readsGroups ? [] : planExistingAll.filter((r) => isNotTransferLeg(r) && !isLinkedRow(r)
      && !(r.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX));
    for (const r of foreign) {
      const key = accountTxKey(sfAccount.id, r.txId);
      errors.push(`Left ${descByKey.get(key) || descriptionFromComment(r.comment) || r.txId} as it is: this app has no record of linking it; the companion will unlink it on its next sync.`);
    }
    // The same for a leg under an `asReimbursement` key that is a transfer the
    // ledger does not know: something else linked it, and retyping one leg of
    // a linked pair rewrites its partner. Left for the companion.
    const foreignPayback = readsGroups ? [] : planExistingAll.filter((r) => isTransferType(r.type)
      && hasTxOverride(overrides, accountTxKey(sfAccount.id, r.txId), 'asReimbursement') && !isLinkedRow(r)
      && !(r.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX));
    for (const r of foreignPayback) {
      const key = accountTxKey(sfAccount.id, r.txId);
      errors.push(`Left ${descByKey.get(key) || descriptionFromComment(r.comment) || r.txId} as it is: it is marked a payback but is now a transfer this app did not link \u2014 change it in Wealthfolio, or undo the payback from /changes.`);
    }
    // The linked partner of such a leg (a transfer row in another account with
    // the same tx id) is left too: retyping it would rewrite the flagged leg.
    const partnersOfPaybacks = planExistingAll.filter((r) => paybackPartnerKeys.has(accountTxKey(sfAccount.id, r.txId)));
    // A failed or corrupt overrides read reads as no overrides, which would
    // turn every stored payback (money in, cash, CREDIT/REIMBURSEMENT) back
    // into a deposit: keep each exactly as stored, and say so once.
    const keptPaybacks = overridesUnread
      ? planExistingAll.filter((r) => isKeptPayback(r)
        && (!wfTypes.get(wfAccountId) || wfTypes.get(wfAccountId) === 'CASH'))
      : [];
    if (keptPaybacks.length > 0 && !paybackNoteGiven) {
      paybackNoteGiven = true;
      errors.push('Couldn\u2019t read your sync overrides \u2014 paybacks were left as they are.');
    }
    for (const r of planExistingAll) {
      if (r.type === 'CREDIT' && (r.subtype ?? '').toUpperCase() === REIMBURSEMENT_SUBTYPE
        && yieldedPaybackKeys.has(accountTxKey(sfAccount.id, r.txId))
        && preparedAll.some((p) => p.tx.id === r.txId && p.type !== r.type)) {
        console.info(`[simplefin-sync] payback yielded: account ${sfAccount.id}, transaction ${r.txId} is no longer money in on a cash account, so it is typed as usual`);
      }
    }
    const hiddenIds = new Set([...foreign, ...foreignPayback, ...keptPaybacks, ...partnersOfPaybacks].map((r) => r.wfId));
    const foreignTxIds = new Set([...foreign, ...foreignPayback, ...keptPaybacks, ...partnersOfPaybacks].map((r) => r.txId));
    const planExisting = planExistingAll.filter((r) => !hiddenIds.has(r.wfId));
    for (const { row, tx } of adoptions) {
      const aliasKey = accountTxKey(sfAccount.id, tx.txId);
      // `comment` unset so toLinkLeg rebuilds this account's own description.
      linkRowByKey.set(aliasKey, {
        ...row, txId: tx.txId, date: tx.date, absCents: tx.absCents, comment: undefined,
        currency: sfAccount.currency, sfAccountId: sfAccount.id,
      });
      overwrittenLegs.push({ aliasKey, partnerTxId: row.txId, sfAccountId: sfAccount.id });
      console.info(
        `[simplefin-sync] ${OVERWRITTEN_LEG_LOG_TAG}: activity ${row.wfId} in account ${sfAccount.id} carried transaction ${row.txId}; it is ${tx.txId}`,
      );
    }

    for (const row of planExisting) {
      linkRowByKey.set(accountTxKey(sfAccount.id, row.txId), {
        ...row, currency: sfAccount.currency, sfAccountId: sfAccount.id,
      });
    }
    // A LINKED leg the person said is not a transfer is unlinked after the
    // loop, both halves together, and kept out of this plan meanwhile: an
    // update to one leg of a linked pair is copied onto the other.
    const unlinking = planExisting.filter((r) => isTransferType(r.type) && isLinkedRow(r)
      && hasTxOverride(overrides, accountTxKey(sfAccount.id, r.txId), 'notTransfer'));
    for (const r of unlinking) unlinkKeys.add(accountTxKey(sfAccount.id, r.txId));
    const unlinkingIds = new Set(unlinking.map((r) => r.wfId));
    const unlinkingTxIds = new Set(unlinking.map((r) => r.txId));
    const storedByTxId = new Map(planExisting.map((r) => [r.txId, r]));
    const planFeed = liveFeed
      .filter((t) => !adoptedTxIds.has(t.txId) && !unlinkingTxIds.has(t.txId) && !foreignTxIds.has(t.txId))
      .map((t) => {
        const row = storedByTxId.get(t.txId);
        return keepLinkedLegAsStored(t, row, !!row && isLinkedRow(row));
      });
    // ── 1.65 A: in-transit rows outside this download ──
    const staleTransit = planStaleInTransit(planExisting.filter((r) => !unlinkingIds.has(r.wfId)), {
      wfAccountId, sfinAccountId: sfAccount.id, accountType: wfTypes.get(wfAccountId) ?? '',
      // Every feed mapped to this account: a reissued card has two, both in the download.
      feedTxIds: new Set([...preparedByAccount].filter(([id]) => mapping[id] === wfAccountId).flatMap(([, ps]) => ps.map((p) => p.tx.id))), nowSec, mappedSfinIds, feedAliveEpoch, nameWords,
      leaveAlone: (r) => isLinkedRow(r) || frozenKeys.has(accountTxKey(sfAccount.id, r.txId)) || skippedTxKeys.has(accountTxKey(sfAccount.id, r.txId))
        || hasTxOverride(overrides, accountTxKey(sfAccount.id, r.txId), 'asReimbursement'),
      notTransfer: (txId) => notTransferKey(accountTxKey(sfAccount.id, txId)),
    });
    for (const h of staleTransit.held) {
      console.info(
        `[simplefin-sync] in-transit hold: stored leg ${h.txId} (account ${sfAccount.id}) is past the timeout and outside this download, but account ${h.heldBy} has published nothing past its pairing window — keeping the placeholder`,
      );
    }
    for (const t of staleTransit.settle) {
      descByKey.set(accountTxKey(sfAccount.id, t.txId), descriptionFromComment(storedByTxId.get(t.txId)?.comment));
    }
    const plan = planReconciliation([...planFeed, ...staleTransit.settle], planExisting.filter((r) => !unlinkingIds.has(r.wfId)));
    // A held card placeholder keeps the shape it is stored in when anything
    // else about it changes (pending to posted, amount, date): the two writers
    // would otherwise flip it per change, and a 3.8/3.9-written WITHDRAWAL that
    // carries the phantom $CASH asset would be retyped TRANSFER_OUT, which 3.10
    // refuses on every sync until the row expires. Applied to plan.updates
    // itself, so the link rows below see the same type.
    if (wfTypes.get(wfAccountId) === 'CREDIT_CARD') {
      for (const u of plan.updates) {
        const stored = planExisting.find((r) => r.wfId === u.wfId);
        if (!stored || !u.to.inTransit || !(stored.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX)) continue;
        const type = keepBookkeepingOutflow('CREDIT_CARD', stored.type, u.to.type);
        if (type !== u.to.type) u.to = { ...u.to, type: type as typeof u.to.type };
      }
    }

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
        plan.updates.length === 0 && plan.deleteIds.length === 0 && prunedThisAccount === 0
        // `wfValuation` still counts the old linked rows of a held pair (see
        // planUnlinkPrepass) — and with an unread account, any account may
        // hold one.
        && unlinkPrepass.certain && !driftAccounts.has(sfAccount.id);
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
        // The person undid an automatic correction on this account: no plug, but
        // `drift` and `measuredDrift` stay as measured, so the account is still
        // reported (Sync page, alert, the morning 🧹 list).
        const noAutoCorrect = hasAccountOverride(overrides, sfAccount.id, 'noAutoCorrect');
        if (heal && autoAdjust && drift != null && !youngEpisode && !noAutoCorrect) {
          const alreadyToday = await hasAdjustmentToday(host, wfAccountId, sfAccount.id).catch(
            () => false,
          );
          if (!alreadyToday) {
            try {
              const plug = await importAdjustmentActivity(host, {
                sfinAccountId: sfAccount.id,
                wfAccountId,
                currency: sfAccount.currency,
                amount: drift,
              });
              imported += 1;
              if (plug && logChange) {
                const driftCents = Math.round(drift * 100);
                const plugId = await rowIdByComment(() => host.listActivities(wfAccountId), plug.comment);
                logChange(() => balanceCorrectionChange({
                  account: accountRef,
                  actor: 'auto',
                  activityId: plugId,
                  amountCents: driftCents,
                  date: plug.date.slice(0, 10),
                  activityType: plug.activityType,
                  comment: plug.comment,
                }));
              }
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
      aliveThrough: feedAliveEpoch.get(sfAccount.id) ?? sfAccount['balance-date'],
      drift,
      // `measuredDrift` is the run's only trustworthy figure — non-null exactly when
      // the account was comparable — so it, not `drift`, decides this. `drift`
      // additionally goes null for "in sync" and for "plugged this run".
      measured: measuredDrift !== null,
      fetchedAt,
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
      activityDate: bankDayInstant(t.date),
      // Transfer legs carry NO asset so they land as real cash and stay pairable
      // (see isTransferType's note). Everything else resolves the reserved cash
      // asset by symbol — the /activities/bulk endpoint deserializes `symbol` as
      // an AssetResolutionInput object (a bare string 422s with "invalid type:
      // string, expected struct AssetResolutionInput").
      ...(isTransferType(t.type) ? {} : { symbol: { symbol: cashSymbol } }),
      amount: t.absCents / 100,
      currency: sfAccount.currency,
      // The in-transit marker goes at the FRONT: txIdFromComment parses the
      // `… · <txId>` SUFFIX, and every reconciliation match depends on it.
      comment: `${t.inTransit ? IN_TRANSIT_COMMENT_PREFIX : ''}${descByKey.get(accountTxKey(sfAccount.id, t.txId)) ?? ''} · ${t.txId}${t.pending ? PENDING_SUFFIX : ''}`,
      // The rule's classifier, and ONLY when a rule set one. The key is absent
      // rather than `''` on every other row: this field is patch-shaped, so an
      // empty string is a positive instruction to CLEAR — it would wipe a
      // subtype Wealthfolio assigned itself, on every sync, on every row.
      ...(t.subtype ? { subtype: t.subtype } : {}),
      // Only ever sent as `true`, and only by the expiry guess above. Never
      // `false`: that would be this sync asserting a row is fine, overriding a
      // flag the host or the user set for reasons of their own.
      ...(t.needsReview ? { needsReview: true } : {}),
      // A transfer-typed placeholder is born external (see
      // EXTERNAL_BOOKKEEPING_METADATA), so it never shows on Wealthfolio's
      // Health page as an incomplete transfer while it waits for its partner.
      // Linking re-creates both legs with the internal marker instead, and an
      // update that omits metadata leaves the stored value alone.
      ...(t.inTransit && isTransferType(t.type) ? { metadata: EXTERNAL_BOOKKEEPING_METADATA } : {}),
      // Transfer-link sourceGroupId is applied later, atomically (see flush).
    });
    const toActivityUpdate = (wfId: string, t: FeedTx): ActivityWrite => {
      const write = toActivityCreate(t);
      // Never mark a row that is already one half of a link: Wealthfolio then
      // reports the whole pair as conflicting (see planExternalMarkerStamp).
      const stored = existing.find((r) => r.wfId === wfId);
      if (stored && (stored.sourceGroupId || stored.flowExternal === false)) delete write.metadata;
      return withUpdateFields(wfId, write);
    };
    const withUpdateFields = (wfId: string, write: ActivityWrite): ActivityWrite => ({
      ...write,
      // State the fee explicitly, even though nothing the sync writes carries
      // one any more. The server's numeric fields are patch-shaped (an omitted
      // key means "leave unchanged"), and a row written before v1.49 may still
      // hold its amount in `fee`: an update that promotes or expires such a
      // placeholder must clear that side or the row books the wrong amount.
      //
      // `subtype` gets the OPPOSITE treatment, and deliberately: it is inherited
      // from toActivityCreate above, which omits the key when no rule set one.
      // Stating it explicitly here the way `fee` is would send `''` for every
      // unruled row and clear subtypes this sync never owned.
      fee: 0,
      id: wfId,
    });

    // Import only — NO transfer-link gids here. A transfer pair's two legs live
    // in different accounts, so stamping them in these per-account saveMany calls
    // never lets Wealthfolio see a complete 2-leg group (each call looks like a
    // lone leg and the group is dropped). All linking is done atomically after
    // the loop over `linkRowByTxId` (see the flush below).
    /** Rows this run landed, for the starting-balance netting below. */
    let baselineCreated: Array<{ date: string; signed: number }> = [];
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
      // Every planned create that did not land. The plan only ever proposes a
      // create for a tx id NO stored row carries, so a refusal here is always
      // Wealthfolio's own duplicate hash talking — which is exactly the check
      // that ate a real transaction in June.
      for (const t of plan.creates) {
        if (landedTxIds.has(t.txId)) continue;
        refusedCreates.push({
          txId: t.txId,
          description: descByKey.get(accountTxKey(sfAccount.id, t.txId)) ?? '',
          amountCents: t.absCents,
          currency: sfAccount.currency,
          accountName: wfNames.get(t.wfAccountId) || sfAccount.name,
          date: t.date,
        });
      }

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
      // it (the baseline already includes those rows), so net them back out —
      // after the write block, together with the baseline's date check.
      if ((result.errors ?? []).length === 0) {
        // LANDED creates only. This rewrites the starting balance, so netting
        // out a row that was refused moves real money for a row that does not
        // exist. It used to be shielded by the error a duplicate raised; now
        // that a duplicate is (correctly) not an error, the filter is the guard.
        baselineCreated = plan.creates
          .filter((t) => !t.pending && landedTxIds.has(t.txId))
          .map((t) => ({
            date: t.date,
            signed: signedByKey.get(accountTxKey(sfAccount.id, t.txId)) ?? 0,
          }));
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
            direction: (signedByKey.get(accountTxKey(sfAccount.id, txId)) ?? 0) < 0 ? 'out' : 'in',
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
              activityId: a.id,
            });
          }
        }
      }
      // Same for rows updated IN PLACE: the snapshot registered above was read
      // before the plan ran, so it still describes the row as it was. That matters
      // most for an in-transit placeholder promoting to a real transfer — linkPair
      // re-creates both legs verbatim from what it's handed (the addon must), so a
      // stale snapshot would resurrect the placeholder's type and amount.
      // Driven off the echo, so only rows the host confirms it wrote are refreshed.
      const updatedFeedByTxId = new Map(plan.updates.map((u) => [u.to.txId, u.to]));
      // Only rows THIS plan updated. The echo also carries the linked partner
      // Wealthfolio rewrote alongside (in another account, now wearing this leg's
      // note), and taking it for this leg would hand the link step the wrong row.
      const plannedUpdateIds = new Set(plan.updates.map((u) => u.wfId));
      for (const a of result.updated ?? []) {
        const txId = txIdFromComment(a.comment);
        const t = txId ? updatedFeedByTxId.get(txId) : undefined;
        if (!txId || !t || !a.id || !plannedUpdateIds.has(a.id)) continue;
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

      // The change log: an entry per write the host CONFIRMED — a create or an
      // update off its echo, a delete only when its request came back clean.
      // A refused create is in none of these and records nothing (it is on
      // `refusedCreates` already).
      if (logChange) {
        for (const a of result.created ?? []) {
          const txId = txIdFromComment(a.comment);
          const t = txId ? createdFeedByTxId.get(txId) : undefined;
          if (!txId || !t || !a.id) continue;
          const key = accountTxKey(sfAccount.id, txId);
          const facts = () => ({
            account: accountRef, txKey: key, activityId: a.id, description: descByKey.get(key) ?? '',
            amountCents: signedCentsOf(txId, t.type, t.absCents), date: t.date,
          });
          logChange(() => importChange({ ...facts(), pending: !!t.pending, activityType: t.type }));
          // A Venmo note added at import is its own decision (3), so Undo can
          // take the note off and leave the row.
          const noted = venmoNoted.get(sfAccount.id)?.get(txId);
          const written = a.comment ?? '';
          if (noted && written.includes(noted.enriched)) {
            logChange(() => venmoNoteChange({
              ...facts(), description: noted.bare, note: noted.note,
              beforeNote: written.replace(noted.enriched, () => noted.bare), afterNote: written,
            }));
          }
          // Held as a transfer that has not found its other half: a decision
          // of its own, undone in R2 with `notTransfer` on this leg.
          if (t.inTransit) logChange(() => transferTypeChange({ ...facts(), activityType: t.type, previousType: null, held: true }));
        }
        const updateTo = new Map(plan.updates.map((u) => [u.wfId, u.to]));
        for (const a of result.updated ?? []) {
          const to = a.id ? updateTo.get(a.id) : undefined;
          const stored = to ? planExisting.find((r) => r.wfId === a.id) : undefined;
          if (!to || !stored) continue;
          const key = accountTxKey(sfAccount.id, to.txId);
          const facts = () => ({
            account: accountRef, txKey: key, activityId: stored.wfId,
            description: descByKey.get(key) ?? descriptionFromComment(stored.comment),
            amountCents: signedCentsOf(to.txId, to.type, to.absCents), date: to.date,
          });
          // A pending row that has posted is rewritten by this update, and the
          // rewrite carries its Venmo note (pending rows are never noted): the
          // note is its own decision, undone on its own.
          const notedHere = venmoNoted.get(sfAccount.id)?.get(to.txId);
          const writtenHere = a.comment ?? '';
          if (notedHere && writtenHere.includes(notedHere.enriched) && !(stored.comment ?? '').includes(notedHere.enriched)) {
            logChange(() => venmoNoteChange({
              ...facts(), description: notedHere.bare, note: notedHere.note,
              beforeNote: writtenHere.replace(notedHere.enriched, () => notedHere.bare), afterNote: writtenHere,
            }));
          }
          // Two of these are the sync's own transfer decisions, not the bank's:
          // a row now held in transit, and a placeholder that ran out of time
          // (an unpaired leg always passes through the placeholder first).
          const wasInTransit = (stored.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX);
          if (to.inTransit && !wasInTransit) {
            logChange(() => transferTypeChange({ ...facts(), activityType: to.type, previousType: stored.type, held: true }));
          } else if (wasInTransit && !to.inTransit && !isTransferType(to.type)) {
            logChange(() => transferTypeChange({
              ...facts(), activityType: to.type, previousType: stored.type, held: false,
              ...(hasTxOverride(overrides, key, 'notTransfer') ? { undone: true } : {}),
            }));
          } else if (wasInTransit && !to.inTransit) {
            // A held leg found its other half: the `transfer-link` entry that
            // follows is the record of this (and carries the undo). The row
            // update itself is the link's plumbing, not a bank change.
          } else if (
            // The bank finishing the charge — same id, same everything but
            // the pending flag — is not worth an entry (it would be one per
            // pending row, forever).
            to.txId === stored.txId && stored.pending && !to.pending
            && stored.absCents === to.absCents && stored.type === to.type && stored.date === to.date
            && !(to.subtype && (stored.subtype ?? '').trim().toUpperCase() !== to.subtype.trim().toUpperCase())
          ) {
            // record nothing
          } else {
            logChange(() => bankUpdateChange({
              ...facts(),
              ...(to.txId !== stored.txId ? { previousTxKey: accountTxKey(sfAccount.id, stored.txId) } : {}),
              before: { absCents: stored.absCents, date: stored.date, pending: stored.pending, activityType: stored.type, subtype: stored.subtype ?? null },
              after: { absCents: to.absCents, date: to.date, pending: to.pending, activityType: to.type, subtype: to.subtype ?? null },
            }));
          }
        }
        for (const id of result.deleted) {
          const stored = planExisting.find((r) => r.wfId === id);
          if (!stored) continue;
          logChange(() => pendingRemovedChange({
            account: accountRef,
            txKey: accountTxKey(sfAccount.id, stored.txId),
            activityId: stored.wfId,
            description: descriptionFromComment(stored.comment),
            amountCents: signedCentsOf(stored.txId, stored.type, stored.absCents),
            date: stored.date,
          }));
        }
      }
    }

    // Every run, not only one that imported: a baseline stranded after older
    // history by an earlier version has no new row to trigger its repair.
    try {
      const moved = await keepStartingBalanceOldest(host, {
        wfAccountId,
        sfinAccountId: sfAccount.id,
        currency: sfAccount.currency,
        accountType: wfTypes.get(wfAccountId) ?? '',
        created: baselineCreated,
        recent: existing,
      });
      if (moved) logChange?.(() => startingBalanceMovedChange({ account: accountRef, actor: 'auto', ...moved }));
    } catch (e: any) {
      errors.push(`Account ${wfAccountId} starting-balance adjust failed: ${e?.message ?? e}`);
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
        const shape = startingBalanceFields(wfTypes.get(wfAccountId) ?? '', starting, bookkeepingShapeOf(host));
        const correction: ImportRow = {
          accountId: wfAccountId,
          sourceSystem: 'simplefin',
          activityType: shape.activityType,
          date: bankDayInstant(dayBeforeDate),
          symbol: `$CASH-${sfAccount.currency}`,
          amount: shape.amount,
          currency: sfAccount.currency,
          comment: `${STARTING_BALANCE_COMMENT_PREFIX}${sfAccount.id}`,
          isValid: true,
          isDraft: false,
        };
        try {
          await host.importActivities([correction]);
          imported += 1;
          if (logChange) {
            const sbId = await rowIdByComment(() => host.listOldestActivities(wfAccountId, STARTING_BALANCE_SCAN), correction.comment);
            logChange(() => startingBalanceChange({
              account: accountRef,
              activityId: sbId,
              amountCents: Math.round(starting * 100),
              date: dayBeforeDate,
              activityType: correction.activityType,
              comment: correction.comment,
            }));
          }
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
        // Carried, not re-derived later: the second pass runs after the account
        // loop, where `sfAccount` is gone, and a correction shaped without the
        // account type books a phantom purchase on a card (see site one).
        accountType: wfTypes.get(wfAccountId) ?? '',
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
            const shape = startingBalanceFields(p.accountType, starting, bookkeepingShapeOf(host));
            const correction: ImportRow = {
              accountId: p.wfAccountId,
              sourceSystem: 'simplefin',
              activityType: shape.activityType,
              date: bankDayInstant(p.date),
              symbol: `$CASH-${p.currency}`,
              amount: shape.amount,
              currency: p.currency,
              comment: `${STARTING_BALANCE_COMMENT_PREFIX}${p.sfinAccountId}`,
              isValid: true,
              isDraft: false,
            };
            await host.importActivities([correction]);
            imported += 1;
            if (logChange) {
              const sbId = await rowIdByComment(() => host.listOldestActivities(p.wfAccountId, STARTING_BALANCE_SCAN), correction.comment);
              logChange(() => startingBalanceChange({
                account: {
                  sfinId: p.sfinAccountId,
                  wfId: p.wfAccountId,
                  name: wfNames.get(p.wfAccountId) || (accountSet.accounts.find((a) => a.id === p.sfinAccountId)?.name ?? ''),
                },
                activityId: sbId,
                amountCents: Math.round(starting * 100),
                date: p.date,
                activityType: correction.activityType,
                comment: correction.comment,
              }));
            }
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

  // ── Unlink: a linked pair with a leg the person said is not a transfer ──
  //
  // Both legs are deleted together and re-created as ordinary money in or out
  // (`unlinkPairByRecreate`), and every later step this run leaves them alone.
  // The partner is found the way "already linked?" is answered: the rows'
  // shared group where the host reads it, the ledger where it cannot. A leg
  // whose other half is not in view is left linked and reported — deleting one
  // leg of a pair deletes both, and the unseen half could not be re-created.
  // A pair the pre-pass holds is in here from the start: no step this run
  // pairs, links or relinks it (each of those deletes and re-creates a row,
  // and the re-create would collide with an old linked leg still standing).
  const unlinkedKeys = new Set<string>(staleKeys);
  const partnerKeyOf = (key: string, row: LinkableRow): string | null => {
    const gid = readsGroups ? row.sourceGroupId : (ledger[key] ?? ledger[row.txId]);
    if (!gid) return null;
    for (const [k, r] of linkRowByKey) {
      if (k === key || r.sfAccountId === row.sfAccountId) continue;
      const same = readsGroups
        ? r.sourceGroupId === gid
        : ledger[k] === gid || (r.txId !== row.txId && ledger[r.txId] === gid);
      if (same) return k;
    }
    return null;
  };
  for (const key of unlinkKeys) {
    if (unlinkedKeys.has(key)) continue;
    const row = linkRowByKey.get(key);
    if (!row) continue;
    const partnerKey = partnerKeyOf(key, row);
    const partner = partnerKey ? linkRowByKey.get(partnerKey) : undefined;
    unlinkedKeys.add(key);
    if (!partner || !partnerKey) {
      errors.push(`Could not unlink ${descByKey.get(key) || descriptionFromComment(row.comment) || row.txId}: its other half is not in this sync — it stays linked for now`);
      continue;
    }
    unlinkedKeys.add(partnerKey);
    const leg = (r: LinkableRow): UnlinkLeg => {
      const base = toLinkLeg(r);
      // The feed's own sign when the leg is in it; else from the stored type.
      const fed = signedByKey.get(accountTxKey(r.sfAccountId, r.txId));
      const signed = fed !== undefined ? Math.round(fed * 100)
        : UNLINK_OUTFLOW_TYPES.has(r.type) ? -r.absCents : r.absCents;
      return { ...base, accountName: wfNames.get(r.wfAccountId), newType: expiredTransferLegType(wfTypes.get(r.wfAccountId) ?? '', signed) };
    };
    let result: UnlinkResult;
    try {
      // In place where the host can (Wealthfolio's own unlink, the same rows
      // retyped), else re-created as it always was.
      result = host.unlinkPair
        ? await host.unlinkPair([leg(row), leg(partner)])
        : await unlinkPairByRecreate((req) => host.saveMany(req), [leg(row), leg(partner)]);
    } catch (e: any) {
      result = { unlinked: false, problems: [String(e?.message ?? e)] };
    }
    if (!result.unlinked) {
      for (const p of result.problems ?? []) errors.push(`Transfer-unlink ${result.stale ? 'incomplete' : 'failed'} (${row.txId}/${partner.txId}): ${p}`);
      continue;
    }
    // Unlinked in place but not retyped: the pair is apart, and says what is left.
    for (const p of result.problems ?? []) errors.push(`Transfer-unlink incomplete (${row.txId}/${partner.txId}): ${p}`);
    // An incomplete unlink keeps its ledger records and logs nothing yet: the
    // rows are still typed as transfers, so the next run finds the pair again
    // through the ledger and finishes the retype.
    if (result.inPlace && (result.problems?.length ?? 0) > 0) continue;
    if (!readsGroups) {
      const gid = ledger[key] ?? ledger[row.txId];
      for (const [k, r] of [[key, row], [partnerKey, partner]] as const) {
        if (k in ledger) { delete ledger[k]; ledgerChanged = true; }
        if (r.txId in ledger && ledger[r.txId] === gid) { delete ledger[r.txId]; ledgerChanged = true; }
      }
    }
    const unlinkedPair: Array<[string, LinkableRow]> = [[key, row], [partnerKey, partner]];
    logChange?.(() => bookkeepingChange({
      step: 'transfer-unlink', activityIds: result.activityIds ?? [row.wfId, partner.wfId],
      legs: unlinkedPair.map(([k, r]) => ({ txKey: k, description: descByKey.get(k) || descriptionFromComment(r.comment) || r.txId })),
      ...(result.inPlace ? { inPlace: true } : {}),
    }));
  }

  // The old linked pair of an unlink whose delete failed last time, confirmed
  // by planUnlinkPrepass: each leg has its ordinary row already, so this only
  // deletes — no second create. One request per pair, so each says how it went.
  for (const pair of unlinkPrepass.cleanup) {
    const txIds = pair.old.map((m) => m.row.txId).join('/');
    if (lateGids.has(pair.gid)) {
      unlinkPrepass.waiting.push({ txIds: pair.old.map((m) => m.row.txId), reason: 'its linked rows cannot be told apart' });
      continue;
    }
    let problem: string | null = null;
    try {
      const del = await host.saveMany({ deleteIds: pair.old.map((m) => m.row.wfId) });
      if (del.errors.length > 0) problem = del.errors.map((e) => `${e.action}: ${e.message}`).join('; ');
    } catch (e: any) {
      problem = String(e?.message ?? e);
    }
    if (problem !== null) {
      errors.push(`Transfer-unlink cleanup incomplete (${txIds}): the old linked pair is still there next to the new rows: ${problem}`);
      continue;
    }
    if (!readsGroups) {
      // Both legs' entries go: they share the pair's group id.
      for (const [k, g] of Object.entries(ledger)) {
        if (g === pair.gid) { delete ledger[k]; ledgerChanged = true; }
      }
    }
    logChange?.(() => bookkeepingChange({
      step: 'transfer-unlink', pairs: 1, rows: pair.replacements.length,
      activityIds: [...pair.replacements, ...pair.old].map((m) => m.row.wfId),
      legs: pair.old.map((m) => ({ txKey: m.key, description: descByKey.get(m.key) || descriptionFromComment(m.row.comment) || m.row.txId })),
    }));
  }
  for (const w of unlinkPrepass.waiting) {
    errors.push(`Transfer-unlink cleanup waiting (${w.txIds.join('/')}): ${w.reason} — the old linked rows stay for now, nothing was deleted`);
  }
  // Whenever the pre-pass read was uncertain (it runs only while a notTransfer
  // override exists), held pair or not: the run skipped the prune, the relink
  // sweep and drift for EVERY account, and this note is the only sign of it.
  if (!unlinkPrepass.certain) {
    errors.push('Could not read every account, so a transfer you undid was not unlinked or cleaned up this sync — nothing was deleted; the next sync tries again');
  }

  for (const { out, in: inLeg } of detection.pairs) {
    // Resolved per (account, tx id). When SimpleFin gave both sides of the
    // transfer ONE id these two keys still differ — by account — which is what
    // keeps them two distinct rows in two accounts instead of one row twice.
    const outKey = accountTxKey(out.accountId, out.txId);
    const inKey = accountTxKey(inLeg.accountId, inLeg.txId);
    if (unlinkedKeys.has(outKey) || unlinkedKeys.has(inKey)) continue;
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

  // Overwritten legs: re-link each with the partner whose identity it was wearing,
  // so both are re-created under their OWN note, date and fingerprint. Even when
  // the two already share a group — that is the state being repaired. Skipped
  // (the leg just stays adopted) unless the partner is a real opposite leg of the
  // same amount in another account.
  const queuedKeys = new Set(pairsToLink.flatMap((p) => p.keys));
  for (const { aliasKey, partnerTxId, sfAccountId } of overwrittenLegs) {
    const alias = linkRowByKey.get(aliasKey);
    const partnerKey = [...(accountsByTxId.get(partnerTxId) ?? [])]
      .filter((id) => id !== sfAccountId)
      .map((id) => accountTxKey(id, partnerTxId))
      .find((key) => linkRowByKey.has(key));
    const partner = partnerKey ? linkRowByKey.get(partnerKey) : undefined;
    if (!alias || !partner || !partnerKey || queuedKeys.has(aliasKey) || queuedKeys.has(partnerKey)) continue;
    // A leg the person said is not a transfer is never linked again.
    if ([aliasKey, partnerKey].some((k) => unlinkedKeys.has(k) || hasTxOverride(overrides, k, 'notTransfer'))) continue;
    const opposite = new Set([alias.type, partner.type]);
    if (!opposite.has('TRANSFER_IN') || !opposite.has('TRANSFER_OUT')) continue;
    if (alias.absCents !== partner.absCents || alias.wfAccountId === partner.wfAccountId) continue;
    const [outRow, outKey, inRow, inKey] = alias.type === 'TRANSFER_OUT'
      ? [alias, aliasKey, partner, partnerKey] as const
      : [partner, partnerKey, alias, aliasKey] as const;
    linkedKeys.add(outKey);
    linkedKeys.add(inKey);
    queuedKeys.add(outKey);
    queuedKeys.add(inKey);
    pairsToLink.push({ legs: [toLinkLeg(outRow), toLinkLeg(inRow)], keys: [outKey, inKey] });
  }

  // ── Holdings snapshots (investment accounts only) ────────────────────────
  //
  // A separate pass rather than a step inside the account loop above: holdings
  // share nothing with transaction reconciliation — not the plan, not the balance
  // arithmetic, not the transfer pairing — and that loop has several `continue`
  // paths a snapshot step would silently ride along with.
  //
  // Failure is per account and never fatal. A rejected snapshot is a reporting
  // problem, the account's transactions are already saved by this point, and
  // taking the run down over positions would cost the thing that matters to save
  // the thing that does not.
  const holdingsSnapshots = noHoldings();
  if (host.syncHoldings) {
    for (const sfAccount of accountSet.accounts) {
      const wfAccountId = mapping[sfAccount.id];
      if (!wfAccountId) continue;
      const snapshot = toHoldingsSnapshot(sfAccount);
      if (!snapshot) continue;
      try {
        const outcome = await host.syncHoldings(wfAccountId, snapshot, feedPrices(sfAccount), { tag: accountTag(wfAccountId) });
        holdingsSnapshots.imported += outcome.imported;
        holdingsSnapshots.skipped += outcome.skipped;
        for (const symbol of outcome.pricedFromFeed ?? []) {
          (holdingsSnapshots.pricedFromFeed ??= []).push(symbol);
        }
        if (outcome.pricedFromFeed?.length) {
          console.log(`[simplefin-sync] priced ${outcome.pricedFromFeed.join(', ')} (${sfAccount.name}) from SimpleFin's market value`);
        }
        for (const symbol of outcome.unresolvedSymbols) {
          // Deduped across accounts: the same unresolvable ticker in two
          // brokerages is one problem to report, not two.
          if (!holdingsSnapshots.unresolvedSymbols.includes(symbol)) {
            holdingsSnapshots.unresolvedSymbols.push(symbol);
          }
        }
      } catch (e: any) {
        errors.push(`Holdings snapshot failed (${sfAccount.name}): ${e?.message ?? e}`);
      }
    }
  }

  // ── Loan balances (accounts linked to a liability) ───────────────────────
  //
  // A pass of its own for the same reasons as the holdings one: a loan account
  // is never mapped, so it takes no part in the account loop, and a refused
  // write is per loan and never fatal.
  let loanBalancesRecorded = 0;
  if (loansById && host.confirmLoanBalance) {
    // One loan, one feed: two accounts linked to it (SimpleFin shows a duplicate
    // after a bank is re-linked) would each overwrite the other every sync, so
    // neither is recorded until the person keeps one link.
    const feedsOfLoan = new Map<string, string[]>();
    for (const sfAccount of accountSet.accounts) {
      const assetId = loanLinks[sfAccount.id];
      if (assetId && loansById.has(assetId)) feedsOfLoan.set(assetId, [...(feedsOfLoan.get(assetId) ?? []), sfAccount.name]);
    }
    for (const [assetId, names] of feedsOfLoan) {
      if (names.length < 2) continue;
      errors.push(`Loan balance not recorded: ${loansById.get(assetId)!.name} is linked from ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}; keep one link`);
    }
    for (const sfAccount of accountSet.accounts) {
      const loan = loansById.get(loanLinks[sfAccount.id] ?? '');
      if (!loan || feedsOfLoan.get(loan.id)!.length > 1) continue;
      try {
        const entry = loanBalanceOf(sfAccount);
        if (!entry) continue;
        const decision = await host.confirmLoanBalance(loan, entry);
        if (decision === 'write') loanBalancesRecorded++;
        else if (decision === 'zero') {
          errors.push(`${sfAccount.name} shows nothing owed on ${loan.name}: if the loan is paid off, close it in Wealthfolio`);
        } else if (decision === 'currency') {
          errors.push(`Loan balance not recorded (${sfAccount.name}): the bank reports ${entry.currency}, ${loan.name} is in ${loan.currency}`);
        } else if (decision === 'theirs') {
          console.log(`[simplefin-sync] ${sfAccount.name}: ${entry.date} already has a balance you recorded, so the bank's is not written`);
        } else if (decision === 'early') {
          console.log(`[simplefin-sync] ${sfAccount.name}: ${entry.date} is before ${loan.name} began, so the bank's balance is not written`);
        }
      } catch (e: any) {
        errors.push(`Loan balance failed (${sfAccount.name}): ${e?.message ?? e}`);
      }
    }
    if (loanBalancesRecorded > 0) {
      console.log(`[simplefin-sync] ${loanBalancesRecorded} loan balance(s) recorded`);
    }
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
  /** One leg of a confirmed link, as the change log names it. */
  const linkLegFacts = (leg: LinkLeg, key: string, newActivityId?: string): LinkLegFacts => {
    const sfinId = linkRowByKey.get(key)?.sfAccountId;
    const signed = signedByKey.get(key);
    return {
      account: {
        ...(sfinId ? { sfinId } : {}),
        wfId: leg.accountId,
        name: wfNames.get(leg.accountId) || (accountSet.accounts.find((a) => a.id === sfinId)?.name ?? ''),
      },
      txKey: key,
      description: descByKey.get(key) ?? descriptionFromComment(leg.comment),
      amountCents: signed !== undefined ? Math.round(signed * 100) : OUTFLOW_TYPES.has(leg.activityType) ? -leg.absCents : leg.absCents,
      date: leg.date,
      oldActivityId: leg.wfId,
      ...(newActivityId ? { newActivityId } : {}),
    };
  };
  for (const { legs, keys } of pairsToLink) {
    let result: LinkResult;
    try {
      result = await host.linkPair(legs);
    } catch (e: any) {
      errors.push(`Transfer-link failed (${legs[0].txId}/${legs[1].txId}): ${e?.message ?? e}`);
      continue; // leave the ledger untouched so the pair retries next run
    }
    if (result.linked && result.groupId) {
      logChange?.(() => transferLinkChange(
        linkLegFacts(legs[0], keys[0], result.activityIds?.[0]),
        linkLegFacts(legs[1], keys[1], result.activityIds?.[1]),
      ));
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
        // A link in place carries Wealthfolio's own group id; the ledger keeps
        // it under the prefix its one-time migration does not drop.
        const gid = ledgerGroupId(result.groupId);
        if (ledger[key] !== gid) {
          ledger[key] = gid;
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
  //
  // Not at all when the unlink pre-pass could not read every account: the
  // re-create can collide with an old linked leg it could not see, after the
  // delete has already gone through.
  const relinkCreates: ActivityWrite[] = [];
  const staleLegIds: string[] = [];
  for (const [key, row] of unlinkPrepass.certain ? linkRowByKey : []) {
    if (!isTransferType(row.type) || !row.assetId || linkedKeys.has(key) || unlinkedKeys.has(key)) continue;
    staleLegIds.push(row.wfId);
    relinkCreates.push({
      accountId: row.wfAccountId,
      activityType: row.type,
      activityDate: bankDayInstant(row.date),
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
    if ((del.errors ?? []).length === 0 && (result.errors ?? []).length === 0) {
      const fresh = (result.created ?? []).map((a) => a.id).filter((id): id is string => !!id);
      logChange?.(() => bookkeepingChange({
        step: 'transfer-relink',
        activityIds: fresh.length === relinkCreates.length ? fresh : staleLegIds,
      }));
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
  if (venmoConsumed.size > 0 && store.getVenmoLedger && store.setVenmoLedger) {
    // The mail poll may have merged new payments since the read at the top of
    // the run: re-read, apply only THIS run's consumptions, and never write
    // over a document that cannot be read.
    try {
      const fresh = await store.getVenmoLedger();
      if (!isReadableVenmoLedger(fresh)) throw new Error('unreadable');
      let next = fresh;
      let changed = false;
      for (const [k, txKey] of venmoConsumed) {
        const rec = next[k];
        if (!rec || rec.consumedBy === txKey) continue;
        if (rec.consumedBy) continue; // another row took it meanwhile
        next = { ...next, [k]: { ...rec, consumedBy: txKey } };
        changed = true;
      }
      if (changed) await store.setVenmoLedger(next);
    } catch (e: any) {
      errors.push(`Could not save the Venmo payment ledger: ${String(e?.message ?? e)}`);
    }
  }

  // The badge for every card Wealthfolio does not value, totalled AFTER this
  // run's own saves. Live case (2026-10-18): after an in-app Sync every card
  // said "not checked", because the valuations API is cash-only and the add-on
  // had no ledger figure. B3: a POSTED-only total is comparable to the bank's
  // posted balance whatever is pending, so pending rows no longer block it.
  // R15: the BADGE ONLY. Alerts, the starting balance, auto-heal, the
  // baseline-fix offer and every write keep the before-save figure, which
  // subtracts this run's rows from a before-save read and would count them
  // twice if fed this one. A verdict the run already measured stands.
  // Cards only (B1, F5): an account whose type is unknown (listAccounts failed)
  // is not asked either, since an untyped total counts a card's interest as income.
  if (host.postedLedgerTotals && wfBalances !== null) {
    const unchecked = accountSet.accounts.filter((sf) => {
      const wf = mapping[sf.id];
      const snap = accountBalances[sf.id];
      return !!wf && wfTypes.get(wf) === 'CREDIT_CARD' && !valuedWfIds.has(wf) && !!snap && snap.measured !== true && snap.balance !== null;
    });
    if (unchecked.length > 0) {
      const wanted = [...new Set(unchecked.map((sf) => mapping[sf.id]))]
        .map((wfAccountId) => ({ wfAccountId, accountType: wfTypes.get(wfAccountId) ?? '' }));
      const totals = await host.postedLedgerTotals(wanted).catch(() => null);
      for (const sf of unchecked) {
        const total = totals?.get(mapping[sf.id]);
        const snap = accountBalances[sf.id];
        if (total === undefined || snap.balance === null) continue;
        Object.assign(snap, badgeVerdict(snap.balance, total), { checkedAfterSave: true as const });
      }
    }
  }
  await store.setAccountBalances(accountBalances);
  // Persisted as well as returned: the sync that discovers a new account is
  // normally the COMPANION's, and the addon's UI has no way to see a return
  // value from that. Overwritten every run, so mapping the account clears the
  // banner on the next sync. Optional on the interface and guarded here — an
  // older host loses the banner, never the sync.
  await store.setUnmappedAccounts?.(unmappedAccounts).catch(() => {});

  await store.setLastSyncAt(new Date());
  // Alongside the timestamp, and only here: an interval skip returns long before
  // this point, so the last REAL run's figure survives one. A genuine 0 is recorded
  // rather than left at the previous number — "nothing to import" is information,
  // and keeping the old count would report activity that did not happen.
  await store.setLastSyncImported(imported).catch(() => {});

  return {
    imported, skipped, errors, stuckTransferAlerts, importedTransactions,
    largeTransactionAlerts, balanceDriftAlerts, prunedDuplicates, unmappedAccounts,
    refusedCreates,
    holdingsSnapshots,
    ignoredByRules,
    loanBalancesRecorded,
  };
}
