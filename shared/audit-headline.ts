/**
 * shared/audit-headline.ts
 *
 * "Why is the report's spending different from Wealthfolio's?" (2c R1, spec
 * A2): companion/tools/audit-headline.mjs, judged here. Pure — the companion
 * reads the rows and both figures (companion/src/audit-facts.ts).
 *
 * WHAT IS COMPARED. The script itself compares no two figures: it sizes six
 * differences in what each side counts as spending and leaves a person to
 * match them against the gap between the daily report's "$X left this month"
 * and Wealthfolio's budget card. Both "left" figures are `plan − spent`, so
 * they differ exactly where the spent figures do. This check compares the two
 * SPENT figures:
 *  - the report's: "Spent this month" — the report cube's current month,
 *    categorized plus uncategorized (`monthlySpendTotals`), the Budget tab's
 *    headline number;
 *  - Wealthfolio's: its Spending page's `headline.spent` for this calendar
 *    month in Wealthfolio's timezone (`POST /spending/insight`, the request
 *    the page itself makes for "This month").
 *
 * Each reason's cents is its share of report − Wealthfolio, from the row's
 * spend in the report's own sign (SPENDING_SIGN, companion/src/
 * sqlite-native.ts; positive spends, negative refunds):
 *   first-midnight        +spend  stored at 00:00 UTC on the 1st: Wealthfolio, west of UTC, counts it last month
 *   future                +spend  dated after today: the report counts the whole month, Wealthfolio stops at today
 *   bookkeeping           −spend  the sync's own rows: Wealthfolio counts them, the report excludes them
 *   excluded              +spend  filed under a category Wealthfolio excludes from spending
 *   double-filed          +spend × (filings − 1)  the report counts every spending filing
 *   uncategorized-refund  −spend  a refund with no category: Wealthfolio nets it, the report ignores it
 * unexplainedCents = (report − Wealthfolio) − Σ reasons.
 *
 * Across Wealthfolio versions (3.8 to 3.10):
 *  - first-midnight: a date-only row is stored at UTC midnight on 3.8, and
 *    still is when the sync imports it; from 3.10 one entered in Wealthfolio
 *    west of UTC is stored at its LOCAL midnight (`2026-10-01T04:00:00+00:00`
 *    for New York), which both sides put in the same month. So only a row
 *    stored at exactly 00:00 UTC counts, whatever the rest of the ledger is.
 *  - excluded: `spending.excluded_category_ids` arrived in 3.9, where the
 *    Spending page drops a row whose spending allocation — its earliest
 *    spending filing — lands on an excluded category OR ANY DESCENDANT
 *    (crates/spending/src/category_exclusions.rs). With no setting (3.8)
 *    nothing is excluded and the reason is empty. Split lines, which the
 *    add-on never writes, are not modelled: their difference stays in the
 *    remainder.
 */
