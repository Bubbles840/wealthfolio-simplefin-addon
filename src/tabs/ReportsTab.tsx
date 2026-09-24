import React, { useEffect, useRef, useState } from 'react';
import {
  REPORT_KINDS,
  type ReportEdition,
  type ReportKind,
  type ReportStore,
} from '../../shared/reports-archive';

/**
 * The Reports tab: every daily, weekly and monthly report, kept.
 *
 * What it replaces. Telegram was the one place reports lived, and the part of
 * it worth keeping was the history: scroll back to any report, pull one up
 * whenever. Here each sub-tab shows the report as it stands right now (the
 * companion recomposes it after every sync, from the local ledger) with the
 * editions actually sent listed underneath. A push notification links straight
 * to its sub-tab.
 *
 * Read-only by design: the companion writes these (see
 * shared/reports-archive.ts), so there is nothing here to run or configure.
 */

const LABELS: Record<ReportKind, string> = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

export interface ReportsStore {
  getReports(kind: ReportKind): Promise<ReportStore>;
}

export function ReportsTab({ store, initialReport }: { store: ReportsStore; initialReport?: ReportKind }) {
  const [kind, setKind] = useState<ReportKind>(initialReport ?? 'daily');
  const [data, setData] = useState<ReportStore | null>(null);
  const tabRefs = useRef<Map<ReportKind, HTMLButtonElement>>(new Map());

  // A later notification tap re-renders with a new initialReport.
  useEffect(() => {
    if (initialReport) setKind(initialReport);
  }, [initialReport]);

  useEffect(() => {
    let live = true;
    setData(null);
    store
      .getReports(kind)
      .then((d) => { if (live) setData(d); })
      .catch(() => { if (live) setData({ live: null, archive: [] }); });
    return () => { live = false; };
  }, [store, kind]);

  const move = (delta: number) => {
    const i = REPORT_KINDS.indexOf(kind);
    const next = REPORT_KINDS[(i + delta + REPORT_KINDS.length) % REPORT_KINDS.length];
    setKind(next);
    tabRefs.current.get(next)?.focus();
  };

  const empty = data && !data.live && data.archive.length === 0;

  return (
    <div className="sfin-reports">
      <div className="sfin-subtabs" role="tablist" aria-label="Reports">
        {REPORT_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`sfin-report-tab-${k}`}
            aria-selected={k === kind}
            aria-controls="sfin-report-panel"
            tabIndex={k === kind ? 0 : -1}
            className={`sfin-subtab${k === kind ? ' sfin-subtab--active' : ''}`}
            ref={(el) => { if (el) tabRefs.current.set(k, el); else tabRefs.current.delete(k); }}
            onClick={() => setKind(k)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); move(1); }
              if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
            }}
          >
            {LABELS[k]}
          </button>
        ))}
      </div>

      <div id="sfin-report-panel" role="tabpanel" aria-labelledby={`sfin-report-tab-${kind}`}>
        {data === null && <div className="sfin-subtle">Loading…</div>}
        {empty && (
          <div className="sfin-callout">
            No {kind} reports yet. The Docker companion publishes each report here
            after its next sync, and keeps every one it sends.
          </div>
        )}
        {data?.live && (
          <section className="sfin-card sfin-report-live" aria-label={`${LABELS[kind]} report, right now`}>
            <div className="sfin-report-head">
              <strong>{data.live.title}</strong>
              <span className="sfin-subtle">{kind === 'monthly' ? 'month so far' : 'right now'} · updated {timeOf(data.live)}</span>
            </div>
            <ReportText text={data.live.text} />
          </section>
        )}
        {data && data.archive.length > 0 && (
          <section aria-label="Past reports">
            <h3 className="sfin-section-title">Past reports</h3>
            {data.archive.map((e) => (
              <details key={`${e.kind}-${e.period}`} className="sfin-card sfin-report-past">
                <summary>{e.title}</summary>
                <ReportText text={e.text} />
              </details>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

function timeOf(edition: ReportEdition): string {
  const d = new Date(edition.generatedAt);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Telegram's (legacy) Markdown, which every report is written in: `*bold*`,
 * `_italic_`, `` `code` `` and `[text](url)`, one paragraph per line. Rendered
 * as React elements, never as HTML, so report text can never inject markup.
 * An unpaired marker (a lone `*` in "5 * 3") stays literal text.
 */
export function ReportText({ text }: { text: string }) {
  return (
    <div className="sfin-report-text">
      {text.split('\n').map((line, i) =>
        line.trim() === ''
          ? <div key={i} className="sfin-report-gap" />
          : <div key={i} className="sfin-report-line">{inline(line)}</div>,
      )}
    </div>
  );
}

const TOKEN = /\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

function inline(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    const key = `${at}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<em key={key}>{m[2]}</em>);
    else if (m[3] !== undefined) out.push(<code key={key}>{m[3]}</code>);
    else out.push(<a key={key} href={m[5]} target="_blank" rel="noreferrer">{m[4]}</a>);
    last = at + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}
