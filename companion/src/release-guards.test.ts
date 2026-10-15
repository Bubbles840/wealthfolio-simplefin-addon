import { describe, it, expect } from 'vitest';
import { isNewerVersion, SIMPLEFIN_SYNC_VERSION } from '../../shared/version.js';
import { CARD_REWRITE_ADDON_SINCE } from './card-bookkeeping-rewrite.js';

/** A gate above the version this build ships as would wait for itself forever. */
describe("the card rewrite's add-on gate", () => {
  it('is never above the version this build ships as', () => {
    expect(isNewerVersion(CARD_REWRITE_ADDON_SINCE, SIMPLEFIN_SYNC_VERSION)).toBe(false);
  });
});
