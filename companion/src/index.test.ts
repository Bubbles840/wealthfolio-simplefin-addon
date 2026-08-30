import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maskUrl, validateStartupEnv, runCompanionSync, resolvePassword, sendDailyTelegramReport, sendWeeklyTelegramReport, sendMonthlyTelegramReport, previousYearMonth, sendImportNotice, readBudgetSnapshot, composeDailyDigestMessage, runCompanionSyncExclusive, buildTelegramCommandHandler, applyTelegramDismissal, undoTelegramDismissal, formatDismissedReply, buildTelegramListenerDeps, buildCategorizeController, buildCategorizeDeps, rememberImportScope, sendUnmappedAccountsNotice } from './index.js';
import { formatHelpReply, parseCommand } from '../../shared/telegram-commands.js';
import { SIMPLEFIN_SYNC_VERSION } from '../../shared/version.js';
import { runSyncCore } from '../../shared/sync-core.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories } from './sqlite-native.js';
import { ingestAmazonMail } from './amazon-mail.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';
import { CATEGORIZE_ENTRY_CALLBACK } from '../../shared/telegram.js';
import { existsSync } from 'fs';
import type { SyncResult } from '../../shared/sync-core.js';

/** A promise plus its resolve/reject, for tests that need to control exactly
 *  when an in-flight async operation settles. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const FAKE_SYNC_RESULT: SyncResult = {
  imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [],
  importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [],
  prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
};

vi.mock('../../shared/sync-core.js', async (importOriginal) => ({
  // The real module's parsers (descriptionFromComment etc.) stay real; only the
  // sync engine itself is faked.
  ...(await importOriginal<object>()),
  runSyncCore: vi.fn(async () => ({ imported: 2, skipped: 1, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [] })),
}));

vi.mock('./wealthfolio.js', () => {
  return {
    WealthfolioClient: vi.fn().mockImplementation(function (this: any) {
      this.login = vi.fn(async () => {});
      this.getAddonSecret = vi.fn(async (_addon: string, key: string) => {
        if (key === 'simplefin_access_url') return 'https://user:pass@bridge.simplefin.org/simplefin';
        return null;
      });
      this.setAddonSecret = vi.fn(async () => {});
    }),
  };
});

vi.mock('./sqlite-native.js', () => ({
  getNativeUncategorizedSpending: vi.fn(() => []),
  // The categorized mirror: read by both menus' Undo before it un-files
  // anything, and by /recategorize's list. Must be listed here for the same
  // reason as the categories reader below — index.ts imports it.
  getNativeCategorizedSpending: vi.fn(() => []),
  // Read by the /categorize menu's category picker and by /newrule's resolver.
  // Present in this factory even though most tests never touch it: vi.mock
  // replaces the WHOLE module, so an export index.ts imports but the factory
  // omits fails at import time and takes every test in this file with it.
  getNativeSpendingCategories: vi.fn(() => []),
  getNativeSubcategorySpending: vi.fn(() => []),
  getNativeCategoryCatalog: vi.fn(() => ([
    { name: 'Transportation', parent: null, icon: 'Car', color: '#24837B', hasBudget: true, hasSpend: false },
    { name: 'Personal Care', parent: null, icon: 'Sparkles', color: '#B0552E', hasBudget: false, hasSpend: false },
  ])),
  getNativeWealthfolioSpending: vi.fn(() => ({ Groceries: 200, Dining: 550 })),
  // Week-scoped spend: a subset of the month totals above.
  getNativeWealthfolioSpendingBetween: vi.fn(() => ({ Groceries: 50, Dining: 100 })),
  getNativeWealthfolioBudgets: vi.fn(() => ({ Groceries: 800, Dining: 500 })),
  // The week's biggest individual spends, display-ready (the reader strips the
  // stored note's tx id, pending marker and in-transit prefix).
  // Default: nothing unfiled, so the many digest tests that predate this
  // reader keep asserting the totals they always did.
  getNativeUncategorizedSpendingTotal: vi.fn(() => ({ count: 0, total: 0 })),
  getNativeWealthfolioTopSpending: vi.fn(() => ([
    { amount: 412.37, description: 'WHOLE FOODS MKT', categoryName: 'Dining' },
    { amount: 95.5, description: 'SQ *BLUE BOTTLE', categoryName: 'Dining' },
    { amount: 63, description: 'COSTCO GAS · PUMP 4', categoryName: 'Groceries' },
  ])),
}));

vi.mock('./amazon-mail.js', async (importOriginal) => ({
  // Real `amazonMailConfigured`, `htmlToText`, etc. stay real; only the two
  // functions that would otherwise try a real IMAP connection are faked.
  ...(await importOriginal<object>()),
  createImapSource: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
  ingestAmazonMail: vi.fn(async () => ({
    scanned: 0, added: 0, unparsed: 0, ignored: 0, pruned: 0, newLabels: [], unparsedSenders: {},
  })),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

describe('maskUrl', () => {
  it('replaces user:pass segment with ***', () => {
    expect(maskUrl('https://user:pass@bridge.simplefin.org/path')).toBe(
      'https://***@bridge.simplefin.org/path',
    );
  });

  it('is a no-op when there are no credentials in the URL', () => {
    const plain = 'https://bridge.simplefin.org/path';
    expect(maskUrl(plain)).toBe(plain);
  });
});

describe('validateStartupEnv', () => {
  beforeEach(() => {
    delete process.env.WEALTHFOLIO_API_URL;
    delete process.env.WEALTHFOLIO_PASSWORD;
    delete process.env.WEALTHFOLIO_PASSWORD_FILE;
    delete process.env.WEALTHFOLIO_API_KEY;
  });

  it('throws when WEALTHFOLIO_API_URL is missing', () => {
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    expect(() => validateStartupEnv()).toThrow('WEALTHFOLIO_API_URL');
  });

  it('throws when no password or API key is set', () => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    expect(() => validateStartupEnv()).toThrow('WEALTHFOLIO_PASSWORD');
  });

  it('requires only the Wealthfolio URL and password', () => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    expect(() => validateStartupEnv()).not.toThrow();
  });

  it('passes when WEALTHFOLIO_API_KEY is provided', () => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_API_KEY = 'key';
    expect(() => validateStartupEnv()).not.toThrow();
  });
});

describe('runCompanionSync', () => {
  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    vi.mocked(runSyncCore).mockClear();
  });

  it('calls runSyncCore using REST host and store adapters', async () => {
    await runCompanionSync();
    expect(runSyncCore).toHaveBeenCalledTimes(1);
  });

  it('derives force from MIN_SYNC_INTERVAL_HOURS when called with no options, so the cron tick is unchanged', async () => {
    delete process.env.MIN_SYNC_INTERVAL_HOURS;
    await runCompanionSync();
    expect(vi.mocked(runSyncCore).mock.calls[0][2]).toMatchObject({ force: false });

    vi.mocked(runSyncCore).mockClear();
    process.env.MIN_SYNC_INTERVAL_HOURS = '0';
    try {
      await runCompanionSync();
      expect(vi.mocked(runSyncCore).mock.calls[0][2]).toMatchObject({ force: true });
    } finally {
      delete process.env.MIN_SYNC_INTERVAL_HOURS;
    }
  });

  it('forces the run when asked, whatever the interval says — an explicitly requested sync is never refused', async () => {
    process.env.MIN_SYNC_INTERVAL_HOURS = '1';
    try {
      await runCompanionSync({ force: true });
      expect(vi.mocked(runSyncCore).mock.calls[0][2]).toMatchObject({ force: true });
    } finally {
      delete process.env.MIN_SYNC_INTERVAL_HOURS;
    }
  });
});

describe('runCompanionSync sync health', () => {
  let secrets: Map<string, string>;

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    secrets = new Map();
    secrets.set('simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin');
    vi.mocked(runSyncCore).mockClear();
  });

  it('records lastSuccessAt and clears any failure streak on success', async () => {
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — runCompanionSync calls
    // `new WealthfolioClient(apiUrl)`, and mockImplementation with an arrow
    // fn throws "is not a constructor" when invoked via `new`.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    await runCompanionSync();

    const health = JSON.parse(secrets.get('sync_health')!);
    expect(health.lastSuccessAt).toBeTruthy();
    expect(health.firstFailedAt).toBeUndefined();
  });

  it('sends one Telegram alert per stuck-transfer entry in the result', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 130000, currency: 'USD' }],
    });
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — runCompanionSync calls
    // `new WealthfolioClient(apiUrl)`, and mockImplementation with an arrow
    // fn throws "is not a constructor" when invoked via `new`.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).toHaveBeenCalled();
    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('$1300.00');
  });

  it('escapes Markdown specials in a stuck-transfer description before sending', async () => {
    // Bank/card descriptors routinely contain `*` and `_` (e.g. card-network
    // descriptors like "AMAZON *MKTPLACE"), so this is realistically likelier
    // to break a send than a hand-written error message.
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'AMAZON *MKTPLACE ↔ Payment_Refund', amountCents: 500, currency: 'USD' }],
    });
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('AMAZON \\*MKTPLACE ↔ Payment\\_Refund');
  });

  it('records a failure streak with firstFailedAt set only on the first failure', async () => {
    const err1 = new Error('SimpleFin: connection refused');
    vi.mocked(runSyncCore).mockRejectedValueOnce(err1);

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — runCompanionSync calls
    // `new WealthfolioClient(apiUrl)`, and mockImplementation with an arrow
    // fn throws "is not a constructor" when invoked via `new`.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    await expect(runCompanionSync()).rejects.toThrow('SimpleFin: connection refused');
    const firstHealth = JSON.parse(secrets.get('sync_health')!);
    expect(firstHealth.firstFailedAt).toBeTruthy();
    expect(firstHealth.lastError).toBe('SimpleFin: connection refused');
    expect(firstHealth.alerted).toBe(false);

    // A second consecutive failure must not push firstFailedAt forward —
    // otherwise the 24h alert clock would reset on every run and never fire.
    const firstFailedAt = firstHealth.firstFailedAt;
    const err2 = new Error('SimpleFin: still down');
    vi.mocked(runSyncCore).mockRejectedValueOnce(err2);
    await expect(runCompanionSync()).rejects.toThrow('SimpleFin: still down');
    const secondHealth = JSON.parse(secrets.get('sync_health')!);
    expect(secondHealth.firstFailedAt).toBe(firstFailedAt);
    expect(secondHealth.lastError).toBe('SimpleFin: still down');
  });

  it('sends exactly one 24h-failure Telegram alert and marks the streak alerted', async () => {
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    secrets.set('sync_health', JSON.stringify({
      lastSuccessAt: null,
      firstFailedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      lastError: 'old error',
      alerted: false,
    }));
    const err = new Error('SimpleFin: still failing');
    vi.mocked(runSyncCore).mockRejectedValueOnce(err);

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — runCompanionSync calls
    // `new WealthfolioClient(apiUrl)`, and mockImplementation with an arrow
    // fn throws "is not a constructor" when invoked via `new`.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runCompanionSync()).rejects.toThrow('SimpleFin: still failing');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('failing since');
    const health = JSON.parse(secrets.get('sync_health')!);
    expect(health.alerted).toBe(true);

    // A further failing run must not alert again — the streak is already marked.
    fetchMock.mockClear();
    vi.mocked(runSyncCore).mockRejectedValueOnce(new Error('SimpleFin: still failing'));
    await expect(runCompanionSync()).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not mark the streak alerted when the Telegram send itself fails, and retries next run', async () => {
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    secrets.set('sync_health', JSON.stringify({
      lastSuccessAt: null,
      firstFailedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      lastError: 'old error',
      alerted: false,
    }));
    vi.mocked(runSyncCore).mockRejectedValueOnce(new Error('invalid_grant: *access denied*'));

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    // Telegram itself rejects the send (rate limit, bad token, etc.) —
    // sendTelegramMessage resolves { ok: false }, it does not throw.
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false, description: 'Too Many Requests' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runCompanionSync()).rejects.toThrow('invalid_grant');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    let health = JSON.parse(secrets.get('sync_health')!);
    expect(health.alerted).toBe(false); // must not be marked delivered — it wasn't

    // A second failing run must retry the alert (not skip it) and, once
    // Telegram accepts it, escape the Markdown specials in lastError so the
    // send itself can't fail on them.
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({ json: async () => ({ ok: true }) }));
    vi.mocked(runSyncCore).mockRejectedValueOnce(new Error('invalid_grant: *access denied*'));

    await expect(runCompanionSync()).rejects.toThrow('invalid_grant');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('invalid\\_grant: \\*access denied\\*');
    health = JSON.parse(secrets.get('sync_health')!);
    expect(health.alerted).toBe(true); // now actually delivered
  });

  it('does not fire the 24h alert on a run that just succeeded', async () => {
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    secrets.set('sync_health', JSON.stringify({
      lastSuccessAt: null,
      firstFailedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      lastError: 'old error',
      alerted: false,
    }));
    // imported: 0 so the unrelated "new transactions imported" notification
    // doesn't also fire and confuse the "no alert was sent" assertion below.
    vi.mocked(runSyncCore).mockResolvedValueOnce({ imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [] });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — runCompanionSync calls
    // `new WealthfolioClient(apiUrl)`, and mockImplementation with an arrow
    // fn throws "is not a constructor" when invoked via `new`.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    // Success clears the streak (updateSyncHealth writes a fresh { lastSuccessAt }
    // record with no firstFailedAt) before checkSyncHealthAlert runs in `finally`.
    await runCompanionSync();

    expect(fetchMock).not.toHaveBeenCalled();
    const health = JSON.parse(secrets.get('sync_health')!);
    expect(health.firstFailedAt).toBeUndefined();
  });

  it('does not let a failure inside health persistence mask the original sync error', async () => {
    const originalError = new Error('SimpleFin: token revoked');
    vi.mocked(runSyncCore).mockRejectedValueOnce(originalError);
    secrets.set('simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin');

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => {
      if (key === 'sync_health') return 'not valid json{{{';
      return secrets.get(key) ?? null;
    });
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — runCompanionSync calls
    // `new WealthfolioClient(apiUrl)`, and mockImplementation with an arrow
    // fn throws "is not a constructor" when invoked via `new`.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    await expect(runCompanionSync()).rejects.toThrow('SimpleFin: token revoked');
  });
});

describe('runCompanionSync import-notice visibility', () => {
  // Covers the "I got two new transactions but never got a Telegram message"
  // report: rows can land in Wealthfolio while the notice about them goes
  // silent for three different reasons, and each one must leave a `log`-level
  // line naming how many transactions went unannounced.
  let secrets: Map<string, string>;
  const importedTx = {
    txId: 'tx-a', sfAccountId: 'sfin-1', description: 'TRADER JOE S #628',
    amountCents: 6774, currency: 'USD', accountName: 'Spend (4937)',
    activityType: 'WITHDRAWAL', pending: false, inTransit: false,
  };

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    secrets = new Map();
    secrets.set('simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin');
    vi.mocked(runSyncCore).mockClear();
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([]);
  });

  async function client() {
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const c: any = new (WealthfolioClient as any)();
    c.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    c.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    return c;
  }

  it('logs the count and does not fail the sync when the notice itself throws', async () => {
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 2, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      importedTransactions: [importedTx], largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [],
    });
    // The example from the report that prompted this: a locked database on
    // the uncategorized sweep inside sendImportNotice. The status-tile publish
    // earlier in the sync reads the same function but swallows its own
    // errors, so this must stay thrown on every call, not just the first, to
    // reach sendImportNotice's unguarded read.
    vi.mocked(getNativeUncategorizedSpending).mockImplementation(() => {
      throw new Error('database is locked');
    });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const c = await client();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return c; } as any);

    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runCompanionSync();
      expect(result.imported).toBe(2);
      const allLogs = logs.mock.calls.flat().join('\n');
      expect(allLogs).toMatch(/2.*not announced/i);
      expect(allLogs).toContain('database is locked');
    } finally {
      logs.mockRestore();
    }
  });

  it('logs an explanatory line and sends no notice when notifyOnImport is off', async () => {
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true, notifyOnImport: false }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 3, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      importedTransactions: [importedTx], largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [],
    });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const c = await client();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return c; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCompanionSync();
      // No message was sent for the import — notifyOnImport is off.
      const sendCall = fetchMock.mock.calls.find((call: any[]) => String(call[0]).includes('sendMessage'));
      expect(sendCall).toBeUndefined();
      const allLogs = logs.mock.calls.flat().join('\n');
      expect(allLogs).toMatch(/3.*not announced/i);
    } finally {
      logs.mockRestore();
    }
  });

  it('logs an explanatory line and sends no notice when Telegram is not configured at all', async () => {
    // No telegram_config secret set at all.
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 5, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      importedTransactions: [importedTx], largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [],
    });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const c = await client();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return c; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCompanionSync();
      // No message was sent for the import — there is no config to send with.
      const sendCall = fetchMock.mock.calls.find((call: any[]) => String(call[0]).includes('sendMessage'));
      expect(sendCall).toBeUndefined();
      const allLogs = logs.mock.calls.flat().join('\n');
      expect(allLogs).toMatch(/5.*not announced/i);
      expect(allLogs).toContain('Telegram not configured');
    } finally {
      logs.mockRestore();
    }
  });

  it('says "disabled", not "not configured", when the user deliberately turned Telegram off', async () => {
    // A config that fully exists but is switched off — genuinely different
    // from no config at all, and an operator reading the log must be able to
    // tell the two apart rather than go hunting for a missing secret they
    // never set because they didn't need to.
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: false }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 4, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      importedTransactions: [importedTx], largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [],
    });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const c = await client();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return c; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCompanionSync();
      const sendCall = fetchMock.mock.calls.find((call: any[]) => String(call[0]).includes('sendMessage'));
      expect(sendCall).toBeUndefined();
      const allLogs = logs.mock.calls.flat().join('\n');
      expect(allLogs).toMatch(/4.*not announced/i);
      expect(allLogs).toContain('Telegram disabled');
      expect(allLogs).not.toContain('Telegram not configured');
    } finally {
      logs.mockRestore();
    }
  });

  it('logs nothing new when nothing was imported', async () => {
    // No telegram_config either, so both the "skipped" and "not configured"
    // paths are live candidates for firing — neither may, since imported is 0.
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [],
    });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const c = await client();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return c; } as any);

    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCompanionSync();
      const allLogs = logs.mock.calls.flat().join('\n');
      expect(allLogs).not.toMatch(/not announced/i);
    } finally {
      logs.mockRestore();
    }
  });
});

describe('stuck-transfer alert delivery confirmation', () => {
  let secrets: Map<string, string>;

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    secrets = new Map();
    secrets.set('simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin');
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    vi.mocked(runSyncCore).mockClear();
  });

  it('rolls the ledger entry back to un-alerted when the Telegram send fails', async () => {
    // runSyncCore has already persisted alerted:true for this pair when it
    // queued the alert. A failed delivery must undo that so the next sync
    // re-alerts.
    secrets.set('transfer_link_failures', JSON.stringify({
      'tx-out': { count: 3, firstFailedAt: '2026-07-01T00:00:00Z', alerted: true },
    }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 50000, currency: 'USD' }],
    });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — runCompanionSync calls
    // `new WealthfolioClient(apiUrl)`, and mockImplementation with an arrow
    // fn throws "is not a constructor" when invoked via `new`.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false, description: 'Bad Request' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    const failures = JSON.parse(secrets.get('transfer_link_failures')!);
    expect(failures['tx-out'].alerted).toBe(false);
    expect(failures['tx-out'].count).toBe(3);
    expect(failures['tx-out'].firstFailedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('leaves the ledger entry alerted when the send succeeds', async () => {
    secrets.set('transfer_link_failures', JSON.stringify({
      'tx-out': { count: 3, firstFailedAt: '2026-07-01T00:00:00Z', alerted: true },
    }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 50000, currency: 'USD' }],
    });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    const failures = JSON.parse(secrets.get('transfer_link_failures')!);
    expect(failures['tx-out'].alerted).toBe(true);
    expect(failures['tx-out'].count).toBe(3);
    expect(failures['tx-out'].firstFailedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('rolls back only the entry whose send failed', async () => {
    secrets.set('transfer_link_failures', JSON.stringify({
      'tx-out': { count: 3, firstFailedAt: '2026-07-01T00:00:00Z', alerted: true },
      'tx-out-2': { count: 3, firstFailedAt: '2026-07-02T00:00:00Z', alerted: true },
    }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [
        { outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 50000, currency: 'USD' },
        { outTxId: 'tx-out-2', description: 'Other ↔ Other', amountCents: 20000, currency: 'USD' },
      ],
    });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => ({ json: async () => ({ ok: false, description: 'Bad Request' }) }))
      .mockImplementationOnce(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    const failures = JSON.parse(secrets.get('transfer_link_failures')!);
    expect(failures['tx-out'].alerted).toBe(false);
    expect(failures['tx-out-2'].alerted).toBe(true);
  });

  it('does not fail a successful sync when telegram_config is corrupt', async () => {
    // The unguarded JSON.parse in sendStuckTransferAlert threw straight out of
    // the alert loop in runCompanionSync: remaining alerts went undelivered,
    // the rollback sweep was skipped entirely, and updateSyncHealth then
    // recorded a FAILURE for a sync that had actually succeeded.
    secrets.set('telegram_config', '{"botToken":"tok","chatId"'); // truncated
    secrets.set('transfer_link_failures', JSON.stringify({
      'tx-out': { count: 3, firstFailedAt: '2026-07-01T00:00:00Z', alerted: true },
    }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
      largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [
        { outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 50000, currency: 'USD' },
        { outTxId: 'tx-out-2', description: 'Other ↔ Other', amountCents: 20000, currency: 'USD' },
      ],
    });

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    // The sync itself must still resolve, not reject.
    await expect(runCompanionSync()).resolves.toMatchObject({ imported: 0, skipped: 0 });

    // ...and health must record the success, not a phantom failure streak.
    const health = JSON.parse(secrets.get('sync_health')!);
    expect(health.lastSuccessAt).toBeTruthy();
    expect(health.firstFailedAt).toBeUndefined();

    // No token to send with, so nothing was sent and the ledger is untouched —
    // a non-attempt, not a delivery failure to roll back.
    expect(fetchMock).not.toHaveBeenCalled();
    const failures = JSON.parse(secrets.get('transfer_link_failures')!);
    expect(failures['tx-out'].alerted).toBe(true);
  });
});

describe('large-transaction alert delivery', () => {
  let secrets: Map<string, string>;

  /** Wires the mocked WealthfolioClient to a plain secrets map, the way every
   *  other delivery test in this file does. */
  async function client() {
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const c = new (WealthfolioClient as any)();
    c.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    c.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — runCompanionSync calls
    // `new WealthfolioClient(apiUrl)`, and mockImplementation with an arrow
    // fn throws "is not a constructor" when invoked via `new`.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return c; } as any);
    return c;
  }

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    secrets = new Map();
    secrets.set('simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin');
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    vi.mocked(runSyncCore).mockClear();
  });

  it('sends the rendered alert, with a `*`-laden bank descriptor escaped, on the real request body', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
      largeTransactionAlerts: [{
        txId: 'tx-1', description: 'SQ *BLUE BOTTLE_COFFEE', amountCents: 124000,
        currency: 'USD', accountName: 'Spend',
      }],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, sentBody] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottok/sendMessage');
    const payload = JSON.parse((sentBody as any).body);
    expect(payload.chat_id).toBe('1');
    expect(payload.parse_mode).toBe('Markdown');
    expect(payload.text).toBe('💸 *$1,240.00* USD — SQ \\*BLUE BOTTLE\\_COFFEE · Spend');
  });

  it('keeps an undelivered alert queued and re-sends it on the next sync', async () => {
    // A large transaction is announced because its row was CREATED this run, and
    // a create happens once per SimpleFin tx id — so a dropped send could never
    // be re-derived. The outbox is the only thing standing between a Telegram
    // 429 and a permanently lost notification.
    const alert = {
      txId: 'tx-1', description: 'DELTA AIR LINES', amountCents: 124000,
      currency: 'USD', accountName: 'Spend',
    };
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
      largeTransactionAlerts: [alert],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false, description: 'Too Many Requests' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(JSON.parse(secrets.get('pending_large_tx_alerts')!)).toEqual([alert]);

    // Next sync reports nothing new, but the queued alert must still go out.
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], largeTransactionAlerts: [], balanceDriftAlerts: [],
    });
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({ json: async () => ({ ok: true }) }));

    await runCompanionSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
    expect(text).toBe('💸 *$1,240.00* USD — DELTA AIR LINES · Spend');
    expect(JSON.parse(secrets.get('pending_large_tx_alerts')!)).toEqual([]);
  });

  it('does not queue a delivered alert', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
      largeTransactionAlerts: [{
        txId: 'tx-1', description: 'DELTA AIR LINES', amountCents: 124000,
        currency: 'USD', accountName: 'Spend',
      }],
    });
    await client();
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true }) })));

    await runCompanionSync();

    expect(secrets.get('pending_large_tx_alerts')).toBeUndefined();
  });

  it('queues nothing when Telegram is disabled — an opted-out user must not accumulate a backlog', async () => {
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: false }));
    secrets.set('pending_large_tx_alerts', JSON.stringify([{
      txId: 'old', description: 'Older alert', amountCents: 500000, currency: 'USD', accountName: 'Spend',
    }]));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
      largeTransactionAlerts: [{
        txId: 'tx-1', description: 'DELTA AIR LINES', amountCents: 124000,
        currency: 'USD', accountName: 'Spend',
      }],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(secrets.get('pending_large_tx_alerts')!)).toEqual([]);
  });

  it('does not send the same transaction twice when it is both queued and re-reported', async () => {
    const alert = {
      txId: 'tx-1', description: 'DELTA AIR LINES', amountCents: 124000,
      currency: 'USD', accountName: 'Spend',
    };
    secrets.set('pending_large_tx_alerts', JSON.stringify([alert]));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
      largeTransactionAlerts: [alert],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('balance-drift alert delivery', () => {
  let secrets: Map<string, string>;

  async function client() {
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const c = new (WealthfolioClient as any)();
    c.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    c.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — see the note in the
    // sync-health tests above.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return c; } as any);
    return c;
  }

  // AGED, so these tests keep exercising the alarm formatter and the
  // `alerted` rollback; the young/soft path is pinned separately below.
  const driftAlert = {
    sfinAccountId: 'sfin-1', accountName: 'Spend', driftAmount: 1300,
    currency: 'USD', bankBalance: 3475.23, phase: 'aged' as const,
  };

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    secrets = new Map();
    secrets.set('simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin');
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    // runSyncCore has already persisted alerted:true for this episode when it
    // queued the alert; the companion's job is to undo that if delivery fails.
    secrets.set('drift_alerts', JSON.stringify({
      'sfin-1': { driftAmount: 1300, firstDetectedAt: '2026-07-01T00:00:00Z', alerted: true, alertedAged: true },
    }));
    vi.mocked(runSyncCore).mockClear();
  });

  it('sends the rendered drift alert on the real request body', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
      balanceDriftAlerts: [driftAlert],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(payload.parse_mode).toBe('Markdown');
    expect(payload.text).toBe(
      '⚠️ *Balance drift* — Spend\n'
      + "Wealthfolio is *$1,300.00* below the bank's *$3,475.23* USD\n"
      + 'Run "Reconcile balances" in the addon to line them up.',
    );
    // Delivered, so the episode stays marked and no second ping goes out.
    expect(JSON.parse(secrets.get('drift_alerts')!)['sfin-1'].alerted).toBe(true);
  });

  it('sends a YOUNG drift as the soft feed-lag notice, not the alarm', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], importedTransactions: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
      balanceDriftAlerts: [{ ...driftAlert, phase: 'young' as const }],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
    expect(text).toContain('⏳ *Waiting on the bank feed* — Spend');
    expect(text).not.toContain('Balance drift');
  });

  it('escapes a `_`-bearing account name so the send cannot 400', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
      balanceDriftAlerts: [{ ...driftAlert, accountName: 'Joint_Spend *Main*' }],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
    expect(text).toContain('⚠️ *Balance drift* — Joint\\_Spend \\*Main\\*');
  });

  it('rolls the episode back to un-alerted when the send fails, so the next sync retries', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
      balanceDriftAlerts: [driftAlert],
    });
    await client();
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: false, description: 'Bad Request' }) })));

    await runCompanionSync();

    const stored = JSON.parse(secrets.get('drift_alerts')!)['sfin-1'];
    // An aged escalation rolls back ONLY its own flag: the young notice was
    // already delivered, and re-arming it too would re-send the soft message
    // alongside the retried alarm.
    expect(stored.alertedAged).toBe(false);
    expect(stored.alerted).toBe(true);
    // The episode itself must survive intact — rolling back the delivery flag
    // is not the same as declaring the account healthy again.
    expect(stored.driftAmount).toBe(1300);
    expect(stored.firstDetectedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('rolls back only the account whose send failed', async () => {
    secrets.set('drift_alerts', JSON.stringify({
      'sfin-1': { driftAmount: 1300, firstDetectedAt: '2026-07-01T00:00:00Z', alerted: true, alertedAged: true },
      'sfin-2': { driftAmount: 500, firstDetectedAt: '2026-07-02T00:00:00Z', alerted: true },
    }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
      balanceDriftAlerts: [
        driftAlert,
        { sfinAccountId: 'sfin-2', accountName: 'Savings', driftAmount: 500, currency: 'USD', bankBalance: 610.65, phase: 'young' as const },
      ],
    });
    await client();
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => ({ json: async () => ({ ok: false, description: 'Bad Request' }) }))
      .mockImplementationOnce(async () => ({ json: async () => ({ ok: true }) })));

    await runCompanionSync();

    const stored = JSON.parse(secrets.get('drift_alerts')!);
    expect(stored['sfin-1'].alertedAged).toBe(false);
    expect(stored['sfin-2'].alerted).toBe(true);
  });

  it('leaves the ledger alone when Telegram is not configured — a non-attempt, not a failure', async () => {
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: false }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
      balanceDriftAlerts: [driftAlert],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(secrets.get('drift_alerts')!)['sfin-1'].alerted).toBe(true);
  });
});

