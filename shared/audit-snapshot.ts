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
import type { HeadlineExplanation } from './audit-headline.js';
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

/** The snapshot for one run, trimmed until it fits AUDIT_SNAPSHOT_MAX_BYTES. */
export function buildAuditSnapshot(results: AuditResults, now: Date): AuditSnapshot {
  const balances: Record<string, BalanceExplanation> = {};
  for (const a of results.balances.accounts) balances[a.wfAccountId] = a;
  let snapshot: AuditSnapshot | null = null;
  for (const [rowCap, issueCap] of CAPS) {
    snapshot = {
      v: 1, at: now.toISOString(), balances, balanceNotes: results.balances.notes,
      headline: trimHeadline(results.headline, rowCap), health: trimHealth(results.health, issueCap),
    };
    if (utf8Bytes(JSON.stringify(snapshot)) <= AUDIT_SNAPSHOT_MAX_BYTES) break;
  }
  return snapshot!;
}

export type AuditSnapshotRead =
  | { kind: 'ok'; snapshot: AuditSnapshot }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

const isObject = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const nullOrArray = (x: unknown) => x === null || Array.isArray(x);

/** The stored secret: absent when there is none, corrupt when it is not a
 *  snapshot this version can read, else the snapshot. */
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
  for (const e of Object.values(v.balances)) {
    if (!isObject(e) || typeof e.wfAccountId !== 'string' || typeof e.name !== 'string' || !isObject(e.bank) || !nullOrArray(e.causes)) return corrupt;
  }
  const h = v.headline;
  if (!isObject(h) || typeof h.month !== 'string' || !nullOrArray(h.reasons) || !Array.isArray(h.notes)) return corrupt;
  for (const r of h.reasons ?? []) {
    if (!isObject(r) || typeof r.kind !== 'string' || typeof r.cents !== 'number' || !Array.isArray(r.rows)) return corrupt;
  }
  const health = v.health;
  if (!isObject(health) || !nullOrArray(health.issues) || !Array.isArray(health.notes)) return corrupt;
  for (const i of health.issues ?? []) {
    if (!isObject(i) || typeof i.kind !== 'string' || typeof i.key !== 'string') return corrupt;
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
