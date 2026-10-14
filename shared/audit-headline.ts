/**
 * shared/audit-headline.ts
 *
 * "Why is the report's spending different from Wealthfolio's?" (2c R1, spec
 * A2), judged here. Pure — the companion reads the rows and both figures
 * (companion/src/audit-facts.ts).
 *
 * WHAT IS COMPARED. The two SPENT figures:
 *  - the report's: "Spent this month" — the report cube's current month,
 *    categorized plus uncategorized (`monthlySpendTotals`), the Budget tab's
 *    headline number;
 *  - Wealthfolio's: its Spending page's `headline.spent` for this calendar
 *    month in Wealthfolio's timezone (`POST /spending/insight`, the request
 *    the page itself makes for "This month").
 *
 * ONE DEFINITION (1.62, ruling W4). Since 1.62 the report counts spending
 * exactly as Wealthfolio's Spending page does: both read shared/wf-spending.ts
 * — the effective type, the subtype and the account type; a linked transfer
 * never; the earliest spending filing, or split lines; excluded categories and
 * their descendants left out; an uncategorized refund netted; each row placed
 * by its local date in Wealthfolio's timezone. The five reasons 1.61 sized —
 * a row stored at 00:00 UTC on the 1st, the sync's bookkeeping rows, an
 * excluded category, a row filed twice, a refund with no category — were each
 * a rule only one side applied; none can arise now (the agreement matrix in
 * audit-headline.test.ts pins each). Their kinds stay readable, so the app
 * still shows a snapshot an older companion published.
 *
 * A REASON IS A ROW EXACTLY ONE SIDE COUNTS. One remains:
 *   not-covered  −spend  on an account Wealthfolio's Spending page reads that
 *                        the add-on does not map: the cube's accounts are the
 *                        mapped ones
 * Each reason's cents is its share of report − Wealthfolio.
 * unexplainedCents = (report − Wealthfolio) − Σ reasons: what neither rule
 * names — a row written between the cube's build and Wealthfolio's answer, a
 * foreign-currency row (Wealthfolio converts it; the report sums it as
 * stored), or a rule of Wealthfolio's this model misses. The daily report's
 * tripwire (shared/spending-tripwire.ts) says so when it is more than a cent.
 */
import { changeDay, changeMoney } from './change-entries.js';
import { descriptionFromComment } from './sync-core.js';
import { spendLines, type SpendRow } from './wf-spending.js';

/** Moved to ./wf-spending.ts (the one definition); re-exported for its readers. */
export { excludedWithDescendants } from './wf-spending.js';

/** 'spending-off' is not a failed read: Wealthfolio's Spending page is turned
 *  off (or has no accounts), so its figure is a meaningless $0 and is left out. */
export type HeadlineRead = 'report' | 'wealthfolio' | 'spending-off' | 'ledger' | 'settings' | 'mapping';
export const HEADLINE_READ_NOTES: Record<HeadlineRead, string> = {
  report: "Couldn't read the report's figure for this month.",
  wealthfolio: "Couldn't read Wealthfolio's Spending page figure.",
  ledger: "Couldn't read the Wealthfolio database, so the reasons are missing.",
  'spending-off': "Wealthfolio's Spending page is turned off or has no accounts selected, so there's nothing to compare.",
  mapping: "Couldn't read the account mapping, so accounts the add-on doesn't sync aren't named.",
  settings: "Couldn't read Wealthfolio's settings just now, so its excluded categories and the Spending page's accounts aren't taken into account, and the month follows the companion's timezone.",
};
const READ_ORDER: HeadlineRead[] = ['report', 'wealthfolio', 'spending-off', 'ledger', 'settings', 'mapping'];

export const HEADLINE_AGREE = 'The report and Wealthfolio agree this month.';

/** One activity of the month, as companion/src/sqlite-audit.ts reads it:
 *  the row shared/wf-spending.ts counts. */
export type HeadlineDbRow = SpendRow;

