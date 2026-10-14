/**
 * shared/reports-seen.ts
 *
 * The Reports tab's unread state (project 5 R1, spec C; ruling N5): which
 * report editions the person has seen, kept in the `reports_seen` add-on
 * secret — `{ daily?, weekly?, monthly? }`, the newest `generatedAt` seen per
 * kind — so it is shared across their devices. The add-on is its only writer.
 *
 * What counts: SENT editions only (the archive). The live edition is
 * recomposed after every sync and is never "new". An edition is unread when it
 * was generated after its kind's seen time; a kind the document has no time
 * for yet counts every sent edition. With no document (the first run) or one
 * nothing can read, everything counts as seen and the newest editions become
 * the baseline, so later ones count as new.
 */
import { REPORT_KINDS, type ReportEdition, type ReportKind, type ReportStore } from './reports-archive.js';

export const REPORTS_SEEN_SECRET_KEY = 'reports_seen';

export type ReportsSeen = Partial<Record<ReportKind, string>>;

export type ReportsSeenRead =
  | { kind: 'ok'; seen: ReportsSeen }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

export const NO_UNREAD: Readonly<Record<ReportKind, number>> = { daily: 0, weekly: 0, monthly: 0 };

const time = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Absent for nothing stored; corrupt for anything that is not an object
 *  whose known kinds are readable times. Unknown keys are ignored. */
export function parseReportsSeen(raw: string | null | undefined): ReportsSeenRead {
  if (raw === null || raw === undefined || raw === '') return { kind: 'absent' };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { kind: 'corrupt' };
  const seen: ReportsSeen = {};
  for (const kind of REPORT_KINDS) {
    const value = (v as Record<string, unknown>)[kind];
    if (value === undefined) continue;
    if (time(value) === null) return { kind: 'corrupt' };
    seen[kind] = value as string;
  }
  return { kind: 'ok', seen };
}

/** The newest sent edition's `generatedAt`, or null when none can be read. */
export function newestEdition(store: ReportStore): string | null {
  let newest: string | null = null;
  let newestTime = Number.NEGATIVE_INFINITY;
  for (const e of store.archive) {
    const t = time(e.generatedAt);
    if (t !== null && t > newestTime) {
      newest = e.generatedAt;
      newestTime = t;
    }
  }
  return newest;
}

/** Generated after `seenAt`; every edition when the kind has no time yet.
 *  An edition whose time cannot be read is never "new". */
export function isUnread(edition: ReportEdition, seenAt: string | undefined): boolean {
  const t = time(edition.generatedAt);
  if (t === null) return false;
  if (seenAt === undefined) return true;
  const s = time(seenAt);
  return s !== null && t > s;
}

export function unreadCount(store: ReportStore, seenAt: string | undefined): number {
  return store.archive.filter((e) => isUnread(e, seenAt)).length;
}

/** Per kind; all zero when nothing is known to be seen (null). */
export function unreadCounts(stores: Partial<Record<ReportKind, ReportStore>>, seen: ReportsSeen | null): Record<ReportKind, number> {
  const counts = { ...NO_UNREAD };
  if (seen === null) return counts;
  for (const kind of REPORT_KINDS) {
    const store = stores[kind];
    if (store) counts[kind] = unreadCount(store, seen[kind]);
  }
  return counts;
}

/** The first run's (or a rewrite's) document: each kind's newest edition, so
 *  everything there now counts as seen. A kind with none is left out. */
export function baselineSeen(stores: Partial<Record<ReportKind, ReportStore>>): ReportsSeen {
  const seen: ReportsSeen = {};
  for (const kind of REPORT_KINDS) {
    const store = stores[kind];
    const newest = store ? newestEdition(store) : null;
    if (newest) seen[kind] = newest;
  }
  return seen;
}

/** The document after opening `kind`'s sub-tab, or null when nothing would
 *  change — so a second visit writes nothing. */
export function markSeen(seen: ReportsSeen, kind: ReportKind, store: ReportStore): ReportsSeen | null {
  const newest = newestEdition(store);
  if (newest === null) return null;
  const current = time(seen[kind]);
  if (current !== null && time(newest)! <= current) return null;
  return { ...seen, [kind]: newest };
}

/** "Reports, 2 unread" — a tab's accessible name while it has unread editions. */
export function unreadLabel(label: string, count: number): string {
  return `${label}, ${count} unread`;
}
