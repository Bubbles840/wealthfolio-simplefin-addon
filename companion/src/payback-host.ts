/**
 * companion/src/payback-host.ts
 *
 * The companion's half of a payback (1.62.0, W6–W8): what `filePayback`
 * (shared/payback.ts) and a payback's Undo read and write, bound to one
 * Wealthfolio client. The row is re-read live over REST by exact id
 * (`activityIdFilter`, Wealthfolio 3.8), with its account's type and its
 * stored instant; the re-type goes through the bulk endpoint, the category
 * through `PUT …/assignments`, and the entry through the companion's one
 * change-log writer. Telegram's paybacks wait for an INSTALLED add-on that
 * reads `asReimbursement` (W8).
 */
import { SPENDING_TAXONOMY_ID } from '../../shared/cash-flow-bucket.js';
import { addonPaybackGate, paybackRowOf, type PaybackIo } from '../../shared/payback.js';
import type { PaybackRow } from '../../shared/payback-row.js';
import { sfinIdsFor } from '../../shared/tx-story.js';
import { recordCompanionChanges, type SecretClient } from './change-log-host.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** What a payback needs of a `WealthfolioClient`. */
export type PaybackClient = SecretClient & Pick<WealthfolioClient, 'searchActivities' | 'getAccounts' | 'saveMany' | 'assignActivityCategory'>;

/** One row by exact id, as a payback reads it; null when it is gone. Rejects when unreachable. */
export async function readPaybackRow(client: Pick<WealthfolioClient, 'searchActivities' | 'getAccounts'>, activityId: string): Promise<PaybackRow | null> {
  const types = new Map((await client.getAccounts()).map((a) => [a.id, String(a.accountType ?? '')]));
  const items = await client.searchActivities({ page: 0, pageSize: 1, activityIdFilter: [activityId] });
  const hit = items.find((a) => a.id === activityId);
  return hit ? paybackRowOf(hit, types.get(hit.accountId) ?? '') : null;
}

export function companionPaybackIo(client: PaybackClient, log: (msg: string) => void): PaybackIo {
  const get = (k: string) => client.getAddonSecret(ADDON_ID, k);
  return {
    gate: () => addonPaybackGate(get),
    read: (activityId) => readPaybackRow(client, activityId),
    feeds: async (wfAccountId) => {
      const raw = await get('account_mapping');
      return sfinIdsFor(raw ? (JSON.parse(raw) as Record<string, string>) : {}, wfAccountId);
    },
    secrets: { get, set: (k, v) => client.setAddonSecret(ADDON_ID, k, v) },
    update: async (write) => {
      const res = await client.saveMany({ updates: [write] });
      const errors = (res.errors ?? []) as Array<{ message?: unknown }>;
      if (errors.length > 0) throw new Error(errors.map((e) => String(e.message ?? '')).join('; '));
    },
    assign: (activityId, categoryId) => client.assignActivityCategory(activityId, SPENDING_TAXONOMY_ID, categoryId),
    record: (draft) => recordCompanionChanges(client, [draft]),
    log,
  };
}
