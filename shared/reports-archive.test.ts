import { describe, it, expect } from 'vitest';
import {
  emptyReportStore, withLive, withArchived, reportPeriod, parseReportsLink, reportsLink,
  notificationPreview, REPORT_ARCHIVE_LIMITS, REPORTS_MAX_BYTES, type ReportEdition,
} from './reports-archive.js';

const edition = (period: string, text = `report ${period}`): ReportEdition => ({
  kind: 'daily', period, title: `Daily · ${period}`, generatedAt: `${period}T08:00:00.000Z`, text,
});

describe('report store', () => {
  it('replaces the live edition and leaves the archive alone', () => {
    const s = withLive(withArchived(emptyReportStore(), edition('2026-09-22')), edition('2026-09-23'));
    expect(s.live?.period).toBe('2026-09-23');
    expect(s.archive.map((e) => e.period)).toEqual(['2026-09-22']);
  });

  it('archives newest first, replacing an edition for the same period', () => {
    let s = emptyReportStore();
    s = withArchived(s, edition('2026-09-21'));
    s = withArchived(s, edition('2026-09-23'));
    s = withArchived(s, edition('2026-09-22'));
    s = withArchived(s, edition('2026-09-23', 'resent'));
    expect(s.archive.map((e) => e.period)).toEqual(['2026-09-23', '2026-09-22', '2026-09-21']);
    expect(s.archive[0].text).toBe('resent');
  });

  it('keeps at most the limit for its kind', () => {
    let s = emptyReportStore();
    for (let d = 1; d <= REPORT_ARCHIVE_LIMITS.daily + 5; d++) {
      const day = new Date(Date.UTC(2026, 0, d)).toISOString().slice(0, 10);
      s = withArchived(s, edition(day));
    }
    expect(s.archive).toHaveLength(REPORT_ARCHIVE_LIMITS.daily);
    expect(s.archive[s.archive.length - 1].period > '2026-01-05').toBe(true);
  });

  it('drops the oldest editions to stay under the size cap', () => {
    let s = emptyReportStore();
    const big = 'x'.repeat(Math.floor(REPORTS_MAX_BYTES / 5));
    for (let d = 1; d <= 10; d++) s = withArchived(s, edition(`2026-09-${String(d).padStart(2, '0')}`, big));
    expect(new TextEncoder().encode(JSON.stringify(s)).length).toBeLessThanOrEqual(REPORTS_MAX_BYTES);
    expect(s.archive[0].period).toBe('2026-09-10');
  });
});

describe('reportPeriod', () => {
  const wed = new Date(2026, 8, 23, 9, 0); // Wed 23 Sep 2026, local
  it('names a day, a Monday-started week, and a month', () => {
    expect(reportPeriod('daily', wed)).toBe('2026-09-23');
    expect(reportPeriod('weekly', wed)).toBe('2026-09-21');
    expect(reportPeriod('monthly', wed)).toBe('2026-09');
  });
});

describe('links into the Reports tab', () => {
  it('round-trips a sub-tab through the route query', () => {
    expect(reportsLink('weekly')).toBe('/addons/simplefin-sync?tab=reports&report=weekly');
    expect(parseReportsLink('?tab=reports&report=weekly')).toEqual({ report: 'weekly' });
    expect(parseReportsLink('?tab=reports')).toEqual({ report: 'daily' });
  });

  it('ignores anything else', () => {
    expect(parseReportsLink('')).toBeNull();
    expect(parseReportsLink(undefined)).toBeNull();
    expect(parseReportsLink('?tab=budget')).toBeNull();
    expect(parseReportsLink('?tab=reports&report=yearly')).toEqual({ report: 'daily' });
  });
});

describe('notificationPreview', () => {
  it('strips Telegram markdown and keeps it to a short line', () => {
    const text = '*Daily check* — Sep 23\n\n*Groceries* $42.10 left this week\n' + 'y'.repeat(400);
    const preview = notificationPreview(text);
    expect(preview.startsWith('Daily check — Sep 23 · Groceries $42.10 left this week')).toBe(true);
    expect(preview).not.toContain('*');
    expect(preview.length).toBeLessThanOrEqual(180);
  });
});