export interface HeadlineFacts {
  /** YYYY-MM. */
  month: string;
  /** Wealthfolio's timezone, which places its month; null or absent: the
   *  companion's own, as the Spending page was asked. */
  timezone?: string | null;
  /** The accounts Wealthfolio's Spending page reads: opted in, not archived;
   *  [] when it is off. Absent (unread): every account. */
  spendingAccountIds?: string[];
  /** The accounts the report covers: the mapped ones (the cube drops any
   *  other). Absent (unread): every account. */
  reportAccountIds?: string[];
  /** Wealthfolio's base currency (`base_currency`); absent (unread): no row
   *  is judged foreign. Wealthfolio converts every row to it; the report sums
   *  the amounts as stored. */
  baseCurrency?: string | null;
  /** The report's "Spent this month", cents. */
  reportCents?: number;
  /** Wealthfolio's Spending page `headline.spent`, cents. */
  wealthfolioCents?: number;
  /** The month's activities, every account, read a day wider on each side
   *  (a row's local date can differ from its UTC date by one). */
  rows?: HeadlineDbRow[];
  /** `spending.excluded_category_ids`; [] when unset (Wealthfolio 3.8). */
  excludedCategoryIds?: string[];
  /** Every spending category's parent (null at the top), so an excluded
   *  category's descendants are excluded too. */
  categoryParents?: Record<string, string | null>;
  failed?: HeadlineRead[];
}

/** `not-covered` and `foreign-currency` are the ones a 1.62 companion finds.
 *  The other five are a 1.61 companion's: still read and shown, never found
 *  any more. A reader that does not know a kind folds it into "unexplained"
 *  (audit-snapshot.ts). */
export type HeadlineReasonKind =
  | 'not-covered' | 'foreign-currency'
  | 'first-midnight' | 'bookkeeping' | 'excluded' | 'double-filed' | 'uncategorized-refund';
export const HEADLINE_REASON_KINDS: readonly HeadlineReasonKind[] = [
  'not-covered', 'foreign-currency', 'first-midnight', 'bookkeeping', 'excluded', 'double-filed', 'uncategorized-refund',
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
  /** Wealthfolio's base currency, when it was read (names the
   *  foreign-currency reason). Optional: an older snapshot has none. */
  baseCurrency?: string;
  /** null when either figure or the reasons are unknown. */
  unexplainedCents: number | null;
  notes: string[];
}

export function explainHeadline(facts: HeadlineFacts): HeadlineExplanation {
  const failed = new Set(facts.failed ?? []);
  const notes = READ_ORDER.filter((r) => failed.has(r)).map((r) => HEADLINE_READ_NOTES[r]);
  const reportCents = facts.reportCents ?? null;
  const wealthfolioCents = facts.wealthfolioCents ?? null;
  let reasons: HeadlineReason[] | null = null;
  if (facts.rows) {
    const notCovered: HeadlineReason = { kind: 'not-covered', cents: 0, rows: [] };
    const covered = facts.reportAccountIds ? new Set(facts.reportAccountIds) : null;
    // Both sides are Wealthfolio's Spending page: its accounts, its month.
    const lines = spendLines(facts.rows, {
      timezone: facts.timezone ?? null,
      spendingAccountIds: facts.spendingAccountIds ?? null,
      excludedCategoryIds: facts.excludedCategoryIds ?? [],
      categoryParents: facts.categoryParents ?? {},
    });
    for (const line of lines) {
      if (line.month !== facts.month || !covered || covered.has(line.row.accountId)) continue;
      // Wealthfolio counts it; the report does not cover the account.
      notCovered.cents -= line.cents;
      notCovered.rows.push({ date: line.day, description: descriptionFromComment(line.row.notes), cents: line.cents, account: line.row.accountName });
    }
    // Wealthfolio converts each row to its base currency; the report sums the
    // stored amounts. The conversion is not modelled, so this reason takes
    // whatever difference the other reason leaves (nothing, when the two
    // agree), and names the rows it cannot size.
    const foreign: HeadlineReason = { kind: 'foreign-currency', cents: 0, rows: [] };
    const base = facts.baseCurrency?.trim().toUpperCase() || null;
    if (base) {
      for (const line of lines) {
        const currency = line.row.currency?.trim().toUpperCase();
        if (line.month !== facts.month || !currency || currency === base) continue;
        if (covered && !covered.has(line.row.accountId)) continue;
        foreign.rows.push({ date: line.day, description: descriptionFromComment(line.row.notes), cents: line.cents, account: line.row.accountName });
      }
      if (foreign.rows.length > 0 && reportCents !== null && wealthfolioCents !== null) {
        foreign.cents = reportCents - wealthfolioCents - notCovered.cents;
      }
    }
    reasons = [notCovered, foreign].filter((r) => r.rows.length > 0);
  }
  const unexplainedCents = reportCents !== null && wealthfolioCents !== null && reasons !== null
    ? reportCents - wealthfolioCents - reasons.reduce((s, r) => s + r.cents, 0)
    : null;
  const baseCurrency = facts.baseCurrency?.trim().toUpperCase();
  return { month: facts.month, reportCents, wealthfolioCents, reasons, unexplainedCents, notes, ...(baseCurrency ? { baseCurrency } : {}) };
}

