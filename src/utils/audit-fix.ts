/**
 * src/utils/audit-fix.ts
 *
 * The add-on's half of the fixes (2c R2, spec C): what Link
 * (shared/audit-link.ts) reads and writes through the add-on SDK. Rows are
 * re-read by exact id — Wealthfolio 3.8's `activityIds` search filter, the
 * read the story uses (src/utils/tx-story.ts) — and written through
 * `AddonSyncHost`, whose `linkPair` is the sync's own `linkPairByRecreate`.
 *
 * The add-on cannot count on reading a row's group back, so a row is
 * confirmed linked by a group the host does report or by the add-on's own
 * `linked_groups` ledger; otherwise `linkedState`'s rule for a row the
 * snapshot read unpaired decides "maybe". A pair linked here goes into that
 * ledger too: it is how the add-on's sync knows to leave both legs as stored.
 * Every store method is optional-called.
 */
import type { ActivitySearchFilters, AddonContext } from '@wealthfolio/addon-sdk';
import type { HealthLeg } from '../../shared/audit-health';
import { linkPairs, type LinkIo, type LinkPair, type LinkRun, type ReadRow } from '../../shared/audit-link';
import { fixRowOf, linkedState, type FixRow } from '../../shared/fix-row';
import { txIdFromComment } from '../../shared/sync-core';
import { AddonSyncHost } from './addon-host';
import type { SecretsStore } from './secrets';

/** The store methods the fixes use, every one optional. */
export type FixStore = Partial<Pick<SecretsStore,
  'readSyncOverrides' | 'getLinkedGroups' | 'setLinkedGroups' | 'recordChange'>>;

const warn = (msg: string) => console.warn(`[simplefin-sync] ${msg}`);

const accountTypes = async (ctx: AddonContext) =>
  new Map((await ctx.api.accounts.getAll()).map((a) => [a.id, String(a.accountType ?? '')]));

/** One row by id, as the fixes read it; null when it is gone. */
async function readFixRow(ctx: AddonContext, activityId: string, types: Map<string, string>): Promise<FixRow | null> {
  const filters = { activityIds: [activityId] } as ActivitySearchFilters;
  const res = await ctx.api.activities.search(0, 1, filters, '');
  const hit = (res.data ?? []).find((a) => a.id === activityId);
  return hit ? fixRowOf(hit, types.get(hit.accountId) ?? '') : null;
}

/** The add-on's ledger of pairs; null when it cannot be read (no evidence either way). */
async function ledgerOf(store: FixStore): Promise<Record<string, string> | null> {
  try {
    return (await store.getLinkedGroups?.()) ?? {};
  } catch {
    return null;
  }
}

const ledgerKnows = (ledger: Record<string, string> | null, keys: readonly string[], txId: string | null) =>
  !!ledger && (keys.some((k) => ledger[k] !== undefined) || (!!txId && ledger[txId] !== undefined));

export function addonLinkIo(ctx: AddonContext, store: FixStore, log: (msg: string) => void = warn): LinkIo {
  const host = new AddonSyncHost(ctx);
  return {
    read: async (pair: LinkPair) => {
      const types = await accountTypes(ctx);
      const ledger = await ledgerOf(store);
      const one = async (leg: HealthLeg): Promise<ReadRow | null> => {
        const row = await readFixRow(ctx, leg.activityId, types);
        if (!row) return null;
        const knows = ledgerKnows(ledger, leg.txKey ? [leg.txKey] : [], txIdFromComment(row.notes));
        return { row, linked: linkedState(row, { readsGroups: false, ledgerKnows: knows, unpairedWhenRead: true }) };
      };
      return [await one(pair.leg), await one(pair.counterpart)];
    },
    overrides: async () => {
      const loaded = await store.readSyncOverrides?.();
      if (!loaded) throw new Error("the overrides couldn't be read");
      return loaded;
    },
    link: (legs) => host.linkPair(legs),
    restore: (writes) => host.saveMany({ creates: writes }),
    remember: async (keys, groupId) => {
      if (!store.getLinkedGroups || !store.setLinkedGroups) return;
      // Re-read right before the write (the add-on's sync writes it too); a
      // ledger that cannot be read throws here and is never overwritten.
      const ledger = await store.getLinkedGroups();
      await store.setLinkedGroups({ ...ledger, [keys[0]]: groupId, [keys[1]]: groupId });
    },
    record: async (draft) => {
      await store.recordChange?.(draft);
    },
    log,
  };
}

/** Link from Settings → Checks. */
export function linkFromApp(ctx: AddonContext, store: FixStore, pairs: LinkPair[]): Promise<LinkRun> {
  return linkPairs(pairs, addonLinkIo(ctx, store));
}
