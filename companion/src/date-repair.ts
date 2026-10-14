/**
 * companion/src/date-repair.ts
 *
 * Runs the one-time repair of 1.62 (shared/date-repair.ts) after a sync:
 * reads every mapped account's rows over REST (the search returns the group,
 * which the add-on's SDK cannot), learns from the read-only database which
 * rows carry a type override, writes the date-only updates in paced batches,
 * records one bookkeeping entry in the change log, and marks the repair done
 * only when every row moved — so a run that stops part-way is picked up by
 * the next sync.
 *
 * Every dependency is injected: index.ts binds the real ones, the tests fake
 * each in its real shape.
 */
import { bookkeepingChange, type ChangeDraft } from '../../shared/change-entries.js';
import {
  batches, DATE_REPAIR_PAUSE_MS, DATE_REPAIR_SECRET_KEY, parseDateRepairMarker, planDateRepair, type DateRepairRow,
} from '../../shared/date-repair.js';
import type { ActivityWrite } from '../../shared/sync-host.js';

/** Page size for the account sweep, and the most pages read per account. */
const PAGE_SIZE = 500;
const MAX_PAGES = 40;

export interface DateRepairDeps {
  /** One add-on secret; rejects when Wealthfolio cannot be reached. */
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  /** The Wealthfolio account ids `account_mapping` maps to. */
  mappedAccountIds(): Promise<string[]>;
  /** One page (0-indexed) of an account's rows, as Wealthfolio's search returns them. */
  searchPage(accountId: string, page: number, pageSize: number): Promise<DateRepairRow[]>;
  /** Ids of rows with a non-blank type override. Throws when the database cannot be read. */
  overriddenIds(): Set<string>;
  /** One bulk update; resolves the refusals (Wealthfolio's bulk write is all or nothing). */
  saveUpdates(writes: ActivityWrite[]): Promise<{ errors: Array<{ action: string; message: string }> }>;
  record(draft: ChangeDraft): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export interface DateRepairResult {
  /** False when it had already run, or could not run this time. */
  ran: boolean;
  moved: number;
  failed: number;
  skippedGrouped: number;
  skippedOverride: number;
}

const NOT_RUN: DateRepairResult = { ran: false, moved: 0, failed: 0, skippedGrouped: 0, skippedOverride: 0 };

export async function runDateRepair(deps: DateRepairDeps, now: Date): Promise<DateRepairResult> {
  let marker: string | null;
  try {
    marker = await deps.getSecret(DATE_REPAIR_SECRET_KEY);
  } catch {
    return NOT_RUN; // Unreachable: try again after the next sync.
  }
  if (parseDateRepairMarker(marker)) return NOT_RUN;
  const mapped = new Set((await deps.mappedAccountIds()).filter((id) => !!id));
  if (mapped.size === 0) return NOT_RUN;
  let overriddenIds: Set<string>;
  try {
    overriddenIds = deps.overriddenIds();
  } catch (err) {
    deps.log(`Date repair waits: couldn't read the Wealthfolio database (${err instanceof Error ? err.message : String(err)}).`);
    return NOT_RUN;
  }
  const rows: DateRepairRow[] = [];
  for (const accountId of mapped) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const items = await deps.searchPage(accountId, page, PAGE_SIZE);
      rows.push(...items);
      if (items.length < PAGE_SIZE) break;
    }
  }
  const plan = planDateRepair(rows, { mappedAccountIds: mapped, overriddenIds });
  const moved: string[] = [];
  let failed = 0;
  const groups = batches(plan.moves);
  for (const [i, group] of groups.entries()) {
    if (i > 0) await deps.sleep(DATE_REPAIR_PAUSE_MS);
    const bulk = await deps.saveUpdates(group.map((m) => m.write)).catch((e) => ({ errors: [{ action: 'save', message: String(e) }] }));
    if (bulk.errors.length === 0) {
      moved.push(...group.map((m) => m.row.id));
      continue;
    }
    // All or nothing: one refused row sends the batch back, so each goes alone.
    for (const m of group) {
      const one = await deps.saveUpdates([m.write]).catch((e) => ({ errors: [{ action: 'save', message: String(e) }] }));
      if (one.errors.length === 0) moved.push(m.row.id);
      else {
        failed += 1;
        deps.log(`Date repair: couldn't move ${m.row.id} (${one.errors.map((e) => e.message).join('; ')}).`);
      }
    }
  }
  const skipped = plan.skippedGrouped + plan.skippedOverride;
  if (moved.length > 0) {
    await deps.record(bookkeepingChange({ step: 'date-repair', activityIds: moved, skipped }))
      .catch((e) => deps.log(`Change log skipped: ${String(e)}`));
  }
  if (failed === 0) {
    await deps.setSecret(DATE_REPAIR_SECRET_KEY, JSON.stringify({
      at: now.toISOString(), moved: moved.length, skippedGrouped: plan.skippedGrouped, skippedOverride: plan.skippedOverride,
    }));
  }
  deps.log(failed === 0
    ? `Date repair: moved ${moved.length} row(s) from midnight UTC to noon; left ${skipped} linked or retyped row(s) alone. Done.`
    : `Date repair: moved ${moved.length} row(s); ${failed} could not be moved — the next sync tries again.`);
  return { ran: true, moved: moved.length, failed, skippedGrouped: plan.skippedGrouped, skippedOverride: plan.skippedOverride };
}
