/**
 * companion/src/sqlite-native.ts
 *
 * Reads Wealthfolio's native SQLite database (wealthfolio.db) directly
 * for 100% exact, native category budget allocations and spent totals.
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';

export interface NativeCategorySpending {
  categoryName: string;
  spent: number;
}

/**
 * Returns native category spent totals for an arbitrary date window —
 * `[startInclusive, endExclusive)`, both `YYYY-MM-DD` — matching the format
 * `activities.activity_date` is stored in.
 *
 * This is the single implementation of the spending query; the month-scoped
 * reader below computes its own bounds and delegates here, so the type filter,
 * the transfers exclusion, the parent-category rollup and the
 * node:sqlite-then-sqlite3-CLI fallback exist in exactly one place.
 */
export function getNativeWealthfolioSpendingBetween(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): Record<string, number> {
  if (!dbPath || !existsSync(dbPath)) {
    return {};
  }

  // The bounds are interpolated into SQL rather than bound as parameters (the
  // sqlite3-CLI fallback path has no parameter binding), so they are validated
  // rather than trusted. Every caller builds them from date arithmetic, so a
  // failure here means a bug, not user input — refusing to run is the safe
  // response either way.
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(startInclusive) || !isDate(endExclusive)) {
    console.error(`[simplefin-sync] Refusing spending query with malformed date bounds: ${startInclusive}..${endExclusive}`);
    return {};
  }

  const query = `
    SELECT
      COALESCE(parent.name, tc.name) as parent_category,
      ROUND(SUM(ABS(CAST(a.amount AS REAL))), 2) as total_spent
    FROM activities a
    JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    JOIN taxonomy_categories tc ON ata.category_id = tc.id
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
    WHERE a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
      AND UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'TAX')
      AND LOWER(COALESCE(parent.name, tc.name)) NOT IN ('transfers', 'transfer', 'internal transfers', 'savings & transfers')
    GROUP BY COALESCE(parent.name, tc.name);
  `;

  const result: Record<string, number> = {};

  try {
    const uri = dbPath.startsWith('file:') ? dbPath : `file:${dbPath}?immutable=1`;
    const db = new DatabaseSync(uri);
    const rows = db.prepare(query).all() as Array<{ parent_category: string; total_spent: number }>;
    for (const r of rows) {
      if (r.parent_category) {
        result[r.parent_category] = typeof r.total_spent === 'number' ? r.total_spent : parseFloat(String(r.total_spent || 0));
      }
    }
    db.close();
    return result;
  } catch (err) {
    console.error('[simplefin-sync] node:sqlite spending error:', err);
  }

  try {
    const cmd = `sqlite3 "${dbPath}" "${query.replace(/\n/g, ' ')}"`;
    const output = execSync(cmd, { encoding: 'utf8' });

    for (const line of output.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length === 2) {
        const catName = parts[0].trim();
        const spent = parseFloat(parts[1]) || 0;
        if (catName) {
          result[catName] = spent;
        }
      }
    }
    return result;
  } catch (err) {
    console.error('[simplefin-sync] Failed to read native sqlite database:', err);
    return {};
  }
}

/**
 * Returns native category spent totals directly from wealthfolio.db for a given month (e.g. '2026-07').
 */
export function getNativeWealthfolioSpending(dbPath: string, yearMonth: string): Record<string, number> {
  const [y, m] = yearMonth.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return getNativeWealthfolioSpendingBetween(dbPath, `${yearMonth}-01`, `${nextMonth}-01`);
}

/**
 * Returns native category budget targets from wealthfolio.db for a given month or default.
 */
export function getNativeWealthfolioBudgets(dbPath: string, yearMonth: string): Record<string, number> {
  if (!dbPath || !existsSync(dbPath)) return {};

  const query = `
    WITH ranked_budgets AS (
      SELECT 
        category_id,
        CAST(amount AS REAL) as amount,
        ROW_NUMBER() OVER (
          PARTITION BY category_id 
          ORDER BY (period_key = '${yearMonth}') DESC, updated_at DESC
        ) as rn
      FROM budget_targets
      WHERE period_key = '${yearMonth}' OR period_key = 'default'
    )
    SELECT 
      COALESCE(parent.name, tc.name) as parent_category,
      ROUND(SUM(rb.amount), 2) as total_budget
    FROM ranked_budgets rb
    JOIN taxonomy_categories tc ON rb.category_id = tc.id
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
    WHERE rb.rn = 1
    GROUP BY COALESCE(parent.name, tc.name);
  `;

  const result: Record<string, number> = {};

  try {
    const uri = dbPath.startsWith('file:') ? dbPath : `file:${dbPath}?immutable=1`;
    const db = new DatabaseSync(uri);
    const rows = db.prepare(query).all() as Array<{ parent_category: string; total_budget: number }>;
    for (const r of rows) {
      if (r.parent_category) {
        result[r.parent_category] = typeof r.total_budget === 'number' ? r.total_budget : parseFloat(String(r.total_budget || 0));
      }
    }
    db.close();
    return result;
  } catch (err) {
    console.error('[simplefin-sync] node:sqlite budget error:', err);
  }

  try {
    const cmd = `sqlite3 "${dbPath}" "${query.replace(/\n/g, ' ')}"`;
    const output = execSync(cmd, { encoding: 'utf8' });

    for (const line of output.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length === 2) {
        const catName = parts[0].trim();
        const budget = parseFloat(parts[1]) || 0;
        if (catName) {
          result[catName] = budget;
        }
      }
    }
    return result;
  } catch (err) {
    console.error('[simplefin-sync] Failed to read native sqlite budget targets:', err);
    return {};
  }
}
