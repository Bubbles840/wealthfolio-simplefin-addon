/**
 * src/utils/app-payback.ts
 *
 * The add-on's half of a payback (1.62.0, W11): what `filePaybackInApp`
 * (shared/payback-app-file.ts) reads and writes through the add-on SDK.
 *  - The row is re-read by exact id (Wealthfolio 3.8's `activityIds` filter,
 *    the read the story makes), with its account's type and stored instant.
 *  - Wealthfolio's facts come from `searchCashActivities`
 *    (src/utils/wf-facts.ts), behind `hostCan`.
 *  - The one-off rule goes through `spending.getRules`, `saveRule`,
 *    `deleteRule` and `rerunRules(true)` (manifest: `spending`; Wealthfolio
 *    offers them since 3.8, so `hostCan`'s 3.9 probe is what gates them).
 *  - The re-type goes through `AddonSyncHost.saveMany`; the entry through the
 *    store's strict append.
 * A payback holds the add-on's write lock, as Remove for good does. Every
 * call is made as a method on `ctx.api` (the sandbox's Proxy treats `.call`
 * as one more path).
 */
import type { ActivitySearchFilters, AddonContext } from '@wealthfolio/addon-sdk';
import { ACCOUNT_MAPPING_SECRET_KEY } from '../../shared/change-undo-run';
import { paybackRowOf } from '../../shared/payback';
import { appPaybackGate, paybackCategoriesOf, paybackPickList, type PaybackCategory } from '../../shared/payback-app';
import { filePaybackInApp, type AppPaybackChoice, type AppPaybackIo, type AppPaybackOutcome } from '../../shared/payback-app-file';
import { PAYBACK_COMPANION_UNKNOWN } from '../../shared/payback-copy';
import type { PaybackRow } from '../../shared/payback-row';
import { parseAccountMapping } from '../../shared/tx-remove';
import { sfinIdsFor } from '../../shared/tx-story';
import { AddonSyncHost } from './addon-host';
import { hostCan } from './host-can';
import type { SecretsStore } from './secrets';
import { readCashFacts } from './wf-facts';
import { beginWrite, writeRefusal } from './write-lock';

/** The store methods a payback uses, each optional-called. */
export type PaybackStore = Partial<Pick<SecretsStore, 'getCompanionVersion' | 'recordChangeStrict'>>;

const warn = (msg: string) => console.warn(`[simplefin-sync] ${msg}`);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether the app offers "It's a payback…" at all: a companion of 1.62.0 or
 *  newer, and a Wealthfolio that offers its facts (3.9+). The companion is
 *  judged first, so nothing is probed without one. Never rejects. */
export async function appPaybacksOffered(ctx: AddonContext, companionVersion: string | null): Promise<boolean> {
  if (appPaybackGate({ hostOffersFacts: true, companionVersion }) !== null) return false;
  return appPaybackGate({ hostOffersFacts: await hostCan(ctx, 'spending.searchCashActivities'), companionVersion }) === null;
}

/** The categories the picker offers (`paybackPickList`). Rejects when they cannot be read. */
export async function readPaybackCategories(ctx: AddonContext): Promise<PaybackCategory[]> {
  return paybackPickList(paybackCategoriesOf(await ctx.api.spending.getCategories('expense')));
}

/** One row by exact id, as a payback reads it; null when it is gone. Rejects when unreachable. */
async function readPaybackRow(ctx: AddonContext, activityId: string): Promise<PaybackRow | null> {
  const types = new Map((await ctx.api.accounts.getAll()).map((a) => [a.id, String(a.accountType ?? '')]));
  const filters = { activityIds: [activityId] } as ActivitySearchFilters;
  const res = await ctx.api.activities.search(0, 1, filters, '');
  const hit = (res.data ?? []).find((a) => a.id === activityId);
  return hit ? paybackRowOf(hit, types.get(hit.accountId) ?? '') : null;
}

export function addonPaybackIo(ctx: AddonContext, store: PaybackStore, log: (msg: string) => void = warn): AppPaybackIo {
  const host = new AddonSyncHost(ctx, { log });
  return {
    gate: async () => {
      let companionVersion: string | null;
      try {
        companionVersion = (await store.getCompanionVersion?.()) ?? null;
      } catch (err) {
        log(`Payback: could not read the companion's version: ${errorText(err)}`);
        return PAYBACK_COMPANION_UNKNOWN;
      }
      return appPaybackGate({ hostOffersFacts: await hostCan(ctx, 'spending.searchCashActivities'), companionVersion });
    },
    read: (activityId) => readPaybackRow(ctx, activityId),
    feeds: async (wfAccountId) => sfinIdsFor(parseAccountMapping(await ctx.api.secrets.get(ACCOUNT_MAPPING_SECRET_KEY)), wfAccountId),
    secrets: {
      get: (k) => ctx.api.secrets.get(k),
      set: (k, v) => ctx.api.secrets.set(k, v),
    },
    fact: async (row) => {
      const facts = await readCashFacts(ctx, [{ id: row.id, accountId: row.accountId, date: row.instant }]);
      if (!facts) throw new Error("Wealthfolio's facts could not be read");
      return facts.get(row.id) ?? null;
    },
    categories: async () => paybackCategoriesOf(await ctx.api.spending.getCategories()),
    rules: async () => (await ctx.api.spending.getRules()) ?? [],
    saveRule: async (rule) => {
      await ctx.api.spending.saveRule(rule);
    },
    deleteRule: async (ruleKey) => {
      await ctx.api.spending.deleteRule(ruleKey);
    },
    update: async (write) => {
      const res = await host.saveMany({ updates: [write] });
      if (res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '));
    },
    rerunRules: async () => {
      await ctx.api.spending.rerunRules(true);
    },
    record: async (draft) => (store.recordChangeStrict ? store.recordChangeStrict(draft) : false),
    log,
  };
}

/** "It's a payback…" from the app. Holds the add-on's write lock
 *  (src/utils/write-lock.ts), like Remove for good: refused while a sync is
 *  running, and a sync that starts meanwhile waits. Never rejects. */
export async function paybackFromApp(ctx: AddonContext, store: PaybackStore, choice: AppPaybackChoice): Promise<AppPaybackOutcome> {
  const release = beginWrite();
  if (!release) return { kind: 'refused', message: writeRefusal('remove') };
  try {
    return await filePaybackInApp(choice, addonPaybackIo(ctx, store), new Date());
  } finally {
    release();
  }
}
