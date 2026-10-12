import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubscriptionsCard } from './SubscriptionsCard';
import { CUBE } from '../../../shared/report-cube.test';
import type { ReportCube } from '../../../shared/report-cube';
import { emptySubscriptionPrefs, type SubscriptionPrefs } from '../../../shared/subscription-prefs';
import { aboutDollars, buildRoster, formatRosterTotal, localIsoDay, rosterAmount } from '../../../shared/subscription-roster';
import { escapeMarkdown, formatSubscriptionList } from '../../../shared/telegram';

/**
 * R2-14: the app card and the bot's /subscriptions render from one roster, so
 * they must show the same names, amounts and totals in the same order. One
 * fixture, both surfaces.
 */
const NOW = new Date(2026, 9, 12, 9, 0, 0);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const det = (name: string, over: Record<string, unknown> = {}) => ({
  name, monthlyCents: 1199, count: 5, lastDate: '2026-09-15', lastCents: 1199, prevCents: 1199, creep: false,
  kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }], ...over,
});
const cube = {
  ...CUBE,
  asOf: NOW.toISOString(),
  subscriptions: [
    det('SPOTIFY'),
    det('NETFLIX', { monthlyCents: 1549, lastCents: 1799, creep: true, lastDate: '2026-09-22' }),
    det('LG&E', { kind: 'bill', monthlyCents: 6149, lastCents: 6149, lastDate: '2026-09-28' }),
    det('QR LIBRARY', { monthlyCents: 499, lastCents: 499 }),
  ],
  merchants: [[], [{ name: 'ANTHROPIC* CLAUDE SUB', cents: 2000, count: 1 }]],
} as ReportCube;
const prefs: SubscriptionPrefs = {
  ...emptySubscriptionPrefs(),
  names: { SPOTIFY: 'Spotify' },
  remind: { SPOTIFY: 3 },
  hidden: ['QR LIBRARY'],
  confirmed: ['ANTHROPIC* CLAUDE SUB'],
  manual: [
    { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' },
    { id: 'dom00001', name: 'Domain', cents: 9900, cadence: 'yearly', nextDate: '2027-03-03' },
  ],
};

describe('app card and /subscriptions agree', () => {
  it('show the same names, amounts and totals, in the same order, and hide the same rows', () => {
    const roster = buildRoster({
      detected: cube.subscriptions, merchants: cube.merchants, links: [], prefs, today: localIsoDay(NOW),
    });
    const telegram = formatSubscriptionList(roster, 0);
    const { container } = render(<SubscriptionsCard cube={cube} subscriptionPrefs={{ prefs, unreadable: false }} onSubscriptionEdit={vi.fn()} />);
    const app = container.textContent ?? '';

    const rows = [...roster.subscriptions, ...roster.bills];
    expect(rows.length).toBe(6);
    for (const e of rows) {
      expect(telegram).toContain(escapeMarkdown(e.displayName));
      expect(app).toContain(e.displayName);
      expect(telegram).toContain(rosterAmount(e));
      expect(app).toContain(rosterAmount(e));
    }
    expect(telegram).toContain(formatRosterTotal(roster));
    expect(app).toContain(`${formatRosterTotal(roster)} across ${roster.subscriptions.length}`);
    expect(telegram).toContain(`about ${aboutDollars(roster.billsMonthlyCents)}/mo`);
    expect(app).toContain(`Bills ≈ ${aboutDollars(roster.billsMonthlyCents)}/mo`);

    const appOrder = Array.from(container.querySelectorAll('.sfin-subs-toggle')).map((b) => b.textContent);
    expect(appOrder).toEqual(rows.map((e) => e.displayName));
    expect(telegram).not.toContain('QR LIBRARY');
    expect(app).not.toContain('QR LIBRARY');
  });
});
