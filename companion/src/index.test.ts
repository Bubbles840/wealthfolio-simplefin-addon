import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maskUrl, validateStartupEnv, runCompanionSync, resolvePassword, sendDailyTelegramReport, sendWeeklyTelegramReport, sendMonthlyTelegramReport, previousYearMonth, sendImportNotice, readBudgetSnapshot, composeDailyDigestMessage, runCompanionSyncExclusive } from './index.js';
import { runSyncCore } from '../../shared/sync-core.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending } from './sqlite-native.js';
import { ingestAmazonMail } from './amazon-mail.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY } from '../../shared/status-keys.js';
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
  prunedDuplicates: [],
};

vi.mock('../../shared/sync-core.js', async (importOriginal) => ({
  // The real module's parsers (descriptionFromComment etc.) stay real; only the
  // sync engine itself is faked.
  ...(await importOriginal<object>()),
  runSyncCore: vi.fn(async () => ({ imported: 2, skipped: 1, errors: [], prunedDuplicates: [], importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [] })),
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [],
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
    vi.mocked(runSyncCore).mockResolvedValueOnce({ imported: 0, skipped: 0, errors: [], prunedDuplicates: [], largeTransactionAlerts: [], balanceDriftAlerts: [], stuckTransferAlerts: [] });

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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
      largeTransactionAlerts: [alert],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false, description: 'Too Many Requests' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(JSON.parse(secrets.get('pending_large_tx_alerts')!)).toEqual([alert]);

    // Next sync reports nothing new, but the queued alert must still go out.
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], largeTransactionAlerts: [], balanceDriftAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], importedTransactions: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
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
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
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
    imported: 0, skipped: 0, errors: [], prunedDuplicates: [], stuckTransferAlerts: [],
    largeTransactionAlerts: [], balanceDriftAlerts: [], prunedDuplicates: [],
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

  it('titles the digest as daily and headlines what is left this week', async () => {
    // Mocked month spend/budgets: Groceries 200/800, Dining 550/500; mocked
    // week spend: Groceries 50, Dining 100. Tuesday 2026-07-14, so the week
    // began Monday the 13th and July has 31 days:
    //   daysFromWeekStartToMonthEnd = 31 - 13 + 1 = 19
    //   Groceries: spentBeforeWeek 150 -> budgetAtWeekStart 650
    //              envelope = 650 * 7 / 19 = 239.47, left = 189.47
    //   Dining:    over budget for the month by 50
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
      expect(text).toContain('_left to spend this week_');
      expect(text).not.toContain('Weekly Spending Update');
      expect(text).toContain('Groceries  *$189.47*');
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

    it('logs a rejected send instead of assuming it arrived', async () => {
      // `sendTelegramMessage` reports an API-level failure — a 400 from
      // unbalanced Markdown being the one this section could plausibly cause —
      // by RESOLVING `{ ok: false }`, not throwing.
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: false, description: "can't parse entities" }) })));
      try {
        await expect(sendWeeklyTelegramReport(weeklyClient())).resolves.toBeUndefined();
        expect(logs.mock.calls.flat().join('\n')).toContain('Failed to send weekly Telegram report');
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

  it('logs a rejected send instead of discarding the result', async () => {
    // `sendTelegramMessage` reports an API-level failure by RESOLVING
    // `{ ok: false }` — a 400 from malformed Markdown, a bad token, a rate limit.
    // Discarding it would lose the wrap-up silently, and it is only produced once
    // a month.
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ ok: false, description: "can't parse entities" }),
    })));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await expect(sendMonthlyTelegramReport(client)).resolves.toBeUndefined();
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('Failed to send monthly Telegram report');
      expect(logged).toContain("can't parse entities");
    } finally {
      logSpy.mockRestore();
    }
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

  it('lists the imports, sweeps uncategorized minus dismissed, and honours a button press from THIS poll', async () => {
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([
      uncatRow('act-1', 'VENMO PAYMENT'),
      uncatRow('act-old', 'DISMISSED EARLIER'),
      uncatRow('act-9', 'DISMISSED BY BUTTON'),
    ]);
    const fetchMock = vi.fn((url: any) => {
      if (String(url).includes('getUpdates')) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: [
          { update_id: 60, callback_query: { id: 'cb', data: 'd:act-9' } },
        ] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const secrets = new Map<string, string>([
      ['uncategorized_dismissals', JSON.stringify({ 'act-old': '2026-07-20T00:00:00Z' })],
      ['telegram_update_offset', '41'],
    ]);
    const client: any = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };

    await sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
      imported: 1, importedTransactions: [importedTx],
    } as any);

    const sendCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('sendMessage'));
    expect(sendCall).toBeTruthy();
    const body = JSON.parse((sendCall![1] as any).body);
    expect(body.text).toContain('1 new transaction');
    expect(body.text).toContain('TRADER JOE S');
    expect(body.text).toContain('VENMO PAYMENT');
    // Dismissed rows are out — including the one dismissed by the button press
    // this very poll just collected.
    expect(body.text).not.toContain('DISMISSED EARLIER');
    expect(body.text).not.toContain('DISMISSED BY BUTTON');
    // One dismiss button per SHOWN needs-category row.
    expect(body.reply_markup.inline_keyboard).toHaveLength(1);
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('d:act-1');
    // The press is recorded and the poll offset advanced past its update.
    expect(JSON.parse(secrets.get('uncategorized_dismissals')!)).toHaveProperty('act-9');
    expect(secrets.get('telegram_update_offset')).toBe('61');
    // The getUpdates call resumed from the stored offset.
    expect(String(fetchMock.mock.calls.find((c) => String(c[0]).includes('getUpdates'))![0])).toContain('offset=41');
  });

  it('does not erase a dismissal the addon wrote after this run\'s first read', async () => {
    // The addon writes this same secret, and there is no compare-and-swap. This
    // run reads the ledger BEFORE the Telegram poll (a seconds-long network
    // round trip), so a dismissal the addon makes during that poll must still
    // survive this run's own write at the end — the write has to merge onto
    // whatever is persisted right now, not overwrite with the stale first read.
    // The poll itself collects a button press for 'act-1', so this run DOES
    // have its own change to write (a no-op run writes nothing, and would prove
    // nothing about the merge).
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([
      uncatRow('act-1', 'VENMO PAYMENT'),
    ]);
    const secrets = new Map<string, string>([
      ['uncategorized_dismissals', JSON.stringify({ 'act-old': '2026-07-20T00:00:00Z' })],
    ]);
    const fetchMock = vi.fn((url: any) => {
      if (String(url).includes('getUpdates')) {
        // While this poll is "in flight", the addon writes its own dismissal
        // straight into the secret store — simulated by mutating `secrets`
        // before the poll's response resolves.
        secrets.set('uncategorized_dismissals', JSON.stringify({
          ...JSON.parse(secrets.get('uncategorized_dismissals')!),
          'act-addon': '2026-08-09T00:00:00.000Z',
        }));
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: [
          { update_id: 60, callback_query: { id: 'cb', data: 'd:act-1' } },
        ] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client: any = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };

    await sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
      imported: 1, importedTransactions: [importedTx],
    } as any);

    const written = JSON.parse(secrets.get('uncategorized_dismissals')!);
    expect(written).toHaveProperty('act-addon');
    expect(written).toHaveProperty('act-old');
    expect(written).toHaveProperty('act-1');
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
