/**
 * src/utils/host-can.ts
 *
 * The one feature check for the add-on SDK 3.9 calls (1.62.0, U1). Every 3.9
 * call the add-on makes goes through `hostCan` first; where it says no, the
 * add-on does what it did on 3.8. `minWealthfolioVersion` stays 3.8.0.
 *
 * Why not `typeof ctx.api.activities?.linkTransfer === 'function'`: inside
 * Wealthfolio's add-on sandbox `ctx.api` is a Proxy on which EVERY path is a
 * callable function (upstream addon-sandbox-entry.tsx `createApiProxy`, 3.8
 * through 3.10). A 3.8 host only refuses the call: it rejects with "Unknown
 * addon host API method '<name>'" (addon-iframe-manager.ts `getMethod`,
 * against `ALLOWED_API_METHODS`). Nor can the probe be `spending.isEnabled`:
 * 3.8 already offers it, `getCategories` and the rule calls (type-bridge.ts,
 * v3.8.0). So the check makes the cheapest call only 3.9+ offers — a cash
 * search no row can match — once per context:
 *  - it resolves: a 3.9+ host, whose allowed-method list carries every call
 *    below (3.9.0 through 3.10.0);
 *  - "Unknown addon host API method" (a 3.8 host) or "is not allowed to call"
 *    (`AddonPermissionDenied`, a manifest without the permission): no, and
 *    remembered;
 *  - anything else (a passing failure): no for now, and not remembered.
 * A host object that has no such function at all (a test double, a future
 * host) is a plain no. Nothing else is ever called here.
 */
import type { AddonContext, CashActivitySearchRequest } from '@wealthfolio/addon-sdk';

/** The SDK 3.9 calls the add-on makes, by `<api namespace>.<method>`. */
export type Sdk39Method =
  | 'activities.linkTransfer'
  | 'activities.unlinkTransfer'
  | 'activities.getTransferPair'
  | 'spending.searchCashActivities';

/**
 * The manifest permission each call needs: `[category, function]`. Not always
 * its namespace — Wealthfolio guards `spending.searchCashActivities` under the
 * high-risk `activities` category (upstream type-bridge.ts, v3.9.0).
 */
export const SDK39_PERMISSIONS: Readonly<Record<Sdk39Method, readonly [string, string]>> = {
  'activities.linkTransfer': ['activities', 'linkTransfer'],
  'activities.unlinkTransfer': ['activities', 'unlinkTransfer'],
  'activities.getTransferPair': ['activities', 'getTransferPair'],
  'spending.searchCashActivities': ['activities', 'searchCashActivities'],
};

/** A cash search no row can match: one day in 1970, one row at most. */
const PROBE: CashActivitySearchRequest = {
  startDate: '1970-01-01T00:00:00.000Z', endDate: '1970-01-01T00:00:00.000Z', offset: 0, limit: 1,
};

/** The host's answer, per context. */
const answers = new WeakMap<object, Promise<boolean>>();

/** A refusal that will not change while the add-on runs. */
const LASTING = /Unknown addon host API method|is not allowed to call|AddonPermissionDenied/i;

const fnAt = (ctx: AddonContext, method: string): unknown => {
  const [ns, name] = method.split('.');
  const api = (ctx as unknown as { api?: Record<string, Record<string, unknown> | undefined> }).api;
  return api?.[ns]?.[name];
};

async function probe(ctx: AddonContext): Promise<{ yes: boolean; lasting: boolean }> {
  if (typeof fnAt(ctx, 'spending.searchCashActivities') !== 'function') return { yes: false, lasting: true };
  try {
    // Called as a method, never through `.call`: on the sandbox's Proxy
    // `.call` is one more path ("spending.searchCashActivities.call"), which
    // no host offers.
    await ctx.api.spending.searchCashActivities(PROBE);
    return { yes: true, lasting: true };
  } catch (err) {
    const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    return { yes: false, lasting: LASTING.test(text) };
  }
}

/** Whether the host offers this SDK 3.9 call. Never rejects. */
export async function hostCan(ctx: AddonContext, method: Sdk39Method): Promise<boolean> {
  if (typeof fnAt(ctx, method) !== 'function') return false;
  const known = answers.get(ctx);
  if (known) return known;
  const asking = probe(ctx).then(({ yes, lasting }) => {
    if (!lasting) answers.delete(ctx);
    return yes;
  });
  answers.set(ctx, asking);
  return asking;
}
