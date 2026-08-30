import { describe, it, expect, vi } from 'vitest';
import { readPoolStatus, readRunwayMonths, type PoolReportDeps } from './pool-report.js';

const CFG = JSON.stringify({ amountCents: 1_600_000, startDate: '2026-08-25', endDate: '2026-12-12' });

/** All-fake deps: this module is DI all the way down, so no vi.mock. */
const deps = (over: Partial<PoolReportDeps> = {}): PoolReportDeps => ({
  getSecret: vi.fn(async () => CFG),
  spendingBetween: vi.fn(() => ({ Groceries: 3000, Dining: 1400 })),
  uncategorizedTotal: vi.fn(() => ({ count: 2, total: 100 })),
  dismissedIds: vi.fn(async () => ['dismissed-1']),
  accountTypes: vi.fn(async () => ({ 'sfin-1': 'CASH', 'sfin-2': 'CREDIT_CARD', 'sfin-3': 'SECURITIES' })),
  accountBalances: vi.fn(async () => ({
    'sfin-1': { balance: 8000 },
    'sfin-2': { balance: -1500 },
    'sfin-3': { balance: 50_000 }, // investments are not liquid — excluded
  })),
  ...over,
});

describe('readPoolStatus', () => {
  it('is null with no pool configured, and reads nothing else', async () => {
    const d = deps({ getSecret: vi.fn(async () => null) });
    expect(await readPoolStatus(d, new Date('2026-10-01T12:00:00Z'))).toBeNull();
    expect(d.spendingBetween).not.toHaveBeenCalled();
  });

  it('totals categorized plus uncategorized spending over [start, tomorrow) mid-pool', async () => {
    const d = deps();
    const s = await readPoolStatus(d, new Date('2026-10-01T12:00:00Z'));
    // (3000 + 1400 + 100) dollars → cents.
    expect(s?.spentCents).toBe(450_000);
    expect(s?.phase).toBe('active');
    expect(d.spendingBetween).toHaveBeenCalledWith('2026-08-25', '2026-10-02');
    // Dismissed rows are excluded from the burn, matching the daily digest.
    expect(d.uncategorizedTotal).toHaveBeenCalledWith('2026-08-25', '2026-10-02', ['dismissed-1']);
  });

  it('stops counting spend at the day after the end date once the pool is over', async () => {
    const d = deps();
    const s = await readPoolStatus(d, new Date('2026-12-15T12:00:00Z'));
    expect(s?.phase).toBe('ended');
    expect(d.spendingBetween).toHaveBeenCalledWith('2026-08-25', '2026-12-13');
  });

  it('treats a malformed stored config as no pool', async () => {
    const d = deps({ getSecret: vi.fn(async () => '{"amountCents":-5}') });
    expect(await readPoolStatus(d, new Date('2026-10-01T12:00:00Z'))).toBeNull();
  });
});

describe('readRunwayMonths', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('divides liquid cash net of card debt by the trailing-90-day monthly average', async () => {
    // Liquid: 8000 − 1500 = 6500 (the securities account is excluded).
    // Spend: (3000 + 1400 + 100) over 90 days → 1500/mo → 4.3 months.
    const d = deps();
    expect(await readRunwayMonths(d, now)).toBe(4.3);
    expect(d.spendingBetween).toHaveBeenCalledWith('2026-07-03', '2026-10-02');
  });

  it('skips accounts with unreadable balances rather than counting them as zero', async () => {
    const d = deps({
      accountBalances: vi.fn(async () => ({
        'sfin-1': { balance: 8000 },
        'sfin-2': { balance: null },
      })),
    });
    expect(await readRunwayMonths(d, now)).toBe(5.3);
  });

  it('is null — unknowable, not infinite — without spending, balances, or types', async () => {
    expect(await readRunwayMonths(deps({
      spendingBetween: vi.fn(() => ({})),
      uncategorizedTotal: vi.fn(() => ({ count: 0, total: 0 })),
    }), now)).toBeNull();
    expect(await readRunwayMonths(deps({ accountBalances: vi.fn(async () => ({})) }), now)).toBeNull();
    expect(await readRunwayMonths(deps({ accountTypes: vi.fn(async () => { throw new Error('down'); }) }), now)).toBeNull();
  });
});
