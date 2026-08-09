import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from './SyncPage';
import { runSync, INTERVAL_SKIP_MESSAGE } from '../utils/sync';
// Shared with copy-policy.test.tsx, so the copy policy is proved against the
// same page state the behaviour tests use.
import { makeProps } from './test-props';

// The real INTERVAL_SKIP_MESSAGE has to travel through the mock: SyncPage
// compares the sync's single error against it to tell "skipped, offer to force"
// from a genuine failure, and a mock that omitted it left that branch dead.
// Re-exported from the real module (not re-typed) so it cannot drift.
vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 5, skipped: 1, errors: [] })),
  };
});

/**
 * Only one tab panel is mounted at a time, so a test that touches content on
 * another tab has to switch to it first — exactly as the user does. Matched by
 * the tab's accessible name (its label).
 */
async function switchTab(name: RegExp) {
  fireEvent.click(await screen.findByRole('tab', { name }));
}

/**
 * A button in the shell header, specifically.
 *
 * `Deep scan` is now the name in BOTH places that fire it — the header and the
 * off-balance banner — because one operation (one `healing` flag) must not have
 * two names. That makes a bare `getByRole('button', { name: /deep scan/i })`
 * ambiguous whenever a drift banner is on screen, which the default props put
 * there. Scoping to the header is the fix; the ambiguity itself is the feature.
 */
function headerButton(name: RegExp | string): HTMLElement {
  return within(document.querySelector('.sfin-head-actions') as HTMLElement)
    .getByRole('button', { name });
}

/**
 * The page's own behaviour: sync actions, the interval-skip banner, the error
 * surface, and the tabbed shell itself.
 *
 * Everything about the Telegram cards lives in NotificationsTab.test.tsx, and
 * everything about Auto-sync / Docker / Amazon / Transaction rules / Reset
 * lives in AdvancedTab.test.tsx — both still rendered through this page.
 */
