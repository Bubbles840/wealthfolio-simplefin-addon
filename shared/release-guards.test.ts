import { describe, it, expect } from 'vitest';
import { DATE_REPAIR_SINCE } from './date-repair';
import { IGNORE_RULES_SINCE, isNewerVersion, LOAN_BALANCES_SINCE, PAYBACK_SINCE, RELINKS_SINCE, SIMPLEFIN_SYNC_VERSION } from './version';

/** A gate above the version this build ships as would wait for itself forever. */
describe('the 1.62, 1.66 and 1.68 gates are never above the version this build ships as', () => {
  it.each<[string, string]>([
    ['DATE_REPAIR_SINCE', DATE_REPAIR_SINCE], ['PAYBACK_SINCE', PAYBACK_SINCE], ['IGNORE_RULES_SINCE', IGNORE_RULES_SINCE],
    ['LOAN_BALANCES_SINCE', LOAN_BALANCES_SINCE], ['RELINKS_SINCE', RELINKS_SINCE],
  ])('%s', (_name, since) => {
    expect(isNewerVersion(since, SIMPLEFIN_SYNC_VERSION)).toBe(false);
  });
});
