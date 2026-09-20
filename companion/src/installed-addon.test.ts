import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInstalledAddonVersion } from './installed-addon.js';

const made: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-addons-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readInstalledAddonVersion', () => {
  it('reads the version from the installed addon\'s manifest, beside the database', () => {
    const dir = dataDir();
    mkdirSync(join(dir, 'addons', 'simplefin-sync'), { recursive: true });
    writeFileSync(join(dir, 'addons', 'simplefin-sync', 'manifest.json'), JSON.stringify({ id: 'simplefin-sync', version: '1.52.0' }));
    expect(readInstalledAddonVersion(join(dir, 'wealthfolio.db'))).toBe('1.52.0');
  });

  it('matches on the manifest id, not the folder name', () => {
    // The host picks the folder name, and nothing promises it equals the id.
    const dir = dataDir();
    mkdirSync(join(dir, 'addons', 'some-other-addon'), { recursive: true });
    writeFileSync(join(dir, 'addons', 'some-other-addon', 'manifest.json'), JSON.stringify({ id: 'other', version: '9.9.9' }));
    mkdirSync(join(dir, 'addons', 'a1b2c3'), { recursive: true });
    writeFileSync(join(dir, 'addons', 'a1b2c3', 'manifest.json'), JSON.stringify({ id: 'simplefin-sync', version: '1.49.0' }));
    expect(readInstalledAddonVersion(join(dir, 'wealthfolio.db'))).toBe('1.49.0');
  });

  it('is null when the addons directory is not there', () => {
    // A deployment that mounts the bare .db file, or a desktop install with a
    // different layout. Null makes the self-check fall back to offering both
    // remedies, which is the behaviour that existed before this reader did.
    expect(readInstalledAddonVersion(join(dataDir(), 'wealthfolio.db'))).toBeNull();
  });

  it('is null for a manifest that cannot be parsed, rather than throwing into the daily report', () => {
    const dir = dataDir();
    mkdirSync(join(dir, 'addons', 'simplefin-sync'), { recursive: true });
    writeFileSync(join(dir, 'addons', 'simplefin-sync', 'manifest.json'), '{ not json');
    expect(readInstalledAddonVersion(join(dir, 'wealthfolio.db'))).toBeNull();
  });

  it('is null for a manifest with no usable version', () => {
    const dir = dataDir();
    mkdirSync(join(dir, 'addons', 'simplefin-sync'), { recursive: true });
    writeFileSync(join(dir, 'addons', 'simplefin-sync', 'manifest.json'), JSON.stringify({ id: 'simplefin-sync' }));
    expect(readInstalledAddonVersion(join(dir, 'wealthfolio.db'))).toBeNull();
  });
});
