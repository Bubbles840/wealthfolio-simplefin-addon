/**
 * shared/budget-layout.ts
 *
 * The user's arrangement of the Budget tab: which reports are the two hero
 * charts, the grid order for the rest, and what is hidden. Stored as the
 * addon-owned `budget_layout` secret and resolved fresh against whatever
 * reports EXIST right now — the stored value is a preference, never a
 * manifest. That split is what makes the arrangement corruption-proof:
 * unknown ids (a deleted custom report, a renamed standard id) are ignored,
 * new reports append at the end, and a pool report simply vanishes from every
 * slot while no pool is set.
 *
 * Mutations return new objects for React and take `availableIds` so the
 * up/down arithmetic happens on the RESOLVED grid the user is looking at —
 * moving "the card below" must mean the one visually below, not whatever
 * happens to sit next in a stale stored order.
 */

export const STANDARD_REPORT_IDS = [
  'pool-burndown', 'cash-flow', 'category-trends', 'net-worth', 'savings-rate',
  'merchants', 'budget-vs-actual', 'seasonality', 'fees-interest', 'runway-trend',
  'category-donut', 'mom-delta', 'cumulative-flow', 'spend-calendar', 'pool-pace', 'uncat-trend',
] as const;

/** Reports that only exist while a pool is set — they render the pool window. */
export const POOL_ONLY_REPORT_IDS = new Set(['pool-burndown', 'spend-calendar', 'pool-pace']);

export interface BudgetLayout {
  heroes: string[];
  order: string[];
  hidden: string[];
  /** Grid cards rendered double-width. LEGACY (pre-size secrets): read as
   *  size 'w' when the card has no entry in `size`; never written any more. */
  wide?: string[];
  /** Per-card shape on the grid's fixed row rhythm:
   *  c = compact (1×1), m = medium (1×2, the default), w = wide (2×2),
   *  t = tall (1×3), b = big (2×3). The "exact box size you want", within a
   *  system that keeps the grid flush. */
  size?: Record<string, CardSize>;
  /** Exact per-card spans from the drag handle: [columns, rows] on the grid's
   *  fixed rhythm. Wins over `size` and `wide`, which remain as coarser
   *  fallbacks (the cycle button still writes `size`). */
  span?: Record<string, [number, number]>;
}

export interface CardSpan { c: number; r: number }

export const MAX_SPAN_COLS = 3;
export const MAX_SPAN_ROWS = 4;

/** What each cycle letter means in grid units. */
const LETTER_SPANS: Record<CardSize, [number, number]> = {
  c: [1, 1], m: [1, 2], w: [2, 2], t: [1, 3], b: [2, 3],
};

export type CardSize = 'c' | 'm' | 'w' | 't' | 'b';

/** Reports whose usual content is one line or a short list start compact —
 *  an all-quiet fees card at full height is what read as wasted space. */
const DEFAULT_COMPACT = new Set(['fees-interest', 'pool-pace', 'uncat-trend']);

/** m → w → t → b → c → m: each tap of Resize is one step through the shapes. */
const SIZE_CYCLE: Record<CardSize, CardSize> = { m: 'w', w: 't', t: 'b', b: 'c', c: 'm' };

export const SIZE_LABELS: Record<CardSize, string> = {
  c: 'compact', m: 'medium', w: 'wide', t: 'tall', b: 'big',
};
export interface ResolvedLayout {
  heroes: string[];
  grid: string[];
  hidden: string[];
  wide: string[];
  /** The effective size for any card id: the stored size, else 'w' for a
   *  legacy wide entry, else the per-report default. */
  sizeOf: (id: string) => CardSize;
  /** The effective spans: an exact drag-set span first, then the size letter's
   *  shape, then the same fallbacks sizeOf uses. */
  spanOf: (id: string) => CardSpan;
}

const MAX_HEROES = 2;

export function parseBudgetLayout(raw: string | null | undefined): BudgetLayout | null {
  if (!raw) return null;
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  if (!strings(v.heroes) || !strings(v.order) || !strings(v.hidden)) return null;
  if (v.wide !== undefined && !strings(v.wide)) return null;
  if (v.size !== undefined) {
    if (typeof v.size !== 'object' || v.size === null) return null;
    for (const val of Object.values(v.size)) {
      if (val !== 'c' && val !== 'm' && val !== 'w' && val !== 't' && val !== 'b') return null;
    }
  }
  if (v.span !== undefined) {
    if (typeof v.span !== 'object' || v.span === null) return null;
    for (const val of Object.values(v.span)) {
      if (!Array.isArray(val) || val.length !== 2
        || !val.every((n) => Number.isInteger(n) && n >= 1)) return null;
    }
  }
  return {
    heroes: v.heroes, order: v.order, hidden: v.hidden,
    ...(v.wide ? { wide: v.wide } : {}),
    ...(v.size ? { size: v.size } : {}),
    ...(v.span ? { span: v.span } : {}),
  };
}

/** The default hero pair. The pool chart leads when a pool exists — it is the
 *  lens this tab was built around — and yields its slot to category trends
 *  when there is nothing to burn down. */
function defaultHeroes(poolPresent: boolean): string[] {
  return poolPresent ? ['pool-burndown', 'cash-flow'] : ['cash-flow', 'category-trends'];
}

