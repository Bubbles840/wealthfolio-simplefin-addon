import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SIMPLEFIN_SYNC_VERSION } from './version.js';

describe('SIMPLEFIN_SYNC_VERSION', () => {
  /**
   * The whole point of this constant is that ONE number describes a build. A
   * companion running unidentifiable code cost a diagnostic detour on
   * 2026-08-06: `companion/package.json` has read `1.0.1` since the project
   * started, so "which build is deployed?" could only be answered by grepping
   * compiled JavaScript for a feature-specific string.
   *
   * These tests fail the moment a release bumps the manifest and forgets this
   * file, which is the only way the guarantee survives contact with a release
   * checklist.
   */
  const root = join(__dirname, '..');
  const readVersion = (file: string) =>
    JSON.parse(readFileSync(join(root, file), 'utf8')).version as string;

  it('matches manifest.json, which is what Wealthfolio installs', () => {
    expect(SIMPLEFIN_SYNC_VERSION).toBe(readVersion('manifest.json'));
  });

  it('matches package.json, which is what names the built zip', () => {
    expect(SIMPLEFIN_SYNC_VERSION).toBe(readVersion('package.json'));
  });

  it('is a plain semver triple, so it can be compared and displayed as-is', () => {
    expect(SIMPLEFIN_SYNC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('isNewerVersion', () => {
  it('orders semver numerically, not lexically', async () => {
    const { isNewerVersion } = await import('./version.js');
    expect(isNewerVersion('1.34.0', '1.33.0')).toBe(true);
    expect(isNewerVersion('1.33.0', '1.34.0')).toBe(false);
    expect(isNewerVersion('1.34.0', '1.34.0')).toBe(false);
    // The lexical trap: '1.9.0' > '1.10.0' as strings.
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.0')).toBe(true);
  });

  it('rejects anything that is not a plain x.y.z', async () => {
    // The comparison feeds an "update available" line from an external API
    // response — a malformed tag must never manufacture an upgrade prompt.
    const { isNewerVersion } = await import('./version.js');
    expect(isNewerVersion('', '1.33.0')).toBe(false);
    expect(isNewerVersion('v1.34.0-rc1', '1.33.0')).toBe(false);
    expect(isNewerVersion('banana', '1.33.0')).toBe(false);
  });
});

describe('versionMismatchNotice', () => {
  it('stays quiet when the tab matches the companion, or no companion has run', async () => {
    const { versionMismatchNotice } = await import('./version.js');
    expect(versionMismatchNotice('1.57.0', '1.57.0', '1.57.0')).toBeNull();
    expect(versionMismatchNotice('1.57.0', null, null)).toBeNull();
  });

  it('tells a stale tab to reload when the new zip is already installed', async () => {
    // The case the morning report could never tell apart from "no tab open".
    const { versionMismatchNotice } = await import('./version.js');
    const notice = versionMismatchNotice('1.57.0', '1.58.0', '1.58.0');
    expect(notice?.tone).toBe('reload');
    expect(notice?.text).toMatch(/Reload/);
    expect(notice?.text).not.toContain('.zip');
  });

  it('names the zip when the installed addon is the old one', async () => {
    const { versionMismatchNotice } = await import('./version.js');
    const notice = versionMismatchNotice('1.57.0', '1.58.0', '1.57.0');
    expect(notice?.tone).toBe('upload');
    expect(notice?.text).toContain('simplefin-sync-1.58.0.zip');
  });

  it('offers both remedies when the installed version is unknown', async () => {
    const { versionMismatchNotice } = await import('./version.js');
    const notice = versionMismatchNotice('1.57.0', '1.58.0', null);
    expect(notice?.text).toMatch(/Reload/);
    expect(notice?.text).toContain('simplefin-sync-1.58.0.zip');
  });

  it('points at the companion image when this tab is the newer half', async () => {
    // The old footer said "rebuild the companion" whichever half was behind.
    const { versionMismatchNotice } = await import('./version.js');
    const notice = versionMismatchNotice('1.58.0', '1.57.0', '1.58.0');
    expect(notice?.tone).toBe('companion');
    expect(notice?.text).toMatch(/pull the new companion image/);
  });
});
