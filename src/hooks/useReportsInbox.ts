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
export function useReportsInbox(store: ReportsInboxStore): ReportsInbox {
  const [seen, setSeen] = useState<ReportsSeen | null>(null);
  const [stores, setStores] = useState<Partial<Record<ReportKind, ReportStore>>>({});
  const seenRef = useRef<ReportsSeen | null>(null);
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
        setStores(byKind);
        if (read.kind === 'ok') {
          seenRef.current = read.seen;
          setSeen(read.seen);
          return;
        }
        const baseline = baselineSeen(byKind);
        seenRef.current = baseline;
        setSeen(baseline);
        if (baselineTried.current) return;
        baselineTried.current = true;
        store.setReportsSeen?.(baseline)?.catch(() => {});
      })
      .catch(() => {});
  }, [store]);

  useEffect(() => { refresh(); }, [refresh]);

  const opened = useCallback((kind: ReportKind, data: ReportStore) => {
    if (!store.setReportsSeen) return;
    const run = async () => {
      const current = seenRef.current;
      if (!current) return;
      const next = markSeen(current, kind, data);
      if (!next) return;
      try {
        await store.setReportsSeen!(next);
      } catch {
        return;
      }
      seenRef.current = next;
      if (!mounted.current) return;
      setSeen(next);
      setStores((prev) => ({ ...prev, [kind]: data }));
    };
    queue.current = queue.current.then(run, run);
  }, [store]);

  const counts = useMemo(() => unreadCounts(stores, seen), [stores, seen]);
  const total = counts.daily + counts.weekly + counts.monthly;
  return useMemo(() => ({ counts, total, seen, refresh, opened }), [counts, total, seen, refresh, opened]);
}
