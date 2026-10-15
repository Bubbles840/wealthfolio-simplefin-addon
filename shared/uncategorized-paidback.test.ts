import { describe, it, expect } from 'vitest';
import { paidBackHidden } from './uncategorized.js';

const ROWS = [{ activityId: 'a' }, { activityId: 'b' }, { activityId: 'c' }];
const ASOF = '2026-10-14T12:00:00.000Z';

describe('a row filed as a payback leaves the needs-a-category list at once (W11)', () => {
  it('hides the rows filed since this publish, and only rows the publish lists', () => {
    expect([...paidBackHidden(ROWS, { a: '2026-10-14T12:05:00.000Z', z: '2026-10-14T12:05:00.000Z' }, ASOF)]).toEqual(['a']);
  });

  it('shows a row again once a publish made after the filing still lists it (a payback undone in Telegram)', () => {
    expect([...paidBackHidden(ROWS, { a: '2026-10-14T11:00:00.000Z' }, ASOF)]).toEqual([]);
  });

  it('hides it when either time cannot be read: the filing is the newer news', () => {
    expect([...paidBackHidden(ROWS, { a: 'garbage' }, ASOF)]).toEqual(['a']);
    expect([...paidBackHidden(ROWS, { b: '2026-10-14T11:00:00.000Z' }, '')]).toEqual(['b']);
  });

  it('hides nothing with nothing filed', () => {
    expect(paidBackHidden(ROWS, {}, ASOF).size).toBe(0);
  });
});
