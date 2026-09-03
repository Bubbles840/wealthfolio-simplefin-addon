import { describe, it, expect } from 'vitest';
import { detectSubscriptions } from './subscriptions.js';

const NOW = new Date('2026-09-02T12:00:00Z');
const charge = (date: string, merchant: string, cents: number) => ({ date, merchant, cents });

describe('detectSubscriptions', () => {
  it('finds a monthly charge with a stable amount', () => {
    const found = detectSubscriptions([
      charge('2026-06-15', 'NETFLIX.COM', 1549),
      charge('2026-07-15', 'NETFLIX.COM', 1549),
      charge('2026-08-15', 'NETFLIX.COM', 1549),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: 'NETFLIX.COM',
      monthlyCents: 1549,
      count: 3,
      lastDate: '2026-08-15',
      lastCents: 1549,
      creep: false,
    });
  });

  it('needs at least three charges', () => {
    // Two same-priced charges a month apart happen by coincidence constantly
    // (two grocery runs, two tanks of gas); three on a cadence do not.
    expect(detectSubscriptions([
      charge('2026-07-15', 'HULU', 999),
      charge('2026-08-15', 'HULU', 999),
    ], NOW)).toEqual([]);
  });

  it('rejects merchants visited often but not on a monthly cadence', () => {
    expect(detectSubscriptions([
      charge('2026-08-01', 'CHIPOTLE', 1200),
      charge('2026-08-04', 'CHIPOTLE', 1150),
      charge('2026-08-19', 'CHIPOTLE', 1275),
    ], NOW)).toEqual([]);
  });

  it('rejects a cadence whose amounts swing too much to be a price', () => {
    expect(detectSubscriptions([
      charge('2026-06-01', 'SHELL OIL', 3000),
      charge('2026-07-01', 'SHELL OIL', 5200),
      charge('2026-08-01', 'SHELL OIL', 2100),
    ], NOW)).toEqual([]);
  });

  it('drops a subscription that has stopped charging', () => {
    // Cancelled is the good outcome; listing it forever would nag about money
    // no longer leaving.
    expect(detectSubscriptions([
      charge('2026-01-10', 'OLD GYM', 2500),
      charge('2026-02-10', 'OLD GYM', 2500),
      charge('2026-03-10', 'OLD GYM', 2500),
    ], NOW)).toEqual([]);
  });

  it('flags price creep when the newest charge tops the typical price', () => {
    const found = detectSubscriptions([
      charge('2026-06-20', 'SPOTIFY', 1099),
      charge('2026-07-20', 'SPOTIFY', 1099),
      charge('2026-08-20', 'SPOTIFY', 1199),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].creep).toBe(true);
    // The recurring price is the typical charge, not the crept one.
    expect(found[0].monthlyCents).toBe(1099);
    expect(found[0].lastCents).toBe(1199);
  });

  it('orders results by monthly cost, biggest first', () => {
    const sub = (m: string, cents: number) => [
      charge(`2026-06-05`, m, cents), charge(`2026-07-05`, m, cents), charge(`2026-08-05`, m, cents),
    ];
    const found = detectSubscriptions([...sub('SPOTIFY', 1099), ...sub('ADOBE', 5499)], NOW);
    expect(found.map((s) => s.name)).toEqual(['ADOBE', 'SPOTIFY']);
  });
});
