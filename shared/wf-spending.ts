/**
 * shared/wf-spending.ts
 *
 * What counts as spending — ONE definition, Wealthfolio's (1.62, ruling W4).
 * The report (the cube, the digest, the weekly and pool figures, budget vs
 * actual, the forecast, suggested budgets) and the audit's model of
 * Wealthfolio's Spending page both read it from here, so the two cannot drift.
 *
 * Transcribed from upstream crates/spending (3.10's reading; 3.8 and 3.9
 * differ in two ways: they treat a blank type override as a type, and they
 * have no excluded categories before 3.9):
 *  - insight/service.rs `compute`: the accounts its Spending page reads
 *    (`spending.account_ids`, not archived, CASH or CREDIT_CARD), every row in
 *    the window `activity_date >= start && <= end` — the calendar month in
 *    Wealthfolio's timezone, so a row is placed by its LOCAL date;
 *  - activity_classification.rs `classify_activity_for_aggregation`: by the
 *    EFFECTIVE type (a non-blank `activity_type_override` wins), the subtype
 *    and the account type. A linked TRANSFER_IN/OUT (one with a group) is
 *    never spending: an internal transfer, or a saving when it crosses out of
 *    the spending accounts. An unlinked one falls through to the classifier,
 *    where a cash TRANSFER_OUT is an expense;
 *  - activity_allocations.rs `allocations_for_taxonomy`: split lines win when
 *    there are any; otherwise the whole amount goes to the EARLIEST spending
 *    filing (by `created_at`, then id) — a row filed twice counts once;
 *  - category_exclusions.rs `split_spending_allocations`: an allocation on an
 *    excluded category or any descendant leaves spending; a row with no
 *    allocation at all is Uncategorized and is never excluded — a refund
 *    included, which nets against Uncategorized.
 * Amounts are taken as stored, in the row's own currency: Wealthfolio converts
 * a foreign-currency row to the base currency, which this does not model.
 */

export const SPENDING_TAXONOMY = 'spending_categories';

/** One spending-taxonomy filing (`activity_taxonomy_assignments`). */
export interface SpendFiling {
  /** The assignment's id: the tie-break after `createdAt`. */
  id: string;
  categoryId: string;
  /** `created_at` as stored. */
  createdAt: string;
  /** `source` ('manual', 'rule', …); '' when unrecorded. */
  source: string;
}

/** One spending-taxonomy split line (`spending_activity_splits`). */
export interface SpendSplit {
  categoryId: string;
  /** The line's amount, positive, in cents. */
  absCents: number;
}

/** One activity, as the readers hand it over. */
export interface SpendRow {
  id: string;
  /** `activity_date` as stored, e.g. `2026-10-01T12:00:00+00:00`. */
  date: string;
  accountId: string;
  accountName: string;
  /** Upper-case. */
  accountType: string;
  /** `activity_type`, upper-case. */
  type: string;
  /** `activity_type_override` as stored; '' or absent when none. */
  typeOverride?: string;
  /** Upper-case; '' when none. */
  subtype: string;
  /** `source_group_id`; '' when none: a linked transfer's group. */
  groupId: string;
  absCents: number;
  /** `currency` as stored, upper-case; '' or absent when unrecorded. */
  currency?: string;
  /** The stored note, raw. */
  notes: string;
  /** Every spending-taxonomy filing. */
  filings: SpendFiling[];
  /** Every spending-taxonomy split line. */
  splits: SpendSplit[];
}

/** Wealthfolio's Spending settings, as its page applies them. */
export interface SpendScope {
  /** Wealthfolio's timezone; null: the process's own. */
  timezone: string | null;
  /** The accounts the Spending page reads; null when unread: every account. */
  spendingAccountIds: readonly string[] | null;
  /** `spending.excluded_category_ids`; [] when unset (3.8). */
  excludedCategoryIds: readonly string[];
  /** Every spending category's parent (null at the top). */
  categoryParents: Readonly<Record<string, string | null>>;
}

/** The type Wealthfolio computes with: the override when it is not blank. */
export function effectiveType(r: Pick<SpendRow, 'type' | 'typeOverride'>): string {
  const override = (r.typeOverride ?? '').trim();
  return (override || r.type).toUpperCase();
}

const CASH_EXPENSE = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX']);
const CARD_EXPENSE = new Set(['WITHDRAWAL', 'FEE', 'INTEREST']);
const REFUND_SUBTYPES = new Set(['REFUND', 'REBATE', 'REIMBURSEMENT']);
const TRANSFER_TYPES = new Set(['TRANSFER_IN', 'TRANSFER_OUT']);

/** `+1` an expense, `-1` money back against spending, `0` not spending. */
export function wfSpendSign(r: Pick<SpendRow, 'accountType' | 'type' | 'typeOverride' | 'subtype' | 'groupId'>): -1 | 0 | 1 {
  const t = effectiveType(r);
  if (TRANSFER_TYPES.has(t) && r.groupId !== '') return 0;
  const account = r.accountType.toUpperCase();
  if (account === 'CASH') {
    if (CASH_EXPENSE.has(t)) return 1;
    return t === 'CREDIT' && REFUND_SUBTYPES.has(r.subtype.toUpperCase()) ? -1 : 0;
  }
  if (account === 'CREDIT_CARD') {
    if (CARD_EXPENSE.has(t)) return 1;
    return t === 'CREDIT' ? -1 : 0;
  }
  return 0;
}

