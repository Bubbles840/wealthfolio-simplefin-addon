/**
 * companion/src/opening-balance-category.ts
 *
 * Files a credit card's opening DEBT under a spending category that Wealthfolio
 * excludes from spending, so its Spending page stops counting it as a purchase.
 *
 * Why this is needed at all. Wealthfolio 3.8 accepts only WITHDRAWAL, FEE,
 * INTEREST, TRANSFER_IN and CREDIT on a card, and all three money-out types are
 * spending to its classifier. A card that opened owing $464.60 therefore needs
 * a $464.60 WITHDRAWAL, and that row read as a $464.60 purchase on the card's
 * first day (see `neutralAdjustmentFields`). Wealthfolio's own escape hatch is a
 * category listed in `spending.excluded_category_ids`: such rows leave every
 * spending surface. This project's readers already skip the row by its note
 * marker, so this only changes Wealthfolio's own pages.
 *
 * Deliberately narrow. Only the sync's own card opening balances qualify
 * (recognised by the marker), and only while they have NO spending category:
 * a row the user filed somewhere themselves is theirs. With nothing to file,
 * nothing is created — no category appears on an install that never needs one.
 *
 * Runs in the companion only: creating a category and changing the spending
 * settings need REST routes the addon SDK does not expose.
 */
import { databaseFileExists, openLiveDatabase } from './live-db.js';
import { bookkeepingChange, openingBalanceFiledChange, type ChangeDraft } from '../../shared/change-entries.js';
import { isNewerVersion } from '../../shared/version.js';
import { OPENING_BALANCES_CATEGORY, STARTING_BALANCE_COMMENT_PREFIX } from '../../shared/sync-core.js';

export { OPENING_BALANCES_CATEGORY };
const TAXONOMY = 'spending_categories';

export interface OpeningBalanceFilingDeps {
  dbPath: string;
  /** Creates the category and resolves its id. */
  createCategory: (name: string) => Promise<string>;
  /** Replaces `spending.excluded_category_ids` with this list. */
  setExcluded: (categoryIds: string[]) => Promise<void>;
  assign: (activityId: string, categoryId: string) => Promise<void>;
  log: (message: string) => void;
  /** The change log: one draft per write that succeeded. */
  record?: (draft: ChangeDraft) => void;
  /** True for a SimpleFin account whose opening-balance filing the person
   *  undid (`noOpeningFile`, shared/sync-overrides.ts): never filed again. */
  noOpeningFile?: (sfinAccountId: string) => boolean;
  /** The host's version. `PUT /spending/settings {excludedCategoryIds}` exists
   *  only from Wealthfolio 3.9.0 (3.8 silently ignores it), so the exclusion
   *  is applied only when this resolves to 3.9.0 or newer; null or absent
   *  means unknown and skips it. */
  appVersion?: () => Promise<string | null>;
  /** Wealthfolio's own exclusions (`GET /spending/settings`, 3.9+), read
   *  immediately before each PUT, which replaces the list whole. When absent
   *  the database's copy is used. */
  readExcluded?: () => Promise<string[]>;
}

const EXCLUSION_MIN_VERSION = '3.9.0';
/** Whether the host takes `spending.excluded_category_ids` (3.9.0+). Shared
 *  with the bookkeeping filing (bookkeeping-category.ts). */
export const supportsExclusion = (v: string | null | undefined): boolean =>
  !!v && (v === EXCLUSION_MIN_VERSION || isNewerVersion(v, EXCLUSION_MIN_VERSION));

interface OpeningDebtRow { id: string; account_id: string; account_name: string; amount: string; day: string; notes: string }

