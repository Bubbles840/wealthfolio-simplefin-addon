import { describe, it, expect } from 'vitest';
import {
  STANDARD_REPORT_IDS, parseBudgetLayout, resolveBudgetLayout,
  pinHero, moveCard, toggleHidden, type BudgetLayout,
} from './budget-layout.js';

const AVAIL = [...STANDARD_REPORT_IDS, 'custom:cr-1'];

describe('resolveBudgetLayout', () => {
  it('defaults heroes to pool + cash flow when a pool exists', () => {
    const r = resolveBudgetLayout(null, AVAIL, true);
    expect(r.heroes).toEqual(['pool-burndown', 'cash-flow']);
    expect(r.grid).toEqual(AVAIL.filter((id) => !r.heroes.includes(id)));
    expect(r.hidden).toEqual([]);
  });

  it('pool hero yields to category trends when no pool is set', () => {
    const r = resolveBudgetLayout(null, AVAIL, false);
    expect(r.heroes).toEqual(['cash-flow', 'category-trends']);
    // The pool report is ABSENT without a pool — not in the grid either.
    expect(r.grid).not.toContain('pool-burndown');
  });

  it('ignores unknown ids and appends new reports at the end', () => {
    const stored: BudgetLayout = {
      heroes: ['net-worth'],
      order: ['merchants', 'gone-report'],
      hidden: ['fees-interest'],
    };
    const r = resolveBudgetLayout(stored, AVAIL, true);
    expect(r.heroes).toEqual(['net-worth']);
    expect(r.grid[0]).toBe('merchants');
    expect(r.grid).not.toContain('gone-report');
    expect(r.grid).toContain('custom:cr-1'); // appended, never lost
    expect(r.hidden).toEqual(['fees-interest']);
    expect(r.grid).not.toContain('fees-interest');
    expect(r.grid).not.toContain('net-worth'); // heroes are not grid cards
  });
});

describe('mutations', () => {
  const base: BudgetLayout = { heroes: ['pool-burndown', 'cash-flow'], order: [], hidden: [] };

  it('pinning a third hero bumps the oldest back into the grid front', () => {
    const next = pinHero(base, AVAIL, 'net-worth');
    expect(next.heroes).toEqual(['cash-flow', 'net-worth']);
    const r = resolveBudgetLayout(next, AVAIL, true);
    expect(r.grid[0]).toBe('pool-burndown'); // the bumped hero lands up front, not lost
  });

  it('moveCard swaps within resolved grid order and clamps at the edges', () => {
    const r = resolveBudgetLayout(base, AVAIL, true);
    const next = moveCard(base, AVAIL, r.grid[1], -1);
    expect(resolveBudgetLayout(next, AVAIL, true).grid[0]).toBe(r.grid[1]);
    const clamped = moveCard(next, AVAIL, resolveBudgetLayout(next, AVAIL, true).grid[0], -1);
    expect(resolveBudgetLayout(clamped, AVAIL, true).grid[0]).toBe(r.grid[1]); // unchanged
  });

  it('toggleHidden hides, un-hides, and unpins a hidden hero', () => {
    const hiddenOnce = toggleHidden(base, AVAIL, 'merchants');
    expect(hiddenOnce.hidden).toContain('merchants');
    expect(toggleHidden(hiddenOnce, AVAIL, 'merchants').hidden).not.toContain('merchants');
    const heroHidden = toggleHidden(base, AVAIL, 'cash-flow');
    expect(heroHidden.heroes).not.toContain('cash-flow');
    expect(heroHidden.hidden).toContain('cash-flow');
  });
});

it('parseBudgetLayout rejects junk and non-string arrays', () => {
  expect(parseBudgetLayout(null)).toBeNull();
  expect(parseBudgetLayout('x')).toBeNull();
  expect(parseBudgetLayout(JSON.stringify({ heroes: [1], order: [], hidden: [] }))).toBeNull();
  const ok = { heroes: [], order: ['cash-flow'], hidden: [] };
  expect(parseBudgetLayout(JSON.stringify(ok))).toEqual(ok);
});

