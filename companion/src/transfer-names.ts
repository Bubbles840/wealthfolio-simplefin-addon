/**
 * companion/src/transfer-names.ts
 *
 * Publishes the learned transfer names (1.64, A4): reads the ledger from the
 * Wealthfolio database, learns the names (shared/learn-transfer-names.ts) and
 * writes them as the `transfer_names` add-on secret that both writers' syncs
 * read. Not transfer-learning.ts - that is the Telegram "make it a transfer
 * rule" menu, an unrelated feature.
 *
 * It never publishes from a read it cannot trust: an unreadable database or
 * unreadable overrides (a `notTransfer` the user set might be hiding in them)
 * keeps the PREVIOUS list rather than publishing one that could re-learn a
 * wording the user undid. No companion means no learning at all (R6).
 */
import type { AuditLedger } from '../../shared/audit-ledger.js';
import { learnTransferNames } from '../../shared/learn-transfer-names.js';
import type { SyncOverrides } from '../../shared/sync-overrides.js';
import type { AccountMapping } from '../../shared/types.js';

export interface PublishTransferNamesDeps {
  readLedger: () => AuditLedger;
  readMapping: () => Promise<AccountMapping | null>;
  readOverrides: () => Promise<SyncOverrides | null>;
  write: (raw: string) => Promise<void>;
  log: (message: string) => void;
  now: Date;
}

/** The number of names published, or null when nothing was (list kept). */
export async function publishTransferNames(deps: PublishTransferNamesDeps): Promise<number | null> {
  let ledger: AuditLedger;
  try {
    ledger = deps.readLedger();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.log(`Transfer names not learned — the database could not be read (${message}).`);
    return null;
  }
  const overrides = await deps.readOverrides().catch(() => null);
  if (!overrides) {
    deps.log('Transfer names not learned — the sync overrides could not be read.');
    return null;
  }
  const mapping = (await deps.readMapping()) ?? {};
  const doc = learnTransferNames({ ledger, mapping, overrides, now: deps.now });
  await deps.write(JSON.stringify(doc));
  deps.log(`Learned ${doc.names.length} transfer name(s).`);
  return doc.names.length;
}
