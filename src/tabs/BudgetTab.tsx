import React, { useState } from 'react';
import { Button, SectionLabel } from '../components/ui';
import { ReportView, reportTitle } from '../components/budget/ReportView';
import { monthlySpendTotals, sliceCubeMonths, type ReportCube } from '../../shared/report-cube';
import { runwayTrendData, savingsRateData } from '../components/budget/report-data';
import { resolveBudgetLayout, STANDARD_REPORT_IDS, type BudgetLayout } from '../../shared/budget-layout';
import type { CustomReport } from '../../shared/report-eval';
import type { SecretsStore } from '../utils/secrets';

/**
 * The Budget tab: the addon's first and default view. Everything rendered
 * here is a pure function of the companion-published report cube — see the
 * 2026-08-30 spec. The tab owns only presentation state (which report is
 * full-screen, the shared range); the arrangement and the custom-report
 * collection live in SyncPage, because TabPanel unmounts inactive tabs and
 * state held here would reset on every tab trip — the defect class the
 * Telegram draft hoisting fixed.
 *
 * One range control for every report, not ten pickers; drill into any card
 * for the full-screen view, which on a phone is the primary experience.
 * Absence explains itself: no cube renders ONE banner naming the companion,
 * a stale cube gets an "as of" strip while charts keep rendering.
 */
export interface BudgetTabProps {
  cube: ReportCube | null;
  customReports: CustomReport[];
  layout: BudgetLayout | null;
  onLayoutChange: (next: BudgetLayout) => void;
  onCustomReportsChange: (next: CustomReport[]) => void;
  store: SecretsStore;
}

/** Two days: one missed nightly publish is routine, two is worth a strip. */
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

const money0 = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);

type Range = number | 'all' | 'pool';
const RANGES: Array<{ label: string; value: Range }> = [
  { label: '6 months', value: 6 },
  { label: '12 months', value: 12 },
  { label: '24 months', value: 24 },
  { label: 'All', value: 'all' },
];

export function BudgetTab({ cube, customReports, layout }: BudgetTabProps) {
  const [fullId, setFullId] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(12);

  if (!cube) {
    return (
      <div className="sfin-banner-warn">
        <div className="sfin-banner-body">
          <div>
            <b>Reports need the companion.</b> The Budget tab renders data the
            companion publishes on each sync — once a sync with v1.29.0+ has
            run, the reports appear here on their own.
          </div>
        </div>
      </div>
    );
  }

  const availableIds = [
    ...STANDARD_REPORT_IDS.filter((id) => id !== 'pool-burndown' || cube.pool !== null),
    ...customReports.map((r) => `custom:${r.id}`),
  ];
  const resolved = resolveBudgetLayout(layout, availableIds, cube.pool !== null);
  const stale = Date.now() - Date.parse(cube.asOf) > STALE_MS;
  const viewCube = sliceCubeMonths(cube, range);

  const staleStrip = stale && (
    <div className="sfin-banner-warn">
      <div className="sfin-banner-body">
        Data as of {cube.asOf.slice(0, 10)} — the companion hasn&apos;t published since.
        Charts below render that last snapshot.
      </div>
    </div>
  );

  const rangeChips = (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
      {[...RANGES, ...(cube.pool ? [{ label: 'Pool', value: 'pool' as Range }] : [])].map((r) => (
        <Button
          key={r.label}
          variant={range === r.value ? undefined : 'ghost'}
          aria-pressed={range === r.value}
          onClick={() => setRange(r.value)}
        >
          {r.label}
        </Button>
      ))}
    </div>
  );

  if (fullId !== null) {
    return (
      <div data-full-report={fullId}>
        {staleStrip}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Button variant="ghost" aria-label="Back to all reports" onClick={() => setFullId(null)}>
            ← All reports
          </Button>
          <SectionLabel>{reportTitle(fullId, customReports)}</SectionLabel>
        </div>
        {rangeChips}
        <ReportView id={fullId} cube={viewCube} customReports={customReports} hero />
      </div>
    );
  }

  // The three headline chips: this month's spend, runway, savings rate — each
  // only when it means something.
  const spendCents = monthlySpendTotals(cube).at(-1) ?? 0;
  const runway = runwayTrendData(cube).map((r) => r.months).filter((v): v is number => typeof v === 'number').at(-1) ?? null;
  const rate = savingsRateData(cube).map((r) => r.rate).filter((v): v is number => typeof v === 'number').at(-1) ?? null;

  /** A whole card is its own open-button: the tap target a phone needs, with
   *  the accessible name a screen reader needs. */
  const openable = (id: string, hero: boolean) => (
    <div
      key={id}
      role="button"
      tabIndex={0}
      aria-label={`Open ${reportTitle(id, customReports)}`}
      style={{ cursor: 'pointer' }}
      onClick={() => setFullId(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFullId(id); }
      }}
    >
      <ReportView id={id} cube={viewCube} customReports={customReports} hero={hero} />
    </div>
  );

  return (
    <>
      {staleStrip}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {resolved.heroes.map((id) => openable(id, true))}
      </div>

      <div className="sfin-strip" style={{ marginTop: 12 }}>
        <div className="sfin-tile sfin-tile--blue">
          <SectionLabel>Spent this month</SectionLabel>
          <div className="sfin-tile-val">{money0(spendCents)}</div>
        </div>
        {runway !== null && (
          <div className="sfin-tile sfin-tile--green">
            <SectionLabel>Cash runway</SectionLabel>
            <div className="sfin-tile-val">{runway}mo</div>
          </div>
        )}
        {rate !== null && (
          <div className="sfin-tile sfin-tile--purple">
            <SectionLabel>Savings rate</SectionLabel>
            <div className="sfin-tile-val">{Math.round(rate * 100)}%</div>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 12 }}>
        {resolved.grid.map((id) => openable(id, false))}
      </div>
    </>
  );
}
