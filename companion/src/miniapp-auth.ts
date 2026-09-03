/**
 * companion/src/miniapp-auth.ts
 *
 * Telegram Web App `initData` validation — the mini app's entire auth story.
 * Telegram signs the payload it hands the page with HMAC-SHA256 keyed off the
 * bot token, so a valid signature proves "this open came through OUR bot",
 * with no passwords anywhere. Freshness is enforced because initData travels
 * in requests: a captured payload must stop working on its own.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How old a signed payload may be. Telegram re-signs on every open, so this
 *  only needs to cover one sitting, not a session. */
const MAX_AGE_SECONDS = 24 * 60 * 60;

export function validateInitData(
  initData: string,
  botToken: string,
  now: Date,
): { userId: number } | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheck = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expected = createHmac('sha256', secret).update(dataCheck).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(hash, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate)) return null;
    const age = now.getTime() / 1000 - authDate;
    if (age > MAX_AGE_SECONDS || age < -300) return null;

    const user = JSON.parse(params.get('user') ?? 'null') as { id?: unknown } | null;
    if (!user || typeof user.id !== 'number') return null;
    return { userId: user.id };
  } catch {
    return null;
  }
}
