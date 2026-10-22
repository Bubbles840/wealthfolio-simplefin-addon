import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { heldTransferMessage, type HeldTransfer } from '../../shared/held-transfers';
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

/** R2: what the Checks card can fix. */
export interface HealthFix {
  link: (pairs: LinkPair[]) => Promise<LinkRun>;
  /** After a fix: read the snapshot again. */
  onFixed?: () => void;
}

/**
 * The card's fix state lives at module scope: a link outlives the card (Checks
 * collapsed, another tab), and a card mounted meanwhile must show the buttons
 * disabled, then the result. One run at a time, app-wide. Only mounted cards
 * hear about changes, so nothing is set on a card that is gone.
 */
interface FixListener { update: () => void; onFixed?: () => void }
const fixState = { running: false, result: null as string | null, at: null as string | null, after: true, done: new Set<string>(), listeners: new Set<FixListener>() };
/** Tests: forget everything the module remembers. */
export function resetCheckFixes(): void {
  fixState.running = false;
  fixState.result = null;
  fixState.at = null;
  fixState.after = true;
  fixState.done = new Set();
  fixState.listeners.clear();
}
const notifyFix = () => fixState.listeners.forEach((l) => l.update());

async function runLinks(link: HealthFix['link'], pairs: LinkPair[], at: string | null): Promise<void> {
  if (fixState.running || pairs.length === 0) return;
  fixState.running = true;
  fixState.result = null;
  fixState.at = at;
  notifyFix();
  let message: string;
  let linked: string[] = [];
  // Nothing was linked, lost or failed (a refusal): nothing will change after the next sync.
  let after = false;
  try {
    const r = await link(pairs);
    message = r.message;
    linked = r.done;
    after = r.linked > 0 || r.failed > 0 || r.lost.length > 0 || r.maybeLost.length > 0;
  } catch {
    message = LINK_UNREACHABLE;
  }
  fixState.running = false;
  fixState.done = new Set([...fixState.done, ...linked]);
  fixState.result = message;
  fixState.after = after;
  notifyFix();
  // The newest card still mounted asks its page to read the snapshot again.
  [...fixState.listeners].pop()?.onFixed?.();
}

