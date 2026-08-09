import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import type { MappingRule, AccountMapping } from '../../shared/types';
import type { UiState } from './secrets';
import { UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys';

const makeCtx = () => {
  const store: Record<string, string> = {};
  return {
    api: {
      secrets: {
        get: vi.fn(async (k: string) => store[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { store[k] = v; }),
        delete: vi.fn(async (k: string) => { delete store[k]; }),
      },
    },
  } as any;
};

describe('SecretsStore', () => {
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
    expect(await s.getUncategorizedStatus()).toEqual({ count: 4, asOf: '2026-08-08' });
    await s.clearAll();
    expect(await s.getUncategorizedStatus()).toBeNull();
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
    expect(await store.getUncategorizedStatus()).toEqual({ count: 3, asOf: '2026-08-08T12:00:00.000Z' });
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
