import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import type { MappingRule, AccountMapping } from '../../shared/types';
import type { UiState } from './secrets';
import { UNCATEGORIZED_STATUS_SECRET_KEY, AMAZON_MAIL_STATUS_SECRET_KEY } from '../../shared/status-keys';
import { AMAZON_LABELS_SECRET_KEY } from '../../shared/amazon-config';

/** Builds a ctx plus its backing secrets map. `makeCtx` (below) wraps this and
 *  discards the map, for the ~40 call sites that only need the ctx; tests that
 *  need to read/write raw key strings directly — e.g. asserting the dismissal
 *  ledger lands under the exact key the companion reads — use this instead. */
const makeCtxWithData = () => {
  const data: Record<string, string> = {};
  const ctx = {
    api: {
      secrets: {
        get: vi.fn(async (k: string) => data[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
        delete: vi.fn(async (k: string) => { delete data[k]; }),
      },
    },
  } as any;
  return { ctx, data };
};

const makeCtx = () => makeCtxWithData().ctx;

describe('SecretsStore', () => {
  it('defaults weekly capping ON and stores only the opt-out, under the key the companion reads', async () => {
    // Two independent writers share these secrets, so the key string is the
    // contract: the companion reads the literal 'cap_weekly_to_pool'. And the
    // opt-OUT storage is what makes the default reach every existing install
    // without a migration — an absent value must mean on, not off.
    const { ctx, data } = makeCtxWithData();
    const s = new SecretsStore(ctx);
    expect(await s.getCapWeeklyToPool()).toBe(true);

    await s.setCapWeeklyToPool(false);
    expect(data['cap_weekly_to_pool']).toBe('off');
    expect(await s.getCapWeeklyToPool()).toBe(false);

    await s.setCapWeeklyToPool(true);
    expect(await s.getCapWeeklyToPool()).toBe(true);
  });

  it('defaults the over-budget spent figures to the monthly total, under the key the companion reads', async () => {
    const { ctx, data } = makeCtxWithData();
    const s = new SecretsStore(ctx);
    expect(await s.getOverBudgetSpent()).toBe('total');
    await s.setOverBudgetSpent('all');
    expect(data['over_budget_spent']).toBe('all');
    expect(await s.getOverBudgetSpent()).toBe('all');
    // A value this build does not know reads as the default, never as a crash
    // or a surprise mode — a newer addon must not break an older one.
    data['over_budget_spent'] = 'something-from-the-future';
    expect(await s.getOverBudgetSpent()).toBe('total');
  });

  it('defaults the month projection ON and stores only the opt-out, under the companion\'s key', async () => {
    const { ctx, data } = makeCtxWithData();
    const s = new SecretsStore(ctx);
    expect(await s.getMonthProjection()).toBe(true);
    await s.setMonthProjection(false);
    expect(data['month_projection']).toBe('off');
    expect(await s.getMonthProjection()).toBe(false);
  });

  it('roundtrips access URL', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    await s.setAccessUrl('https://user:pass@bridge.simplefin.org/simplefin');
    expect(await s.getAccessUrl()).toBe('https://user:pass@bridge.simplefin.org/simplefin');
  });

  it('returns null when access URL not set', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    expect(await s.getAccessUrl()).toBeNull();
  });

  it('roundtrips account mapping as JSON', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    const mapping: AccountMapping = { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' };
    await s.setAccountMapping(mapping);
    expect(await s.getAccountMapping()).toEqual(mapping);
  });

  it('roundtrips mapping rules as JSON', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    const rules: MappingRule[] = [
      { pattern: 'dividend', matchType: 'contains', activityType: 'DIVIDEND' },
    ];
    await s.setMappingRules(rules);
    expect(await s.getMappingRules()).toEqual(rules);
  });

  it('roundtrips syncScheduleHours', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    await s.setSyncScheduleHours(6);
    expect(await s.getSyncScheduleHours()).toBe(6);
  });

  it('roundtrips lastSyncAt as ISO date', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    const now = new Date('2024-06-01T12:00:00Z');
    await s.setLastSyncAt(now);
    const result = await s.getLastSyncAt();
    expect(result?.toISOString()).toBe(now.toISOString());
  });

  it('clearAll deletes all keys', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    await s.setAccessUrl('https://user:pass@bridge.simplefin.org/simplefin');
    await s.setSyncScheduleHours(6);
    await s.clearAll();
    expect(await s.getAccessUrl()).toBeNull();
    expect(await s.getSyncScheduleHours()).toBeNull();
  });

  it('clearAll deletes the companion-published uncategorized-status secret too', async () => {
    // uncategorized_status has no SecretsStore setter (the companion writes it
    // directly), which is exactly why it was easy to leave out of KEYS — and
    // doing so meant a reset left the stale "Needs a category" tile visible
    // against a freshly-disconnected account.
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    await ctx.api.secrets.set(UNCATEGORIZED_STATUS_SECRET_KEY, JSON.stringify({ count: 4, asOf: '2026-08-08' }));
    expect(await s.getUncategorizedStatus()).toEqual({ count: 4, asOf: '2026-08-08', rows: [] });
    await s.clearAll();
    expect(await s.getUncategorizedStatus()).toBeNull();
  });

  it('clearAll deletes the Amazon mailbox config, ledger and label catalog too', async () => {
    // Same class of bug as uncategorized_status above: getAmazonConfig,
    // getAmazonLabels and getAmazonLedger all read/write their key constants
    // directly rather than through KEYS, so "Reset" used to leave the Amazon
    // app password (and everything else Amazon) sitting in storage even
    // though the reset copy promised to clear "any Amazon setup".
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    await s.setAmazonConfig({
      enabled: true, host: 'imap.gmail.com', user: 'r@g.com', password: 'app-pass',
      defaultCategory: 'Shopping', labelOverrides: {},
    });
    await s.setAmazonLedger({ 'order-1': { orderDate: '2026-08-01', category: 'Shopping' } } as any);
    // No SecretsStore setter for labels — the companion writes this one
    // directly, like uncategorized_status.
    await ctx.api.secrets.set(AMAZON_LABELS_SECRET_KEY, JSON.stringify({
      'Lawn & Garden': { category: 'Housing', matched: true },
    }));

    expect(await s.getAmazonConfig()).not.toBeNull();
    expect(await s.getAmazonLedger()).not.toEqual({});
    expect(await s.getAmazonLabels()).not.toEqual({});

    await s.clearAll();

    expect(await s.getAmazonConfig()).toBeNull();
    expect(await s.getAmazonLedger()).toEqual({});
    expect(await s.getAmazonLabels()).toEqual({});
  });

  it('clearAll deletes the companion-published Amazon mail status too', async () => {
    // Same class of bug as uncategorized_status: no SecretsStore setter (the
    // companion writes it directly), so it is exactly the kind of key that is
    // easy to leave out of KEYS and have survive a reset.
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    await ctx.api.secrets.set(AMAZON_MAIL_STATUS_SECRET_KEY, JSON.stringify({ unparsed: 2, asOf: '2026-08-08' }));
    expect(await s.getAmazonMailStatus()).toEqual({ unparsed: 2, asOf: '2026-08-08' });
    await s.clearAll();
    expect(await s.getAmazonMailStatus()).toBeNull();
  });
});

