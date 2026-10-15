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
 * One change-log entry per pass (background), when anything changed, and a
 * set-up entry whenever the category was created or its exclusion (re)added.
 *
 * Careful by construction (LU-H):
 *  - it reads the database LIVE or not at all (live-db.ts) — a write decided
 *    from a snapshot could clobber what the person just did;
 *  - a row with split lines counts as filed (assigning clears the split);
 *  - it takes back out ONLY rows it filed itself — their ids are remembered in
 *    a companion-only secret (`sync_bookkeeping_filed`, with the category id);
 *    a corrupt secret stops the pass, and is never overwritten;
 *  - the exclusions are Wealthfolio's own list, read right before the PUT;
 *  - each row is re-read, by id, immediately before its write, and skipped
 *    unless it is still exactly as planned.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  planBookkeepingFiling, SYNC_BOOKKEEPING_CATEGORY, SYNC_BOOKKEEPING_DESCRIPTION, type BookkeepingRow, type FiledState,
} from '../../shared/bookkeeping-filing.js';
import { bookkeepingChange, type ChangeDraft } from '../../shared/change-entries.js';
import { IN_TRANSIT_COMMENT_PREFIX } from '../../shared/reconcile.js';
import { BALANCE_ADJUSTMENT_COMMENT_PREFIX, STARTING_BALANCE_COMMENT_PREFIX } from '../../shared/sync-core.js';
import { isNewerVersion } from '../../shared/version.js';
import { SPENDING_TAXONOMY } from '../../shared/wf-spending.js';
import { databaseFileExists, openLiveDatabase } from './live-db.js';
import { supportsExclusion } from './opening-balance-category.js';
import { getNativeSpendingSettings } from './sqlite-native.js';

export { SYNC_BOOKKEEPING_CATEGORY };

/** The add-on secret holding the rows this pass filed (companion-only writer). */
export const BOOKKEEPING_FILED_SECRET_KEY = 'sync_bookkeeping_filed';

export interface BookkeepingFilingDeps {
  dbPath: string;
  /** Creates the category (top level, spending taxonomy) and resolves its id. */
  createCategory: (name: string, description: string) => Promise<string>;
  /** Replaces `spending.excluded_category_ids` with this list. */
  setExcluded: (categoryIds: string[]) => Promise<void>;
  /** Wealthfolio's own exclusions (`GET /spending/settings`), read immediately
   *  before each PUT: the PUT replaces the list whole. */
  readExcluded: () => Promise<string[]>;
  assign: (activityId: string, categoryId: string) => Promise<void>;
  unassign: (activityId: string) => Promise<void>;
  /** The host's version (`/app/info`); null when unknown. */
  appVersion: () => Promise<string | null>;
  /** The rows this pass filed, and its category; 'corrupt' when the secret is
   *  unreadable (`parseFiledState`). */
  loadFiled: () => Promise<FiledState | 'corrupt'>;
  saveFiled: (state: FiledState) => Promise<void>;
  /** True for a SimpleFin account whose opening-balance filing the person undid. */
  noOpeningFile?: (sfinAccountId: string) => boolean;
  /** The change log: one draft per pass that changed anything. */
  record?: (draft: ChangeDraft) => void;
  log: (message: string) => void;
}

/** A row with the extra the pass needs beyond the plan: a blank type override. */
type CandidateRow = BookkeepingRow & { blankOverride: boolean };

interface Read { rows: CandidateRow[]; categoryId: string | null; present: Set<string> }

const ROW_SELECT = `SELECT a.id AS id, COALESCE(a.account_id, '') AS account_id, UPPER(COALESCE(acc.account_type, '')) AS account_type,
              UPPER(COALESCE(a.activity_type, '')) AS type, COALESCE(a.activity_type_override, '') AS type_override,
              CASE WHEN a.activity_type_override IS NOT NULL AND a.activity_type_override = '' THEN 1 ELSE 0 END AS blank_override,
              UPPER(COALESCE(a.subtype, '')) AS subtype, COALESCE(a.source_group_id, '') AS grp, COALESCE(a.notes, '') AS notes
       FROM activities a LEFT JOIN accounts acc ON acc.id = a.account_id`;

type RawRow = { id: string; account_id: string; account_type: string; type: string; type_override: string; blank_override: number; subtype: string; grp: string; notes: string };

