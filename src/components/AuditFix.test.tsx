import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { healthIssues } from '../../shared/audit-health';
import type { AuditLedgerRow } from '../../shared/audit-ledger';
import { linkablePairs, type LinkPair, type LinkRun } from '../../shared/audit-link';
import { buildAuditSnapshot, parseAuditSnapshot, type AuditSnapshotRead } from '../../shared/audit-snapshot';
import { AUDIT_AFTER_SYNC, ChecksCard, resetCheckFixes } from './AuditViews';
import { linkFromApp } from '../utils/audit-fix';
import { emptySyncOverrides } from '../../shared/sync-overrides';

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date(2026, 9, 14, 12, 0);
const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const ledger = {
  accounts: [{ id: 'wf-chk', name: 'PNC Checking', type: 'CASH', archived: false }, { id: 'wf-ally', name: 'Ally', type: 'CASH', archived: false }],
  rows: [
    row({ id: 'outA', absCents: 60000, notes: 'TRANSFER TO ALLY · TRN-1' }),
    row({ id: 'inA', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 60000, date: '2026-10-05', notes: 'FROM PNC · TRN-2' }),
    row({ id: 'outB', absCents: 2500, date: '2026-10-06', notes: 'ZELLE TO SAVINGS · TRN-3' }),
    row({ id: 'inB', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 2500, date: '2026-10-06', notes: 'ZELLE FROM PNC · TRN-4' }),
    row({ id: 'lone', absCents: 777, date: '2026-10-07', notes: 'TO SOMEWHERE · TRN-5' }),
  ],
};
const health = healthIssues({ ledger, mapping: { 'sfin-chk': 'wf-chk', 'sfin-ally': 'wf-ally' } });
const read: AuditSnapshotRead = parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
  balances: { accounts: [], notes: [] },
  headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, unexplainedCents: null, reasons: null, notes: [] },
  health,
}, new Date(2026, 9, 14, 10, 0))));
const PAIRS = linkablePairs(health.issues);

const linked = (pairs: LinkPair[], message = pairs.length === 1 ? 'Linked.' : `Linked all ${pairs.length}.`): LinkRun => ({
  total: pairs.length, linked: pairs.length, changed: 0, failed: 0, done: pairs.map((p) => p.key), lost: [], maybeLost: [], message,
});
const card = (link?: (pairs: LinkPair[]) => Promise<LinkRun>, onFixed = vi.fn()) =>
  render(<ChecksCard read={read} companionVersion="1.61.0" now={NOW} link={link} onFixed={onFixed} />);

/** The fix result line (the card also has a freshness status). */
const fixStatus = () => screen.getAllByRole('status').find((el) => !el.className.includes('sfin-audit-status'))!;