describe('duplicate-prune notice delivery', () => {
  let secrets: Map<string, string>;

  async function client() {
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const c = new (WealthfolioClient as any)();
    c.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    c.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    // NOTE: must be a `function` (not an arrow fn) — see the note in the
    // sync-health tests above.
    vi.mocked(WealthfolioClient).mockImplementation(function () { return c; } as any);
    return c;
  }

  /** The two rows the sweep removed from the user's live savings account. */
  const pruned = [
    { sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-3917f117',
      description: 'PNC BANK 1234 Transfer', date: '2026-07-27', amountCents: 130000,
      currency: 'USD', wfId: 'act-2' },
    { sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-ce426394',
      description: 'Monthly Interest Paid', date: '2026-06-30', amountCents: 250,
      currency: 'USD', wfId: 'act-4' },
  ];

  const emptyResult = () => ({
    imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [],
    largeTransactionAlerts: [], balanceDriftAlerts: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [],
  });

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    secrets = new Map();
    secrets.set('simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin');
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    vi.mocked(runSyncCore).mockClear();
  });

  it('sends ONE message itemising every row the sweep deleted', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({ ...emptyResult(), prunedDuplicates: pruned });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(payload.parse_mode).toBe('Markdown');
    expect(payload.text).toBe(
      '🧹 *Duplicate activities removed* — 2 rows\n'
      + 'Each of these was stored twice, so the extra copy was deleted during reconcile:\n'
      + '• *$1,300.00* USD · 2026-07-27 · PNC BANK 1234 Transfer · Savings\n'
      + '• *$2.50* USD · 2026-06-30 · Monthly Interest Paid · Savings\n'
      + 'Nothing to do — your balances should line up again.',
    );
  });

  it('escapes a `*`-bearing bank description so the send cannot 400', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      ...emptyResult(),
      prunedDuplicates: [{ ...pruned[0], description: 'AMAZON *MKTPLACE_US' }],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
    expect(text).toContain('AMAZON \\*MKTPLACE\\_US');
  });

  it('sends nothing when nothing was pruned', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce(emptyResult());
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing when Telegram is disabled', async () => {
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: false }));
    vi.mocked(runSyncCore).mockResolvedValueOnce({ ...emptyResult(), prunedDuplicates: pruned });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendDailyTelegramReport', () => {
  it('publishes the available category list and filters the digest to the configured selection', async () => {
    const secrets = new Map<string, string>();
    secrets.set('telegram_config', JSON.stringify({
      botToken: 'tok', chatId: '1', enabled: true, dailyReportCategories: ['Groceries'],
    }));
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDailyTelegramReport(client);

    expect(client.setAddonSecret).toHaveBeenCalledWith(
      'simplefin-sync', 'available_report_categories', JSON.stringify(['Dining', 'Groceries']),
    );
    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('Groceries');
    expect(text).not.toContain('Dining');
  });

  it('does nothing when dailyReportEnabled is false', async () => {
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true, dailyReportEnabled: false })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    await sendDailyTelegramReport(client);
    expect(client.setAddonSecret).not.toHaveBeenCalled();
  });

  it('appends a sync-health success footer when a sync_health record exists', async () => {
    const secrets = new Map<string, string>();
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    secrets.set('sync_health', JSON.stringify({ lastSuccessAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }));
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDailyTelegramReport(client);

    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('✅ synced 2h ago');
  });

  it('appends a failing-since footer during an active sync failure streak', async () => {
    const secrets = new Map<string, string>();
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    secrets.set('sync_health', JSON.stringify({
      lastSuccessAt: null,
      firstFailedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
      lastError: 'SimpleFin: token revoked',
      alerted: true,
    }));
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDailyTelegramReport(client);

    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('⚠️ failing since');
    expect(text).toContain('SimpleFin: token revoked');
  });

  it('omits the footer entirely when there is no sync_health record yet', async () => {
    const secrets = new Map<string, string>();
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDailyTelegramReport(client);

    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).not.toContain('synced');
    expect(text).not.toContain('failing since');
  });

  it('still sends the digest, minus the footer, when sync_health is corrupt', async () => {
    // `sync_health` supplies a decorative one-line footer. An unguarded
    // JSON.parse there threw synchronously and destroyed the ENTIRE daily
    // digest over a value the digest does not depend on.
    const secrets = new Map<string, string>();
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    secrets.set('sync_health', '{"lastSuccessAt":"2026-07-2'); // truncated
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendDailyTelegramReport(client)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('Daily Spending Check');
    expect(text).toContain('Groceries');
    expect(text).not.toContain('synced');
    expect(text).not.toContain('failing since');
  });

  it('sends nothing and does not throw when telegram_config itself is corrupt', async () => {
    const secrets = new Map<string, string>([['telegram_config', 'not json at all']]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendDailyTelegramReport(client)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.setAddonSecret).not.toHaveBeenCalled();
  });

  it('turns glyphs back on when the style secret asks for them', async () => {
    // The default is clean, but the toggle has to actually reach the builders —
    // and it is read per report rather than cached, so editing it in the addon
    // takes effect without restarting the container.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14, 9, 0, 0));
    try {
      const secrets = new Map<string, string>();
      secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
      secrets.set('report_glyph_style', JSON.stringify({ mode: 'glyphs', overrides: { Groceries: '🥕' } }));
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async () => {}),
      } as any;
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendDailyTelegramReport(client);
      const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
      expect(text).toContain('☀️ *Daily Spending Check*');
      // The override wins over the keyword default for that one category.
      expect(text).toContain('🥕 Groceries');
      expect(text).toContain('🍽️ Dining');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces an unmapped account in the daily report', async () => {
    // The failure that started all of this: an account mapped to nothing syncs
    // nothing and says nothing. It was already detected and already stored —
    // but only `/status` ever looked, and nobody runs `/status` unless they
    // already suspect something.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14, 9, 0, 0));
    try {
      const secrets = new Map<string, string>();
      secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
      secrets.set('unmapped_accounts', JSON.stringify([
        { sfinAccountId: 'sf-9', accountName: 'Robinhood Gold' },
      ]));
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async () => {}),
      } as any;
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendDailyTelegramReport(client);
      const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
      expect(text).toContain('Needs attention');
      expect(text).toContain('Robinhood Gold');
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds no self-check block to a healthy daily report', () => new Promise<void>((done) => {
    // Silence on success is the contract. A reassurance printed every single
    // day stops being read long before the day it is wrong.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14, 9, 0, 0));
    const secrets = new Map<string, string>();
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    secrets.set('sync_health', JSON.stringify({
      lastSuccessAt: new Date(2026, 6, 14, 8, 0, 0).toISOString(),
    }));
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    sendDailyTelegramReport(client).then(() => {
      const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
      expect(text).not.toContain('Needs attention');
      expect(text).toContain('✅ synced');
      vi.useRealTimers();
      done();
    });
  }));

  it('carries the over-budget spent setting from the addon into the digest', async () => {
    // Mocked Dining is 550 of 500, so the month is over and the setting has
    // something to act on.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14, 9, 0, 0));
    try {
      const secrets = new Map<string, string>();
      secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
      secrets.set('over_budget_spent', 'all');
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async () => {}),
      } as any;
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendDailyTelegramReport(client);
      const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
      expect(text).toContain('over* · $550 spent');
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the weekly-capping opt-out from the addon into the digest', async () => {
    // The setting lives in the addon's UI but is applied by the companion, so
    // the only thing that proves it works is the key crossing that boundary.
    // Read per report, like the glyph style, so a change takes effect without
    // restarting the container.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14, 9, 0, 0));
    try {
      const secrets = new Map<string, string>();
      secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
      secrets.set('cap_weekly_to_pool', 'off');
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async () => {}),
      } as any;
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendDailyTelegramReport(client);
      const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
      // Dining is 550/500, so the pool is short of the envelopes and the
      // uncapped figures need their caveat.
      // Named exactly: 'left overall' alone also appears in the CAPPED
      // subtitle, so a loose match here would pass either way.
      expect(text).toContain('only $550 left overall');
      expect(text).not.toContain('reduced to fit what is left overall');
    } finally {
      vi.useRealTimers();
    }
  });

  it('titles the digest as daily and headlines what is left this week', async () => {
    // Mocked month spend/budgets: Groceries 200/800, Dining 550/500; mocked
    // week spend: Groceries 50, Dining 100. Tuesday 2026-07-14, so the week
    // began Monday the 13th and July has 31 days:
    //   daysFromWeekStartToMonthEnd = 31 - 13 + 1 = 19
    //   Groceries: spentBeforeWeek 150 -> budgetAtWeekStart 650
    //              envelope = 650 * 7 / 19 = 239.47, left = 189.47
    //   Dining:    over budget for the month by 50
    //
    // That $189.47 is then CAPPED by the month's pool: Dining being $50 over
    // means the two envelopes together promise more than the month can afford,
    // so Groceries' weekly figure is scaled down and the subtitle says so.
    // Pool = (800-200) + (500-550) = 550 against 600 of envelope, so ~92%.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14, 9, 0, 0));
    try {
      const secrets = new Map<string, string>();
      secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
      } as any;
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendDailyTelegramReport(client);

      const [, sentBody] = fetchMock.mock.calls[0];
      const text = JSON.parse((sentBody as any).body).text;
      expect(text).toContain('*Daily Spending Check*');
      expect(text).toContain('left to spend this week');
      expect(text).not.toContain('Weekly Spending Update');
      // Reduced from 189.47 by the pool cap, not equal to it.
      const shown = /Groceries  \*\$([\d,.]+)\*/.exec(text);
      expect(shown).not.toBeNull();
      const left = parseFloat(shown![1].replace(/,/g, ''));
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThan(189.47);
      expect(text).toContain('reduced to fit what is left overall');
      expect(text).toContain('Dining  🚨 *$50 over* for the month');
      // One month-context line at the end, 18 days left counting today.
      expect(text).toContain('$550 left this month · 18 days to go');
      expect(text).not.toContain('/wk pace');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the week window from the week start, clamped to the 1st of the month', async () => {
    // Wednesday 2026-07-01: the most recent Monday is 2026-06-29, in the
    // previous month. A monthly budget cannot be spent before the month began,
    // so the window must start on the 1st.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 1, 9, 0, 0));
    try {
      const secrets = new Map<string, string>();
      secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async () => {}),
      } as any;
      vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true }) })));

      await sendDailyTelegramReport(client);

      expect(vi.mocked(getNativeWealthfolioSpendingBetween)).toHaveBeenCalledWith(
        expect.any(String), '2026-07-01', '2026-08-01',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for the week-scoped spend from the week start through the end of the month', async () => {
    // The upper bound matches the month reader's rather than stopping at today,
    // so `monthSpent - weekSpent` is exactly "spent earlier this month" even if
    // an activity is dated later in the month.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14, 9, 0, 0));
    try {
      const secrets = new Map<string, string>();
      secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async () => {}),
      } as any;
      vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true }) })));

      await sendDailyTelegramReport(client);

      expect(vi.mocked(getNativeWealthfolioSpendingBetween)).toHaveBeenCalledWith(
        expect.any(String), '2026-07-13', '2026-08-01',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes the category checklist from the MONTH maps, not the week-scoped ones', async () => {
    // A week-scoped list would make categories vanish from the addon's Report
    // Categories checklist mid-month simply because nothing was spent on them
    // this week.
    vi.mocked(getNativeWealthfolioSpendingBetween).mockReturnValueOnce({ Groceries: 50 });
    const secrets = new Map<string, string>();
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true }) })));

    await sendDailyTelegramReport(client);

    expect(client.setAddonSecret).toHaveBeenCalledWith(
      'simplefin-sync', 'available_report_categories', JSON.stringify(['Dining', 'Groceries']),
    );
  });

  it('keeps the sync-health footer as its own block, separated from the summary line', async () => {
    const secrets = new Map<string, string>();
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
    secrets.set('sync_health', JSON.stringify({ lastSuccessAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() }));
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDailyTelegramReport(client);

    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    // Blank line between the digest's last line and the health footer, and the
    // footer is the final line — never run on to the money summary.
    expect(text).toMatch(/ to go\n\n✅ synced 2h ago$/);
  });

  it('retries a transient send failure and reports success once it lands', async () => {
    // Reproduces 2026-08-13: a bare `fetch failed` (a network-level exception,
    // not a Telegram API rejection) lost the entire day's report with no
    // retry. An instant `sleep` stand-in skips the real backoff delay.
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue({ json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(sendDailyTelegramReport(client, async () => {})).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('Daily Telegram spending check sent successfully.');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('gives up after exhausting retries and logs the final failure', async () => {
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sleepCalls: number[] = [];

    try {
      await expect(
        sendDailyTelegramReport(client, async (ms: number) => { sleepCalls.push(ms); }),
      ).resolves.toBeUndefined();
      // Initial attempt plus one retry per configured delay.
      expect(fetchMock).toHaveBeenCalledTimes(sleepCalls.length + 1);
      expect(sleepCalls.length).toBeGreaterThan(0);
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain(`Failed to send daily Telegram report after ${sleepCalls.length + 1} attempt(s): fetch failed`);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('readBudgetSnapshot', () => {
  it('zips spend/budget/week maps into a snapshot covering every category from either map', () => {
    vi.mocked(getNativeWealthfolioSpending).mockReturnValueOnce({ Groceries: 200, OnlyInSpend: 300 });
    vi.mocked(getNativeWealthfolioBudgets).mockReturnValueOnce({ Groceries: 800, OnlyInBudget: 100 });
    vi.mocked(getNativeWealthfolioSpendingBetween).mockReturnValueOnce({ Groceries: 50 });

    const { categories } = readBudgetSnapshot('/mnt/wealthfolio.db', new Date(2026, 6, 14, 9, 0, 0));

    expect(categories).toEqual([
      { name: 'Groceries', budget: 800, monthSpent: 200, weekSpent: 50 },
      { name: 'OnlyInBudget', budget: 100, monthSpent: 0, weekSpent: 0 },
      { name: 'OnlyInSpend', budget: 0, monthSpent: 300, weekSpent: 0 },
    ]);
  });

  it('computes the period the same way the daily digest does, for a known fixture date', () => {
    // Tuesday 2026-07-14: week began Monday the 13th, July has 31 days.
    //   daysFromWeekStartToMonthEnd = 31 - 13 + 1 = 19
    //   daysLeftInMonthInclusive (counting today) = 31 - 14 + 1 = 18
    const { period } = readBudgetSnapshot('/mnt/wealthfolio.db', new Date(2026, 6, 14, 9, 0, 0));

    expect(period).toEqual({ daysFromWeekStartToMonthEnd: 19, daysLeftInMonthInclusive: 18 });
  });

  it('asks for the week-scoped spend using the same nextMonthStart upper bound as the digest', () => {
    readBudgetSnapshot('/mnt/wealthfolio.db', new Date(2026, 6, 14, 9, 0, 0));

    expect(vi.mocked(getNativeWealthfolioSpendingBetween)).toHaveBeenCalledWith(
      '/mnt/wealthfolio.db', '2026-07-13', '2026-08-01',
    );
  });

  it('does not filter by any category selection — every category from spend or budget is present', () => {
    vi.mocked(getNativeWealthfolioSpending).mockReturnValueOnce({ Groceries: 200 });
    vi.mocked(getNativeWealthfolioBudgets).mockReturnValueOnce({ Dining: 500 });

    const { categories } = readBudgetSnapshot('/mnt/wealthfolio.db', new Date(2026, 6, 14, 9, 0, 0));

    expect(categories.map((c) => c.name)).toEqual(['Dining', 'Groceries']);
  });
});

describe('composeDailyDigestMessage', () => {
  it('returns the same message text sendDailyTelegramReport sends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 14, 9, 0, 0));
    try {
      const secrets = new Map<string, string>();
      secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
      } as any;

      const message = await composeDailyDigestMessage(client);

      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);
      await sendDailyTelegramReport(client);
      const sentText = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;

      expect(message).toBe(sentText);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null when telegram is not configured', async () => {
    const client = {
      getAddonSecret: vi.fn(async () => null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;

    await expect(composeDailyDigestMessage(client)).resolves.toBeNull();
  });

  it('returns null when the database is missing', async () => {
    vi.mocked(existsSync).mockReturnValueOnce(false);
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;

    await expect(composeDailyDigestMessage(client)).resolves.toBeNull();
  });
});

describe('runCompanionSyncExclusive', () => {
  it('returns the same promise identity to a second caller while the first sync is pending', async () => {
    const deferred = createDeferred<SyncResult>();
    const runner = vi.fn(() => deferred.promise);

    const first = runCompanionSyncExclusive(runner);
    const second = runCompanionSyncExclusive(runner);

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.result).toBe(first.result);
    expect(runner).toHaveBeenCalledTimes(1);

    // Drain the in-flight slot: it is module-level state shared across every
    // test in this file, and an unsettled promise here would make the NEXT
    // test's call see a stale "still running" sync instead of starting fresh.
    deferred.resolve(FAKE_SYNC_RESULT);
    await first.result;
  });

  it('starts a fresh sync once the in-flight one resolves', async () => {
    const deferred = createDeferred<SyncResult>();
    const runner = vi.fn(() => deferred.promise);

    const first = runCompanionSyncExclusive(runner);
    deferred.resolve(FAKE_SYNC_RESULT);
    await first.result;

    const secondRunner = vi.fn(async () => FAKE_SYNC_RESULT);
    const third = runCompanionSyncExclusive(secondRunner);

    expect(third.started).toBe(true);
    expect(secondRunner).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight slot even when the sync rejects, so the next call can start', async () => {
    const deferred = createDeferred<SyncResult>();
    const runner = vi.fn(() => deferred.promise);

    const first = runCompanionSyncExclusive(runner);
    deferred.reject(new Error('sync failed'));
    await expect(first.result).rejects.toThrow('sync failed');

    const secondRunner = vi.fn(async () => FAKE_SYNC_RESULT);
    const second = runCompanionSyncExclusive(secondRunner);

    expect(second.started).toBe(true);
    expect(secondRunner).toHaveBeenCalledTimes(1);
  });
});

describe('buildTelegramCommandHandler', () => {
  const ISO_2H_AGO = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  /** The store every handler test reads through: a Map behind the two secret
   *  methods, exactly as the report tests above fake it. */
  const clientFor = (entries: Array<[string, string]> = []) => {
    const secrets = new Map<string, string>(entries);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    } as any;
    return { client, secrets };
  };

  /** Collects what the handler replies. Mirrors the listener's guarantee that a
   *  reply callback never rejects, so a test can never mask a handler bug as a
   *  transport failure. */
  const collector = () => {
    const sent: string[] = [];
    return { sent, reply: async (text: string) => { sent.push(text); } };
  };

  const run = async (client: any, command: string, args = '') => {
    const { sent, reply } = collector();
    await buildTelegramCommandHandler(client)({ command, args }, reply);
    return sent;
  };

  /** `/sync` deliberately returns BEFORE its summary is sent (the poll loop must
   *  keep running), so its tests wait on the reply rather than on the handler. */
  const waitFor = async (what: string, predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 500; i += 1) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
  });

  it('answers /help with the registered command menu', async () => {
    const { client } = clientFor();
    const sent = await run(client, 'help');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(formatHelpReply());
  });

  it('answers an unknown command with the menu and names what it did not understand', async () => {
    const { client } = clientFor();
    const sent = await run(client, 'wat', 'now');
    expect(sent[0]).toBe(formatHelpReply('wat'));
  });

  it('answers /report with the daily digest plus a freshness footer', async () => {
    const { client } = clientFor([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
      ['last_sync_at', ISO_2H_AGO()],
    ]);

    const sent = await run(client, 'report');

    expect(sent).toHaveLength(1);
    // The digest itself — same text composeDailyDigestMessage builds.
    expect(sent[0]).toContain('Groceries');
    // …and the footer, last, so a cached report cannot read as a live one.
    expect(sent[0]).toMatch(/Data as of last sync, 2h ago — \/sync to pull new charges\.$/);
  });

  it('tells /report why there is nothing to send when the digest cannot be built', async () => {
    const { client } = clientFor();
    const sent = await run(client, 'report');
    expect(sent[0]).toBe("Telegram reports are not configured — check budgets and the addon's Notifications tab.");
  });

  it('answers /report with the never-synced footer when no sync has run', async () => {
    const { client } = clientFor([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const sent = await run(client, 'report');
    expect(sent[0]).toMatch(/No sync has run yet — \/sync to pull transactions\.$/);
  });

  it('answers /report even when the scheduled daily digest is switched off, while 8am stays silent', async () => {
    // Unchecking "Daily" on the Notifications tab turns off the 8am SEND. It is
    // not an answer to "give me a report now": /report is an on-demand command,
    // gated on Telegram being configured and the database being readable.
    const { client } = clientFor([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true, dailyReportEnabled: false })],
      ['last_sync_at', ISO_2H_AGO()],
    ]);

    const sent = await run(client, 'report');

    expect(sent[0]).toContain('Groceries');
    expect(sent[0]).toMatch(/Data as of last sync, 2h ago — \/sync to pull new charges\.$/);

    // …and the schedule still honours the unchecked box, unchanged.
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await sendDailyTelegramReport(client);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not claim /report has never synced when the last-sync read itself failed', async () => {
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => {
        if (k === 'last_sync_at') throw new Error('401 unauthorized');
        return secrets.get(k) ?? null;
      }),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    } as any;

    const sent = await run(client, 'report');

    // "No sync has run yet" is a confident claim about a signal that could not
    // be read at all — the digest above it is real, its freshness is unknown.
    expect(sent[0]).not.toContain('No sync has run yet');
    expect(sent[0]).toContain('Could not read the last sync time');
  });

  it('answers bare /left with one line per budgeted category', async () => {
    const { client } = clientFor();
    const sent = await run(client, 'left');
    // Mocked fixtures: Groceries 200/800, Dining 550/500.
    expect(sent[0]).toContain('Groceries');
    expect(sent[0]).toContain('Dining');
  });

  it('answers /left <query> with just the category that matched', async () => {
    const { client } = clientFor();
    const sent = await run(client, 'left', 'groc');
    expect(sent[0]).toContain('Groceries');
    expect(sent[0]).not.toContain('Dining');
  });

  it('answers an unparseable /afford with the one usage line', async () => {
    const { client } = clientFor();
    const sent = await run(client, 'afford', 'shopping');
    expect(sent[0]).toBe('Usage: /afford 20 shopping');
  });

  it('answers /afford <amount> <category> with the before → after pair', async () => {
    const { client } = clientFor();
    const sent = await run(client, 'afford', '20 groceries');
    expect(sent[0]).toContain('This week:');
    expect(sent[0]).toContain('This month:');
  });

  it('assembles /status from sync_health, the balance snapshot and the published counts', async () => {
    const { client } = clientFor([
      ['sync_health', JSON.stringify({ lastSuccessAt: ISO_2H_AGO() })],
      ['account_balances', JSON.stringify({
        'sfin-1': { balance: 3475.23, currency: 'USD', date: 1_760_000_000, drift: 13, measured: true },
        'sfin-2': { balance: 100, currency: 'USD', date: 1_760_000_000, drift: null, measured: true },
        'sfin-3': { balance: 40, currency: 'USD', date: 1_760_000_000, drift: null },
      })],
      ['account_names', JSON.stringify({ 'sfin-1': 'Spend (4937)', 'sfin-2': 'Save', 'sfin-3': 'Old' })],
      ['uncategorized_status', JSON.stringify({ count: 3, asOf: ISO_2H_AGO(), rows: [] })],
      ['amazon_mail_status', JSON.stringify({ unparsed: 2, asOf: ISO_2H_AGO() })],
    ]);

    const sent = await run(client, 'status');

    expect(sent[0]).toContain(`*SimpleFin Sync* — companion v${SIMPLEFIN_SYNC_VERSION}`);
    expect(sent[0]).toContain('Last sync: 2h ago');
    expect(sent[0]).toContain('Spend (4937): $3,475 · $13 off');
    expect(sent[0]).toContain('Save: $100 · in sync');
    // `measured` absent — an older build's snapshot proves nothing about drift.
    expect(sent[0]).toContain('Old: $40 · not checked');
    expect(sent[0]).toContain('Needs a category: 3');
    expect(sent[0]).toContain('2 Amazon email(s) unread');
  });

  it('still answers /status when every single secret read fails', async () => {
    const client = {
      getAddonSecret: vi.fn(async () => { throw new Error('wealthfolio unreachable'); }),
      setAddonSecret: vi.fn(async () => {}),
    } as any;

    const sent = await run(client, 'status');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`companion v${SIMPLEFIN_SYNC_VERSION}`);
    // Was `Last sync: never` — a confident negative derived from a read that
    // threw. The command still ANSWERS (this test's actual subject), it just no
    // longer claims a fact it could not check. See the two tests below.
    expect(sent[0]).toContain('Last sync: unknown — the sync record could not be read.');
    // A missing signal is omitted, never rendered as a confident zero.
    expect(sent[0]).not.toContain('Needs a category');
    expect(sent[0]).not.toContain('Amazon');
  });

  it('counts the accounts SimpleFin reported no numeric balance for instead of claiming $0 — or hiding them', async () => {
    const { client } = clientFor([
      ['account_balances', JSON.stringify({
        'sfin-1': { balance: null, currency: 'USD', date: 1_760_000_000, drift: null, measured: false },
        'sfin-2': { balance: 100, currency: 'USD', date: 1_760_000_000, drift: null, measured: true },
      })],
      ['account_names', JSON.stringify({ 'sfin-1': 'No Balance', 'sfin-2': 'Save' })],
    ]);

    const sent = await run(client, 'status');

    expect(sent[0]).not.toContain('No Balance: $0');
    expect(sent[0]).toContain('Save: $100 · in sync');
    // A quietly SHORT account list is worse than one that admits the gap.
    expect(sent[0]).toContain('1 account(s) have no balance yet');
  });

  it('says the sync record could not be read instead of claiming the companion has never synced', async () => {
    const secrets = new Map<string, string>([
      ['account_balances', JSON.stringify({
        'sfin-2': { balance: 100, currency: 'USD', date: 1_760_000_000, drift: null, measured: true },
      })],
      ['account_names', JSON.stringify({ 'sfin-2': 'Save' })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => {
        if (k === 'sync_health') throw new Error('401 unauthorized');
        return secrets.get(k) ?? null;
      }),
      setAddonSecret: vi.fn(async () => {}),
    } as any;

    const sent = await run(client, 'status');

    // A transient 401 is not evidence that no sync ever ran.
    expect(sent[0]).not.toContain('Last sync: never');
    expect(sent[0]).toContain('Last sync: unknown — the sync record could not be read.');
    // Everything else still answers.
    expect(sent[0]).toContain('Save: $100 · in sync');
  });

  it('says the balance snapshot could not be read instead of showing an unexplained empty list', async () => {
    const secrets = new Map<string, string>([
      ['sync_health', JSON.stringify({ lastSuccessAt: ISO_2H_AGO() })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => {
        if (k === 'account_balances') throw new Error('401 unauthorized');
        return secrets.get(k) ?? null;
      }),
      setAddonSecret: vi.fn(async () => {}),
    } as any;

    const sent = await run(client, 'status');

    expect(sent[0]).toContain('Last sync: 2h ago');
    // Zero account lines AND `0 accounts have no balance` explained nothing.
    expect(sent[0]).toContain('Account balances could not be read');
    expect(sent[0]).not.toContain('have no balance yet');
  });

  it('acknowledges /sync immediately, returns without waiting, and reports the run when it lands', async () => {
    const secrets = new Map<string, string>([
      ['simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin'],
    ]);
    const client: any = {
      login: vi.fn(async () => {}),
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };
    const { WealthfolioClient } = await import('./wealthfolio.js');
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    const { sent, reply } = collector();
    await buildTelegramCommandHandler(client)({ command: 'sync', args: '' }, reply);

    // Returned already: the listener's poll loop is free again, so a /status sent
    // during a sync is still answered instead of queueing behind it.
    expect(sent).toEqual(['Syncing…']);

    // The mocked runSyncCore's usual result: 2 imported, 1 skipped.
    await waitFor('the sync summary', () => sent.length >= 2);
    expect(sent[1]).toBe('Synced: 2 imported, 1 skipped.');
  });

  it('tells a second /sync that one is already running, returns, then reports the shared result', async () => {
    const deferred = createDeferred<SyncResult>();
    const occupying = runCompanionSyncExclusive(() => deferred.promise);
    expect(occupying.started).toBe(true);

    const { client } = clientFor();
    const { sent, reply } = collector();
    // Awaited to completion — and it completes while the sync is still pending.
    await buildTelegramCommandHandler(client)({ command: 'sync', args: '' }, reply);
    expect(sent).toEqual(['Already syncing — hang on.']);

    deferred.resolve({ ...FAKE_SYNC_RESULT, imported: 4, skipped: 9 });
    await occupying.result;

    await waitFor('the shared run summary', () => sent.length >= 2);
    expect(sent[1]).toBe('Synced: 4 imported, 9 skipped.');
  });

  it('reports a failed shared run through the reply, leaving no rejection unhandled', async () => {
    const deferred = createDeferred<SyncResult>();
    const occupying = runCompanionSyncExclusive(() => deferred.promise);

    const { client } = clientFor();
    const { sent, reply } = collector();
    await buildTelegramCommandHandler(client)({ command: 'sync', args: '' }, reply);

    deferred.reject(new Error('SimpleFin: token revoked'));
    await expect(occupying.result).rejects.toThrow('token revoked');

    expect(sent[0]).toBe('Already syncing — hang on.');
    await waitFor('the error summary', () => sent.length >= 2);
    expect(sent[1]).toContain('Sync finished with errors: SimpleFin: token revoked');
  });

  it('runs /sync FORCED, so a command typed minutes after the cron tick is not refused by the interval guard', async () => {
    // The addon's Sync Now offers a "Sync anyway" button when the interval guard
    // skips a run. A chat command has no second click, so an explicitly
    // requested sync must force — otherwise /sync answers
    // "0 imported, 0 skipped" plus "minimum sync interval not yet elapsed".
    process.env.MIN_SYNC_INTERVAL_HOURS = '1';
    vi.mocked(runSyncCore).mockClear();

    const secrets = new Map<string, string>([
      ['simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin'],
    ]);
    const client: any = {
      login: vi.fn(async () => {}),
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };
    const { WealthfolioClient } = await import('./wealthfolio.js');
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    try {
      const { sent, reply } = collector();
      await buildTelegramCommandHandler(client)({ command: 'sync', args: '' }, reply);
      await waitFor('the sync summary', () => sent.length >= 2);

      expect(vi.mocked(runSyncCore).mock.calls[0][2]).toMatchObject({ force: true });
    } finally {
      delete process.env.MIN_SYNC_INTERVAL_HOURS;
    }
  });
});

describe('buildTelegramListenerDeps', () => {
  const configured = JSON.stringify({ botToken: 'tok', chatId: '4242', enabled: true });

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    delete process.env.WEALTHFOLIO_API_KEY;
  });

  const clientWith = (impl: (key: string) => Promise<string | null>) => ({
    login: vi.fn(async () => {}),
    getAddonSecret: vi.fn(async (_a: string, k: string) => impl(k)),
    setAddonSecret: vi.fn(async () => {}),
  } as any);

  it('reads the config and authenticates once, reusing the session while it is fresh', async () => {
    const client = clientWith(async (k) => (k === 'telegram_config' ? configured : null));
    const deps = buildTelegramListenerDeps(client);

    await expect(deps.readConfig()).resolves.toEqual({ botToken: 'tok', chatId: '4242', botName: undefined });
    await deps.readConfig();

    // One login for two cycles: the loop wakes every ~50s and a login per wake
    // would be ~1,700 pointless authentications a day.
    expect(client.login).toHaveBeenCalledTimes(1);
  });

  it('reports an unreadable telegram_config as an auth/connectivity failure, never as "not configured"', async () => {
    // Returning null here is what the listener treats as "no Telegram
    // configuration yet": it logs that ONCE and idles forever, which is exactly
    // the healthy-looking silent bot this must not become.
    const client = clientWith(async () => { throw new Error('getAddonSecret failed: 401'); });
    const deps = buildTelegramListenerDeps(client);

    await expect(deps.readConfig()).rejects.toThrow(/could not read telegram_config/);
    await expect(deps.readConfig()).rejects.toThrow(/not a missing configuration/);
  });

  it('re-authenticates on the very next cycle after a failed read, rather than waiting out the session window', async () => {
    const client = clientWith(async () => { throw new Error('getAddonSecret failed: 401'); });
    const deps = buildTelegramListenerDeps(client);

    await expect(deps.readConfig()).rejects.toThrow();
    await expect(deps.readConfig()).rejects.toThrow();

    // An expired token is the likeliest cause, so the session is discarded and
    // retried immediately — not cached as fresh for another 30 minutes.
    expect(client.login).toHaveBeenCalledTimes(2);
  });

  it('names the missing credential and keeps retrying when there is nothing to log in with', async () => {
    // Startup validation already proved one of the three credentials was set, so
    // this state means WEALTHFOLIO_PASSWORD_FILE is unreadable right now — and
    // `resolvePassword` re-reads it from disk every call, so it can come back.
    delete process.env.WEALTHFOLIO_PASSWORD;
    const client = clientWith(async () => configured);
    const deps = buildTelegramListenerDeps(client);

    await expect(deps.readConfig()).rejects.toThrow(/no Wealthfolio password/i);
    await expect(deps.readConfig()).rejects.toThrow(/no Wealthfolio password/i);
    expect(client.getAddonSecret).not.toHaveBeenCalled();
  });

  it('still reports a genuinely absent configuration as null, so the listener idles quietly', async () => {
    const client = clientWith(async () => null);
    const deps = buildTelegramListenerDeps(client);

    await expect(deps.readConfig()).resolves.toBeNull();
  });

  it('treats a disabled Telegram config as unconfigured', async () => {
    const client = clientWith(async () => JSON.stringify({ botToken: 't', chatId: '1', enabled: false }));
    const deps = buildTelegramListenerDeps(client);

    await expect(deps.readConfig()).resolves.toBeNull();
  });

  it('reads and writes the stored update offset, treating junk as absent', async () => {
    const client = clientWith(async () => 'not a number');
    const deps = buildTelegramListenerDeps(client);
    await expect(deps.readOffset()).resolves.toBeNull();

    const numeric = clientWith(async () => '77');
    const numericDeps = buildTelegramListenerDeps(numeric);
    await expect(numericDeps.readOffset()).resolves.toBe(77);

    await numericDeps.writeOffset(78);
    expect(numeric.setAddonSecret).toHaveBeenCalledWith('simplefin-sync', 'telegram_update_offset', '78');
  });

  it('uses a sleep that cannot reject', async () => {
    const deps = buildTelegramListenerDeps(clientWith(async () => null));
    await expect(deps.sleep(1)).resolves.toBeUndefined();
  });
});

