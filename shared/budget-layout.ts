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

import { compact, moveTo, packInto, swapVertical, moveInReadingOrder, type PlacedCard } from './grid-engine.js';

export const STANDARD_REPORT_IDS = [
  'pool-burndown', 'cash-flow', 'headline-stats', 'category-trends', 'net-worth', 'savings-rate',
  'merchants', 'budget-vs-actual', 'seasonality', 'fees-interest', 'runway-trend',
  'category-donut', 'mom-delta', 'cumulative-flow', 'spend-calendar', 'pool-pace', 'uncat-trend',
  'subscriptions', 'data-check',
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
  /** LEGACY exact spans on the old 3×4 grid — read (×4) but never written
   *  since v1.35.0. */
  span?: Record<string, [number, number]>;
  /** Exact per-card spans from the drag handle, in FINE units (12×16). Wins
   *  over everything; `size`/`wide`/`span` remain as coarser fallbacks. */
  span2?: Record<string, [number, number]>;
  /** v1.43: per-card range pins — a card listed here ignores the shared
   *  range chips and always renders this window (months, or 'all'/'pool'). */
  ranges?: Record<string, number | 'all' | 'pool'>;
  /** v1.43: which headline stats the headline card shows, in order (1–5 of
   *  the catalog in report-data). Absent = the classic trio. */
  headline?: string[];
  /** v1.43: chart palette — global, and per-card overrides. Ids from the
   *  addon's palette catalog; unknown ids fall back to the default. */
  palette?: string;
  palettes?: Record<string, string>;
  /** v1.41: the 2-D board — [x, y, w, h] per card in fine units (see
   *  shared/grid-engine.ts). When present for a card it defines placement
   *  outright; cards without one are packed after the placed ones, in the
   *  legacy resolved order, which is also how migration happens. */
  pos?: Record<string, [number, number, number, number]>;
}

export interface CardSpan { c: number; r: number }

/**
 * v1.35: FINE grid units — 12 columns and short rows, so a drag can make a
 * card "super thin" or "super wide" without a free-pixel system that would
 * break reflow on other screen sizes. One legacy coarse unit (the old 3×4
 * grid) = 4 fine units in each dimension, which is what `SPAN_SCALE`
 * migrates by. New writes go to `span2`; `span` stays readable forever.
 */
export const MAX_SPAN_COLS = 12;
export const MAX_SPAN_ROWS = 16;
const SPAN_SCALE = 4;

