/**
 * src/utils/audit-fix.ts
 *
 * The add-on's half of the fixes (2c R2, spec C): what Link
 * (shared/audit-link.ts) and Remove for good (shared/tx-remove.ts) read and
 * write through the add-on SDK. Rows are
 * re-read by exact id — Wealthfolio 3.8's `activityIds` search filter, the
 * read the story uses (src/utils/tx-story.ts) — and written through
 * `AddonSyncHost`, whose `linkPair` is the sync's own linker: in place on a
 * Wealthfolio 3.9+ host, else `linkPairByRecreate`.
 *
 * The add-on cannot count on reading a row's group back, so a row is
 * confirmed linked by a group the host does report or by the add-on's own
 * `linked_groups` ledger; otherwise `linkedState`'s rule for a row the
 * snapshot read unpaired decides "maybe". A pair linked here goes into that
 * ledger too: it is how the add-on's sync knows to leave both legs as stored.
 * Remove has no snapshot behind it, so a transfer-typed row nothing marks as
 * unpaired may be linked (the change log's own rule) and is refused.
 * Every store method is optional-called.
 */
import type { ActivitySearchFilters, AddonContext } from '@wealthfolio/addon-sdk';
import type { HealthLeg } from '../../shared/audit-health';
import { linkPairs, LINK_DONE, type LinkIo, type LinkPair, type LinkRun, type ReadRow } from '../../shared/audit-link';
import { fixRowOf, linkedState, type FixRow } from '../../shared/fix-row';
import { ledgerGroupId } from '../../shared/link-in-place';
import type { HeldTransfer } from '../../shared/held-transfers';
import { isTransferType, txIdFromComment } from '../../shared/sync-core';
import { isUnreadableOverridesError, notTransferEdit, SYNC_OVERRIDES_UNREADABLE_MESSAGE } from '../../shared/sync-overrides';
import { removeForGood, type RemoveIo, type RemoveOutcome } from '../../shared/tx-remove';
import { sfinIdsFor } from '../../shared/tx-story';
import { linkedOfFact } from '../../shared/wf-facts';
import { AddonSyncHost } from './addon-host';
import type { SecretsStore } from './secrets';
import { readCashFacts } from './wf-facts';
import { beginWrite, writeRefusal } from './write-lock';

/** The store methods the fixes use, every one optional. */
export type FixStore = Partial<Pick<SecretsStore,
  'readSyncOverrides' | 'getLinkedGroups' | 'setLinkedGroups' | 'recordChange' | 'getAccountMapping'>>;

export const warn = (msg: string) => console.warn(`[simplefin-sync] ${msg}`);

const accountTypes = async (ctx: AddonContext) =>
  new Map((await ctx.api.accounts.getAll()).map((a) => [a.id, String(a.accountType ?? '')]));

/** One row by id, as the fixes read it; null when it is gone. */
async function readFixRow(ctx: AddonContext, activityId: string, types: Map<string, string>): Promise<FixRow | null> {
  const filters = { activityIds: [activityId] } as ActivitySearchFilters;
  const res = await ctx.api.activities.search(0, 1, filters, '');
  const hit = (res.data ?? []).find((a) => a.id === activityId);
  return hit ? fixRowOf(hit, types.get(hit.accountId) ?? '') : null;
}

/** The ledger as stored must be a plain object (the store's getter only JSON.parses, so an
 *  array or a string would otherwise read as "no pairs" and be written over). */
function plainLedger(v: unknown): Record<string, string> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('linked_groups is not a plain object');
  return v as Record<string, string>;
}

/** The add-on's ledger of pairs; null when it cannot be read (no evidence either way). */
async function ledgerOf(store: FixStore): Promise<Record<string, string> | null> {
  try {
    return plainLedger((await store.getLinkedGroups?.()) ?? {});
  } catch {
    return null;
  }
}

const ledgerKnows = (ledger: Record<string, string> | null, keys: readonly string[], txId: string | null) =>
  !!ledger && (keys.some((k) => ledger[k] !== undefined) || (!!txId && ledger[txId] !== undefined));

export function addonLinkIo(ctx: AddonContext, store: FixStore, log: (msg: string) => void = warn): LinkIo {
  const host = new AddonSyncHost(ctx, { log });
  return {
    read: async (pair: LinkPair) => {
      const types = await accountTypes(ctx);
      const ledger = await ledgerOf(store);
      const rows = [await readFixRow(ctx, pair.leg.activityId, types), await readFixRow(ctx, pair.counterpart.activityId, types)];
      // Wealthfolio 3.9+: linked or not on its own word (U3), never "maybe".
      const facts = await readCashFacts(ctx, rows.flatMap((r) => (r ? [{ id: r.id, accountId: r.accountId, date: r.date }] : [])));
      const one = (row: FixRow | null, leg: HealthLeg): ReadRow | null => {
        if (!row) return null;
        const fact = facts?.get(row.id);
        if (fact) return { row, linked: linkedOfFact(fact) };
        const knows = ledgerKnows(ledger, leg.txKey ? [leg.txKey] : [], txIdFromComment(row.notes));
        return { row, linked: linkedState(row, { readsGroups: false, ledgerKnows: knows, unpairedWhenRead: true }) };
      };
      return [one(rows[0], pair.leg), one(rows[1], pair.counterpart)];
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
      const ledger = plainLedger(await store.getLinkedGroups());
      // A pair linked in place carries Wealthfolio's own group: kept under the prefix the sync keeps.
      await store.setLinkedGroups({ ...ledger, [keys[0]]: ledgerGroupId(groupId), [keys[1]]: ledgerGroupId(groupId) });
    },
    record: async (draft) => {
      await store.recordChange?.(draft);
    },
    log,
  };
}

