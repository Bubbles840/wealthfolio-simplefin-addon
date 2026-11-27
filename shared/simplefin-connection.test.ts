import { describe, it, expect } from 'vitest';
import {
  REFUSED_CONNECTION_LINE, companionConnectionRefused, isRefusedConnection, mappedAccountIds, missingMappedAccounts, providerName,
} from './simplefin-connection.js';

describe('isRefusedConnection', () => {
  it('is true for a 401 or 403 status, which wins over the message', () => {
    expect(isRefusedConnection({ status: 403, message: 'x' })).toBe(true);
    expect(isRefusedConnection({ status: 401 })).toBe(true);
    expect(isRefusedConnection('anything', 403)).toBe(true);
    expect(isRefusedConnection('SimpleFin /accounts failed: 403', 500)).toBe(false);
    expect(isRefusedConnection({ status: 402, message: 'SimpleFin /accounts failed: 403' })).toBe(false);
  });
  it('reads the companion text when there is no status', () => {
    expect(isRefusedConnection('SimpleFin /accounts failed: 403')).toBe(true);
    expect(isRefusedConnection('SimpleFin /accounts failed: 401 — Unauthorized')).toBe(true);
    expect(isRefusedConnection(new Error('SimpleFin /accounts failed: 403 — Forbidden'))).toBe(true);
  });
  it("is never true for 402, a claim's 403, or another host's 403", () => {
    expect(isRefusedConnection('SimpleFin /accounts failed: 402 — Payment required')).toBe(false);
    expect(isRefusedConnection('SimpleFin /accounts failed: 4031')).toBe(false);
    expect(isRefusedConnection('SimpleFin /accounts failed: 524')).toBe(false);
    expect(isRefusedConnection('SimpleFin claim failed (403): this setup token was already used')).toBe(false);
    expect(isRefusedConnection('HTTP 403')).toBe(false);
    expect(isRefusedConnection(null)).toBe(false);
    expect(isRefusedConnection(undefined)).toBe(false);
  });
});

describe('providerName', () => {
  it('names the two providers and any other host, never the credentials', () => {
    expect(providerName('https://u:p@beta-bridge.simplefin.org/simplefin')).toBe('SimpleFIN Bridge');
    expect(providerName('https://u:p@www.lunchflow.app/simplefin')).toBe('Lunch Flow');
    expect(providerName('https://user:secret@example.com/simplefin')).toBe('example.com');
    expect(providerName('https://user:secret@example.com/simplefin')).not.toContain('secret');
  });
  it('is null for nothing, or for what does not parse', () => {
    expect(providerName(null)).toBeNull();
    expect(providerName('')).toBeNull();
    expect(providerName('not a url')).toBeNull();
  });
});

describe('mapped and missing accounts', () => {
  const mapping = { a: 'wf-1', b: 'wf-2', c: '' };
  const loans = { d: 'loan-1', a: 'loan-x' };
  it('counts a non-empty target and every loan link, once each, mapping order first', () => {
    expect(mappedAccountIds(mapping, loans)).toEqual(['a', 'b', 'd']);
    expect(mappedAccountIds(mapping)).toEqual(['a', 'b']);
  });
  it('lists the mapped ids the new list lacks, loans included', () => {
    expect(missingMappedAccounts(mapping, [{ id: 'a' }, { id: 'zzz' }], loans)).toEqual(['b', 'd']);
    expect(missingMappedAccounts(mapping, [{ id: 'a' }, { id: 'b' }, { id: 'd' }], loans)).toEqual([]);
  });
});

describe('companionConnectionRefused', () => {
  const refused = { firstFailedAt: '2026-11-20T10:00:00.000Z', lastFailedAt: '2026-11-25T10:00:00.000Z', lastError: 'SimpleFin /accounts failed: 403' };
  it.each([
    ['refused, never replaced', refused, null, true],
    ['replaced after the last failure', refused, '2026-11-25T11:00:00.000Z', false],
    ['fails again after the replace', refused, '2026-11-24T09:00:00.000Z', true],
    ['old companion: replaced after the first failure', { ...refused, lastFailedAt: undefined }, '2026-11-21T09:00:00.000Z', false],
    ['unreadable replace time', refused, 'garbage', true],
    ['another failure', { ...refused, lastError: 'SimpleFin /accounts failed: 524' }, null, false],
    ['a success', { lastSuccessAt: '2026-11-25T10:00:00.000Z' } as any, null, false],
    ['no record', null, null, false],
    ['a lastError that is not text', { ...refused, lastError: 403 as any }, null, false],
  ])('%s', (_name, health, replacedAt, shown) => {
    expect(companionConnectionRefused(health as any, replacedAt as any)).toBe(shown);
  });

  it.each([
    ['an add-on sync succeeded after the last failure', refused, '2026-11-25T12:00:00.000Z', false],
    ['the add-on last succeeded before it', refused, '2026-11-25T09:00:00.000Z', true],
    ['old companion: an add-on success after the first failure', { ...refused, lastFailedAt: undefined }, '2026-11-21T09:00:00.000Z', false],
    ['an unreadable success time never hides it', refused, 'garbage', true],
    ['no add-on success yet', refused, null, true],
  ])('%s', (_name, health, lastAddonSuccessAt, shown) => {
    expect(companionConnectionRefused(health as any, null, lastAddonSuccessAt as any)).toBe(shown);
  });
});

it('the fix line is the one wording', () => {
  expect(REFUSED_CONNECTION_LINE).toBe('SimpleFIN no longer accepts this connection. Paste a new setup token in SimpleFin Sync → Settings → SimpleFIN connection; your mapping and rules stay.');
});
