import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSION_CATEGORIES } from '@wealthfolio/addon-sdk';
import { hostCan, SDK39_PERMISSIONS, type Sdk39Method } from './host-can';

const METHODS = Object.keys(SDK39_PERMISSIONS) as Sdk39Method[];

/**
 * The add-on sandbox's `ctx.api` as Wealthfolio builds it (upstream
 * addon-sandbox-entry.tsx `createApiProxy`): every path is a function, and a
 * call the host does not list is refused with "Unknown addon host API method".
 */
function sandbox(allowed: readonly string[], impl: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: string[] = [];
  const at = (path: string[]): unknown => new Proxy(function addonApiProxy() {}, {
    get: (_t, key) => (key === 'then' || typeof key === 'symbol' ? undefined : at([...path, String(key)])),
    apply: (_t, _this, args: unknown[]) => {
      const method = path.join('.');
      calls.push(method);
      if (!allowed.includes(method)) return Promise.reject(new Error(`Unknown addon host API method '${method}'`));
      try {
        return Promise.resolve(impl[method]?.(...args));
      } catch (err) {
        return Promise.reject(err);
      }
    },
  });
  return { ctx: { api: at([]) } as any, calls };
}

/** What a 3.8 host offers: spending's categories and rules already, none of the 3.9 calls. */
const HOST_38 = ['activities.search', 'activities.saveMany', 'accounts.getAll', 'spending.isEnabled', 'spending.getCategories', 'spending.getRules'];
const HOST_39 = [...HOST_38, ...METHODS];
const EMPTY = { items: [], totalCount: 0 };

describe('hostCan — the one check before any SDK 3.9 call', () => {
  it('on a Wealthfolio 3.8 host says no to every 3.9 call, and calls nothing but the probe', async () => {
    const { ctx, calls } = sandbox(HOST_38, { 'spending.isEnabled': () => true });
    for (const m of METHODS) expect(await hostCan(ctx, m)).toBe(false);
    expect(calls).toEqual(['spending.searchCashActivities']);
  });

  it('on a 3.9 or 3.10 host says yes, after one cash search no row can match', async () => {
    const search = vi.fn(() => EMPTY);
    const { ctx, calls } = sandbox(HOST_39, { 'spending.searchCashActivities': search });
    for (const m of METHODS) expect(await hostCan(ctx, m)).toBe(true);
    expect(calls).toEqual(['spending.searchCashActivities']);
    expect(search).toHaveBeenCalledWith({ startDate: '1970-01-01T00:00:00.000Z', endDate: '1970-01-01T00:00:00.000Z', offset: 0, limit: 1 });
  });

  it('says no, for good, when the manifest lacks the permission', async () => {
    const { ctx, calls } = sandbox(HOST_39, {
      'spending.searchCashActivities': () => {
        const err = new Error("Addon 'simplefin-sync' is not allowed to call activities.searchCashActivities");
        err.name = 'AddonPermissionDenied';
        throw err;
      },
    });
    expect(await hostCan(ctx, 'activities.linkTransfer')).toBe(false);
    expect(await hostCan(ctx, 'spending.searchCashActivities')).toBe(false);
    expect(calls).toEqual(['spending.searchCashActivities']);
  });

  it('does not remember a passing failure', async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(EMPTY);
    const { ctx } = sandbox(HOST_39, { 'spending.searchCashActivities': search });
    expect(await hostCan(ctx, 'activities.linkTransfer')).toBe(false);
    expect(await hostCan(ctx, 'activities.linkTransfer')).toBe(true);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('says no without calling anything when the host object has no such function', async () => {
    const searchCashActivities = vi.fn(async () => EMPTY);
    const plain = { api: { activities: { search: vi.fn() }, spending: { searchCashActivities } } } as any;
    expect(await hostCan(plain, 'activities.linkTransfer')).toBe(false);
    expect(await hostCan({ api: {} } as any, 'spending.searchCashActivities')).toBe(false);
    expect(searchCashActivities).not.toHaveBeenCalled();
  });

  it('asks each context once, however many calls check at the same time', async () => {
    const search = vi.fn(async () => EMPTY);
    const { ctx } = sandbox(HOST_39, { 'spending.searchCashActivities': search });
    expect(await Promise.all(METHODS.map((m) => hostCan(ctx, m)))).toEqual(METHODS.map(() => true));
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe('manifest.json declares what the 3.9 calls need, and still installs on 3.8', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '../../manifest.json'), 'utf8')) as {
    sdkVersion: string;
    minWealthfolioVersion: string;
    permissions: Array<{ category: string; functions: Array<string | { name: string; isDeclared?: boolean }>; purpose: string }>;
  };
  const declared = new Set(manifest.permissions.flatMap((p) => p.functions.map((f) => `${p.category}:${typeof f === 'string' ? f : f.name}`)));

  it('builds against SDK 3.9.0 and keeps Wealthfolio 3.8.0 as the minimum', () => {
    expect(manifest.sdkVersion).toBe('3.9.0');
    expect(manifest.minWealthfolioVersion).toBe('3.8.0');
  });

  it('declares the permission behind every 3.9 call, and spending categories for the story', () => {
    for (const [category, fn] of Object.values(SDK39_PERMISSIONS)) expect(declared.has(`${category}:${fn}`)).toBe(true);
    expect(declared.has('spending:getCategories')).toBe(true);
  });

  it('declares only functions the SDK 3.9 permission catalogue lists', () => {
    const known = new Set(PERMISSION_CATEGORIES.flatMap((c) => c.functions.map((f) => `${c.id}:${f}`)));
    // `ui` and `navigation` are host categories the catalogue does not list.
    const checked = [...declared].filter((k) => !k.startsWith('ui:') && !k.startsWith('navigation:'));
    expect(checked.filter((k) => !known.has(k))).toEqual([]);
  });

  it('gives every permission a purpose', () => {
    for (const p of manifest.permissions) expect(p.purpose.trim()).not.toBe('');
  });
});
