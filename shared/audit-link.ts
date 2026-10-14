/**
 * shared/audit-link.ts
 *
 * Link, from the Health list (2c R2, spec C1): a Health leg with exactly one
 * likely other half is linked to it in one tap — the list is the preview.
 * "Link all N" links every pair the list shows, one at a time. Pure decisions
 * and a host-neutral runner; each host lends its reads and writes
 * (companion/src/audit-fix-host.ts, src/utils/audit-fix.ts).
 *
 * Right before each pair's write both rows are re-read by id, and nothing is
 * written — "It has changed since — nothing was linked." — when either row
 * changed account, amount, date or type; is linked, or may be (the add-on);
 * carries a `notTransfer` override; is pending (the sync never pairs one); is
 * the add-on's own in-transit placeholder, opening balance or correction; or
 * no longer carries the tx id its Health leg named. Money leaving a card is
 * refused on its own words, whatever the row's stored type: the sync never
 * links money leaving a card, Wealthfolio 3.8 and 3.9 accept no TRANSFER_OUT
 * on one (v1.55), and a WITHDRAWAL is never half of a valid pair. So is a pair
 * whose account types, or whose currency, are not what was shown.
 *
 * The write is the sync's own linker, `linkPairByRecreate`, through the
 * host's `linkPair` (shared/link-pair.ts). It DELETES both rows and then
 * re-creates them as one marked group. Wealthfolio applies a bulk request all
 * or nothing (activities_service.rs, bulk_mutate_activities), so a re-create
 * it refuses (or a request that throws) wrote nothing while the delete already
 * went through. After any throw, or a refused re-create, the runner re-reads
 * both rows by id, writes back whichever are gone (`recreateWrite`), records
 * that, and names any row it could not restore.
 *
 * Each link is a `transfer-link` change entry with actor `you`, so the change
 * log's Undo — `notTransfer` on both legs, which the next sync acts on — and
 * Redo work unchanged. On the add-on the pair also goes into its
 * `linked_groups` ledger: its sync cannot read groups back, and the ledger is
 * how it knows to leave both legs as stored. Neither the log nor the ledger
 * ever costs the link.
 */