/** Link from Settings → Checks. Holds the add-on's write lock (src/utils/write-lock.ts):
 *  refused while a sync is running, and a sync that starts meanwhile waits. */
export async function linkFromApp(ctx: AddonContext, store: FixStore, pairs: LinkPair[]): Promise<LinkRun> {
  const release = beginWrite();
  if (!release) {
    return { total: pairs.length, linked: 0, changed: 0, failed: 0, done: [], lost: [], maybeLost: [], message: writeRefusal('link') };
  }
  try {
    const io = addonLinkIo(ctx, store);
    // A pair that linked but did not reach `linked_groups`: say so, the run still stands.
    const unnoted: string[] = [];
    const remember = io.remember;
    if (remember) {
      io.remember = async (keys, groupId) => {
        try {
          await remember(keys, groupId);
        } catch (err) {
          unnoted.push(err instanceof Error ? err.message : String(err));
          throw err;
        }
      };
    }
    const run = await linkPairs(pairs, io);
    if (unnoted.length === 0) return run;
    const note = `Linked, but the add-on couldn't note it (${unnoted[0].trim().replace(/[.\s]+$/, '')}) — check Health after the next sync.`;
    return { ...run, message: run.message === LINK_DONE ? note : `${run.message} ${note}` };
  } finally {
    release();
  }
}

export function addonRemoveIo(ctx: AddonContext, store: FixStore, log: (msg: string) => void = warn): RemoveIo {
  const host = new AddonSyncHost(ctx, { log });
  return {
    read: async (activityId) => readFixRow(ctx, activityId, await accountTypes(ctx)),
    feeds: async (wfAccountId) => sfinIdsFor((await store.getAccountMapping?.()) ?? {}, wfAccountId),
    linked: async (row, txKeys) => {
      // Wealthfolio 3.9+: linked or not on its own word (U3) — an unlinked transfer leg can go.
      const fact = (await readCashFacts(ctx, [{ id: row.id, accountId: row.accountId, date: row.date }]))?.get(row.id);
      if (fact) return linkedOfFact(fact);
      // The app's Remove never needs a transfer leg, and upstream treats a wf-transfer- group or
      // a "wealthfolio" transfer source as linked even when the row reads is_external:true.
      if (isTransferType(row.type.toUpperCase())) return 'confirmed';
      const ledger = await ledgerOf(store);
      return linkedState(row, { readsGroups: false, ledgerKnows: ledgerKnows(ledger, txKeys, txIdFromComment(row.notes)) });
    },
    secrets: {
      get: (k) => ctx.api.secrets.get(k),
      set: (k, v) => ctx.api.secrets.set(k, v),
    },
    remove: async (activityId) => {
      const res = await host.saveMany({ deleteIds: [activityId] });
      if (res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '));
    },
    record: async (draft) => {
      await store.recordChange?.(draft);
    },
    log,
  };
}

/** "Remove for good…" from a story in the app. Holds the add-on's write lock
 *  (src/utils/write-lock.ts), like Link: refused while a sync is running, and a
 *  sync that starts meanwhile waits. */
export async function removeFromApp(ctx: AddonContext, store: FixStore, activityId: string, fingerprint: string): Promise<RemoveOutcome> {
  const release = beginWrite();
  if (!release) return { ok: false, message: writeRefusal('remove') };
  try {
    return await removeForGood(activityId, fingerprint, addonRemoveIo(ctx, store), new Date());
  } finally {
    release();
  }
}

export const NOT_TRANSFER_FAILED = "Couldn't save that — nothing was changed.";

/**
 * "Not a transfer" on a transfer still in transit (1.65 C): records the
 * `notTransfer` override the next sync obeys. The write goes only through
 * `editSyncOverrides`, which re-reads before writing (the companion is a
 * second writer). It touches the overrides document alone, which the sync
 * reads at its start, so it takes no write lock. An older store without
 * `editSyncOverrides`, or a row with no bank transaction to name, writes nothing.
 */
export async function notTransferFromApp(
  store: Partial<Pick<SecretsStore, 'editSyncOverrides'>>, h: HeldTransfer, now: Date = new Date(),
): Promise<string> {
  if (!h.txKey || !store.editSyncOverrides) return NOT_TRANSFER_FAILED;
  try {
    await store.editSyncOverrides(notTransferEdit(h.txKey, h.label, now));
    return `Saved — the next sync counts it as ${h.direction === 'out' ? 'spending' : 'money in'}.`;
  } catch (err) {
    return isUnreadableOverridesError(err) ? SYNC_OVERRIDES_UNREADABLE_MESSAGE : NOT_TRANSFER_FAILED;
  }
}
