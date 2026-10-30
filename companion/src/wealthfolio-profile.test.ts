import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WealthfolioClient, PROFILE_SCOPE_HEADER, resetProfileSessionsForTest } from './wealthfolio';

/**
 * A fake Wealthfolio 3.10 with the profile behaviour the companion depends on
 * (apps/server/src/profiles.rs at v3.10.0): a grant per signed-in OWNER (here,
 * the Authorization header), replaced by every unlock, lost on restart, and a
 * 423 for a request whose scope is not the owner's current grant.
 */
const PERSONAL = '11111111-1111-4111-8111-111111111111';
const BUSINESS = '22222222-2222-4222-8222-222222222222';
const LOCKED = '33333333-3333-4333-8333-333333333333';

function fakeWealthfolio(opts: { profilesRoute?: 'missing' | 'html'; scopeId?: (n: number) => unknown } = {}) {
  const grants = new Map<string, { profileId: string; scope: string }>();
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
  let unlocks = 0;
  let logins = 0;
  let alwaysStale = false;
  const profiles = [
    { id: PERSONAL, name: 'Personal', avatarId: 'a', lockEnabled: false, isLegacy: true, hasConnectBinding: false },
    { id: BUSINESS, name: 'Business', avatarId: 'b', lockEnabled: false, isLegacy: false, hasConnectBinding: false },
    { id: LOCKED, name: 'Locked one', avatarId: 'c', lockEnabled: true, isLegacy: false, hasConnectBinding: false },
  ];
  const accountsOf: Record<string, Array<{ id: string }>> = { [PERSONAL]: [{ id: 'acc-p' }], [BUSINESS]: [{ id: 'acc-b1' }, { id: 'acc-b2' }] };
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const text = (status: number, body: string) => ({ ok: status < 400, status, json: async () => JSON.parse(body), text: async () => body });

  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const headers = { ...(init.headers as Record<string, string> | undefined) };
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, headers, body });
    if (path === '/api/v1/auth/login') {
      logins += 1;
      return {
        ok: true, status: 200,
        headers: { getSetCookie: () => [`wf_session=jwt-${logins}; HttpOnly`], get: () => null },
        json: async () => ({}),
      };
    }
    const owner = headers.Authorization ?? '';
    if (path.startsWith('/api/v1/profiles/')) {
      if (opts.profilesRoute === 'missing') return text(404, 'Not Found');
      if (opts.profilesRoute === 'html') return text(200, '<!doctype html><title>Wealthfolio</title>');
      const command = path.slice('/api/v1/profiles/'.length);
      if (command === 'get_profile_state') return json(200, { profiles, pendingDeletions: [], session: null, starting: false });
      if (command === 'unlock_profile') {
        const target = profiles.find((p) => p.id === (body as { profileId?: string }).profileId);
        if (!target) return text(423, 'Profile not found');
        if (target.lockEnabled) return text(423, 'PROFILE_LOCKED: Unlock this profile to continue.');
        unlocks += 1;
        const scope = opts.scopeId ? opts.scopeId(unlocks) : `aaaaaaaa-0000-4000-8000-${String(unlocks).padStart(12, '0')}`;
        grants.set(owner, { profileId: target.id, scope: String(scope) });
        return json(200, { profileId: target.id, scopeId: scope });
      }
      return text(404, 'Unknown profile operation');
    }
    const grant = grants.get(owner);
    // Every request but the open's own account check: proves the retry is bounded.
    if (alwaysStale && path !== '/api/v1/accounts') return text(423, 'PROFILE_STALE');
    if (!grant) return text(423, 'PROFILE_LOCKED: Unlock this profile to continue.');
    if (headers[PROFILE_SCOPE_HEADER] !== grant.scope) return text(423, 'PROFILE_STALE');
    if (path === '/api/v1/accounts') return json(200, accountsOf[grant.profileId] ?? []);
    return json(200, { profile: grant.profileId });
  });

  return {
    fetch, calls, grants,
    unlocks: () => unlocks,
    restart: () => grants.clear(),
    breakEveryScope: () => { alwaysStale = true; },
    sent: (path: string) => calls.filter((c) => c.path === path),
  };
}

