import { describe, it, expect, vi } from 'vitest';
import { syncHostFor } from './rest-host.js';

const client = (version: string | null | Error) => ({
  getAppVersion: vi.fn(async () => {
    if (version instanceof Error) throw version;
    return version;
  }),
  setAddonSecret: vi.fn(async () => {}),
});

describe('the companion\'s sync host knows what this Wealthfolio takes', () => {
  it.each([
    ['3.10.0', true],
    ['3.11.2', true],
    ['3.9.1', false],
  ])('on Wealthfolio %s a card bookkeeping outflow is a TRANSFER_OUT: %s — and the version is published for the add-on', async (version, takes) => {
    const c = client(version);
    const { host, wealthfolioVersion } = await syncHostFor(c as any, '/mnt/wealthfolio.db');
    expect(host.capabilities).toEqual({ readsSourceGroupId: true, cardTransferOut: takes });
    expect(wealthfolioVersion).toBe(version);
    expect(c.setAddonSecret).toHaveBeenCalledWith('simplefin-sync', 'wealthfolio_version', version);
  });

  it('treats a version it cannot read as older, publishes nothing, and never stops the sync', async () => {
    for (const version of [null, new Error('fetch failed')]) {
      const c = client(version);
      const { host, wealthfolioVersion } = await syncHostFor(c as any);
      expect(host.capabilities.cardTransferOut).toBe(false);
      expect(wealthfolioVersion).toBeNull();
      expect(c.setAddonSecret).not.toHaveBeenCalled();
    }
    const failingPublish = { ...client('3.10.0'), setAddonSecret: vi.fn(async () => { throw new Error('500'); }) };
    expect((await syncHostFor(failingPublish as any)).host.capabilities.cardTransferOut).toBe(true);
  });
});