/** Whether Wealthfolio puts the row in the spending bucket at all — the only
 *  rows a spending category can be filed on. */
export function isSpendingBucket(r: Pick<SpendRow, 'accountType' | 'type' | 'typeOverride' | 'subtype' | 'groupId'>): boolean {
  return wfSpendSign(r) !== 0;
}

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

/** A category's top-level ancestor, as Wealthfolio rolls spending up
 *  (`top_category_id`: bounded at 32 steps, stops at a cycle or a parent it
 *  does not know). */
export function topCategoryId(categoryId: string, parents: Readonly<Record<string, string | null>>): string {
  let current = categoryId;
  const seen = new Set([current]);
  for (let depth = 0; depth < 32; depth++) {
    if (!(current in parents)) break;
    const parent = parents[current];
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    current = parent;
  }
  return current;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A stored date as an instant. A timestamp with no offset
 *  (`YYYY-MM-DD HH:MM:SS[.f]` or `YYYY-MM-DDTHH:MM:SS[.f]`, a legacy row) is
 *  read as UTC, never in the process's zone, which `Date.parse` would use.
 *  Upstream's `parse_db_datetime` (model.rs:27-41, :438-444 at v3.10.0)
 *  accepts only the space form and falls back to "now" for the `T` form; we
 *  deliberately read both as UTC, the honest instant for either. NaN when it
 *  cannot be read. */
export function storedInstant(stored: string): number {
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(stored.trim());
  return Date.parse(naive ? `${naive[1]}T${naive[2]}${naive[3] ?? ''}Z` : stored);
}

/** One formatter per zone: building one is the slow part of `localDay`. A
 *  zone the runtime does not know is cached as null. */
const dayFormatters = new Map<string, Intl.DateTimeFormat | null>();
function dayFormatter(timeZone: string): Intl.DateTimeFormat | null {
  let f = dayFormatters.get(timeZone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      f = null; // an unknown zone: the process's own
    }
    dayFormatters.set(timeZone, f);
  }
  return f;
}

/** The calendar day a stored instant falls on in `timeZone` — Wealthfolio's
 *  local date. Null or a zone the runtime does not know: the process's own.
 *  A bare `YYYY-MM-DD` is the UTC midnight 3.8 stores it at; a timestamp with
 *  no offset is UTC (`storedInstant`). Null when the date cannot be read. */
export function localDay(stored: string, timeZone: string | null): string | null {
  const at = storedInstant(stored);
  if (Number.isNaN(at)) return null;
  const formatter = timeZone ? dayFormatter(timeZone) : null;
  if (formatter) {
    const p = Object.fromEntries(formatter.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One allocation of a row's spend to a category it counts under. */
export interface SpendAllocation {
  /** The category the money lands on (a split's or the filing's — the leaf). */
  categoryId: string;
  /** Signed cents: positive spend, negative money back. */
  cents: number;
  /** The filing's source; '' for a split line. */
  source: string;
}

/** One row as Wealthfolio's Spending page counts it. */
export interface SpendLine {
  row: SpendRow;
  /** Wealthfolio's local day, YYYY-MM-DD. */
  day: string;
  /** YYYY-MM. */
  month: string;
  /** What the row adds to the month's spent figure: its spend less any
   *  excluded allocation. Signed. */
  cents: number;
  /** Its allocations to categories that are not excluded. */
  allocations: SpendAllocation[];
  /** Its spend when it has no spending allocation at all (Uncategorized,
   *  refunds negative); 0 otherwise. */
  uncategorizedCents: number;
}

/** The row's spending line, or null when Wealthfolio's Spending page does not
 *  count it: an account it does not read, a type that is not spending, a
 *  spend wholly in excluded categories, or a date it cannot read. */
export function spendLine(row: SpendRow, scope: SpendScope, excluded: ReadonlySet<string>): SpendLine | null {
  if (scope.spendingAccountIds && !scope.spendingAccountIds.includes(row.accountId)) return null;
  const sign = wfSpendSign(row);
  if (sign === 0 || row.absCents === 0) return null;
  const bucket = sign * row.absCents;
  let all: SpendAllocation[];
  if (row.splits.length > 0) {
    all = row.splits.map((s) => ({ categoryId: s.categoryId, cents: sign * Math.abs(s.absCents), source: '' }));
  } else {
    const first = [...row.filings].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    all = first ? [{ categoryId: first.categoryId, cents: bucket, source: first.source }] : [];
  }
  let excludedCents = 0;
  const allocations = all.filter((a) => {
    if (!excluded.has(a.categoryId)) return true;
    excludedCents += a.cents;
    return false;
  });
  const cents = bucket - excludedCents;
  if (cents === 0) return null;
  const day = localDay(row.date, scope.timezone);
  if (!day) return null;
  return { row, day, month: day.slice(0, 7), cents, allocations, uncategorizedCents: all.length === 0 ? bucket : 0 };
}

/** Every row's spending line, in the rows' order. */
export function spendLines(rows: readonly SpendRow[], scope: SpendScope): SpendLine[] {
  const excluded = excludedWithDescendants(scope.excludedCategoryIds, scope.categoryParents);
  const out: SpendLine[] = [];
  for (const row of rows) {
    const line = spendLine(row, scope, excluded);
    if (line) out.push(line);
  }
  return out;
}

/** The spent figure of the lines: Wealthfolio's `headline.spent`, in cents. */
export function spentCents(lines: readonly SpendLine[]): number {
  return lines.reduce((sum, l) => sum + l.cents, 0);
}
