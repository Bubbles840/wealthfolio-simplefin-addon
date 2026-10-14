/**
 * companion/src/tx-story-host.ts
 *
 * The companion's half of "Why is this here?": everything it can see about
 * one transaction, gathered into shared/tx-story.ts's facts, and the search
 * behind `/why`. It sees more than the add-on can — the row and the rules over
 * REST; the other half of a link, the category and who put it there from the
 * read-only database; the mapping, the overrides and the skip list from the
 * add-on's settings; and the change log — so its story is the whole story.
 *
 * Every read but the row's own is wrapped: a failure leaves that part of the
 * story out and adds a note (`failed`). An overrides document that cannot be
 * parsed is reported, never read as "none". Only the row failing is a full
 * failure ("Couldn't reach Wealthfolio — try again."). A row that no longer
 * exists is followed forward through the change log once — a transfer link
 * re-created it — and is `gone` only when nothing leads on (it was removed).
 */
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { changesForTransaction, currentActivityId, isChangeLogPartial } from '../../shared/change-view.js';
import { parseSkippedTransactionsStrict, SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions.js';
import { txIdFromComment } from '../../shared/sync-core.js';
import { hasTxOverride, loadSyncOverrides, TX_OVERRIDE_FLAGS, type TxOverrideFlag } from '../../shared/sync-overrides.js';
import { accountTxKey } from '../../shared/transfers.js';
import { findTransactions, txDescription, TX_SEARCH_RECENT_DAYS, type TxQuery, type TxSearchResult, type TxSearchRow } from '../../shared/tx-search.js';
import {
  buildTxStory, feedOf, resolveFiler, sfinIdsFor, signedCents, type CategoryRuleLike, type TxFactName, type TxStory,
  type TxStoryFacts, type TxStoryRow,
} from '../../shared/tx-story.js';
import { readCompanionChangeLog, type SecretClient } from './change-log-host.js';
import {
  getNativeTxDetails, getNativeTxPartner, getNativeTxSearchRows, type NativeTxAssignment, type NativeTxSearchRow,
} from './sqlite-native.js';
import type { ActivitySearchItem, WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';
const SPENDING_TAXONOMY_ID = 'spending_categories';
/** REST pages the 12-month fallback reads at most (500 rows each). */
const RECENT_PAGE_SIZE = 500;
const RECENT_MAX_PAGES = 20;

/** Everything the story and the search read, so a test can fake each one. */
export interface StoryReaders {
  /** The row by REST; null when it no longer exists. Rejects when Wealthfolio
   *  cannot be reached. */
  row(activityId: string): Promise<ActivitySearchItem | null>;
  /** Account type and every assignment (database). Throws when unreadable. */
  details(activityId: string): { accountType: string; assignments: NativeTxAssignment[] };
  /** The other activity in the group (database). Throws when unreadable. */
  partner(groupId: string, activityId: string): { activityId: string; accountName: string; date: string } | null;
  /** The categorization rules, in the server's order. */
  rules(): Promise<CategoryRuleLike[]>;
  changeLog(now: Date): Promise<ChangeLogRead>;
  /** An add-on setting. */
  secret(key: string): Promise<string | null>;
  /** All of history (database). Throws when unreadable. */
  searchRows(): NativeTxSearchRow[];
  /** REST, every activity dated `dateFrom` (YYYY-MM-DD) or later. */
  recentRows(dateFrom: string): Promise<RecentRows>;
}

/** The REST fallback's rows (archived accounts left out, each with its
 *  account's type) and whether the page cap cut them short. */
export interface RecentRows {
  rows: Array<ActivitySearchItem & { accountType: string }>;
  truncated: boolean;
}

export type StoryClient = SecretClient & Pick<WealthfolioClient, 'searchActivities' | 'listCategorizationRules' | 'getAccounts'>;

export function companionStoryReaders(client: StoryClient, dbPath: string): StoryReaders {
  return {
    row: async (activityId) =>
      (await client.searchActivities({ page: 0, pageSize: 1, activityIdFilter: [activityId] })).find((a) => a.id === activityId) ?? null,
    details: (activityId) => getNativeTxDetails(dbPath, activityId),
    partner: (groupId, activityId) => getNativeTxPartner(dbPath, groupId, activityId),
    rules: () => client.listCategorizationRules(),
    changeLog: (now) => readCompanionChangeLog(client, now),
    secret: (key) => client.getAddonSecret(ADDON_ID, key),
    searchRows: () => getNativeTxSearchRows(dbPath),
    recentRows: async (dateFrom) => {
      const accounts = new Map((await client.getAccounts()).map((a) => [a.id, a]));
      const all: ActivitySearchItem[] = [];
      let truncated = false;
      for (let page = 0; page < RECENT_MAX_PAGES; page++) {
        const items = await client.searchActivities({ page, pageSize: RECENT_PAGE_SIZE, dateFrom });
        all.push(...items);
        if (items.length < RECENT_PAGE_SIZE) break;
        if (page === RECENT_MAX_PAGES - 1) truncated = true;
      }
      return {
        rows: all
          .filter((a) => !accounts.get(a.accountId)?.isArchived)
          .map((a) => ({ ...a, accountType: accounts.get(a.accountId)?.accountType ?? '' })),
        truncated,
      };
    },
  };
}

export type StoryOutcome =
  /** `movedTo`: the id asked for was replaced (a transfer link, or an Undo
   *  that put the row back); the story is that row's, under this id. */
  | { kind: 'ok'; story: TxStory; facts: TxStoryFacts; movedTo?: string }
  | { kind: 'gone' }
  | { kind: 'unreachable' };

const absCentsOf = (amount: unknown) => Math.round(Math.abs(Number(amount ?? 0)) * 100) || 0;

/** One transaction's story. Never rejects. A row that no longer exists is
 *  followed forward through the change log once (`currentActivityId`), so an
 *  old button — a queued alert, an import a link re-created — still opens it. */
export async function companionTxStory(readers: StoryReaders, requestedId: string, now: Date): Promise<StoryOutcome> {
  let activityId = requestedId;
  let item: ActivitySearchItem | null;
  // Read once, here or below; a failed read here is retried below.
  let logRead: Promise<ChangeLogRead> | null = null;
  try {
    item = await readers.row(activityId);
    if (!item) {
      logRead = readers.changeLog(now);
      const moved = await logRead.then((read) => currentActivityId(read.entries, activityId), () => activityId);
      if (moved === activityId) return { kind: 'gone' };
      item = await readers.row(moved);
      activityId = moved;
    }
  } catch {
    return { kind: 'unreachable' };
  }
  if (!item) return { kind: 'gone' };

  const failed: TxFactName[] = [];
  const note = item.comment ?? '';
  const txId = txIdFromComment(note);

  // The mapping: every SimpleFin account this row's account syncs from (two
  // feeds can share one); the row's keys are its tx id under each.
  let sfinIds: string[] | undefined;
  try {
    const raw = await readers.secret('account_mapping');
    sfinIds = sfinIdsFor(raw ? JSON.parse(raw) as Record<string, string> : {}, item.accountId);
  } catch {
    failed.push('mapping');
  }
  const txKeys = txId ? (sfinIds ?? []).map((id) => accountTxKey(id, txId)) : [];

  let details: { accountType: string; assignments: NativeTxAssignment[] } | null = null;
  try {
    details = readers.details(activityId);
  } catch {
    failed.push('category');
  }

  let partner: TxStoryFacts['partner'] = null;
  if (item.sourceGroupId) {
    try {
      const p = readers.partner(item.sourceGroupId, activityId);
      partner = p ? { accountName: p.accountName, date: p.date } : null;
    } catch {
      partner = undefined;
      failed.push('partner');
    }
  }

  let history: ChangeLogItem[] | null = null;
  // A bucket that can't be read, or a gap, may hold the filing: the history
  // keeps what was read, but who filed it is not inferred from an absence.
  let partial = false;
  try {
    const read = await (logRead ? logRead.catch(() => readers.changeLog(now)) : readers.changeLog(now));
    partial = isChangeLogPartial(read);
    if (partial) failed.push('changeLogPartial');
    history = changesForTransaction(read.entries, { txKeys, activityIds: [activityId] });
  } catch {
    failed.push('changeLog');
  }

  let overrides: TxOverrideFlag[] = [];
  try {
    const loaded = await loadSyncOverrides(readers.secret);
    if (loaded.unreadable) failed.push('overridesUnreadable');
    else overrides = TX_OVERRIDE_FLAGS.filter((flag) => txKeys.some((key) => hasTxOverride(loaded.overrides, key, flag)));
  } catch {
    failed.push('overrides');
  }

  let skipped = false;
  try {
    const parsed = parseSkippedTransactionsStrict(await readers.secret(SKIPPED_TRANSACTIONS_SECRET_KEY));
    if (parsed.kind === 'corrupt') failed.push('skipList');
    else if (parsed.kind === 'ok') skipped = !!txId && parsed.list.some((s) => !!sfinIds?.includes(s.account) && s.txId === txId);
  } catch {
    failed.push('skipList');
  }

  const row: TxStoryRow = {
    activityId,
    note,
    absCents: absCentsOf(item.amount),
    date: String(item.date ?? '').slice(0, 10),
    activityType: String(item.activityType ?? '').toUpperCase(),
    accountName: item.accountName ?? '',
    ...(details?.accountType ? { accountType: details.accountType } : {}),
  };

  // Its category: the spending one when it has one, else whatever it has.
  let category: TxStoryFacts['category'];
  if (details) {
    const a = details.assignments.find((x) => x.taxonomyId === SPENDING_TAXONOMY_ID) ?? details.assignments[0];
    if (!a) category = null;
    else {
      let rules: CategoryRuleLike[] | null = null;
      if (a.source.toLowerCase() === 'rule') {
        try {
          rules = await readers.rules();
        } catch {
          failed.push('rules');
        }
      }
      const filer = resolveFiler({
        source: a.source,
        categoryId: a.categoryId,
        categoryName: a.categoryName,
        row: { note, activityType: row.activityType, accountId: item.accountId, absCents: row.absCents },
        history: partial ? null : history,
        rules,
      });
      category = { name: a.categoryName || 'a category', filer };
    }
  }

  const facts: TxStoryFacts = {
    row,
    ...(sfinIds === undefined ? {} : { feed: sfinIds.length ? { sfinAccountId: feedOf(sfinIds, txId, history)! } : null }),
    partner,
    category,
    overrides,
    skipped,
    ...(history ? { history } : {}),
    failed,
    now,
  };
  return { kind: 'ok', story: buildTxStory(facts), facts, ...(activityId !== requestedId ? { movedTo: activityId } : {}) };
}

export type SearchOutcome =
  | { kind: 'ok'; result: TxSearchResult; recentOnly: boolean }
  | { kind: 'unreachable' };

const isoDaysBefore = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/** `/why <words>`: all of history from the database; the last 12 months over
 *  REST when the database cannot be read. Never rejects. */
export async function companionTxSearch(readers: StoryReaders, query: TxQuery, now: Date): Promise<SearchOutcome> {
  let rows: TxSearchRow[];
  let recentOnly = false;
  let cut = false;
  try {
    rows = readers.searchRows().map((r) => ({
      activityId: r.activityId,
      date: r.date,
      description: txDescription(r.notes),
      amountCents: signedCents({ absCents: r.absCents, activityType: r.activityType, accountType: r.accountType }),
      accountName: r.accountName,
    }));
  } catch {
    try {
      recentOnly = true;
      const recent = await readers.recentRows(isoDaysBefore(now, TX_SEARCH_RECENT_DAYS));
      cut = recent.truncated;
      rows = recent.rows.map((a) => {
        return {
          activityId: a.id,
          date: String(a.date ?? '').slice(0, 10),
          description: txDescription(a.comment),
          amountCents: signedCents({ absCents: absCentsOf(a.amount), activityType: String(a.activityType ?? '').toUpperCase(), accountType: a.accountType }),
          accountName: a.accountName ?? '',
        };
      });
    } catch {
      return { kind: 'unreachable' };
    }
  }
  const result = findTransactions(rows, query);
  return { kind: 'ok', result: cut ? { ...result, truncated: true } : result, recentOnly };
}
