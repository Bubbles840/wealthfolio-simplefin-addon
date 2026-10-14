/**
 * companion/src/bookkeeping-category.ts
 *
 * The post-sync pass of 1.62 (ruling W3): files the sync's spending-bucket
 * bookkeeping rows — transfers in transit, balance corrections, starting
 * balances — under "Sync bookkeeping", a spending category Wealthfolio is
 * told to leave out of spending, and takes back out any row that is no longer
 * bookkeeping. shared/bookkeeping-filing.ts decides; this reads and writes.
 *
 * The same mechanism as the card opening-debt filing
 * (opening-balance-category.ts, which runs first): the category is created
 * in the spending taxonomy when there is something to file, and appended to
 * `spending.excluded_category_ids` (`PUT /spending/settings`). That setting
 * exists only from Wealthfolio 3.9.0 (3.8 ignores it), so on 3.8 — or a host
 * whose version is unknown — the pass does nothing at all: a filing that is
 * not excluded would still count, and would only add a category.
 *
 * Only rows in the accounts Wealthfolio's Spending page reads are considered:
 * Wealthfolio refuses a category anywhere else, and counts nothing there.
 * Each write on its own: one refused filing costs that row, never the pass.
 * One change-log entry per pass (background), when anything changed.
 */
import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import {
  planBookkeepingFiling, SYNC_BOOKKEEPING_CATEGORY, SYNC_BOOKKEEPING_DESCRIPTION, type BookkeepingRow,
} from '../../shared/bookkeeping-filing.js';
import { bookkeepingChange, type ChangeDraft } from '../../shared/change-entries.js';
import { IN_TRANSIT_COMMENT_PREFIX } from '../../shared/reconcile.js';
import { BALANCE_ADJUSTMENT_COMMENT_PREFIX, STARTING_BALANCE_COMMENT_PREFIX } from '../../shared/sync-core.js';
import { SPENDING_TAXONOMY } from '../../shared/wf-spending.js';
import { supportsExclusion } from './opening-balance-category.js';
import { getNativeSpendingSettings } from './sqlite-native.js';

export { SYNC_BOOKKEEPING_CATEGORY };

export interface BookkeepingFilingDeps {
  dbPath: string;
  /** Creates the category (top level, spending taxonomy) and resolves its id. */
  createCategory: (name: string, description: string) => Promise<string>;
  /** Replaces `spending.excluded_category_ids` with this list. */
  setExcluded: (categoryIds: string[]) => Promise<void>;
  assign: (activityId: string, categoryId: string) => Promise<void>;
  unassign: (activityId: string) => Promise<void>;
  /** The host's version (`/app/info`); null when unknown. */
  appVersion: () => Promise<string | null>;
  /** True for a SimpleFin account whose opening-balance filing the person undid. */
  noOpeningFile?: (sfinAccountId: string) => boolean;
  /** The change log: one draft per pass that changed anything. */
  record?: (draft: ChangeDraft) => void;
  log: (message: string) => void;
}

function open(dbPath: string): DatabaseSync | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  for (const uri of [`file:${dbPath}?mode=ro`, `file:${dbPath}?mode=ro&readonly_shm=1`, `file:${dbPath}?immutable=1`]) {
    try {
      const db = new DatabaseSync(uri);
      db.prepare('SELECT 1').get();
      return db;
    } catch {
      /* next form */
    }
  }
  return null;
}

interface Read { rows: BookkeepingRow[]; categoryId: string | null }

/** The bookkeeping rows and the rows filed under the category, with their
 *  spending filings; null when the database cannot be read. */
