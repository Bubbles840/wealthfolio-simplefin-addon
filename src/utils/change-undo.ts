/**
 * src/utils/change-undo.ts
 *
 * Undo and Redo from the app's Change log card, through the shared runner
 * (shared/change-undo-run.ts). The add-on reaches activities and settings
 * only: a category or a rule entry is undone from Telegram (`/changes`), and
 * the card says so. A sync decision's Undo waits for a companion that obeys
 * overrides — the version it publishes decides (`companion_version`); when
 * that cannot be read, the Undo is refused rather than let through.
 *
 * The reversal entry is recorded in the add-on's own bucket through the
 * store's one writer. Like Link and Remove, an Undo or Redo holds the add-on's
 * write lock (src/utils/write-lock.ts): refused while a sync or another change
 * runs, and a sync that starts meanwhile waits for it.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { ChangeLogItem } from '../../shared/change-log';
import { companionGateCovers, UNDO_VERSION_UNKNOWN, type UndoOp } from '../../shared/change-undo';
import { runChangeUndo, type UndoIo, type UndoOutcome } from '../../shared/change-undo-run';
import { linkedOfFact } from '../../shared/wf-facts';
import { AddonSyncHost } from './addon-host';
import { warn } from './audit-fix';
import type { SecretsStore } from './secrets';
import { readCashFacts } from './wf-facts';
import { beginWrite, writeRefusal } from './write-lock';

export function addonUndoIo(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): UndoIo {
  return {
    host: new AddonSyncHost(ctx, warn),
    secrets: {
      get: (k) => ctx.api.secrets.get(k),
      set: (k, v) => ctx.api.secrets.set(k, v),
    },
    record: (draft) => store.recordChange(draft),
    where: { host: 'addon', companionVersion },
    // Wealthfolio 3.9+: whether the row is linked, on its own word (U3).
    linkFact: async (a) => {
      const fact = (await readCashFacts(ctx, [{ id: a.id, accountId: a.accountId, date: a.date }]))?.get(a.id);
      return fact ? linkedOfFact(fact) : null;
    },
  };
}

/**
 * One Undo or Redo, decided against the log as the card last read it.
 *
 * A failed read of the companion's version is NOT "no companion" (that opens
 * the gate): the undos the gate covers are refused, and the rest go ahead.
 */
export async function undoFromApp(
  ctx: AddonContext,
  store: SecretsStore,
  entry: ChangeLogItem,
  entries: ChangeLogItem[],
  op: UndoOp,
): Promise<UndoOutcome> {
  const release = beginWrite();
  if (!release) return { ok: false, message: writeRefusal('undo') };
  try {
    let companionVersion: string | null;
    try {
      companionVersion = (await store.getCompanionVersion?.()) ?? null;
    } catch {
      if (companionGateCovers(entry, op)) return { ok: false, message: UNDO_VERSION_UNKNOWN };
      companionVersion = null;
    }
    return await runChangeUndo(entry, entries, op, addonUndoIo(ctx, store, companionVersion));
  } finally {
    release();
  }
}
