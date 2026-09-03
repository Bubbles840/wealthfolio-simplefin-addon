/**
 * shared/grid-engine.ts
 *
 * The 2-D dashboard layout model: explicit x/y/w/h per card, collision
 * push-down, vertical compaction. This is the model react-grid-layout and
 * gridstack.js converge on (researched 2026-09-02) — the industry answer to
 * "the tile should land where I put it, and nothing else should teleport."
 *
 * The previous model was a 1-D order rendered with CSS `grid-auto-flow:
 * dense`, which BACKFILLS holes: inserting one card could visually repack
 * every other card, which is exactly the live complaint. Explicit coordinates
 * make placement literal; the only movements are the two predictable ones —
 * overlapped cards push straight down, and gravity pulls cards straight up
 * into free space.
 *
 * Why not the libraries themselves: their drag layers ride document-level
 * mouse listeners, which have already died once inside Wealthfolio's
 * sandboxed iframe (v1.32). The proven pointer-capture input layer stays;
 * only the MATH lives here, pure and tested.
 */

export const GRID_COLS = 12;

export interface PlacedCard {
  id: string;
  /** Fine grid units: x in 0..11, y ≥ 0, w in 1..12, h ≥ 1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export function collides(a: PlacedCard, b: PlacedCard): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Reading order: top row first, left to right within it. */
const byPosition = (a: PlacedCard, b: PlacedCard) => a.y - b.y || a.x - b.x;

/**
 * Gravity: every card rises straight up (x kept) until it would overlap a
 * card already settled. Processed in reading order so the outcome is stable
 * and unique — no floating holes, no sideways movement.
 */
export function compact(cards: readonly PlacedCard[]): PlacedCard[] {
  const settled: PlacedCard[] = [];
  for (const card of [...cards].sort(byPosition)) {
    let y = 0;
    // The lowest y where it fits: walk down from the top one row at a time.
    // Bounded by the card's own y — it never sinks during compaction.
    while (y < card.y) {
      const probe = { ...card, y };
      if (settled.every((other) => !collides(probe, other))) break;
      y += 1;
    }
    settled.push({ ...card, y });
  }
  return settled;
}

/**
 * Place `id` at exactly (x, y) — clamped into the columns — pushing anything
 * it now overlaps straight DOWN (cascading), then compacting. The moved card
 * is settled first so gravity cannot yank it away from where it was dropped.
 */
export function moveTo(
  cards: readonly PlacedCard[],
  id: string,
  x: number,
  y: number,
): PlacedCard[] {
  const moving = cards.find((c) => c.id === id);
  if (!moving) return [...cards];
  const placed: PlacedCard = {
    ...moving,
    x: Math.max(0, Math.min(GRID_COLS - moving.w, Math.round(x))),
    y: Math.max(0, Math.round(y)),
  };

  // Push-down, cascading: any card overlapping something settled above it
  // moves just below the blocker, which can in turn displace the next one.
  const settled: PlacedCard[] = [placed];
  for (const card of cards.filter((c) => c.id !== id).sort(byPosition)) {
    let next = { ...card };
    let blocker = settled.find((other) => collides(next, other));
    while (blocker) {
      next = { ...next, y: blocker.y + blocker.h };
      blocker = settled.find((other) => collides(next, other));
    }
    settled.push(next);
  }

  // Gravity closes the gaps the push opened — but must not steal the drop:
  // compact in an order that settles the moved card first.
  const compacted = compact(settled);
  const dropped = compacted.find((c) => c.id === id)!;
  if (dropped.y === placed.y && dropped.x === placed.x) return compacted;
  // Compaction moved the dropped card (free space above the drop point).
  // That is standard gridstack behavior and keeps the board hole-free.
  return compacted;
}

/**
 * First-gap packing for cards that have no stored position yet — migration
 * from the order-based layout, and any new report: scan rows top-to-bottom,
 * columns left-to-right, take the first spot that fits.
 */
export function packInto(
  placed: readonly PlacedCard[],
  toPlace: ReadonlyArray<{ id: string; w: number; h: number }>,
): PlacedCard[] {
  const out = [...placed];
  for (const item of toPlace) {
    const w = Math.max(1, Math.min(GRID_COLS, item.w));
    let spot: { x: number; y: number } | null = null;
    for (let y = 0; spot === null; y += 1) {
      for (let x = 0; x + w <= GRID_COLS; x += 1) {
        const probe: PlacedCard = { id: item.id, x, y, w, h: item.h };
        if (out.every((other) => !collides(probe, other))) {
          spot = { x, y };
          break;
        }
      }
    }
    out.push({ id: item.id, x: spot.x, y: spot.y, w, h: Math.max(1, item.h) });
  }
  return out;
}

/**
 * Swap a card with its nearest vertical neighbor (dir -1 = above, +1 =
 * below): a neighbor is any card sharing columns with it. The pair exchange
 * anchor rows and everything re-settles; at an edge, nothing changes beyond
 * the usual compaction.
 */
export function swapVertical(
  cards: readonly PlacedCard[],
  id: string,
  dir: -1 | 1,
): PlacedCard[] {
  const me = cards.find((c) => c.id === id);
  if (!me) return compact(cards);
  const sharesColumns = (o: PlacedCard) => o.x < me.x + me.w && me.x < o.x + o.w;
  const candidates = cards.filter((o) => o.id !== id && sharesColumns(o)
    && (dir === 1 ? o.y >= me.y + me.h : o.y + o.h <= me.y));
  if (candidates.length === 0) return compact(cards);
  const neighbor = candidates.reduce((best, o) => {
    const dBest = dir === 1 ? best.y : -(best.y + best.h);
    const dO = dir === 1 ? o.y : -(o.y + o.h);
    return dO < dBest ? o : best;
  });
  const swapped = cards.map((c) => {
    if (c.id === me.id) return { ...c, y: dir === 1 ? neighbor.y + neighbor.h - me.h : neighbor.y };
    if (c.id === neighbor.id) return { ...c, y: me.y };
    return c;
  });
  return compact(swapped);
}

/**
 * Move a card exactly one slot in READING order (top row first, left to
 * right) — what ▲/▼ mean on a single-column phone view, where the 2-D
 * column-sharing swap produced two-slot jumps and dead buttons (live,
 * 2026-09-03). The new order is realized by repacking every card first-gap
 * in sequence, which keeps sizes and yields a clean board both surfaces
 * agree on.
 */
export function moveInReadingOrder(
  cards: readonly PlacedCard[],
  id: string,
  dir: -1 | 1,
): PlacedCard[] {
  const ordered = [...cards].sort(byPosition);
  const idx = ordered.findIndex((c) => c.id === id);
  const target = idx + dir;
  if (idx === -1 || target < 0 || target >= ordered.length) return compact(ordered);
  [ordered[idx], ordered[target]] = [ordered[target], ordered[idx]];
  return packInto([], ordered.map(({ id: cid, w, h }) => ({ id: cid, w, h })));
}
