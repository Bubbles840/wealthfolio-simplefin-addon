/**
 * shared/audit-snapshot.ts
 *
 * The `audit_snapshot` secret (2c R1, spec B2): the three checks as the
 * companion last ran them, for the app, which has no database and cannot run
 * them itself. The companion is its ONLY writer — after each sync,
 * best-effort; a failed publish keeps the previous snapshot. The app reads it
 * corrupt-aware: ok, absent or corrupt, never "empty" for a snapshot it
 * could not read.
 *
 * Size. No limit on an add-on secret is known: Wealthfolio's secrets routes
 * (apps/server/src/api/secrets.rs, v3.8.0) check none and the server sets no
 * body limit, leaving axum's default 2 MB request body as the only ceiling.
 * Like the report cube (REPORT_CUBE_MAX_BYTES = 200_000, kept by trimming
 * history), this keeps itself small on purpose: AUDIT_SNAPSHOT_MAX_BYTES of
 * UTF-8, kept by trimming row lists first — each reason's rows, then
 * Health's issues — and saying how many were left out (`more`).
 */
import type { BalanceExplanation, BalanceReport } from './audit-balance.js';
import { HEADLINE_REASON_KINDS, type HeadlineExplanation } from './audit-headline.js';
import type { HealthReport } from './audit-health.js';

export const AUDIT_SNAPSHOT_SECRET_KEY = 'audit_snapshot';
export const AUDIT_SNAPSHOT_MAX_BYTES = 100_000;
/** Older than this, the app says the companion has not synced since. */
export const AUDIT_STALE_MS = 2 * 86_400_000;

export const AUDIT_CORRUPT = "Couldn't read the checks — run /audit in Telegram.";
export const AUDIT_NEEDS_COMPANION = 'These checks need the companion.';
export const AUDIT_NOT_YET = "These checks arrive with the companion's next sync.";

export interface AuditSnapshot {
  v: 1;
  /** ISO: when the companion ran the checks. */
  at: string;
  /** By Wealthfolio account id, in mapping order. */
  balances: Record<string, BalanceExplanation>;
  balanceNotes: string[];
  headline: HeadlineExplanation;
  health: HealthReport;
}

/** What one run of the three checks produced. */
export interface AuditResults {
  balances: BalanceReport;
  headline: HeadlineExplanation;
  health: HealthReport;
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** [rows per reason, Health issues], tried in order until the snapshot fits. */
const CAPS: ReadonlyArray<readonly [number, number]> = [
  [Infinity, Infinity], [50, 200], [20, 100], [10, 50], [5, 20], [2, 10], [0, 5], [0, 0],
];

function trimHeadline(h: HeadlineExplanation, cap: number): HeadlineExplanation {
  if (!h.reasons) return h;
  return {
    ...h,
    reasons: h.reasons.map((r) => (r.rows.length <= cap ? r : { ...r, rows: r.rows.slice(0, cap), more: (r.more ?? 0) + r.rows.length - cap })),
  };
}

function trimHealth(h: HealthReport, cap: number): HealthReport {
  if (!h.issues || h.issues.length <= cap) return h;
  return { ...h, issues: h.issues.slice(0, cap), more: (h.more ?? 0) + h.issues.length - cap };
}

const NOTE_CAP = 3;
const capNotes = (notes: string[]): string[] =>
  notes.length <= NOTE_CAP ? notes : [...notes.slice(0, NOTE_CAP), `and ${notes.length - NOTE_CAP} more`];

/** The snapshot for one run, trimmed until it fits AUDIT_SNAPSHOT_MAX_BYTES:
 *  rows first, then the notes lists. Null when it still does not fit — the
 *  caller keeps the previous snapshot rather than publish an oversize one. */
export function buildAuditSnapshot(results: AuditResults, now: Date): AuditSnapshot | null {
  const balances: Record<string, BalanceExplanation> = {};
  for (const a of results.balances.accounts) balances[a.wfAccountId] = a;
  const fits = (s: AuditSnapshot) => utf8Bytes(JSON.stringify(s)) <= AUDIT_SNAPSHOT_MAX_BYTES;
  const make = (rowCap: number, issueCap: number, capNote: boolean): AuditSnapshot => {
    const headline = trimHeadline(results.headline, rowCap);
    const health = trimHealth(results.health, issueCap);
    return {
      v: 1, at: now.toISOString(), balances,
      balanceNotes: capNote ? capNotes(results.balances.notes) : results.balances.notes,
      headline: capNote ? { ...headline, notes: capNotes(headline.notes) } : headline,
      health: capNote ? { ...health, notes: capNotes(health.notes) } : health,
    };
  };
  for (const [rowCap, issueCap] of CAPS) {
    const snapshot = make(rowCap, issueCap, false);
    if (fits(snapshot)) return snapshot;
  }
  const last = CAPS[CAPS.length - 1];
  const capped = make(last[0], last[1], true);
  return fits(capped) ? capped : null;
}

export type AuditSnapshotRead =
  | { kind: 'ok'; snapshot: AuditSnapshot }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

const isObject = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const nullOrArray = (x: unknown) => x === null || Array.isArray(x);
const isNum = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
/** A date the views print (changeDay): a string starting YYYY-MM-DD. */
const isDay = (x: unknown) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x);
const REASON_KINDS = new Set<string>(HEADLINE_REASON_KINDS);

