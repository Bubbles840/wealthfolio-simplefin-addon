/**
 * companion/src/category-lookup.ts
 *
 * Finding a category the companion created, by name or by key.
 *
 * `createSpendingCategory` keys a category by its name in snake case. A
 * person may rename the category afterwards; the key stays. Wealthfolio 3.12
 * refuses a second category with a key already in the taxonomy, so a lookup
 * by name alone would try to create it again, and fail, on every sync.
 */
import type { DatabaseSync } from 'node:sqlite';

/** The key Wealthfolio stores for a category the companion creates: its name in snake case. */
export const categoryKey = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export const hasTable = (db: DatabaseSync, name: string): boolean =>
  !!db.prepare(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

const hasKeyColumn = (db: DatabaseSync): boolean =>
  !!db.prepare(`SELECT 1 AS x FROM pragma_table_info('taxonomy_categories') WHERE name = 'key'`).get();

/** The category named `name` in `taxonomyId`, else the one keyed as the companion would key it. */
export function findCategoryByNameOrKey(db: DatabaseSync, taxonomyId: string, name: string): string | undefined {
  const byName = db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND name = ? ORDER BY id`)
    .get(taxonomyId, name) as { id: string } | undefined;
  if (byName || !hasKeyColumn(db)) return byName?.id;
  return (db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND key = ? ORDER BY id`)
    .get(taxonomyId, categoryKey(name)) as { id: string } | undefined)?.id;
}
