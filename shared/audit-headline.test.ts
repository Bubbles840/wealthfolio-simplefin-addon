import { describe, it, expect } from 'vitest';
import {
  explainHeadline, headlineAgrees, headlineReasonLine, headlineRowLine, headlineSummaryLine, headlineUnexplainedLine,
  reportSpendSign, zonedMonthBounds, HEADLINE_AGREE, HEADLINE_READ_NOTES,
  type HeadlineDbRow, type HeadlineFacts, type HeadlineRead,
} from './audit-headline';

let seq = 0;
const row = (over: Partial<HeadlineDbRow> = {}): HeadlineDbRow => {
  seq += 1;
  return {
    id: `act-${seq}`, date: '2026-10-05T00:00:00+00:00', accountName: 'PNC Checking', accountType: 'CASH',
    type: 'WITHDRAWAL', subtype: '', absCents: 1000, notes: `SHOP · TRN-${seq}`, spendingFilings: 1, categoryIds: ['cat-x'],
    ...over,
  };
};

/** One row for each of the script's six reasons, plus an ordinary purchase. */
function octoberFacts(): HeadlineFacts {
  return {
    month: '2026-10',
    today: '2026-10-13',
    reportCents: 130000,
    wealthfolioCents: 120000,
    excludedCategoryIds: ['cat-excluded'],
    rows: [
      row({ date: '2026-10-01T00:00:00+00:00', absCents: 2500, notes: 'RENT PORTAL · TRN-1' }),
      row({ date: '2026-10-20T00:00:00+00:00', absCents: 4000, notes: 'GYM · TRN-2' }),
      row({ type: 'TRANSFER_OUT', absCents: 600, categoryIds: [], notes: 'Balance adjustment · ACT-1 · 2026-10-02' }),
      row({ absCents: 1500, categoryIds: ['cat-excluded'], spendingCategoryId: 'cat-excluded', notes: 'TUITION · TRN-3' }),
      row({ absCents: 1200, spendingFilings: 2, categoryIds: ['cat-a', 'cat-b'], notes: 'SPLIT · TRN-4' }),
      row({ type: 'CREDIT', subtype: 'REFUND', absCents: 800, categoryIds: [], notes: 'RETURN · TRN-5' }),
      row({ absCents: 9999, notes: 'KROGER · TRN-6' }),
    ],
  };
}

describe('reportSpendSign', () => {
  it('is the report’s own sign: card credits refund, cash credits only with a refund subtype', () => {
    expect(reportSpendSign({ accountType: 'CREDIT_CARD', type: 'INTEREST', subtype: '' })).toBe(1);
    expect(reportSpendSign({ accountType: 'CREDIT_CARD', type: 'CREDIT', subtype: '' })).toBe(-1);
    expect(reportSpendSign({ accountType: 'CASH', type: 'TRANSFER_OUT', subtype: '' })).toBe(1);
    expect(reportSpendSign({ accountType: 'CASH', type: 'CREDIT', subtype: 'REIMBURSEMENT' })).toBe(-1);
    expect(reportSpendSign({ accountType: 'CASH', type: 'CREDIT', subtype: '' })).toBe(0);
    expect(reportSpendSign({ accountType: 'SECURITIES', type: 'WITHDRAWAL', subtype: '' })).toBe(0);
  });
});