function goodBank(b: unknown): boolean {
  if (!isObject(b)) return false;
  if (b.kind === 'none' || b.kind === 'unread') return true;
  return b.kind === 'ok' && isNum(b.cents) && (b.date === null || isDay(b.date));
}

function goodIncludes(inc: unknown): boolean {
  if (inc === null || inc === undefined) return true;
  if (!isObject(inc)) return false;
  const start = inc.start;
  const fixes = inc.corrections;
  if (start != null && !(isObject(start) && isNum(start.cents) && isDay(start.date))) return false;
  return fixes == null || (isObject(fixes) && isNum(fixes.count) && isNum(fixes.cents) && isDay(fixes.latest));
}

/** The stored secret: absent when there is none, corrupt when it is not a
 *  snapshot this version can read — every field the app's views read, dates
 *  and kinds included — else the snapshot. */
export function parseAuditSnapshot(raw: string | null | undefined): AuditSnapshotRead {
  if (raw === null || raw === undefined || raw === '') return { kind: 'absent' };
  const corrupt = { kind: 'corrupt' } as const;
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return corrupt;
  }
  if (!isObject(v) || v.v !== 1 || typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at))) return corrupt;
  if (!isObject(v.balances) || !Array.isArray(v.balanceNotes)) return corrupt;
  for (const [key, e] of Object.entries(v.balances)) {
    if (!isObject(e) || typeof e.wfAccountId !== 'string' || e.wfAccountId !== key || typeof e.name !== 'string' || !goodBank(e.bank)) return corrupt;
    if (!goodIncludes(e.includes)) return corrupt;
    if (e.offCents != null && !isNum(e.offCents)) return corrupt;
    if (e.causes != null && !Array.isArray(e.causes)) return corrupt;
    for (const c of e.causes ?? []) if (!isObject(c) || typeof c.kind !== 'string' || !isNum(c.cents)) return corrupt;
  }
  const h = v.headline;
  if (!isObject(h) || typeof h.month !== 'string' || !nullOrArray(h.reasons) || !Array.isArray(h.notes)) return corrupt;
  for (const r of h.reasons ?? []) {
    if (!isObject(r) || !REASON_KINDS.has(r.kind) || !isNum(r.cents) || !Array.isArray(r.rows)) return corrupt;
    for (const row of r.rows) if (!isObject(row) || !isNum(row.cents) || !isDay(row.date)) return corrupt;
  }
  const health = v.health;
  if (!isObject(health) || !nullOrArray(health.issues) || !Array.isArray(health.notes)) return corrupt;
  const goodLeg = (l: unknown) => isObject(l) && typeof l.activityId === 'string' && typeof l.accountId === 'string' && isNum(l.absCents) && isDay(l.date);
  for (const i of health.issues ?? []) {
    if (!isObject(i) || typeof i.kind !== 'string' || typeof i.key !== 'string') return corrupt;
    if (i.kind === 'incomplete-leg') {
      if (!goodLeg(i.leg) || (i.counterpart != null && !goodLeg(i.counterpart))) return corrupt;
    } else if (i.kind === 'phantom-cash') {
      if (!isNum(i.rows) || !Array.isArray(i.accounts)) return corrupt;
    } else if (i.kind === 'late-start') {
      if (typeof i.activityId !== 'string' || typeof i.accountId !== 'string' || !isNum(i.cents) || !isDay(i.date) || !isDay(i.earliest)) return corrupt;
    } else return corrupt;
  }
  return { kind: 'ok', snapshot: v as AuditSnapshot };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const localDay = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const localClock = (d: Date) => {
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Where the app's checks came from, in one line, in the viewer's own zone. */
export function auditSnapshotStatus(
  read: AuditSnapshotRead, companionVersion: string | null, now: Date,
): { state: 'fresh' | 'stale' | 'absent' | 'corrupt'; line: string } {
  if (read.kind === 'corrupt') return { state: 'corrupt', line: AUDIT_CORRUPT };
  if (read.kind === 'absent') return { state: 'absent', line: companionVersion ? AUDIT_NOT_YET : AUDIT_NEEDS_COMPANION };
  const at = new Date(read.snapshot.at);
  if (now.getTime() - at.getTime() > AUDIT_STALE_MS) {
    return { state: 'stale', line: `These checks are from ${localDay(at)} — the companion hasn't synced since.` };
  }
  const sameDay = at.toDateString() === now.toDateString();
  return { state: 'fresh', line: `As of the ${sameDay ? '' : `${localDay(at)}, `}${localClock(at)} sync.` };
}
