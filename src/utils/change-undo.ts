/**
 * src/utils/change-undo.ts
 *
 * Undo and Redo from the app's Change log card, through the shared runner
 * (shared/change-undo-run.ts). The add-on reaches activities and settings
 * only: a category or a rule entry is undone from Telegram (`/changes`), and
 * the card says so. A sync decision's Undo waits for a companion that obeys
 * overrides — the version it publishes decides (`companion_version`).
 *
 * The reversal entry is recorded in the add-on's own bucket through the
 * store's one writer.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { ChangeLogItem } from '../../shared/change-log';
import type { UndoOp } from '../../shared/change-undo';
import { runChangeUndo, type UndoIo, type UndoOutcome } from '../../shared/change-undo-run';
import { AddonSyncHost } from './addon-host';
import type { SecretsStore } from './secrets';

export function addonUndoIo(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): UndoIo {
  return {
    host: new AddonSyncHost(ctx),
    secrets: {
      get: (k) => ctx.api.secrets.get(k),
      set: (k, v) => ctx.api.secrets.set(k, v),
    },
    record: (draft) => store.recordChange(draft),
    where: { host: 'addon', companionVersion },
  };
}

/** One Undo or Redo, decided against the log as the card last read it. */
export async function undoFromApp(
  ctx: AddonContext,
  store: SecretsStore,
  entry: ChangeLogItem,
  entries: ChangeLogItem[],
  op: UndoOp,
): Promise<UndoOutcome> {
  const companionVersion = await (store.getCompanionVersion?.() ?? Promise.resolve(null)).catch(() => null);
  return runChangeUndo(entry, entries, op, addonUndoIo(ctx, store, companionVersion));
}