describe('SecretsStore transfer link failures', () => {
  it('returns an empty record when nothing is stored', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    expect(await store.getTransferLinkFailures()).toEqual({});
  });

  it('round-trips a stored failure map', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    await store.setTransferLinkFailures({
      'tx-out-1': { count: 3, firstFailedAt: '2026-07-27T00:00:00Z', alerted: true },
    });
    expect(await store.getTransferLinkFailures()).toEqual({
      'tx-out-1': { count: 3, firstFailedAt: '2026-07-27T00:00:00Z', alerted: true },
    });
  });
});

describe('SecretsStore available report categories', () => {
  it('returns an empty array when the companion has never published categories', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    expect(await store.getAvailableReportCategories()).toEqual([]);
  });

  it('parses the category-name array published by the companion', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    // The companion publishes this secret directly via wfClient.setAddonSecret,
    // not through a SecretsStore setter — simulate that by writing the raw key.
    await ctx.api.secrets.set('available_report_categories', JSON.stringify(['Dining', 'Groceries']));
    expect(await store.getAvailableReportCategories()).toEqual(['Dining', 'Groceries']);
  });
});

describe('SecretsStore notification thresholds', () => {
  it('reads the large-transaction threshold out of telegram_config', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);

    // Never configured → null, which runSyncCore reads as "off".
    expect(await store.getLargeTransactionThreshold()).toBeNull();

    await store.setTelegramConfig({ botToken: 'tok', chatId: '1', enabled: true, largeTransactionThreshold: 750 });
    expect(await store.getLargeTransactionThreshold()).toBe(750);

    // An explicit 0 must survive as 0 rather than being collapsed into null —
    // see the same note on RestSyncStore.
    await store.setTelegramConfig({ largeTransactionThreshold: 0 });
    expect(await store.getLargeTransactionThreshold()).toBe(0);

    await store.setTelegramConfig({ largeTransactionThreshold: '750' });
    expect(await store.getLargeTransactionThreshold()).toBeNull();
  });

  it('reads the drift-alert threshold out of telegram_config, keeping an explicit 0', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);

    // Absent → null, which runSyncCore turns into its $100 default. Explicit 0
    // means OFF, so it must not be reported as absent.
    expect(await store.getDriftAlertThreshold()).toBeNull();
    await store.setTelegramConfig({ driftAlertThreshold: 0 });
    expect(await store.getDriftAlertThreshold()).toBe(0);
    await store.setTelegramConfig({ driftAlertThreshold: 250 });
    expect(await store.getDriftAlertThreshold()).toBe(250);
  });

  it('roundtrips drift alerts as JSON', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    expect(await store.getDriftAlerts()).toEqual({});
    await store.setDriftAlerts({
      'sfin-1': { driftAmount: 1300, firstDetectedAt: '2026-07-29T00:00:00Z', alerted: true },
    });
    expect(ctx.api.secrets.set).toHaveBeenCalledWith(
      'drift_alerts',
      '{"sfin-1":{"driftAmount":1300,"firstDetectedAt":"2026-07-29T00:00:00Z","alerted":true}}',
    );
    expect(await store.getDriftAlerts()).toEqual({
      'sfin-1': { driftAmount: 1300, firstDetectedAt: '2026-07-29T00:00:00Z', alerted: true },
    });
  });
});

