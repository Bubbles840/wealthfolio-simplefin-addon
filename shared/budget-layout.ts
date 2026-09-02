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
] as const;

export interface BudgetLayout {
  heroes: string[];
  order: string[];
  hidden: string[];
  /** Grid cards rendered double-width. Optional: layouts stored before the
   *  control existed simply have none. */
  wide?: string[];
}
export interface ResolvedLayout { heroes: string[]; grid: string[]; hidden: string[]; wide: string[] }

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
  return { heroes: v.heroes, order: v.order, hidden: v.hidden, ...(v.wide ? { wide: v.wide } : {}) };
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
  return { heroes, grid, hidden, wide: (stored?.wide ?? []).filter((id) => availSet.has(id)) };
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
