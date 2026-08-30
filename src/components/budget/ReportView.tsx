import React from 'react';
import { SectionLabel } from '../ui';
import type { ReportCube } from '../../../shared/report-cube';
import type { CustomReport } from '../../../shared/report-eval';

/**
 * One report, rendered by id — the single dispatch point the hero row, the
 * grid, and (later) the full-screen view all share. Task 11 of the Budget tab
 * plan replaces the placeholder body with the real charts; the `data-report-id`
 * contract and the title resolution are already final.
 */
export const REPORT_TITLES: Record<string, string> = {
  'pool-burndown': 'Pool burn-down',
  'cash-flow': 'Cash flow',
  'category-trends': 'Category trends',
  'net-worth': 'Net worth',
  'savings-rate': 'Savings rate',
  'merchants': 'Merchants',
  'budget-vs-actual': 'Budget vs actual',
  'seasonality': 'Seasonality',
  'fees-interest': 'Fees & interest',
  'runway-trend': 'Cash runway',
};

export function reportTitle(id: string, customReports: CustomReport[]): string {
  if (id.startsWith('custom:')) {
    return customReports.find((r) => `custom:${r.id}` === id)?.name ?? 'Custom report';
  }
  return REPORT_TITLES[id] ?? id;
}

export function ReportView({ id, cube, customReports, hero = false }: {
  id: string;
  cube: ReportCube;
  customReports: CustomReport[];
  hero?: boolean;
}) {
  return (
    <div className="sfin-card" data-report-id={id} data-hero={hero || undefined}>
      <div className="sfin-card-head">
        <SectionLabel>{reportTitle(id, customReports)}</SectionLabel>
      </div>
    </div>
  );
}
