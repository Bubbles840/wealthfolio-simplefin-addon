/**
 * companion/src/date-repair.ts
 *
 * Runs the one-time repair of 1.62 (shared/date-repair.ts) after a sync:
 * reads every mapped account's rows over REST (the search returns the group,
 * which the add-on's SDK cannot), learns from the read-only database which
 * rows carry a type override, writes the date-only updates in paced batches,
 * records one bookkeeping entry in the change log, and marks the repair done
 * only when nothing is left to move — so a run that stops part-way is picked
 * up by the next sync. Each batch is re-read by id right before it is written
 * (the sweep is minutes old: a hand edit, a link or another writer in between
 * must not be overwritten), and the run waits for the 1.62 add-on.
 *
 * Every dependency is injected: index.ts binds the real ones, the tests fake
 * each in its real shape.
 */
import { bookkeepingChange, type ChangeDraft } from '../../shared/change-entries.js';
import {
  batches, DATE_REPAIR_PAUSE_MS, DATE_REPAIR_SECRET_KEY, DATE_REPAIR_SINCE, parseDateRepairMarker, planDateRepair, type DateRepairPlan, type DateRepairRow, type DateRepairWrite,
} from '../../shared/date-repair.js';
import { isNewerVersion } from '../../shared/version.js';

/** Page size for the account sweep, and the most pages read per account. */
const PAGE_SIZE = 500;
const MAX_PAGES = 40;
/** The most ids the change-log entry lists (the entry carries the full count). */
export const DATE_REPAIR_ENTRY_IDS = 200;

