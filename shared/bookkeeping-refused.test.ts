import { describe, it, expect } from 'vitest';
import { bookkeepingChange, BOOKKEEPING_REFUSED_IDS } from './change-entries';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);

describe('a one-time pass names at most 200 rows Wealthfolio refused (1.62)', () => {
  it.each(['date-repair', 'card-transfer-out'] as const)('%s: lists the first 200, counts them all', (step) => {
    const entry = bookkeepingChange({ step, activityIds: ['a1'], refused: ids(250) });
    expect(BOOKKEEPING_REFUSED_IDS).toBe(200);
    expect(entry.after).toMatchObject({ refused: ids(200), refusedCount: 250 });
    expect(entry.summary).toContain('Wealthfolio refused 250 rows');
  });

  it('lists a short list whole, with its count', () => {
    expect(bookkeepingChange({ step: 'date-repair', activityIds: [], refused: ['x', 'y'] }).after).toMatchObject({ refused: ['x', 'y'], refusedCount: 2 });
  });
});