describe('undoTelegramDismissal', () => {
  it('removes only the tapped id, merging against a fresh re-read', async () => {
    // The mirror of the 1.10.1 test above: an undo is an id-REMOVAL delta, and
    // it must not take a dismissal the other writer made in between down with
    // it. A whole-object write of the stale snapshot minus one id would.
    const secrets = new Map<string, string>([
      ['uncategorized_dismissals', JSON.stringify({
        'act-1': '2026-08-09T00:00:00.000Z', 'act-2': '2026-08-10T00:00:00.000Z',
      })],
    ]);
    let ledgerReads = 0;
    const client: any = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => {
        if (k !== 'uncategorized_dismissals') return secrets.get(k) ?? null;
        ledgerReads += 1;
        const current = secrets.get(k)!;
        if (ledgerReads === 1) {
          secrets.set(k, JSON.stringify({ ...JSON.parse(current), 'act-addon': new Date().toISOString() }));
          return current;
        }
        return secrets.get(k)!;
      }),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };

    await undoTelegramDismissal(client, 'act-1');

    const written = JSON.parse(secrets.get('uncategorized_dismissals')!);
    expect(Object.keys(written).sort()).toEqual(['act-2', 'act-addon']);
  });

  it('writes nothing when the id was never dismissed', async () => {
    // A doubled tap, or Undo on a row the addon already restored. Idempotent,
    // and silent: there is nothing to confirm.
    const secrets = new Map<string, string>([
      ['uncategorized_dismissals', JSON.stringify({ 'act-1': '2026-08-09T00:00:00.000Z' })],
    ]);
    const client: any = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    };
    await undoTelegramDismissal(client, 'act-nope');
    expect(client.setAddonSecret).not.toHaveBeenCalled();
  });
});