export interface DateRepairDeps {
  /** One add-on secret; rejects when Wealthfolio cannot be reached. */
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  /** The installed add-on's version, or null when unknown. */
  installedAddonVersion(): string | null;
  /** The Wealthfolio account ids `account_mapping` maps to. */
  mappedAccountIds(): Promise<string[]>;
  /** One page (0-indexed) of an account's rows, as Wealthfolio's search returns them. */
  searchPage(accountId: string, page: number, pageSize: number): Promise<DateRepairRow[]>;
  /** These rows by id, as the search returns them now (a vanished id is absent). */
  searchByIds(ids: string[]): Promise<DateRepairRow[]>;
  /** Ids of rows with a non-blank type override. LIVE reads only: throws `SnapshotOnlyError` when the database can only be read as a snapshot, and another error when it cannot be read at all. */
  overriddenIds(): Set<string>;
  /** Every row's stored type by id. Live only, as `overriddenIds`. */
  storedTypes(): Map<string, string>;
  /** Wealthfolio's timezone (null when unset). Live only, as `overriddenIds`. */
  timeZone(): string | null;
  /** One bulk update; resolves the refusals (Wealthfolio's bulk write is all or nothing). */
  saveUpdates(writes: DateRepairWrite[]): Promise<{ errors: Array<{ action: string; message: string }> }>;
  record(draft: ChangeDraft): Promise<void>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export interface DateRepairResult {
  /** False when it had already run, or could not run this time. */
  ran: boolean;
  moved: number;
  /** Rows not moved: refused for good, or failed this time. */
  failed: number;
  /** Of `failed`, those that may succeed next time (5xx, network). */
  transient: number;
  /** Rows that changed or vanished between the sweep and the write. */
  changed: number;
  skippedGrouped: number;
  skippedOverride: number;
}

/** The database can only be read as a snapshot (a checkpoint behind): the repair never decides from one. */
export class SnapshotOnlyError extends Error {
  constructor() {
    super('the database can only be read as a snapshot');
    this.name = 'SnapshotOnlyError';
  }
}

const NOT_RUN: DateRepairResult = { ran: false, moved: 0, failed: 0, transient: 0, changed: 0, skippedGrouped: 0, skippedOverride: 0 };

/** A thrown write error that is the row's own fault (4xx) and will not heal. */
function isPermanent(e: unknown): boolean {
  const m = /failed: (\d{3})/.exec(e instanceof Error ? e.message : String(e));
  if (!m) return false;
  const status = Number(m[1]);
  return status >= 400 && status < 500 && ![408, 423, 429].includes(status);
}

type Move = DateRepairPlan['moves'][number];

export async function runDateRepair(
  deps: DateRepairDeps, now: Date, limits: { pageSize?: number; maxPages?: number } = {},
): Promise<DateRepairResult> {
  const pageSize = limits.pageSize ?? PAGE_SIZE;
  const maxPages = limits.maxPages ?? MAX_PAGES;
  let marker: string | null;
  try {
    marker = await deps.getSecret(DATE_REPAIR_SECRET_KEY);
  } catch {
    return NOT_RUN; // Unreachable: try again after the next sync.
  }
  if (parseDateRepairMarker(marker)) return NOT_RUN;
  // A 1.61 add-on keeps writing midnight rows after the marker (3.8/3.9).
  const installed = deps.installedAddonVersion();
  if (installed && installed !== DATE_REPAIR_SINCE && !isNewerVersion(installed, DATE_REPAIR_SINCE)) {
    deps.log('Date repair waits for the 1.62 add-on.');
    return NOT_RUN;
  }
  const mapped = new Set((await deps.mappedAccountIds()).filter((id) => !!id));
  if (mapped.size === 0) return NOT_RUN;
  /** The database's view of the rows, read live; null (logged) when it cannot be. */
  const readOpts = () => {
    try {
      return { mappedAccountIds: mapped, overriddenIds: deps.overriddenIds(), storedTypes: deps.storedTypes(), timeZone: deps.timeZone() };
    } catch (err) {
      deps.log(err instanceof SnapshotOnlyError
        ? 'Date repair waits: the database can only be read as a snapshot'
        : `Date repair waits: couldn't read the Wealthfolio database (${err instanceof Error ? err.message : String(err)}).`);
      return null;
    }
  };
  const opts = readOpts();
  if (!opts) return NOT_RUN;

  /** Every mapped account's rows, one per id; `capped` when a sweep hit its page limit. */
  const sweep = async (): Promise<{ rows: DateRepairRow[]; capped: boolean }> => {
    const byId = new Map<string, DateRepairRow>();
    let capped = false;
    for (const accountId of mapped) {
      for (let page = 0; ; page++) {
        if (page >= maxPages) { capped = true; break; }
        const items = await deps.searchPage(accountId, page, pageSize);
        for (const r of items) byId.set(r.id, r);
        if (items.length < pageSize) break;
      }
    }
    return { rows: [...byId.values()], capped };
  };

  /** Re-read right before writing (the note and type go out as swept): the moves still true now; null when the re-read failed. */
  const reread = async (group: Move[]): Promise<Move[] | null> => {
    let fresh: Map<string, DateRepairRow>;
    try {
      fresh = new Map((await deps.searchByIds(group.map((m) => m.row.id))).map((r) => [r.id, r]));
    } catch (e) {
      deps.log(`Date repair: couldn't re-read a batch (${e instanceof Error ? e.message : String(e)}) — the next sync tries again.`);
      return null;
    }
    const same = group.filter((m) => {
      const now = fresh.get(m.row.id);
      return !!now && now.accountId === m.row.accountId && now.activityType === m.row.activityType
        && now.currency === m.row.currency && (now.comment ?? '') === (m.row.comment ?? '');
    });
    return planDateRepair(same.map((m) => fresh.get(m.row.id)!), opts).moves;
  };

  const first = await sweep();
  const plan = planDateRepair(first.rows, opts);
  const moved: string[] = [];
  const refused = new Set<string>();
  const refusedOnce: Move[] = [];
  let transient = 0;
  let changed = 0;
  const groups = batches(plan.moves);
  for (const [i, group] of groups.entries()) {
    if (i > 0) await deps.sleep(DATE_REPAIR_PAUSE_MS);
    const send = await reread(group);
    if (!send) {
      transient += group.length;
      continue;
    }
    changed += group.length - send.length;
    if (send.length === 0) continue;
    const bulk = await deps.saveUpdates(send.map((m) => m.write)).catch((e) => ({ errors: [{ action: 'save', message: String(e) }] }));
    if (bulk.errors.length === 0) {
      moved.push(...send.map((m) => m.row.id));
      continue;
    }
    // All or nothing: one refused row sends the batch back, so each goes alone.
    for (const m of send) {
      let permanent = false;
      let message = '';
      try {
        const one = await deps.saveUpdates([m.write]);
        if (one.errors.length === 0) { moved.push(m.row.id); continue; }
        permanent = true; // A refusal in the answer is about this row.
        message = one.errors.map((e) => e.message).join('; ');
      } catch (e) {
        permanent = isPermanent(e);
        message = e instanceof Error ? e.message : String(e);
      }
      if (permanent) refusedOnce.push(m); else transient += 1;
      deps.log(`Date repair: couldn't move ${m.row.id} (${message}).`);
    }
  }
  // Upstream maps every error, "database is locked" included, to a 400: one
  // refusal proves nothing. Refused rows get one more try after a pause, on a
  // fresh read, and only a second refusal is for good.
  if (refusedOnce.length > 0) {
    await deps.sleep(DATE_REPAIR_PAUSE_MS);
    for (const group of batches(refusedOnce)) {
      const send = await reread(group);
      if (!send) {
        transient += group.length;
        continue;
      }
      changed += group.length - send.length;
      for (const m of send) {
        try {
          const one = await deps.saveUpdates([m.write]);
          if (one.errors.length === 0) { moved.push(m.row.id); continue; }
          refused.add(m.row.id);
        } catch (e) {
          if (isPermanent(e)) refused.add(m.row.id); else transient += 1;
        }
      }
    }
  }
  const failed = refused.size + transient;
  // Rows left on purpose; a row that changed or vanished meanwhile is no one of them.
  const skipped = plan.skippedGrouped + plan.skippedOverride;
  if (moved.length > 0) {
    await deps.record(bookkeepingChange({
      step: 'date-repair', activityIds: moved.slice(0, DATE_REPAIR_ENTRY_IDS), total: moved.length, skipped, failed: refused.size,
    })).catch((e) => deps.log(`Change log skipped: ${String(e)}`));
  }

  // Done only when nothing movable is left: a last sweep, apart from the rows Wealthfolio refuses for good.
  let complete = transient === 0 && !first.capped;
  if (first.capped) deps.log(`Date repair: an account has more than ${maxPages * pageSize} rows — not all were read, so it isn't marked done.`);
  if (complete && plan.unknown > 0) {
    complete = false;
    deps.log(`Date repair: ${plan.unknown} row(s) are not in the database read yet — the next sync tries again.`);
  }
  if (complete) {
    try {
      // The types as they are NOW: a retype during the run must not leave a row counted as "retyped".
      const latest = readOpts();
      if (!latest) throw new Error('the database could not be read again');
      const last = await sweep();
      const check = planDateRepair(last.rows, latest);
      const left = check.moves.filter((m) => !refused.has(m.row.id));
      if (last.capped || left.length > 0 || check.unknown > 0) {
        complete = false;
        deps.log(`Date repair: ${left.length + check.unknown} row(s) are still at midnight after the pass — the next sync tries again.`);
      }
    } catch {
      deps.log(`Date repair moved ${moved.length} rows but couldn't finish checking — it will check again next sync.`);
      return { ran: true, moved: moved.length, failed, transient, changed, skippedGrouped: plan.skippedGrouped, skippedOverride: plan.skippedOverride };
    }
  }
  if (complete) {
    try {
      await deps.setSecret(DATE_REPAIR_SECRET_KEY, JSON.stringify({
        at: now.toISOString(), moved: moved.length, skippedGrouped: plan.skippedGrouped, skippedOverride: plan.skippedOverride,
      }));
    } catch {
      deps.log(`Date repair moved ${moved.length} rows but couldn't record it — it will check again next sync.`);
      return { ran: true, moved: moved.length, failed, transient, changed, skippedGrouped: plan.skippedGrouped, skippedOverride: plan.skippedOverride };
    }
  }
  deps.log(complete
    ? `Date repair: moved ${moved.length} row(s) from midnight UTC to noon; left ${skipped} linked or retyped row(s) alone${refused.size ? `; Wealthfolio refused ${refused.size}` : ''}. Done.`
    : failed > 0
      ? `Date repair: moved ${moved.length} row(s); ${failed} could not be moved — the next sync tries again.`
      : `Date repair: moved ${moved.length} row(s); not finished — the next sync tries again.`);
  return { ran: true, moved: moved.length, failed, transient, changed, skippedGrouped: plan.skippedGrouped, skippedOverride: plan.skippedOverride };
}