export async function fileCardOpeningDebts(deps: OpeningBalanceFilingDeps): Promise<{ filed: number }> {
  if (!databaseFileExists(deps.dbPath)) return { filed: 0 };
  // A writer never decides from a snapshot (live-db.ts): the exclusions it
  // writes back whole could drop another writer's.
  const db = openLiveDatabase(deps.dbPath);
  if (!db) {
    deps.log('Opening balance filing waits: the database can only be read as a snapshot');
    return { filed: 0 };
  }
  let rows: OpeningDebtRow[];
  let categoryId: string | undefined;
  let excluded: string[] = [];
  try {
    rows = db
      .prepare(
        `SELECT a.id, COALESCE(a.account_id,'') account_id, COALESCE(acc.name,'') account_name, COALESCE(a.amount,'0') amount,
                substr(COALESCE(a.activity_date,''),1,10) day, COALESCE(a.notes,'') notes
         FROM activities a JOIN accounts acc ON a.account_id = acc.id
         WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
           AND UPPER(a.activity_type) = 'WITHDRAWAL'
           AND COALESCE(a.notes,'') LIKE 'Starting balance · %'
           AND NOT EXISTS (
             SELECT 1 FROM activity_taxonomy_assignments ata
             JOIN taxonomy_categories tc ON ata.category_id = tc.id
             WHERE ata.activity_id = a.id AND tc.taxonomy_id = ?)`,
      )
      .all(TAXONOMY) as unknown as OpeningDebtRow[];
    // The note names the SimpleFin account: `Starting balance · <sfinId>`.
    rows = rows.filter((r) => !(r.notes.startsWith(STARTING_BALANCE_COMMENT_PREFIX)
      && deps.noOpeningFile?.(r.notes.slice(STARTING_BALANCE_COMMENT_PREFIX.length))));
    categoryId = (
      db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND name = ?`).get(TAXONOMY, OPENING_BALANCES_CATEGORY) as
        | { id: string }
        | undefined
    )?.id;
    try {
      const raw = (
        db.prepare(`SELECT setting_value v FROM app_settings WHERE setting_key = 'spending.excluded_category_ids'`).get() as
          | { v: string }
          | undefined
      )?.v;
      const parsed: unknown = JSON.parse(raw ?? '[]');
      excluded = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      excluded = [];
    }
  } finally {
    db.close();
  }

  // A failed recording never costs the filing.
  const record = (make: () => ChangeDraft) => {
    if (!deps.record) return;
    try { deps.record(make()); } catch (err) { deps.log(`Could not record the change: ${String(err)}`); }
  };
  const liveExcluded = async () => (deps.readExcluded ? deps.readExcluded() : excluded);
  const hostExcludes = async () => supportsExclusion(await deps.appVersion?.().catch(() => null));

  if (rows.length === 0) {
    // Nothing to file, but a category an earlier sync made on Wealthfolio 3.8
    // (which ignored the exclusion) may still be counted as spending.
    if (categoryId && !excluded.includes(categoryId) && (await hostExcludes())) {
      await deps.setExcluded([...(await liveExcluded()), categoryId]);
      deps.log(`Excluded "${OPENING_BALANCES_CATEGORY}" from spending, so an opening debt is not read as a purchase.`);
      record(() => bookkeepingChange({ step: 'opening-category', activityIds: [], categoryName: OPENING_BALANCES_CATEGORY }));
    }
    return { filed: 0 };
  }

  let setUp = false;
  if (!categoryId) {
    categoryId = await deps.createCategory(OPENING_BALANCES_CATEGORY);
    deps.log(`Created the "${OPENING_BALANCES_CATEGORY}" spending category for card opening balances.`);
    setUp = true;
  }
  if (!excluded.includes(categoryId) && (await hostExcludes())) {
    // Appended to the user's own list, never replacing it.
    await deps.setExcluded([...(await liveExcluded()), categoryId]);
    deps.log(`Excluded "${OPENING_BALANCES_CATEGORY}" from spending, so an opening debt is not read as a purchase.`);
    setUp = true;
  }
  if (setUp) record(() => bookkeepingChange({ step: 'opening-category', activityIds: [], categoryName: OPENING_BALANCES_CATEGORY }));
  for (const row of rows) {
    await deps.assign(row.id, categoryId);
    record(() => openingBalanceFiledChange({
      account: {
        // Always the SimpleFin id: R2 keys its don't-auto-file override per account.
        ...(row.notes.startsWith(STARTING_BALANCE_COMMENT_PREFIX) ? { sfinId: row.notes.slice(STARTING_BALANCE_COMMENT_PREFIX.length) } : {}),
        wfId: row.account_id,
        name: row.account_name,
      },
      activityId: row.id,
      // A card's opening DEBT: money owed, so negative.
      amountCents: -Math.round(Math.abs(Number(row.amount) || 0) * 100),
      date: row.day,
      category: { categoryId: categoryId!, categoryName: OPENING_BALANCES_CATEGORY, taxonomyId: TAXONOMY },
    }));
  }
  deps.log(`Filed ${rows.length} card opening balance(s) under "${OPENING_BALANCES_CATEGORY}".`);
  return { filed: rows.length };
}
