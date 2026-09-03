import { describe, it, expect } from 'vitest';
import { compact, moveTo, packInto, collides, swapVertical, type PlacedCard } from './grid-engine.js';

const card = (id: string, x: number, y: number, w = 4, h = 4): PlacedCard => ({ id, x, y, w, h });

describe('collides', () => {
  it('detects overlap and clears adjacency', () => {
    expect(collides(card('a', 0, 0), card('b', 3, 3))).toBe(true);
    expect(collides(card('a', 0, 0), card('b', 4, 0))).toBe(false);
    expect(collides(card('a', 0, 0), card('b', 0, 4))).toBe(false);
  });
});

describe('compact', () => {
  it('pulls every card up into free space, keeping x', () => {
    // The gravity rule every dashboard library shares: no floating holes.
    const out = compact([card('a', 0, 6), card('b', 4, 9)]);
    expect(out.find((c) => c.id === 'a')).toMatchObject({ x: 0, y: 0 });
    expect(out.find((c) => c.id === 'b')).toMatchObject({ x: 4, y: 0 });
  });

  it('stacks same-column cards without overlap, top one first', () => {
    const out = compact([card('a', 0, 8), card('b', 0, 2)]);
    expect(out.find((c) => c.id === 'b')).toMatchObject({ y: 0 });
    expect(out.find((c) => c.id === 'a')).toMatchObject({ y: 4 });
  });
});

describe('moveTo', () => {
  it('drops the card exactly where asked and pushes the occupant down', () => {
    const out = moveTo([card('a', 0, 0), card('b', 0, 4)], 'b', 0, 0);
    expect(out.find((c) => c.id === 'b')).toMatchObject({ x: 0, y: 0 });
    // a pushed below b, not teleported elsewhere.
    expect(out.find((c) => c.id === 'a')).toMatchObject({ x: 0, y: 4 });
  });

  it('leaves unrelated columns completely alone', () => {
    // The complaint this exists to fix: moving one tile shifted everything.
    const out = moveTo([card('a', 0, 0), card('b', 0, 4), card('c', 8, 0, 4, 8)], 'b', 0, 0);
    expect(out.find((c) => c.id === 'c')).toMatchObject({ x: 8, y: 0 });
  });

  it('clamps to the grid so a wide card cannot hang off the right edge', () => {
    const out = moveTo([card('a', 0, 0, 8, 4)], 'a', 10, 0);
    expect(out.find((c) => c.id === 'a')).toMatchObject({ x: 4 });
  });
});

describe('packInto', () => {
  it('places new cards into the first gap scanning rows left to right', () => {
    const placed = [card('a', 0, 0, 8, 4)];
    const out = packInto(placed, [{ id: 'b', w: 4, h: 4 }, { id: 'c', w: 8, h: 4 }]);
    expect(out.find((c) => c.id === 'b')).toMatchObject({ x: 8, y: 0 });
    expect(out.find((c) => c.id === 'c')).toMatchObject({ x: 0, y: 4 });
  });
});

describe('swapVertical', () => {
  it('exchanges a card with the neighbor below it, respecting heights', () => {
    // Under gravity a "move down one row" is a no-op — the card falls back
    // up. The buttons therefore SWAP, which is what users mean by them.
    const out = swapVertical([card('a', 0, 0), card('b', 0, 4, 4, 8)], 'a', 1);
    expect(out.find((c) => c.id === 'b')).toMatchObject({ x: 0, y: 0 });
    expect(out.find((c) => c.id === 'a')).toMatchObject({ x: 0, y: 8 });
  });

  it('is a no-op at the board edge', () => {
    const cards = [card('a', 0, 0), card('b', 0, 4)];
    expect(swapVertical(cards, 'a', -1)).toEqual(compact(cards));
  });
});