function resolveFrom(stored: BudgetLayout | null, avail: string[], poolPresent: boolean): ResolvedLayout {
  const availSet = new Set(avail);
  const storedHeroes = (stored?.heroes ?? []).filter((id) => availSet.has(id));
  const heroes = (storedHeroes.length > 0 ? storedHeroes : defaultHeroes(poolPresent).filter((id) => availSet.has(id)))
    .slice(0, MAX_HEROES);
  const heroSet = new Set(heroes);
  const hidden = (stored?.hidden ?? []).filter((id) => availSet.has(id) && !heroSet.has(id));
  const hiddenSet = new Set(hidden);
  const placed = new Set([...heroes, ...hidden]);
  const grid: string[] = [];
  for (const id of stored?.order ?? []) {
    if (availSet.has(id) && !placed.has(id)) {
      grid.push(id);
      placed.add(id);
    }
  }
  for (const id of avail) {
    if (!placed.has(id)) {
      grid.push(id);
      placed.add(id);
    }
  }
  const wide = (stored?.wide ?? []).filter((id) => availSet.has(id));
  const sizeOf = (id: string): CardSize =>
    stored?.size?.[id]
    ?? (wide.includes(id) ? 'w' : DEFAULT_COMPACT.has(id) ? 'c' : 'm');
  const spanOf = (id: string): CardSpan => {
    const exact = stored?.span?.[id];
    if (exact) {
      return {
        c: Math.min(MAX_SPAN_COLS, Math.max(1, exact[0])),
        r: Math.min(MAX_SPAN_ROWS, Math.max(1, exact[1])),
      };
    }
    const [c, r] = LETTER_SPANS[sizeOf(id)];
    return { c, r };
  };
  return { heroes, grid, hidden, wide, sizeOf, spanOf };
}

export function resolveBudgetLayout(
  stored: BudgetLayout | null,
  availableIds: string[],
  poolPresent: boolean,
): ResolvedLayout {
  const avail = poolPresent ? availableIds : availableIds.filter((id) => id !== 'pool-burndown');
  return resolveFrom(stored, avail, poolPresent);
}

/** Pin `id` as a hero. At most two: pinning a third bumps the OLDEST hero to
 *  the FRONT of the grid, where the user can see where it went. */
export function pinHero(stored: BudgetLayout, availableIds: string[], id: string): BudgetLayout {
  const heroes = [...stored.heroes.filter((h) => h !== id), id];
  let order = stored.order.filter((o) => o !== id);
  const hidden = stored.hidden.filter((h) => h !== id);
  while (heroes.length > MAX_HEROES) {
    const bumped = heroes.shift()!;
    order = [bumped, ...order.filter((o) => o !== bumped)];
  }
  return { ...stored, heroes, order, hidden };
}

/** Move a grid card one slot up (-1) or down (+1) in the grid the user SEES,
 *  writing that whole resolved order back — snapshot semantics keep repeated
 *  taps stable however sparse the stored order was. Out-of-range moves are
 *  no-ops, not wraps. */
export function moveCard(
  stored: BudgetLayout,
  availableIds: string[],
  id: string,
  delta: -1 | 1,
): BudgetLayout {
  const grid = [...resolveFrom(stored, availableIds, true).grid];
  const i = grid.indexOf(id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= grid.length) return stored;
  [grid[i], grid[j]] = [grid[j], grid[i]];
  return { ...stored, order: grid };
}

/** Hide or un-hide. Hiding a hero also unpins it — a hidden hero would be an
 *  invisible slot the user could never explain. */
export function toggleHidden(stored: BudgetLayout, availableIds: string[], id: string): BudgetLayout {
  if (stored.hidden.includes(id)) {
    return { ...stored, hidden: stored.hidden.filter((h) => h !== id) };
  }
  return {
    ...stored,
    heroes: stored.heroes.filter((h) => h !== id),
    order: stored.order.filter((o) => o !== id),
    hidden: [...stored.hidden, id],
  };
}

/** Widen a grid card to double width, or narrow it back — purely visual, so
 *  unlike hide/pin it touches nothing else about the arrangement. */
export function toggleWide(stored: BudgetLayout, id: string): BudgetLayout {
  const wide = stored.wide ?? [];
  return {
    ...stored,
    wide: wide.includes(id) ? wide.filter((w) => w !== id) : [...wide, id],
  };
}

/** One Resize tap: step this card to the next shape in the cycle. */
export function cycleSize(stored: BudgetLayout, id: string): BudgetLayout {
  const current: CardSize = stored.size?.[id]
    ?? (stored.wide?.includes(id) ? 'w' : DEFAULT_COMPACT.has(id) ? 'c' : 'm');
  return {
    ...stored,
    size: { ...(stored.size ?? {}), [id]: SIZE_CYCLE[current] },
  };
}

/** Store an exact span from the drag handle, clamped to the grid. */
export function setSpan(stored: BudgetLayout, id: string, cols: number, rows: number): BudgetLayout {
  const c = Math.min(MAX_SPAN_COLS, Math.max(1, Math.round(cols)));
  const r = Math.min(MAX_SPAN_ROWS, Math.max(1, Math.round(rows)));
  return { ...stored, span: { ...(stored.span ?? {}), [id]: [c, r] } };
}
