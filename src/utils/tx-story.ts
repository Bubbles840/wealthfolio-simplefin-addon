/**
 * src/utils/tx-story.ts
 *
 * The add-on's half of "Why is this here?": what the add-on SDK can see about
 * one transaction, gathered into shared/tx-story.ts's facts, and the search
 * behind Home's "Why is this here?" box.
 *
 * It sees less than the companion: the SDK has no categories and no link
 * groups. So who filed a row is told only when something the add-on CAN read
 * knows it — a budget drill-down row's `f` (the caller passes it), the report
 * cube's drill-down, the companion's needs-a-category list — and otherwise the
 * story points at Telegram (when a companion has published a version) or says
 * the category was set in Wealthfolio. The other half of a transfer comes from
 * the change log's link entry, else the add-on's own `linked_groups`.
 *
 * Search: Wealthfolio's keyword is one `LIKE '%…%'` over the note (upstream
 * activities repository, `search_activities_with_utc_bounds`), never the
 * account name. A word no account name contains goes to Wealthfolio across all
 * history; with none (an amount alone, or words that may be an account's), the
 * last 12 months are read and filtered here. Either way every word and the
 * amount are matched here (`matchesTxQuery`).
 *
 * Every store read is optional-called and wrapped: a failure leaves that part
 * of the story out with a note. Only the row failing is a full failure.
 */
import type { ActivityDetails, ActivitySearchFilters, AddonContext } from '@wealthfolio/addon-sdk';
import type { ChangeLogItem } from '../../shared/change-log';
import { changesForTransaction, currentActivityId, isChangeLogPartial } from '../../shared/change-view';
import { txIdFromComment, isTransferType } from '../../shared/sync-core';
import { hasTxOverride, TX_OVERRIDE_FLAGS, type TxOverrideFlag } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import {
  findTransactions, isEmptyTxQuery, matchesTxQuery, txDescription, txSearchKeyword, TX_SEARCH_MAX_RESULTS,
  TX_SEARCH_RECENT_DAYS, type TxQuery, type TxSearchResult, type TxSearchRow,
} from '../../shared/tx-search';
import {
  buildTxStory, decodeFiler, feedOf, sfinIdsFor, signedCents, withFilingDay, type TxFactName, type TxStory, type TxStoryFacts,
} from '../../shared/tx-story';
import type { SecretsStore } from './secrets';

/** What a story is opened for. A budget drill-down row also brings its
 *  (rolled-up) category and its `f` code. */
export interface AppStoryTarget {
  activityId: string;
  categoryName?: string;
  filer?: string;
}

/** The store reads a story makes, every one optional. */
export type StoryStore = Partial<Pick<SecretsStore,
  'getAccountMapping' | 'getChangeLog' | 'readSyncOverrides' | 'readSkippedTransactions' | 'getLinkedGroups'
  | 'getCompanionVersion' | 'getUncategorizedStatus' | 'getReportCube'>>;

export type AppStoryOutcome =
  /** `entries`: the whole change log as read (Undo needs it); [] when unread. */
  | { kind: 'ok'; story: TxStory; entries: ChangeLogItem[] }
  | { kind: 'gone' }
  | { kind: 'unreachable' };

export type AppSearchOutcome = { kind: 'ok'; result: TxSearchResult } | { kind: 'unreachable' };

const isoDay = (v: unknown) => {
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v ?? '').slice(0, 10) : d.toISOString().slice(0, 10);
};
const absCentsOf = (amount: unknown) => Math.round(Math.abs(Number(amount ?? 0)) * 100) || 0;

/** One row by id. `activityIds` reaches Wealthfolio 3.8's exact-id filter (its
 *  activities adapter passes it through); the SDK's filter type does not list
 *  it, and an older host would ignore it — hence the id check. */
