/**
 * companion/src/change-undo-host.ts
 *
 * The companion's half of Undo (shared/change-undo-run.ts): everything the
 * runner may touch, bound to one Wealthfolio client. The companion can do
 * every kind — it has the REST routes for categories and rules the add-on SDK
 * lacks, and the database for "which charges did this rule file".
 *
 * Its reversal entries land in the companion's own bucket, through the one
 * process-wide writer (change-log-host.ts).
 */
import type { ChangeEntry } from '../../shared/change-entries.js';
import type { UndoIo } from '../../shared/change-undo-run.js';
import { SPENDING_TAXONOMY } from '../../shared/change-undo.js';
import type { SyncHost } from '../../shared/sync-host.js';
import { SIMPLEFIN_SYNC_VERSION } from '../../shared/version.js';
import { recordCompanionChanges, type SecretClient } from './change-log-host.js';
import { RestSyncHost } from './rest-host.js';
import { getNativeRuleFiledActivityIds } from './sqlite-native.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** What Undo needs of a `WealthfolioClient`. */
export type UndoClient = SecretClient & Pick<WealthfolioClient,
  'getActivityAssignments' | 'assignActivityCategory' | 'unassignActivityCategory'
  | 'listCategorizationRules' | 'createCategorizationRule' | 'deleteCategorizationRule'
  | 'getBudgetTargets' | 'setDefaultBudgetTarget' | 'deleteBudgetTarget'>;

export function companionUndoIo(
  client: UndoClient,
  dbPath: string,
  host?: SyncHost,
  log?: (message: string) => void,
): UndoIo {
  return {
    host: host ?? new RestSyncHost(client as unknown as WealthfolioClient, dbPath, log),
    secrets: {
      get: (k) => client.getAddonSecret(ADDON_ID, k),
      set: (k, v) => client.setAddonSecret(ADDON_ID, k, v),
    },
    categories: {
      assignments: async (activityId) => (await client.getActivityAssignments(activityId))
        .map(({ taxonomyId, categoryId }) => ({ taxonomyId, categoryId })),
      assign: (activityId, taxonomyId, categoryId) => client.assignActivityCategory(activityId, taxonomyId, categoryId),
      unassign: (activityId, taxonomyId) => client.unassignActivityCategory(activityId, taxonomyId),
    },
    rules: {
      list: () => client.listCategorizationRules(),
      // The same shape and LOSING priority /categorize's rules are created
      // with (see `buildCategorizeDeps`): a redo puts back what was there.
      create: (rule) => client.createCategorizationRule({ ...rule, taxonomyId: SPENDING_TAXONOMY, priority: 50 }),
      remove: (id) => client.deleteCategorizationRule(id),
      filedBy: async (rule) => getNativeRuleFiledActivityIds(dbPath, rule.categoryId, rule.pattern),
    },
    // `budget-set` (project 4). An empty snapshot means Wealthfolio's Spending
    // tracker is off, not that the budget is gone: that is unreadable, so the
    // Undo says it couldn't reach Wealthfolio and changes nothing.
    budgets: {
      targets: async () => {
        const read = await client.getBudgetTargets();
        if (!read.enabled) throw new Error("Wealthfolio's Spending tracker is off");
        return read.targets;
      },
      // null: written, but the reply named no target (the runner then looks the category's default up).
      set: async (categoryId, amountCents) => (await client.setDefaultBudgetTarget(categoryId, amountCents))?.id ?? null,
      remove: (id) => client.deleteBudgetTarget(id),
    },
    record: (draft) => recordCompanionChanges(client, [draft]),
    where: { host: 'companion', companionVersion: SIMPLEFIN_SYNC_VERSION },
  };
}

/** N for "↩ Undo rule + un-file N": what the rule filed, read when the entry
 *  is shown. Null when that cannot be read (no database), and for any other
 *  kind. */
export function companionRuleFiledCount(dbPath: string, entry: ChangeEntry): number | null {
  if (entry.kind !== 'category-rule-created') return null;
  const after = (entry.after ?? {}) as Record<string, unknown>;
  if (typeof after.categoryId !== 'string' || typeof after.pattern !== 'string') return null;
  return getNativeRuleFiledActivityIds(dbPath, after.categoryId, after.pattern)?.length ?? null;
}