/** True when both figures were read and are the same to the cent. */
export function headlineAgrees(h: HeadlineExplanation): boolean {
  return h.reportCents !== null && h.wealthfolioCents !== null && h.reportCents === h.wealthfolioCents;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ownMonth = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

/** The checked month by name — "October", "December 2026" when not `now`'s
 *  year — or null when it is `now`'s own month (or there is no `now`: a live
 *  check is always this month). A snapshot read after the month turned is
 *  last month's, and says so. */
function otherMonthName(month: string, now?: Date): string | null {
  if (!now || ownMonth(now) === month) return null;
  const [y, m] = month.split('-').map(Number);
  const name = MONTH_NAMES[(m || 1) - 1];
  return y === now.getFullYear() ? name : `${name} ${y}`;
}

/** "The report counts $1,240.18 spent this month; Wealthfolio's Spending page
 *  counts $1,301.40." — "spent in October" for a month that is not `now`'s. Raw. */
export function headlineSummaryLine(h: HeadlineExplanation, now?: Date): string | null {
  const other = otherMonthName(h.month, now);
  const when = other ? `in ${other}` : 'this month';
  const report = h.reportCents === null ? null : changeMoney(h.reportCents);
  const wf = h.wealthfolioCents === null ? null : changeMoney(h.wealthfolioCents);
  if (report && wf) return `The report counts ${report} spent ${when}; Wealthfolio's Spending page counts ${wf}.`;
  if (report) return `The report counts ${report} spent ${when}.`;
  if (wf) return `Wealthfolio's Spending page counts ${wf} spent ${when}.`;
  return null;
}

/** HEADLINE_AGREE, or "The report and Wealthfolio agree on October." for a
 *  month that is not `now`'s. Raw. */
export function headlineAgreeLine(h: HeadlineExplanation, now?: Date): string {
  const other = otherMonthName(h.month, now);
  return other ? `The report and Wealthfolio agree on ${other}.` : HEADLINE_AGREE;
}

export const HEADLINE_REASON_LABELS: Record<HeadlineReasonKind, string> = {
  'not-covered': "On accounts the add-on doesn't sync",
  'foreign-currency': 'Amounts in another currency',
  'first-midnight': 'Dated the 1st at midnight UTC',
  bookkeeping: "The add-on's own bookkeeping rows",
  excluded: 'In categories Wealthfolio excludes',
  'double-filed': 'Filed under two categories',
  'uncategorized-refund': 'Refunds with no category',
};
const REASON_WHY: Record<HeadlineReasonKind, (baseCurrency?: string) => string> = {
  'not-covered': () => "Wealthfolio's Spending page reads them; the report covers only the accounts the add-on syncs",
  'foreign-currency': (base) => `Wealthfolio converts them to ${base || 'its base currency'}; the report doesn't`,
  'first-midnight': () => "Wealthfolio's month starts later west of UTC, so it counts these last month",
  bookkeeping: () => "Wealthfolio counts them; the report doesn't",
  excluded: () => "Wealthfolio leaves these out; the report doesn't",
  'double-filed': () => 'the report counts them twice',
  'uncategorized-refund': () => "Wealthfolio subtracts them; the report doesn't",
};

const signFor = (h: HeadlineExplanation) =>
  (h.reportCents !== null && h.wealthfolioCents !== null && h.reportCents < h.wealthfolioCents ? -1 : 1);

/** "$12.00 — Dated the 1st at midnight UTC: Wealthfolio's month … (2 rows)". Raw. */
export function headlineReasonLine(h: HeadlineExplanation, r: HeadlineReason): string {
  const n = r.rows.length + (r.more ?? 0);
  return `${changeMoney(signFor(h) * r.cents)} — ${HEADLINE_REASON_LABELS[r.kind]}: ${REASON_WHY[r.kind](h.baseCurrency)} (${n} ${n === 1 ? 'row' : 'rows'})`;
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
