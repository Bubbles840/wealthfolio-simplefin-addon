/**
 * companion/src/audit-fix-host.ts
 *
 * The companion's half of the fixes (2c R2, spec C): what Link
 * (shared/audit-link.ts) and Remove for good (shared/tx-remove.ts) read and
 * write, bound to one Wealthfolio client. Rows are re-read live over REST by
 * exact id (`activityIdFilter`); each carries its group, so on the companion
 * a row is linked or not — never "maybe". Writes go through `RestSyncHost`,
 * whose `linkPair` is the sync's own linker (Wealthfolio's link in place,
 * else `linkPairByRecreate`), and entries land
 * in the companion's bucket of the change log through its one writer.
 */
import type { LinkIo, LinkPair, ReadRow } from '../../shared/audit-link.js';
import { fixRowOf, linkedState, type FixRow } from '../../shared/fix-row.js';
import { loadSyncOverrides } from '../../shared/sync-overrides.js';
import { parseAccountMapping, type RemoveIo } from '../../shared/tx-remove.js';
import { sfinIdsFor } from '../../shared/tx-story.js';
import { recordCompanionChangesStrict, type SecretClient } from './change-log-host.js';
import { RestSyncHost } from './rest-host.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** What the fixes need of a `WealthfolioClient`. */
export type FixClient = SecretClient & Pick<WealthfolioClient, 'searchActivities' | 'getAccounts' | 'saveMany'>;

const accountTypes = async (client: FixClient) =>
  new Map((await client.getAccounts()).map((a) => [a.id, String(a.accountType ?? '')]));

/** One activity by exact id, as REST reports it; null when it is gone. The one reader the
 *  fixes and the paybacks share. Rejects when unreachable. */
export async function readActivityById(client: Pick<WealthfolioClient, 'searchActivities'>, activityId: string) {
  const items = await client.searchActivities({ page: 0, pageSize: 1, activityIdFilter: [activityId] });
  return items.find((a) => a.id === activityId) ?? null;
}

/** One row by id, as the fixes read it; null when it is gone. */
async function readFixRow(client: FixClient, activityId: string, types: Map<string, string>): Promise<FixRow | null> {
  const hit = await readActivityById(client, activityId);
  return hit ? fixRowOf(hit, types.get(hit.accountId) ?? '') : null;
}

const restHost = (client: FixClient, log?: (msg: string) => void) => new RestSyncHost(client as unknown as WealthfolioClient, undefined, log ? { log } : {});

export function companionLinkIo(client: FixClient, log: (msg: string) => void): LinkIo {
  const host = restHost(client, log);
  return {
    read: async (pair: LinkPair) => {
      const types = await accountTypes(client);
      const one = async (activityId: string): Promise<ReadRow | null> => {
        const row = await readFixRow(client, activityId, types);
        return row ? { row, linked: linkedState(row, { readsGroups: true, ledgerKnows: false }) } : null;
      };
      return [await one(pair.leg.activityId), await one(pair.counterpart.activityId)];
    },
    overrides: () => loadSyncOverrides((k) => client.getAddonSecret(ADDON_ID, k)),
    link: (legs) => host.linkPair(legs),
    restore: (writes) => host.saveMany({ creates: writes }),
    record: (draft) => recordCompanionChangesStrict(client, [draft]),
    log,
  };
}

export function companionRemoveIo(client: FixClient, log: (msg: string) => void): RemoveIo {
  const host = restHost(client, log);
  return {
    read: async (activityId) => readFixRow(client, activityId, await accountTypes(client)),
    feeds: async (wfAccountId) => sfinIdsFor(parseAccountMapping(await client.getAddonSecret(ADDON_ID, 'account_mapping')), wfAccountId),
    linked: async (row) => linkedState(row, { readsGroups: true, ledgerKnows: false }),
    secrets: {
      get: (k) => client.getAddonSecret(ADDON_ID, k),
      set: (k, v) => client.setAddonSecret(ADDON_ID, k, v),
    },
    remove: async (activityId) => {
      const res = await host.saveMany({ deleteIds: [activityId] });
      if (res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '));
    },
    record: (draft) => recordCompanionChangesStrict(client, [draft]),
    log,
  };
}