/** `at`: when the snapshot shown was taken. A result belongs to the snapshot it was run against. */
export function HealthView({ report, fix, at }: { report: HealthReport; fix?: HealthFix; at?: string }) {
  const [, tick] = useState(0);
  const onFixed = useRef(fix?.onFixed);
  onFixed.current = fix?.onFixed;
  // A layout effect, so the card is subscribed by the time it can be clicked.
  // A passive one runs a task after a non-urgent render (the app mounts the
  // card from an async read): a link that settled first was heard by no card,
  // and the page never read the snapshot again.
  useLayoutEffect(() => {
    const me: FixListener = { update: () => tick((n) => n + 1), onFixed: () => onFixed.current?.() };
    fixState.listeners.add(me);
    // A run may have finished between the render and this subscription.
    me.update();
    return () => { fixState.listeners.delete(me); };
  }, []);
  const busy = fixState.running;
  const done = fixState.done;
  const result = fixState.result !== null && fixState.at === (at ?? null) ? fixState.result : null;
  const pairOf = (i: HealthIssue) => (fix && !done.has(i.key) ? linkablePair(i) : null);
  const open = fix ? linkablePairs(report.issues).filter((p) => !done.has(p.key)) : [];
  const run = (pairs: LinkPair[]) => { if (fix) void runLinks(fix.link, pairs, at ?? null); };
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
                <div className="sfin-audit-head" id={`sfin-audit-title-${i.key}`}>{healthIssueTitle(i)}</div>
                {healthIssueLines(i).map((l, n) => <div key={n} className="sfin-subtle">{l}</div>)}
                {pair && (
                  <div className="sfin-audit-fix">
                    <Button variant="ghost" disabled={busy} aria-busy={busy} aria-describedby={`sfin-audit-title-${i.key}`} onClick={() => run([pair])}>{LINK_BUTTON}</Button>
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
      {fix && <div role="status" className="sfin-subtle">{result ? (fixState.after ? `${result} ${AUDIT_AFTER_SYNC}` : result) : ''}</div>}
      <AuditNotes notes={report.notes} />
    </div>
  );
}

export const HELD_TITLE = 'Still in transit';
export const NOT_TRANSFER_BUTTON = 'Not a transfer';

/** What "Not a transfer" answers: `ok` only when the mark was saved. */
export interface NotTransferResult { ok: boolean; message: string }

/** Transfers held 14+ days (1.65 C), each with why and, when it can be written, "Not a transfer".
 *  `loadMarked`: the bank-transaction keys already marked, read when the card opens (it unmounts
 *  when collapsed, and the snapshot can lag); null/failed changes nothing. */
export function HeldTransfersView({ held, notTransfer, loadMarked }: {
  held: readonly HeldTransfer[];
  notTransfer?: (h: HeldTransfer) => Promise<NotTransferResult>;
  loadMarked?: () => Promise<ReadonlySet<string> | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [markedKeys, setMarkedKeys] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState('');
  const running = useRef(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const keys = await loadMarked?.();
        if (live && keys) setMarkedKeys(keys);
      } catch { /* unchanged */ }
    })();
    return () => { live = false; };
  }, [loadMarked]);
  const run = async (h: HeldTransfer) => {
    if (!notTransfer || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const res = await notTransfer(h);
      setStatus(res.message);
      if (res.ok) setDone((d) => new Set(d).add(h.activityId));
    } catch {
      setStatus('');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="sfin-audit-body sfin-audit-held">
      <div className="sfin-audit-head">{HELD_TITLE}</div>
      <ul className="sfin-audit-issues">
        {held.map((h) => {
          const marked = h.marked === true || (h.txKey !== null && markedKeys.has(h.txKey));
          const shown = marked ? { ...h, marked: true as const } : h;
          return (
            <li key={h.activityId} className="sfin-audit-issue">
              <div className="sfin-subtle" id={`sfin-held-${h.activityId}`}>{heldTransferMessage(shown)}</div>
              {notTransfer && h.txKey && !marked && !done.has(h.activityId) && (
                <div className="sfin-audit-fix">
                  <Button variant="ghost" disabled={busy} aria-busy={busy} aria-describedby={`sfin-held-${h.activityId}`} onClick={() => void run(h)}>{NOT_TRANSFER_BUTTON}</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* Mounted from the first render, so what lands in it is announced. */}
      {notTransfer && <div role="status" className="sfin-subtle">{status}</div>}
    </div>
  );
}

/** Settings → Checks: what Health flags, and where the checks came from.
 *  R2: `link` adds Link; `onFixed` reads the snapshot again after a fix. */
export function ChecksCard({ link, onFixed, notTransfer, loadMarked, ...source }: AuditSource & Partial<HealthFix> & { notTransfer?: (h: HeldTransfer) => Promise<NotTransferResult>; loadMarked?: () => Promise<ReadonlySet<string> | null> }) {
  return (
    <div className="sfin-audit-checks">
      <AuditBoundary read={source.read}>
        {source.read.kind === 'ok' && <HealthView report={source.read.snapshot.health} fix={link ? { link, onFixed } : undefined} at={source.read.snapshot.at} />}
        {source.read.kind === 'ok' && source.read.snapshot.held && source.read.snapshot.held.length > 0 && (
          <HeldTransfersView held={source.read.snapshot.held} notTransfer={notTransfer} loadMarked={loadMarked} />
        )}
        <AuditStatusLine {...source} />
      </AuditBoundary>
    </div>
  );
}

/** The Checks card's collapsed summary. */
export function checksSummary(read: AuditSnapshotRead, companionVersion: string | null): string {
  if (read.kind === 'corrupt') return "Couldn't read";
  if (read.kind === 'absent') return companionVersion ? 'Arrive with the next sync' : 'Need the companion';
  if (healthCount(read.snapshot.health) === null && unmarkedHeld(read.snapshot) === 0) return 'Health not checked';
  const total = checksToLookAt(read);
  return total === 0 ? 'Nothing found' : `${total} to look at`;
}

const unmarkedHeld = (snapshot: { held?: Array<{ marked?: boolean }> }): number => (snapshot.held ?? []).filter((h) => !h.marked).length;

/** Everything the Checks card says to look at: Health issues plus held transfers not yet marked. Home counts with this too. */
export function checksToLookAt(read: AuditSnapshotRead | null | undefined): number {
  return read?.kind === 'ok' ? (healthCount(read.snapshot.health) ?? 0) + unmarkedHeld(read.snapshot) : 0;
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