describe('/dismissed', () => {
  const rows = [
    { activityId: 'a1', notes: 'Frame It Easy · TRN-1', amountCents: 8889, date: '2026-08-24', accountName: 'Robinhood' },
    { activityId: 'a2', notes: 'The Post · TRN-2', amountCents: 10574, date: '2026-08-22', accountName: 'Robinhood' },
  ];

  it('lists only rows the ledger holds, newest dismissal first, each with an Undo button', async () => {
    // The button-swap undo lives on the notice that was tapped; a notice that
    // has scrolled away has no way back. This is that way back.
    vi.mocked(getNativeUncategorizedSpending).mockReturnValueOnce(rows as any);
    const secrets = new Map<string, string>([
      ['uncategorized_dismissals', JSON.stringify({
        a1: '2026-08-24T10:00:00.000Z', a2: '2026-08-25T10:00:00.000Z',
      })],
    ]);
    const client: any = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    };
    const sent: Array<{ text: string; keyboard?: any }> = [];
    await buildTelegramCommandHandler(client)(
      { command: 'dismissed', args: '' },
      async (text: string, keyboard?: any) => { sent.push({ text, keyboard }); },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('*2 dismissed*');
    const buttons = sent[0].keyboard.inline_keyboard.flat();
    // a2 was dismissed later, so it comes first — the most likely slip.
    expect(buttons.map((b: any) => b.callback_data)).toEqual(['u:a2', 'u:a1']);
    expect(buttons[0].text).toContain('↩ Undo: The Post');
    for (const b of buttons) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it('says so plainly when nothing is dismissed', async () => {
    vi.mocked(getNativeUncategorizedSpending).mockReturnValueOnce(rows as any);
    const client: any = {
      getAddonSecret: vi.fn(async () => null),
      setAddonSecret: vi.fn(async () => {}),
    };
    const sent: Array<{ text: string; keyboard?: any }> = [];
    await buildTelegramCommandHandler(client)(
      { command: 'dismissed', args: '' },
      async (text: string, keyboard?: any) => { sent.push({ text, keyboard }); },
    );
    expect(sent[0].text).toContain('Nothing dismissed');
    expect(sent[0].keyboard).toBeUndefined();
  });

  it('formats an empty list without a keyboard and a full one with the row cap', () => {
    expect(formatDismissedReply([]).keyboard).toBeUndefined();
    const many = Array.from({ length: 12 }, (_, i) => ({
      activityId: `id-${i}`, description: `Row ${i}`, amountCents: 100, date: '2026-08-20', accountName: 'X',
    }));
    const out = formatDismissedReply(many);
    expect(out.text).toContain('*12 dismissed*');
    expect(out.text).toContain('more');
    expect(out.keyboard!.inline_keyboard.length).toBeLessThan(12);
  });
});

describe('applyTelegramDismissal', () => {
  const clientOver = (secrets: Map<string, string>) => ({
    getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
    setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
  } as any);

  it('merges onto a re-read ledger, so a dismissal written between the read and the write survives', async () => {
    // The 1.10.1 bug: a whole-object write from a snapshot read moments earlier
    // silently erased a dismissal the OTHER host made in between, and the row
    // reappeared as needing a category. Reading once and calling
    // `mergeDismissals(base, base, next)` would pass a test that only checks
    // "existing entries survive" — the merge has to be against a FRESH read to
    // mean anything, which is what this asserts.
    const secrets = new Map<string, string>([
      ['uncategorized_dismissals', JSON.stringify({ 'act-earlier': '2026-08-09T00:00:00.000Z' })],
    ]);
    let ledgerReads = 0;
    const client: any = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => {
        if (k !== 'uncategorized_dismissals') return secrets.get(k) ?? null;
        ledgerReads += 1;
        const current = secrets.get(k)!;
        if (ledgerReads === 1) {
          // The addon dismisses something of its own right after this read.
          secrets.set(k, JSON.stringify({ ...JSON.parse(current), 'act-addon': new Date().toISOString() }));
          return current;
        }
        return secrets.get(k)!;
      }),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };

    await applyTelegramDismissal(client, 'act-tapped');

    const written = JSON.parse(secrets.get('uncategorized_dismissals')!);
    expect(Object.keys(written).sort()).toEqual(['act-addon', 'act-earlier', 'act-tapped']);
    expect(written['act-earlier']).toBe('2026-08-09T00:00:00.000Z');
  });

  it('writes nothing at all when the id is already dismissed', async () => {
    const secrets = new Map<string, string>([
      ['uncategorized_dismissals', JSON.stringify({ 'act-1': '2026-08-09T00:00:00.000Z' })],
    ]);
    const client = clientOver(secrets);

    await applyTelegramDismissal(client, 'act-1');

    expect(client.setAddonSecret).not.toHaveBeenCalled();
  });

  it('records a tap even when no ledger exists yet', async () => {
    const secrets = new Map<string, string>();
    const client = clientOver(secrets);

    await applyTelegramDismissal(client, 'act-first');

    expect(JSON.parse(secrets.get('uncategorized_dismissals')!)).toHaveProperty('act-first');
  });
});