describe('card sizes', () => {
  const base: BudgetLayout = { heroes: ['cash-flow'], order: [], hidden: [] };

  it('cycleSize walks medium through the shapes and back', () => {
    let l = base;
    for (const expected of ['w', 't', 'b', 'c', 'm']) {
      l = cycleSize(l, 'merchants');
      expect(l.size?.merchants ?? 'm').toBe(expected);
    }
  });

  it('resolve reports each card size, honoring the legacy wide list and defaults', () => {
    const stored: BudgetLayout = { ...base, wide: ['net-worth'], size: { merchants: 't' } };
    const r = resolveBudgetLayout(stored, AVAIL, true);
    expect(r.sizeOf('merchants')).toBe('t');
    expect(r.sizeOf('net-worth')).toBe('w');   // pre-size secrets keep their widening
    expect(r.sizeOf('fees-interest')).toBe('c'); // quiet reports default compact
    expect(r.sizeOf('seasonality')).toBe('m');
  });

  it('parseBudgetLayout keeps a valid size map and rejects junk values', () => {
    const ok = { heroes: [], order: [], hidden: [], size: { merchants: 'b' } };
    expect(parseBudgetLayout(JSON.stringify(ok))).toEqual(ok);
    expect(parseBudgetLayout(JSON.stringify({ heroes: [], order: [], hidden: [], size: { merchants: 'huge' } }))).toBeNull();
  });
});

import { cycleSize } from './budget-layout.js';

describe('wide cards', () => {
  const base: BudgetLayout = { heroes: ['cash-flow'], order: [], hidden: [] };

  it('resolve carries the wide list, filtered to what exists', () => {
    const stored: BudgetLayout = { ...base, wide: ['merchants', 'gone-report'] };
    const r = resolveBudgetLayout(stored, AVAIL, true);
    expect(r.wide).toEqual(['merchants']);
  });

  it('a stored layout without a wide list resolves to none (older secret)', () => {
    expect(resolveBudgetLayout(base, AVAIL, true).wide).toEqual([]);
    const parsed = parseBudgetLayout(JSON.stringify({ heroes: [], order: [], hidden: [] }));
    expect(parsed).toEqual({ heroes: [], order: [], hidden: [] });
  });

  it('toggleWide widens and narrows', () => {
    const widened = toggleWide(base, 'merchants');
    expect(widened.wide).toEqual(['merchants']);
    expect(toggleWide(widened, 'merchants').wide).toEqual([]);
  });

  it('parseBudgetLayout keeps a valid wide list and rejects a junk one', () => {
    const ok = { heroes: [], order: [], hidden: [], wide: ['merchants'] };
    expect(parseBudgetLayout(JSON.stringify(ok))).toEqual(ok);
    expect(parseBudgetLayout(JSON.stringify({ heroes: [], order: [], hidden: [], wide: [7] }))).toBeNull();
  });
});

import { toggleWide } from './budget-layout.js';

describe('free spans (drag resize)', () => {
  const base: BudgetLayout = { heroes: ['cash-flow'], order: [], hidden: [] };

  it('setSpan stores exact column/row spans, clamped to the grid', () => {
    const l = setSpan(base, 'merchants', 2, 3);
    expect(l.span).toEqual({ merchants: [2, 3] });
    const clamped = setSpan(base, 'merchants', 9, 0);
    expect(clamped.span).toEqual({ merchants: [3, 1] });
  });

  it('spanOf prefers exact spans, then size letters, then wide, then defaults', () => {
    const stored: BudgetLayout = {
      ...base,
      wide: ['net-worth'],
      size: { seasonality: 't' },
      span: { merchants: [3, 1] },
    };
    const r = resolveBudgetLayout(stored, AVAIL, true);
    expect(r.spanOf('merchants')).toEqual({ c: 3, r: 1 });
    expect(r.spanOf('seasonality')).toEqual({ c: 1, r: 3 });
    expect(r.spanOf('net-worth')).toEqual({ c: 2, r: 2 });
    expect(r.spanOf('fees-interest')).toEqual({ c: 1, r: 1 });
    expect(r.spanOf('savings-rate')).toEqual({ c: 1, r: 2 });
  });

  it('parseBudgetLayout keeps a valid span map and rejects junk', () => {
    const ok = { heroes: [], order: [], hidden: [], span: { merchants: [2, 2] } };
    expect(parseBudgetLayout(JSON.stringify(ok))).toEqual(ok);
    expect(parseBudgetLayout(JSON.stringify({ heroes: [], order: [], hidden: [], span: { merchants: ['x', 2] } }))).toBeNull();
  });
});

import { setSpan } from './budget-layout.js';
