/**
 * companion/src/sqlite-native.ts
 *
 * Reads Wealthfolio's native SQLite database (wealthfolio.db) directly
 * for 100% exact, native category budget allocations and spent totals.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

export interface NativeCategorySpending {
  categoryName: string;
  spent: number;
}

/**
 * Returns native category spent totals directly from wealthfolio.db for a given month (e.g. '2026-07').
 */
export function getNativeWealthfolioSpending(dbPath: string, yearMonth: string): Record<string, number> {
  if (!dbPath || !existsSync(dbPath)) {
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
    WHERE a.activity_date >= '${yearMonth}-01' 
      AND UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'TAX')
    GROUP BY COALESCE(parent.name, tc.name);
  `;

  try {
    const cmd = `sqlite3 "${dbPath}" "${query.replace(/\n/g, ' ')}"`;
    const output = execSync(cmd, { encoding: 'utf8' });
    const result: Record<string, number> = {};

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
 * Returns native category budget targets from wealthfolio.db for a given month or default.
 */
export function getNativeWealthfolioBudgets(dbPath: string, yearMonth: string): Record<string, number> {
  if (!dbPath || !existsSync(dbPath)) {
    return {};
  }

  const query = `
    SELECT 
      COALESCE(parent.name, tc.name) as parent_category,
      ROUND(SUM(CAST(bt.amount AS REAL)), 2) as total_budget
    FROM budget_targets bt
    JOIN taxonomy_categories tc ON bt.target_id = tc.id
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
    WHERE bt.period_key = '${yearMonth}' OR bt.period_key = 'default'
    GROUP BY COALESCE(parent.name, tc.name);
  `;

  try {
    const cmd = `sqlite3 "${dbPath}" "${query.replace(/\n/g, ' ')}"`;
    const output = execSync(cmd, { encoding: 'utf8' });
    const result: Record<string, number> = {};

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
