import React, { useState } from 'react';
import { balanceCauseLines, balanceHeaderLine, balanceIncludesLine, type BalanceExplanation } from '../../shared/audit-balance';
import {
  headlineAgrees, headlineReasonLine, headlineRowLine, headlineSummaryLine, headlineUnexplainedLine, HEADLINE_AGREE,
  type HeadlineExplanation,
} from '../../shared/audit-headline';
import { healthCount, healthIssueLines, healthIssueTitle, HEALTH_NONE, type HealthReport } from '../../shared/audit-health';
import { auditSnapshotStatus, type AuditSnapshotRead } from '../../shared/audit-snapshot';

/**
 * The three checks as the app shows them (2c R1, spec A5), from the
 * companion's snapshot (shared/audit-snapshot.ts): why a balance is off
 * (inline under its account), why the month's spending differs from
 * Wealthfolio's (in place under the Budget tab's headline numbers), and what
 * Wealthfolio's Health page flags (Settings → Checks). Every line comes from
 * the shared builders — the words Telegram sends — and renders as text, so
 * bank text is never markup. No emoji (src/pages/copy-policy.test.tsx).
 */
export const AUDIT_HEADLINE_LINK = 'Why is this different from Wealthfolio?';
export const AUDIT_ACCOUNT_NOT_COVERED = "These checks don't cover this account yet — they arrive with the companion's next sync.";

export interface AuditSource {
  read: AuditSnapshotRead;
  companionVersion: string | null;
  now: Date;
}

/** Where the checks came from: "As of the 2:00 PM sync.", stale, absent or unreadable. */
export function AuditStatusLine({ read, companionVersion, now }: AuditSource) {
  const { state, line } = auditSnapshotStatus(read, companionVersion, now);
  return <div className={`sfin-subtle sfin-audit-status sfin-audit-status--${state}`}>{line}</div>;
}

function AuditNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return <ul className="sfin-audit-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul>;
}

export function BalanceExplanationView({ e, notes = [] }: { e: BalanceExplanation; notes?: readonly string[] }) {
  const causes = balanceCauseLines(e);
  const includes = balanceIncludesLine(e);
  return (
    <div className="sfin-audit-body">
      <div className="sfin-audit-head">{balanceHeaderLine(e)}</div>
      {causes.length > 0 && <ul className="sfin-audit-lines">{causes.map((l) => <li key={l}>{l}</li>)}</ul>}
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
      {source.read.kind === 'ok' && (e
        ? <BalanceExplanationView e={e} notes={source.read.snapshot.balanceNotes} />
        : <div className="sfin-subtle">{AUDIT_ACCOUNT_NOT_COVERED}</div>)}
      <AuditStatusLine {...source} />
    </div>
  );
}

export function HeadlineView({ h }: { h: HeadlineExplanation }) {
  const summary = headlineSummaryLine(h);
  const rest = headlineUnexplainedLine(h);
  return (
    <div className="sfin-audit-body">
      {summary && <div className="sfin-audit-head">{summary}</div>}
      {headlineAgrees(h) ? <div>{HEADLINE_AGREE}</div> : h.reasons && (
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

export function HealthView({ report }: { report: HealthReport }) {
  return (
    <div className="sfin-audit-body">
      {report.issues && report.issues.length === 0 && !report.more && <div>{HEALTH_NONE}</div>}
      {report.issues && report.issues.length > 0 && (
        <ul className="sfin-audit-issues">
          {report.issues.map((i) => (
            <li key={i.key} className="sfin-audit-issue">
              <div className="sfin-audit-head">{healthIssueTitle(i)}</div>
              {healthIssueLines(i).map((l) => <div key={l} className="sfin-subtle">{l}</div>)}
            </li>
          ))}
        </ul>
      )}
      {report.more ? <div className="sfin-subtle">and {report.more} more</div> : null}
      <AuditNotes notes={report.notes} />
    </div>
  );
}

/** Settings → Checks: what Health flags, and where the checks came from. */
export function ChecksCard(source: AuditSource) {
  return (
    <div className="sfin-audit-checks">
      {source.read.kind === 'ok' && <HealthView report={source.read.snapshot.health} />}
      <AuditStatusLine {...source} />
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
        <div className="sfin-audit-inline">
          {source.read.kind === 'ok' && <HeadlineView h={source.read.snapshot.headline} />}
          <AuditStatusLine {...source} />
        </div>
      )}
    </div>
  );
}