/** What each cycle letter means, in fine grid units. */
const LETTER_SPANS: Record<CardSize, [number, number]> = {
  c: [4, 4], m: [4, 8], w: [8, 8], t: [4, 12], b: [8, 12],
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
  if (v.ranges !== undefined) {
    if (typeof v.ranges !== 'object' || v.ranges === null) return null;
    for (const val of Object.values(v.ranges)) {
      const okNumber = typeof val === 'number' && Number.isInteger(val) && val >= 1;
      if (!okNumber && val !== 'all' && val !== 'pool') return null;
    }
  }
  if (v.headline !== undefined && !strings(v.headline)) return null;
  if (v.palette !== undefined && typeof v.palette !== 'string') return null;
  if (v.palettes !== undefined) {
    if (typeof v.palettes !== 'object' || v.palettes === null) return null;
    if (!Object.values(v.palettes).every((val) => typeof val === 'string')) return null;
  }
  if (v.pos !== undefined) {
    if (typeof v.pos !== 'object' || v.pos === null) return null;
    for (const val of Object.values(v.pos)) {
      if (!Array.isArray(val) || val.length !== 4
        || !val.every((n) => Number.isInteger(n) && n >= 0)) return null;
    }
  }
  for (const key of ['span', 'span2'] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== 'object' || v[key] === null) return null;
      for (const val of Object.values(v[key])) {
        if (!Array.isArray(val) || val.length !== 2
          || !val.every((n) => Number.isInteger(n) && n >= 1)) return null;
      }
    }
  }
  return {
    heroes: v.heroes, order: v.order, hidden: v.hidden,
    ...(v.wide ? { wide: v.wide } : {}),
    ...(v.size ? { size: v.size } : {}),
    ...(v.span ? { span: v.span } : {}),
    ...(v.span2 ? { span2: v.span2 } : {}),
    ...(v.pos ? { pos: v.pos } : {}),
    ...(v.ranges ? { ranges: v.ranges } : {}),
    ...(v.headline ? { headline: v.headline } : {}),
    ...(v.palette ? { palette: v.palette } : {}),
    ...(v.palettes ? { palettes: v.palettes } : {}),
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
  // ONE grid since v1.33.0: the former hero row flattened into the front of
  // the ordering, with a big default span — every card is movable and
  // resizable the same way, which is the whole point. `heroes` (stored and
  // returned) is now just "the front set": it drives default position and the
  // 2×2 default shape, nothing else.
  const storedHeroes = (stored?.heroes ?? []).filter((id) => availSet.has(id));
  const front = (storedHeroes.length > 0 ? storedHeroes : defaultHeroes(poolPresent).filter((id) => availSet.has(id)))
    .slice(0, MAX_HEROES);
  const hidden = (stored?.hidden ?? []).filter((id) => availSet.has(id));
  const hiddenSet = new Set(hidden);
  const placed = new Set<string>(hidden);
  const grid: string[] = [];
  const orderSet = new Set(stored?.order ?? []);
  // Front cards lead — UNLESS an explicit rearrangement has placed them: the
  // move/drag snapshots write the whole combined order, front included, and
  // that snapshot is then the truth. A legacy order that never mentions a
  // front id (pin's bump list) still gets the front pair up top.
  for (const id of front) {
    if (availSet.has(id) && !orderSet.has(id) && !placed.has(id)) {
      grid.push(id);
      placed.add(id);
    }
  }
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
  const frontSet = new Set(front);
  const sizeOf = (id: string): CardSize =>
    stored?.size?.[id]
    ?? (wide.includes(id) ? 'w' : DEFAULT_COMPACT.has(id) ? 'c' : 'm');
  const clamp = (c: number, r: number): CardSpan => ({
    c: Math.min(MAX_SPAN_COLS, Math.max(1, c)),
    r: Math.min(MAX_SPAN_ROWS, Math.max(1, r)),
  });
  const spanOf = (id: string): CardSpan => {
    const fine = stored?.span2?.[id];
    if (fine) return clamp(fine[0], fine[1]);
    const legacy = stored?.span?.[id];
    if (legacy) return clamp(legacy[0] * SPAN_SCALE, legacy[1] * SPAN_SCALE);
    const preset = DEFAULT_SPANS[id];
    if (preset && !stored?.size?.[id] && !wide.includes(id)) {
      // Front cards default big; fixed presets (the headline strip) likewise —
      // an explicit size or span always wins.
      const [c, r] = preset;
      return { c, r };
    }
    if (frontSet.has(id) && !stored?.size?.[id] && !wide.includes(id)) return { c: 8, r: 8 };
    const [c, r] = LETTER_SPANS[sizeOf(id)];
    return { c, r };
  };
  return { heroes: front, grid, hidden: hidden.filter((id) => hiddenSet.has(id)), wide, sizeOf, spanOf };
}

/** Fixed default shapes for cards whose content dictates one. */
const DEFAULT_SPANS: Record<string, [number, number]> = {
  'headline-stats': [12, 4],
};

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

/** Store an exact FINE span from the drag handle, clamped to the grid. */
export function setSpan(stored: BudgetLayout, id: string, cols: number, rows: number): BudgetLayout {
  const c = Math.min(MAX_SPAN_COLS, Math.max(1, Math.round(cols)));
  const r = Math.min(MAX_SPAN_ROWS, Math.max(1, Math.round(rows)));
  return { ...stored, span2: { ...(stored.span2 ?? {}), [id]: [c, r] } };
}

/** Drag-to-move's drop: put `id` immediately before `targetId` in the one
 *  grid, snapshotting the whole resolved order (the same snapshot semantics
 *  moveCard uses, so repeated drags stay stable). */
export function moveBefore(
  stored: BudgetLayout,
  availableIds: string[],
  id: string,
  targetId: string,
): BudgetLayout {
  const grid = resolveFrom(stored, availableIds, true).grid.filter((g) => g !== id);
  const at = grid.indexOf(targetId);
  if (at === -1 || id === targetId) return stored;
  grid.splice(at, 0, id);
  return { ...stored, order: grid };
}