async function readRow(ctx: AddonContext, activityId: string): Promise<ActivityDetails | null> {
  const filters = { activityIds: [activityId] } as ActivitySearchFilters;
  const res = await ctx.api.activities.search(0, 1, filters, '');
  return (res.data ?? []).find((a) => a.id === activityId) ?? null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function appTxStory(ctx: AddonContext, store: StoryStore, target: AppStoryTarget, now: Date): Promise<AppStoryOutcome> {
  let item: ActivityDetails | null;
  // A row that no longer exists is followed forward through the change log
  // once (a transfer link re-created it); the read is kept for the history.
  let logRead: Awaited<ReturnType<NonNullable<StoryStore['getChangeLog']>>> | null | undefined;
  try {
    item = await readRow(ctx, target.activityId);
    if (!item && store.getChangeLog) {
      logRead = await store.getChangeLog().catch(() => null);
      const moved = logRead ? currentActivityId(logRead.entries, target.activityId) : target.activityId;
      if (moved !== target.activityId) item = await readRow(ctx, moved);
    }
  } catch {
    return { kind: 'unreachable' };
  }
  if (!item) return { kind: 'gone' };
  const row = item;
  const failed: TxFactName[] = [];
  const note = row.comment ?? '';
  const txId = txIdFromComment(note);

  let accounts: Awaited<ReturnType<AddonContext['api']['accounts']['getAll']>> = [];
  try {
    accounts = await ctx.api.accounts.getAll();
  } catch {
    // Without accounts the sign and where it came from are unreliable.
    failed.push('mapping');
  }
  const accountType = accounts.find((a) => a.id === row.accountId)?.accountType;

  let mapping: Record<string, string> | null = null;
  try {
    mapping = store.getAccountMapping ? ((await store.getAccountMapping()) ?? {}) : null;
  } catch {
    failed.push('mapping');
  }
  // Every SimpleFin account this row's account syncs from (two feeds can
  // share one); the row's keys are its tx id under each.
  const sfinIds = mapping ? sfinIdsFor(mapping, row.accountId) : undefined;
  const txKeys = txId ? (sfinIds ?? []).map((id) => accountTxKey(id, txId)) : [];

  let entries: ChangeLogItem[] = [];
  let history: ChangeLogItem[] | undefined;
  if (store.getChangeLog) {
    const read = logRead ?? await store.getChangeLog().catch(() => null);
    if (read) {
      // An unreadable bucket or a gap: keep what was read, and say the list may be short.
      if (isChangeLogPartial(read)) failed.push('changeLogPartial');
      entries = read.entries;
      history = changesForTransaction(entries, { txKeys, activityIds: [row.id] });
    } else failed.push('changeLog');
  }

  let overrides: TxOverrideFlag[] = [];
  if (store.readSyncOverrides) {
    const loaded = await store.readSyncOverrides().catch(() => null);
    if (!loaded) failed.push('overrides');
    else if (loaded.unreadable) failed.push('overridesUnreadable');
    else overrides = TX_OVERRIDE_FLAGS.filter((flag) => txKeys.some((key) => hasTxOverride(loaded.overrides, key, flag)));
  }

  let skipped = false;
  try {
    const parsed = await store.readSkippedTransactions?.();
    if (parsed?.kind === 'corrupt') failed.push('skipList');
    else if (parsed?.kind === 'ok') skipped = !!txId && parsed.list.some((s) => !!sfinIds?.includes(s.account) && s.txId === txId);
  } catch {
    failed.push('skipList');
  }

  // The other half of a transfer: the newest link in the log that is not
  // undone, else the add-on's own ledger of pairs it linked.
  let partner: TxStoryFacts['partner'] = null;
  const link = [...(history ?? [])].reverse().find((e) => e.kind === 'transfer-link' && !e.reverses && !e.undone);
  const legs = link && isRecord(link.after) && Array.isArray(link.after.legs) ? link.after.legs.filter(isRecord) : [];
  const other = legs.find((l) => (txKeys.length ? !txKeys.includes(l.txKey as string) : l.activityId !== row.id));
  if (other && typeof other.accountName === 'string') {
    partner = { accountName: other.accountName };
  } else if (txKeys.length) {
    let groups: Record<string, string> | null = null;
    try {
      groups = (await store.getLinkedGroups?.()) ?? null;
    } catch {
      failed.push('partner');
    }
    const gid = txKeys.map((k) => groups?.[k]).find(Boolean);
    const otherKey = gid ? Object.keys(groups!).find((k) => !txKeys.includes(k) && groups![k] === gid) : undefined;
    const otherWf = otherKey && mapping ? mapping[otherKey.split('\u0000')[0]] : undefined;
    const name = otherWf ? accounts.find((a) => a.id === otherWf)?.name : undefined;
    if (name) partner = { accountName: name };
  }
  // A row that IS grouped (when the host reports it) or transfer-typed, with no
  // partner found, is not known to be ordinary money: leave that line out.
  const grouped = !!(row as { sourceGroupId?: string | null }).sourceGroupId;
  if (!partner && (grouped || isTransferType(String(row.activityType).toUpperCase()))) partner = undefined;

  // Who filed it, as far as the add-on can see.
  let category: TxStoryFacts['category'];
  let needsCategory = false;
  let filerHint: TxStoryFacts['filerHint'];
  const fromCode = (code: string | undefined) => {
    const f = decodeFiler(code);
    return f ? withFilingDay(f, history) : null;
  };
  if (target.categoryName) {
    category = { name: target.categoryName, filer: fromCode(target.filer) };
  } else {
    let cube: Awaited<ReturnType<NonNullable<StoryStore['getReportCube']>>> | null = null;
    try {
      cube = (await store.getReportCube?.()) ?? null;
    } catch {
      failed.push('category');
    }
    for (const [name, list] of Object.entries(cube?.drill ?? {})) {
      const hit = list.find((r) => r.i === row.id);
      if (hit) {
        category = { name, filer: fromCode(hit.f) };
        break;
      }
    }
    if (!category) {
      let status: Awaited<ReturnType<NonNullable<StoryStore['getUncategorizedStatus']>>> | null = null;
      try {
        status = (await store.getUncategorizedStatus?.()) ?? null;
      } catch {
        if (!failed.includes('category')) failed.push('category');
      }
      if (status?.rows.some((r) => r.activityId === row.id)) needsCategory = true;
      else if (store.getCompanionVersion) {
        try {
          filerHint = (await store.getCompanionVersion()) ? 'telegram' : 'wealthfolio';
        } catch {
          // Unknown whether a companion exists: say neither.
        }
      } else filerHint = 'wealthfolio';
    }
  }

  const facts: TxStoryFacts = {
    row: {
      activityId: row.id,
      note,
      absCents: absCentsOf(row.amount),
      date: isoDay(row.date),
      activityType: String(row.activityType).toUpperCase(),
      accountName: row.accountName ?? '',
      ...(accountType ? { accountType: String(accountType) } : {}),
    },
    ...(sfinIds === undefined ? {} : { feed: sfinIds.length ? { sfinAccountId: feedOf(sfinIds, txId, history)! } : null }),
    partner,
    ...(category ? { category } : {}),
    needsCategory,
    ...(filerHint ? { filerHint } : {}),
    overrides,
    skipped,
    ...(history ? { history } : {}),
    now,
    failed,
  };
  return { kind: 'ok', story: buildTxStory(facts), entries };
}

const PAGE_SIZE = 500;
const KEYWORD_MAX_PAGES = 10;
const RECENT_MAX_PAGES = 20;

export async function appTxSearch(ctx: AddonContext, query: TxQuery, now: Date): Promise<AppSearchOutcome> {
  if (isEmptyTxQuery(query)) return { kind: 'ok', result: { rows: [], truncated: false } };
  try {
    const accounts = await ctx.api.accounts.getAll();
    const typeOf = new Map(accounts.map((a) => [a.id, String(a.accountType ?? '')]));
    const keyword = txSearchKeyword(query, accounts.map((a) => a.name ?? ''));
    const cutoff = new Date(now.getTime() - TX_SEARCH_RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
    const hits: TxSearchRow[] = [];
    let endedOnLimit = true;
    for (let page = 0; page < (keyword ? KEYWORD_MAX_PAGES : RECENT_MAX_PAGES); page++) {
      const data = (await ctx.api.activities.search(page, PAGE_SIZE, {}, keyword ?? '', { id: 'date', desc: true })).data ?? [];
      let pastCutoff = false;
      for (const a of data) {
        const date = isoDay(a.date);
        if (!keyword && date < cutoff) {
          pastCutoff = true;
          continue;
        }
        const r: TxSearchRow = {
          activityId: a.id,
          date,
          description: txDescription(a.comment),
          amountCents: signedCents({ absCents: absCentsOf(a.amount), activityType: String(a.activityType), accountType: typeOf.get(a.accountId) }),
          accountName: a.accountName ?? '',
        };
        if (matchesTxQuery(r, query)) hits.push(r);
      }
      // One past the cap is enough to say there were too many.
      if (hits.length > TX_SEARCH_MAX_RESULTS || pastCutoff || data.length < PAGE_SIZE) {
        endedOnLimit = false;
        break;
      }
    }
    const result = findTransactions(hits, query);
    // Out of pages while pages were still full: there may be more.
    return { kind: 'ok', result: endedOnLimit ? { ...result, truncated: true } : result };
  } catch {
    return { kind: 'unreachable' };
  }
}