import type { HealthIssue, HealthLeg } from './audit-health.js';
import { isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';
import { bookkeepingChange, transferLinkChange, type ChangeDraft, type LinkLegFacts } from './change-entries.js';
import { recreateWrite, type FixRow, type LinkedState } from './fix-row.js';
import { findingHandle } from './handle.js';
import { describeLeg } from './link-pair.js';
import { descriptionFromComment, txIdFromComment } from './sync-core.js';
import type { ActivityWrite, LinkLeg, LinkResult, SaveManyResult } from './sync-host.js';
import { hasTxOverride, SYNC_OVERRIDES_UNREADABLE_MESSAGE, type LoadedSyncOverrides, type SyncOverrides } from './sync-overrides.js';

export const LINK_BUTTON = 'Link';
export const linkAllButton = (n: number): string => `Link all ${n}`;
export const LINK_DONE = 'Linked.';
export const LINK_CHANGED = 'It has changed since — nothing was linked.';
export const LINK_CARD_OUT = "Wealthfolio doesn't take a transfer out of a credit card, so these two can't be linked here.";
export const LINK_UNKNOWN_ACCOUNT = "Can't tell what kind of account this is — nothing was linked.";
export const LINK_DROPPED = "Both rows were re-created as transfers, but Wealthfolio didn't link them.";
export const LINK_UNREACHABLE = "Couldn't reach Wealthfolio — nothing was linked.";

/** A Health leg and its one likely other half, as the list shows them. */
export interface LinkPair {
  /** The Health issue's key. */
  key: string;
  leg: HealthLeg;
  counterpart: HealthLeg;
}

/** The pair a Health issue offers to link, or null: a leg of yours, not
 *  linked at all, with exactly one likely other half, both from the bank
 *  feed (each needs its tx key: the change log's Undo works by it). */
export function linkablePair(issue: HealthIssue): LinkPair | null {
  if (issue.kind !== 'incomplete-leg' || issue.owner !== 'you' || issue.problem !== null || issue.match !== 'one') return null;
  if (!issue.counterpart || !issue.leg.txKey || !issue.counterpart.txKey) return null;
  return { key: issue.key, leg: issue.leg, counterpart: issue.counterpart };
}

export function linkablePairs(issues: readonly HealthIssue[] | null | undefined): LinkPair[] {
  return (issues ?? []).map(linkablePair).filter((p): p is LinkPair => p !== null);
}

/** What a leg looked like when it was shown: its id, account, amount, date and type. */
export const legFingerprint = (l: Pick<HealthLeg, 'activityId' | 'accountId' | 'absCents' | 'date' | 'type'>): string =>
  findingHandle([l.activityId, l.accountId, l.absCents, l.date, l.type].join('\u001f'));
/** A pair as a button carries it: both legs' fingerprints, 16 hex. */
export const pairHandle = (p: LinkPair): string => `${legFingerprint(p.leg)}${legFingerprint(p.counterpart)}`;
/** Every pair a list showed, as "Link all" carries them: 8 hex. */
export const pairsHandle = (pairs: readonly LinkPair[]): string => findingHandle(pairs.map(pairHandle).join(','));

/** A row re-read right before the write, and whether it is linked. */
export interface ReadRow {
  row: FixRow;
  linked: LinkedState;
}

export type LinkCheck =
  | { ok: true; legs: [LinkLeg, LinkLeg]; rows: [FixRow, FixRow]; keys: [string, string] }
  | { ok: false; reason: string };

const OUT_TYPES = new Set(['TRANSFER_OUT', 'WITHDRAWAL']);
const IN_TYPES = new Set(['TRANSFER_IN', 'DEPOSIT', 'CREDIT']);
const changed: LinkCheck = { ok: false, reason: LINK_CHANGED };

/**
 * The pair as it stands now (leg first, then the counterpart; null: gone)
 * against how it was shown. The legs come back money-out first, typed
 * TRANSFER_OUT and TRANSFER_IN — a counterpart stored as ordinary money gets
 * the right type — with their own notes, so each keeps its bank text and id.
 */
export function checkLinkPair(pair: LinkPair, now: readonly [ReadRow | null, ReadRow | null], overrides: SyncOverrides): LinkCheck {
  const shown = [pair.leg, pair.counterpart] as const;
  for (let i = 0; i < 2; i++) {
    const read = now[i];
    const was = shown[i];
    if (!read) return changed;
    const { row } = read;
    if (row.currency !== was.currency) return changed;
    if (row.id !== was.activityId || row.accountId !== was.accountId || row.absCents !== was.absCents || row.date !== was.date || row.type !== was.type) {
      return changed;
    }
    if (read.linked) return changed;
    if (isPendingNote(row.notes) || isPlaceholderNote(row.notes) || isStartingBalanceNote(row.notes) || isCorrectionNote(row.notes)) return changed;
    const txId = txIdFromComment(row.notes);
    if (!was.txKey || !txId || !was.txKey.endsWith(`\u0000${txId}`)) return changed;
    if (hasTxOverride(overrides, was.txKey, 'notTransfer')) return changed;
  }
  const outAt = pair.leg.type === 'TRANSFER_OUT' ? 0 : 1;
  const out = now[outAt]!.row;
  const into = now[1 - outAt]!.row;
  if (!OUT_TYPES.has(out.type) || !IN_TYPES.has(into.type) || out.accountId === into.accountId || out.currency !== into.currency) return changed;
  if (!out.accountType || !into.accountType) return { ok: false, reason: LINK_UNKNOWN_ACCOUNT };
  // The sync never links money leaving a card, whatever the row's stored type.
  if (out.accountType === 'CREDIT_CARD') return { ok: false, reason: LINK_CARD_OUT };
  const leg = (row: FixRow, activityType: string): LinkLeg => ({
    wfId: row.id, accountId: row.accountId, txId: txIdFromComment(row.notes)!, activityType, date: row.date,
    absCents: row.absCents, currency: row.currency, comment: row.notes,
  });
  return {
    ok: true,
    legs: [leg(out, 'TRANSFER_OUT'), leg(into, 'TRANSFER_IN')],
    rows: [out, into],
    keys: [shown[outAt].txKey!, shown[1 - outAt].txKey!],
  };
}

/** What a host lends the runner. */
export interface LinkIo {
  /** Both rows by id, now (leg first; null: gone). Rejects when unreachable. */
  read(pair: LinkPair): Promise<[ReadRow | null, ReadRow | null]>;
  /** The overrides document (`loadSyncOverrides`). */
  overrides(): Promise<LoadedSyncOverrides>;
  /** The host's `linkPair`: `linkPairByRecreate`. */
  link(legs: [LinkLeg, LinkLeg]): Promise<LinkResult>;
  /** Writes rows back (the host's `saveMany` creates). */
  restore(writes: ActivityWrite[]): Promise<SaveManyResult>;
  /** The add-on: put the pair in `linked_groups`. Absent on the companion. */
  remember?(keys: [string, string], groupId: string): Promise<void>;
  /** Appends to the change log through the host's own writer. */
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
}

export interface LinkRun {
  total: number;
  linked: number;
  changed: number;
  failed: number;
  /** The issue keys linked (the app retires their buttons). */
  done: string[];
  /** Rows deleted by a link and not written back, named. */
  lost: string[];
  /** Rows a failed link may have deleted, when the run could not look. */
  maybeLost: string[];
  /** What to say, in place. */
  message: string;
}

type One = { kind: 'linked' } | { kind: 'changed' } | { kind: 'failed'; message: string; lost?: string[]; maybeLost?: string[] };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** Error text without a trailing full stop, to sit inside a sentence. */
const bare = (t: string) => t.trim().replace(/[.\s]+$/, '');
const describeRow = (r: FixRow) => describeLeg({ accountId: r.accountId, accountName: r.accountName, date: r.date, absCents: r.absCents, comment: r.notes });
const TRANSPORT = /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|timed? ?out|\b5\d\d\b|bad gateway|unavailable/i;
const DUPLICATE = /duplicate/i;
const LINK_MAYBE_THERE = 'A matching row already exists — the link may have gone through; check both accounts.';

/** A bookkeeping entry for a Link that re-created rows without linking them
 *  (the person tapped it: actor `you`; two rows). */
function relinkNote(check: Extract<LinkCheck, { ok: true }>, newIds: string[], summary: string, oldIds: string[] = []): ChangeDraft {
  const legs = check.rows.map((r, i) => ({ txKey: check.keys[i], description: descriptionFromComment(r.notes) }));
  const base = bookkeepingChange({ step: 'transfer-relink', activityIds: newIds, legs });
  return { ...base, actor: 'you', summary, after: { step: 'transfer-relink', count: 2, ...(oldIds.length ? { oldActivityIds: oldIds } : {}) } };
}

async function linkOne(pair: LinkPair, io: LinkIo, overrides: SyncOverrides): Promise<One> {
  let now: [ReadRow | null, ReadRow | null];
  try {
    now = await io.read(pair);
  } catch (err) {
    io.log(`Link ${pair.key}: reading the rows failed: ${errorText(err)}`);
    return { kind: 'failed', message: LINK_UNREACHABLE };
  }
  const check = checkLinkPair(pair, now, overrides);
  if (!check.ok) return check.reason === LINK_CHANGED ? { kind: 'changed' } : { kind: 'failed', message: check.reason };

  let result: LinkResult | null = null;
  let thrown: string | null = null;
  try {
    result = await io.link(check.legs);
  } catch (err) {
    thrown = errorText(err);
    io.log(`Link ${pair.key}: ${thrown}`);
  }
  if (!result || !result.linked || !result.groupId) {
    const problems = result?.problems ?? [];
    if (result) io.log(`Link ${pair.key}: ${problems.join('; ') || 'not linked'}`);
    if (problems.some((p) => p.startsWith('the host stored no shared group'))) {
      // Both saves went through and Wealthfolio kept no group: the rows exist,
      // as transfers, unlinked. Say so, and leave a visible trace.
      try {
        await io.record(relinkNote(check, [], `Re-created ${descriptionFromComment(check.rows[0].notes)} and ${descriptionFromComment(check.rows[1].notes)} as transfers, but Wealthfolio did not link them`));
      } catch (err) {
        io.log(`Link ${pair.key}: the change log was not written: ${errorText(err)}`);
      }
      return { kind: 'failed', message: LINK_DROPPED };
    }
    const deleteFailed = problems.some((p) => p.startsWith('delete ('));
    if (!thrown && deleteFailed) return { kind: 'failed', message: `Couldn't link them: ${bare(problems[0])}.` };
    const refused = problems.find((p) => p.startsWith('save ('));
    const why = bare(thrown ?? (refused ? refused.replace(/^save \([^)]*\): /, '') : problems[0] ?? 'Wealthfolio did not say why'));
    // The linker deletes first, so a throw or a refused re-create may have
    // taken both rows. Look; write back whichever are gone.
    // Wealthfolio's bulk endpoint is all or nothing, so a refused re-create
    // wrote nothing and the delete before it is known to have landed.
    // `again` is in the pair's order (leg first); `check.rows` is money-out
    // first, so which rows survive is decided by id, never by position.
    let still: Set<string> | null = null;
    try {
      const again = await io.read(pair);
      still = new Set(again.flatMap((r) => (r ? [r.row.id] : [])));
    } catch (err) {
      io.log(`Link ${pair.key}: re-reading the rows failed: ${errorText(err)}`);
      if (refused) still = new Set();
    }
    const lead = thrown !== null && TRANSPORT.test(why) ? `Couldn't reach Wealthfolio (${why})` : `Wealthfolio refused the link (${why})`;
    if (still === null) {
      const maybe = check.rows.map(describeRow);
      io.log(`Link ${pair.key}: could not check the rows; they may be deleted. Payloads: ${JSON.stringify(check.rows.map(recreateWrite))}`);
      return {
        kind: 'failed',
        maybeLost: maybe,
        message: `Couldn't link them: ${why}, and couldn't check whether the two rows are still there. If they're gone, they were: ${maybe.join(' and ')}. Check both accounts in Wealthfolio.`,
      };
    }
    const lostRows = check.rows.filter((r) => !still!.has(r.id));
    if (lostRows.length === 0) {
      return { kind: 'failed', message: thrown ? `Couldn't link them: ${why}. Check both accounts in Wealthfolio.` : `Couldn't link them: ${why}. Nothing was changed.` };
    }
    const writes = lostRows.map(recreateWrite);
    let restored = false;
    let backErrors: string[] = [];
    let newIds: string[] = [];
    try {
      const back = await io.restore(writes);
      backErrors = back.errors.map((e) => e.message);
      restored = backErrors.length === 0;
      newIds = [...back.created, ...back.updated].map((a) => a.id);
    } catch (err) {
      backErrors = [errorText(err)];
    }
    if (!restored) io.log(`Link ${pair.key}: putting the rows back failed: ${backErrors.join('; ')}`);
    if (restored) {
      try {
        await io.record(relinkNote(check, newIds, `Link failed (${why}); put ${lostRows.length === 2 ? 'both rows' : 'the deleted row'} back with new ids`, lostRows.map((r) => r.id)));
      } catch (err) {
        io.log(`Link ${pair.key}: the change log was not written: ${errorText(err)}`);
      }
      return {
        kind: 'failed',
        message: lostRows.length === 2
          ? `${lead}. Both rows are back, with new ids. Their categories may need filing again.`
          : `${lead}. The deleted row is back, with a new id. Its category may need filing again.`,
      };
    }
    io.log(`Link ${pair.key}: payloads: ${JSON.stringify(writes)}`);
    if (backErrors.some((m) => DUPLICATE.test(m))) return { kind: 'failed', message: LINK_MAYBE_THERE };
    const lost = lostRows.map(describeRow);
    io.log(`Link ${pair.key}: deleted and not restored: ${lost.join('; ')}`);
    return {
      kind: 'failed',
      lost,
      message: `${lead}, and the ${lostRows.length === 2 ? 'two rows' : 'row'} couldn't be put back. Deleted and not restored: ${lost.join('; ')}. The next sync brings back any the bank still sends.`,
    };
  }

  const [out, into] = check.rows;
  if (io.remember) {
    try {
      await io.remember(check.keys, result.groupId);
    } catch (err) {
      io.log(`Link ${pair.key}: linked, but linked_groups was not updated: ${errorText(err)}`);
    }
  }
  const facts = (row: FixRow, key: string, amountCents: number, newId?: string): LinkLegFacts => ({
    account: { sfinId: key.slice(0, key.indexOf('\u0000')), wfId: row.accountId, name: row.accountName },
    txKey: key,
    description: descriptionFromComment(row.notes),
    amountCents,
    date: row.date,
    oldActivityId: row.id,
    ...(newId ? { newActivityId: newId } : {}),
  });
  try {
    await io.record(transferLinkChange(
      facts(out, check.keys[0], -out.absCents, result.activityIds?.[0]),
      facts(into, check.keys[1], into.absCents, result.activityIds?.[1]),
      'you',
    ));
  } catch (err) {
    // The log never costs the work.
    io.log(`Link ${pair.key}: linked, but the change log was not written: ${errorText(err)}`);
  }
  return { kind: 'linked' };
}