/**
 * The 2-D board: every visible card with an explicit place. Stored positions
 * are taken as-is (clamped); everything else — a fresh migration, a new
 * report, a just-unhidden card — packs into the first gap in the LEGACY
 * resolved order, so an existing arrangement carries over recognizably.
 * Always compacted: no floating holes, and a stable answer for the same
 * inputs.
 */
export function resolveBoard(
  stored: BudgetLayout | null,
  availableIds: string[],
  poolPresent: boolean,
): PlacedCard[] {
  const legacy = resolveBudgetLayout(stored, availableIds, poolPresent);
  const visible = legacy.grid;
  const visibleSet = new Set(visible);
  const placed: PlacedCard[] = [];
  const unplaced: Array<{ id: string; w: number; h: number }> = [];
  for (const id of visible) {
    const posEntry = stored?.pos?.[id];
    if (posEntry) {
      const [x, y, w0, h0] = posEntry;
      const w = Math.max(1, Math.min(12, w0));
      placed.push({
        id,
        x: Math.max(0, Math.min(12 - w, x)),
        y: Math.max(0, y),
        w,
        h: Math.max(1, Math.min(MAX_SPAN_ROWS, h0)),
      });
    } else {
      const { c, r } = legacy.spanOf(id);
      unplaced.push({ id, w: c, h: r });
    }
  }
  // Stored ids that no longer exist simply contribute nothing.
  void visibleSet;
  return compact(packInto(placed, unplaced));
}

/** The board serialized back into the stored shape — whole-snapshot writes,
 *  like every other layout mutation, so repeated edits stay stable. */
function writeBoard(stored: BudgetLayout, board: PlacedCard[]): BudgetLayout {
  const pos: Record<string, [number, number, number, number]> = {};
  for (const c of board) pos[c.id] = [c.x, c.y, c.w, c.h];
  return { ...stored, pos };
}

/** Drop `id` at exactly (x, y): the engine pushes overlaps down and closes
 *  the gaps. The whole resulting board is stored. */
export function moveCardTo(
  stored: BudgetLayout,
  availableIds: string[],
  poolPresent: boolean,
  id: string,
  x: number,
  y: number,
): BudgetLayout {
  const board = resolveBoard(stored, availableIds, poolPresent);
  if (!board.some((c) => c.id === id)) return stored;
  return writeBoard(stored, moveTo(board, id, x, y));
}

/** Resize in place: same spot, new size, collisions re-resolved. */
export function resizeCardTo(
  stored: BudgetLayout,
  availableIds: string[],
  poolPresent: boolean,
  id: string,
  w: number,
  h: number,
): BudgetLayout {
  const board = resolveBoard(stored, availableIds, poolPresent);
  const card = board.find((c) => c.id === id);
  if (!card) return stored;
  const resized = board.map((c) => (c.id === id
    ? { ...c, w: Math.max(1, Math.min(12, Math.round(w))), h: Math.max(1, Math.min(MAX_SPAN_ROWS, Math.round(h))) }
    : c));
  return writeBoard(stored, moveTo(resized, id, card.x, card.y));
}

/** The buttons' movement: swap with the vertical neighbor (gravity makes a
 *  bare one-row nudge fall straight back, so swapping is what ↑/↓ MEAN). */
export function swapCard(
  stored: BudgetLayout,
  availableIds: string[],
  poolPresent: boolean,
  id: string,
  dir: -1 | 1,
): BudgetLayout {
  const board = resolveBoard(stored, availableIds, poolPresent);
  if (!board.some((c) => c.id === id)) return stored;
  const swapped = swapVertical(board, id, dir);
  const pos: Record<string, [number, number, number, number]> = {};
  for (const c of swapped) pos[c.id] = [c.x, c.y, c.w, c.h];
  return { ...stored, pos };
}

/** Reading-order ▲/▼ — the phone's single-column semantics. */
export function moveCardReading(
  stored: BudgetLayout,
  availableIds: string[],
  poolPresent: boolean,
  id: string,
  dir: -1 | 1,
): BudgetLayout {
  const board = resolveBoard(stored, availableIds, poolPresent);
  if (!board.some((c) => c.id === id)) return stored;
  const moved = moveInReadingOrder(board, id, dir);
  const pos: Record<string, [number, number, number, number]> = {};
  for (const c of moved) pos[c.id] = [c.x, c.y, c.w, c.h];
  return { ...stored, pos };
}