/** Filings and split lines per row, read from the same live handle. */
function filingReaders(db: DatabaseSync) {
  const filings = db.prepare(`SELECT category_id AS category_id FROM activity_taxonomy_assignments WHERE activity_id = ? AND taxonomy_id = ?`);
  const hasSplitsTable = !!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'spending_activity_splits'`).get();
  const splits = hasSplitsTable
    ? db.prepare(`SELECT 1 AS x FROM spending_activity_splits WHERE activity_id = ? AND taxonomy_id = ? LIMIT 1`)
    : null;
  return (r: RawRow): CandidateRow => ({
    id: r.id, accountType: r.account_type, type: r.type, typeOverride: r.type_override, subtype: r.subtype,
    groupId: r.grp, notes: r.notes, blankOverride: r.blank_override === 1,
    spendingCategoryIds: (filings.all(r.id, SPENDING_TAXONOMY) as Array<{ category_id: string }>).map((f) => f.category_id),
    hasSplits: !!splits?.get(r.id, SPENDING_TAXONOMY),
  });
}

/** The category: the remembered id first (a rename keeps working, duplicates
 *  resolve to ours), else the one with the name. */
function findCategory(db: DatabaseSync, rememberedId: string | null): string | null {
  if (rememberedId) {
    const byId = db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND id = ?`).get(SPENDING_TAXONOMY, rememberedId) as { id: string } | undefined;
    if (byId) return byId.id;
  }
  return (db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND name = ? ORDER BY id`)
    .get(SPENDING_TAXONOMY, SYNC_BOOKKEEPING_CATEGORY) as { id: string } | undefined)?.id ?? null;
}

/** The bookkeeping rows, the rows filed under the category, and which
 *  remembered ids still exist, with their spending filings and splits. */
function readCandidates(db: DatabaseSync, dbPath: string, state: FiledState): Read {
  const categoryId = findCategory(db, state.categoryId);
  const raw = db.prepare(
    `${ROW_SELECT}
       WHERE COALESCE(a.notes, '') LIKE ? OR COALESCE(a.notes, '') LIKE ? OR COALESCE(a.notes, '') LIKE ?
          OR a.id IN (SELECT ata.activity_id FROM activity_taxonomy_assignments ata WHERE ata.taxonomy_id = ? AND ata.category_id = ?)
       ORDER BY a.activity_date, a.id`,
  ).all(`${IN_TRANSIT_COMMENT_PREFIX}%`, `${BALANCE_ADJUSTMENT_COMMENT_PREFIX}%`, `${STARTING_BALANCE_COMMENT_PREFIX}%`, SPENDING_TAXONOMY, categoryId ?? '') as RawRow[];
  const toRow = filingReaders(db);
  const scope = new Set(getNativeSpendingSettings(dbPath).spendingAccountIds);
  const exists = db.prepare(`SELECT 1 AS x FROM activities WHERE id = ?`);
  return {
    categoryId,
    rows: raw.filter((r) => scope.has(r.account_id)).map(toRow),
    present: new Set(state.ids.filter((id) => !!exists.get(id))),
  };
}

/** One row as it is right now, or null when it is gone. */
function readLiveRow(dbPath: string, id: string): CandidateRow | null {
  const db = openLiveDatabase(dbPath);
  if (!db) return null;
  try {
    const r = db.prepare(`${ROW_SELECT} WHERE a.id = ?`).get(id) as RawRow | undefined;
    return r ? filingReaders(db)(r) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** 3.10 treats a blank type override as none; 3.9 reads '' as a type. */
const blankOverrideIsNone = (v: string | null): boolean => !!v && (v === '3.10.0' || isNewerVersion(v, '3.10.0'));

export async function fileSyncBookkeeping(deps: BookkeepingFilingDeps): Promise<{ filed: number; unfiled: number }> {
  const none = { filed: 0, unfiled: 0 };
  const version = await deps.appVersion().catch(() => null);
  // 3.8 has no excluded categories: a filing there would only add a category.
  if (!supportsExclusion(version)) return none;
  const loaded = await deps.loadFiled().catch(() => 'corrupt' as const);
  if (loaded === 'corrupt') {
    deps.log(`Bookkeeping filing skipped: the remembered rows (${BOOKKEEPING_FILED_SECRET_KEY}) can't be read — nothing is filed or taken out until that is fixed`);
    return none;
  }
  if (!databaseFileExists(deps.dbPath)) return none;
  // A writer never decides from a snapshot (live-db.ts).
  const db = openLiveDatabase(deps.dbPath);
  if (!db) {
    deps.log('Bookkeeping filing waits: the database can only be read as a snapshot');
    return none;
  }
  let read: Read;
  try {
    read = readCandidates(db, deps.dbPath, loaded);
  } catch (err) {
    console.error('[simplefin-sync] bookkeeping filing could not read the database:', err);
    deps.log("Bookkeeping filing skipped: couldn't read the database");
    return none;
  } finally {
    db.close();
  }

  // Ids remembered for a category that is gone had their filings cascade away.
  const sameCategory = read.categoryId !== null && read.categoryId === loaded.categoryId;
  const mine = new Set(sameCategory ? loaded.ids.filter((id) => read.present.has(id)) : []);
  const stillUnder = new Set(read.rows.filter((r) => read.categoryId && r.spendingCategoryIds.includes(read.categoryId)).map((r) => r.id));
  // A row the person moved elsewhere is theirs now.
  for (const id of [...mine]) if (!stillUnder.has(id)) mine.delete(id);
  const plannedWith = (rows: readonly CandidateRow[], categoryId: string | null) =>
    planBookkeepingFiling(rows, { categoryId, filedByPass: mine, noOpeningFile: deps.noOpeningFile });
  const plan = plannedWith(read.rows, read.categoryId);
  // 3.9 reads a blank override as a type and refuses the filing, for good.
  const blank = new Set(read.rows.filter((r) => r.blankOverride).map((r) => r.id));
  const toFile = blankOverrideIsNone(version) ? plan.file : plan.file.filter((id) => !blank.has(id));

  let categoryId = read.categoryId;
  const remembered = (): FiledState => ({ categoryId, ids: [...mine].sort() });
  const unchangedMemory = () => sameCategory && loaded.ids.length === mine.size && loaded.ids.every((id) => mine.has(id));
  const save = async () => {
    try {
      await deps.saveFiled(remembered());
    } catch (err) {
      deps.log(`Couldn't remember the bookkeeping rows it filed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (toFile.length === 0 && plan.unfile.length === 0) {
    if (categoryId && !unchangedMemory()) await save();
    return none;
  }

  let setUp = false;
  const recordSetUp = () => {
    if (!setUp || !deps.record) return;
    try {
      deps.record(bookkeepingChange({ step: 'opening-category', activityIds: [], categoryName: SYNC_BOOKKEEPING_CATEGORY }));
    } catch (err) {
      deps.log(`Could not record the change: ${String(err)}`);
    }
  };
  try {
    if (!categoryId) {
      categoryId = await deps.createCategory(SYNC_BOOKKEEPING_CATEGORY, SYNC_BOOKKEEPING_DESCRIPTION);
      deps.log(`Created the "${SYNC_BOOKKEEPING_CATEGORY}" spending category for the sync's bookkeeping rows.`);
      setUp = true;
    }
    // Wealthfolio's own list, right now: the PUT replaces it whole, and the
    // opening-debt filer may just have written to it. Appended, never replaced.
    const excluded = await deps.readExcluded();
    if (!excluded.includes(categoryId)) {
      await deps.setExcluded([...excluded, categoryId]);
      deps.log(`Excluded "${SYNC_BOOKKEEPING_CATEGORY}" from spending.`);
      setUp = true;
    }
  } catch (err) {
    // Nothing is filed under a category that is not excluded; what did get made is still logged.
    recordSetUp();
    throw err;
  }
  recordSetUp();

  const cat = categoryId;
  const asPlanned = (id: string, kind: 'file' | 'unfile'): boolean => {
    const row = readLiveRow(deps.dbPath, id);
    if (!row) return false;
    if (kind === 'file' && row.blankOverride && !blankOverrideIsNone(version)) return false;
    return plannedWith([row], cat)[kind].includes(id);
  };
  const filed: string[] = [];
  for (const id of toFile) {
    if (!asPlanned(id, 'file')) continue;
    try {
      await deps.assign(id, cat);
      filed.push(id);
      mine.add(id);
    } catch (err) {
      deps.log(`Couldn't file ${id} under "${SYNC_BOOKKEEPING_CATEGORY}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const unfiled: string[] = [];
  for (const id of plan.unfile) {
    if (!asPlanned(id, 'unfile')) continue;
    try {
      await deps.unassign(id);
      unfiled.push(id);
      mine.delete(id);
    } catch (err) {
      deps.log(`Couldn't take ${id} out of "${SYNC_BOOKKEEPING_CATEGORY}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await save();
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