describe('Link on the Checks card', () => {
  // The card's fix state is app-wide; start each test clean.
  beforeEach(() => { resetCheckFixes(); });

  it('offers Link under each leg with one other half, and Link all for two or more', () => {
    card(vi.fn());
    expect(screen.getAllByRole('button', { name: 'Link' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Link all 2' })).toBeInTheDocument();
  });

  it('offers no Link without a linker', () => {
    card(undefined);
    expect(screen.queryByRole('button', { name: /^Link/ })).toBeNull();
  });

  it('runs one action at a time, every button disabled and busy, then says what happened and that it shows after the next sync', async () => {
    let finish!: (r: LinkRun) => void;
    const link = vi.fn(() => new Promise<LinkRun>((r) => { finish = r; }));
    const onFixed = vi.fn();
    card(link, onFixed);
    const first = screen.getAllByRole('button', { name: 'Link' })[0];
    fireEvent.click(first);
    fireEvent.click(first);
    fireEvent.click(screen.getByRole('button', { name: 'Link all 2' }));
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith([PAIRS[0]]);
    for (const b of screen.getAllByRole('button', { name: /^Link/ })) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('aria-busy', 'true');
    }
    await act(async () => { finish(linked([PAIRS[0]])); });
    expect(screen.getByText(`Linked. ${AUDIT_AFTER_SYNC}`)).toBeInTheDocument();
    // That pair's button is gone; one pair is left, so no Link all.
    expect(screen.getAllByRole('button', { name: 'Link' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Link all/ })).toBeNull();
    expect(onFixed).toHaveBeenCalledTimes(1);
  });

  it('Link all links every pair it lists, and says how it went', async () => {
    const link = vi.fn(async (pairs: LinkPair[]) => ({ ...linked(pairs.slice(0, 1)), total: 2, changed: 1, message: 'Linked 1 of 2 — 1 had changed since.' }));
    card(link);
    fireEvent.click(screen.getByRole('button', { name: 'Link all 2' }));
    expect(link).toHaveBeenCalledWith(PAIRS);
    expect(await screen.findByText(`Linked 1 of 2 — 1 had changed since. ${AUDIT_AFTER_SYNC}`)).toBeInTheDocument();
  });

  it('says Wealthfolio could not be reached when the link throws, with no emoji anywhere', async () => {
    const { container } = card(vi.fn(async () => { throw new Error('offline'); }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    expect(await screen.findByText("Couldn't reach Wealthfolio — nothing was linked.")).toBeInTheDocument();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('shows what the real runner says when a link throws and the rows cannot be put back, naming both rows', async () => {
    const rows: Array<Record<string, unknown>> = [
      { id: 'outA', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'TRANSFER_OUT', date: '2026-10-04T00:00:00.000Z', amount: '600', currency: 'USD', comment: 'TRANSFER TO ALLY · TRN-1', metadata: null },
      { id: 'inA', accountId: 'wf-ally', accountName: 'Ally', activityType: 'DEPOSIT', date: '2026-10-05T00:00:00.000Z', amount: '600', currency: 'USD', comment: 'FROM PNC · TRN-2', metadata: null },
    ];
    let writes = 0;
    const ctx = {
      api: {
        accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }, { id: 'wf-ally', accountType: 'CASH' }]) },
        activities: {
          search: vi.fn(async (_p: number, _s: number, f: { activityIds?: string[] }) => ({ data: rows.filter((r) => f.activityIds?.includes(r.id as string)), meta: { totalRowCount: 0 } })),
          // The delete goes through; every later write (the re-create, then the write-back) throws.
          saveMany: vi.fn(async (req: { deleteIds?: string[] }) => {
            writes += 1;
            if (writes === 1) { for (const id of req.deleteIds ?? []) rows.splice(rows.findIndex((r) => r.id === id), 1); return { created: [], updated: [], errors: [] }; }
            throw new Error('Wealthfolio is down');
          }),
        },
      },
    } as any;
    const store = { readSyncOverrides: async () => ({ overrides: emptySyncOverrides(), unreadable: false }), getLinkedGroups: async () => ({}), setLinkedGroups: async () => {}, recordChange: async () => {} };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    card((pairs) => linkFromApp(ctx, store, pairs));
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    const status = await waitFor(() => {
      const el = fixStatus();
      expect(el.textContent).toContain('Deleted and not restored');
      return el;
    });
    expect(status.textContent).toContain('TRANSFER TO ALLY · TRN-1');
    expect(status.textContent).toContain('FROM PNC · TRN-2');
    expect(status.textContent).toContain(AUDIT_AFTER_SYNC);
    warn.mockRestore();
  });

  it('does not say changes show after the next sync when nothing was linked (a refusal)', async () => {
    const run = (message: string, changed: number): LinkRun => ({ total: 1, linked: 0, changed, failed: 0, done: [], lost: [], maybeLost: [], message });
    const link = vi.fn()
      .mockResolvedValueOnce(run('A sync is running — try Link again when it finishes.', 0))
      .mockResolvedValueOnce(run('It has changed since — nothing was linked.', 1));
    card(link);
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    await waitFor(() => expect(fixStatus().textContent).toBe('A sync is running — try Link again when it finishes.'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    await waitFor(() => expect(fixStatus().textContent).toBe('It has changed since — nothing was linked.'));
  });

  it('hides the last result once the card shows a newer snapshot', async () => {
    const newer = parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
      balances: { accounts: [], notes: [] },
      headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, unexplainedCents: null, reasons: null, notes: [] },
      health,
    }, new Date(2026, 9, 14, 11, 0))));
    const link = vi.fn(async (pairs: LinkPair[]) => linked(pairs));
    const { rerender } = card(link);
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    await screen.findByText(`Linked. ${AUDIT_AFTER_SYNC}`);
    rerender(<ChecksCard read={newer} companionVersion="1.61.0" now={NOW} link={link} onFixed={vi.fn()} />);
    expect(screen.queryByText(`Linked. ${AUDIT_AFTER_SYNC}`)).toBeNull();
    expect(fixStatus().textContent).toBe('');
  });

  it('a new run clears the last result at once', async () => {
    let finish!: (r: LinkRun) => void;
    const link = vi.fn()
      .mockImplementationOnce(async (pairs: LinkPair[]) => linked(pairs))
      .mockImplementationOnce(() => new Promise<LinkRun>((r) => { finish = r; }));
    card(link);
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    await screen.findByText(`Linked. ${AUDIT_AFTER_SYNC}`);
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    expect(fixStatus().textContent).toBe('');
    await act(async () => { finish(linked([PAIRS[1]])); });
  });

  it('describes each Link button by its issue title', () => {
    card(vi.fn());
    for (const b of screen.getAllByRole('button', { name: 'Link' })) {
      const title = document.getElementById(b.getAttribute('aria-describedby')!);
      expect(title?.textContent).toMatch(/TRN|TRANSFER|ZELLE|\$/);
      expect(title?.className).toBe('sfin-audit-head');
    }
  });

  it('a card unmounted and mounted again mid-link shows the buttons disabled, then the result', async () => {
    let finish!: (r: LinkRun) => void;
    const link = vi.fn(() => new Promise<LinkRun>((r) => { finish = r; }));
    const first = card(link);
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    first.unmount();
    const onFixed = vi.fn();
    card(link, onFixed);
    for (const b of screen.getAllByRole('button', { name: /^Link/ })) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('aria-busy', 'true');
    }
    // No second link can start from the new card.
    fireEvent.click(screen.getByRole('button', { name: 'Link all 2' }));
    expect(link).toHaveBeenCalledTimes(1);
    await act(async () => { finish(linked([PAIRS[0]])); });
    expect(screen.getByText(`Linked. ${AUDIT_AFTER_SYNC}`)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Link' })).toHaveLength(1);
    expect(onFixed).toHaveBeenCalledTimes(1);
  });

  it('changes nothing once the card is gone', async () => {
    let finish!: (r: LinkRun) => void;
    const onFixed = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = card(vi.fn(() => new Promise<LinkRun>((r) => { finish = r; })), onFixed);
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    unmount();
    await act(async () => { finish(linked([PAIRS[0]])); });
    await waitFor(() => expect(onFixed).not.toHaveBeenCalled());
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
