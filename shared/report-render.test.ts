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

describe('legends and captions (v1.45)', () => {
  it('multi-series charts carry a legend naming each series', () => {
    const svg = renderReportSvg(CUBE, 'cash-flow', { width: 600, height: 340 })!;
    expect(svg).toContain('income');
    expect(svg).toContain('spending');
  });

  it('line charts annotate the newest value so no hover is needed', () => {
    const svg = renderReportSvg(CUBE, 'net-worth', { width: 600, height: 340 })!;
    expect(svg).toContain('9,000'); // July's latest known net worth, printed at the line end
  });

  it('every report has a caption carrying the key latest numbers', async () => {
    const { reportImageCaption } = await import('./report-render.js');
    expect(reportImageCaption(CUBE, 'cash-flow')).toContain('$47');
    expect(reportImageCaption(CUBE, 'net-worth')).toContain('$9,000');
    for (const id of RENDERABLE_REPORT_IDS) {
      expect(reportImageCaption(CUBE, id).length).toBeGreaterThan(0);
    }
  });
});

describe('custom report rendering (v1.46)', () => {
  it('renders a line/bar custom report as an SVG of its evaluated series', async () => {
    const { renderCustomReportSvg } = await import('./report-render.js');
    const def = {
      id: 'cr-1', name: 'Food', chart: 'line' as const, range: { kind: 'all' as const }, accounts: null,
      series: [{ label: 'Food', terms: [
        { sign: 1 as const, source: 'category' as const, category: 'Dining' },
        { sign: 1 as const, source: 'category' as const, category: 'Groceries' },
      ] }],
    };
    const svg = renderCustomReportSvg(CUBE, def, { width: 640, height: 320 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('Food');
  });
});