describe('sendWeeklyTelegramReport', () => {
  it('sends the total-remaining summary across all included categories', async () => {
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendWeeklyTelegramReport(client);

    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    // totalSpent = 750, totalBudget = 1300, remaining = 550
    expect(text).toContain('*$550 left* this month');
    expect(text).toContain('_spent $750 of $1,300 · 58%_');
  });

  it('does nothing when weeklyReportEnabled is false', async () => {
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true, weeklyReportEnabled: false })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendWeeklyTelegramReport(client);

    expect(client.setAddonSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('biggest spends this week', () => {
    function weeklyClient(config: Record<string, unknown> = {}) {
      const secrets = new Map<string, string>([
        ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true, ...config })],
      ]);
      return {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
      } as any;
    }

    beforeEach(() => vi.mocked(getNativeWealthfolioTopSpending).mockClear());
    afterEach(() => vi.useRealTimers());

    it('appends the week\'s biggest spends to the outgoing message body', async () => {
      const client = weeklyClient();
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendWeeklyTelegramReport(client);

      const [, sentBody] = fetchMock.mock.calls[0];
      const text = JSON.parse((sentBody as any).body).text;
      expect(text).toContain('*$550 left* this month');
      expect(text).toContain('*Biggest this week*');
      // The `*`-laden card descriptor arrives escaped, and outside every entity.
      expect(text).toContain('$412 · WHOLE FOODS MKT · Dining');
      expect(text).toContain('$96 · SQ \\*BLUE BOTTLE · Dining');
      expect(text).toContain('$63 · COSTCO GAS · PUMP 4 · Groceries');
      // Whatever Telegram would actually parse is balanced: only the report's own
      // three bold pairs survive unescaped.
      const unescaped = text.replace(/\\[_*`[]/g, '');
      expect((unescaped.match(/\*/g) ?? [])).toHaveLength(6);
    });

    it('reads the week from Monday WITHOUT clamping to the 1st of the month', async () => {
      // Saturday 2026-08-01 — the report's own schedule lands on a day that is
      // both a Saturday and the 1st. The daily digest clamps its week to the 1st
      // because a monthly budget cannot be spent before the month began; doing
      // that here would leave a heading that says "this week" over a single day
      // of data.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 7, 1, 9, 0, 0));
      vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true }) })));

      await sendWeeklyTelegramReport(weeklyClient());

      expect(vi.mocked(getNativeWealthfolioTopSpending)).toHaveBeenCalledWith(
        expect.any(String), '2026-07-27', '2026-08-03', 5,
      );
    });

    it('asks for the whole Monday-to-Sunday week, half-open', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 11, 9, 0, 0)); // Saturday 2026-07-11
      vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: true }) })));

      await sendWeeklyTelegramReport(weeklyClient());

      expect(vi.mocked(getNativeWealthfolioTopSpending)).toHaveBeenCalledWith(
        expect.any(String), '2026-07-06', '2026-07-13', 5,
      );
    });

    it('omits the section when nothing was spent this week', async () => {
      vi.mocked(getNativeWealthfolioTopSpending).mockReturnValueOnce([]);
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendWeeklyTelegramReport(weeklyClient());

      const [, sentBody] = fetchMock.mock.calls[0];
      const text = JSON.parse((sentBody as any).body).text;
      expect(text).toContain('*$550 left* this month');
      expect(text).not.toContain('Biggest');
      expect(text).toBe(text.trimEnd());
    });

    it('honours weeklyTopSpendCount, and skips the query entirely when it is 0', async () => {
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendWeeklyTelegramReport(weeklyClient({ weeklyTopSpendCount: 3 }));
      expect(vi.mocked(getNativeWealthfolioTopSpending)).toHaveBeenCalledWith(
        expect.any(String), expect.any(String), expect.any(String), 3,
      );

      vi.mocked(getNativeWealthfolioTopSpending).mockClear();
      await sendWeeklyTelegramReport(weeklyClient({ weeklyTopSpendCount: 0 }));
      expect(vi.mocked(getNativeWealthfolioTopSpending)).not.toHaveBeenCalled();
      const text = JSON.parse((fetchMock.mock.calls[1][1] as any).body).text;
      expect(text).not.toContain('Biggest');
    });

    it('logs a rejected send at once, without spending the retry budget', async () => {
      // `sendTelegramMessage` reports an API-level failure — a 400 from
      // unbalanced Markdown being the one this section could plausibly cause —
      // by RESOLVING `{ ok: false }`, not throwing. Malformed Markdown fails
      // identically on every attempt, so it is reported immediately: retrying
      // it only delays the error reaching whoever has to fix it.
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false, description: "can't parse entities" }) }));
      vi.stubGlobal('fetch', fetchMock);
      try {
        await expect(sendWeeklyTelegramReport(weeklyClient(), async () => {})).resolves.toBeUndefined();
        expect(logs.mock.calls.flat().join('\n')).toContain('Failed to send weekly Telegram report');
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        logs.mockRestore();
      }
    });

    it('retries after a transient failure and reports success once it lands', async () => {
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
      // A real connectivity failure REJECTS — modelling it as a resolved
      // `ok: false` made the fixture indistinguishable from Telegram rejecting
      // the message, which is the opposite case and must not be retried.
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValue({ json: async () => ({ ok: true }) });
      vi.stubGlobal('fetch', fetchMock);
      try {
        await expect(sendWeeklyTelegramReport(weeklyClient(), async () => {})).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(logs.mock.calls.flat().join('\n')).toContain('Weekly Telegram total-remaining summary sent successfully.');
      } finally {
        logs.mockRestore();
      }
    });
  });
});

describe('previousYearMonth', () => {
  it('names the calendar month before the given date', () => {
    expect(previousYearMonth(new Date(2026, 6, 1, 9, 0, 0))).toEqual({
      yearMonth: '2026-06', monthName: 'June',
    });
  });

  it('rolls back to December of the PREVIOUS year on 1 January', () => {
    // The case that silently produces an empty report if it is got wrong: naive
    // arithmetic asks for `2027-00`, which matches no `activity_date` and no
    // `period_key`, so the wrap-up would render as "nothing to report" once a
    // year with nothing to indicate anything had gone wrong.
    expect(previousYearMonth(new Date(2027, 0, 1, 9, 0, 0))).toEqual({
      yearMonth: '2026-12', monthName: 'December',
    });
  });

  it('zero-pads the month', () => {
    expect(previousYearMonth(new Date(2026, 9, 1)).yearMonth).toBe('2026-09');
    expect(previousYearMonth(new Date(2026, 1, 1)).yearMonth).toBe('2026-01');
  });

  it('is unaffected by the day of the month it is asked on', () => {
    // The cron fires on the 1st, but nothing should depend on that — a manual run
    // mid-month must still describe the month that ended.
    for (const day of [1, 15, 28, 31]) {
      expect(previousYearMonth(new Date(2026, 6, day)).yearMonth).toBe('2026-06');
    }
  });
});

describe('sendMonthlyTelegramReport', () => {
  it('reads the PREVIOUS month from both native readers, rolling the year back on 1 January', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 1, 9, 0, 0));
    try {
      const secrets = new Map<string, string>([
        ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
      ]);
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async () => {}),
      } as any;
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendMonthlyTelegramReport(client);

      expect(vi.mocked(getNativeWealthfolioSpending)).toHaveBeenCalledWith(expect.any(String), '2026-12');
      expect(vi.mocked(getNativeWealthfolioBudgets)).toHaveBeenCalledWith(expect.any(String), '2026-12');
      const [, sentBody] = fetchMock.mock.calls[0];
      const text = JSON.parse((sentBody as any).body).text;
      expect(text).toContain('*December wrap-up*');
      expect(text).not.toContain('January');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a per-category budgeted-vs-spent wrap-up with a total verdict', async () => {
    // Mocked month figures: Groceries 200 of 800, Dining 550 of 500.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 1, 9, 0, 0));
    try {
      const secrets = new Map<string, string>([
        ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
      ]);
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
      } as any;
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendMonthlyTelegramReport(client);

      const [, sentBody] = fetchMock.mock.calls[0];
      const text = JSON.parse((sentBody as any).body).text;
      expect(text).toBe(
        '*July wrap-up*\n'
        + '\n'
        + '🚨 Dining  $550 of $500 · *$50 over*\n'
        + '✅ Groceries  *$200* of $800\n'
        + '\n'
        + '💰 Finished *$550 under budget* · spent $750 of $1,300',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('states the direction when the month finished OVER budget overall', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 1, 9, 0, 0));
    try {
      vi.mocked(getNativeWealthfolioSpending).mockReturnValueOnce({ Groceries: 1100, Dining: 3794 });
      vi.mocked(getNativeWealthfolioBudgets).mockReturnValueOnce({ Groceries: 900, Dining: 2500 });
      const secrets = new Map<string, string>([
        ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
      ]);
      const client = {
        getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
        setAddonSecret: vi.fn(async () => {}),
      } as any;
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);

      await sendMonthlyTelegramReport(client);

      const [, sentBody] = fetchMock.mock.calls[0];
      const text = JSON.parse((sentBody as any).body).text;
      // spent 4894 of 3400 → $1,494 OVER. The exact figure that once shipped as
      // "$1,494 left" when a shared formatter absorbed the sign.
      expect(text).toContain('🚨 Finished *$1,494 over budget* · spent $4,894 of $3,400');
      expect(text).not.toContain('under budget');
      expect(text).not.toContain('left');
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes the available category list and filters to monthlyReportCategories', async () => {
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({
        botToken: 'tok', chatId: '1', enabled: true, monthlyReportCategories: ['Groceries'],
      })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendMonthlyTelegramReport(client);

    expect(client.setAddonSecret).toHaveBeenCalledWith(
      'simplefin-sync', 'available_report_categories', JSON.stringify(['Dining', 'Groceries']),
    );
    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('Groceries');
    expect(text).not.toContain('Dining');
  });

  it('escapes a `_`-bearing category name so Telegram cannot reject the whole send', async () => {
    vi.mocked(getNativeWealthfolioSpending).mockReturnValueOnce({ Food_Drink: 550 });
    vi.mocked(getNativeWealthfolioBudgets).mockReturnValueOnce({ Food_Drink: 500 });
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendMonthlyTelegramReport(client);

    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('Food\\_Drink');
    // Outside every entity: an escape inside one is ignored by legacy Markdown,
    // leaving a live opener and a 400 on the WHOLE message.
    expect(text).not.toContain('*Food\\_Drink*');
    expect(text.replace(/\\[_*`[]/g, '').match(/_/g)).toBeNull();
  });

  it('does nothing when monthlyReportEnabled is false', async () => {
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true, monthlyReportEnabled: false })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendMonthlyTelegramReport(client);

    expect(client.setAddonSecret).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opts an existing config without the field IN', async () => {
    // Only an explicit `false` suppresses it, matching its two siblings: a user
    // whose telegram_config predates this report should get it.
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendMonthlyTelegramReport(client);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends nothing and does not throw when telegram_config is corrupt', async () => {
    const secrets = new Map<string, string>([['telegram_config', 'not json at all']]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendMonthlyTelegramReport(client)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.setAddonSecret).not.toHaveBeenCalled();
  });

  it('logs a rejected send instead of discarding the result, after retrying', async () => {
    // `sendTelegramMessage` reports an API-level failure by RESOLVING
    // `{ ok: false }` — a 400 from malformed Markdown, a bad token, a rate limit.
    // Discarding it would lose the wrap-up silently, and it is only produced once
    // a month. An instant `sleep` stand-in skips the real retry delay.
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: false, description: "can't parse entities" }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(sendMonthlyTelegramReport(client, async () => {})).resolves.toBeUndefined();
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('Failed to send monthly Telegram report');
      expect(logged).toContain("can't parse entities");
      // Permanent: reported on the first attempt rather than after the budget.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('sendUnmappedAccountsNotice', () => {
  const ROBINHOOD = { sfinAccountId: 'sfin-rh', accountName: 'Robinhood Gold Card', orgName: 'Robinhood' };
  const ANNOUNCED_KEY = 'announced_unmapped_accounts';

  /** A client over a mutable secret map, so a test can assert what the ledger
   *  looks like AFTER the call the way the real secret would persist it. */
  const clientOver = (secrets: Map<string, string>) => ({
    getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
    setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
  }) as any;

  const configured = () => new Map<string, string>([
    ['telegram_config', JSON.stringify({ botToken: 'T', chatId: '9', enabled: true })],
  ]);

  it('announces a newly-seen unmapped account and records it', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const secrets = configured();

    await sendUnmappedAccountsNotice(clientOver(secrets), [ROBINHOOD]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
    expect(text).toContain('Robinhood Gold Card');
    expect(text).toContain('Robinhood');
    expect(text).toContain('Advanced');
    expect(JSON.parse(secrets.get(ANNOUNCED_KEY)!)).toEqual(['sfin-rh']);
  });

  it('stays silent on every later sync for an account it already announced', async () => {
    // The whole point of the ledger: this runs every 6 hours, and an account
    // can sit unmapped indefinitely.
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const secrets = configured();
    secrets.set(ANNOUNCED_KEY, JSON.stringify(['sfin-rh']));

    await sendUnmappedAccountsNotice(clientOver(secrets), [ROBINHOOD]);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT record the account when Telegram rejects the send', async () => {
    // `sendTelegramMessage` reports an API-level failure by RESOLVING
    // `{ ok: false }`. Recording on an unconfirmed send would silence this
    // account forever on the strength of a message that never arrived.
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false, description: 'Bad Request' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const secrets = configured();

    await sendUnmappedAccountsNotice(clientOver(secrets), [ROBINHOOD]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secrets.get(ANNOUNCED_KEY)).toBeUndefined();
  });

  it('leaves the account unannounced when Telegram is not configured', async () => {
    // The addon's own banner still reports it, so this is not a failure — but
    // the id must stay unrecorded so configuring Telegram later still notifies.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const secrets = new Map<string, string>();

    await sendUnmappedAccountsNotice(clientOver(secrets), [ROBINHOOD]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(secrets.get(ANNOUNCED_KEY)).toBeUndefined();
  });

  it('leaves the ledger ALONE for a run that never read the feed', async () => {
    // `null` is an interval skip or a missing-config pre-flight return — it
    // proves nothing about what is mapped. Treating it as "nothing unmapped"
    // cleared the ledger on every restart landing inside the sync interval,
    // which re-announced the same account indefinitely.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const secrets = configured();
    secrets.set(ANNOUNCED_KEY, JSON.stringify(['sfin-rh']));

    await sendUnmappedAccountsNotice(clientOver(secrets), null);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(secrets.get(ANNOUNCED_KEY)!)).toEqual(['sfin-rh']);
  });

  it('drops a now-mapped account from the ledger even when another stays unmapped', async () => {
    // The prune used to run only on the send path, so with one account still
    // unmapped (no fresh ids → early return) a mapped account's id stayed
    // recorded forever, silently suppressing its re-announcement if it ever
    // came back unmapped.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const secrets = configured();
    secrets.set(ANNOUNCED_KEY, JSON.stringify(['sfin-rh', 'sfin-mapped-since']));

    await sendUnmappedAccountsNotice(clientOver(secrets), [ROBINHOOD]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(secrets.get(ANNOUNCED_KEY)!)).toEqual(['sfin-rh']);
  });

  it('prunes the ledger even when Telegram is switched off', async () => {
    // Bookkeeping, not an announcement — it must not depend on Telegram.
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'T', chatId: '9', enabled: false })],
      [ANNOUNCED_KEY, JSON.stringify(['sfin-rh', 'sfin-gone'])],
    ]);
    await sendUnmappedAccountsNotice(clientOver(secrets), [ROBINHOOD]);
    expect(JSON.parse(secrets.get(ANNOUNCED_KEY)!)).toEqual(['sfin-rh']);
  });

  it('survives a ledger secret that is not an array', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const secrets = configured();
    secrets.set(ANNOUNCED_KEY, '{"not":"an array"}');

    await sendUnmappedAccountsNotice(clientOver(secrets), [ROBINHOOD]);

    // Treated as "nothing announced yet" rather than throwing into the outer
    // catch, which would leave the notice permanently dead.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secrets.get(ANNOUNCED_KEY)!)).toEqual(['sfin-rh']);
  });

  it('clears the ledger once nothing is unmapped, so a re-link announces again', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const secrets = configured();
    secrets.set(ANNOUNCED_KEY, JSON.stringify(['sfin-rh']));

    await sendUnmappedAccountsNotice(clientOver(secrets), []);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(secrets.get(ANNOUNCED_KEY)!)).toEqual([]);
  });

  it('announces only the accounts that are new since the last notice', async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const secrets = configured();
    secrets.set(ANNOUNCED_KEY, JSON.stringify(['sfin-rh']));
    const second = { sfinAccountId: 'sfin-2', accountName: 'Ally Savings' };

    await sendUnmappedAccountsNotice(clientOver(secrets), [ROBINHOOD, second]);

    const text = JSON.parse((fetchMock.mock.calls[0][1] as any).body).text;
    expect(text).toContain('Ally Savings');
    expect(text).not.toContain('Robinhood Gold Card');
    // Both are retained: the ledger tracks what is CURRENTLY unmapped, so it
    // cannot grow without bound as accounts come and go at the bridge.
    expect(JSON.parse(secrets.get(ANNOUNCED_KEY)!).sort()).toEqual(['sfin-2', 'sfin-rh']);
  });

  it('never throws — a notice failure must not fail a sync that already succeeded', async () => {
    const client = {
      getAddonSecret: vi.fn(async () => { throw new Error('secrets unreachable'); }),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    await expect(sendUnmappedAccountsNotice(client, [ROBINHOOD])).resolves.toBeUndefined();
  });
});

