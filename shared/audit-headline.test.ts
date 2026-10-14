import { describe, it, expect } from 'vitest';
import {
  explainHeadline, headlineAgreeLine, headlineAgrees, headlineReasonLine, headlineRowLine, headlineSummaryLine, headlineUnexplainedLine,
  zonedMonthBounds, HEADLINE_AGREE, HEADLINE_READ_NOTES, HEADLINE_REASON_KINDS,
  type HeadlineDbRow, type HeadlineFacts, type HeadlineRead,
} from './audit-headline';
import { spendLines, spentCents } from './wf-spending';

let seq = 0;
const filed = (categoryId: string, createdAt = '2026-10-05T13:00:00Z') => {
  seq += 1;
  return { id: `asg-${seq}`, categoryId, createdAt, source: 'manual' };
};
const row = (over: Partial<HeadlineDbRow> = {}): HeadlineDbRow => {
  seq += 1;
  return {
    id: `act-${seq}`, date: '2026-10-05T12:00:00+00:00', accountId: 'wf-chk', groupId: '', accountName: 'PNC Checking', accountType: 'CASH',
    type: 'WITHDRAWAL', subtype: '', absCents: 1000, notes: `SHOP · TRN-${seq}`, filings: [filed('cat-x')], splits: [],
    ...over,
  };
};
const unfiled = { filings: [] };
const card = { accountId: 'wf-card', accountName: 'Visa', accountType: 'CREDIT_CARD' };

/** The report's "Spent this month" for these rows: the lines the companion's
 *  readers build the cube from (companion/src/sqlite-native.ts), in the
 *  report's accounts and month. */
function reportCentsFor(f: HeadlineFacts): number {
  const covered = f.reportAccountIds ? new Set(f.reportAccountIds) : null;
  const lines = spendLines((f.rows ?? []).filter((r) => !covered || covered.has(r.accountId)), {
    timezone: f.timezone ?? null, spendingAccountIds: f.spendingAccountIds ?? null,
    excludedCategoryIds: f.excludedCategoryIds ?? [], categoryParents: f.categoryParents ?? {},
  });
  return spentCents(lines.filter((l) => l.month === f.month));
}

/** New York: Wealthfolio's October starts at 04:00 UTC on the 1st. */
const october = (over: Partial<HeadlineFacts>): HeadlineFacts => ({
  month: '2026-10', timezone: 'America/New_York', excludedCategoryIds: [], spendingAccountIds: ['wf-chk', 'wf-card'], reportAccountIds: ['wf-chk', 'wf-card'], ...over,
});

