import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubscriptionsCard } from './SubscriptionsCard';
import { CUBE } from '../../../shared/report-cube.test';
import type { ReportCube } from '../../../shared/report-cube';
import type { DetectedSubscription } from '../../../shared/subscriptions';
import { emptySubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs } from '../../../shared/subscription-prefs';

const NOW = new Date(2026, 9, 12, 9, 0, 0);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

/** DetectedSubscription exactly as a 1.60 companion publishes it. */
const det = (name: string, over: Partial<DetectedSubscription> = {}): DetectedSubscription => ({
  name, monthlyCents: 1199, count: 4, lastDate: '2026-09-15', lastCents: over.monthlyCents ?? 1199, prevCents: 1199,
  creep: false, kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }], ...over,
});
const cubeWith = (subscriptions: DetectedSubscription[] | null, extra: Partial<ReportCube> = {}): ReportCube =>
  ({ ...CUBE, asOf: NOW.toISOString(), subscriptions, ...extra });
const loaded = (over: Partial<SubscriptionPrefs> = {}, unreadable = false) =>
  ({ prefs: { ...emptySubscriptionPrefs(), ...over }, unreadable });
/** Every edit the card handed up, applied in order to `base`. */
const applied = (spy: ReturnType<typeof vi.fn>, base: SubscriptionPrefs = emptySubscriptionPrefs()) =>
  spy.mock.calls.reduce((p: SubscriptionPrefs, call: unknown[]) => (call[0] as SubscriptionEdit)(p), base);
const HULU = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly' as const, nextDate: '2026-10-20' };
const LINK = { manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 };

describe('subscriptions card rows (1.60)', () => {
  it('rows carry the next date and, in words, the reminder and hand-added marks', () => {
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])}
      subscriptionPrefs={loaded({ remind: { SPOTIFY: 3 }, manual: [HULU] })} onSubscriptionEdit={vi.fn()} />);
    expect(screen.getByText('next Oct 15 · reminder 3d')).toBeTruthy();
    expect(screen.getByText('next Oct 20 · added by you')).toBeTruthy();
    expect(screen.getByText('$11.99/mo')).toBeTruthy();
  });

  it('carries no emoji in its rows, headings and controls (app copy policy)', () => {
    const { container } = render(<SubscriptionsCard full
      cube={cubeWith(
        [det('SPOTIFY'), det('LG&E', { kind: 'bill', monthlyCents: 6149 }), det('MYSTERY BOX', { kind: 'possible', count: 2 }), det('QR LIBRARY', { monthlyCents: 499 })],
        { subscriptionLinks: [LINK] },
      )}
      subscriptionPrefs={loaded({ remind: { SPOTIFY: 3 }, manual: [HULU], hidden: ['QR LIBRARY'] })}
      onSubscriptionEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    const texts = Array.from(container.querySelectorAll(
      'button, label, .sfin-subs-meta, .sfin-subs-maybe-head, .sfin-subs-total, .sfin-subs-note, .sfin-subs-detail',
    )).map((el) => el.textContent ?? '');
    expect(texts.length).toBeGreaterThan(10);
    expect(texts.filter((t) => /\p{Extended_Pictographic}/u.test(t))).toEqual([]);
  });

  it('a row opens inline with its last three charges, and closes again', () => {
    const recent = [{ date: '2026-09-15', cents: 1199 }, { date: '2026-08-15', cents: 1199 }, { date: '2026-07-15', cents: 1199 }];
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY', { recent })])} subscriptionPrefs={loaded()} onSubscriptionEdit={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'SPOTIFY' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Last charges: Sep 15 $11.99 · Aug 15 $11.99 · Jul 15 $11.99')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText(/Last charges/)).toBeNull();
  });

  it('a renamed row says what the bank calls it', () => {
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])} subscriptionPrefs={loaded({ names: { SPOTIFY: 'Spotify' } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Spotify' }));
    expect(screen.getByText('On your statement as SPOTIFY')).toBeTruthy();
  });

  it('bills are their own group, out of the subscriptions total', () => {
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY'), det('LG&E', { kind: 'bill', monthlyCents: 6149, lastDate: '2026-09-28' })])}
      subscriptionPrefs={loaded()} />);
    expect(screen.getByText('Bills ≈ $61/mo')).toBeTruthy();
    expect(screen.getByText('about $61/mo')).toBeTruthy();
    expect(screen.getByText('$11.99/mo across 1')).toBeTruthy();
  });

  it('a link suggestion row: Yes links it', () => {
    const onEdit = vi.fn();
    const base = loaded({ manual: [HULU] });
    render(<SubscriptionsCard cube={cubeWith([], { subscriptionLinks: [LINK] })} subscriptionPrefs={base} onSubscriptionEdit={onEdit} />);
    expect(screen.getByText('Is HULU your Hulu?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, HULU is Hulu' }));
    expect(applied(onEdit, base.prefs).manual[0]).toMatchObject({ merchant: 'HULU', nextDate: '2026-10-19' });
  });

  it('a link suggestion row: No sticks', () => {
    const onEdit = vi.fn();
    const base = loaded({ manual: [HULU] });
    render(<SubscriptionsCard cube={cubeWith([], { subscriptionLinks: [LINK] })} subscriptionPrefs={base} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'No, HULU is not Hulu' }));
    expect(applied(onEdit, base.prefs).declinedLinks).toEqual(['hulu0001|HULU']);
  });

  it('an unreadable document: a one-line notice, the earlier hides still applied, and no controls', () => {
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY'), det('QR LIBRARY', { monthlyCents: 499 })])}
      subscriptionPrefs={loaded({ hidden: ['QR LIBRARY'] }, true)} onSubscriptionEdit={vi.fn()} />);
    expect(screen.getByText("Couldn't read your subscription settings, so changes are paused. This shows your earlier choices.")).toBeTruthy();
    expect(screen.queryByText('QR LIBRARY')).toBeNull();
    expect(screen.queryByRole('button', { name: /hidden — restore/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    expect(screen.queryByRole('button', { name: 'Hide SPOTIFY' })).toBeNull();
  });

  it('an older companion that could not look: hand-added rows still render, with the hint', () => {
    render(<SubscriptionsCard cube={cubeWith(null)} subscriptionPrefs={loaded({ manual: [HULU] })} onSubscriptionEdit={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Hulu' })).toBeTruthy();
    expect(screen.getByText('The companion looks for recurring charges after the next sync.')).toBeTruthy();
  });
});