function client(wf: ReturnType<typeof fakeWealthfolio>, profile?: ConstructorParameters<typeof WealthfolioClient>[1], token = 'api-key') {
  vi.stubGlobal('fetch', wf.fetch);
  const c = new WealthfolioClient('http://wf:8088', profile);
  (c as unknown as { token: string }).token = token;
  return c;
}

beforeEach(() => {
  resetProfileSessionsForTest();
  vi.unstubAllGlobals();
});

describe('WealthfolioClient without a profile', () => {
  it('sends requests exactly as before: no scope header, no cookie, no profile calls', async () => {
    const wf = fakeWealthfolio();
    wf.grants.set('Bearer api-key', { profileId: PERSONAL, scope: 'unused' });
    await client(wf).getAccounts().catch(() => {});
    expect(wf.calls).toHaveLength(1);
    expect(wf.calls[0].headers).toEqual({ Authorization: 'Bearer api-key' });
  });

  it('names WEALTHFOLIO_PROFILE_ID in the 423 message', async () => {
    const wf = fakeWealthfolio();
    await expect(client(wf).getAccounts()).rejects.toThrow(/HTTP 423.*WEALTHFOLIO_PROFILE_ID/);
  });
});

describe('WealthfolioClient with a profile (#50)', () => {
  it('opens the profile, checks it, then sends every request with its scope and a steady wf_browser cookie', async () => {
    const wf = fakeWealthfolio();
    const verify = vi.fn();
    const c = client(wf, { id: BUSINESS, verify });
    expect(await c.getAccounts()).toEqual([{ id: 'acc-b1' }, { id: 'acc-b2' }]);
    expect(wf.calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /api/v1/profiles/get_profile_state',
      'POST /api/v1/profiles/unlock_profile',
      'GET /api/v1/accounts',
      'GET /api/v1/accounts',
    ]);
    expect(wf.calls[1].body).toEqual({ profileId: BUSINESS });
    expect(verify).toHaveBeenCalledWith([{ id: 'acc-b1' }, { id: 'acc-b2' }]);
    const last = wf.calls.at(-1)!.headers;
    expect(last[PROFILE_SCOPE_HEADER]).toBe(wf.grants.get('Bearer api-key')!.scope);
    expect(last.Cookie).toMatch(/^wf_browser=[0-9a-f-]{36}$/);
    expect(new Set(wf.calls.map((x) => x.headers.Cookie))).toEqual(new Set([last.Cookie]));
    await c.getAccounts();
    expect(wf.unlocks()).toBe(1);
  });

  it('accepts the ID in any case', async () => {
    const wf = fakeWealthfolio();
    await client(wf, { id: BUSINESS.toUpperCase() }).getAccounts();
    expect(wf.calls[1].body).toEqual({ profileId: BUSINESS });
  });

  it('refuses an ID that is not a UUID before any request', () => {
    const wf = fakeWealthfolio();
    for (const bad of ['../../etc', '', 'business', `${BUSINESS}\r\nX: y`]) {
      expect(() => client(wf, { id: bad })).toThrow(/WEALTHFOLIO_PROFILE_ID/);
    }
    expect(wf.calls).toHaveLength(0);
  });

  it('never sends the request when the check refuses the profile, and tries again next time', async () => {
    const wf = fakeWealthfolio();
    const verify = vi.fn().mockRejectedValueOnce(new Error('not this profile’s database')).mockResolvedValue(undefined);
    const c = client(wf, { id: BUSINESS, verify });
    await expect(c.getHoldings('acc-b1')).rejects.toThrow('not this profile’s database');
    expect(wf.sent('/api/v1/holdings')).toHaveLength(0);
    await c.getHoldings('acc-b1');
    expect(wf.sent('/api/v1/holdings')).toHaveLength(1);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('an unknown ID: the error names no profiles, the log lists them', async () => {
    const wf = fakeWealthfolio();
    const log = vi.fn();
    const unknown = '44444444-4444-4444-8444-444444444444';
    const err = await client(wf, { id: unknown, log }).getAccounts().catch((e) => e as Error);
    expect(err.message).toContain(unknown);
    expect(err.message).not.toContain('Business');
    expect(log.mock.calls.join('\n')).toContain(`Business (${BUSINESS})`);
    expect(log.mock.calls.join('\n')).toContain(`Personal (${PERSONAL})`);
    expect(wf.sent('/api/v1/profiles/unlock_profile')).toHaveLength(0);
    expect(wf.sent('/api/v1/accounts')).toHaveLength(0);
  });

  it('a profile with a lock is refused without trying to unlock it', async () => {
    const wf = fakeWealthfolio();
    await expect(client(wf, { id: LOCKED }).getAccounts()).rejects.toThrow(/has a lock/);
    expect(wf.sent('/api/v1/profiles/unlock_profile')).toHaveLength(0);
  });

  it('a Wealthfolio without profiles (before 3.10) is a clear error, whether it 404s or serves its page', async () => {
    for (const route of ['missing', 'html'] as const) {
      const wf = fakeWealthfolio({ profilesRoute: route });
      await expect(client(wf, { id: BUSINESS }).getAccounts()).rejects.toThrow(/3\.10/);
      expect(wf.sent('/api/v1/accounts')).toHaveLength(0);
    }
  });

  it('a session id that is not a UUID is refused, never put in a header', async () => {
    const wf = fakeWealthfolio({ scopeId: () => 'x\r\nInjected: 1' });
    await expect(client(wf, { id: BUSINESS }).getAccounts()).rejects.toThrow(/session/);
    expect(wf.sent('/api/v1/accounts')).toHaveLength(0);
  });

  it('after a Wealthfolio restart it reopens the profile and retries the request once', async () => {
    const wf = fakeWealthfolio();
    const verify = vi.fn();
    const c = client(wf, { id: BUSINESS, verify });
    await c.getAccounts();
    wf.restart();
    expect(await c.getAccounts()).toHaveLength(2);
    expect(wf.unlocks()).toBe(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('a second 423 is an error that names the profile', async () => {
    const wf = fakeWealthfolio();
    const c = client(wf, { id: BUSINESS });
    await c.getAccounts();
    wf.breakEveryScope();
    await expect(c.getHoldings('acc-b1')).rejects.toThrow(new RegExp(`profile ${BUSINESS}.*HTTP 423`));
    expect(wf.sent('/api/v1/holdings')).toHaveLength(2);
  });

  it('two clients on one credential share one grant instead of cancelling each other', async () => {
    const wf = fakeWealthfolio();
    const sync = client(wf, { id: BUSINESS });
    const listener = client(wf, { id: BUSINESS });
    await sync.getAccounts();
    await listener.getAccounts();
    expect(wf.unlocks()).toBe(1);
    wf.restart();
    await listener.getAccounts();
    await sync.getAccounts();
    expect(wf.unlocks()).toBe(2);
  });

  it('opens once for requests that arrive together', async () => {
    const wf = fakeWealthfolio();
    const c = client(wf, { id: BUSINESS });
    await Promise.all([c.getAccounts(), c.getHoldings('acc-b1'), c.getLatestValuations().catch(() => [])]);
    expect(wf.unlocks()).toBe(1);
  });

  it('a new login is a new owner, so it opens the profile again', async () => {
    const wf = fakeWealthfolio();
    vi.stubGlobal('fetch', wf.fetch);
    const c = new WealthfolioClient('http://wf:8088', { id: BUSINESS });
    await c.login('pw');
    await c.getAccounts();
    await c.login('pw');
    await c.getAccounts();
    expect(wf.unlocks()).toBe(2);
    expect(wf.sent('/api/v1/profiles/unlock_profile').map((x) => x.headers.Authorization)).toEqual(['Bearer jwt-1', 'Bearer jwt-2']);
  });

  it('the profile calls send only the ID, the credential and the cookie', async () => {
    const wf = fakeWealthfolio();
    await client(wf, { id: BUSINESS }).getAccounts();
    for (const call of wf.calls.filter((x) => x.path.startsWith('/api/v1/profiles/'))) {
      expect(Object.keys(call.headers).sort()).toEqual(['Authorization', 'Content-Type', 'Cookie']);
    }
    expect(wf.calls[0].body).toEqual({});
  });
});
