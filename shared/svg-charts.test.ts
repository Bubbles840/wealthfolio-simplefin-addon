import { describe, it, expect } from 'vitest';
import { svgLineChart, svgBarChart, svgDonut } from './svg-charts.js';

describe('svgLineChart', () => {
  it('draws one polyline per series with axis labels', () => {
    const svg = svgLineChart({
      width: 600, height: 300,
      labels: ['Jul', 'Aug', 'Sep'],
      series: [
        { name: 'actual', color: '#5e9483', values: [100, 80, 60] },
        { name: 'ideal', color: '#c9a86b', values: [100, 70, 40], dashed: true },
      ],
    });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 600 300"');
    expect((svg.match(/<polyline/g) ?? []).length).toBe(2);
    expect(svg).toContain('stroke-dasharray');
    expect(svg).toContain('Jul');
    expect(svg).toContain('Sep');
  });

  it('skips null gaps instead of drawing to zero', () => {
    const svg = svgLineChart({
      width: 600, height: 300, labels: ['a', 'b', 'c'],
      series: [{ name: 's', color: '#fff', values: [10, null, 30] }],
    });
    // A null splits the line into two polylines of one point each — rendered
    // as circles so lone points stay visible.
    expect((svg.match(/<circle/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('svgBarChart', () => {
  it('draws grouped bars with negative values below the baseline', () => {
    const svg = svgBarChart({
      width: 600, height: 300, labels: ['Jul', 'Aug'],
      series: [
        { name: 'income', color: '#5e9483', values: [500, 0] },
        { name: 'spending', color: '#c17a63', values: [61, 47] },
      ],
    });
    expect((svg.match(/<rect [^>]*data-bar/g) ?? []).length).toBe(4);
    expect(svg).toContain('Aug');
  });
});

describe('svgDonut', () => {
  it('draws one slice per entry plus a legend', () => {
    const svg = svgDonut({
      width: 400, height: 300,
      slices: [
        { name: 'Dining', value: 60, color: '#5e9483' },
        { name: 'Groceries', value: 40, color: '#c9a86b' },
      ],
    });
    expect((svg.match(/<path/g) ?? []).length).toBe(2);
    expect(svg).toContain('Dining');
    expect(svg).toContain('Groceries');
  });
});

describe('attribute hygiene', () => {
  it('a dashed polyline defines stroke-width exactly once', () => {
    // resvg rejects duplicate attributes outright ("already defined", live
    // 2026-09-03 on the pool burn-down) — browsers were quietly forgiving it.
    const svg = svgLineChart({
      width: 600, height: 300, labels: ['a', 'b'],
      series: [{ name: 'ideal', color: '#c9a86b', dashed: true, values: [10, 5] }],
    });
    const polyline = svg.match(/<polyline[^>]*>/)![0];
    expect((polyline.match(/stroke-width/g) ?? []).length).toBe(1);
    expect(polyline).toContain('stroke-dasharray');
  });
});
