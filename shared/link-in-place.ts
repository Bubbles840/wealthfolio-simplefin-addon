/**
 * shared/link-in-place.ts
 *
 * Link and unlink two legs IN PLACE, through Wealthfolio's own link — `POST
 * /activities/link` and `/activities/unlink` (the companion, Wealthfolio 3.8+)
 * or the SDK's `activities.linkTransfer` and `unlinkTransfer` (the add-on, a
 * 3.9+ host). Ids stay stable, and so does everything filed on the rows.
 * Where in place cannot give the result re-creating gives, the leg shape goes
 * to the delete-and-re-create linker as before (shared/link-pair.ts). Pure:
 * each host lends its reads and calls (`InPlaceIo`).
 *
 * What upstream's link does (storage-sqlite activities repository.rs
 * `link_transfer_activities`, v3.8.0 through v3.10.0):
 *  - one transaction: both rows are read, checked and updated together, and a
 *    refusal writes nothing;
 *  - it needs one row whose effective type is TRANSFER_IN and one TRANSFER_OUT
 *    — it never changes a type — in two accounts (one account only for a cash
 *    FX conversion);
 *  - it refuses a row already in another VALID pair ("already linked to
 *    another transfer"); a row in an orphan or broken group is re-grouped;
 *    3.10 also accepts the pair already linked to each other (keeps its group);
 *  - it checks the asset shape only: two cash legs (no asset, or a `$CASH-XXX`
 *    one) pass; a security asset must match on both legs with a quantity. It
 *    does NOT clear an asset — so a leg carrying the phantom "$CASH" security
 *    (a uuid asset that `is_cash_symbol` rejects) is refused or, worse, linked
 *    and still books no cash;
 *  - it never checks amount, currency or date;
 *  - it writes a new uuid `source_group_id` (no `wf-transfer-` prefix),
 *    merges `flow.is_external: false` into each row's metadata, and sets
 *    `is_user_modified` (read only by provider upserts, which never touch
 *    these rows) — nothing else: type, date, amount, note, asset, subtype,
 *    fee and every category assignment stay as they are;
 *  - it answers with both rows, transfer-in first.
 * Unlink is its mirror: both rows must share one group; it clears the group,
 * sets `flow.is_external: true`, and changes nothing else.
 *
 * So in place gives exactly what re-creating gives only when each stored row
 * already IS the leg re-creating would write: the type, the UTC day, the
 * amount, the currency, the note, and no asset, subtype or fee. Re-creating
 * also drops a filing; in place keeps it — the point of linking in place —
 * except on a row marked external: the sync's held placeholder, whose
 * bookkeeping filing must not ride onto a real transfer, keeps re-creating.
 * Rows are read by id right before the call. Wealthfolio decides the group
 * question itself, atomically: a refusal (of any kind) falls back to
 * re-creating, which is how every pair linked before 1.62.0. A call whose
 * answer is lost is read again: a shared group means it went through.
 *
 * Unlinking in place keeps the rows and their ids, then retypes both to
 * ordinary money in ONE bulk update — they are no longer a pair, so an update
 * to one is not copied onto the other (Wealthfolio 3.8 `build_counterpart_update`
 * only follows a valid pair). If that update fails the pair stays unlinked,
 * as transfers marked external, and says so.
 */
import { bankDayInstant } from './bank-day.js';
import { utcMidnightDay } from './date-repair.js';
import { describeLeg, linkPairByRecreate, unlinkPairByRecreate, type UnlinkLeg, type UnlinkResult } from './link-pair.js';
import { flowExternalOf, isTransferType, TRANSFER_GROUP_PREFIX } from './sync-core.js';
import type { ActivityWrite, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult } from './sync-host.js';

/** What a host lends: Wealthfolio's link and unlink, and a read by id. */
export interface InPlaceIo {
  /** Both rows by id as the host's search returns them (a missing row is absent). Rejects when unreachable. */
  read(ids: [string, string]): Promise<unknown[]>;
  /** Wealthfolio's link: resolves to the two rows it wrote; rejects on a refusal. */
  link(aId: string, bId: string): Promise<unknown[]>;
  /** Wealthfolio's unlink: resolves to the two rows it wrote; rejects on a refusal. */
  unlink(aId: string, bId: string): Promise<unknown[]>;
  /** Optional: where a pair fell back to re-creating, and why — Wealthfolio's own refusal text included. */
  log?(message: string): void;
}

