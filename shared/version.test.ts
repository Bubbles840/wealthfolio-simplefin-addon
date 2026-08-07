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
