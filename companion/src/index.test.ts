import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maskUrl, validateStartupEnv, runCompanionSync, resolvePassword, sendDailyTelegramReport, sendWeeklyTelegramReport } from './index.js';
import { runSyncCore } from '../../shared/sync-core.js';
import { getNativeWealthfolioSpendingBetween } from './sqlite-native.js';

vi.mock('../../shared/sync-core.js', () => ({
  runSyncCore: vi.fn(async () => ({ imported: 2, skipped: 1, errors: [], largeTransactionAlerts: [], stuckTransferAlerts: [] })),
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
  getNativeWealthfolioSpending: vi.fn(() => ({ Groceries: 200, Dining: 550 })),
  // Week-scoped spend: a subset of the month totals above.
  getNativeWealthfolioSpendingBetween: vi.fn(() => ({ Groceries: 50, Dining: 100 })),
  getNativeWealthfolioBudgets: vi.fn(() => ({ Groceries: 800, Dining: 500 })),
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
      imported: 0, skipped: 0, errors: [],
      largeTransactionAlerts: [], stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 130000, currency: 'USD' }],
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
      imported: 0, skipped: 0, errors: [],
      largeTransactionAlerts: [], stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'AMAZON *MKTPLACE ↔ Payment_Refund', amountCents: 500, currency: 'USD' }],
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
    vi.mocked(runSyncCore).mockResolvedValueOnce({ imported: 0, skipped: 0, errors: [], largeTransactionAlerts: [], stuckTransferAlerts: [] });

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
      imported: 0, skipped: 0, errors: [],
      largeTransactionAlerts: [], stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 50000, currency: 'USD' }],
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
      imported: 0, skipped: 0, errors: [],
      largeTransactionAlerts: [], stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 50000, currency: 'USD' }],
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
      imported: 0, skipped: 0, errors: [],
      largeTransactionAlerts: [], stuckTransferAlerts: [
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
      imported: 0, skipped: 0, errors: [],
      largeTransactionAlerts: [], stuckTransferAlerts: [
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
      imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [],
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
      imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [], largeTransactionAlerts: [alert],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false, description: 'Too Many Requests' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(JSON.parse(secrets.get('pending_large_tx_alerts')!)).toEqual([alert]);

    // Next sync reports nothing new, but the queued alert must still go out.
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [], largeTransactionAlerts: [],
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
      imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [],
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
      imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [],
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
      imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [], largeTransactionAlerts: [alert],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      expect(text).toContain('☀️ *Daily Spending Check*');
      expect(text).toContain('_left to spend this week_');
      expect(text).not.toContain('Weekly Spending Update');
      expect(text).toContain('🛒 Groceries  *$189.47*');
      expect(text).toContain('🍽️ Dining  🚨 *$50 over* for the month');
      // One month-context line at the end, 18 days left counting today.
      expect(text).toContain('💰 $550 left this month · 18 days to go');
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
    expect(text).toContain('💰 *$550 left* this month');
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
});