describe('sendImportNotice', () => {
  const uncatRow = (activityId: string, desc: string) => ({
    activityId, wfAccountId: 'wf-a', notes: `${desc} \u00b7 TRN-${activityId}`,
    amountCents: 4516, date: '2026-07-09', accountName: 'Spend (4937)',
  });
  const importedTx = {
    txId: 'tx-a', sfAccountId: 'sfin-1', description: 'TRADER JOE S #628',
    amountCents: 6774, currency: 'USD', accountName: 'Spend (4937)',
    activityType: 'WITHDRAWAL', pending: false, inTransit: false,
  };

  it('lists the imports and sweeps uncategorized minus whatever the ledger already holds', async () => {
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([
      uncatRow('act-1', 'VENMO PAYMENT'),
      uncatRow('act-old', 'DISMISSED EARLIER'),
      uncatRow('act-9', 'DISMISSED BY BUTTON'),
    ]);
    const fetchMock = vi.fn((_url: any, _init?: any) => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    // 'act-9' is a button press the LISTENER recorded, seconds after the tap and
    // long before this notice ran — this path no longer polls for it.
    const secrets = new Map<string, string>([
      ['uncategorized_dismissals', JSON.stringify({
        'act-old': '2026-07-20T00:00:00Z',
        'act-9': new Date().toISOString(),
      })],
    ]);
    const client: any = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };

    await sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
      imported: 1, importedTransactions: [importedTx],
    } as any);

    const sendCall = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('sendMessage'));
    expect(sendCall).toBeTruthy();
    const body = JSON.parse((sendCall![1] as any).body);
    expect(body.text).toContain('1 new transaction');
    expect(body.text).toContain('TRADER JOE S');
    expect(body.text).toContain('VENMO PAYMENT');
    // Dismissed rows are out — including the one dismissed by a button press.
    expect(body.text).not.toContain('DISMISSED EARLIER');
    expect(body.text).not.toContain('DISMISSED BY BUTTON');
    // One dismiss button per SHOWN needs-category row, plus the appended
    // `Categorize these` row that opens the menu (see buildDismissKeyboard).
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('d:act-1');
    expect(body.reply_markup.inline_keyboard[1]).toEqual([
      { text: 'Categorize these', callback_data: CATEGORIZE_ENTRY_CALLBACK },
    ]);
    // The listener is the bot's ONLY getUpdates consumer now: a second one here
    // would take 409s and make the bot look like it ignores every command.
    expect(fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('getUpdates'))).toHaveLength(0);
    expect(client.getAddonSecret).not.toHaveBeenCalledWith('simplefin-sync', 'telegram_update_offset');
    expect(client.setAddonSecret).not.toHaveBeenCalledWith('simplefin-sync', 'telegram_update_offset', expect.anything());
  });

  it('does not erase a dismissal the addon wrote after this run\'s first read', async () => {
    // The addon writes this same secret, and there is no compare-and-swap. This
    // run reads the ledger, prunes it, and writes it back, so a dismissal the
    // addon makes in between must still survive that write — it has to merge
    // onto whatever is persisted right now, not overwrite with the stale first
    // read. The pruning of a 61-day-old entry is this run's own change (a no-op
    // run writes nothing, and would prove nothing about the merge).
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([
      uncatRow('act-1', 'VENMO PAYMENT'),
    ]);
    const ancient = new Date(Date.now() - 61 * 86400_000).toISOString();
    const secrets = new Map<string, string>([
      ['uncategorized_dismissals', JSON.stringify({ 'act-ancient': ancient })],
    ]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ ok: true }) })));
    let ledgerReads = 0;
    const client: any = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => {
        if (k === 'uncategorized_dismissals') {
          ledgerReads += 1;
          // After the FIRST read, the addon writes its own dismissal straight
          // into the secret store — the race this merge exists for.
          if (ledgerReads === 1) {
            const now = JSON.parse(secrets.get(k)!);
            secrets.set(k, JSON.stringify({ ...now, 'act-addon': new Date().toISOString() }));
            return JSON.stringify(now);
          }
        }
        return secrets.get(k) ?? null;
      }),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };

    await sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
      imported: 1, importedTransactions: [importedTx],
    } as any);

    const written = JSON.parse(secrets.get('uncategorized_dismissals')!);
    expect(written).toHaveProperty('act-addon');
    // This run's own delta still applied: the aged-out entry is gone.
    expect(written).not.toHaveProperty('act-ancient');
  });

  it('logs Telegram\'s own description when the send is rejected, and still resolves', async () => {
    // `sendTelegramMessage` never throws for an API-level rejection — a bad
    // chat id, a blocked bot, and rate limiting all come back as a resolved
    // `{ ok: false }` — so this is the one failure mode the caller's own
    // exception catch can never see.
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }),
    })));
    const client: any = {
      getAddonSecret: vi.fn(async () => null),
      setAddonSecret: vi.fn(async () => {}),
    };
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
        imported: 2, importedTransactions: [importedTx],
      } as any)).resolves.toBeUndefined();
      const allLogs = logs.mock.calls.flat().join('\n');
      expect(allLogs).toMatch(/2.*not announced/i);
      expect(allLogs).toContain('Forbidden: bot was blocked by the user');
    } finally {
      logs.mockRestore();
    }
  });

  it('logs nothing when the send succeeds', async () => {
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ ok: true }) })));
    const client: any = {
      getAddonSecret: vi.fn(async () => null),
      setAddonSecret: vi.fn(async () => {}),
    };
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
        imported: 1, importedTransactions: [importedTx],
      } as any);
      const allLogs = logs.mock.calls.flat().join('\n');
      expect(allLogs).not.toMatch(/not announced|not delivered/i);
    } finally {
      logs.mockRestore();
    }
  });

  /** Shaped like `getNativeCategorizedSpending`'s rows: the note still carries the
   *  ` · <txId>` bookkeeping the read-back matches on. */
  const catRow = (activityId: string, desc: string, txId: string, categoryName: string) => ({
    activityId,
    notes: `${desc} · ${txId}`,
    amountCents: 6774,
    date: '2026-07-09',
    accountName: 'Spend (4937)',
    activityType: 'WITHDRAWAL',
    assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-g', categoryName }],
  });

  /** Sends one notice for `importedTx` and hands back the parsed sendMessage body. */
  const noticeBody = async (): Promise<any> => {
    const fetchMock = vi.fn((_url: any, _init?: any) => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const client: any = {
      getAddonSecret: vi.fn(async () => null),
      setAddonSecret: vi.fn(async () => {}),
    };
    await sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
      imported: 1, importedTransactions: [importedTx],
    } as any);
    const call = fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('sendMessage'));
    return JSON.parse((call![1] as any).body);
  };

  describe('where the import was filed', () => {
    beforeEach(() => {
      vi.mocked(getNativeUncategorizedSpending).mockReturnValue([]);
      vi.mocked(getNativeCategorizedSpending).mockReset();
      vi.mocked(getNativeCategorizedSpending).mockReturnValue([]);
    });

    afterEach(() => {
      // Left as every other describe in this file expects to find it: nothing
      // else in here has ever had a reason to stub the categorized mirror, and a
      // row leaking out of this block would put a `Recategorize` button on
      // notices those tests assert have no keyboard at all.
      vi.mocked(getNativeCategorizedSpending).mockReset();
      vi.mocked(getNativeCategorizedSpending).mockReturnValue([]);
    });

    it('names the category each imported row landed in and offers a Recategorize button', async () => {
      vi.mocked(getNativeCategorizedSpending).mockReturnValue([
        catRow('act-1', 'TRADER JOE S #628', 'tx-a', 'Groceries'),
      ] as any);
      const body = await noticeBody();
      expect(body.text).toContain('TRADER JOE S #628 — Spend (4937) → filed under Groceries');
      // Nothing is uncategorized here, so there are no dismiss rows and no
      // `Categorize these` — the Recategorize row stands on its own condition.
      expect(body.reply_markup.inline_keyboard).toEqual([
        [{ text: 'Recategorize', callback_data: 'cz:recat' }],
      ]);
    });

    it('matches the read-back by txId, never by description', async () => {
      // Two $4.23 Amazon charges in a week is normal. Matching on the description
      // would attribute one transaction's category to another — the row below has
      // the SAME description as the import and a DIFFERENT txId, so the notice
      // must say nothing about where the import was filed.
      vi.mocked(getNativeCategorizedSpending).mockReturnValue([
        catRow('act-2', 'TRADER JOE S #628', 'tx-other', 'Shopping'),
      ] as any);
      const body = await noticeBody();
      expect(body.text).not.toContain('filed under');
      expect(body).not.toHaveProperty('reply_markup');
    });

    it('picks the row with the matching txId out of same-description siblings', async () => {
      vi.mocked(getNativeCategorizedSpending).mockReturnValue([
        catRow('act-2', 'TRADER JOE S #628', 'tx-other', 'Shopping'),
        catRow('act-1', 'TRADER JOE S #628', 'tx-a', 'Groceries'),
      ] as any);
      const body = await noticeBody();
      expect(body.text).toContain('filed under Groceries');
      expect(body.text).not.toContain('Shopping');
    });

    it('reports the SPENDING category when a row carries more than one taxonomy', async () => {
      // The name the reader recognises: it is what their budgets and every /left
      // figure are about, and it is what the recategorize menu will show as the
      // row's current category — the two must not disagree.
      vi.mocked(getNativeCategorizedSpending).mockReturnValue([{
        ...catRow('act-1', 'TRADER JOE S #628', 'tx-a', 'Groceries'),
        assignments: [
          { taxonomyId: 'income_categories', categoryId: 'inc-1', categoryName: 'Reimbursement' },
          { taxonomyId: 'spending_categories', categoryId: 'cat-g', categoryName: 'Groceries' },
        ],
      }] as any);
      const body = await noticeBody();
      expect(body.text).toContain('filed under Groceries');
      expect(body.text).not.toContain('Reimbursement');
    });

    it('sends the notice anyway when the read-back cannot be done', async () => {
      // A locked database costs the ` → filed under` suffix and the button. It
      // must never cost the notice, which is the only record of what imported.
      vi.mocked(getNativeCategorizedSpending).mockImplementationOnce(() => { throw new Error('database is locked'); });
      const body = await noticeBody();
      expect(body.text).toContain('1 new transaction');
      expect(body.text).toContain('TRADER JOE S #628 — Spend (4937)');
      expect(body.text).not.toContain('filed under');
      expect(body).not.toHaveProperty('reply_markup');
    });

    it('adds the Recategorize row after the frozen dismiss and Categorize these rows', async () => {
      vi.mocked(getNativeUncategorizedSpending).mockReturnValue([uncatRow('act-9', 'VENMO PAYMENT')] as any);
      vi.mocked(getNativeCategorizedSpending).mockReturnValue([
        catRow('act-1', 'TRADER JOE S #628', 'tx-a', 'Groceries'),
      ] as any);
      const body = await noticeBody();
      expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('d:act-9');
      expect(body.reply_markup.inline_keyboard[1]).toEqual([
        { text: 'Categorize these', callback_data: CATEGORIZE_ENTRY_CALLBACK },
      ]);
      expect(body.reply_markup.inline_keyboard[2]).toEqual([
        { text: 'Recategorize', callback_data: 'cz:recat' },
      ]);
      // Frozen copy, still exactly as it was.
      expect(body.reply_markup.inline_keyboard[0][0].text).toBe('Dismiss: VENMO PAYMENT $45.16');
    });
  });

  it('sends no keyboard when nothing is uncategorized', async () => {
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([]);
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ ok: true, result: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const client: any = {
      getAddonSecret: vi.fn(async () => null),
      setAddonSecret: vi.fn(async () => {}),
    };
    await sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
      imported: 1, importedTransactions: [importedTx],
    } as any);
    const body = JSON.parse((fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('sendMessage'))![1] as any).body);
    expect(body).not.toHaveProperty('reply_markup');
    expect(body.text).not.toContain('Needs a category');
  });
});