/** Wealthfolio's refusal when a row is already half of ANOTHER transfer
 *  (`link_transfer_activities`, v3.8.0 through v3.10.0). */
const OTHER_TRANSFER_REFUSAL = /already linked to another transfer/i;
/** The refusal 3.8 and 3.9 give a pair that is already linked to each other:
 *  upstream has the one text, "already linked to another transfer", across
 *  3.8 through 3.10 (the same text as a row in a different pair). */
const ALREADY_LINKED_REFUSAL = OTHER_TRANSFER_REFUSAL;
/** What the caller is told when it is: re-creating would delete the other
 *  pair's partner too, and that partner is never re-created. */
export const HALF_OF_ANOTHER_TRANSFER = 'One of these is already half of another transfer — nothing was changed.';
/** What a lost answer leaves when a row is still in its earlier group and its
 *  partner is not in it: nothing was written here, and the next sync looks again. */
export const LINK_ANSWER_LOST = "Couldn't tell whether Wealthfolio linked them — it will try again next sync.";
const whyOf = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

/** A stored row as in-place linking checks it: a search row (ActivityDetails) or a link answer (Activity). */
export interface StoredLeg {
  id: string;
  accountId: string;
  /** Upper-case. */
  type: string;
  /** The stored instant, as the host sent it. */
  instant: string;
  /** YYYY-MM-DD: the instant's UTC day. */
  day: string;
  absCents: number;
  feeCents: number;
  /** Upper-case. */
  currency: string;
  notes: string;
  /** '' when none. */
  assetId: string;
  /** '' when none. */
  subtype: string;
  /** '' when none. */
  group: string;
  /** The host reported the group (sent the key, even empty). */
  groupKnown: boolean;
  /** `flow.is_external`: true/false; null when unset; undefined when unknown. */
  external: boolean | null | undefined;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const cents = (v: unknown) => Math.round(Math.abs(Number(v ?? 0)) * 100) || 0;
const dayOf = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v.slice(0, 10) : d.toISOString().slice(0, 10);
};

/** A host row as in-place linking reads it; null without an id or an account. */
export function storedLegOf(raw: unknown): StoredLeg | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id);
  const accountId = text(raw.accountId);
  if (!id || !accountId) return null;
  const instant = typeof raw.date === 'string' ? raw.date : typeof raw.activityDate === 'string' ? raw.activityDate : '';
  return {
    id,
    accountId,
    type: text(raw.activityType).toUpperCase(),
    instant,
    day: dayOf(instant),
    absCents: cents(raw.amount),
    feeCents: cents(raw.fee),
    currency: text(raw.currency).toUpperCase(),
    notes: typeof raw.comment === 'string' ? raw.comment : typeof raw.notes === 'string' ? raw.notes : '',
    assetId: text(raw.assetId),
    subtype: text(raw.subtype),
    group: text(raw.sourceGroupId),
    groupKnown: 'sourceGroupId' in raw,
    external: 'metadata' in raw ? flowExternalOf(raw.metadata) : undefined,
  };
}

const find = (rows: unknown[], id: string): StoredLeg | null =>
  rows.map(storedLegOf).find((s): s is StoredLeg => s !== null && s.id === id) ?? null;

/** Why this pair cannot be linked in place (for a log), or null when it can. */
export function inPlaceRefusal(legs: readonly [LinkLeg, LinkLeg], stored: readonly [StoredLeg | null, StoredLeg | null]): string | null {
  const types = new Set(legs.map((l) => l.activityType));
  if (!types.has('TRANSFER_OUT') || !types.has('TRANSFER_IN')) return 'Wealthfolio links one transfer out with one transfer in';
  if (legs[0].accountId === legs[1].accountId) return 'both legs are in one account';
  for (let i = 0; i < 2; i++) {
    const leg = legs[i];
    const s = stored[i];
    if (!s) return `${leg.wfId} could not be read`;
    if (s.accountId !== leg.accountId) return `${leg.wfId} is in another account now`;
    if (s.type !== leg.activityType) return `${leg.wfId} is stored as ${s.type} and links as ${leg.activityType}`;
    if (s.day !== leg.date) return `${leg.wfId} is dated ${s.day}, not ${leg.date}`;
    if (s.absCents !== leg.absCents) return `${leg.wfId} has another amount`;
    if (s.currency !== leg.currency.toUpperCase()) return `${leg.wfId} is in ${s.currency}`;
    if (s.notes !== leg.comment) return `${leg.wfId} has another note`;
    if (s.assetId) return `${leg.wfId} carries an asset`;
    if (s.subtype) return `${leg.wfId} carries a subtype`;
    if (s.feeCents) return `${leg.wfId} carries a fee`;
    if (s.external === undefined) return `${leg.wfId} could not be checked for an outside-transfer mark`;
    if (s.external === true) return `${leg.wfId} is marked as an outside transfer`;
  }
  return null;
}

