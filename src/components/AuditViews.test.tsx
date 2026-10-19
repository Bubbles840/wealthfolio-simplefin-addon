import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import {
  AccountAudit, ChecksCard, checksSummary, HeadlineAuditLink, checksToLookAt, AUDIT_ACCOUNT_NOT_COVERED, AUDIT_HEADLINE_LINK, AUDIT_HEALTH_NOT_CHECKED, HealthView,
} from './AuditViews';
import {
  buildAuditSnapshot, parseAuditSnapshot, AUDIT_CORRUPT, AUDIT_NEEDS_COMPANION, AUDIT_NOT_YET, type AuditResults, type AuditSnapshotRead,
} from '../../shared/audit-snapshot';
import { explainBalances } from '../../shared/audit-balance';
import { explainHeadline, type HeadlineExplanation } from '../../shared/audit-headline';
import { healthIssues, HEALTH_NONE, HEALTH_READ_NOTES } from '../../shared/audit-health';
import type { AuditLedgerRow } from '../../shared/audit-ledger';

const EMOJI = /\p{Extended_Pictographic}/u;
const NAME = "Joe's *Visa*_[1]";
const BANK = 'SQ *COFFEE_CLUB [2]';
const AT = new Date(2026, 9, 13, 14, 0);
const LATER = new Date(2026, 9, 13, 18, 30);

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const LEDGER = {
  accounts: [{ id: 'wf-visa', name: 'Visa', type: 'CREDIT_CARD', archived: false }, { id: 'wf-chk', name: 'Checking', type: 'CASH', archived: false }],
  rows: [
    row({ id: 'v1', accountId: 'wf-visa', absCents: 50000, date: '2026-09-01' }),
    row({ id: 'v2', accountId: 'wf-visa', absCents: 1910, notes: `${BANK} · TRN-7 · pending` }),
    row({ id: 'out', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 60000, notes: `${BANK} · TRN-1` }),
    row({ id: 'dep', accountId: 'wf-visa', rawType: 'CREDIT', type: 'CREDIT', absCents: 60000, date: '2026-10-05', notes: 'PAYMENT · TRN-2' }),
  ],
};

function results(): AuditResults {
  // A reason a 1.61 companion published: the app still shows it as it came.
  const headline: HeadlineExplanation = {
    month: '2026-10', reportCents: 130000, wealthfolioCents: 120000, unexplainedCents: 7500, notes: [],
    reasons: [{ kind: 'first-midnight', cents: 2500, rows: [{ date: '2026-10-01', description: BANK, cents: 2500, account: NAME }] }],
  };
  headline.reasons![0].more = 5;
  return {
    balances: explainBalances({
      mapping: { 'sfin-v': 'wf-visa' },
      balances: { 'sfin-v': { balance: 100, date: Date.parse('2026-10-13T12:00:00Z') / 1000 } },
      names: { 'sfin-v': NAME },
      valuations: {},
      ledger: LEDGER,
    }),
    headline,
    health: healthIssues({ ledger: LEDGER, mapping: { 'sfin-v': 'wf-visa' } }),
  };
}
const ok = (r: AuditResults = results()): AuditSnapshotRead => parseAuditSnapshot(JSON.stringify(buildAuditSnapshot(r, AT)));

describe('AccountAudit', () => {
  it('explains an account in place, with the sync it came from', () => {
    render(<AccountAudit read={ok()} wfAccountId="wf-visa" companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText('Bank: $100.00 (Oct 13) · Wealthfolio: $80.90 · Off by $19.10')).toBeInTheDocument();
    expect(screen.getByText("$19.10 in 1 pending transaction the bank hasn't posted")).toBeInTheDocument();
    expect(screen.getByText('As of the 2:00 PM sync.')).toBeInTheDocument();
  });

  it('says when the snapshot does not cover the account', () => {
    render(<AccountAudit read={ok()} wfAccountId="wf-new" companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(AUDIT_ACCOUNT_NOT_COVERED)).toBeInTheDocument();
  });

  it('says a stale snapshot is old, and a corrupt or missing one cannot be shown', () => {
    const { unmount } = render(<AccountAudit read={ok()} wfAccountId="wf-visa" companionVersion="1.61.0" now={new Date(2026, 9, 16, 9, 0)} />);
    expect(screen.getByText("These checks are from Oct 13 — the companion hasn't synced since.")).toBeInTheDocument();
    expect(screen.getByText(/Off by \$19\.10/)).toBeInTheDocument();
    unmount();
    const corrupt = render(<AccountAudit read={{ kind: 'corrupt' }} wfAccountId="wf-visa" companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(AUDIT_CORRUPT)).toBeInTheDocument();
    expect(screen.queryByText(/Off by/)).toBeNull();
    corrupt.unmount();
    render(<AccountAudit read={{ kind: 'absent' }} wfAccountId="wf-visa" companionVersion={null} now={LATER} />);
    expect(screen.getByText(AUDIT_NEEDS_COMPANION)).toBeInTheDocument();
  });
});