describe('the agreement matrix — each rule 1.61 named a reason for is now the same on both sides', () => {
  // Wealthfolio's figure is worked out by hand from upstream's rules
  // (crates/spending insight/service.rs, activity_classification.rs,
  // activity_allocations.rs, category_exclusions.rs); the report's comes from
  // the shared definition. Each case used to differ by the amount in its name.
  it.each<[string, HeadlineFacts, number]>([
    ['excluded categories, and a descendant (used to differ by $15.00)', october({
      excludedCategoryIds: ['cat-edu'], categoryParents: { 'cat-edu': null, 'cat-tuition': 'cat-edu', 'cat-food': null },
      rows: [row({ absCents: 1500, filings: [filed('cat-tuition')] }), row({ absCents: 10000, filings: [filed('cat-food')] })],
    }), 10000],
    ['a row filed under two categories counts once, under its earliest filing (used to differ by $12.00)', october({
      rows: [row({ absCents: 1200, filings: [filed('cat-b', '2026-10-06T00:00:00Z'), filed('cat-a', '2026-10-05T00:00:00Z')] })],
    }), 1200],
    ['a refund with no category is netted (used to differ by $8.00)', october({
      rows: [row({ absCents: 5000 }), row({ type: 'CREDIT', subtype: 'REFUND', absCents: 800, ...unfiled }), row({ ...card, type: 'CREDIT', absCents: 300, ...unfiled })],
    }), 3900],
    ['a row stored at 00:00 UTC on the 1st is September’s west of UTC (used to differ by $25.00)', october({
      rows: [
        row({ date: '2026-10-01T00:00:00+00:00', absCents: 2500 }),
        row({ date: '2026-10-01T12:00:00+00:00', absCents: 1000 }),
        row({ date: '2026-11-01T00:00:00+00:00', absCents: 4000 }),
      ],
    }), 5000],
    ['a linked transfer out of the spending accounts is a saving, not spending', october({
      rows: [
        row({ type: 'TRANSFER_OUT', groupId: 'g-sav', absCents: 50000, ...unfiled, notes: 'TO SAVINGS · TRN-1' }),
        row({ accountId: 'wf-sav', accountType: 'CASH', type: 'TRANSFER_IN', groupId: 'g-sav', absCents: 50000, ...unfiled }),
        row({ ...card, type: 'TRANSFER_IN', groupId: 'g-pay', absCents: 9000, ...unfiled }),
        row({ type: 'TRANSFER_OUT', groupId: 'g-pay', absCents: 9000, filings: [filed('cat-x')] }),
        row({ absCents: 2000 }),
      ],
    }), 2000],
    ['an activity type override is the type Wealthfolio counts', october({
      rows: [
        row({ type: 'DEPOSIT', typeOverride: 'WITHDRAWAL', absCents: 3000 }),
        row({ type: 'WITHDRAWAL', typeOverride: 'DEPOSIT', absCents: 7000 }),
        row({ type: 'WITHDRAWAL', typeOverride: '', absCents: 100 }),
      ],
    }), 3100],
    ['the sync’s bookkeeping rows, filed under an excluded category (3.9+; used to differ by $10.00)', october({
      excludedCategoryIds: ['cat-sync-bookkeeping'], categoryParents: { 'cat-sync-bookkeeping': null },
      rows: [
        row({ type: 'TRANSFER_OUT', absCents: 1000, filings: [filed('cat-sync-bookkeeping')], notes: '↔️ In-transit transfer · ZELLE · TRN-9' }),
        row({ absCents: 2000 }),
      ],
    }), 2000],
    ['the sync’s bookkeeping rows on 3.8, which has no exclusions: both sides count them', october({
      rows: [
        row({ type: 'TRANSFER_OUT', absCents: 600, ...unfiled, notes: 'Balance adjustment · ACT-1 · 2026-10-02' }),
        row({ absCents: 2000 }),
      ],
    }), 2600],
  ])('%s', (_name, facts, wealthfolio) => {
    const report = reportCentsFor(facts);
    expect(report).toBe(wealthfolio);
    const h = explainHeadline({ ...facts, reportCents: report, wealthfolioCents: wealthfolio });
    expect(h.reasons).toEqual([]);
    expect(h.unexplainedCents).toBe(0);
    expect(headlineAgrees(h)).toBe(true);
  });
});