/** The pair, linked: both rows share a group (one not in `existing`, the
 *  groups the rows were in before the call). Null when they do not. */
function linkedIn(legs: readonly [LinkLeg, LinkLeg], rows: unknown[], existing: ReadonlySet<string> = new Set()): LinkResult | null {
  const a = find(rows, legs[0].wfId);
  const b = find(rows, legs[1].wfId);
  if (!a || !b || !a.group || a.group !== b.group || existing.has(a.group)) return null;
  return { linked: true, groupId: a.group, activityIds: [legs[0].wfId, legs[1].wfId], inPlace: true };
}

/**
 * Links the pair in place where the stored rows allow it, and by
 * re-creating them everywhere else — `io` null (a host without Wealthfolio's
 * link), a read that fails, a shape in place would not keep, or a link
 * Wealthfolio refuses.
 */
export async function linkPairPreferInPlace(
  io: InPlaceIo | null,
  saveMany: (req: SaveManyRequest) => Promise<SaveManyResult>,
  legs: [LinkLeg, LinkLeg],
): Promise<LinkResult> {
  if (!io) return linkPairByRecreate(saveMany, legs);
  const ids: [string, string] = [legs[0].wfId, legs[1].wfId];
  const recreate = (why: string) => {
    io.log?.(`link ${ids[0]}/${ids[1]}: re-creating instead of linking in place (${why})`);
    return linkPairByRecreate(saveMany, legs);
  };
  let before: unknown[];
  try {
    before = await io.read(ids);
  } catch (e) {
    return recreate(`the rows could not be read: ${whyOf(e)}`);
  }
  const storedBefore: [StoredLeg | null, StoredLeg | null] = [find(before, ids[0]), find(before, ids[1])];
  const refusal = inPlaceRefusal(legs, storedBefore);
  if (refusal !== null) return recreate(refusal);
  // The groups the rows were already in: a shared group found later only
  // proves the link if it is a new one.
  const existing = new Set(storedBefore.map((s) => s?.group ?? '').filter(Boolean));
  const alreadyOneGroup = storedBefore[0]!.group !== '' && storedBefore[0]!.group === storedBefore[1]!.group;
  // A shared group Wealthfolio itself marked: `flow.is_external` false on both
  // rows, or a `wf-transfer-` group id.
  const marked = alreadyOneGroup
    && ((storedBefore[0]!.external === false && storedBefore[1]!.external === false) || storedBefore[0]!.group.startsWith(TRANSFER_GROUP_PREFIX));
  try {
    const done = linkedIn(legs, await io.link(ids[0], ids[1]), alreadyOneGroup ? new Set() : existing);
    if (done) return done;
    io.log?.(`link ${ids[0]}/${ids[1]}: Wealthfolio answered without a shared group; looking`);
  } catch (e) {
    const why = whyOf(e);
    if (marked && ALREADY_LINKED_REFUSAL.test(why)) {
      // 3.8 and 3.9 refuse a pair already linked to each other. It IS linked:
      // keep the ids and the filings instead of re-creating.
      io.log?.(`link ${ids[0]}/${ids[1]}: already linked to each other (${why}); kept as they are`);
      return { linked: true, groupId: storedBefore[0]!.group, activityIds: ids, inPlace: true };
    }
    if (OTHER_TRANSFER_REFUSAL.test(why) && !alreadyOneGroup) {
      // Re-creating would delete the OTHER pair's partner too (a delete expands
      // to the whole group), and that partner is never re-created.
      io.log?.(`link ${ids[0]}/${ids[1]}: refused, left unlinked, nothing deleted (${why})`);
      return { linked: false, problems: [HALF_OF_ANOTHER_TRANSFER] };
    }
    io.log?.(`link ${ids[0]}/${ids[1]}: Wealthfolio refused or its answer was lost (${why}); looking`);
  }
  try {
    const again = await io.read(ids);
    const done = linkedIn(legs, again, existing);
    if (done) return done;
    // A lost answer, and a row still in the group it had at the first read
    // while its partner is not in that group: it is half of another transfer
    // (a link that went through would have moved it). Re-creating would delete
    // that other pair's partner too, so leave it for the next sync.
    const a = find(again, ids[0]);
    const b = find(again, ids[1]);
    const stuck = [[a, b, storedBefore[0]], [b, a, storedBefore[1]]].some(([now, other, was]) =>
      !!now && !!was && was.group !== '' && now.group === was.group && (!other || other.group !== now.group));
    if (a && b && stuck) {
      io.log?.(`link ${ids[0]}/${ids[1]}: a row is still in its earlier group and its partner is not; left unlinked, nothing deleted`);
      return { linked: false, problems: [LINK_ANSWER_LOST] };
    }
  } catch (e) {
    // Can't tell: re-creating links them either way.
    return recreate(`could not check: ${whyOf(e)}`);
  }
  return recreate('Wealthfolio did not link them');
}

