import { vi } from 'vitest';

/**
 * The default `SyncPage` props every page-level test starts from.
 *
 * Lifted verbatim out of `SyncPage.test.tsx` so `copy-policy.test.tsx` renders
 * the SAME page a behaviour test does: a copy policy proved against a
 * hand-tuned fixture proves nothing about what users see. A factory, not a
 * constant — each test mutates its own copy (`props.store.getUiState = …`), and
 * the `vi.fn()` call counts must not be shared between cases.
 *
 * Note what the defaults deliberately include: `sfin-2` carries a non-null
 * `drift`, so the off-balance banner renders. That is why the copy policy test
 * exercises the banner's wording without doing anything special.
 */
export const makeProps = () => ({
  ctx: {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-a', name: 'Checking' }]) },
      navigation: { navigate: vi.fn(async () => {}) },
    },
  } as any,
  store: {
    getLastSyncAt: vi.fn(async () => new Date('2024-01-01T10:00:00Z')),
    getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' })),
    getMappingRules: vi.fn(async () => []),
    getSyncScheduleHours: vi.fn(async () => 6),
    getAccessUrl: vi.fn(async () => 'https://u:p@bridge.simplefin.org/simplefin'),
    getAccountNames: vi.fn(async () => ({ 'sfin-1': 'Growth', 'sfin-2': 'Spend' })),
    setAccountNames: vi.fn(),
    getAccountBalances: vi.fn(async () => ({
      'sfin-1': { balance: 1234.56, currency: 'USD', date: 1700000000, drift: null },
      'sfin-2': { balance: -420.1, currency: 'USD', date: 1700000000, drift: 15.22 },
    })),
    getAuthB64Key: vi.fn(async () => 'simplefin_auth_b64'),
    setLastSyncAt: vi.fn(),
    setSyncScheduleHours: vi.fn(),
    getAutoHeal: vi.fn(async () => false),
    setAutoHeal: vi.fn(),
    getAutoAdjust: vi.fn(async () => false),
    setAutoAdjust: vi.fn(),
    getTelegramConfig: vi.fn(async () => null),
    setTelegramConfig: vi.fn(),
    getAvailableReportCategories: vi.fn(async () => [] as string[]),
    getReportCategoryCatalog: vi.fn(async () => [] as any[]),
    // Amazon categorization unconfigured, which is every test here except the
    // Amazon card ones.
    getLastSyncImported: vi.fn(async () => null),
    setLastSyncImported: vi.fn(async () => {}),
    getAmazonConfig: vi.fn(async () => null),
    setAmazonConfig: vi.fn(async () => {}),
    getAmazonLabels: vi.fn(async () => ({})),
    getReportGlyphStyle: vi.fn(async () => ({ mode: 'clean' as const, overrides: {} })),
    setReportGlyphStyle: vi.fn(async () => {}),
    getSubcategoryDisplay: vi.fn(async () => 'rollup' as const),
    setSubcategoryDisplay: vi.fn(async () => {}),
    getCompanionVersion: vi.fn(async () => null),
    getOpenCards: vi.fn(async () => ({}) as Record<string, boolean>),
    // async, like the real SecretsStore method — the page fires it and forgets,
    // so it has to be thenable
    setOpenCards: vi.fn(async () => {}),
    // Page-level UI state (active tab, checklist dismissal) and the companion's
    // uncategorized count. Overview reads all three; see OverviewTab.test.tsx.
    getUiState: vi.fn(async () => ({}) as any),
    setUiState: vi.fn(async () => {}),
    getUncategorizedStatus: vi.fn(async () => null as any),
    getDismissals: vi.fn(async () => ({}) as any),
    setDismissals: vi.fn(async () => {}),
  } as any,
  onReset: vi.fn(),
  scheduler: { start: vi.fn(), stop: vi.fn(), isRunning: vi.fn(() => false) } as any,
});
