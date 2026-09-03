import { describe, it, expect } from 'vitest';
import {
  STANDARD_REPORT_IDS, parseBudgetLayout, resolveBudgetLayout,
  resolveBoard, moveCardTo, resizeCardTo,
  pinHero, moveCard, toggleHidden, type BudgetLayout,
} from './budget-layout.js';

const AVAIL = [...STANDARD_REPORT_IDS, 'custom:cr-1'];

describe('resolveBudgetLayout', () => {
  it('one unified grid: the front pair leads at 2x2 when a pool exists', () => {
    const r = resolveBudgetLayout(null, AVAIL, true);
    expect(r.grid.slice(0, 2)).toEqual(['pool-burndown', 'cash-flow']);
    expect(r.spanOf('pool-burndown')).toEqual({ c: 8, r: 8 });
    expect(r.spanOf('cash-flow')).toEqual({ c: 8, r: 8 });
    expect(new Set(r.grid)).toEqual(new Set(AVAIL));
    expect(r.hidden).toEqual([]);
  });

  it('the pool front card yields to category trends when no pool is set', () => {
    const r = resolveBudgetLayout(null, AVAIL, false);
    expect(r.grid.slice(0, 2)).toEqual(['cash-flow', 'category-trends']);
    expect(r.grid).not.toContain('pool-burndown');
    expect(r.spanOf('category-trends')).toEqual({ c: 8, r: 8 });
  });

  it('ignores unknown ids and appends new reports at the end', () => {
    const stored: BudgetLayout = {
      heroes: ['net-worth'],
      order: ['merchants', 'gone-report'],
      hidden: ['fees-interest'],
    };
    const r = resolveBudgetLayout(stored, AVAIL, true);
    // Pinned front cards lead the ONE grid, big by default.
    expect(r.grid[0]).toBe('net-worth');
    expect(r.spanOf('net-worth')).toEqual({ c: 8, r: 8 });
    expect(r.grid[1]).toBe('merchants');
    expect(r.grid).not.toContain('gone-report');
    expect(r.grid).toContain('custom:cr-1'); // appended, never lost
    expect(r.hidden).toEqual(['fees-interest']);
    expect(r.grid).not.toContain('fees-interest');
  });
});

