/**
 * src/tabs/drop-target.ts
 *
 * Where a dragged card should land, by GEOMETRY over the whole cells.
 *
 * The elementFromPoint approach this replaces only matched the inner report
 * body (`data-report-id` lives there), so a card's header, tools, and padding
 * were dead zones — hovering "right on top" of a card frequently did nothing
 * (live, 2026-09-02). Rect hit-testing has no dead zones, and the halves rule
 * gives before/after placement instead of before-only.
 */

export interface DropCell {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The cell under the pointer, and which side of it the drop belongs on:
 * the front (top-left) half inserts before, the back half after — judged
 * diagonally so both horizontal neighbors and vertical stacks feel right.
 * Null when the pointer is over nothing (or the cells are unmeasured, as in
 * jsdom — callers fall back to elementFromPoint there).
 */
export function dropTarget(
  cells: readonly DropCell[],
  x: number,
  y: number,
  draggedId: string,
): { id: string; after: boolean } | null {
  for (const cell of cells) {
    if (cell.id === draggedId || cell.width <= 0 || cell.height <= 0) continue;
    if (x < cell.left || x > cell.left + cell.width) continue;
    if (y < cell.top || y > cell.top + cell.height) continue;
    const frac = ((x - cell.left) / cell.width + (y - cell.top) / cell.height) / 2;
    return { id: cell.id, after: frac > 0.5 };
  }
  return null;
}