describe('HeadlineAuditLink', () => {
  it('opens in place: both figures, each reason opening its rows, and how many were left out', () => {
    render(<HeadlineAuditLink read={ok()} companionVersion="1.61.0" now={LATER} />);
    expect(screen.queryByText(/The report counts/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
    expect(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText("The report counts $1,300.00 spent this month; Wealthfolio's Spending page counts $1,200.00.")).toBeInTheDocument();
    expect(screen.getByText('$75.00 not explained by these reasons')).toBeInTheDocument();
    const summary = screen.getByText(/^\$25\.00 — Dated the 1st at midnight UTC/);
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(details).toHaveAttribute('open');
    expect(screen.getByText(`Oct 1 · ${BANK} · $25.00 · ${NAME}`)).toBeInTheDocument();
    expect(screen.getByText('and 5 more')).toBeInTheDocument();
  });
});

describe('HeadlineView in a later month', () => {
  it('labels a last-month snapshot by its month, not "this month"', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 1, 9, 0));
    try {
      const now = new Date();
      render(<HeadlineAuditLink read={ok()} companionVersion="1.61.0" now={now} />);
      fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
      expect(screen.getByText("The report counts $1,300.00 spent in October; Wealthfolio's Spending page counts $1,200.00.")).toBeInTheDocument();
      expect(screen.queryByText(/this month/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the two agree on that month', () => {
    const agree = { ...results(), headline: explainHeadline({ month: '2026-10', reportCents: 500, wealthfolioCents: 500, rows: [] }) };
    render(<HeadlineAuditLink read={ok(agree)} companionVersion="1.61.0" now={new Date(2026, 10, 2, 9, 0)} />);
    fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
    expect(screen.getByText('The report and Wealthfolio agree on October.')).toBeInTheDocument();
  });
});

describe('ChecksCard', () => {
  it('lists what Health flags, each with what to do', () => {
    render(<ChecksCard read={ok()} companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(`${BANK} · $600.00 · Checking · Oct 4`)).toBeInTheDocument();
    expect(screen.getByText('Likely the other half: PAYMENT · $600.00 · Visa · Oct 5')).toBeInTheDocument();
    expect(screen.getByText('As of the 2:00 PM sync.')).toBeInTheDocument();
  });

  it('says nothing is flagged only when Health was checked', () => {
    const clean = { ...results(), health: { issues: [], notes: [] } };
    const { unmount } = render(<ChecksCard read={ok(clean)} companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(HEALTH_NONE)).toBeInTheDocument();
    unmount();
    const unchecked = { ...results(), health: healthIssues({ failed: ['ledger'] }) };
    render(<ChecksCard read={ok(unchecked)} companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(HEALTH_READ_NOTES.ledger)).toBeInTheDocument();
    expect(screen.queryByText(HEALTH_NONE)).toBeNull();
  });

  it('sums itself up for the collapsed card and Home’s tile', () => {
    expect(checksSummary(ok(), '1.61.0')).toBe('1 to look at');
    expect(checksSummary(ok({ ...results(), health: { issues: [], notes: [] } }), '1.61.0')).toBe('Nothing found');
    expect(checksSummary(ok({ ...results(), health: { issues: null, notes: [] } }), '1.61.0')).toBe('Health not checked');
    expect(checksSummary({ kind: 'absent' }, null)).toBe('Need the companion');
    expect(checksSummary({ kind: 'absent' }, '1.60.0')).toBe('Arrive with the next sync');
    expect(checksSummary({ kind: 'corrupt' }, '1.61.0')).toBe("Couldn't read");
    expect(checksToLookAt(ok())).toBe(1);
    expect(checksToLookAt({ kind: 'corrupt' })).toBe(0);
    expect(checksToLookAt(null)).toBe(0);
  });
});

describe('copy', () => {
  it('renders bank text as text, and no emoji in any state', () => {
    const states: Array<[AuditSnapshotRead, string | null, Date]> = [
      [ok(), '1.61.0', LATER], [ok(), '1.61.0', new Date(2026, 9, 20)], [{ kind: 'absent' }, null, LATER],
      [{ kind: 'absent' }, '1.60.0', LATER], [{ kind: 'corrupt' }, '1.61.0', LATER],
    ];
    for (const [read, version, now] of states) {
      const { container, unmount } = render(
        <>
          <AccountAudit read={read} wfAccountId="wf-visa" companionVersion={version} now={now} />
          <HeadlineAuditLink read={read} companionVersion={version} now={now} />
          <ChecksCard read={read} companionVersion={version} now={now} />
        </>,
      );
      fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
      expect(container.textContent).not.toMatch(EMOJI);
      unmount();
    }
    expect(AUDIT_NOT_YET).not.toMatch(EMOJI);
  });
});

describe('R-F review fixes', () => {
  it('marks status lines and opened panels as live regions', () => {
    render(<HeadlineAuditLink read={ok()} companionVersion="1.61.0" now={LATER} />);
    fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
    const region = screen.getByRole('region', { name: 'Spent vs Wealthfolio' });
    expect(within(region).getByRole('status')).toHaveTextContent('As of the 2:00 PM sync.');
  });

  const STATES: Array<[string, AuditSnapshotRead, string | null, Date, string]> = [
    ['corrupt', { kind: 'corrupt' }, '1.61.0', LATER, AUDIT_CORRUPT],
    ['absent, no companion', { kind: 'absent' }, null, LATER, AUDIT_NEEDS_COMPANION],
    ['absent, companion', { kind: 'absent' }, '1.61.0', LATER, AUDIT_NOT_YET],
    ['stale', ok(), '1.61.0', new Date(2026, 9, 16, 9, 0), "These checks are from Oct 13 — the companion hasn't synced since."],
  ];
  it.each(STATES)('headline link and Checks card say the exact copy when %s', (_n, read, version, now, copy) => {
    const a = render(<HeadlineAuditLink read={read} companionVersion={version} now={now} />);
    fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
    expect(screen.getByText(copy)).toBeInTheDocument();
    a.unmount();
    render(<ChecksCard read={read} companionVersion={version} now={now} />);
    expect(screen.getByText(copy)).toBeInTheDocument();
    if (read.kind !== 'ok') expect(screen.queryByText(HEALTH_NONE)).toBeNull();
  });

  it('says Health was not checked when there is no verdict and no note', () => {
    render(<HealthView report={{ issues: null, notes: [] }} />);
    expect(screen.getByText(AUDIT_HEALTH_NOT_CHECKED)).toBeInTheDocument();
    expect(AUDIT_HEALTH_NOT_CHECKED).not.toMatch(EMOJI);
  });

  it('tolerates identical note lines without duplicate keys', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<HealthView report={{ issues: [], notes: ['same', 'same'] }} />);
    expect(screen.getAllByText('same')).toHaveLength(2);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('a snapshot the views cannot draw', () => {
  /** Handed to the views as-is, past the reader: dates that are not strings. */
  const broken = (): AuditSnapshotRead => {
    const snap = buildAuditSnapshot(results(), AT)!;
    (snap.balances['wf-visa'].bank as { date: unknown }).date = 5;
    (snap.headline.reasons![0].rows[0] as { date: unknown }).date = 5;
    for (const i of snap.health.issues!) if (i.kind === 'incomplete-leg') (i.leg as { date: unknown }).date = 5;
    return { kind: 'ok', snapshot: snap };
  };

  it('shows the corrupt line in place of each view instead of taking the page down', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <>
          <div>Still here</div>
          <AccountAudit read={broken()} wfAccountId="wf-visa" companionVersion="1.61.0" now={LATER} />
          <HeadlineAuditLink read={broken()} companionVersion="1.61.0" now={LATER} />
          <ChecksCard read={broken()} companionVersion="1.61.0" now={LATER} />
        </>,
      );
      fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
      expect(screen.getAllByText(AUDIT_CORRUPT)).toHaveLength(3);
      expect(screen.getByText('Still here')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK })).toHaveAttribute('aria-expanded', 'true');
    } finally {
      err.mockRestore();
    }
  });

  it('draws again once a readable snapshot arrives', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rerender } = render(<AccountAudit read={broken()} wfAccountId="wf-visa" companionVersion="1.61.0" now={LATER} />);
      expect(screen.getByText(AUDIT_CORRUPT)).toBeInTheDocument();
      rerender(<AccountAudit read={ok()} wfAccountId="wf-visa" companionVersion="1.61.0" now={LATER} />);
      expect(screen.getByText('Bank: $100.00 (Oct 13) · Wealthfolio: $80.90 · Off by $19.10')).toBeInTheDocument();
      expect(screen.queryByText(AUDIT_CORRUPT)).toBeNull();
    } finally {
      err.mockRestore();
    }
  });
});