describe('category catalog publishing', () => {
  it('publishes the catalog on a SYNC, not only when a report runs', async () => {
    // Live symptom (2026-08-07): after deploying 1.7.0 the addon showed 9
    // budget-or-spent categories with identical fallback icons and no
    // subcategories — the legacy list. The catalog was only written by the daily,
    // weekly and monthly report paths, so it did not exist until 8am, and the
    // addon's fallback carries no icon or parent.
    const secrets = new Map<string, string>();
    secrets.set('simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin');
    const client: any = {
      login: vi.fn(async () => {}),
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };
    const { WealthfolioClient } = await import('./wealthfolio.js');
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);

    await runCompanionSync();

    const written = secrets.get('report_category_catalog');
    expect(written).toBeTruthy();
    const parsed = JSON.parse(written!);
    // Carries what the fallback cannot: the icon, and a category with neither a
    // budget nor spending.
    expect(parsed.find((c: any) => c.name === 'Transportation').icon).toBe('Car');
    expect(parsed.map((c: any) => c.name)).toContain('Personal Care');
  });
});

describe('Amazon mail status publishing', () => {
  // Amazon changed its email format on 2026-08-07 and the companion silently
  // mis-filed order confirmations for two days — `ingestAmazonMail` already
  // counted `unparsed`, but the only place it went was a log line nobody
  // reads. This publishes it as an addon secret every run, so the warning
  // reaches the UI instead.
  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    vi.mocked(runSyncCore).mockClear();
    vi.mocked(ingestAmazonMail).mockClear();
  });

  const configuredSecrets = () => {
    const secrets = new Map<string, string>();
    secrets.set('simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin');
    secrets.set('amazon_config', JSON.stringify({
      enabled: true, host: 'imap.gmail.com', user: 'r@g.com', password: 'app-pass',
    }));
    return secrets;
  };

  const clientFor = async (secrets: Map<string, string>) => {
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client: any = {
      login: vi.fn(async () => {}),
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);
    return client;
  };

  it('publishes the unparsed count after a scan that found unrecognised mail', async () => {
    const secrets = configuredSecrets();
    await clientFor(secrets);
    vi.mocked(ingestAmazonMail).mockResolvedValueOnce({
      scanned: 5, added: 1, unparsed: 2, ignored: 1, pruned: 0, newLabels: [], unparsedSenders: {},
    });

    await runCompanionSync();

    const published = JSON.parse(secrets.get(AMAZON_MAIL_STATUS_SECRET_KEY)!);
    expect(published.unparsed).toBe(2);
    expect(published.asOf).toBeTruthy();
  });

  it('publishes unparsed: 0 after a clean scan, so a parser fix clears the warning', async () => {
    const secrets = configuredSecrets();
    await clientFor(secrets);
    vi.mocked(ingestAmazonMail).mockResolvedValueOnce({
      scanned: 3, added: 3, unparsed: 0, ignored: 0, pruned: 0, newLabels: [], unparsedSenders: {},
    });

    await runCompanionSync();

    const published = JSON.parse(secrets.get(AMAZON_MAIL_STATUS_SECRET_KEY)!);
    expect(published.unparsed).toBe(0);
  });

  it('does not publish when the ingest itself failed to run', async () => {
    // A connection error is not "0 problems" — publishing here would overwrite
    // a real, standing warning with a false all-clear.
    const secrets = configuredSecrets();
    await clientFor(secrets);
    vi.mocked(ingestAmazonMail).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await runCompanionSync();

    expect(secrets.has(AMAZON_MAIL_STATUS_SECRET_KEY)).toBe(false);
  });

  it('does not fail the sync when the status write itself throws', async () => {
    const secrets = configuredSecrets();
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client: any = {
      login: vi.fn(async () => {}),
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => {
        if (k === AMAZON_MAIL_STATUS_SECRET_KEY) throw new Error('write failed');
        secrets.set(k, v);
      }),
    };
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);
    vi.mocked(ingestAmazonMail).mockResolvedValueOnce({
      scanned: 1, added: 0, unparsed: 1, ignored: 0, pruned: 0, newLabels: [], unparsedSenders: {},
    });

    const result = await runCompanionSync();

    expect(result.imported).toBe(2); // the mocked runSyncCore's usual result
    expect(secrets.has(AMAZON_MAIL_STATUS_SECRET_KEY)).toBe(false);
  });
});

describe('the /categorize wiring', () => {
  /** Two childless top-level categories and one parent with a child, so both the
   *  file-immediately and the drill-down paths are reachable. */
  const CATS = [
    { id: 'cat-food', name: 'Food & Dining', parentId: null, parentName: null },
    { id: 'cat-rest', name: 'Restaurants', parentId: 'cat-food', parentName: 'Food & Dining' },
    { id: 'cat-fun', name: 'Entertainment', parentId: null, parentName: null },
  ];

  /** Shaped like `getNativeUncategorizedSpending`'s rows: the note still carries
   *  its ` · <txId>` bookkeeping, and the amount is a magnitude. */
  const uncatRow = (activityId: string, description: string) => ({
    activityId,
    wfAccountId: 'wf-a',
    notes: `${description} · TRN-${activityId}`,
    amountCents: 1200,
    date: '2026-08-08',
    accountName: 'Citi Double Cash',
  });

  const LEDGER_KEY = 'uncategorized_dismissals';

  /** The whole client surface this feature touches: the two secret methods over a
   *  Map, plus the three spending writes. `ops` records every secret read/write in
   *  order, which is what proves a write had a FRESH read behind it. */
  const clientFor = (entries: Array<[string, string]> = []) => {
    const secrets = new Map<string, string>(entries);
    const ops: string[] = [];
    const client = {
      login: vi.fn(async () => {}),
      getAddonSecret: vi.fn(async (_a: string, k: string) => {
        ops.push(`get:${k}`);
        return secrets.get(k) ?? null;
      }),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => {
        ops.push(`set:${k}`);
        secrets.set(k, v);
      }),
      assignActivityCategory: vi.fn(async () => {}),
      unassignActivityCategory: vi.fn(async () => {}),
      createCategorizationRule: vi.fn(async () => {}),
    } as any;
    return { client, secrets, ops };
  };

  type Sent = [string, any];
  const collect = () => {
    const sent: Sent[] = [];
    return { sent, reply: async (text: string, keyboard?: any) => { sent.push([text, keyboard]); } };
  };
  const labels = (kb: any): string[] => kb.inline_keyboard.flat().map((b: any) => b.text);
  const dataFor = (kb: any, label: string): string => {
    const btn = kb.inline_keyboard.flat().find((b: any) => b.text.includes(label));
    if (!btn) throw new Error(`no button matching "${label}" among: ${labels(kb).join(' | ')}`);
    return btn.callback_data;
  };
  const fakeUi = () => ({
    edit: vi.fn(async (_t: string, _k?: any) => {}),
    answer: vi.fn(async (_t?: string) => {}),
    send: vi.fn(async (_t: string, _k?: any) => {}),
  });
  const lastOf = (fn: any): Sent => fn.mock.calls.at(-1) as Sent;

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    process.env.WEALTHFOLIO_DB_PATH = '/mnt/wealthfolio.db';
    vi.mocked(existsSync).mockReturnValue(true);
    // Cleared per test, this file's convention for a module mock whose CALLS are
    // asserted: nothing resets them between tests, and the two "the database is
    // missing, so nothing was read" assertions below are about this test's calls
    // rather than every earlier test's.
    vi.mocked(getNativeUncategorizedSpending).mockClear();
    vi.mocked(getNativeCategorizedSpending).mockClear();
    vi.mocked(getNativeCategorizedSpending).mockReturnValue([]);
    vi.mocked(getNativeSpendingCategories).mockClear();
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([
      uncatRow('act-1', 'BOOK STORES'),
      uncatRow('act-2', 'VENMO PAYMENT'),
    ] as any);
    vi.mocked(getNativeSpendingCategories).mockReturnValue(CATS as any);
  });

  afterEach(() => {
    // Left as every other describe in this file expects to find it.
    vi.mocked(existsSync).mockReturnValue(true);
    delete process.env.WEALTHFOLIO_DB_PATH;
  });

  it('answers /categorize with the list and a keyboard to tap', async () => {
    const { client } = clientFor();
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client)({ command: 'categorize', args: '' }, reply);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('2 transactions need a category:');
    expect(labels(sent[0][1])).toEqual([
      'Aug 8 · BOOK STORES · $12',
      'Aug 8 · VENMO PAYMENT · $12',
      'Done',
    ]);
  });

  it('leaves an already-dismissed row out of what /categorize lists', async () => {
    const { client } = clientFor([[LEDGER_KEY, JSON.stringify({ 'act-2': '2026-08-09T00:00:00.000Z' })]]);
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client)({ command: 'categorize', args: '' }, reply);
    expect(sent[0][0]).toBe('1 transaction needs a category:');
    expect(labels(sent[0][1])).toEqual(['Aug 8 · BOOK STORES · $12', 'Done']);
  });

  it('says so rather than claiming nothing needs a category when the database is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const { client } = clientFor();
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client)({ command: 'categorize', args: '' }, reply);
    expect(sent[0][0]).toBe(
      'The companion has no database access right now, so it can\'t tell what needs a category.',
    );
    expect(vi.mocked(getNativeUncategorizedSpending)).not.toHaveBeenCalled();
  });

  it('files a tapped transaction through the spending API and republishes the status tile', async () => {
    const { client, secrets } = clientFor();
    const controller = buildCategorizeController(client);
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client, controller)({ command: 'categorize', args: '' }, reply);

    const ui = fakeUi();
    const cb = (data: string) => controller.onCallback({ data, chatId: 4242, messageId: 7 }, ui);
    await cb(dataFor(sent[0][1], 'BOOK STORES'));
    // Entertainment has no children, so tapping it files immediately.
    await cb(dataFor(lastOf(ui.edit)[1], 'Entertainment'));

    expect(client.assignActivityCategory).toHaveBeenCalledWith('act-1', 'spending_categories', 'cat-fun');
    expect(lastOf(ui.edit)[0]).toBe('Filed BOOK STORES → Entertainment.');

    // The tile the addon renders is stale the moment a row is filed, so the
    // controller's `republish` has to have run — assert the secret it writes.
    const status = JSON.parse(secrets.get(UNCATEGORIZED_STATUS_SECRET_KEY)!);
    expect(status.count).toBe(2);
    expect(status.rows.map((r: any) => r.description)).toEqual(['BOOK STORES', 'VENMO PAYMENT']);
  });

  it('drills into subcategories and files the child id', async () => {
    const { client } = clientFor();
    const controller = buildCategorizeController(client);
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client, controller)({ command: 'categorize', args: '' }, reply);
    const ui = fakeUi();
    const cb = (data: string) => controller.onCallback({ data, chatId: 4242, messageId: 7 }, ui);
    await cb(dataFor(sent[0][1], 'BOOK STORES'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Food & Dining'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Restaurants'));
    expect(client.assignActivityCategory).toHaveBeenCalledWith('act-1', 'spending_categories', 'cat-rest');
  });

  it('undoes a filing through the taxonomy-scoped delete', async () => {
    const { client } = clientFor();
    const controller = buildCategorizeController(client);
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client, controller)({ command: 'categorize', args: '' }, reply);
    const ui = fakeUi();
    const cb = (data: string) => controller.onCallback({ data, chatId: 4242, messageId: 7 }, ui);
    // What the row is filed under AFTER the tap below files it. The module mock
    // has no notion of writes, so the post-filing state is stated up front; only
    // the Undo's verification reads it, and it declines rather than un-filing if
    // the category is not the one this menu set.
    vi.mocked(getNativeCategorizedSpending).mockReturnValue([{
      activityId: 'act-1',
      notes: 'BOOK STORES · TRN-act-1',
      amountCents: 1200,
      date: '2026-08-08',
      accountName: 'Citi Double Cash',
      activityType: 'WITHDRAWAL',
      assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-fun', categoryName: 'Entertainment' }],
    }] as any);
    await cb(dataFor(sent[0][1], 'BOOK STORES'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Entertainment'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Undo'));
    expect(client.unassignActivityCategory).toHaveBeenCalledWith('act-1', 'spending_categories');
  });

  it('creates a rule from a filed row at priority 50 in the spending taxonomy', async () => {
    const { client } = clientFor();
    const controller = buildCategorizeController(client);
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client, controller)({ command: 'categorize', args: '' }, reply);
    const ui = fakeUi();
    const cb = (data: string) => controller.onCallback({ data, chatId: 4242, messageId: 7 }, ui);
    await cb(dataFor(sent[0][1], 'BOOK STORES'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Entertainment'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Make this a rule'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Create rule'));
    expect(client.createCategorizationRule).toHaveBeenCalledWith({
      name: 'Telegram: BOOK STORES',
      pattern: 'BOOK STORES',
      categoryId: 'cat-fun',
      taxonomyId: 'spending_categories',
      priority: 50,
    });
  });

  describe('writeLedgerMerged', () => {
    it('re-reads the ledger immediately before writing, so a third party\'s dismissal survives', async () => {
      // THE 1.10.1 bug, in the shape this dep can reintroduce it: passing the
      // controller's `base` snapshot as `persisted` collapses the merge into a
      // whole-object write and erases whatever the other host recorded in
      // between. Two reads are the only thing that makes the merge mean anything.
      const { client, secrets } = clientFor([
        [LEDGER_KEY, JSON.stringify({ 'act-earlier': '2026-08-09T00:00:00.000Z' })],
      ]);
      const deps = buildCategorizeDeps(client);

      const base = await deps.readLedger();
      // …and now the addon (or the notice's own Dismiss button) writes its own
      // entry, after the controller read but before the menu's write.
      secrets.set(LEDGER_KEY, JSON.stringify({ ...base, 'act-thirdparty': '2026-08-10T00:00:00.000Z' }));

      await deps.writeLedgerMerged(base, { ...base, 'act-menu': '2026-08-10T01:00:00.000Z' });

      const written = JSON.parse(secrets.get(LEDGER_KEY)!);
      expect(Object.keys(written).sort()).toEqual(['act-earlier', 'act-menu', 'act-thirdparty']);
      expect(written['act-earlier']).toBe('2026-08-09T00:00:00.000Z');
    });

    it('replays a REMOVAL as a delta, leaving a third party\'s entry alone', async () => {
      const { client, secrets } = clientFor([
        [LEDGER_KEY, JSON.stringify({ 'act-menu': '2026-08-10T01:00:00.000Z' })],
      ]);
      const deps = buildCategorizeDeps(client);
      const base = await deps.readLedger();
      secrets.set(LEDGER_KEY, JSON.stringify({ ...base, 'act-thirdparty': '2026-08-10T00:00:00.000Z' }));

      const next = { ...base };
      delete (next as any)['act-menu'];
      await deps.writeLedgerMerged(base, next);

      expect(Object.keys(JSON.parse(secrets.get(LEDGER_KEY)!))).toEqual(['act-thirdparty']);
    });

    it('prunes entries too old to matter while it is there', async () => {
      const ancient = new Date(Date.now() - 61 * 86400_000).toISOString();
      const { client, secrets } = clientFor([[LEDGER_KEY, JSON.stringify({ 'act-ancient': ancient })]]);
      const deps = buildCategorizeDeps(client);
      const base = await deps.readLedger();
      await deps.writeLedgerMerged(base, { ...base, 'act-menu': new Date().toISOString() });
      expect(Object.keys(JSON.parse(secrets.get(LEDGER_KEY)!))).toEqual(['act-menu']);
    });

    it('survives a ledger secret that is not JSON, treating it as empty', async () => {
      const { client, secrets } = clientFor([[LEDGER_KEY, 'not json at all']]);
      const deps = buildCategorizeDeps(client);
      await expect(deps.readLedger()).resolves.toEqual({});
      await deps.writeLedgerMerged({}, { 'act-menu': '2026-08-10T01:00:00.000Z' });
      expect(JSON.parse(secrets.get(LEDGER_KEY)!)).toEqual({ 'act-menu': '2026-08-10T01:00:00.000Z' });
    });

    it('keeps a concurrent dismissal when the menu\'s Keep uncategorized button is tapped', async () => {
      // The same guarantee, end to end through the controller: the fresh read
      // sits immediately before the write, with nothing in between.
      const { client, secrets, ops } = clientFor();
      const controller = buildCategorizeController(client);
      const { sent, reply } = collect();
      await buildTelegramCommandHandler(client, controller)({ command: 'categorize', args: '' }, reply);
      const ui = fakeUi();
      const cb = (data: string) => controller.onCallback({ data, chatId: 4242, messageId: 7 }, ui);
      await cb(dataFor(sent[0][1], 'BOOK STORES'));

      // From here on, the FIRST ledger read is the controller's own; the addon
      // writes its dismissal straight afterwards, which only a second read can see.
      let reads = 0;
      client.getAddonSecret.mockImplementation(async (_a: string, k: string) => {
        if (k !== LEDGER_KEY) { ops.push(`get:${k}`); return secrets.get(k) ?? null; }
        ops.push(`get:${k}`);
        reads += 1;
        const current = secrets.get(k) ?? '{}';
        if (reads === 1) {
          secrets.set(k, JSON.stringify({ ...JSON.parse(current), 'act-addon': '2026-08-10T00:00:00.000Z' }));
          return current;
        }
        return secrets.get(k) ?? null;
      });

      const mark = ops.length;
      await cb(dataFor(lastOf(ui.edit)[1], 'Keep uncategorized'));

      const written = JSON.parse(secrets.get(LEDGER_KEY)!);
      expect(Object.keys(written).sort()).toEqual(['act-1', 'act-addon']);
      // Two reads, back to back, then the write: nothing else touches the ledger
      // between the read the merge is based on and the write itself.
      expect(ops.slice(mark, mark + 3)).toEqual([`get:${LEDGER_KEY}`, `get:${LEDGER_KEY}`, `set:${LEDGER_KEY}`]);
      expect(lastOf(ui.edit)[0]).toBe('BOOK STORES will stay uncategorized.');
    });
  });

  describe('/newrule', () => {
    const runNewRule = async (args: string, controller?: any) => {
      const { client } = clientFor();
      const { sent, reply } = collect();
      await buildTelegramCommandHandler(client, controller ?? buildCategorizeController(client))(
        { command: 'newrule', args }, reply,
      );
      return { sent, client };
    };

    it('answers one usage line for anything that does not parse', async () => {
      for (const args of ['', 'just some text', '= groceries', 'trader joes =']) {
        const { sent } = await runNewRule(args);
        expect(sent).toEqual([['Usage: /newrule trader joes = groceries', undefined]]);
      }
    });

    it('asks which one when the category query is ambiguous', async () => {
      vi.mocked(getNativeSpendingCategories).mockReturnValue([
        { id: 'c1', name: 'Home', parentId: null, parentName: null },
        { id: 'c2', name: 'Home Improvement', parentId: null, parentName: null },
      ] as any);
      const { sent } = await runNewRule('lowes = hom');
      expect(sent[0][0]).toBe('Which one? Home, Home Improvement');
    });

    it('says nothing starts with the query, pointing at a list that includes subcategories', async () => {
      // NOT "/left lists them all": `/left` shows budgeted PARENTS, and this
      // command resolves the whole tree, so a mistyped subcategory can never
      // appear in the list the default pointer names.
      const { sent } = await runNewRule('trader joes = xyzzy');
      expect(sent[0][0]).toBe(
        'No category starts with "xyzzy". '
        + 'Subcategories count too — Wealthfolio\'s category settings list them all.',
      );
    });

    it('names the PARENT in the preview, so two same-named children cannot be confused', async () => {
      // `resolveCategoryQuery` matches on name over the FLAT tree, and
      // Wealthfolio's presets ship duplicate leaf names. The preview is the only
      // thing between a typo and a rule that sweeps rows into the wrong
      // category, so it has to say which `Restaurants` it means.
      const { sent } = await runNewRule('trader joes = restaur');
      expect(sent[0][0]).toBe(
        'Create this rule?\n'
        + 'Descriptions containing "trader joes" → Restaurants (Food & Dining)\n'
        + 'It will also file any other uncategorized transactions that match, now and on every future import. '
        + 'Already-categorized transactions are never touched.',
      );
      expect(labels(sent[0][1])).toEqual(['Create rule', 'Cancel']);
    });

    it('creates the rule when the preview is confirmed', async () => {
      const { client } = clientFor();
      const controller = buildCategorizeController(client);
      const { sent, reply } = collect();
      await buildTelegramCommandHandler(client, controller)({ command: 'newrule', args: 'trader joes = restaur' }, reply);
      const ui = fakeUi();
      await controller.onCallback(
        { data: dataFor(sent[0][1], 'Create rule'), chatId: 4242, messageId: 7 },
        ui,
      );
      expect(client.createCategorizationRule).toHaveBeenCalledWith({
        name: 'Telegram: trader joes',
        pattern: 'trader joes',
        categoryId: 'cat-rest',
        taxonomyId: 'spending_categories',
        priority: 50,
      });
      expect(lastOf(ui.edit)[0]).toBe(
        'Rule created — future matches will file automatically under Restaurants (Food & Dining).',
      );
    });

    it('pins the rule priority at 50 — higher wins upstream, so a tapped rule yields', async () => {
      // Verified against upstream source, not inferred:
      // `crates/spending/src/categorization_rules/matcher.rs` picks
      // `rule.priority > current.priority`, with a unit test named
      // `higher_priority_wins`. HIGHER WINS. 50 therefore loses to a hand-tuned
      // rule (60) AND to the presets Wealthfolio ships (70–90) — the conservative
      // direction for something created by one tap. Upstream's ordering lives in
      // another repo and is not tested here; the NUMBER is, so it cannot drift
      // silently and quietly start outranking deliberate rules.
      const { client } = clientFor();
      const rules: Array<{ priority: number }> = [];
      client.createCategorizationRule.mockImplementation(async (r: any) => { rules.push(r); });
      const controller = buildCategorizeController(client);
      const { sent, reply } = collect();
      await buildTelegramCommandHandler(client, controller)({ command: 'newrule', args: 'trader joes = restaur' }, reply);
      await controller.onCallback(
        { data: dataFor(sent[0][1], 'Create rule'), chatId: 4242, messageId: 7 },
        fakeUi(),
      );
      expect(rules.map((r) => r.priority)).toEqual([50]);
    });

    it('says the same thing when the category read throws rather than answering []', async () => {
      // A locked or corrupt database is another way of not being able to look the
      // categories up. Unwrapped, it would surface as the listener's generic
      // "Something went wrong running that command", which names neither the
      // cause nor anything the reader can do about it.
      vi.mocked(getNativeSpendingCategories).mockImplementation(() => { throw new Error('database is locked'); });
      const { sent, client } = await runNewRule('trader joes = groceries');
      expect(sent[0][0]).toBe(
        'The companion has no database access right now, so it can\'t look up your categories.',
      );
      expect(client.createCategorizationRule).not.toHaveBeenCalled();
    });

    it('says the database is unreachable instead of "no category starts with"', async () => {
      // `getNativeSpendingCategories` answers [] for a path that is not there, so
      // every query would otherwise resolve to a confident "no such category".
      vi.mocked(existsSync).mockReturnValue(false);
      const { sent } = await runNewRule('trader joes = groceries');
      expect(sent[0][0]).toBe(
        'The companion has no database access right now, so it can\'t look up your categories.',
      );
      expect(vi.mocked(getNativeSpendingCategories)).not.toHaveBeenCalled();
    });
  });

  it('routes menu callbacks, and the notice\'s Categorize these opens a fresh message', async () => {
    const { client } = clientFor();
    const deps = buildTelegramListenerDeps(client);
    expect(deps.onMenuCallback).toBeTypeOf('function');
    const ui = fakeUi();
    await deps.onMenuCallback!({ data: CATEGORIZE_ENTRY_CALLBACK, chatId: 4242, messageId: 7 }, ui);
    // A new message, never an edit of the import notice the button sits on.
    expect(lastOf(ui.send)[0]).toBe('2 transactions need a category:');
    expect(ui.edit).not.toHaveBeenCalled();
  });

  it('reaches the menu from /categorize typed into the configured chat', async () => {
    // Through the listener's own dispatch: parseCommand → onCommand → controller.
    const { client } = clientFor();
    const deps = buildTelegramListenerDeps(client);
    const parsed = parseCommand('/categorize');
    const { sent, reply } = collect();
    await deps.onCommand(parsed!, reply);
    expect(sent[0][0]).toBe('2 transactions need a category:');
  });
});

