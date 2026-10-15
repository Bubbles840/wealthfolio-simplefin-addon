/**
 * companion/src/change-log-host.ts
 *
 * The companion's half of the change log (shared/change-log.ts): ONE writer
 * for the whole process, so the sync and a Telegram tap that land in the same
 * moment append through one queue and never overwrite each other. Storage is
 * the add-on's secrets over REST, which has no delete: a key is cleared by
 * writing `''`, which the reader treats as absent.
 */
import { newRunId, stampChange, type ChangeDraft, type ChangeLogSink } from '../../shared/change-entries.js';
import {
  createChangeLogWriter, readChangeLog, type ChangeLogIo, type ChangeLogRead, type ChangeLogWriter,
} from '../../shared/change-log.js';

const ADDON_ID = 'simplefin-sync';

/** What the change log needs of a `WealthfolioClient`. */
export interface SecretClient {
  getAddonSecret(addonId: string, key: string): Promise<string | null>;
  setAddonSecret(addonId: string, key: string, value: string): Promise<void>;
}

/** The process's writer. Tests make their own with `createChangeLogWriter`. */
export const companionChangeLog: ChangeLogWriter = createChangeLogWriter({
  writer: 'companion',
  log: (msg) => console.log(`[simplefin-sync] ${msg}`),
});

export function companionChangeLogIo(client: SecretClient): ChangeLogIo {
  return {
    get: (k) => client.getAddonSecret(ADDON_ID, k),
    set: (k, v) => client.setAddonSecret(ADDON_ID, k, v),
    clear: (k) => client.setAddonSecret(ADDON_ID, k, ''),
  };
}

/** What a companion sync hands `runSyncCore`: a fresh run id, this writer. */
export function companionChangeSink(
  client: SecretClient,
  now = new Date(),
  writer: ChangeLogWriter = companionChangeLog,
): ChangeLogSink {
  return {
    writer: 'companion',
    run: newRunId('companion', now),
    append: (entries) => writer.append(companionChangeLogIo(client), entries),
  };
}

/**
 * Stamps and appends drafts: a Telegram action (no run), or an after-sync
 * step (the sync's run). Never rejects — a failed append is a gap record on
 * the next one.
 */
export async function recordCompanionChanges(
  client: SecretClient,
  drafts: ChangeDraft[],
  run?: string,
  now = new Date(),
  writer: ChangeLogWriter = companionChangeLog,
): Promise<void> {
  if (drafts.length === 0) return;
  await writer.append(companionChangeLogIo(client), drafts.map((d) => stampChange(d, 'companion', now, run)));
}

/**
 * As `recordCompanionChanges`, but THROWS when this append was not written (the gap
 * record is still left): for a caller that tells the person whether an Undo exists.
 */
export async function recordCompanionChangesStrict(
  client: SecretClient,
  drafts: ChangeDraft[],
  run?: string,
  now = new Date(),
  writer: ChangeLogWriter = companionChangeLog,
): Promise<void> {
  if (drafts.length === 0) return;
  const { saved } = await writer.appendStrict(companionChangeLogIo(client), drafts.map((d) => stampChange(d, 'companion', now, run)));
  if (!saved) throw new Error('the change log was not written');
}

/** Both writers' log, merged. Rejects when Wealthfolio cannot be read. */
export function readCompanionChangeLog(client: SecretClient, now: Date): Promise<ChangeLogRead> {
  return readChangeLog((k) => client.getAddonSecret(ADDON_ID, k), now);
}
