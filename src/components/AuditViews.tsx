import React, { useEffect, useRef, useState } from 'react';
import { balanceCauseLines, balanceHeaderLine, balanceIncludesLine, type BalanceExplanation } from '../../shared/audit-balance';
import {
  headlineAgreeLine, headlineAgrees, headlineReasonLine, headlineRowLine, headlineSummaryLine, headlineUnexplainedLine,
  type HeadlineExplanation,
} from '../../shared/audit-headline';
import { healthCount, healthIssueLines, healthIssueTitle, HEALTH_NONE, type HealthIssue, type HealthReport } from '../../shared/audit-health';
import {
  linkablePair, linkablePairs, linkAllButton, LINK_BUTTON, LINK_UNREACHABLE, type LinkPair, type LinkRun,
} from '../../shared/audit-link';
import { auditSnapshotStatus, AUDIT_CORRUPT, type AuditSnapshotRead } from '../../shared/audit-snapshot';
import { Button } from './ui';

/**
 * The three checks as the app shows them (2c R1, spec A5), from the
 * companion's snapshot (shared/audit-snapshot.ts): why a balance is off
 * (inline under its account), why the month's spending differs from
 * Wealthfolio's (in place under the Budget tab's headline numbers), and what
 * Wealthfolio's Health page flags (Settings → Checks). Every line comes from
 * the shared builders — the words Telegram sends — and renders as text, so
 * bank text is never markup. No emoji (src/pages/copy-policy.test.tsx).
 *
 * R2: given a linker, the Checks card offers Link under each Health leg with
 * one likely other half, and Link all for two or more. One action at a time
 * (every button disabled and busy while it runs); the result is said in a
 * status line, and — the card shows a snapshot — that changes show here
 * after the next sync.
 */
export const AUDIT_HEADLINE_LINK = 'Why is this different from Wealthfolio?';
/** After a fix: the card reads the companion's snapshot, which only its next sync renews. */
export const AUDIT_AFTER_SYNC = 'Changes show here after the next sync.';
/** Health returned no verdict (its database read failed). */
export const AUDIT_HEALTH_NOT_CHECKED = "Health wasn't checked.";
export const AUDIT_ACCOUNT_NOT_COVERED = "These checks don't cover this account yet — they arrive with the companion's next sync.";

export interface AuditSource {
  read: AuditSnapshotRead;
  companionVersion: string | null;
  now: Date;
}

/** Where the checks came from: "As of the 2:00 PM sync.", stale, absent or unreadable. */
export function AuditStatusLine({ read, companionVersion, now }: AuditSource) {
  const { state, line } = auditSnapshotStatus(read, companionVersion, now);
  return <div role="status" className={`sfin-subtle sfin-audit-status sfin-audit-status--${state}`}>{line}</div>;
}

/**
 * A snapshot the reader let through but a view still cannot draw (a host
 * that hands over a parsed object as-is, or a shape the reader does not
 * check) shows the corrupt line in place of that view, never a crashed page.
 * A new snapshot draws again.
 */
class AuditBoundary extends React.Component<{ read: AuditSnapshotRead; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev: { read: AuditSnapshotRead }) {
    if (prev.read !== this.props.read && this.state.failed) this.setState({ failed: false });
  }

  render() {
    if (this.state.failed) {
      return <div role="status" className="sfin-subtle sfin-audit-status sfin-audit-status--corrupt">{AUDIT_CORRUPT}</div>;
    }
    return this.props.children;
  }
}

function AuditNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return <ul className="sfin-audit-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>;
}

