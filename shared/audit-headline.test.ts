import { describe, it, expect } from 'vitest';
import {
  explainHeadline, headlineAgrees, headlineReasonLine, headlineRowLine, headlineSummaryLine, headlineUnexplainedLine,
  reportSpendSign, zonedMonthBounds, HEADLINE_AGREE, HEADLINE_READ_NOTES, HEADLINE_REASON_KINDS,
  type HeadlineDbRow, type HeadlineFacts, type HeadlineRead,
} from './audit-headline';

let seq = 0;
const row = (over: Partial<HeadlineDbRow> = {}): HeadlineDbRow => {
  seq += 1;
  return {
    id: `act-${seq}`, date: '2026-10-05T00:00:00+00:00', accountId: 'wf-chk', groupId: '', accountName: 'PNC Checking', accountType: 'CASH',
    type: 'WITHDRAWAL', subtype: '', absCents: 1000, notes: `SHOP · TRN-${seq}`, spendingFilings: 1, categoryIds: ['cat-x'],
    ...over,
  };
};

/** One row for each of the five reasons, a late-month charge both sides
 *  count, and an ordinary purchase — in New York, west of UTC. */
function octoberFacts(): HeadlineFacts {
  return {
    month: '2026-10',
    timezone: 'America/New_York',
    reportCents: 130000,
    wealthfolioCents: 120000,
    excludedCategoryIds: ['cat-excluded'],
    rows: [
      row({ date: '2026-10-01T00:00:00+00:00', absCents: 2500, notes: 'RENT PORTAL · TRN-1' }),
      row({ date: '2026-10-20T00:00:00+00:00', absCents: 4000, notes: 'GYM · TRN-2' }),
      row({ type: 'TRANSFER_OUT', absCents: 600, categoryIds: [], spendingFilings: 0, notes: 'Balance adjustment · ACT-1 · 2026-10-02' }),
      row({ absCents: 1500, categoryIds: ['cat-excluded'], spendingCategoryId: 'cat-excluded', notes: 'TUITION · TRN-3' }),
      row({ absCents: 1200, spendingFilings: 2, categoryIds: ['cat-a', 'cat-b'], notes: 'SPLIT · TRN-4' }),
      row({ type: 'CREDIT', subtype: 'REFUND', absCents: 800, categoryIds: [], spendingFilings: 0, notes: 'RETURN · TRN-5' }),
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
  it('sizes each of the five reasons as its share of report − Wealthfolio', () => {
    const h = explainHeadline(octoberFacts());
    expect(h.reasons!.map((r) => [r.kind, r.cents, r.rows.length])).toEqual([
      ['first-midnight', 2500, 1],
      ['bookkeeping', -600, 1],
      ['excluded', 1500, 1],
      ['double-filed', 1200, 1],
      ['uncategorized-refund', 800, 1],
    ]);
    // 1,300.00 − 1,200.00 − (25 − 6 + 15 + 12 + 8)
    expect(h.unexplainedCents).toBe(10000 - 5400);
    expect(h.reasons![0].rows[0]).toEqual({ date: '2026-10-01', description: 'RENT PORTAL', cents: 2500, account: 'PNC Checking' });
  });

  it('counts a row filed three times twice over, and a placeholder neither side counts this month as no reason', () => {
    const h = explainHeadline({
      month: '2026-10', timezone: 'America/New_York', reportCents: 0, wealthfolioCents: 0, excludedCategoryIds: [],
      rows: [
        row({ absCents: 1000, spendingFilings: 3 }),
        // The report drops it by its marker; Wealthfolio, west of UTC, counts it in September.
        row({ date: '2026-10-01T00:00:00+00:00', type: 'TRANSFER_OUT', absCents: 300, categoryIds: [], spendingFilings: 0, notes: '↔️ In-transit transfer · ZELLE · TRN-9' }),
      ],
    });
    expect(h.reasons!.map((r) => [r.kind, r.cents])).toEqual([['double-filed', 2000]]);
  });

  it('says the two agree, and lists no reasons that have nothing in them', () => {
    const h = explainHeadline({ month: '2026-10', reportCents: 50000, wealthfolioCents: 50000, rows: [row()], excludedCategoryIds: [] });
    expect(headlineAgrees(h)).toBe(true);
    expect(h.reasons).toEqual([]);
    expect(HEADLINE_AGREE).toBe('The report and Wealthfolio agree this month.');
  });

  it('writes the lines: both figures, each reason, the rest, a row', () => {
    const h = explainHeadline(octoberFacts());
    expect(headlineSummaryLine(h)).toBe("The report counts $1,300.00 spent this month; Wealthfolio's Spending page counts $1,200.00.");
    expect(headlineReasonLine(h, h.reasons![0])).toBe("$25.00 — Dated the 1st at midnight UTC: Wealthfolio's month starts later west of UTC, so it counts these last month (1 row)");
    expect(headlineReasonLine(h, h.reasons![1])).toBe("-$6.00 — The add-on's own bookkeeping rows: Wealthfolio counts them; the report doesn't (1 row)");
    expect(headlineUnexplainedLine(h)).toBe('$46.00 not explained by these reasons');
    expect(headlineRowLine(h.reasons![4].rows[0])).toBe('Oct 5 · RETURN · -$8.00 · PNC Checking');
    expect(headlineReasonLine(h, { ...h.reasons![1], more: 4 })).toContain('(5 rows)');
  });

  it('shows the reasons against the gap’s direction when Wealthfolio counts more', () => {
    const facts = octoberFacts();
    facts.reportCents = 100000;
    facts.wealthfolioCents = 120000;
    const h = explainHeadline(facts);
    expect(headlineReasonLine(h, h.reasons![0]).startsWith('-$25.00 — ')).toBe(true);
    expect(headlineUnexplainedLine(h)).toBe('$254.00 not explained by these reasons');
  });

  it('keeps bank text raw', () => {
    const h = explainHeadline({
      month: '2026-10', timezone: 'America/New_York', excludedCategoryIds: [],
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
      month: '2026-10', timezone: 'America/New_York', excludedCategoryIds: [],
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
      month: '2026-10', excludedCategoryIds: ['cat-edu', 'cat-gone'],
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
      month: '2026-10', excludedCategoryIds: [],
      rows: [row({ absCents: 100, spendingCategoryId: 'cat-edu' })],
    });
    expect(h.reasons).toEqual([]);
  });
});

describe('a reason is a row exactly one side counts', () => {
  /** New York: Wealthfolio's October starts at 04:00 UTC on the 1st. */
  const facts = (over: Partial<HeadlineFacts>): HeadlineFacts => ({
    month: '2026-10', timezone: 'America/New_York', excludedCategoryIds: [], ...over,
  });
  const uncategorized = { categoryIds: [], spendingFilings: 0 };
  const card = { accountId: 'wf-card', accountName: 'Visa', accountType: 'CREDIT_CARD' };

  it('lists no reason when both sides count the same rows', () => {
    const h = explainHeadline(facts({
      reportCents: 15800, wealthfolioCents: 15800,
      spendingAccountIds: ['wf-chk', 'wf-card'], reportAccountIds: ['wf-chk', 'wf-card'],
      rows: [
        row({ absCents: 10000, notes: 'KROGER · TRN-1' }),
        // Entered in Wealthfolio 3.10 at New York's midnight: both put it in October.
        row({ date: '2026-10-01T04:00:00+00:00', absCents: 5000, notes: 'RENT · TRN-2' }),
        row({ ...card, absCents: 800, ...uncategorized, notes: 'UNFILED · TRN-3' }),
        // A linked card payment: neither side's spending.
        row({ date: '2026-10-01T00:00:00+00:00', type: 'TRANSFER_OUT', groupId: 'g1', absCents: 150000, ...uncategorized, notes: 'AUTOPAY · TRN-4' }),
        row({ ...card, date: '2026-10-01T00:00:00+00:00', type: 'TRANSFER_IN', groupId: 'g1', absCents: 150000, ...uncategorized, notes: 'PAYMENT · TRN-5' }),
        // An account neither side reads.
        row({ accountId: 'wf-other', date: '2026-10-01T00:00:00+00:00', absCents: 700, notes: 'ELSEWHERE · TRN-6' }),
        // A placeholder at midnight UTC on the 1st: the report drops it by its marker, Wealthfolio counts it in September.
        row({ date: '2026-10-01T00:00:00+00:00', type: 'TRANSFER_OUT', absCents: 300, ...uncategorized, notes: '↔️ In-transit transfer · ZELLE · TRN-7' }),
        // A cash starting balance moves no spending on either side.
        row({ type: 'DEPOSIT', absCents: 120000, ...uncategorized, notes: 'Starting balance · sfin-chk' }),
      ],
    }));
    expect(h.reasons).toEqual([]);
    expect(h.unexplainedCents).toBe(0);
    expect(headlineAgrees(h)).toBe(true);
  });

  it('(a) has no "after today" reason: both sides count the whole calendar month', () => {
    const h = explainHeadline(facts({
      reportCents: 5000, wealthfolioCents: 4000,
      rows: [
        row({ date: '2026-10-20T00:00:00+00:00', absCents: 5000, notes: 'GYM · TRN-1' }),
        row({ type: 'CREDIT', subtype: 'REFUND', absCents: 1000, ...uncategorized, notes: 'RETURN · TRN-2' }),
      ],
    }));
    expect(h.reasons).toEqual([{ kind: 'uncategorized-refund', cents: 1000, rows: [expect.objectContaining({ description: 'RETURN', cents: -1000 })] }]);
    expect(h.unexplainedCents).toBe(0);
    expect(headlineUnexplainedLine(h)).toBeNull();
    expect(HEADLINE_REASON_KINDS).not.toContain('future');
  });

  it('(b) names a real charge at midnight UTC on the 1st, never a linked transfer there', () => {
    const h = explainHeadline(facts({
      reportCents: 12000, wealthfolioCents: 10000,
      rows: [
        row({ date: '2026-10-01T00:00:00+00:00', type: 'TRANSFER_OUT', groupId: 'g-autopay', absCents: 150000, ...uncategorized, notes: 'AUTOPAY CITI · TRN-1' }),
        row({ ...card, date: '2026-10-01T00:00:00+00:00', type: 'TRANSFER_IN', groupId: 'g-autopay', absCents: 150000, ...uncategorized, notes: 'PAYMENT · TRN-2' }),
        row({ date: '2026-10-01T00:00:00+00:00', absCents: 2000, notes: 'PARKING · TRN-3' }),
        row({ absCents: 10000, notes: 'KROGER · TRN-4' }),
      ],
    }));
    expect(h.reasons).toEqual([{ kind: 'first-midnight', cents: 2000, rows: [expect.objectContaining({ description: 'PARKING', cents: 2000 })] }]);
    expect(h.unexplainedCents).toBe(0);
  });

  it('(d) east of UTC, midnight UTC on the 1st is already the 1st there: no reason', () => {
    expect(zonedMonthBounds('2026-10', 'Europe/Berlin').start).toBe('2026-09-30T22:00:00.000Z');
    const h = explainHeadline(facts({
      timezone: 'Europe/Berlin', reportCents: 2000, wealthfolioCents: 2000,
      rows: [row({ date: '2026-10-01T00:00:00+00:00', absCents: 2000, notes: 'BÄCKEREI · TRN-1' })],
    }));
    expect(h.reasons).toEqual([]);
  });

  it('only counts the accounts Wealthfolio’s Spending page reads', () => {
    const three = (accountId: string) => [
      row({ accountId, date: '2026-10-01T00:00:00+00:00', absCents: 2000, notes: 'PARKING · TRN-1' }),
      row({ accountId, date: '2026-10-03T00:00:00+00:00', type: 'TRANSFER_OUT', absCents: 600, ...uncategorized, notes: 'Balance adjustment · ACT-1 · 2026-10-03' }),
      row({ accountId, type: 'CREDIT', subtype: 'REFUND', absCents: 800, ...uncategorized, notes: 'RETURN · TRN-2' }),
    ];
    const off = explainHeadline(facts({ spendingAccountIds: ['wf-chk'], rows: three('wf-savings') }));
    expect(off.reasons).toEqual([]);
    const on = explainHeadline(facts({ spendingAccountIds: ['wf-chk'], rows: three('wf-chk') }));
    expect(on.reasons!.map((r) => [r.kind, r.cents])).toEqual([['first-midnight', 2000], ['bookkeeping', -600], ['uncategorized-refund', 800]]);
  });

  it('leaves an account the report does not cover (not mapped) to the remainder', () => {
    const h = explainHeadline(facts({
      reportCents: 0, wealthfolioCents: 2600, reportAccountIds: ['wf-chk'],
      rows: [
        row({ accountId: 'wf-cash-jar', date: '2026-10-01T00:00:00+00:00', absCents: 2000, notes: 'PARKING · TRN-1' }),
        row({ accountId: 'wf-cash-jar', date: '2026-10-03T00:00:00+00:00', type: 'TRANSFER_OUT', absCents: 600, ...uncategorized, notes: 'Balance adjustment · ACT-1 · 2026-10-03' }),
        row({ accountId: 'wf-cash-jar', absCents: 2000, notes: 'LUNCH · TRN-2' }),
      ],
    }));
    expect(h.reasons).toEqual([]);
    expect(h.unexplainedCents).toBe(-2600);
  });

  it('calls only the report’s marker exclusions bookkeeping; a card’s opening debt is an excluded category (3.9+)', () => {
    const debt = row({ ...card, absCents: 46460, notes: 'Starting balance · sfin-card', spendingCategoryId: 'cat-opening', categoryIds: ['cat-opening'] });
    const rows = [
      row({ date: '2026-10-03T00:00:00+00:00', type: 'TRANSFER_OUT', absCents: 600, ...uncategorized, notes: 'Balance adjustment · ACT-1 · 2026-10-03' }),
      row({ date: '2026-10-03T00:00:00+00:00', type: 'TRANSFER_OUT', absCents: 300, ...uncategorized, notes: '↔️ In-transit transfer · ZELLE · TRN-9' }),
      debt,
    ];
    const on39 = explainHeadline(facts({ excludedCategoryIds: ['cat-opening'], rows }));
    expect(on39.reasons!.map((r) => [r.kind, r.cents, r.rows.length])).toEqual([['bookkeeping', -900, 2], ['excluded', 46460, 1]]);
    // 3.8 has no exclusion: both sides count the debt.
    const on38 = explainHeadline(facts({ excludedCategoryIds: [], rows }));
    expect(on38.reasons!.map((r) => [r.kind, r.cents])).toEqual([['bookkeeping', -900]]);
  });

  it('a row Wealthfolio counts elsewhere is named once, its extra filings as double-filed', () => {
    const h = explainHeadline(facts({
      excludedCategoryIds: ['cat-edu'],
      rows: [
        row({ date: '2026-10-01T00:00:00+00:00', absCents: 1000, spendingFilings: 2, notes: 'SPLIT RENT · TRN-1' }),
        row({ absCents: 500, spendingFilings: 2, spendingCategoryId: 'cat-edu', notes: 'BOOKS · TRN-2' }),
        // Excluded AND at midnight on the 1st: Wealthfolio counts it in no month, so it is "excluded", not "last month".
        row({ date: '2026-10-01T00:00:00+00:00', absCents: 300, spendingCategoryId: 'cat-edu', notes: 'TUITION · TRN-3' }),
      ],
    }));
    expect(h.reasons!.map((r) => [r.kind, r.cents, r.rows.length])).toEqual([['first-midnight', 1000, 1], ['excluded', 800, 2], ['double-filed', 1500, 2]]);
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
