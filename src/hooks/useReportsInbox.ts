import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { REPORT_KINDS, type ReportKind, type ReportStore } from '../../shared/reports-archive';
import {
  baselineSeen, markSeen, unreadCounts, type ReportsSeen, type ReportsSeenRead,
} from '../../shared/reports-seen';

/** What the inbox reads and writes; the seen pair is optional-called, so an
 *  older store simply counts nothing. */
export interface ReportsInboxStore {
  getReports(kind: ReportKind): Promise<ReportStore>;
  getReportsSeen?(): Promise<ReportsSeenRead>;
  setReportsSeen?(seen: ReportsSeen): Promise<void>;
}

export interface ReportsInbox {
  /** Unread sent editions per kind — all zero until read, and whenever what
   *  was seen cannot be known. */
  counts: Record<ReportKind, number>;
  total: number;
  /** What was seen, as last read or written; null until known. */
  seen: ReportsSeen | null;
  /** Re-read the seen state and the three archives. */
  refresh(): void;
  /** A kind's sub-tab opened on `data`: marks it seen, one best-effort write. */
  opened(kind: ReportKind, data: ReportStore): void;
}

/**
 * The Reports tab's unread state (project 5 R1, spec C; ruling N5), held by
 * the page so the tab bar's count and the sub-tabs agree.
 *
 * First run (no `reports_seen`) or a value nothing can read: everything counts
 * as seen and each kind's newest edition is written as the baseline, once per
 * page, best-effort. A host read that fails counts nothing and writes nothing.
 * Marking seen writes one document at a time (a queue), so two sub-tabs
 * opened quickly cannot overwrite each other; a failed write leaves the count
 * as it was and never throws; nothing is set after unmount.
 */
/** Per kind, the later of two seen documents: a time never goes back. */
function laterOf(a: ReportsSeen | null, b: ReportsSeen | null): ReportsSeen {
  const out: ReportsSeen = { ...(a ?? {}) };
  for (const k of REPORT_KINDS) {
    const t = b?.[k];
    if (t === undefined) continue;
    const have = out[k];
    if (have === undefined || Date.parse(t) > Date.parse(have)) out[k] = t;
  }
  return out;
}

export function useReportsInbox(store: ReportsInboxStore): ReportsInbox {
  const [seen, setSeen] = useState<ReportsSeen | null>(null);
  const [stores, setStores] = useState<Partial<Record<ReportKind, ReportStore>>>({});
  const seenRef = useRef<ReportsSeen | null>(null);
  const storesRef = useRef<Partial<Record<ReportKind, ReportStore>>>({});
  const mounted = useRef(true);
  const baselineTried = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(() => {
    if (!store.getReportsSeen) return;
    Promise.all([store.getReportsSeen(), Promise.all(REPORT_KINDS.map((k) => store.getReports(k)))])
      .then(([read, list]) => {
        if (!mounted.current) return;
        const byKind: Partial<Record<ReportKind, ReportStore>> = {};
        REPORT_KINDS.forEach((k, i) => { byKind[k] = list[i]; });
        storesRef.current = byKind;
        setStores(byKind);
        // A refresh never lowers a kind's seen time (a write may be landing).
        if (read.kind === 'ok') {
          const merged = laterOf(seenRef.current, read.seen);
          seenRef.current = merged;
          setSeen(merged);
          return;
        }
        const baseline = laterOf(seenRef.current, baselineSeen(byKind));
        seenRef.current = baseline;
        setSeen(baseline);
        if (baselineTried.current) return;
        baselineTried.current = true;
        store.setReportsSeen?.(baseline)?.catch(() => {});
      })
      .catch(() => {});
  }, [store]);

  // No effect of its own: the page calls `refresh` from its live path (mount,
  // focus, the minute interval), so there is one reader.

  const opened = useCallback((kind: ReportKind, data: ReportStore) => {
    if (!store.setReportsSeen) return;
    const run = async () => {
      const current = seenRef.current;
      if (!current) return;
      // Re-read first: another device may have moved another kind on, and
      // writing our older copy would put its time back.
      let next: ReportsSeen | null;
      let base = current;
      try {
        const read = await store.getReportsSeen?.();
        if (read === undefined) {
          next = markSeen(current, kind, data);
        } else if (read.kind === 'ok') {
          base = laterOf(current, read.seen);
          next = markSeen(base, kind, data);
        } else {
          next = baselineSeen({ ...storesRef.current, [kind]: data });
        }
      } catch {
        return;
      }
      if (!next) {
        // Nothing to write, but another device may have moved times on.
        seenRef.current = base;
        if (mounted.current) setSeen(base);
        return;
      }
      try {
        await store.setReportsSeen!(next);
      } catch {
        return;
      }
      seenRef.current = next;
      if (!mounted.current) return;
      setSeen(next);
      setStores((prev) => ({ ...prev, [kind]: data }));
      storesRef.current = { ...storesRef.current, [kind]: data };
    };
    queue.current = queue.current.then(run, run);
  }, [store]);

  const counts = useMemo(() => unreadCounts(stores, seen), [stores, seen]);
  const total = counts.daily + counts.weekly + counts.monthly;
  return useMemo(() => ({ counts, total, seen, refresh, opened }), [counts, total, seen, refresh, opened]);
}
