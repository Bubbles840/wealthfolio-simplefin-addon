import { describe, it, expect } from 'vitest';
import {
  clearTxOverride, emptySyncOverrides, hasTxOverride, overrideRows, parseSyncOverrides, setTxOverride, TX_OVERRIDE_FLAGS,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import { buildTxStory } from './tx-story.js';
import {
  addonUnderstandsPaybacks, companionUnderstandsPaybacks, isNewerVersion, PAYBACK_SINCE, SIMPLEFIN_SYNC_VERSION, VENMO_NOTE_SINCE,
} from './version.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-chk', 'TRN-77');

describe('asReimbursement, the payback override', () => {
  it('is a transaction flag: set, read back, listed in words, cleared', () => {
    expect(TX_OVERRIDE_FLAGS).toContain('asReimbursement');
    const o = setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', NOW, { label: 'VENMO CASHOUT · PNC Checking' });
    expect(hasTxOverride(o, KEY, 'asReimbursement')).toBe(true);
    expect(parseSyncOverrides(JSON.stringify(o))).toEqual({ kind: 'ok', overrides: o });
    expect(overrideRows(o).map((r) => r.text)).toEqual(['Payback: VENMO CASHOUT · PNC Checking']);
    expect(clearTxOverride(o, KEY, 'asReimbursement')).toEqual(emptySyncOverrides());
  });

  it('is read strictly now that this version knows it: only `true` is a value', () => {
    expect(parseSyncOverrides('{"v":1,"tx":{"k":{"asReimbursement":"yes","at":"2026-10-14T09:00:00Z"}},"accounts":{}}')).toEqual({ kind: 'corrupt' });
  });

  it('is worded in a story as something you told the sync', () => {
    const s = buildTxStory({
      now: NOW,
      row: { activityId: 'a1', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'CREDIT', accountName: 'PNC Checking', accountType: 'CASH' },
      feed: { sfinAccountId: 'sfin-chk' }, partner: null, history: [], overrides: ['asReimbursement', 'noVenmoNote'],
    });
    expect(s.answer.at(-1)).toBe("You told the sync: no Venmo note, it's a payback.");
  });
});

describe('the payback gate (W8)', () => {
  it('is 1.62.0 — raise it to the release that ships paybacks — and never below the Venmo note gate', () => {
    expect(PAYBACK_SINCE).toBe('1.62.0');
    expect(isNewerVersion(VENMO_NOTE_SINCE, PAYBACK_SINCE)).toBe(false);
  });

  it('is never above the version this build ships as, once it ships past 1.61.0', () => {
    // A release below PAYBACK_SINCE would refuse its own paybacks forever.
    if (isNewerVersion(SIMPLEFIN_SYNC_VERSION, '1.61.0')) {
      expect(isNewerVersion(PAYBACK_SINCE, SIMPLEFIN_SYNC_VERSION)).toBe(false);
    }
  });

  it('a companion understands paybacks from that release; no companion at all is fine', () => {
    expect(companionUnderstandsPaybacks(PAYBACK_SINCE)).toBe(true);
    expect(companionUnderstandsPaybacks(' 1.62.0 ')).toBe(true);
    expect(companionUnderstandsPaybacks('9.0.0')).toBe(true);
    expect(companionUnderstandsPaybacks('1.61.0')).toBe(false);
    expect(companionUnderstandsPaybacks('garbage')).toBe(false);
    expect(companionUnderstandsPaybacks(null)).toBe(true);
  });

  it('an installed add-on understands them from that release; an unknown one does not', () => {
    expect(addonUnderstandsPaybacks(PAYBACK_SINCE)).toBe(true);
    expect(addonUnderstandsPaybacks('1.62.0\n')).toBe(true);
    expect(addonUnderstandsPaybacks('9.0.0')).toBe(true);
    expect(addonUnderstandsPaybacks('1.61.0')).toBe(false);
    expect(addonUnderstandsPaybacks('garbage')).toBe(false);
    expect(addonUnderstandsPaybacks(null)).toBe(false);
  });
});