describe('the /recategorize wiring', () => {
  const CATS = [
    { id: 'cat-food', name: 'Food & Dining', parentId: null, parentName: null },
    { id: 'cat-rest', name: 'Restaurants', parentId: 'cat-food', parentName: 'Food & Dining' },
    { id: 'cat-fun', name: 'Entertainment', parentId: null, parentName: null },
  ];

  /** Shaped like `getNativeCategorizedSpending`'s rows — the note keeps its
   *  ` · <txId>` bookkeeping, which is what the import scope matches on. */
  const catRow = (activityId: string, description: string, txId: string, categoryName: string) => ({
    activityId,
    notes: `${description} · ${txId}`,
    amountCents: 1200,
    date: '2026-08-08',
    accountName: 'Citi Double Cash',
    activityType: 'WITHDRAWAL',
    assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-fun', categoryName }],
  });

  const clientFor = () => ({
    login: vi.fn(async () => {}),
    getAddonSecret: vi.fn(async () => null),
    setAddonSecret: vi.fn(async () => {}),
    assignActivityCategory: vi.fn(async () => {}),
    unassignActivityCategory: vi.fn(async () => {}),
  } as any);

  const collect = () => {
    const sent: Array<[string, any]> = [];
    return { sent, reply: async (text: string, keyboard?: any) => { sent.push([text, keyboard]); } };
  };
  const labels = (kb: any): string[] => kb.inline_keyboard.flat().map((b: any) => b.text);
  const fakeUi = () => ({
    edit: vi.fn(async (_t: string, _k?: any) => {}),
    answer: vi.fn(async (_t?: string) => {}),
    send: vi.fn(async (_t: string, _k?: any) => {}),
  });

  const runCommand = async (client: any, args = '') => {
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client)({ command: 'recategorize', args }, reply);
    return sent;
  };

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    process.env.WEALTHFOLIO_DB_PATH = '/mnt/wealthfolio.db';
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(getNativeCategorizedSpending).mockReset();
    vi.mocked(getNativeCategorizedSpending).mockReturnValue([
      catRow('act-1', 'TRADER JOE S #628', 'tx-a', 'Groceries'),
      catRow('act-2', 'VENMO PAYMENT', 'tx-b', 'Entertainment'),
    ] as any);
    vi.mocked(getNativeSpendingCategories).mockReturnValue(CATS as any);
    // Boot state: no import notice has been sent in this process yet.
    rememberImportScope(null);
  });

  afterEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
    delete process.env.WEALTHFOLIO_DB_PATH;
    // Restored like the two above rather than relying on this describe being last
    // in the file: a categorized row leaking out of here would put a
    // `Recategorize` button on notices other tests assert have no keyboard.
    vi.mocked(getNativeCategorizedSpending).mockReset();
    vi.mocked(getNativeCategorizedSpending).mockReturnValue([]);
  });

  it('answers /recategorize with what is already filed, each row naming its category', async () => {
    const sent = await runCommand(clientFor());
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('Recategorize — tap a transaction');
    expect(labels(sent[0][1])).toEqual([
      'Aug 8 · TRADER JOE S #628 · $12 · Groceries',
      'Aug 8 · VENMO PAYMENT · $12 · Entertainment',
      'Done',
    ]);
  });

  it('narrows the list to the argument', async () => {
    const sent = await runCommand(clientFor(), 'venmo');
    expect(labels(sent[0][1])).toEqual(['Aug 8 · VENMO PAYMENT · $12 · Entertainment', 'Done']);
  });

  it('treats a whitespace-only argument as no filter at all', async () => {
    // The handler cannot tell `/recategorize` from `/recategorize `, and
    // "nothing matches" for an empty search would be a lie.
    const sent = await runCommand(clientFor(), '   ');
    expect(labels(sent[0][1])).toHaveLength(3);
  });

  it('says it cannot look up transactions when the database is missing', async () => {
    // `getNativeCategorizedSpending` answers [] for a path that is not there, so
    // without the guard this would read as "nothing is categorized".
    vi.mocked(existsSync).mockReturnValue(false);
    const sent = await runCommand(clientFor());
    expect(sent[0][0]).toBe(
      'The companion has no database access right now, so it can\'t look up your transactions.',
    );
    expect(vi.mocked(getNativeCategorizedSpending)).not.toHaveBeenCalled();
  });

  describe('the import notice\'s Recategorize button', () => {
    const sendNotice = async (client: any, txIds: string[]) => {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ ok: true }) })));
      await sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
        imported: txIds.length,
        importedTransactions: txIds.map((txId) => ({
          txId, sfAccountId: 'sfin-1', description: 'TRADER JOE S #628', amountCents: 1200,
          currency: 'USD', accountName: 'Citi Double Cash', activityType: 'WITHDRAWAL',
          pending: false, inTransit: false,
        })),
      } as any);
    };

    it('opens a FRESH message scoped to the transactions that import brought in', async () => {
      const client = clientFor();
      await sendNotice(client, ['tx-a']);
      const deps = buildTelegramListenerDeps(client);
      const ui = fakeUi();
      await deps.onMenuCallback!({ data: 'cz:recat', chatId: 4242, messageId: 7 }, ui);
      // A new message, never an edit: the notice lists what imported and carries
      // its own dismiss buttons, and rendering the menu over it would destroy it.
      expect(ui.edit).not.toHaveBeenCalled();
      expect(ui.send.mock.calls.at(-1)![0]).toBe('Recategorize — tap a transaction');
      expect(labels(ui.send.mock.calls.at(-1)![1])).toEqual([
        'Aug 8 · TRADER JOE S #628 · $12 · Groceries',
        'Done',
      ]);
      // The spinner has to stop, and the new message is the only feedback.
      expect(ui.answer).toHaveBeenCalledWith();
    });

    it('falls back to the recent list when a restart lost what the notice was about', async () => {
      // `null` scope: the companion restarted, the memory died with it. An empty
      // screen would read as "that import filed nothing".
      rememberImportScope(null);
      const deps = buildTelegramListenerDeps(clientFor());
      const ui = fakeUi();
      await deps.onMenuCallback!({ data: 'cz:recat', chatId: 4242, messageId: 7 }, ui);
      expect(ui.send.mock.calls.at(-1)![0]).toBe('Recategorize — tap a transaction');
      expect(labels(ui.send.mock.calls.at(-1)![1])).toHaveLength(3);
    });

    it('works with no messageId at all, which the listener cannot promise', async () => {
      // The listener types `messageId` as `number` but lifts it off an untrusted
      // payload (`cq?.message?.message_id`), so `undefined` arrives under that type.
      await sendNotice(clientFor(), ['tx-a']);
      const deps = buildTelegramListenerDeps(clientFor());
      const ui = fakeUi();
      await deps.onMenuCallback!({ data: 'cz:recat', chatId: 4242, messageId: undefined as any }, ui);
      expect(ui.send.mock.calls.at(-1)![0]).toBe('Recategorize — tap a transaction');
      expect(ui.answer).toHaveBeenCalled();
    });

    it('never falls through to "that menu expired" — no session exists yet', async () => {
      await sendNotice(clientFor(), ['tx-a']);
      const deps = buildTelegramListenerDeps(clientFor());
      const ui = fakeUi();
      await deps.onMenuCallback!({ data: 'cz:recat', chatId: 4242, messageId: 7 }, ui);
      expect(ui.answer).not.toHaveBeenCalledWith('That menu expired — send /categorize again.');
    });

    it('puts a database failure on the fresh message as text, not as an exception', async () => {
      // Anticipated failures come back from the menu as a SCREEN, so this never
      // reaches the route's catch — it is the controller's own guard, seen from
      // this entry point. Named for what it actually proves.
      vi.mocked(getNativeSpendingCategories).mockImplementationOnce(() => { throw new Error('database is locked'); });
      const deps = buildTelegramListenerDeps(clientFor());
      const ui = fakeUi();
      await deps.onMenuCallback!({ data: 'cz:recat', chatId: 4242, messageId: 7 }, ui);
      expect(ui.send.mock.calls.at(-1)![0]).toBe('Couldn\'t look up your transactions — database is locked');
      expect(ui.answer).toHaveBeenCalledWith();
    });

    it('still clears the spinner when the fresh message itself cannot be delivered', async () => {
      // The one failure that DOES reach this route's catch: `ui.send` rejecting is
      // outside every guard the controller has. The listener's own `ui.send`
      // cannot reject — it catches internally — so this is a dep breaking its
      // contract, and the cost of not handling it is the real point: the
      // rejection would escape into the listener, which deliberately sends
      // nothing for a thrown menu tap, leaving the tapped button spinning until
      // Telegram gave up on it. The answer below is the only thing that stops
      // that, so it has to survive a throw on the way to it.
      const deps = buildTelegramListenerDeps(clientFor());
      const ui = fakeUi();
      ui.send.mockRejectedValueOnce(new Error('Telegram unreachable'));
      await expect(
        deps.onMenuCallback!({ data: 'cz:recat', chatId: 4242, messageId: 7 }, ui),
      ).resolves.toBeUndefined();
      // No toast, exactly as on the success path: there is no screen to explain,
      // and inventing one here would contradict a message that may yet arrive.
      expect(ui.answer).toHaveBeenCalledWith();
    });
  });
});
