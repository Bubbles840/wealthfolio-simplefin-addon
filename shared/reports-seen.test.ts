import { describe, it, expect } from 'vitest';
import {
  baselineSeen, isUnread, markSeen, newestEdition, parseReportsSeen, unreadCount, unreadCounts, unreadLabel,
} from './reports-seen';
import type { ReportEdition, ReportKind, ReportStore } from './reports-archive';

const edition = (kind: ReportKind, period: string, generatedAt: string): ReportEdition => ({
  kind, period, title: `Title ${period}`, generatedAt, text: `${kind} ${period}`,
});
const DAILY: ReportStore = {
  // Recomposed every sync: never "new".
  live: edition('daily', '2026-10-14', '2026-10-14T15:00:00.000Z'),
  archive: [
    edition('daily', '2026-10-14', '2026-10-14T12:00:00.000Z'),
    edition('daily', '2026-10-13', '2026-10-13T12:00:00.000Z'),
    edition('daily', '2026-10-12', '2026-10-12T12:00:00.000Z'),
  ],
};
const WEEKLY: ReportStore = { live: null, archive: [edition('weekly', '2026-10-05', '2026-10-11T23:00:00.000Z')] };
const MONTHLY: ReportStore = { live: null, archive: [] };
const STORES = { daily: DAILY, weekly: WEEKLY, monthly: MONTHLY };

describe('parseReportsSeen', () => {
  it('reads the newest edition seen per kind, ignoring keys it does not know', () => {
    expect(parseReportsSeen(JSON.stringify({ daily: '2026-10-13T12:00:00.000Z', extra: 1 })))
      .toEqual({ kind: 'ok', seen: { daily: '2026-10-13T12:00:00.000Z' } });
    expect(parseReportsSeen('{}')).toEqual({ kind: 'ok', seen: {} });
  });

  it('tells a first run from a value nothing can read', () => {
    expect(parseReportsSeen(null)).toEqual({ kind: 'absent' });
    expect(parseReportsSeen('')).toEqual({ kind: 'absent' });
    for (const raw of ['{oops', '[]', '"2026"', JSON.stringify({ daily: 'yesterday' }), JSON.stringify({ weekly: 3 })]) {
      expect(parseReportsSeen(raw)).toEqual({ kind: 'corrupt' });
    }
  });
});

describe('unread', () => {
  it('counts sent editions generated after what was seen — never the live one', () => {
    expect(unreadCount(DAILY, '2026-10-12T12:00:00.000Z')).toBe(2);
    expect(unreadCount(DAILY, '2026-10-14T12:00:00.000Z')).toBe(0);
    expect(isUnread(DAILY.live!, '2026-10-14T12:00:00.000Z')).toBe(true);
    expect(unreadCounts(STORES, { daily: '2026-10-14T12:00:00.000Z', weekly: '2026-10-11T23:00:00.000Z' }))
      .toEqual({ daily: 0, weekly: 0, monthly: 0 });
  });

  it('counts every sent edition of a kind the document has no time for', () => {
    expect(unreadCounts(STORES, { daily: '2026-10-13T12:00:00.000Z' })).toEqual({ daily: 1, weekly: 1, monthly: 0 });
  });

  it('counts nothing when nothing is known to be seen, and never an edition whose time is unreadable', () => {
    expect(unreadCounts(STORES, null)).toEqual({ daily: 0, weekly: 0, monthly: 0 });
    expect(isUnread(edition('daily', '2026-10-15', 'soon'), undefined)).toBe(false);
  });

  it('labels a tab with what is unread', () => {
    expect(unreadLabel('Reports', 2)).toBe('Reports, 2 unread');
  });
});

describe('the first run and marking seen', () => {
  it('takes each kind’s newest sent edition as seen, leaving out a kind with none', () => {
    expect(newestEdition(DAILY)).toBe('2026-10-14T12:00:00.000Z');
    expect(newestEdition(MONTHLY)).toBeNull();
    const baseline = baselineSeen(STORES);
    expect(baseline).toEqual({ daily: '2026-10-14T12:00:00.000Z', weekly: '2026-10-11T23:00:00.000Z' });
    // So nothing there now is unread, and a later edition will be.
    expect(unreadCounts(STORES, baseline)).toEqual({ daily: 0, weekly: 0, monthly: 0 });
    expect(unreadCount({ live: null, archive: [edition('monthly', '2026-10', '2026-11-01T13:00:00.000Z')] }, baseline.monthly)).toBe(1);
  });

  it('marks a kind seen up to its newest edition, and has nothing to write the second time', () => {
    const seen = { daily: '2026-10-12T12:00:00.000Z', weekly: '2026-10-11T23:00:00.000Z' };
    const next = markSeen(seen, 'daily', DAILY);
    expect(next).toEqual({ daily: '2026-10-14T12:00:00.000Z', weekly: '2026-10-11T23:00:00.000Z' });
    expect(markSeen(next!, 'daily', DAILY)).toBeNull();
    expect(markSeen(seen, 'monthly', MONTHLY)).toBeNull();
    expect(markSeen({}, 'weekly', WEEKLY)).toEqual({ weekly: '2026-10-11T23:00:00.000Z' });
  });
});