/** Why this pair cannot be unlinked in place, or null when it can. */
export function unlinkInPlaceRefusal(legs: readonly [UnlinkLeg, UnlinkLeg], stored: readonly [StoredLeg | null, StoredLeg | null]): string | null {
  for (let i = 0; i < 2; i++) if (!stored[i]) return `${legs[i].wfId} could not be read`;
  const types = new Set(stored.map((s) => s?.type));
  if (!types.has('TRANSFER_OUT') || !types.has('TRANSFER_IN')) return 'Wealthfolio unlinks one transfer out from one transfer in';
  for (let i = 0; i < 2; i++) {
    const leg = legs[i];
    const s = stored[i]!;
    if (s.accountId !== leg.accountId) return `${leg.wfId} is in another account now`;
    if (s.type !== leg.activityType) return `${leg.wfId} is stored as ${s.type}`;
    if (s.absCents !== leg.absCents) return `${leg.wfId} has another amount`;
    if (s.assetId) return `${leg.wfId} carries an asset`;
    if (s.groupKnown && !s.group) return `${leg.wfId} is not linked`;
  }
  const [a, b] = stored as [StoredLeg, StoredLeg];
  if (a.groupKnown && b.groupKnown && a.group !== b.group) return 'the two rows are in different groups';
  return null;
}

/** The instant a retyped leg keeps: the stored one, except 00:00 UTC — a
 *  pre-1.62 bare date the date repair skipped while the row was linked — which
 *  goes to noon on that day (`bankDayInstant`), as the repair would have moved
 *  it; no instant at all is the leg's bank day at noon. Safe here: the pair is
 *  already unlinked, so Wealthfolio copies the date onto no partner. */
function retypeInstant(leg: UnlinkLeg, s: StoredLeg): string {
  if (!s.instant) return bankDayInstant(leg.date);
  const midnight = utcMidnightDay(s.instant);
  return midnight ? bankDayInstant(midnight) : s.instant;
}

/** The leg as ordinary money, written over its own row: the stored instant
 *  kept (see `retypeInstant`), the cash symbol for any non-transfer type (see
 *  `isTransferType`). */
function retypeWrite(leg: UnlinkLeg, s: StoredLeg): ActivityWrite {
  return {
    id: leg.wfId,
    accountId: leg.accountId,
    activityType: leg.newType,
    activityDate: retypeInstant(leg, s),
    ...(isTransferType(leg.newType) ? {} : { symbol: { symbol: `$CASH-${leg.currency}` } }),
    amount: leg.absCents / 100,
    fee: 0,
    currency: leg.currency,
    comment: leg.comment,
  };
}

/**
 * Undo of a link, in place where it can be: Wealthfolio's unlink, then one
 * bulk update retyping both rows as ordinary money in or out. Everything else
 * — `io` null, a failed read, a shape it cannot take, a refused unlink —
 * goes to `unlinkPairByRecreate` as before.
 */
