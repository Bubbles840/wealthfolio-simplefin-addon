import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maskUrl, validateStartupEnv, runCompanionSync, resolvePassword, sendDailyTelegramReport, sendWeeklyTelegramReport } from './index.js';
import { runSyncCore } from '../../shared/sync-core.js';

vi.mock('../../shared/sync-core.js', () => ({
  runSyncCore: vi.fn(async () => ({ imported: 2, skipped: 1, errors: [], stuckTransferAlerts: [] })),
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
      stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 130000, currency: 'USD' }],
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
      stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'AMAZON *MKTPLACE ↔ Payment_Refund', amountCents: 500, currency: 'USD' }],
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
    vi.mocked(runSyncCore).mockResolvedValueOnce({ imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [] });

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
      stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 50000, currency: 'USD' }],
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
      stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 50000, currency: 'USD' }],
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
      stuckTransferAlerts: [
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
      stuckTransferAlerts: [
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

  it('titles the digest as daily and shows monthly remaining with a weekly pace', async () => {
    // Mocked spending/budgets: Groceries 200/800, Dining 550/500.
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
    expect(text).not.toContain('Weekly Spending Update');
    expect(text).toContain('*$600.00 left this month*');
    expect(text).toContain('/wk pace');
    expect(text).toContain('🚨 *$50.00 over budget* this month');
    expect(text).not.toContain('left this week');
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
    expect(text).toContain('$550.00 remaining');
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