describe('explainHeadline', () => {
  /** Two rows on an account Wealthfolio reads that the add-on does not map. */
  const jar = (): HeadlineFacts => october({
    spendingAccountIds: ['wf-chk', 'wf-jar'], reportAccountIds: ['wf-chk'], reportCents: 10000, wealthfolioCents: 12600,
    rows: [
      row({ absCents: 10000, notes: 'KROGER · TRN-1' }),
      row({ accountId: 'wf-jar', accountName: "Joe's *Jar*", absCents: 2000, notes: 'SQ *COFFEE_CLUB [2] · TRN-2' }),
      row({ accountId: 'wf-jar', accountName: "Joe's *Jar*", type: 'CREDIT', subtype: 'REFUND', absCents: 400, ...unfiled, notes: 'RETURN · TRN-3' }),
      row({ accountId: 'wf-jar', accountName: "Joe's *Jar*", date: '2026-10-01T00:00:00+00:00', absCents: 9000, notes: 'SEPTEMBER · TRN-4' }),
    ],
  });

  it('names what Wealthfolio counts on an account the add-on does not sync', () => {
    const h = explainHeadline(jar());
    expect(h.reasons).toEqual([{
      kind: 'not-covered', cents: -1600, rows: [
        { date: '2026-10-05', description: 'SQ *COFFEE_CLUB [2]', cents: 2000, account: "Joe's *Jar*" },
        { date: '2026-10-05', description: 'RETURN', cents: -400, account: "Joe's *Jar*" },
      ],
    }]);
    // 100.00 − 126.00 − (−16.00)
    expect(h.unexplainedCents).toBe(-1000);
  });

  it('writes the lines: both figures, the reason, the rest, a row — bank text raw', () => {
    const h = explainHeadline(jar());
    expect(headlineSummaryLine(h)).toBe("The report counts $100.00 spent this month; Wealthfolio's Spending page counts $126.00.");
    expect(headlineReasonLine(h, h.reasons![0])).toBe("$16.00 — On accounts the add-on doesn't sync: Wealthfolio's Spending page reads them; the report covers only the accounts the add-on syncs (2 rows)");
    expect(headlineUnexplainedLine(h)).toBe('$10.00 not explained by these reasons');
    expect(headlineRowLine(h.reasons![0].rows[0])).toBe("Oct 5 · SQ *COFFEE_CLUB [2] · $20.00 · Joe's *Jar*");
    expect(headlineReasonLine(h, { ...h.reasons![0], more: 4 })).toContain('(6 rows)');
  });

  it('says the two agree, and lists no reason that has nothing in it', () => {
    const h = explainHeadline({ month: '2026-10', reportCents: 50000, wealthfolioCents: 50000, rows: [row()], excludedCategoryIds: [] });
    expect(headlineAgrees(h)).toBe(true);
    expect(h.reasons).toEqual([]);
    expect(HEADLINE_AGREE).toBe('The report and Wealthfolio agree this month.');
  });

  it('still reads the five kinds a 1.61 companion published, and finds only not-covered itself', () => {
    expect(HEADLINE_REASON_KINDS).toEqual(['not-covered', 'foreign-currency', 'first-midnight', 'bookkeeping', 'excluded', 'double-filed', 'uncategorized-refund']);
    const h = explainHeadline(jar());
    // Shown against the gap's direction, as every reason is: Wealthfolio counts more here.
    expect(headlineReasonLine(h, { kind: 'first-midnight', cents: 2500, rows: [] })).toBe(
      "-$25.00 — Dated the 1st at midnight UTC: Wealthfolio's month starts later west of UTC, so it counts these last month (0 rows)",
    );
  });

  describe('amounts in another currency (1.62, ruling LU-B)', () => {
    const eur = (): HeadlineFacts => october({
      baseCurrency: 'usd', reportCents: 12000, wealthfolioCents: 12900,
      rows: [
        row({ absCents: 10000, currency: 'USD', notes: 'KROGER · TRN-1' }),
        row({ absCents: 2000, currency: 'EUR', notes: 'BOULANGERIE · TRN-2' }),
        row({ absCents: 500, currency: '', notes: 'NO CURRENCY · TRN-3' }),
      ],
    });

    it('names the rows whose currency is not the base currency, and sizes them by the difference the conversion leaves', () => {
      const h = explainHeadline(eur());
      expect(h.reasons).toEqual([{
        kind: 'foreign-currency', cents: -900,
        rows: [{ date: '2026-10-05', description: 'BOULANGERIE', cents: 2000, account: 'PNC Checking' }],
      }]);
      expect(h.unexplainedCents).toBe(0);
      expect(h.baseCurrency).toBe('USD');
    });

    it('never explains more than its own rows: a $3 euro row cannot account for a $500 gap', () => {
      const h = explainHeadline({
        ...eur(), reportCents: 62500, wealthfolioCents: 12500,
        rows: [row({ absCents: 300, currency: 'EUR', notes: 'CAFE · TRN-9' })],
      });
      expect(h.reasons).toEqual([{ kind: 'foreign-currency', cents: 300, rows: [{ date: '2026-10-05', description: 'CAFE', cents: 300, account: 'PNC Checking' }] }]);
      expect(h.unexplainedCents).toBe(49700);
      // And the other way: Wealthfolio counts $500 more.
      const under = explainHeadline({ ...eur(), reportCents: 12500, wealthfolioCents: 62500, rows: [row({ absCents: 300, currency: 'EUR' })] });
      expect(under.reasons![0].cents).toBe(-300);
      expect(under.unexplainedCents).toBe(-49700);
    });

    it('names no reason, and prints no "$0.00" line, when the two already agree', () => {
      const h = explainHeadline({ ...eur(), reportCents: 12500, wealthfolioCents: 12500, rows: [row({ absCents: 2000, currency: 'EUR' })] });
      expect(h.reasons).toEqual([]);
      expect(h.unexplainedCents).toBe(0);
    });

    it('is labelled and explained in the base currency', () => {
      const h = explainHeadline(eur());
      expect(headlineReasonLine(h, h.reasons![0])).toBe(
        "$9.00 — Amounts in another currency: Wealthfolio converts them to USD; the report doesn't (1 row)",
      );
    });

    it('finds nothing when every row is in the base currency, or the base currency is unread', () => {
      expect(explainHeadline({ ...eur(), rows: [row({ currency: 'usd' })] }).reasons).toEqual([]);
      expect(explainHeadline({ ...eur(), baseCurrency: undefined }).reasons).toEqual([]);
      expect(explainHeadline({ ...eur(), baseCurrency: null }).reasons).toEqual([]);
    });

    it('leaves a foreign row on an unsynced account to not-covered, and counts a month’s own rows only', () => {
      const h = explainHeadline(october({
        baseCurrency: 'USD', spendingAccountIds: ['wf-chk', 'wf-jar'], reportAccountIds: ['wf-chk'], reportCents: 0, wealthfolioCents: 2000,
        rows: [row({ accountId: 'wf-jar', accountName: 'Jar', currency: 'EUR', absCents: 2000 }), row({ date: '2026-09-05T12:00:00+00:00', currency: 'EUR' })],
      }));
      expect(h.reasons!.map((r) => r.kind)).toEqual(['not-covered']);
    });
  });

  it('an unreadable account mapping is a note, never a silent empty list of reasons', () => {
    const facts = jar();
    delete facts.reportAccountIds;
    facts.failed = ['mapping'];
    const h = explainHeadline(facts);
    expect(h.notes).toEqual([HEADLINE_READ_NOTES.mapping]);
    expect(HEADLINE_READ_NOTES.mapping).toMatch(/account mapping/);
  });

  it.each<HeadlineRead>(['report', 'wealthfolio', 'ledger', 'settings'])('a failed %s read says so and leaves out only its own part', (read) => {
    const facts = jar();
    if (read === 'report') delete facts.reportCents;
    if (read === 'wealthfolio') delete facts.wealthfolioCents;
    if (read === 'ledger') delete facts.rows;
    if (read === 'settings') delete facts.excludedCategoryIds;
    facts.failed = [read];
    const h = explainHeadline(facts);
    expect(h.notes).toEqual([HEADLINE_READ_NOTES[read]]);
    if (read === 'report') {
      expect(h.unexplainedCents).toBeNull();
      expect(headlineSummaryLine(h)).toBe("Wealthfolio's Spending page counts $126.00 spent this month.");
    }
    if (read === 'wealthfolio') expect(headlineSummaryLine(h)).toBe('The report counts $100.00 spent this month.');
    if (read === 'ledger') {
      // Never "nothing explains it": the reasons were not looked for.
      expect(h.reasons).toBeNull();
      expect(h.unexplainedCents).toBeNull();
      expect(headlineAgrees(h)).toBe(false);
    }
    if (read === 'settings') expect(h.reasons!.map((r) => r.kind)).toEqual(['not-covered']);
  });
});

