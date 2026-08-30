import React from 'react';
import { SectionLabel } from '../components/ui';
import { ReportView } from '../components/budget/ReportView';
import { monthlySpendTotals, type ReportCube } from '../../shared/report-cube';
import { runwayTrendData, savingsRateData } from '../components/budget/report-data';
import { resolveBudgetLayout, STANDARD_REPORT_IDS, type BudgetLayout } from '../../shared/budget-layout';
import type { CustomReport } from '../../shared/report-eval';
import type { SecretsStore } from '../utils/secrets';

/**
 * The Budget tab: the addon's first and default view. Everything rendered
 * here is a pure function of the companion-published report cube — see the
 * 2026-08-30 spec. The tab itself owns only presentation state; the
 * arrangement and the custom-report collection live in SyncPage (TabPanel
 * unmounts inactive tabs, and state held here would reset on every tab trip —
 * the same defect class the Telegram draft hoisting fixed).
 *
 * Absence explains itself: no cube renders ONE banner naming the companion,
 * never ten empty charts; a stale cube gets an "as of" strip while the charts
 * keep rendering (old data beats no data, but must say it is old).
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

export function BudgetTab({ cube, customReports, layout }: BudgetTabProps) {
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

  // The three headline chips: this month's spend, runway, savings rate — each
  // only when it means something.
  const spendCents = monthlySpendTotals(cube).at(-1) ?? 0;
  const runway = runwayTrendData(cube).map((r) => r.months).filter((v): v is number => typeof v === 'number').at(-1) ?? null;
  const rate = savingsRateData(cube).map((r) => r.rate).filter((v): v is number => typeof v === 'number').at(-1) ?? null;

  return (
    <>
      {stale && (
        <div className="sfin-banner-warn">
          <div className="sfin-banner-body">
            Data as of {cube.asOf.slice(0, 10)} — the companion hasn&apos;t published since.
            Charts below render that last snapshot.
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {resolved.heroes.map((id) => (
          <ReportView key={id} id={id} cube={cube} customReports={customReports} hero />
        ))}
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
        {resolved.grid.map((id) => (
          <ReportView key={id} id={id} cube={cube} customReports={customReports} />
        ))}
      </div>
    </>
  );
}
