/**
 * shared/fix-row.ts
 *
 * One stored activity as the fixes (2c R2, spec C) re-read it right before
 * they write: Link (shared/audit-link.ts) and Remove for good
 * (shared/tx-remove.ts). Both hosts read the same shape — Wealthfolio's
 * ActivityDetails, through the add-on SDK's exact-id search or the
 * companion's REST search — so one reader serves both. Pure.
 */
import { maybeLinkedTransfer } from './change-undo-run.js';
import { flowExternalOf, isTransferType } from './sync-core.js';
import { bankDayInstant } from './bank-day.js';
import type { ActivityWrite } from './sync-host.js';

export interface FixRow {
  id: string;
  accountId: string;
  /** Raw. */
  accountName: string;
  /** Upper-case: 'CASH', 'CREDIT_CARD', … ('' when unknown). */
  accountType: string;
  /** Upper-case. */
  type: string;
  /** YYYY-MM-DD: the UTC day of the stored instant. */
  date: string;
  absCents: number;
  feeCents: number;
  /** Upper-case. */
  currency: string;
  /** The stored note, raw. */
  notes: string;
  subtype: string | null;
  /** `metadata.flow.is_external`: true/false; null when unset; undefined
   *  when the host did not report metadata (unknown, never "unset"). */
  flowExternal: boolean | null | undefined;
  /** The metadata object the host reported (every key), when it reported a
   *  non-empty one; written back as it was. */
  meta?: Record<string, unknown>;
  /** The host reported a transfer group id on the row. */
  grouped: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function metaOf(metadata: unknown): Record<string, unknown> | undefined {
  let parsed: unknown = metadata;
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return undefined;
    }
  }
  return isRecord(parsed) && Object.keys(parsed).length > 0 ? parsed : undefined;
}
const cents = (v: unknown) => Math.round(Math.abs(Number(v ?? 0)) * 100) || 0;
/** The day the add-on's story shows (src/utils/tx-story.ts): the stored instant's UTC day. */
export function isoDay(v: unknown): string {
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v ?? '').slice(0, 10) : d.toISOString().slice(0, 10);
}

/** An ActivityDetails row as the fixes read it; null when it lacks an id, an
 *  account, a type, a date or a currency. `accountType` comes from the
 *  host's account list. */
export function fixRowOf(raw: unknown, accountType: string): FixRow | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const accountId = typeof raw.accountId === 'string' ? raw.accountId : '';
  const type = typeof raw.activityType === 'string' ? raw.activityType.toUpperCase() : '';
  const date = raw.date === null || raw.date === undefined ? '' : isoDay(raw.date);
  const currency = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : '';
  if (!id || !accountId || !type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !currency) return null;
  const notes = typeof raw.comment === 'string' ? raw.comment : typeof raw.notes === 'string' ? raw.notes : '';
  return {
    id, accountId, accountName: typeof raw.accountName === 'string' ? raw.accountName : '', accountType: accountType.toUpperCase(),
    type, date, absCents: cents(raw.amount), feeCents: cents(raw.fee), currency, notes,
    subtype: typeof raw.subtype === 'string' && raw.subtype.trim() !== '' ? raw.subtype : null,
    flowExternal: 'metadata' in raw ? flowExternalOf(raw.metadata) : undefined,
    ...('metadata' in raw && metaOf(raw.metadata) ? { meta: metaOf(raw.metadata) } : {}),
    grouped: typeof raw.sourceGroupId === 'string' && raw.sourceGroupId.trim() !== '',
  };
}

/**
 * The row as the create request that writes it again, exactly: the same
 * shape the sync's `recreatePayload` keeps for a removed duplicate
 * (shared/sync-core.ts). A transfer leg carries no symbol (see
 * `isTransferType`); everything else resolves the cash asset by symbol.
 */
export function recreateWrite(row: FixRow): ActivityWrite {
  return {
    accountId: row.accountId,
    activityType: row.type,
    activityDate: bankDayInstant(row.date),
    ...(isTransferType(row.type) ? {} : { symbol: { symbol: `$CASH-${row.currency}` } }),
    amount: row.absCents / 100,
    ...(row.feeCents ? { fee: row.feeCents / 100 } : {}),
    currency: row.currency,
    comment: row.notes,
    ...(row.subtype ? { subtype: row.subtype } : {}),
    ...(row.meta ? { metadata: JSON.stringify(row.meta) } : typeof row.flowExternal === 'boolean' ? { metadata: JSON.stringify({ flow: { is_external: row.flowExternal } }) } : {}),
  };
}

/** Half of a linked transfer: known to be, possibly (the add-on cannot always tell), or not. */
export type LinkedState = 'confirmed' | 'maybe' | false;

/**
 * How sure a host is that a row is half of a linked pair.
 *  - A group id on the row, or the add-on's own `linked_groups` ledger: confirmed.
 *  - A host that reads groups (the companion): nothing else is.
 *  - The add-on, which cannot count on reading groups back: change-undo-run.ts's
 *    rule (`maybeLinkedTransfer`) — a transfer-typed row nothing marks as unpaired
 *    may be. With `unpairedWhenRead` (Link: the companion read this row from the
 *    database, unpaired, for the snapshot) a row may be linked only if a linker
 *    that keeps its id has marked it since: Wealthfolio's own link stamps
 *    `flow.is_external: false` on both rows (storage-sqlite activities
 *    repository.rs:1103-1108 at v3.8.0), and every other linker re-creates
 *    both rows under new ids. Metadata the host did not report may be either.
 */
export function linkedState(row: FixRow, how: { readsGroups: boolean; ledgerKnows: boolean; unpairedWhenRead?: boolean }): LinkedState {
  if (row.grouped || how.ledgerKnows) return 'confirmed';
  if (how.readsGroups || !isTransferType(row.type)) return false;
  if (how.unpairedWhenRead) return row.flowExternal === false || row.flowExternal === undefined ? 'maybe' : false;
  const metadata = row.flowExternal === undefined ? {}
    : { metadata: row.flowExternal === null ? null : JSON.stringify({ flow: { is_external: row.flowExternal } }) };
  return maybeLinkedTransfer({ id: row.id, accountId: row.accountId, activityType: row.type, date: row.date, amount: null, comment: row.notes, ...metadata })
    ? 'maybe' : false;
}
