import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { maskUrl, validateStartupEnv, runCompanionSync, resolvePassword } from './index.js';
import { runSyncCore } from '../../shared/sync-core.js';

vi.mock('../../shared/sync-core.js', () => ({
  runSyncCore: vi.fn(async () => ({ imported: 2, skipped: 1, errors: [] })),
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
