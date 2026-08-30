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
