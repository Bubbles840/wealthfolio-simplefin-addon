import React, { useState } from 'react';
import { Button, SectionLabel } from '../ui';
import type { ReportCube } from '../../../shared/report-cube';
import {
  evaluateCustomReport, newCustomReportId,
  type CustomChart, type CustomRange, type CustomReport, type CustomReportSeries, type CustomReportTerm,
} from '../../../shared/report-eval';

/**
 * The custom report builder: name it, build series from signed terms, pick a
 * chart and range, filter accounts — with a LIVE preview on every tap,
 * because evaluation is client-side arithmetic over data already in memory.
 *
 * Touch-first by construction: selects and tap-chips only, nothing
 * hover-dependent. A term chip IS its own sign toggle — tap "+ Dining" and it
 * becomes "− Dining" — which keeps the add/subtract math one gesture deep.
 *
 * The component is controlled by its own draft and hands back a finished
 * `CustomReport` on save (a fresh id for a new report, the existing id
 * preserved on edit); the CALLER owns the collection.
 */
export interface ReportBuilderProps {
  cube: ReportCube;
  existing: CustomReport | null;
  onSave: (def: CustomReport) => void;
  onCancel: () => void;
}

const fmt0 = (dollars: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(dollars);

const CHARTS: CustomChart[] = ['line', 'bars', 'stacked', 'area', 'donut', 'table'];

function termLabel(t: CustomReportTerm): string {
  if (t.source === 'category') return t.category ?? '';
  return t.source === 'income' ? 'Income' : t.source === 'spending' ? 'Total spending' : 'Uncategorized';
}

function rangeToSelect(r: CustomRange): string {
  return r.kind === 'months' ? String(r.n) : r.kind;
}
function selectToRange(v: string): CustomRange {
  if (v === 'all') return { kind: 'all' };
  if (v === 'pool') return { kind: 'pool' };
  return { kind: 'months', n: parseInt(v, 10) || 12 };
}

export function ReportBuilder({ cube, existing, onSave, onCancel }: ReportBuilderProps) {
  const [name, setName] = useState(existing?.name ?? '');
  const [chart, setChart] = useState<CustomChart>(existing?.chart ?? 'line');
  const [rangeSel, setRangeSel] = useState(existing ? rangeToSelect(existing.range) : '12');
  const [series, setSeries] = useState<CustomReportSeries[]>(
    existing?.series?.length ? existing.series.map((s) => ({ ...s, terms: [...s.terms] })) : [{ label: '', terms: [] }],
  );
  const [checked, setChecked] = useState<Set<string>>(
    new Set(existing?.accounts ?? cube.accounts.map((a) => a.sfinId)),
  );

  const allChecked = checked.size === cube.accounts.length;
  const hasTerms = series.some((s) => s.terms.length > 0);

  const draft: CustomReport = {
    id: existing?.id ?? 'cr-preview',
    name: name.trim() || 'Untitled',
    chart,
    range: selectToRange(rangeSel),
    accounts: allChecked ? null : Array.from(checked),
    series: series.filter((s) => s.terms.length > 0),
  };
  const preview = hasTerms ? evaluateCustomReport(cube, draft) : null;

  const patchSeries = (i: number, patch: Partial<CustomReportSeries>) =>
    setSeries((prev) => prev.map((s, si) => (si === i ? { ...s, ...patch } : s)));

  const addTerm = (i: number, value: string) => {
    if (!value) return;
    const term: CustomReportTerm = value.startsWith('category:')
      ? { sign: 1, source: 'category', category: value.slice('category:'.length) }
      : { sign: 1, source: value as CustomReportTerm['source'] };
    patchSeries(i, { terms: [...series[i].terms, term] });
  };

  const toggleSign = (i: number, ti: number) =>
    patchSeries(i, {
      terms: series[i].terms.map((t, idx) => (idx === ti ? { ...t, sign: (t.sign === 1 ? -1 : 1) as 1 | -1 } : t)),
    });

  const save = () => {
    if (!name.trim() || !hasTerms) return;
    onSave({
      ...draft,
      id: existing?.id ?? newCustomReportId(),
      name: name.trim(),
    });
  };

  return (
    <div className="sfin-card">
      <div className="sfin-card-head">
        <SectionLabel>{existing ? 'Edit report' : 'New report'}</SectionLabel>
      </div>

      <div className="sfin-field-row">
        <label htmlFor="sfin-rb-name">Report name</label>
        <input id="sfin-rb-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="sfin-field-row">
        <label htmlFor="sfin-rb-chart">Chart type</label>
        <select id="sfin-rb-chart" value={chart} onChange={(e) => setChart(e.target.value as CustomChart)}>
          {CHARTS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="sfin-field-row">
        <label htmlFor="sfin-rb-range">Date range</label>
        <select id="sfin-rb-range" value={rangeSel} onChange={(e) => setRangeSel(e.target.value)}>
          <option value="6">Last 6 months</option>
          <option value="12">Last 12 months</option>
          <option value="24">Last 24 months</option>
          <option value="all">All</option>
          {cube.pool && <option value="pool">Pool window</option>}
        </select>
      </div>

      <div className="sfin-field-row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="sfin-subtle">Accounts</span>
        {cube.accounts.map((a) => (
          <label key={a.sfinId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={checked.has(a.sfinId)}
              onChange={() => setChecked((prev) => {
                const next = new Set(prev);
                if (next.has(a.sfinId)) next.delete(a.sfinId); else next.add(a.sfinId);
                return next;
              })}
            />
            {a.name}
          </label>
        ))}
      </div>

      {series.map((s, i) => (
        <div key={i} style={{ marginTop: 10 }}>
          <div className="sfin-field-row">
            <label htmlFor={`sfin-rb-series-${i}`}>Series {i + 1} label</label>
            <input
              id={`sfin-rb-series-${i}`}
              type="text"
              value={s.label}
              onChange={(e) => patchSeries(i, { label: e.target.value })}
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {s.terms.map((t, ti) => (
              <Button key={ti} variant="ghost" onClick={() => toggleSign(i, ti)}>
                {t.sign === 1 ? '+' : '−'} {termLabel(t)}
              </Button>
            ))}
            <select aria-label={`Add to series ${i + 1}`} value="" onChange={(e) => addTerm(i, e.target.value)}>
              <option value="">+ add…</option>
              <option value="income">Income</option>
              <option value="spending">Total spending</option>
              <option value="uncategorized">Uncategorized</option>
              {cube.categories.map((c) => (
                <option key={c} value={`category:${c}`}>{c}</option>
              ))}
            </select>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <Button variant="ghost" onClick={() => setSeries((prev) => [...prev, { label: '', terms: [] }])}>
          Add series
        </Button>
      </div>

      {preview && (
        <div style={{ marginTop: 12, overflowX: 'auto' }}>
          <SectionLabel>Preview</SectionLabel>
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Month</th>
                {preview.series.map((s, i) => <th key={i} style={{ textAlign: 'right' }}>{s.label || `Series ${i + 1}`}</th>)}
              </tr>
            </thead>
            <tbody>
              {preview.months.map((m, mi) => (
                <tr key={m}>
                  <td>{m}</td>
                  {preview.series.map((s, i) => (
                    <td key={i} style={{ textAlign: 'right' }}>{fmt0(s.values[mi] / 100)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="sfin-banner-actions" style={{ marginTop: 12 }}>
        <Button onClick={save} disabled={!name.trim() || !hasTerms}>Save report</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
