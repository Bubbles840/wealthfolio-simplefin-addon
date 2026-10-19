import { describe, it, expect, vi } from 'vitest';
import type { SelfCheckFinding } from '../../shared/self-check.js';
import { findingHandle, findingLabel } from '../../shared/findings.js';
import { SYNC_OVERRIDES_UNREADABLE_MESSAGE, SyncOverridesUnreadableError } from '../../shared/sync-overrides.js';
import { accountTxKey } from '../../shared/transfers.js';
import type { GatheredFindings } from './daily-findings.js';
import {
  createFindingsMenu,
  renderFindingsList,
  SHOW_FINDINGS_BUTTON,
  type FindingsMenuDeps,
  type FindingsMenuUi,
} from './findings-menu.js';

const NOW = new Date('2026-10-09T12:00:00Z');

const feed: SelfCheckFinding = {
  kind: 'feed-stale',
  severity: 'warning',
  key: 'feed-stale:Discover',
  label: 'Discover: no new data',
  message: 'Discover has sent no new data in over 14 days — reconnect it',
};

const citi: SelfCheckFinding = {
  kind: 'ledger',
  severity: 'warning',
  key: 'grouped-non-transfer:g1',
  label: 'Payment to Citiba… $94.93 counts as spending',
  message: 'Payment to Citibank ($94.93) is linked as a transfer but typed WITHDRAWAL',
  fix: {
    kind: 'make-transfer',
    activityId: 'g1',
    description: 'Payment to Citibank Credit Card Payments',
    amount: 94.93,
    activityType: 'WITHDRAWAL',
  },
};

const venmo: SelfCheckFinding = {
  kind: 'ledger',
  severity: 'warning',
  key: 'idle-refund:r1',
  label: 'Venmo $50.00 no category',
  message: 'Transfer from Venmo ($50.00) is a refund with no spending category',
  fix: { kind: 'pick-category', activityId: 'r1' },
};

const held: SelfCheckFinding = {
  kind: 'ledger',
  severity: 'warning',
  key: 'held-transfer:ph-1',
  label: 'WIRE TRANSFER TO … $250.00 still in transit',
  message: "WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — Harbor Savings's feed is behind, so it stays on hold",
  fix: {
    kind: 'not-transfer', txKey: accountTxKey('sfin-chk', 'w-old'), label: 'WIRE TRANSFER TO ACME LLC · Checking',
    description: 'WIRE TRANSFER TO ACME LLC', amount: 250, direction: 'out',
  },
};

const failing: SelfCheckFinding = {
  kind: 'sync-failing',
  severity: 'problem',
  message: 'sync has been failing for 14h',
};

function makeDeps(initialState: GatheredFindings = { visible: [], snoozed: [] }) {
  const state: GatheredFindings = {
    visible: [...initialState.visible],
    snoozed: [...initialState.snoozed],
  };
  const deps: FindingsMenuDeps = {
    current: vi.fn(async () => state),
    snooze: vi.fn(async () => {}),
    unsnoozeAll: vi.fn(async () => {}),
    makeTransfer: vi.fn(async () => {}),
    pickCategory: vi.fn(async () => {}),
    markNotTransfer: vi.fn(async () => {}),
    now: () => NOW,
    log: vi.fn(),
  };
  return { deps, state };
}

const makeUi = (): FindingsMenuUi => ({
  edit: vi.fn(async () => {}),
  answer: vi.fn(async () => {}),
  send: vi.fn(async () => {}),
});