/** "Linked." / "Linked all 4." / "Linked 3 of 4 — 1 had changed since." */
export function linkRunLine(r: Pick<LinkRun, 'total' | 'linked' | 'changed' | 'failed'> & { lost?: readonly string[]; maybeLost?: readonly string[] }): string {
  const lost = (r.lost?.length ? ` Deleted and not restored: ${r.lost.join('; ')}.` : '')
    + (r.maybeLost?.length ? ` May have been deleted: ${r.maybeLost.join('; ')}.` : '');
  if (r.total === 0) return LINK_CHANGED;
  if (r.linked === r.total) return r.total === 1 ? LINK_DONE : `Linked all ${r.total}.`;
  const why = [
    r.changed > 0 ? `${r.changed} had changed since` : null,
    r.failed > 0 ? `${r.failed} couldn't be linked` : null,
  ].filter(Boolean).join(', ');
  return `Linked ${r.linked} of ${r.total} — ${why}.${lost}`;
}

/**
 * Links each pair, one at a time: one failure never stops the rest, and the
 * result counts them. One pair says exactly what happened to it. Nothing is
 * read or written when the overrides document cannot be read (a pair's
 * `notTransfer` could not be checked).
 */
export async function linkPairs(pairs: readonly LinkPair[], io: LinkIo): Promise<LinkRun> {
  const run: LinkRun = { total: pairs.length, linked: 0, changed: 0, failed: 0, done: [], lost: [], maybeLost: [], message: '' };
  let loaded: LoadedSyncOverrides;
  try {
    loaded = await io.overrides();
  } catch (err) {
    io.log(`Link: reading the overrides failed: ${errorText(err)}`);
    return { ...run, message: LINK_UNREACHABLE };
  }
  if (loaded.unreadable) return { ...run, message: SYNC_OVERRIDES_UNREADABLE_MESSAGE };
  let last = '';
  for (const pair of pairs) {
    let one: One;
    try {
      one = await linkOne(pair, io, loaded.overrides);
    } catch (err) {
      io.log(`Link ${pair.key}: ${errorText(err)}`);
      one = { kind: 'failed', message: `Couldn't link them: ${bare(errorText(err))}.` };
    }
    if (one.kind === 'linked') {
      run.linked += 1;
      run.done.push(pair.key);
    } else if (one.kind === 'changed') run.changed += 1;
    else {
      run.failed += 1;
      if (one.lost) run.lost.push(...one.lost);
      if (one.maybeLost) run.maybeLost.push(...one.maybeLost);
    }
    last = one.kind === 'linked' ? LINK_DONE : one.kind === 'changed' ? LINK_CHANGED : one.message;
  }
  return { ...run, message: pairs.length === 1 ? last : linkRunLine(run) };
}