describe('explainHeadline', () => {
  it('sizes each of the six reasons as its share of report − Wealthfolio', () => {
    const h = explainHeadline(octoberFacts());
    expect(h.reasons!.map((r) => [r.kind, r.cents, r.rows.length])).toEqual([
      ['first-midnight', 2500, 1],
      ['future', 4000, 1],
      ['bookkeeping', -600, 1],
      ['excluded', 1500, 1],
      ['double-filed', 1200, 1],
      ['uncategorized-refund', 800, 1],
    ]);
    // 1,300.00 − 1,200.00 − (25 + 40 − 6 + 15 + 12 + 8)
    expect(h.unexplainedCents).toBe(10000 - 9400);
    expect(h.reasons![0].rows[0]).toEqual({ date: '2026-10-01', description: 'RENT PORTAL', cents: 2500, account: 'PNC Checking' });
  });

  it('counts a row filed three times twice over, and keeps the sync’s own rows out of every other reason', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', reportCents: 0, wealthfolioCents: 0, excludedCategoryIds: [],
      rows: [
        row({ absCents: 1000, spendingFilings: 3 }),
        row({ date: '2026-10-01T00:00:00+00:00', type: 'TRANSFER_OUT', absCents: 300, notes: '↔️ In-transit transfer · ZELLE · TRN-9' }),
      ],
    });
    expect(h.reasons!.map((r) => [r.kind, r.cents])).toEqual([['bookkeeping', -300], ['double-filed', 2000]]);
  });

  it('only finds rows dated after today in the current month', () => {
    const facts = octoberFacts();
    facts.today = '2026-11-02';
    expect(explainHeadline(facts).reasons!.map((r) => r.kind)).not.toContain('future');
  });

  it('says the two agree, and lists no reasons that have nothing in them', () => {
    const h = explainHeadline({ month: '2026-10', today: '2026-10-13', reportCents: 50000, wealthfolioCents: 50000, rows: [row()], excludedCategoryIds: [] });
    expect(headlineAgrees(h)).toBe(true);
    expect(h.reasons).toEqual([]);
    expect(HEADLINE_AGREE).toBe('The report and Wealthfolio agree this month.');
  });

  it('writes the lines: both figures, each reason, the rest, a row', () => {
    const h = explainHeadline(octoberFacts());
    expect(headlineSummaryLine(h)).toBe("The report counts $1,300.00 spent this month; Wealthfolio's Spending page counts $1,200.00.");
    expect(headlineReasonLine(h, h.reasons![0])).toBe("$25.00 — Dated the 1st at midnight UTC: Wealthfolio's month starts later west of UTC, so it counts these last month (1 row)");
    expect(headlineReasonLine(h, h.reasons![2])).toBe("-$6.00 — The add-on's own bookkeeping rows: Wealthfolio counts them; the report doesn't (1 row)");
    expect(headlineUnexplainedLine(h)).toBe('$6.00 not explained by these reasons');
    expect(headlineRowLine(h.reasons![5].rows[0])).toBe('Oct 5 · RETURN · -$8.00 · PNC Checking');
    expect(headlineReasonLine(h, { ...h.reasons![1], more: 4 })).toContain('(5 rows)');
  });

  it('shows the reasons against the gap’s direction when Wealthfolio counts more', () => {
    const facts = octoberFacts();
    facts.reportCents = 100000;
    facts.wealthfolioCents = 120000;
    const h = explainHeadline(facts);
    expect(headlineReasonLine(h, h.reasons![0]).startsWith('-$25.00 — ')).toBe(true);
    expect(headlineUnexplainedLine(h)).toBe('$294.00 not explained by these reasons');
  });

  it('keeps bank text raw', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', excludedCategoryIds: [],
      rows: [row({ date: '2026-10-01T00:00:00+00:00', notes: 'SQ *COFFEE_CLUB [2] · TRN-1', accountName: "Joe's *Visa*" })],
    });
    expect(h.reasons![0].rows[0]).toMatchObject({ description: 'SQ *COFFEE_CLUB [2]', account: "Joe's *Visa*" });
  });

  it.each<HeadlineRead>(['report', 'wealthfolio', 'ledger', 'settings'])('a failed %s read says so and leaves out only its own part', (read) => {
    const facts = octoberFacts();
    if (read === 'report') delete facts.reportCents;
    if (read === 'wealthfolio') delete facts.wealthfolioCents;
    if (read === 'ledger') delete facts.rows;
    if (read === 'settings') delete facts.excludedCategoryIds;
    facts.failed = [read];
    const h = explainHeadline(facts);
    expect(h.notes).toEqual([HEADLINE_READ_NOTES[read]]);
    if (read === 'report') {
      expect(h.unexplainedCents).toBeNull();
      expect(headlineSummaryLine(h)).toBe("Wealthfolio's Spending page counts $1,200.00 spent this month.");
    }
    if (read === 'wealthfolio') expect(headlineSummaryLine(h)).toBe('The report counts $1,300.00 spent this month.');
    if (read === 'ledger') {
      // Never "nothing explains it": the reasons were not looked for.
      expect(h.reasons).toBeNull();
      expect(h.unexplainedCents).toBeNull();
      expect(headlineAgrees(h)).toBe(false);
    }
    if (read === 'settings') expect(h.reasons!.map((r) => r.kind)).not.toContain('excluded');
  });
});