describe('SecretsStore open-card state', () => {
  it('roundtrips which collapsible cards are open', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    // Never stored → nothing open, which is the page's default anyway.
    expect(await store.getOpenCards()).toEqual({});
    await store.setOpenCards({ telegram: true, rules: false });
    expect(ctx.api.secrets.set).toHaveBeenCalledWith('ui_open_cards', '{"telegram":true,"rules":false}');
    expect(await store.getOpenCards()).toEqual({ telegram: true, rules: false });
  });

  it('degrades to "everything closed" on a malformed or non-object value', async () => {
    // Purely cosmetic state: a corrupt value must not throw out of the page's
    // load Promise.all and take the whole Sync page down with it.
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    await ctx.api.secrets.set('ui_open_cards', 'not json{');
    expect(await store.getOpenCards()).toEqual({});
    await ctx.api.secrets.set('ui_open_cards', '["telegram"]');
    expect(await store.getOpenCards()).toEqual({});
    await ctx.api.secrets.set('ui_open_cards', 'null');
    expect(await store.getOpenCards()).toEqual({});
  });

  it('is wiped by clearAll, like every other addon key', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    await store.setOpenCards({ telegram: true });
    await store.clearAll();
    expect(await store.getOpenCards()).toEqual({});
  });
});

describe('ui_state', () => {
  it('round-trips the active tab and checklist dismissal', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    await store.setUiState({ activeTab: 'advanced', checklistDismissed: true } satisfies UiState);
    expect(await store.getUiState()).toEqual({ activeTab: 'advanced', checklistDismissed: true });
  });

  it('reads absent or corrupt state as {} rather than throwing', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    expect(await store.getUiState()).toEqual({});
    await ctx.api.secrets.set('ui_state', 'not json{');
    expect(await store.getUiState()).toEqual({});
  });
});

describe('uncategorized_status', () => {
  it('parses the companion-published count', async () => {
    const ctx = makeCtx();
    await ctx.api.secrets.set('uncategorized_status', JSON.stringify({ count: 3, asOf: '2026-08-08T12:00:00.000Z' }));
    const store = new SecretsStore(ctx);
    expect(await store.getUncategorizedStatus()).toEqual({ count: 3, asOf: '2026-08-08T12:00:00.000Z', rows: [] });
  });

  it('returns null for absent, corrupt, or count-less values — the tile must hide, not crash', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    expect(await store.getUncategorizedStatus()).toBeNull();
    await ctx.api.secrets.set('uncategorized_status', '{"asOf":"x"}');
    expect(await store.getUncategorizedStatus()).toBeNull();
    await ctx.api.secrets.set('uncategorized_status', 'garbage');
    expect(await store.getUncategorizedStatus()).toBeNull();
  });
});

