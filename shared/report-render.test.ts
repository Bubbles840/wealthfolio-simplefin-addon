import { describe, it, expect } from 'vitest';
import { renderReportSvg, RENDERABLE_REPORT_IDS, reportImageTitle } from './report-render.js';
import { CUBE } from './report-cube.test';

describe('renderReportSvg', () => {
  it('renders every advertised report id for a pool-less cube (pool ones null)', () => {
    for (const id of RENDERABLE_REPORT_IDS) {
      const svg = renderReportSvg(CUBE, id, { width: 600, height: 340 });
      if (id === 'pool-burndown') expect(svg).toBeNull();
      else {
        expect(svg, id).toContain('<svg');
        expect(reportImageTitle(id).length).toBeGreaterThan(0);
      }
    }
  });

  it('cash flow charts income and spending bars', () => {
    const svg = renderReportSvg(CUBE, 'cash-flow', { width: 600, height: 340 })!;
    expect((svg.match(/data-bar/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('the burn-down renders once a pool exists, ideal dashed', () => {
    const cube = {
      ...CUBE,
      pool: {
        config: { amountCents: 160_000, startDate: '2026-08-25', endDate: '2026-08-29' },
        daily: [{ date: '2026-08-26', spentCents: 1000 }],
      },
    };
    const svg = renderReportSvg(cube, 'pool-burndown', { width: 600, height: 340 })!;
    expect(svg).toContain('stroke-dasharray');
  });

  it('an unknown id renders nothing', () => {
    expect(renderReportSvg(CUBE, 'headline-stats', { width: 600, height: 340 })).toBeNull();
  });
});