describe('Wealthfolio 3.8 to 3.10', () => {
  it('counts only a row stored at 00:00 UTC on the 1st, not one at a local midnight (3.10)', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', excludedCategoryIds: [],
      rows: [
        row({ id: 'utc', date: '2026-10-01T00:00:00+00:00' }),
        row({ id: 'utc-z', date: '2026-10-01T00:00:00Z' }),
        row({ id: 'ny', date: '2026-10-01T04:00:00+00:00' }),
        row({ id: 'offset', date: '2026-10-01T00:00:00-04:00' }),
      ],
    });
    expect(h.reasons).toEqual([{ kind: 'first-midnight', cents: 2000, rows: expect.any(Array) }]);
    expect(h.reasons![0].rows).toHaveLength(2);
  });

  it('excludes what Wealthfolio excludes (3.9+): the earliest spending filing, an excluded category or any descendant', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', excludedCategoryIds: ['cat-edu', 'cat-gone'],
      categoryParents: { 'cat-edu': null, 'cat-books': 'cat-edu', 'cat-used-books': 'cat-books', 'cat-food': null, 'cat-loop-a': 'cat-loop-b', 'cat-loop-b': 'cat-loop-a' },
      rows: [
        row({ id: 'edu', absCents: 100, spendingCategoryId: 'cat-edu' }),
        row({ id: 'grandchild', absCents: 200, spendingCategoryId: 'cat-used-books' }),
        row({ id: 'deleted-category', absCents: 400, spendingCategoryId: 'cat-gone' }),
        row({ id: 'food', absCents: 800, spendingCategoryId: 'cat-food', categoryIds: ['cat-food', 'cat-edu'] }),
        row({ id: 'loop', absCents: 1600, spendingCategoryId: 'cat-loop-a' }),
      ],
    });
    expect(h.reasons).toMatchObject([{ kind: 'excluded', cents: 700 }]);
  });

  it('excludes nothing on Wealthfolio 3.8, which has no such setting', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', excludedCategoryIds: [],
      rows: [row({ absCents: 100, spendingCategoryId: 'cat-edu' })],
    });
    expect(h.reasons).toEqual([]);
  });
});

describe('zonedMonthBounds', () => {
  it('is the calendar month in Wealthfolio’s timezone, as its Spending page asks for it', () => {
    expect(zonedMonthBounds('2026-10', 'America/New_York')).toEqual({ start: '2026-10-01T04:00:00.000Z', end: '2026-11-01T03:59:59.999Z' });
    expect(zonedMonthBounds('2027-01', 'America/Los_Angeles')).toEqual({ start: '2027-01-01T08:00:00.000Z', end: '2027-02-01T07:59:59.999Z' });
    expect(zonedMonthBounds('2026-10', 'UTC')).toEqual({ start: '2026-10-01T00:00:00.000Z', end: '2026-10-31T23:59:59.999Z' });
  });

  it('crosses a daylight-saving change inside the month', () => {
    expect(zonedMonthBounds('2026-03', 'America/New_York')).toEqual({ start: '2026-03-01T05:00:00.000Z', end: '2026-04-01T03:59:59.999Z' });
  });

  it('uses the process’s own zone with no setting, or one it does not know', () => {
    const local = { start: new Date(2026, 9, 1).toISOString(), end: new Date(2026, 9, 31, 23, 59, 59, 999).toISOString() };
    expect(zonedMonthBounds('2026-10', null)).toEqual(local);
    expect(zonedMonthBounds('2026-10', 'Mars/Olympus_Mons')).toEqual(local);
  });
});