describe('amazon_mail_status', () => {
  it('parses the companion-published unparsed count', async () => {
    const ctx = makeCtx();
    await ctx.api.secrets.set('amazon_mail_status', JSON.stringify({ unparsed: 2, asOf: '2026-08-08T12:00:00.000Z' }));
    const store = new SecretsStore(ctx);
    expect(await store.getAmazonMailStatus()).toEqual({ unparsed: 2, asOf: '2026-08-08T12:00:00.000Z' });
  });

  it('reports a clean scan as unparsed: 0, not absent — a fix must clear the warning', async () => {
    const ctx = makeCtx();
    await ctx.api.secrets.set('amazon_mail_status', JSON.stringify({ unparsed: 0, asOf: '2026-08-08T12:00:00.000Z' }));
    const store = new SecretsStore(ctx);
    expect(await store.getAmazonMailStatus()).toEqual({ unparsed: 0, asOf: '2026-08-08T12:00:00.000Z' });
  });

  it('returns null for absent, corrupt, or non-numeric values — the card must hide, not crash', async () => {
    const ctx = makeCtx();
    const store = new SecretsStore(ctx);
    expect(await store.getAmazonMailStatus()).toBeNull();
    await ctx.api.secrets.set('amazon_mail_status', '{"asOf":"x"}');
    expect(await store.getAmazonMailStatus()).toBeNull();
    await ctx.api.secrets.set('amazon_mail_status', JSON.stringify({ unparsed: 'two', asOf: 'x' }));
    expect(await store.getAmazonMailStatus()).toBeNull();
    await ctx.api.secrets.set('amazon_mail_status', 'garbage');
    expect(await store.getAmazonMailStatus()).toBeNull();
  });
});

describe('uncategorized rows and dismissals', () => {
  const row = { activityId: 'a', date: '2026-08-01', amountCents: 7000,
    description: 'Thankyou Points Redeemed', accountName: 'Citi Double Cash' };

  it('reads the published rows', async () => {
    const { ctx, data } = makeCtxWithData();
    data['uncategorized_status'] = JSON.stringify({ count: 1, asOf: 'x', rows: [row] });
    const store = new SecretsStore(ctx);
    expect((await store.getUncategorizedStatus())?.rows).toEqual([row]);
  });

  it('treats a companion that publishes no rows as an empty list, not a failure', async () => {
    // Version skew: a v1.10.0 companion publishes only count+asOf. The tile must
    // still render; only the list is absent.
    const { ctx, data } = makeCtxWithData();
    data['uncategorized_status'] = JSON.stringify({ count: 3, asOf: 'x' });
    const store = new SecretsStore(ctx);
    const status = await store.getUncategorizedStatus();
    expect(status?.count).toBe(3);
    expect(status?.rows).toEqual([]);
  });

  it('ignores a rows field that is not an array', async () => {
    const { ctx, data } = makeCtxWithData();
    data['uncategorized_status'] = JSON.stringify({ count: 1, asOf: 'x', rows: 'nope' });
    const store = new SecretsStore(ctx);
    expect((await store.getUncategorizedStatus())?.rows).toEqual([]);
  });

  it('round-trips the dismissal ledger through the SAME key the companion reads', async () => {
    const { ctx, data } = makeCtxWithData();
    const store = new SecretsStore(ctx);
    expect(await store.getDismissals()).toEqual({});
    await store.setDismissals({ a: '2026-08-09T00:00:00.000Z' });
    // Asserted on the raw key, not just the round trip: a typo here means the
    // addon and the companion keep separate ledgers and neither notices.
    expect(JSON.parse(data['uncategorized_dismissals'])).toEqual({ a: '2026-08-09T00:00:00.000Z' });
    expect(await store.getDismissals()).toEqual({ a: '2026-08-09T00:00:00.000Z' });
  });

  it('reads a corrupt ledger as empty rather than throwing', async () => {
    const { ctx, data } = makeCtxWithData();
    data['uncategorized_dismissals'] = 'not json{';
    const store = new SecretsStore(ctx);
    expect(await store.getDismissals()).toEqual({});
  });

  it('clearAll deletes the dismissal ledger', async () => {
    // clearAll iterates the KEYS map; three secrets were previously absent from
    // it and survived a reset that claimed to clear everything.
    const { ctx, data } = makeCtxWithData();
    const store = new SecretsStore(ctx);
    await store.setDismissals({ a: '2026-08-09T00:00:00.000Z' });
    await store.clearAll();
    expect(data['uncategorized_dismissals']).toBeUndefined();
  });
});