export async function unlinkPairPreferInPlace(
  io: InPlaceIo | null,
  saveMany: (req: SaveManyRequest) => Promise<SaveManyResult>,
  legs: [UnlinkLeg, UnlinkLeg],
): Promise<UnlinkResult> {
  if (!io) return unlinkPairByRecreate(saveMany, legs);
  const ids: [string, string] = [legs[0].wfId, legs[1].wfId];
  const recreate = (why: string) => {
    io.log?.(`unlink ${ids[0]}/${ids[1]}: re-creating instead of unlinking in place (${why})`);
    return unlinkPairByRecreate(saveMany, legs);
  };
  let before: unknown[];
  try {
    before = await io.read(ids);
  } catch (e) {
    return recreate(`the rows could not be read: ${whyOf(e)}`);
  }
  const stored: [StoredLeg | null, StoredLeg | null] = [find(before, ids[0]), find(before, ids[1])];
  // Both rows read as ungrouped (the host reported the group, and it is none)
  // and still typed as their legs: an earlier in-place unlink got this far but
  // its retype was refused. There is no pair to copy an update onto, so skip
  // the unlink and retype in place, keeping the ids and their filings.
  const apart = stored.every((s) => !!s && s.groupKnown && !s.group);
  const refusal = unlinkInPlaceRefusal(legs, apart ? stored.map((s) => ({ ...s!, group: 'apart' })) as [StoredLeg, StoredLeg] : stored);
  if (refusal !== null) return recreate(refusal);
  let unlinked = false;
  if (apart) {
    io.log?.(`unlink ${ids[0]}/${ids[1]}: already apart; retyping in place`);
    unlinked = true;
  } else try {
    await io.unlink(ids[0], ids[1]);
    unlinked = true;
  } catch (e) {
    io.log?.(`unlink ${ids[0]}/${ids[1]}: Wealthfolio refused or its answer was lost (${whyOf(e)}); looking`);
    // Refused, or its answer was lost: unlinked only if both rows now say so.
    try {
      const again = await io.read(ids);
      unlinked = ids.every((id) => {
        const s = find(again, id);
        return !!s && s.groupKnown && !s.group;
      });
    } catch {
      unlinked = false;
    }
  }
  if (!unlinked) return recreate('Wealthfolio did not unlink them');
  let problem: string | null = null;
  let still = 'are still';
  try {
    const res = await saveMany({ updates: legs.map((leg, i) => retypeWrite(leg, stored[i]!)) });
    if (res.errors.length > 0) problem = res.errors.map((e) => `${e.action}: ${e.message}`).join('; ');
  } catch (e) {
    problem = whyOf(e);
    still = 'may still be';
    // A throw is not a refusal: the update may have landed. Look before saying.
    try {
      const again = await io.read(ids);
      const types = legs.map((leg) => find(again, leg.wfId)?.type);
      if (types.every((t, i) => t === legs[i].newType)) {
        io.log?.(`unlink ${ids[0]}/${ids[1]}: the retype threw (${problem}) but landed`);
        problem = null;
      }
      else if (types.every((t) => t !== undefined && isTransferType(t))) still = 'are still';
    } catch {
      // Can't tell: stays "may still be".
    }
  }
  if (problem !== null) {
    return {
      unlinked: true, inPlace: true, activityIds: ids,
      problems: [`unlinked ${describeLeg(legs[0])} and ${describeLeg(legs[1])} in place, but they ${still} typed as transfers (${problem}); a later sync retypes each while the bank feed still sends it`],
    };
  }
  return { unlinked: true, inPlace: true, activityIds: ids };
}

/**
 * The add-on's `linked_groups` value for a pair. Its sync drops every entry
 * without the `wf-transfer-` prefix as written before the ledger was
 * echo-confirmed, and Wealthfolio's own link mints a bare uuid — so a pair
 * linked in place is remembered under the prefix. The value is only ever
 * compared between the two legs, never sent to Wealthfolio.
 */
export const ledgerGroupId = (groupId: string): string =>
  groupId.startsWith(TRANSFER_GROUP_PREFIX) ? groupId : `${TRANSFER_GROUP_PREFIX}${groupId}`;
