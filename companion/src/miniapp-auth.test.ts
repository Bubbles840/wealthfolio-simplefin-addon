import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { validateInitData } from './miniapp-auth.js';

const TOKEN = '12345:TEST-TOKEN';
const NOW = new Date('2026-09-02T22:00:00Z');

/** Builds initData exactly the way Telegram signs it. */
function signedInitData(fields: Record<string, string>): string {
  const dataCheck = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheck).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe('validateInitData', () => {
  const fresh = Math.floor(NOW.getTime() / 1000) - 60;
  const user = JSON.stringify({ id: 777, first_name: 'Nick' });

  it('accepts a correctly signed, fresh payload and returns the user id', () => {
    const initData = signedInitData({ auth_date: String(fresh), user });
    expect(validateInitData(initData, TOKEN, NOW)).toEqual({ userId: 777 });
  });

  it('rejects a tampered payload', () => {
    const initData = signedInitData({ auth_date: String(fresh), user });
    const tampered = initData.replace('Nick', 'Mallory');
    expect(validateInitData(tampered, TOKEN, NOW)).toBeNull();
  });

  it('rejects a stale payload — a captured link must expire', () => {
    const old = Math.floor(NOW.getTime() / 1000) - 60 * 60 * 25;
    const initData = signedInitData({ auth_date: String(old), user });
    expect(validateInitData(initData, TOKEN, NOW)).toBeNull();
  });

  it('rejects garbage without throwing', () => {
    expect(validateInitData('', TOKEN, NOW)).toBeNull();
    expect(validateInitData('hash=zz&auth_date=1', TOKEN, NOW)).toBeNull();
  });
});
