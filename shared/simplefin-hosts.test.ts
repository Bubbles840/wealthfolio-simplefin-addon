import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ADDON_PROVIDER_HOSTS,
  addonHostEntriesFor,
  isSimplefinProviderHost,
  requireSimplefinProviderHost,
} from './simplefin-hosts.js';

describe('isSimplefinProviderHost', () => {
  it('accepts SimpleFin Bridge and Lunch Flow, the domain and its subdomains (#25)', () => {
    for (const host of ['bridge.simplefin.org', 'beta-bridge.simplefin.org', 'simplefin.org', 'www.lunchflow.app', 'lunchflow.app', 'api.lunchflow.app']) {
      expect(isSimplefinProviderHost(host), host).toBe(true);
    }
  });

  it('refuses look-alikes', () => {
    for (const host of ['evil.com', 'lunchflow.app.evil.com', 'evillunchflow.app', 'simplefin.org.evil.com', 'notsimplefin.org', 'lunchflow.com']) {
      expect(isSimplefinProviderHost(host), host).toBe(false);
    }
  });
});

describe('requireSimplefinProviderHost', () => {
  it('names both providers when it refuses a host', () => {
    expect(() => requireSimplefinProviderHost('https://evil.com/claim/x', 'SimpleFin claim URL'))
      .toThrow('SimpleFin claim URL must be hosted at simplefin.org or lunchflow.app — got evil.com');
  });

  it('reads the real host of a crafted URL, not text that looks like one', () => {
    expect(() => requireSimplefinProviderHost('https://www.lunchflow.app@evil.com/claim/x', 'SimpleFin claim URL')).toThrow('got evil.com');
    expect(() => requireSimplefinProviderHost('https://www.lunchflow.app./claim/x', 'SimpleFin claim URL')).toThrow('must be hosted at');
  });

  it('lets a Lunch Flow URL through', () => {
    expect(() => requireSimplefinProviderHost('https://u:p@www.lunchflow.app/simplefin', 'SimpleFin access URL')).not.toThrow();
  });
});

describe('addonHostEntriesFor', () => {
  it("names every manifest entry of the refused host's provider, as the permission dialog lists them", () => {
    // Both Lunch Flow entries: its access URL host isn't documented, so a claim
    // on www.lunchflow.app may be followed by a fetch on the bare domain.
    expect(addonHostEntriesFor('www.lunchflow.app')).toEqual(['lunchflow.app', '*.lunchflow.app']);
    expect(addonHostEntriesFor('lunchflow.app')).toEqual(['lunchflow.app', '*.lunchflow.app']);
    expect(addonHostEntriesFor('bridge.simplefin.org')).toEqual(['bridge.simplefin.org', 'beta-bridge.simplefin.org']);
  });

  it('names none when no entry covers the host, even on a provider domain', () => {
    expect(addonHostEntriesFor('simplefin.org')).toEqual([]);
    expect(addonHostEntriesFor('other.simplefin.org')).toEqual([]);
    expect(addonHostEntriesFor('other.example')).toEqual([]);
  });
});

describe('manifest.json network hosts', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '../manifest.json'), 'utf8')) as {
    network: { allowedHosts: string[]; approvedHosts: string[] };
  };

  it('allows and pre-approves every provider host, so a new install reaches Lunch Flow (#25)', () => {
    for (const host of ADDON_PROVIDER_HOSTS) {
      expect(manifest.network.allowedHosts, host).toContain(host);
      expect(manifest.network.approvedHosts, host).toContain(host);
    }
  });

  it('declares no other host than the providers and Telegram', () => {
    expect([...manifest.network.allowedHosts].sort()).toEqual([...ADDON_PROVIDER_HOSTS, 'api.telegram.org'].sort());
  });
});
