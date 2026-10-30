import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WealthfolioClient } from './wealthfolio';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => mockFetch.mockReset());

/** Login response: session JWT arrives via Set-Cookie, not the body */
function loginResponse(jwt = 'jwt-abc') {
  return {
    ok: true,
    headers: {
      getSetCookie: () => [`wf_session=${jwt}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=3600`],
      get: () => null,
    },
    json: async () => ({ authenticated: true, expiresIn: 3600 }),
  };
}

describe('WealthfolioClient', () => {
  it('login POSTs password only and extracts the wf_session cookie as Bearer token', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.login('password');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/auth/login');
    expect(JSON.parse((opts as any).body)).toEqual({ password: 'password' });
  });

  it('falls back to the set-cookie header when getSetCookie is unavailable', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'wf_session=jwt-legacy; HttpOnly' },
      json: async () => ({}),
    });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.login('password');
    await client.importActivities([]);
    const [, opts] = mockFetch.mock.calls[1];
    expect((opts as any).headers.Authorization).toBe('Bearer jwt-legacy');
  });

  it('throws when login returns no wf_session cookie', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { getSetCookie: () => [], get: () => null },
      json: async () => ({}),
    });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await expect(client.login('password')).rejects.toThrow('wf_session');
  });

  it('importActivities POSTs to /activities/import with Bearer header', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.login('password');
    await client.importActivities([{ accountId: 'wf-a', activityType: 'DEPOSIT' }]);

    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/import');
    expect((opts as any).headers.Authorization).toBe('Bearer jwt-abc');
    expect(JSON.parse((opts as any).body)).toEqual({
      activities: [{ accountId: 'wf-a', activityType: 'DEPOSIT' }],
    });
  });

  it('works without credentials when no auth configured (unauthenticated mode)', async () => {
    const client = new WealthfolioClient('http://wealthfolio:8088');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
    await client.importActivities([]);
    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as any).headers.Authorization).toBeUndefined();
  });

  it('linkTransferActivities POSTs both ids to /activities/link', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{}, {}] });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.linkTransferActivities('act-out', 'act-in');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/link');
    expect(JSON.parse((opts as any).body)).toEqual({ activityAId: 'act-out', activityBId: 'act-in' });
  });

  it('linkTransferActivities throws on non-ok status', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await expect(client.linkTransferActivities('a', 'b')).rejects.toThrow('422');
  });

  it('linkTransferActivities answers with the two rows Wealthfolio wrote, and names its refusal', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'act-in', sourceGroupId: 'g' }, { id: 'act-out', sourceGroupId: 'g' }] });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    expect(await client.linkTransferActivities('act-out', 'act-in')).toEqual([{ id: 'act-in', sourceGroupId: 'g' }, { id: 'act-out', sourceGroupId: 'g' }]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'One or both activities are already linked to another transfer' });
    await expect(client.linkTransferActivities('a', 'b')).rejects.toThrow('linkTransferActivities failed: 400 - One or both activities are already linked to another transfer');
  });

  it('unlinkTransferActivities POSTs both ids to /activities/unlink', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'act-in' }, { id: 'act-out' }] });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    expect(await client.unlinkTransferActivities('act-out', 'act-in')).toEqual([{ id: 'act-in' }, { id: 'act-out' }]);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/unlink');
    expect(JSON.parse((opts as any).body)).toEqual({ activityAId: 'act-out', activityBId: 'act-in' });
  });

  it('searchActivities POSTs filters and returns the data array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'act-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-05', amount: '500', sourceGroupId: null }], meta: {} }),
    });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    const items = await client.searchActivities({
      page: 0, pageSize: 200,
      accountIdFilter: ['wf-a'],
      activityTypeFilter: ['TRANSFER_IN', 'TRANSFER_OUT'],
      dateFrom: '2026-06-28',
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/search');
    // The whole body goes to the wire verbatim - in particular `page`, which is
    // 0-indexed on this endpoint. A client that "helpfully" adjusted the page
    // number would resurrect the empty-first-page bug.
    expect(JSON.parse((opts as any).body)).toEqual({
      page: 0, pageSize: 200,
      accountIdFilter: ['wf-a'],
      activityTypeFilter: ['TRANSFER_IN', 'TRANSFER_OUT'],
      dateFrom: '2026-06-28',
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('act-1');
  });

  it('reads an addon secret', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '"https://u:p@bridge"',
      json: async () => 'https://u:p@bridge',
    });
    const c = new WealthfolioClient('http://wf');
    const v = await c.getAddonSecret('simplefin-sync', 'simplefin_access_url');
    expect(v).toBe('https://u:p@bridge');
    expect(mockFetch.mock.calls[0][0]).toBe('http://wf/api/v1/addons/simplefin-sync/secrets?key=simplefin_access_url');
  });

  it('returns null when getAddonSecret returns 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const c = new WealthfolioClient('http://wf');
    const v = await c.getAddonSecret('simplefin-sync', 'simplefin_access_url');
    expect(v).toBeNull();
  });

  it('returns null, not the text "null", for a secret that was never stored', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'null' });
    const c = new WealthfolioClient('http://wf');
    expect(await c.getAddonSecret('simplefin-sync', 'sync_overrides')).toBeNull();
  });

  it('setAddonSecret POSTs { key, secret } (not { key, value }) with auth headers', async () => {
    // Regression test: the real server rejects { key, value } with HTTP 422
    // ("missing field `secret`"). Pin the exact wire shape so a future
    // "helpful" rename can't silently reintroduce the bug.
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });

    const client = new WealthfolioClient('http://wf');
    await client.login('password');
    await client.setAddonSecret('simplefin-sync', 'my_key', 'my_val');

    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe('http://wf/api/v1/addons/simplefin-sync/secrets');
    expect((opts as any).method).toBe('POST');
    expect((opts as any).headers['Content-Type']).toBe('application/json');
    expect((opts as any).headers.Authorization).toBe('Bearer jwt-abc');
    expect(JSON.parse((opts as any).body)).toEqual({ key: 'my_key', secret: 'my_val' });
  });

  it('checkImport POSTs { accountId, activities } to /activities/import/check', async () => {
    mockFetch.mockResolvedValueOnce(loginResponse());
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    const client = new WealthfolioClient('http://wf');
    await client.login('password');
    await client.checkImport('wf-a', [{ activityType: 'DEPOSIT' }]);

    const [url, opts] = mockFetch.mock.calls[1];
    expect(url).toBe('http://wf/api/v1/activities/import/check');
    expect((opts as any).method).toBe('POST');
    expect((opts as any).headers.Authorization).toBe('Bearer jwt-abc');
    expect(JSON.parse((opts as any).body)).toEqual({
      accountId: 'wf-a',
      activities: [{ activityType: 'DEPOSIT' }],
    });
  });

  it('saveMany POSTs to /api/v1/activities/bulk', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ created: [{ id: '1' }], updated: [], errors: [] }),
    });
    const c = new WealthfolioClient('http://wf');
    const res = await c.saveMany({ creates: [{ accountId: 'a', activityType: 'DEPOSIT' }] });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/activities/bulk');
    expect(JSON.parse((opts as any).body)).toEqual({ creates: [{ accountId: 'a', activityType: 'DEPOSIT' }] });
    expect(res.created).toHaveLength(1);
  });

  it('assignActivityCategory PUTs {taxonomyId, categoryId} to the assignments path, percent-encoding the activity id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = new WealthfolioClient('http://wf');
    await client.assignActivityCategory('act/1', 'spending_categories', 'cat-1');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/spending/activities/act%2F1/assignments');
    expect((opts as any).method).toBe('PUT');
    expect(JSON.parse((opts as any).body)).toEqual({
      taxonomyId: 'spending_categories',
      categoryId: 'cat-1',
    });
  });

  it('assignActivityCategory throws through httpError on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422, text: async () => 'bad category' });
    const client = new WealthfolioClient('http://wf');
    await expect(client.assignActivityCategory('act-1', 'spending_categories', 'cat-1')).rejects.toThrow(
      'assignActivityCategory failed: 422 - bad category',
    );
  });

  it('createSpendingCategory POSTs a top-level spending category and returns its id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'cat-new' }) });
    const client = new WealthfolioClient('http://wf');
    expect(await client.createSpendingCategory('Opening balances')).toBe('cat-new');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/taxonomies/categories');
    expect((opts as any).method).toBe('POST');
    expect(JSON.parse((opts as any).body)).toMatchObject({
      taxonomyId: 'spending_categories', parentId: null, name: 'Opening balances', key: 'opening_balances',
    });
  });

  it('setExcludedSpendingCategories PUTs only the exclusion list to the spending settings', async () => {
    // Only this field: the settings route is a patch, and the account list and
    // enabled flag are the user's.
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = new WealthfolioClient('http://wf');
    await client.setExcludedSpendingCategories(['a', 'b']);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/spending/settings');
    expect((opts as any).method).toBe('PUT');
    expect(JSON.parse((opts as any).body)).toEqual({ excludedCategoryIds: ['a', 'b'] });
  });

  it('getExcludedSpendingCategories GETs Wealthfolio’s live list, and throws rather than guess', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ excludedCategoryIds: ['a', 'b'] }) });
    const client = new WealthfolioClient('http://wf');
    expect(await client.getExcludedSpendingCategories()).toEqual(['a', 'b']);
    expect(mockFetch.mock.calls[0][0]).toBe('http://wf/api/v1/spending/settings');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(client.getExcludedSpendingCategories()).rejects.toThrow();
  });

  it('unassignActivityCategory DELETEs the taxonomy off the assignments path, with no body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = new WealthfolioClient('http://wf');
    await client.unassignActivityCategory('act 1', 'spending categories');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/spending/activities/act%201/assignments/spending%20categories');
    expect((opts as any).method).toBe('DELETE');
    expect((opts as any).body).toBeUndefined();
  });

  it('unassignActivityCategory throws through httpError on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'not found' });
    const client = new WealthfolioClient('http://wf');
    await expect(client.unassignActivityCategory('act-1', 'spending_categories')).rejects.toThrow(
      'unassignActivityCategory failed: 404 - not found',
    );
  });

  it('createCategorizationRule POSTs to /spending/rules with matchType "contains", isGlobal true, and no preset fields', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = new WealthfolioClient('http://wf');
    await client.createCategorizationRule({
      name: 'Amazon groceries',
      pattern: 'AMAZON',
      categoryId: 'cat-1',
      taxonomyId: 'spending_categories',
      priority: 10,
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/spending/rules');
    expect((opts as any).method).toBe('POST');
    const body = JSON.parse((opts as any).body);
    expect(body).toEqual({
      name: 'Amazon groceries',
      pattern: 'AMAZON',
      matchType: 'contains',
      taxonomyId: 'spending_categories',
      categoryId: 'cat-1',
      priority: 10,
      isGlobal: true,
    });
    // Upstream's own doc comment: user-facing rule creation leaves the preset
    // fields None - sending them (even as null/undefined) is a coupling to
    // preset-import internals this feature must not create.
    expect(body).not.toHaveProperty('presetId');
    expect(body).not.toHaveProperty('presetRuleKey');
    expect(body).not.toHaveProperty('presetVersion');
  });

  it('createCategorizationRule scopes a rule to one account: isGlobal false and its id (3)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = new WealthfolioClient('http://wf');
    await client.createCategorizationRule({
      name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', categoryId: 'cat-1', taxonomyId: 'spending_categories', priority: 50,
      accountId: 'wf-chk',
    });
    expect(JSON.parse((mockFetch.mock.calls[0][1] as any).body)).toEqual({
      name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', matchType: 'contains', taxonomyId: 'spending_categories',
      categoryId: 'cat-1', priority: 50, isGlobal: false, accountId: 'wf-chk',
    });
  });

  it('createCategorizationRule files one activity type only when asked: a payback rule (W10)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = new WealthfolioClient('http://wf');
    await client.createCategorizationRule({
      name: 'Telegram payback: VENMO CASHOUT', pattern: 'VENMO CASHOUT', categoryId: 'cat-rest', taxonomyId: 'spending_categories', priority: 50,
      accountId: 'wf-chk', activityType: 'CREDIT',
    });
    expect(JSON.parse((mockFetch.mock.calls[0][1] as any).body)).toEqual({
      name: 'Telegram payback: VENMO CASHOUT', pattern: 'VENMO CASHOUT', matchType: 'contains', taxonomyId: 'spending_categories',
      categoryId: 'cat-rest', priority: 50, isGlobal: false, accountId: 'wf-chk', activityType: 'CREDIT',
    });
  });

  it('createCategorizationRule resolves the id of the rule the server stored', async () => {
    // Upstream answers with the stored rule (Json<CategorizationRule>, camelCase).
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '7c1f2a9e-rule', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', matchType: 'contains', priority: 50 }),
    });
    const client = new WealthfolioClient('http://wf');
    await expect(client.createCategorizationRule({
      name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-1', taxonomyId: 'spending_categories', priority: 50,
    })).resolves.toBe('7c1f2a9e-rule');
  });

  it('createCategorizationRule resolves null when the reply carries no id, or no JSON', async () => {
    const client = new WealthfolioClient('http://wf');
    const rule = { name: 'n', pattern: 'p', categoryId: 'c', taxonomyId: 'spending_categories', priority: 50 };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(client.createCategorizationRule(rule)).resolves.toBeNull();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
    await expect(client.createCategorizationRule(rule)).resolves.toBeNull();
  });

  it('createCategorizationRule throws through httpError on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'duplicate pattern' });
    const client = new WealthfolioClient('http://wf');
    await expect(
      client.createCategorizationRule({
        name: 'Amazon groceries',
        pattern: 'AMAZON',
        categoryId: 'cat-1',
        taxonomyId: 'spending_categories',
        priority: 10,
      }),
    ).rejects.toThrow('createCategorizationRule failed: 400 - duplicate pattern');
  });

  describe('error detail on non-ok responses', () => {
    it('surfaces the server response body, not just the status code', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () =>
          'Failed to deserialize the JSON body into the target type: missing field `secret` at line 1 column 36',
      });
      const client = new WealthfolioClient('http://wf');
      await expect(client.setAddonSecret('simplefin-sync', 'my_key', 'super-secret-value')).rejects.toThrow(
        /missing field `secret`/,
      );
    });

    it('never echoes the secret value into a setAddonSecret error, even on failure', async () => {
      // Only the *response* body may appear in the error - never the request
      // body, which is where the secret being written lives.
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'internal server error',
      });
      const client = new WealthfolioClient('http://wf');
      let caught: Error | undefined;
      try {
        await client.setAddonSecret('simplefin-sync', 'my_key', 'super-secret-value');
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toContain('internal server error');
      expect(caught!.message).not.toContain('super-secret-value');
    });

    it('bounds a large response body so a huge HTML error page cannot flood the logs', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'x'.repeat(5000) });
      const client = new WealthfolioClient('http://wf');
      let caught: Error | undefined;
      try {
        await client.getAccounts();
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message.length).toBeLessThan(400);
    });

    it('falls back to a status-only message when the body cannot be read', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => {
          throw new Error('stream already consumed');
        },
      });
      const client = new WealthfolioClient('http://wf');
      await expect(client.getAccounts()).rejects.toThrow('getAccounts failed: 503');
    });
  });

  it('getAppVersion reads the version from GET /api/v1/app/info', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ version: '3.10.0', dbPath: '/x', logsDir: '/l' }) });
    const client = new WealthfolioClient('http://wf');
    expect(await client.getAppVersion()).toBe('3.10.0');
    expect(mockFetch.mock.calls[0][0]).toBe('http://wf/api/v1/app/info');
  });

  it('getAppVersion returns null on a non-ok response, a throw, or a missing field', async () => {
    const client = new WealthfolioClient('http://wf');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    expect(await client.getAppVersion()).toBeNull();
    mockFetch.mockRejectedValueOnce(new Error('network'));
    expect(await client.getAppVersion()).toBeNull();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    expect(await client.getAppVersion()).toBeNull();
  });

  it('turns an HTTP 423 into a clear profile-lock error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 423, text: async () => '{"code":"PROFILE_LOCKED"}' });
    const client = new WealthfolioClient('http://wf');
    await expect(client.getAccounts()).rejects.toThrow(
      'Wealthfolio refused the request: a profile is locked or there is more than one profile (HTTP 423 PROFILE_LOCKED). Set WEALTHFOLIO_PROFILE_ID to the profile to sync; it must have no lock.',
    );
  });
});
