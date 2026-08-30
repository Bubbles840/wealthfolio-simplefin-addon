/**
 * shared/report-eval.ts
 *
 * The custom report model and its evaluator — the "put in your own categories
 * and divide it by this, subtract it by this" half of the Budget tab.
 *
 * A report is data, not code: named series built from TERMS, each a signed
 * source — one category, total income, total spending, or uncategorized —
 * summed per month over the cube. Evaluation is one pure function so the
 * builder's live preview, the saved card, and the full-screen view can never
 * disagree; it also means a definition is safe to store and re-evaluate
 * against any future cube.
 *
 * Failure posture mirrors the cube's: a term naming a category the cube no
 * longer has contributes ZERO and reports the name on the series
 * (`unknownCategories`) — the card wears a warning chip, never crashes, and
 * self-heals if the category returns. `parseCustomReports` validates each
 * stored entry individually, dropping the malformed ones rather than losing
 * the user's whole collection to one bad row.
 */
import {
  categorySeries, monthlyIncomeTotals, monthlySpendTotals, monthlyUncategorizedTotals,
  type ReportCube,
} from './report-cube.js';

export type CustomChart = 'line' | 'bars' | 'stacked' | 'area' | 'donut' | 'table';
export type CustomRange = { kind: 'months'; n: number } | { kind: 'all' } | { kind: 'pool' };

export interface CustomReportTerm {
  sign: 1 | -1;
  source: 'category' | 'income' | 'spending' | 'uncategorized';
  /** Required exactly when `source` is 'category'. */
  category?: string;
}
export interface CustomReportSeries { label: string; terms: CustomReportTerm[] }
export interface CustomReport {
  id: string;
  name: string;
  chart: CustomChart;
  range: CustomRange;
  /** SimpleFin account ids to include, or null for all. */
  accounts: string[] | null;
  series: CustomReportSeries[];
}

export interface EvaluatedSeries { label: string; values: number[]; unknownCategories: string[] }
export interface EvaluatedReport { months: string[]; series: EvaluatedSeries[] }

const CHARTS = new Set(['line', 'bars', 'stacked', 'area', 'donut', 'table']);
const SOURCES = new Set(['category', 'income', 'spending', 'uncategorized']);

/** Month indices the range covers. 'pool' means the pool's months and
 *  deliberately degrades to ALL months when no pool is set — a saved report
 *  must keep meaning something after the semester ends. */
function windowIndices(cube: ReportCube, range: CustomRange): number[] {
  const all = cube.months.map((_, i) => i);
  if (range.kind === 'all') return all;
  if (range.kind === 'months') return all.slice(Math.max(0, all.length - range.n));
  if (!cube.pool) return all;
  const start = cube.pool.config.startDate.slice(0, 7);
  const end = cube.pool.config.endDate.slice(0, 7);
  const hit = all.filter((i) => cube.months[i] >= start && cube.months[i] <= end);
  return hit.length > 0 ? hit : all;
}

export function evaluateCustomReport(cube: ReportCube, def: CustomReport): EvaluatedReport {
  const idx = windowIndices(cube, def.range);
  const series = def.series.map((s) => {
    const totals = new Array(cube.months.length).fill(0);
    const unknown: string[] = [];
    for (const term of s.terms) {
      let full: number[] | null;
      if (term.source === 'category') {
        full = categorySeries(cube, term.category ?? '', def.accounts);
        if (full === null) {
          const name = term.category ?? '';
          if (!unknown.includes(name)) unknown.push(name);
          continue;
        }
      } else if (term.source === 'income') {
        full = monthlyIncomeTotals(cube, def.accounts);
      } else if (term.source === 'uncategorized') {
        full = monthlyUncategorizedTotals(cube, def.accounts);
      } else {
        full = monthlySpendTotals(cube, def.accounts);
      }
      for (let i = 0; i < totals.length; i += 1) totals[i] += term.sign * full[i];
    }
    return {
      label: s.label,
      values: idx.map((i) => totals[i]),
      unknownCategories: unknown,
    };
  });
  return { months: idx.map((i) => cube.months[i]), series };
}

function validTerm(t: any): t is CustomReportTerm {
  if (!t || typeof t !== 'object') return false;
  if (t.sign !== 1 && t.sign !== -1) return false;
  if (!SOURCES.has(t.source)) return false;
  if (t.source === 'category' && (typeof t.category !== 'string' || t.category === '')) return false;
  return true;
}

function validReport(v: any): v is CustomReport {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.id !== 'string' || v.id === '') return false;
  if (typeof v.name !== 'string' || v.name === '') return false;
  if (!CHARTS.has(v.chart)) return false;
  const r = v.range;
  const rangeOk = !!r && typeof r === 'object' && (
    r.kind === 'all' || r.kind === 'pool'
    || (r.kind === 'months' && Number.isInteger(r.n) && r.n > 0)
  );
  if (!rangeOk) return false;
  if (v.accounts !== null && !(Array.isArray(v.accounts) && v.accounts.every((a: unknown) => typeof a === 'string'))) return false;
  if (!Array.isArray(v.series)) return false;
  for (const s of v.series) {
    if (!s || typeof s !== 'object' || typeof s.label !== 'string') return false;
    if (!Array.isArray(s.terms) || !s.terms.every(validTerm)) return false;
  }
  return true;
}

export function parseCustomReports(raw: string | null | undefined): CustomReport[] {
  if (!raw) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  return v.filter(validReport);
}

/** 'cr-' plus six random bytes as hex — short enough for a layout id
 *  (`custom:cr-…`), long enough that collisions are not a real event. */
export function newCustomReportId(): string {
  const bytes = new Uint8Array(6);
  try {
    (globalThis.crypto ?? ({} as Crypto)).getRandomValues?.(bytes);
  } catch { /* fall through to Math.random below */ }
  if (bytes.every((b) => b === 0)) {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `cr-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
