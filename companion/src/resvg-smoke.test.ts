import { describe, it, expect } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { renderReportSvg, RENDERABLE_REPORT_IDS } from '../shared/report-render.js';
import { CUBE } from '../shared/report-cube.test';

describe('resvg accepts every rendered report', () => {
  it('rasterizes each renderable id without throwing', () => {
    const pooled = {
      ...CUBE,
      pool: {
        config: { amountCents: 160_000, startDate: '2026-08-25', endDate: '2026-08-29' },
        daily: [{ date: '2026-08-26', spentCents: 1000 }],
      },
    };
    for (const id of RENDERABLE_REPORT_IDS) {
      const svg = renderReportSvg(pooled, id, { width: 600, height: 340 });
      if (svg === null) continue;
      const png = new Resvg(svg).render().asPng();
      expect(png.length, id).toBeGreaterThan(500);
    }
  });
});
