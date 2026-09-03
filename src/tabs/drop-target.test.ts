import { describe, it, expect } from 'vitest';
import { dropTarget } from './drop-target';

/** Two 100×100 cards side by side, one below. */
const CELLS = [
  { id: 'a', left: 0, top: 0, width: 100, height: 100 },
  { id: 'b', left: 110, top: 0, width: 100, height: 100 },
  { id: 'c', left: 0, top: 110, width: 100, height: 100 },
  { id: 'dragged', left: 110, top: 110, width: 100, height: 100 },
];

describe('dropTarget', () => {
  it('hits the card directly under the pointer — anywhere on it', () => {
    // The live bug: only the inner chart area accepted a drop, so hovering a
    // card's header or padding did nothing. Geometry cares about the whole
    // cell.
    expect(dropTarget(CELLS, 10, 10, 'dragged')).toMatchObject({ id: 'a' });
    expect(dropTarget(CELLS, 115, 95, 'dragged')).toMatchObject({ id: 'b' });
  });

  it('front half means before, back half means after', () => {
    expect(dropTarget(CELLS, 20, 20, 'dragged')).toEqual({ id: 'a', after: false });
    expect(dropTarget(CELLS, 90, 90, 'dragged')).toEqual({ id: 'a', after: true });
  });

  it('never targets the dragged card itself, and misses empty space', () => {
    expect(dropTarget(CELLS, 150, 150, 'dragged')).toBeNull();
    expect(dropTarget(CELLS, 500, 500, 'dragged')).toBeNull();
  });

  it('ignores unmeasured (zero-size) cells instead of matching them all', () => {
    const zeros = CELLS.map((c) => ({ ...c, width: 0, height: 0 }));
    expect(dropTarget(zeros, 10, 10, 'dragged')).toBeNull();
  });
});