describe('SyncPage', () => {

  it('renders Sync Now button', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument());
  });

  it('shows sync result after clicking Sync Now', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(screen.getByText(/5 transactions/i)).toBeInTheDocument());
  });

  it('keeps the daily-driver view visible alongside the collapsed config cards', async () => {
    // The always-on half of the page: status, actions, stat tiles, accounts
    // with balances. (The account rows, balances and drift banner get their own
    // dedicated coverage in OverviewTab.test.tsx; this just proves the tab is
    // still wired into the page and the page's own controls render beside it.)
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument());
    expect(headerButton(/deep scan/i)).toBeInTheDocument();
    expect(screen.getByText('Accounts synced')).toBeInTheDocument();
  });

  it('keeps the technical meaning of the renamed reconcile button in its tooltip', async () => {
    // The label went plain-language, but "reconcile & link" is the name in the
    // logs, the docs and the companion — so it stays reachable on hover rather
    // than being deleted outright.
    render(<SyncPage {...makeProps()} />);
    await screen.findByText('Accounts synced');
    expect(headerButton(/deep scan/i).getAttribute('title')).toBe(
      'Re-scans the last 90 days and re-links transfer pairs (reconcile & link)',
    );
  });

  it('names its own busy state after the button, not after the old label', async () => {
    // The rename left `Reconciling…` behind, so the button changed its name to a
    // word that appears nowhere else in the UI the moment it was pressed.
    let release: (v: any) => void = () => {};
    vi.mocked(runSync).mockImplementationOnce(() => new Promise((res) => { release = res; }));
    render(<SyncPage {...makeProps()} />);
    await screen.findByText('Accounts synced');
    fireEvent.click(headerButton(/deep scan/i));

    await waitFor(() => expect(headerButton('Deep scanning…')).toBeTruthy());
    expect(screen.queryByText(/Reconciling/i)).toBeNull();
    release({ imported: 0, skipped: 0, errors: [] });
    await waitFor(() => expect(headerButton('Deep scan')).toBeTruthy());
  });

  // ── The sync error path ────────────────────────────────────────────────
  it('shows the classified sync error and keeps the raw text as a collapsed detail', async () => {
    // What the user actually saw was the broker's raw rejection, URL and query
    // params included. The friendly line goes in the box; the raw text stays
    // reachable, because the last few days of debugging depended on it.
    const raw = 'error sending request for url (https://beta-bridge.simplefin.org/simplefin/accounts?start-date=1777688539&pending=1)';
    const err: any = new Error("Couldn't reach SimpleFin — usually temporary");
    err.detail = raw;
    vi.mocked(runSync).mockRejectedValueOnce(err);

    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    const box = (await screen.findByText(/Couldn't reach SimpleFin/)).closest('.sfin-error')!;
    // The URL is NOT the headline...
    expect(box.querySelector('details')).not.toBeNull();
    // ...but it is still on the page, and still copyable.
    expect(box.querySelector('details')!.textContent).toContain(raw);
  });

  it('renders an error with no underlying detail exactly as before', async () => {
    // Every other error in the app is a plain Error. It must not grow an empty
    // "Technical details" disclosure that reveals nothing.
    vi.mocked(runSync).mockRejectedValueOnce(new Error('Not configured: no account mapping'));
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    const box = (await screen.findByText(/no account mapping/)).closest('.sfin-error')!;
    expect(box.querySelector('details')).toBeNull();
    expect(box.getAttribute('title')).toBeNull();
  });

  it('refreshes the displayed last-synced time when a sync reports the interval skip', async () => {
    // Both statements read the same `last_sync_at`, so "Last synced 4 hours ago"
    // beside "Last sync was under an hour ago, so Sync now was skipped" cannot
    // both be current: the page loaded a value and the COMPANION then synced.
    // The skip is the moment we learn our copy is stale.
    const props = makeProps();
    const stale = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 10 * 60 * 1000);
    props.store.getLastSyncAt = vi.fn()
      .mockResolvedValueOnce(stale)   // initial page load
      .mockResolvedValue(fresh);      // what the companion has since written
    vi.mocked(runSync).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [INTERVAL_SKIP_MESSAGE],
    } as any);

    render(<SyncPage {...props} />);
    await waitFor(() => expect(screen.getByText(/Last synced 4 hours ago/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    await waitFor(() => expect(screen.getByText(/so Sync now was skipped/)).toBeInTheDocument());
    // The two statements now agree.
    expect(screen.getByText(/Last synced 10 minutes ago/)).toBeInTheDocument();
    expect(screen.queryByText(/Last synced 4 hours ago/)).not.toBeInTheDocument();
  });

  // ── The tabbed shell ───────────────────────────────────────────────────
  it('mounts only the active tab, with the header and both page-wide surfaces outside it', async () => {
    // The whole point of the shell: the page mixed a daily glance with
    // once-ever setup, so the setup half must be absent — not merely hidden —
    // while Overview is on screen.
    render(<SyncPage {...makeProps()} />);
    await screen.findByText('Accounts synced');
    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);

    const panel = document.querySelector('#sfin-panel-overview')!;
    expect(panel.getAttribute('aria-labelledby')).toBe('sfin-tab-overview');
    // Focusable, so tabbing off the tablist ENTERS the panel. A panel whose
    // content starts with plain text has nothing focusable of its own, and
    // without this the whole panel is skipped.
    expect(panel.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-controls'))
      .toBe('sfin-panel-overview');
    // The other two tabs' content is unmounted.
    expect(screen.queryByRole('button', { name: /^Telegram connection/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Auto-sync/i })).toBeNull();
    // ...and the header/footer are the shell's, not the panel's.
    expect(panel.contains(screen.getByRole('button', { name: /sync now/i }))).toBe(false);
    expect(panel.contains(screen.getByRole('tablist'))).toBe(false);

    await switchTab(/advanced/i);
    expect(await screen.findByRole('button', { name: /^Auto-sync/i })).toBeTruthy();
    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    expect(document.querySelector('#sfin-panel-advanced')).toBeTruthy();
    expect(screen.queryByText('Accounts synced')).toBeNull();
    // The header buttons work from every tab, which is what makes hazard 1 below
    // possible in the first place.
    expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument();
    expect(headerButton(/deep scan/i)).toBeInTheDocument();
  });

  it('persists the active tab across mounts', async () => {
    const props = makeProps();
    let saved: any = {};
    props.store.getUiState = vi.fn(async () => saved) as any;
    props.store.setUiState = vi.fn(async (s: any) => { saved = s; }) as any;

    const { unmount } = render(<SyncPage {...props} />);
    await switchTab(/advanced/i);
    await waitFor(() => expect(saved.activeTab).toBe('advanced'));
    unmount();

    render(<SyncPage {...props} />);
    await waitFor(() => expect(
      screen.getByRole('tab', { name: /advanced/i }).getAttribute('aria-selected'),
    ).toBe('true'));
  });

  it('falls back to Overview when the stored tab is not one we can render', async () => {
    // `ui_state` is an unvalidated stored blob that now decides what renders. A
    // hand-edited secret — or a fourth tab written by a newer build the user then
    // downgrades away from — would otherwise select no tab and mount no panel:
    // a blank page with no way back.
    const props = makeProps();
    props.store.getUiState = vi.fn(async () => ({ activeTab: 'reports' }) as any);
    render(<SyncPage {...props} />);

    expect(await screen.findByText('Accounts synced')).toBeTruthy();
    expect(document.querySelector('#sfin-panel-overview')).toBeTruthy();
    await waitFor(() => expect(
      screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-selected'),
    ).toBe('true'));
    // Exactly one panel and exactly one selected tab — never zero of either.
    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    expect(document.querySelectorAll('[role="tab"][aria-selected="true"]')).toHaveLength(1);
  });

  it('remembers the tab without forgetting the dismissed checklist', async () => {
    // Read-modify-write both ways: `ui_state` is one blob, so switching tabs
    // must not resurrect a checklist the user dismissed.
    const props = makeProps();
    props.store.getUiState = vi.fn(async () => ({ checklistDismissed: true })) as any;
    render(<SyncPage {...props} />);
    await switchTab(/notifications/i);
    await waitFor(() => expect(props.store.setUiState).toHaveBeenCalledWith(
      { checklistDismissed: true, activeTab: 'notifications' },
    ));
  });

  it('checklist deep-link lands on the right tab', async () => {
    // What `onNavigate` was built for — it was a no-op until the tab bar existed.
    render(<SyncPage {...makeProps()} />);
    const checklist = (await screen.findByText(/Finish setting up/i)).closest('.sfin-checklist')!;
    const telegramRow = Array.from(checklist.querySelectorAll('.sfin-checklist-row'))
      .find((row) => /Telegram/i.test(row.textContent ?? ''))!;
    fireEvent.click(telegramRow.querySelector('.sfin-checklist-link')!);

    expect(screen.getByRole('tab', { name: /notifications/i }).getAttribute('aria-selected'))
      .toBe('true');
    // Landed somewhere useful, not just on the right tab index.
    expect(await screen.findByRole('button', { name: /^Telegram connection/i })).toBeTruthy();
  });

  // ── Hazard 1: a notice that would have been reported into an unmounted tab ──
  it('brings the pruned-duplicates notice on screen when the sync ran from another tab', async () => {
    // `Sync now` fires from any tab, but the itemised list of what was DELETED
    // renders inside Overview. Without this, a run started from Advanced would
    // remove rows from the user's ledger and say so into a component that is not
    // mounted — silent data loss.
    vi.mocked(runSync).mockResolvedValueOnce({
      imported: 0, skipped: 2, errors: [],
      prunedDuplicates: [
        { sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-3917f117',
          description: 'PNC BANK 1234 Transfer', date: '2026-07-27', amountCents: 130000,
          currency: 'USD', wfId: 'act-2' },
      ],
    } as any);
    render(<SyncPage {...makeProps()} />);
    await switchTab(/advanced/i);
    await screen.findByRole('button', { name: /^Auto-sync/i });

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    const banner = await screen.findByText(/Removed 1 duplicate activity/i);
    expect(banner.closest('.sfin-banner-warn')!.textContent).toContain('$1,300.00');
    expect(screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-selected'))
      .toBe('true');
  });

  it('leaves the tab alone when a sync pruned nothing', async () => {
    // The forced switch is for something the user MUST see. A routine run from
    // the Advanced tab must not yank them off the card they were reading.
    render(<SyncPage {...makeProps()} />);
    await switchTab(/advanced/i);
    await screen.findByRole('button', { name: /^Auto-sync/i });
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    await waitFor(() => expect(screen.getByText(/5 transactions/i)).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /advanced/i }).getAttribute('aria-selected'))
      .toBe('true');
  });

  // ── Hazard 2: a checklist signal that used to be reported by a mounted tab ──
  it('keeps the checklist Telegram row accurate after it is configured on another tab', async () => {
    // NotificationsTab used to report "configured" upward from an effect. Once
    // it unmounts that stops firing, so the checklist on Overview kept saying
    // "get a daily digest" for a user who had just connected a bot. The page
    // derives the row from the stored config instead.
    const props = makeProps();
    let stored: any = null;
    props.store.getTelegramConfig = vi.fn(async () => stored) as any;
    props.store.setTelegramConfig = vi.fn(async (c: any) => { stored = c; }) as any;
    render(<SyncPage {...props} />);
    expect(await screen.findByText(/Telegram reports — get a daily digest/)).toBeTruthy();

    await switchTab(/notifications/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Telegram connection/i }));
    fireEvent.change(await screen.findByLabelText(/Bot Token/i), { target: { value: 'tok' } });
    fireEvent.change(screen.getByLabelText(/Chat ID/i), { target: { value: '42' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());

    await switchTab(/overview/i);
    expect(await screen.findByText(/Telegram reports — connected/)).toBeTruthy();
  });

  // ── Hazard 4: typed input that used to die with its panel ──────────────
  //
  // The drafts were `useState` inside the tabs, and `TabPanel` genuinely
  // unmounts an inactive tab. So a bot token or an IMAP app password typed and
  // not yet saved was destroyed by one click on another tab — with no warning,
  // and with the save bar afterwards reporting that nothing was pending. Both
  // drafts now live in the shell.
  it('keeps a half-typed bot token when the user glances at another tab', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    await switchTab(/notifications/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Telegram connection/i }));
    fireEvent.change(await screen.findByLabelText(/Bot Token/i), {
      target: { value: '123456:half-typed-token' },
    });
    fireEvent.change(screen.getByLabelText(/Chat ID/i), { target: { value: '42' } });
    expect(await screen.findByText(/You have unsaved changes/i)).toBeTruthy();

    // The exact trip that lost it: over to Overview to check a balance, back.
    await switchTab(/overview/i);
    await screen.findByText('Accounts synced');
    await switchTab(/notifications/i);

    const token = await screen.findByLabelText(/Bot Token/i);
    expect((token as HTMLInputElement).value).toBe('123456:half-typed-token');
    expect((screen.getByLabelText(/Chat ID/i) as HTMLInputElement).value).toBe('42');
    // ...and the bar still says so. Silently reverting to "nothing to save" was
    // half the damage: it told the user the field had never been filled in.
    expect(screen.getByText(/You have unsaved changes/i)).toBeTruthy();
    // Nothing was written on the way past — the draft survived UNSAVED, which is
    // the state the user left it in. (Auto-saving a credential the user has not
    // committed would be a different bug, not a fix.)
    expect(props.store.setTelegramConfig).not.toHaveBeenCalled();
  });

  it('keeps a pasted Amazon app password when the user glances at another tab', async () => {
    // Worse than the token: an app password has to be generated at Google, so
    // losing it silently costs a trip back through that flow.
    render(<SyncPage {...makeProps()} />);
    await switchTab(/advanced/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Amazon categorization/i }));
    fireEvent.change(await screen.findByLabelText(/Mailbox address/i), {
      target: { value: 'receipts@gmail.com' },
    });
    fireEvent.change(screen.getByLabelText(/App password/i), {
      target: { value: 'abcd efgh ijkl mnop' },
    });
    expect(await screen.findByText(/You have unsaved changes/i)).toBeTruthy();

    await switchTab(/overview/i);
    await screen.findByText('Accounts synced');
    await switchTab(/advanced/i);

    const pass = await screen.findByLabelText(/App password/i);
    expect((pass as HTMLInputElement).value).toBe('abcd efgh ijkl mnop');
    expect((screen.getByLabelText(/Mailbox address/i) as HTMLInputElement).value)
      .toBe('receipts@gmail.com');
    expect(screen.getByText(/You have unsaved changes/i)).toBeTruthy();
  });

  it('keeps the draft when a pruning sync forces the tab out from under it', async () => {
    // `reportPruned` deliberately yanks the user to Overview so the record of
    // what was DELETED is visible — and `Sync now` is in the header, so it fires
    // while someone is mid-edit. That forced switch used to unmount the draft
    // with it. It costs a tab preference now, and nothing else.
    vi.mocked(runSync).mockResolvedValueOnce({
      imported: 0, skipped: 2, errors: [],
      prunedDuplicates: [
        { sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-3917f117',
          description: 'PNC BANK 1234 Transfer', date: '2026-07-27', amountCents: 130000,
          currency: 'USD', wfId: 'act-2' },
      ],
    } as any);
    render(<SyncPage {...makeProps()} />);
    await switchTab(/notifications/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Telegram connection/i }));
    fireEvent.change(await screen.findByLabelText(/Bot Token/i), {
      target: { value: 'tok-mid-edit' },
    });

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await screen.findByText(/Removed 1 duplicate activity/i);
    expect(screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-selected'))
      .toBe('true');

    await switchTab(/notifications/i);
    expect(((await screen.findByLabelText(/Bot Token/i)) as HTMLInputElement).value)
      .toBe('tok-mid-edit');
    expect(screen.getByText(/You have unsaved changes/i)).toBeTruthy();
  });

  // ── Hazard 5: a late mount load overwriting what the user already did ──
  //
  // The mount `Promise.all` waits on an IPC round-trip, so resolving after the
  // first click is ordinary rather than a race you have to try to hit — and it
  // used to assign the tab, the checklist dismissal and the open cards
  // unconditionally when it landed.
  it('keeps the tab the user picked before the mount load resolved', async () => {
    const props = makeProps();
    let release: (v: any) => void = () => {};
    props.ctx.api.accounts.getAll = vi.fn(() => new Promise((res) => { release = res; }));
    // Storage says Notifications, the user says Advanced, and the user is the one
    // who is right.
    props.store.getUiState = vi.fn(async () => ({ activeTab: 'notifications' })) as any;
    props.store.getLastSyncImported = vi.fn(async () => 7) as any;

    render(<SyncPage {...props} />);
    await switchTab(/advanced/i);
    expect(await screen.findByRole('button', { name: /^Auto-sync/i })).toBeTruthy();

    release([{ id: 'wf-a', name: 'Checking' }]);
    // Proves the hydration actually ran: `imported` comes from the same load.
    await screen.findByText(/7 transactions/i);

    expect(screen.getByRole('tab', { name: /advanced/i }).getAttribute('aria-selected'))
      .toBe('true');
    expect(screen.getByRole('button', { name: /^Auto-sync/i })).toBeTruthy();
  });

  it('keeps a checklist dismissed before the mount load resolved', async () => {
    // The case that could never recover: nothing else ever writes
    // `checklistDismissed`, so a dropped dismissal brings the checklist back on
    // every future session, permanently.
    const props = makeProps();
    let release: (v: any) => void = () => {};
    props.ctx.api.accounts.getAll = vi.fn(() => new Promise((res) => { release = res; }));
    props.store.getUiState = vi.fn(async () => ({})) as any;
    props.store.getLastSyncImported = vi.fn(async () => 7) as any;

    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /Dismiss setup checklist/i }));
    expect(screen.queryByText(/Finish setting up/i)).toBeNull();

    release([{ id: 'wf-a', name: 'Checking' }]);
    await screen.findByText(/7 transactions/i);

    expect(screen.queryByText(/Finish setting up/i)).toBeNull();
    // ...and it was persisted, so the next session agrees with the screen.
    await waitFor(() => expect(props.store.setUiState)
      .toHaveBeenCalledWith(expect.objectContaining({ checklistDismissed: true })));
  });

  it('keeps a card the user opened before the mount load resolved', async () => {
    const props = makeProps();
    let release: (v: any) => void = () => {};
    props.ctx.api.accounts.getAll = vi.fn(() => new Promise((res) => { release = res; }));
    // Stored state that opens a DIFFERENT card, so a blind assignment is visible.
    props.store.getOpenCards = vi.fn(async () => ({ docker: true })) as any;
    props.store.getLastSyncImported = vi.fn(async () => 7) as any;

    render(<SyncPage {...props} />);
    await switchTab(/advanced/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Auto-sync/i }));
    expect(await screen.findByLabelText(/Auto-sync interval/i)).toBeTruthy();

    release([{ id: 'wf-a', name: 'Checking' }]);
    await screen.findByText(/7 transactions/i);

    expect(screen.getByLabelText(/Auto-sync interval/i)).toBeTruthy();
  });

  // ── Hazard 3: live data that only ever loaded once ─────────────────────
  it('refreshes the needs-a-category count with the rest of the live state', async () => {
    // The companion republishes this every sync, and the tile used to read it
    // once on mount — unlike the balances and the companion version beside it —
    // so it could sit stale for an entire session.
    const props = makeProps();
    let status: any = { count: 3, asOf: '2026-08-08T12:00:00Z', rows: [] };
    props.store.getUncategorizedStatus = vi.fn(async () => status) as any;
    render(<SyncPage {...props} />);
    const tile = (await screen.findByText(/Needs a category/i)).closest('.sfin-tile')!;
    expect(tile.textContent).toContain('3');

    // What the companion published since. Focus is the refresh trigger the
    // balances already use.
    status = { count: 11, asOf: '2026-08-09T09:00:00Z', rows: [] };
    fireEvent.focus(window);
    await waitFor(() => expect(tile.textContent).toContain('11'));
    expect(tile.getAttribute('title')).toContain('2026-08-09T09:00:00Z');
  });

});
