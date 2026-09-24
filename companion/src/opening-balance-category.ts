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
import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

export const OPENING_BALANCES_CATEGORY = 'Opening balances';
const TAXONOMY = 'spending_categories';

export interface OpeningBalanceFilingDeps {
  dbPath: string;
  /** Creates the category and resolves its id. */
  createCategory: (name: string) => Promise<string>;
  /** Replaces `spending.excluded_category_ids` with this list. */
  setExcluded: (categoryIds: string[]) => Promise<void>;
  assign: (activityId: string, categoryId: string) => Promise<void>;
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

export async function fileCardOpeningDebts(deps: OpeningBalanceFilingDeps): Promise<{ filed: number }> {
  const db = open(deps.dbPath);
  if (!db) return { filed: 0 };
  let rows: Array<{ id: string }>;
  let categoryId: string | undefined;
  let excluded: string[] = [];
  try {
    rows = db
      .prepare(
        `SELECT a.id FROM activities a JOIN accounts acc ON a.account_id = acc.id
         WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
           AND UPPER(a.activity_type) = 'WITHDRAWAL'
           AND COALESCE(a.notes,'') LIKE 'Starting balance · %'
           AND NOT EXISTS (
             SELECT 1 FROM activity_taxonomy_assignments ata
             JOIN taxonomy_categories tc ON ata.category_id = tc.id
             WHERE ata.activity_id = a.id AND tc.taxonomy_id = ?)`,
      )
      .all(TAXONOMY) as Array<{ id: string }>;
    if (rows.length === 0) return { filed: 0 };
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

  if (!categoryId) {
    categoryId = await deps.createCategory(OPENING_BALANCES_CATEGORY);
    deps.log(`Created the "${OPENING_BALANCES_CATEGORY}" spending category for card opening balances.`);
  }
  if (!excluded.includes(categoryId)) {
    // Appended to the user's own list, never replacing it.
    await deps.setExcluded([...excluded, categoryId]);
    deps.log(`Excluded "${OPENING_BALANCES_CATEGORY}" from spending, so an opening debt is not read as a purchase.`);
  }
  for (const row of rows) await deps.assign(row.id, categoryId);
  deps.log(`Filed ${rows.length} card opening balance(s) under "${OPENING_BALANCES_CATEGORY}".`);
  return { filed: rows.length };
}
