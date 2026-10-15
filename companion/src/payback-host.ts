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
import { MAPPING_RULES_SECRET_KEY } from '../../shared/change-undo-run.js';
import {
  addonPaybackGate, PAYBACK_RULE_PRIORITY, paybackBreadth, paybackRowOf, paybackRuleSince, type PaybackBreadth, type PaybackBreadthRow, type PaybackIo, type PaybackRulesIo,
} from '../../shared/payback.js';
import { PAYBACK_BREADTH_DAYS } from '../../shared/payback-copy.js';
import { descriptionFromComment } from '../../shared/sync-core.js';
import type { MappingRule } from '../../shared/types.js';
import type { PaybackRow } from '../../shared/payback-row.js';
import { parseAccountMapping } from '../../shared/tx-remove.js';
import { sfinIdsFor } from '../../shared/tx-story.js';
import { readActivityById } from './audit-fix-host.js';
import { recordCompanionChanges, recordCompanionChangesStrict, type SecretClient } from './change-log-host.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** What a payback needs of a `WealthfolioClient`. */
export type PaybackClient = SecretClient & Pick<WealthfolioClient, 'searchActivities' | 'getAccounts' | 'saveMany' | 'assignActivityCategory' | 'getActivityAssignments'>;

/** One row by exact id, as a payback reads it; null when it is gone. Rejects when unreachable. */
export async function readPaybackRow(client: Pick<WealthfolioClient, 'searchActivities' | 'getAccounts'>, activityId: string): Promise<PaybackRow | null> {
  const types = new Map((await client.getAccounts()).map((a) => [a.id, String(a.accountType ?? '')]));
  const hit = await readActivityById(client, activityId);
  return hit ? paybackRowOf(hit, types.get(hit.accountId) ?? '') : null;
}

export function companionPaybackIo(client: PaybackClient, log: (msg: string) => void): PaybackIo {
  const get = (k: string) => client.getAddonSecret(ADDON_ID, k);
  return {
    gate: () => addonPaybackGate(get),
    read: (activityId) => readPaybackRow(client, activityId),
    feeds: async (wfAccountId) => {
      return sfinIdsFor(parseAccountMapping(await get('account_mapping')), wfAccountId);
    },
    secrets: { get, set: (k, v) => client.setAddonSecret(ADDON_ID, k, v) },
    update: async (write) => {
      const res = await client.saveMany({ updates: [write] });
      const errors = (res.errors ?? []) as Array<{ message?: unknown }>;
      if (errors.length > 0) throw new Error(errors.map((e) => String(e.message ?? '')).join('; '));
    },
    assign: (activityId, categoryId) => client.assignActivityCategory(activityId, SPENDING_TAXONOMY_ID, categoryId),
    assigned: async (activityId) => (await client.getActivityAssignments(activityId)).find((a) => a.taxonomyId === SPENDING_TAXONOMY_ID)?.categoryId ?? null,
    record: (draft) => recordCompanionChangesStrict(client, [draft]),
    log,
  };
}

/** What "Make every … deposit a payback" needs of a `WealthfolioClient`. */
export type PaybackRulesClient = SecretClient & Pick<WealthfolioClient, 'listCategorizationRules' | 'createCategorizationRule' | 'searchActivities'>;

/** W10 on the companion: the add-on's transaction rules (a secret) and
 *  Wealthfolio's categorization rules, at the same LOSING priority (50) and in
 *  the spending taxonomy as /categorize's rules. */
export function companionPaybackRulesIo(client: PaybackRulesClient, log: (msg: string) => void): PaybackRulesIo {
  const get = (k: string) => client.getAddonSecret(ADDON_ID, k);
  return {
    gate: () => addonPaybackGate(get),
    secrets: { get, set: (k, v) => client.setAddonSecret(ADDON_ID, k, v) },
    breadthRows: (accountId) => readBreadthRows(client, accountId, new Date()),
    categoryRules: async () => (await client.listCategorizationRules()).map((r) => ({
      id: r.id, pattern: r.pattern, categoryId: r.categoryId,
      ...(r.accountId ? { accountId: r.accountId } : {}), ...(r.activityType ? { activityType: r.activityType } : {}),
      ...(typeof r.priority === 'number' ? { priority: r.priority } : {}), ...(r.matchType ? { matchType: r.matchType } : {}),
      ...(r.taxonomyId ? { taxonomyId: r.taxonomyId } : {}), ...(r.amountOp ? { amountOp: r.amountOp } : {}),
    })),
    createCategoryRule: async (rule) => (await client.createCategorizationRule({ ...rule, taxonomyId: SPENDING_TAXONOMY_ID, priority: PAYBACK_RULE_PRIORITY })) ?? null,
    record: (draft) => recordCompanionChanges(client, [draft]),
    log,
  };
}

/** What the preview's breadth check needs of a `WealthfolioClient`. */
export type PaybackBreadthClient = SecretClient & Pick<WealthfolioClient, 'searchActivities'>;

const MONEY_IN_TYPES = ['DEPOSIT', 'CREDIT', 'TRANSFER_IN', 'INTEREST'];
const BREADTH_PAGE = 500;
const BREADTH_MAX_PAGES = 6;

/** The account's money-in rows of the last 90 days (REST), as the breadth and transfer checks read them. Rejects when unreadable. */
export async function readBreadthRows(client: Pick<WealthfolioClient, 'searchActivities'>, accountId: string, now: Date): Promise<PaybackBreadthRow[]> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const dateFrom = day(new Date(now.getTime() - PAYBACK_BREADTH_DAYS * 86_400_000));
  const rows: PaybackBreadthRow[] = [];
  for (let page = 0; page < BREADTH_MAX_PAGES; page += 1) {
    const items = await client.searchActivities({
      page, pageSize: BREADTH_PAGE, accountIdFilter: [accountId], activityTypeFilter: MONEY_IN_TYPES, dateFrom, dateTo: day(now),
    });
    for (const a of items) {
      const amount = Math.abs(Number(a.amount ?? 0));
      if (amount > 0) {
        rows.push({
          id: a.id, description: descriptionFromComment(a.comment), amount, type: a.activityType, ...(a.sourceGroupId ? { grouped: true } : {}),
        });
      }
    }
    if (items.length < BREADTH_PAGE) break;
  }
  return rows;
}

/** W10's preview, read live: the account's money-in rows of the last 90 days
 *  (REST), judged by the whole fresh `mapping_rules` list with the new rule
 *  first. Rejects when Wealthfolio or the secrets cannot be read. */
export async function companionPaybackBreadth(
  client: PaybackBreadthClient,
  input: { pattern: string; account: { id: string; name: string }; sourceId: string; description: string; waitingIds: string[] },
  now: Date = new Date(),
): Promise<PaybackBreadth> {
  const raw = await client.getAddonSecret(ADDON_ID, MAPPING_RULES_SECRET_KEY);
  let list: MappingRule[] = [];
  if (raw && raw.trim() !== '') {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('the transaction rules are unreadable');
    list = parsed as MappingRule[];
  }
  const rows = await readBreadthRows(client, input.account.id, now);
  return paybackBreadth({
    pattern: input.pattern, accountId: input.account.id, since: paybackRuleSince(now), source: { id: input.sourceId, description: input.description },
    list, rows, waitingIds: new Set(input.waitingIds),
  });
}