describe('findings-menu', () => {
  it('handles(): true for "cz:fx:o", false for "cz:tl:1" and "d:abc"', () => {
    // Only callback data starting with the findings prefix belongs to this menu.
    const menu = createFindingsMenu(makeDeps().deps);
    expect(menu.handles(SHOW_FINDINGS_BUTTON.callback_data)).toBe(true);
    expect(menu.handles('cz:fx:o')).toBe(true);
    expect(menu.handles('cz:tl:1')).toBe(false);
    expect(menu.handles('d:abc')).toBe(false);
  });

  it('tapping SHOW_FINDINGS_BUTTON sends a NEW message without editing the report', async () => {
    // The morning report is the only copy of the day's numbers in the chat;
    // drawing the menu over it would destroy them.
    const { deps } = makeDeps({ visible: [feed], snoozed: [] });
    const ui = makeUi();
    await createFindingsMenu(deps).onCallback({ data: SHOW_FINDINGS_BUTTON.callback_data, chatId: 42 }, ui);

    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.edit).not.toHaveBeenCalled();
    expect(ui.answer).toHaveBeenCalledTimes(1);
  });

  it('renderFindingsList: generates numbered action rows for actionable findings and footer with refresh/unsnooze', () => {
    // A failing sync has no key and no fix, so it is said in full in the text
    // only; feed (2) and citi (3) get buttons numbered like the text.
    const { keyboard } = renderFindingsList({ visible: [failing, feed, citi], snoozed: [feed, citi] });

    expect(keyboard.inline_keyboard).toEqual([
      [{ text: `2. ${findingLabel(feed, 36)}`, callback_data: `cz:fx:d:${findingHandle(feed.key!)}` }],
      [{ text: `3. ${findingLabel(citi, 36)}`, callback_data: `cz:fx:d:${findingHandle(citi.key!)}` }],
      [
        { text: '🔄 Refresh', callback_data: 'cz:fx:l' },
        { text: '↩ Unsnooze 2', callback_data: 'cz:fx:u' },
      ],
    ]);
  });

  it('detail tap for citi edits the message with text containing "linked as a transfer" and action buttons', async () => {
    const { deps } = makeDeps({ visible: [citi], snoozed: [] });
    const ui = makeUi();
    const handle = findingHandle(citi.key!);
    await createFindingsMenu(deps).onCallback({ data: `cz:fx:d:${handle}`, chatId: 42 }, ui);

    expect(ui.edit).toHaveBeenCalledWith(
      expect.stringContaining('linked as a transfer'),
      {
        inline_keyboard: [
          [{ text: '↔ Make it a transfer', callback_data: `cz:fx:f:${handle}` }],
          [{ text: '💤 Snooze 30 days', callback_data: `cz:fx:s:${handle}` }],
          [{ text: '‹ Back', callback_data: 'cz:fx:l' }],
        ],
      },
    );
    expect(ui.answer).toHaveBeenCalledTimes(1);
  });

  it('detail tap for feed (no fix) shows Snooze and Back but no fix button, and includes informational hint', async () => {
    // Nothing here can reconnect a bank feed, so the screen says so rather
    // than offering a button that would do nothing.
    const { deps } = makeDeps({ visible: [feed], snoozed: [] });
    const ui = makeUi();
    const handle = findingHandle(feed.key!);
    await createFindingsMenu(deps).onCallback({ data: `cz:fx:d:${handle}`, chatId: 42 }, ui);

    expect(ui.edit).toHaveBeenCalledWith(
      expect.stringContaining('Snooze it if you already know'),
      {
        inline_keyboard: [
          [{ text: '💤 Snooze 30 days', callback_data: `cz:fx:s:${handle}` }],
          [{ text: '‹ Back', callback_data: 'cz:fx:l' }],
        ],
      },
    );
  });

  it('snooze tap calls deps.snooze, re-renders the list via ui.edit, and answers with toast', async () => {
    const { deps } = makeDeps({ visible: [feed], snoozed: [] });
    const ui = makeUi();
    await createFindingsMenu(deps).onCallback({ data: `cz:fx:s:${findingHandle(feed.key!)}`, chatId: 42 }, ui);

    expect(deps.snooze).toHaveBeenCalledWith('feed-stale:Discover', NOW);
    expect(ui.edit).toHaveBeenCalledTimes(1);
    expect(ui.answer).toHaveBeenCalledWith('Snoozed for 30 days');
  });

  it('fix tap on citi calls deps.makeTransfer with citi.fix and ui (and does not call pickCategory)', async () => {
    // The fix is a hand-off to the rule confirmation, which previews before
    // it writes anything.
    const { deps } = makeDeps({ visible: [citi], snoozed: [] });
    const ui = makeUi();
    await createFindingsMenu(deps).onCallback({ data: `cz:fx:f:${findingHandle(citi.key!)}`, chatId: 42 }, ui);

    expect(deps.makeTransfer).toHaveBeenCalledWith(citi.fix, ui);
    expect(deps.pickCategory).not.toHaveBeenCalled();
  });

  it('fix tap on venmo calls deps.pickCategory with activityId, chatId, and ui, then answers', async () => {
    const { deps } = makeDeps({ visible: [venmo], snoozed: [] });
    const ui = makeUi();
    await createFindingsMenu(deps).onCallback({ data: `cz:fx:f:${findingHandle(venmo.key!)}`, chatId: 42 }, ui);

    expect(deps.pickCategory).toHaveBeenCalledWith('r1', 42, ui);
    expect(ui.answer).toHaveBeenCalledTimes(1);
  });

  it('detail tap whose handle matches no current finding re-renders list with ui.edit and answers with toast', async () => {
    // Fixed between the report and the tap: the truth is the fresh list.
    const { deps } = makeDeps({ visible: [], snoozed: [] });
    const ui = makeUi();
    await createFindingsMenu(deps).onCallback({ data: `cz:fx:d:${findingHandle('already-sorted')}`, chatId: 42 }, ui);

    expect(ui.edit).toHaveBeenCalledTimes(1);
    expect(ui.answer).toHaveBeenCalledWith('That one is already sorted — refreshing.');
  });

  it('unsnooze-all tap calls deps.unsnoozeAll(NOW) and answers "Snoozes cleared"', async () => {
    const { deps } = makeDeps({ visible: [], snoozed: [feed, citi] });
    const ui = makeUi();
    await createFindingsMenu(deps).onCallback({ data: 'cz:fx:u', chatId: 42 }, ui);

    expect(deps.unsnoozeAll).toHaveBeenCalledWith(NOW);
    expect(ui.edit).toHaveBeenCalledTimes(1);
    expect(ui.answer).toHaveBeenCalledWith('Snoozes cleared');
  });

  it('if deps.current throws, onCallback does not throw, logs error, and answers with error toast', async () => {
    // A tap runs inside the Telegram listener; a rejection escaping it would
    // take the daemon — and bank syncing — down with it.
    const { deps } = makeDeps();
    deps.current = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const ui = makeUi();

    await expect(
      createFindingsMenu(deps).onCallback({ data: SHOW_FINDINGS_BUTTON.callback_data, chatId: 42 }, ui),
    ).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('database unavailable'));
    expect(ui.answer).toHaveBeenCalledWith('Could not do that — check the companion logs.');
  });

  describe('"Not a transfer" on a held transfer (1.65 C)', () => {
    const handle = findingHandle(held.key!);

    it('the detail screen offers it', async () => {
      const { deps } = makeDeps({ visible: [held], snoozed: [] });
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:d:${handle}`, chatId: 42 }, ui);
      expect(ui.edit).toHaveBeenCalledWith(expect.stringContaining("Harbor Savings's feed is behind"), {
        inline_keyboard: [
          [{ text: '✋ Not a transfer', callback_data: `cz:fx:f:${handle}` }],
          [{ text: '💤 Snooze 30 days', callback_data: `cz:fx:s:${handle}` }],
          [{ text: '‹ Back', callback_data: 'cz:fx:l' }],
        ],
      });
    });

    it('asks before it writes: a confirm screen, nothing written yet', async () => {
      const { deps } = makeDeps({ visible: [held], snoozed: [] });
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:f:${handle}`, chatId: 42 }, ui);
      expect(ui.edit).toHaveBeenCalledWith(
        'Count WIRE TRANSFER TO ACME LLC ($250.00) as spending and stop waiting for its other half? The next sync makes the change.',
        { inline_keyboard: [
          [{ text: '✋ Yes, not a transfer', callback_data: `cz:fx:n:${handle}` }],
          [{ text: '‹ Back', callback_data: `cz:fx:d:${handle}` }],
        ] },
      );
      expect(deps.markNotTransfer).not.toHaveBeenCalled();
      expect(deps.makeTransfer).not.toHaveBeenCalled();
      expect(deps.pickCategory).not.toHaveBeenCalled();
    });

    it('the confirm writes notTransfer for that transaction and shows the list again', async () => {
      const { deps } = makeDeps({ visible: [held], snoozed: [] });
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:n:${handle}`, chatId: 42 }, ui);
      expect(deps.markNotTransfer).toHaveBeenCalledWith(held.fix, NOW);
      expect(ui.edit).toHaveBeenCalledTimes(1);
      expect(ui.answer).toHaveBeenCalledWith('Done — the next sync counts it as spending');
    });

    it('a confirm for a finding that has since cleared writes nothing', async () => {
      const { deps } = makeDeps({ visible: [], snoozed: [] });
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:n:${handle}`, chatId: 42 }, ui);
      expect(deps.markNotTransfer).not.toHaveBeenCalled();
      expect(ui.answer).toHaveBeenCalledWith('That one is already sorted — refreshing.');
    });

    it('a confirm on a finding with a different fix writes nothing', async () => {
      const { deps } = makeDeps({ visible: [venmo], snoozed: [] });
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:n:${findingHandle(venmo.key!)}`, chatId: 42 }, ui);
      expect(deps.markNotTransfer).not.toHaveBeenCalled();
    });

    it('says so when the overrides cannot be read', async () => {
      const { deps } = makeDeps({ visible: [held], snoozed: [] });
      deps.markNotTransfer = vi.fn().mockRejectedValue(new SyncOverridesUnreadableError());
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:n:${handle}`, chatId: 42 }, ui);
      expect(ui.answer).toHaveBeenCalledWith(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
      expect(ui.edit).not.toHaveBeenCalled();
    });
  });
});