import { changeDay, changeMoney } from './change-entries.js';
import { descriptionFromComment } from './sync-core.js';
import { isCorrectionNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';

export type HeadlineRead = 'report' | 'wealthfolio' | 'ledger' | 'settings';
export const HEADLINE_READ_NOTES: Record<HeadlineRead, string> = {
  report: "Couldn't read the report's figure for this month.",
  wealthfolio: "Couldn't read Wealthfolio's Spending page figure.",
  ledger: "Couldn't read the Wealthfolio database, so the reasons are missing.",
  settings: "Couldn't read Wealthfolio's settings, so excluded categories aren't checked.",
};
const READ_ORDER: HeadlineRead[] = ['report', 'wealthfolio', 'ledger', 'settings'];

export const HEADLINE_AGREE = 'The report and Wealthfolio agree this month.';

/** One activity of the month, as companion/src/sqlite-audit.ts reads it. */
export interface HeadlineDbRow {
  id: string;
  /** `activity_date` as stored, e.g. `2026-10-01T00:00:00+00:00`. */
  date: string;
  accountName: string;
  /** Upper-case. */
  accountType: string;
  /** `activity_type`, upper-case. */
  type: string;
  /** Upper-case; '' when none. */
  subtype: string;
  absCents: number;
  notes: string;
  /** How many SPENDING categories it is filed under. */
  spendingFilings: number;
  /** Every category it is filed under, any taxonomy. */
  categoryIds: string[];
  /** Its earliest spending filing (by `created_at`, then id) — the one
   *  Wealthfolio allocates its spend to; absent or null when there is none. */
  spendingCategoryId?: string | null;
}

export interface HeadlineFacts {
  /** YYYY-MM. */
  month: string;
  /** YYYY-MM-DD, the companion's day (the script's TODAY). */
  today: string;
  /** The report's "Spent this month", cents. */
  reportCents?: number;
  /** Wealthfolio's Spending page `headline.spent`, cents. */
  wealthfolioCents?: number;
  /** The month's activities, every account. */
  rows?: HeadlineDbRow[];
  /** `spending.excluded_category_ids`; [] when unset (Wealthfolio 3.8). */
  excludedCategoryIds?: string[];
  /** Every spending category's parent (null at the top), so an excluded
   *  category's descendants are excluded too. */
  categoryParents?: Record<string, string | null>;
  failed?: HeadlineRead[];
}

export type HeadlineReasonKind =
  | 'first-midnight' | 'future' | 'bookkeeping' | 'excluded' | 'double-filed' | 'uncategorized-refund';
export const HEADLINE_REASON_KINDS: readonly HeadlineReasonKind[] = [
  'first-midnight', 'future', 'bookkeeping', 'excluded', 'double-filed', 'uncategorized-refund',
];

/** One row behind a reason. Raw text. */
export interface HeadlineRow {
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  /** The row's spend in the report's sign: positive spends, negative refunds. */
  cents: number;
  account: string;
}

export interface HeadlineReason {
  kind: HeadlineReasonKind;
  /** Its share of report − Wealthfolio. */
  cents: number;
  rows: HeadlineRow[];
  /** Rows left out to fit the snapshot (audit-snapshot.ts). */
  more?: number;
}

export interface HeadlineExplanation {
  month: string;
  reportCents: number | null;
  wealthfolioCents: number | null;
  /** null: the database could not be read. Reasons with no rows are left out. */
  reasons: HeadlineReason[] | null;
  /** null when either figure or the reasons are unknown. */
  unexplainedCents: number | null;
  notes: string[];
}

const CARD_SPEND = new Set(['WITHDRAWAL', 'FEE', 'INTEREST']);
const CASH_SPEND = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX']);
const REFUND_SUBTYPES = new Set(['REFUND', 'REBATE', 'REIMBURSEMENT']);

/** The report's spending sign — kept in step with `SPENDING_SIGN` in
 *  companion/src/sqlite-native.ts, which transcribes Wealthfolio's classifier. */
export function reportSpendSign(r: Pick<HeadlineDbRow, 'accountType' | 'type' | 'subtype'>): -1 | 0 | 1 {
  if (r.accountType === 'CREDIT_CARD') return CARD_SPEND.has(r.type) ? 1 : r.type === 'CREDIT' ? -1 : 0;
  if (r.accountType === 'CASH') {
    if (CASH_SPEND.has(r.type)) return 1;
    return r.type === 'CREDIT' && REFUND_SUBTYPES.has(r.subtype) ? -1 : 0;
  }
  return 0;
}

const isBookkeeping = (notes: string) => isStartingBalanceNote(notes) || isCorrectionNote(notes) || isPlaceholderNote(notes);

/** Stored at exactly 00:00 UTC — the only midnight both sides read differently. */
const atUtcMidnight = (date: string) => /T00:00:00(?:\.0+)?(?:Z|\+00:00)?$/.test(date);

/**
 * The excluded categories and every descendant, as Wealthfolio's
 * ExclusionIndex builds them: the raw ids are kept even when the category no
 * longer exists, and the walk up each parent chain is bounded (32 steps), so
 * a cyclic taxonomy cannot hang it.
 */
export function excludedWithDescendants(raw: readonly string[], parents: Readonly<Record<string, string | null>>): Set<string> {
  const excluded = new Set(raw);
  if (excluded.size === 0) return excluded;
  const roots = new Set(raw);
  for (const id of Object.keys(parents)) {
    if (roots.has(id)) continue;
    const seen = new Set([id]);
    let current = id;
    for (let depth = 0; depth < 32; depth++) {
      const parent = parents[current];
      if (!parent || seen.has(parent)) break;
      if (roots.has(parent)) {
        excluded.add(id);
        break;
      }
      seen.add(parent);
      current = parent;
    }
  }
  return excluded;
}

export function explainHeadline(facts: HeadlineFacts): HeadlineExplanation {
  const failed = new Set(facts.failed ?? []);
  const notes = READ_ORDER.filter((r) => failed.has(r)).map((r) => HEADLINE_READ_NOTES[r]);
  const reportCents = facts.reportCents ?? null;
  const wealthfolioCents = facts.wealthfolioCents ?? null;
  let reasons: HeadlineReason[] | null = null;
  if (facts.rows) {
    const byKind = new Map<HeadlineReasonKind, HeadlineReason>(HEADLINE_REASON_KINDS.map((kind) => [kind, { kind, cents: 0, rows: [] }]));
    const add = (kind: HeadlineReasonKind, cents: number, row: HeadlineRow) => {
      const r = byKind.get(kind)!;
      r.cents += cents;
      r.rows.push(row);
    };
    const firstAtMidnight = `${facts.month}-01T`;
    const thisMonth = facts.today.slice(0, 7) === facts.month;
    const excluded = facts.excludedCategoryIds ? excludedWithDescendants(facts.excludedCategoryIds, facts.categoryParents ?? {}) : null;
    for (const r of facts.rows) {
      const spend = reportSpendSign(r) * r.absCents;
      if (spend === 0) continue;
      const row: HeadlineRow = { date: r.date.slice(0, 10), description: descriptionFromComment(r.notes), cents: spend, account: r.accountName };
      if (isBookkeeping(r.notes)) {
        add('bookkeeping', -spend, row);
        continue;
      }
      if (r.date.startsWith(firstAtMidnight) && atUtcMidnight(r.date)) add('first-midnight', spend, row);
      if (thisMonth && row.date > facts.today) add('future', spend, row);
      if (excluded && r.spendingCategoryId && excluded.has(r.spendingCategoryId)) add('excluded', spend, row);
      if (r.spendingFilings > 1) add('double-filed', spend * (r.spendingFilings - 1), row);
      if (spend < 0 && r.categoryIds.length === 0) add('uncategorized-refund', -spend, row);
    }
    reasons = HEADLINE_REASON_KINDS.map((k) => byKind.get(k)!).filter((r) => r.rows.length > 0);
  }
  const unexplainedCents = reportCents !== null && wealthfolioCents !== null && reasons !== null
    ? reportCents - wealthfolioCents - reasons.reduce((s, r) => s + r.cents, 0)
    : null;
  return { month: facts.month, reportCents, wealthfolioCents, reasons, unexplainedCents, notes };
}

/** True when both figures were read and are the same to the cent. */
export function headlineAgrees(h: HeadlineExplanation): boolean {
  return h.reportCents !== null && h.wealthfolioCents !== null && h.reportCents === h.wealthfolioCents;
}

/** "The report counts $1,240.18 spent this month; Wealthfolio's Spending page counts $1,301.40." Raw. */
export function headlineSummaryLine(h: HeadlineExplanation): string | null {
  const report = h.reportCents === null ? null : changeMoney(h.reportCents);
  const wf = h.wealthfolioCents === null ? null : changeMoney(h.wealthfolioCents);
  if (report && wf) return `The report counts ${report} spent this month; Wealthfolio's Spending page counts ${wf}.`;
  if (report) return `The report counts ${report} spent this month.`;
  if (wf) return `Wealthfolio's Spending page counts ${wf} spent this month.`;
  return null;
}

export const HEADLINE_REASON_LABELS: Record<HeadlineReasonKind, string> = {
  'first-midnight': 'Dated the 1st at midnight UTC',
  future: 'Dated after today',
  bookkeeping: "The add-on's own bookkeeping rows",
  excluded: 'In categories Wealthfolio excludes',
  'double-filed': 'Filed under two categories',
  'uncategorized-refund': 'Refunds with no category',
};
const REASON_WHY: Record<HeadlineReasonKind, string> = {
  'first-midnight': "Wealthfolio's month starts later west of UTC, so it counts these last month",
  future: 'the report counts the whole month; Wealthfolio stops at today',
  bookkeeping: "Wealthfolio counts them; the report doesn't",
  excluded: "Wealthfolio leaves these out; the report doesn't",
  'double-filed': 'the report counts them twice',
  'uncategorized-refund': "Wealthfolio subtracts them; the report doesn't",
};

const signFor = (h: HeadlineExplanation) =>
  (h.reportCents !== null && h.wealthfolioCents !== null && h.reportCents < h.wealthfolioCents ? -1 : 1);

/** "$12.00 — Dated the 1st at midnight UTC: Wealthfolio's month … (2 rows)". Raw. */
export function headlineReasonLine(h: HeadlineExplanation, r: HeadlineReason): string {
  const n = r.rows.length + (r.more ?? 0);
  return `${changeMoney(signFor(h) * r.cents)} — ${HEADLINE_REASON_LABELS[r.kind]}: ${REASON_WHY[r.kind]} (${n} ${n === 1 ? 'row' : 'rows'})`;
}

/** "$3.20 not explained by these reasons", or null. Raw. */
export function headlineUnexplainedLine(h: HeadlineExplanation): string | null {
  if (!h.unexplainedCents) return null;
  return `${changeMoney(signFor(h) * h.unexplainedCents)} not explained by these reasons`;
}

/** "Oct 1 · KROGER #415 · $54.20 · PNC Checking". Raw. */
export function headlineRowLine(r: HeadlineRow): string {
  return `${changeDay(r.date)} · ${r.description || 'A transaction'} · ${changeMoney(r.cents)} · ${r.account}`;
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time occurs in `timeZone` (two passes, for a DST change). */
function zonedInstant(y: number, m0: number, d: number, h: number, min: number, s: number, ms: number, timeZone: string): number {
  const wall = Date.UTC(y, m0, d, h, min, s, ms);
  const first = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(first, timeZone);
}

/**
 * A calendar month in `timeZone`, as the RFC 3339 bounds Wealthfolio's
 * Spending page sends for "This month": the 1st at 00:00 to the last day at
 * 23:59:59.999. Null, or a zone the runtime does not know, uses the
 * process's own zone.
 */
export function zonedMonthBounds(month: string, timeZone: string | null): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (timeZone) {
    try {
      return {
        start: new Date(zonedInstant(y, m - 1, 1, 0, 0, 0, 0, timeZone)).toISOString(),
        end: new Date(zonedInstant(y, m - 1, lastDay, 23, 59, 59, 999, timeZone)).toISOString(),
      };
    } catch {
      /* an unknown zone: the process's own, below */
    }
  }
  return { start: new Date(y, m - 1, 1).toISOString(), end: new Date(y, m - 1, lastDay, 23, 59, 59, 999).toISOString() };
}