describe('mutations', () => {
  const base: BudgetLayout = { heroes: ['pool-burndown', 'cash-flow'], order: [], hidden: [] };

  it('pinning a third front card bumps the oldest right behind the pair', () => {
    const next = pinHero(base, AVAIL, 'net-worth');
    expect(next.heroes).toEqual(['cash-flow', 'net-worth']);
    const r = resolveBudgetLayout(next, AVAIL, true);
    expect(r.grid.slice(0, 3)).toEqual(['cash-flow', 'net-worth', 'pool-burndown']);
  });

  it('moveCard swaps within the one grid and clamps at the edges', () => {
    const r = resolveBudgetLayout(base, AVAIL, true);
    const next = moveCard(base, AVAIL, r.grid[1], -1);
    expect(resolveBudgetLayout(next, AVAIL, true).grid[0]).toBe(r.grid[1]);
    const clamped = moveCard(next, AVAIL, resolveBudgetLayout(next, AVAIL, true).grid[0], -1);
    expect(resolveBudgetLayout(clamped, AVAIL, true).grid[0]).toBe(r.grid[1]); // unchanged
  });

  it('moveBefore drops a card exactly where it was dragged', () => {
    const r = resolveBudgetLayout(base, AVAIL, true);
    const dragged = r.grid[5];
    const target = r.grid[1];
    const next = moveBefore(base, AVAIL, dragged, target);
    const after = resolveBudgetLayout(next, AVAIL, true).grid;
    expect(after.indexOf(dragged)).toBe(1);
    expect(after).toHaveLength(r.grid.length);
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

  it('setSpan stores exact FINE spans (12 cols × 16 rows), clamped to the grid', () => {
    // v1.35: near-custom sizes. New writes land in `span2`, in fine units.
    const l = setSpan(base, 'merchants', 2, 6);
    expect(l.span2).toEqual({ merchants: [2, 6] });
    expect(resolveBudgetLayout(l, AVAIL, true).spanOf('merchants')).toEqual({ c: 2, r: 6 });
    const clamped = setSpan(base, 'merchants', 99, 0);
    expect(clamped.span2).toEqual({ merchants: [12, 1] });
  });

  it('legacy coarse spans (3×4 writers) migrate ×4 on read', () => {
    const r = resolveBudgetLayout({ ...base, span: { merchants: [3, 1] } }, AVAIL, true);
    expect(r.spanOf('merchants')).toEqual({ c: 12, r: 4 });
  });

  it('a fine span wins over a legacy one for the same card', () => {
    const stored: BudgetLayout = { ...base, span: { merchants: [3, 1] }, span2: { merchants: [2, 6] } };
    expect(resolveBudgetLayout(stored, AVAIL, true).spanOf('merchants')).toEqual({ c: 2, r: 6 });
  });

  it('spanOf prefers exact spans, then size letters, then wide, then defaults — in fine units', () => {
    const stored: BudgetLayout = {
      ...base,
      wide: ['net-worth'],
      size: { seasonality: 't' },
      span: { merchants: [3, 1] },
    };
    const r = resolveBudgetLayout(stored, AVAIL, true);
    expect(r.spanOf('merchants')).toEqual({ c: 12, r: 4 });
    expect(r.spanOf('seasonality')).toEqual({ c: 4, r: 12 });
    expect(r.spanOf('net-worth')).toEqual({ c: 8, r: 8 });
    expect(r.spanOf('fees-interest')).toEqual({ c: 4, r: 4 });
    expect(r.spanOf('savings-rate')).toEqual({ c: 4, r: 8 });
  });

  it('the headline card defaults to a full-width short strip', () => {
    const r = resolveBudgetLayout(null, AVAIL, true);
    expect(r.spanOf('headline-stats')).toEqual({ c: 12, r: 4 });
  });

  it('parseBudgetLayout keeps a valid span2 map and rejects junk', () => {
    const ok = { heroes: [], order: [], hidden: [], span2: { merchants: [2, 6] } };
    expect(parseBudgetLayout(JSON.stringify(ok))).toEqual(ok);
    expect(parseBudgetLayout(JSON.stringify({ heroes: [], order: [], hidden: [], span2: { merchants: [0, 2] } }))).toBeNull();
  });

  it('parseBudgetLayout keeps a valid span map and rejects junk', () => {
    const ok = { heroes: [], order: [], hidden: [], span: { merchants: [2, 2] } };
    expect(parseBudgetLayout(JSON.stringify(ok))).toEqual(ok);
    expect(parseBudgetLayout(JSON.stringify({ heroes: [], order: [], hidden: [], span: { merchants: ['x', 2] } }))).toBeNull();
  });
});

import { setSpan } from './budget-layout.js';

import { moveBefore } from './budget-layout.js';

describe('v1.34 report roster', () => {
  it('offers the data check and subscriptions as standard reports', () => {
    expect(STANDARD_REPORT_IDS).toContain('data-check');
    expect(STANDARD_REPORT_IDS).toContain('subscriptions');
  });
});

describe('2-D board (v1.41)', () => {
  const base: BudgetLayout = { heroes: [], order: [], hidden: [] };

  it('migrates an order-based layout by packing cards in their visible order', () => {
    const board = resolveBoard(null, ['cash-flow', 'category-trends', 'headline-stats'], false);
    // Front cards are 8-wide; headline is 12-wide — first-gap packing puts
    // cash-flow top-left, category-trends beside it in the 4-unit gap? No:
    // category-trends is also a front card (8 wide), so it wraps below.
    expect(board.find((c) => c.id === 'cash-flow')).toMatchObject({ x: 0, y: 0, w: 8, h: 8 });
    expect(board.find((c) => c.id === 'category-trends')).toMatchObject({ x: 0, y: 8 });
  });

  it('stored positions win over packing and survive a round trip', () => {
    const l = moveCardTo(base, ['cash-flow', 'net-worth'], false, 'net-worth', 0, 0);
    expect(l.pos?.['net-worth']).toBeDefined();
    const board = resolveBoard(l, ['cash-flow', 'net-worth'], false);
    expect(board.find((c) => c.id === 'net-worth')).toMatchObject({ x: 0, y: 0 });
  });

  it('resizing re-resolves collisions without moving the card itself', () => {
    let l = moveCardTo(base, ['cash-flow', 'net-worth'], false, 'net-worth', 0, 0);
    l = resizeCardTo(l, ['cash-flow', 'net-worth'], false, 'net-worth', 12, 4);
    const board = resolveBoard(l, ['cash-flow', 'net-worth'], false);
    expect(board.find((c) => c.id === 'net-worth')).toMatchObject({ x: 0, y: 0, w: 12, h: 4 });
    // cash-flow pushed cleanly below the widened card.
    expect(board.find((c) => c.id === 'cash-flow')!.y).toBeGreaterThanOrEqual(4);
  });

  it('hidden cards own no board space; unknown stored ids are ignored', () => {
    const l: BudgetLayout = { heroes: [], order: [], hidden: ['net-worth'], pos: { 'ghost-report': [0, 0, 4, 4] } };
    const board = resolveBoard(l, ['cash-flow', 'net-worth'], false);
    expect(board.some((c) => c.id === 'net-worth')).toBe(false);
    expect(board.some((c) => c.id === 'ghost-report')).toBe(false);
  });

  it('parseBudgetLayout keeps a valid pos map and rejects junk', () => {
    const ok = { heroes: [], order: [], hidden: [], pos: { merchants: [0, 4, 4, 8] } };
    expect(parseBudgetLayout(JSON.stringify(ok))).toEqual(ok);
    expect(parseBudgetLayout(JSON.stringify({ heroes: [], order: [], hidden: [], pos: { merchants: [0, 4, 4] } }))).toBeNull();
    expect(parseBudgetLayout(JSON.stringify({ heroes: [], order: [], hidden: [], pos: { merchants: [-1, 0, 4, 8] } }))).toBeNull();
  });
});