describe('Wealthfolio 3.8 to 3.10', () => {
  it('a 3.10 local midnight and a noon write both fall in October; a 3.8 bare date at 00:00 UTC does not', () => {
    const rows = [
      row({ id: 'utc', date: '2026-10-01T00:00:00+00:00', absCents: 100 }),
      row({ id: 'bare', date: '2026-10-01', absCents: 200 }),
      row({ id: 'ny', date: '2026-10-01T04:00:00+00:00', absCents: 400 }),
      row({ id: 'noon', date: '2026-10-01T12:00:00Z', absCents: 800 }),
    ];
    expect(reportCentsFor(october({ rows }))).toBe(1200);
    // East of UTC midnight UTC is already the 1st.
    expect(reportCentsFor(october({ timezone: 'Europe/Berlin', rows }))).toBe(1500);
  });
});

describe('a snapshot from another month', () => {
  const h = (month: string, agree = false) => explainHeadline({ month, reportCents: 130000, wealthfolioCents: agree ? 130000 : 120000, rows: [] });

  it('names the month when it is not the viewer’s', () => {
    const now = new Date(2026, 10, 1, 9, 0);
    expect(headlineSummaryLine(h('2026-10'), now)).toBe("The report counts $1,300.00 spent in October; Wealthfolio's Spending page counts $1,200.00.");
    expect(headlineAgreeLine(h('2026-10', true), now)).toBe('The report and Wealthfolio agree on October.');
    expect(headlineSummaryLine(h('2026-12'), new Date(2027, 0, 1, 9, 0))).toBe("The report counts $1,300.00 spent in December 2026; Wealthfolio's Spending page counts $1,200.00.");
  });

  it('says "this month" for the viewer’s own month, or with no viewer', () => {
    expect(headlineSummaryLine(h('2026-11'), new Date(2026, 10, 1, 9, 0))).toContain('spent this month;');
    expect(headlineSummaryLine(h('2026-11'))).toContain('spent this month;');
    expect(headlineAgreeLine(h('2026-11', true), new Date(2026, 10, 30, 23, 0))).toBe(HEADLINE_AGREE);
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