function readCandidates(dbPath: string): Read | null {
  const db = open(dbPath);
  if (!db) return null;
  try {
    const categoryId = (db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND name = ?`)
      .get(SPENDING_TAXONOMY, SYNC_BOOKKEEPING_CATEGORY) as { id: string } | undefined)?.id ?? null;
    const raw = db.prepare(
      `SELECT a.id AS id, COALESCE(a.account_id, '') AS account_id, UPPER(COALESCE(acc.account_type, '')) AS account_type,
              UPPER(COALESCE(a.activity_type, '')) AS type, COALESCE(a.activity_type_override, '') AS type_override,
              UPPER(COALESCE(a.subtype, '')) AS subtype, COALESCE(a.source_group_id, '') AS grp, COALESCE(a.notes, '') AS notes
       FROM activities a LEFT JOIN accounts acc ON acc.id = a.account_id
       WHERE COALESCE(a.notes, '') LIKE ? OR COALESCE(a.notes, '') LIKE ? OR COALESCE(a.notes, '') LIKE ?
          OR a.id IN (SELECT ata.activity_id FROM activity_taxonomy_assignments ata WHERE ata.taxonomy_id = ? AND ata.category_id = ?)
       ORDER BY a.activity_date, a.id`,
    ).all(`${IN_TRANSIT_COMMENT_PREFIX}%`, `${BALANCE_ADJUSTMENT_COMMENT_PREFIX}%`, `${STARTING_BALANCE_COMMENT_PREFIX}%`, SPENDING_TAXONOMY, categoryId ?? '') as
      Array<{ id: string; account_id: string; account_type: string; type: string; type_override: string; subtype: string; grp: string; notes: string }>;
    const filings = db.prepare(`SELECT activity_id AS activity_id, category_id AS category_id FROM activity_taxonomy_assignments WHERE taxonomy_id = ?`)
      .all(SPENDING_TAXONOMY) as Array<{ activity_id: string; category_id: string }>;
    const filed = new Map<string, string[]>();
    for (const f of filings) filed.set(f.activity_id, [...(filed.get(f.activity_id) ?? []), f.category_id]);
    const scope = new Set(getNativeSpendingSettings(dbPath).spendingAccountIds);
    return {
      categoryId,
      rows: raw.filter((r) => scope.has(r.account_id)).map((r) => ({
        id: r.id, accountType: r.account_type, type: r.type, typeOverride: r.type_override, subtype: r.subtype,
        groupId: r.grp, notes: r.notes, spendingCategoryIds: filed.get(r.id) ?? [],
      })),
    };
  } catch (err) {
    console.error('[simplefin-sync] bookkeeping filing could not read the database:', err);
    return null;
  } finally {
    db.close();
  }
}

function excludedIds(dbPath: string): string[] {
  return getNativeSpendingSettings(dbPath).excludedCategoryIds;
}

export async function fileSyncBookkeeping(deps: BookkeepingFilingDeps): Promise<{ filed: number; unfiled: number }> {
  const none = { filed: 0, unfiled: 0 };
  // 3.8 has no excluded categories: a filing there would only add a category.
  if (!supportsExclusion(await deps.appVersion().catch(() => null))) return none;
  const read = readCandidates(deps.dbPath);
  if (!read) return none;
  const plan = planBookkeepingFiling(read.rows, { categoryId: read.categoryId, noOpeningFile: deps.noOpeningFile });
  if (plan.file.length === 0 && plan.unfile.length === 0) return none;
  let categoryId = read.categoryId;
  if (!categoryId) {
    categoryId = await deps.createCategory(SYNC_BOOKKEEPING_CATEGORY, SYNC_BOOKKEEPING_DESCRIPTION);
    deps.log(`Created the "${SYNC_BOOKKEEPING_CATEGORY}" spending category for the sync's bookkeeping rows.`);
  }
  const excluded = excludedIds(deps.dbPath);
  if (!excluded.includes(categoryId)) {
    // Appended to the person's own list, never replacing it.
    await deps.setExcluded([...excluded, categoryId]);
    deps.log(`Excluded "${SYNC_BOOKKEEPING_CATEGORY}" from spending.`);
  }
  const filed: string[] = [];
  for (const id of plan.file) {
    try {
      await deps.assign(id, categoryId);
      filed.push(id);
    } catch (err) {
      deps.log(`Couldn't file ${id} under "${SYNC_BOOKKEEPING_CATEGORY}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const unfiled: string[] = [];
  for (const id of plan.unfile) {
    try {
      await deps.unassign(id);
      unfiled.push(id);
    } catch (err) {
      deps.log(`Couldn't take ${id} out of "${SYNC_BOOKKEEPING_CATEGORY}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if ((filed.length > 0 || unfiled.length > 0) && deps.record) {
    try {
      deps.record(bookkeepingChange({ step: 'sync-bookkeeping', activityIds: filed, unfiledIds: unfiled, categoryName: SYNC_BOOKKEEPING_CATEGORY }));
    } catch (err) {
      deps.log(`Could not record the change: ${String(err)}`);
    }
  }
  if (filed.length > 0) deps.log(`Filed ${filed.length} bookkeeping row(s) under "${SYNC_BOOKKEEPING_CATEGORY}".`);
  if (unfiled.length > 0) deps.log(`Took ${unfiled.length} row(s) that are no longer bookkeeping out of "${SYNC_BOOKKEEPING_CATEGORY}".`);
  return { filed: filed.length, unfiled: unfiled.length };
}
