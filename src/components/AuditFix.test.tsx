import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { healthIssues } from '../../shared/audit-health';
import type { AuditLedgerRow } from '../../shared/audit-ledger';
import { linkablePairs, type LinkPair, type LinkRun } from '../../shared/audit-link';
import { buildAuditSnapshot, parseAuditSnapshot, type AuditSnapshotRead } from '../../shared/audit-snapshot';
import { AUDIT_AFTER_SYNC, ChecksCard } from './AuditViews';

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

describe('Link on the Checks card', () => {
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
    expect(await screen.findByText(`Couldn't reach Wealthfolio — nothing was linked. ${AUDIT_AFTER_SYNC}`)).toBeInTheDocument();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('shows a run that lost rows in full, including what may have been deleted', async () => {
    const link = vi.fn(async (pairs: LinkPair[]): Promise<LinkRun> => ({
      total: 2, linked: 0, changed: 0, failed: 2, done: [],
      lost: ['$600.00 TRANSFER TO ALLY on 2026-10-04 (PNC Checking)'],
      maybeLost: ['$25.00 ZELLE TO SAVINGS on 2026-10-06 (PNC Checking)'],
      message: pairs.length === 2 ? 'Linked 0 of 2 — 2 couldn\'t be linked.' : 'x',
    }));
    card(link);
    fireEvent.click(screen.getByRole('button', { name: 'Link all 2' }));
    const status = await screen.findByText(/Linked 0 of 2/);
    expect(status).toHaveAttribute('role', 'status');
    expect(status.textContent).toContain('Deleted and not restored: $600.00 TRANSFER TO ALLY on 2026-10-04 (PNC Checking)');
    expect(status.textContent).toContain('May have been deleted: $25.00 ZELLE TO SAVINGS on 2026-10-06 (PNC Checking)');
    expect(status.textContent).toContain(AUDIT_AFTER_SYNC);
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