export function BalanceExplanationView({ e, notes = [] }: { e: BalanceExplanation; notes?: readonly string[] }) {
  const causes = balanceCauseLines(e);
  const includes = balanceIncludesLine(e);
  return (
    <div className="sfin-audit-body">
      <div className="sfin-audit-head">{balanceHeaderLine(e)}</div>
      {causes.length > 0 && <ul className="sfin-audit-lines">{causes.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {includes && <div className="sfin-subtle">{includes}</div>}
      <AuditNotes notes={notes} />
    </div>
  );
}

/** One account's explanation from the snapshot, with where it came from. */
export function AccountAudit({ wfAccountId, ...source }: AuditSource & { wfAccountId: string }) {
  const e = source.read.kind === 'ok' ? source.read.snapshot.balances[wfAccountId] : undefined;
  return (
    <div className="sfin-audit-inline">
      <AuditBoundary read={source.read}>
        {source.read.kind === 'ok' && (e
          ? <BalanceExplanationView e={e} notes={source.read.snapshot.balanceNotes} />
          : <div className="sfin-subtle">{AUDIT_ACCOUNT_NOT_COVERED}</div>)}
        <AuditStatusLine {...source} />
      </AuditBoundary>
    </div>
  );
}

/** `now` is the viewer's: a snapshot from a month that has since turned is
 *  labelled by that month's name, never "this month". */
export function HeadlineView({ h, now }: { h: HeadlineExplanation; now?: Date }) {
  const summary = headlineSummaryLine(h, now);
  const rest = headlineUnexplainedLine(h);
  return (
    <div className="sfin-audit-body">
      {summary && <div className="sfin-audit-head">{summary}</div>}
      {headlineAgrees(h) ? <div>{headlineAgreeLine(h, now)}</div> : h.reasons && (
        <ul className="sfin-audit-lines">
          {h.reasons.map((r) => (
            <li key={r.kind}>
              <details className="sfin-audit-reason">
                <summary>{headlineReasonLine(h, r)}</summary>
                <ul className="sfin-audit-rows">{r.rows.map((row, i) => <li key={i}>{headlineRowLine(row)}</li>)}</ul>
                {r.more ? <div className="sfin-subtle">and {r.more} more</div> : null}
              </details>
            </li>
          ))}
          {rest && <li>{rest}</li>}
        </ul>
      )}
      <AuditNotes notes={h.notes} />
    </div>
  );
}

/** The run's message with any lost or maybe-lost rows spelled out, whatever the message already says. */
function withLoss(r: LinkRun): string {
  let m = r.message;
  const add = (rows: readonly string[] | undefined, lead: string) => {
    if (rows?.length && !rows.every((x) => m.includes(x))) m += ` ${lead}: ${rows.join('; ')}.`;
  };
  add(r.lost, 'Deleted and not restored');
  add(r.maybeLost, 'May have been deleted');
  return m;
}

/** R2: what the Checks card can fix. */
export interface HealthFix {
  link: (pairs: LinkPair[]) => Promise<LinkRun>;
  /** After a fix: read the snapshot again. */
  onFixed?: () => void;
}

export function HealthView({ report, fix }: { report: HealthReport; fix?: HealthFix }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Pairs linked here: the snapshot lists them until the companion's next sync.
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  // One action per click, even before the re-render that disables the buttons.
  const running = useRef(false);
  // No state updates once the card is gone (a link can outlive it).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const pairOf = (i: HealthIssue) => (fix && !done.has(i.key) ? linkablePair(i) : null);
  const open = fix ? linkablePairs(report.issues).filter((p) => !done.has(p.key)) : [];
  const run = async (pairs: LinkPair[]) => {
    if (!fix || running.current || pairs.length === 0) return;
    running.current = true;
    setBusy(true);
    let message: string;
    let linked: string[] = [];
    try {
      const r = await fix.link(pairs);
      message = withLoss(r);
      linked = r.done;
    } catch {
      message = LINK_UNREACHABLE;
    }
    running.current = false;
    if (!mounted.current) return;
    setDone((d) => new Set([...d, ...linked]));
    setResult(message);
    setBusy(false);
    fix.onFixed?.();
  };
  return (
    <div className="sfin-audit-body">
      {report.issues === null && report.notes.length === 0 && <div>{AUDIT_HEALTH_NOT_CHECKED}</div>}
      {report.issues && report.issues.length === 0 && !report.more && <div>{HEALTH_NONE}</div>}
      {report.issues && report.issues.length > 0 && (
        <ul className="sfin-audit-issues">
          {report.issues.map((i) => {
            const pair = pairOf(i);
            return (
              <li key={i.key} className="sfin-audit-issue">
                <div className="sfin-audit-head">{healthIssueTitle(i)}</div>
                {healthIssueLines(i).map((l, n) => <div key={n} className="sfin-subtle">{l}</div>)}
                {pair && (
                  <div className="sfin-audit-fix">
                    <Button variant="ghost" disabled={busy} aria-busy={busy} onClick={() => run([pair])}>{LINK_BUTTON}</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {report.more ? <div className="sfin-subtle">and {report.more} more</div> : null}
      {open.length >= 2 && (
        <div className="sfin-audit-fix">
          <Button variant="ghost" disabled={busy} aria-busy={busy} onClick={() => run(open)}>{linkAllButton(open.length)}</Button>
        </div>
      )}
      {/* Mounted from the first render, so what lands in it is announced. */}
      {fix && <div role="status" className="sfin-subtle">{result ? `${result} ${AUDIT_AFTER_SYNC}` : ''}</div>}
      <AuditNotes notes={report.notes} />
    </div>
  );
}

/** Settings → Checks: what Health flags, and where the checks came from.
 *  R2: `link` adds Link; `onFixed` reads the snapshot again after a fix. */
export function ChecksCard({ link, onFixed, ...source }: AuditSource & Partial<HealthFix>) {
  return (
    <div className="sfin-audit-checks">
      <AuditBoundary read={source.read}>
        {source.read.kind === 'ok' && <HealthView report={source.read.snapshot.health} fix={link ? { link, onFixed } : undefined} />}
        <AuditStatusLine {...source} />
      </AuditBoundary>
    </div>
  );
}

/** The Checks card's collapsed summary. */
export function checksSummary(read: AuditSnapshotRead, companionVersion: string | null): string {
  if (read.kind === 'corrupt') return "Couldn't read";
  if (read.kind === 'absent') return companionVersion ? 'Arrive with the next sync' : 'Need the companion';
  const n = healthCount(read.snapshot.health);
  return n === null ? 'Health not checked' : n === 0 ? 'Nothing found' : `${n} to look at`;
}

/** How many things Health flags, for Home's Accounts tile; 0 when unknown. */
export function healthIssueCount(read: AuditSnapshotRead | null | undefined): number {
  return read?.kind === 'ok' ? healthCount(read.snapshot.health) ?? 0 : 0;
}

/** The Budget tab's "Why is this different from Wealthfolio?", opening in place. */
export function HeadlineAuditLink(source: AuditSource) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sfin-audit-headline">
      <button type="button" className="sfin-audit-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {AUDIT_HEADLINE_LINK}
      </button>
      {open && (
        <div className="sfin-audit-inline" role="region" aria-label="Spent vs Wealthfolio">
          <AuditBoundary read={source.read}>
            {source.read.kind === 'ok' && <HeadlineView h={source.read.snapshot.headline} now={source.now} />}
            <AuditStatusLine {...source} />
          </AuditBoundary>
        </div>
      )}
    </div>
  );
}
