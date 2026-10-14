/**
 * shared/audit-health.ts
 *
 * What Wealthfolio's own Health page would flag (2c R1, spec A3), each with
 * what to do. Pure: companion/tools/audit-health.mjs parts 1–3 and
 * fix-transfers.mjs's matcher, ported over the rows audit-ledger.ts carries.
 *
 *  1. Transfer legs (Wealthfolio 3.8's `invalid_transfer_groups_from_activities`,
 *     crates/core/src/health/service.rs:771-825): every
 *     POSTED TRANSFER_IN/TRANSFER_OUT (by its override type) in an ACTIVE,
 *     NOT ARCHIVED account (service.rs:277, 779) that has no group, or whose
 *     group is not exactly one IN and one OUT in two accounts with no
 *     security on either — except what 3.10's build_transfer_pair accepts
 *     (transfer_pairs.rs): a same-account cash FX conversion (different
 *     currencies, non-zero amounts) and security legs of the same asset and
 *     equal quantity. Those are VALID here on every host: a missed flag on 3.8
 *     is safer than a false "won't accept". Security is reported only when the
 *     facts show different assets or quantities. Unless its metadata says `flow.is_external: true`;
 *     and every leg of a VALID pair that IS marked external (the
 *     "conflicting external marker", service.rs:813-825). The script checks
 *     neither the account nor the marker on a pair; Health's source does.
 *  2. Starting balances dated on or after the account's earliest other row.
 *  3. Rows pointing at the phantom `$CASH` security.
 *
 * A leg of yours gets its likely other half only as fix-transfers.mjs would
 * link it: another account (not archived), the same currency and amount to
 * the cent, the opposite direction (a TRANSFER_OUT wants a TRANSFER_IN,
 * DEPOSIT or CREDIT; a TRANSFER_IN a TRANSFER_OUT or WITHDRAWAL), POSTED and
 * not pending (the sync never pairs a ` · pending` row), within MATCH_DAYS, not already half of a valid pair, not the add-on's
 * opening balance or correction — and unique BOTH ways: the leg has exactly
 * one candidate and no other leg claims it. Anything else is "many" and is
 * never offered. The add-on's own rows (opening balances, corrections,
 * in-transit placeholders) are flagged but never matched: the sync marks
 * those itself. A leg of a valid pair marked external is never matched
 * either: it already has its other half.
 *
 * A counterpart carries both rows' ids, account ids, tx keys, amounts and
 * dates — what R2's Link re-reads before it writes, whichever linker it uses.
 *
 * Across Wealthfolio versions (3.8 to 3.10): a leg marked external is fine in
 * Health on every version (3.10's TransferLinkState::External), so it is
 * skipped here; a card may carry a TRANSFER_OUT from 3.10 (#1796), which is a
 * transfer leg like any other; a `$CASH` row cannot be created on 3.10
 * (#1798), so those are older rows. 3.10's Health also checks things this
 * port does not (rejected, oversold and amountless activities, a stale
 * projection), so "nothing to report" is worded as nothing the ADD-ON
 * checks for, never as Wealthfolio's whole Health page.
 */
import { changeDay, changeMoney } from './change-entries.js';
import { descriptionFromComment, isTransferType, txIdFromComment } from './sync-core.js';
import { accountTxKey } from './transfers.js';
import {
  isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote, type AuditLedger, type AuditLedgerRow,
} from './audit-ledger.js';

/** fix-transfers.mjs's MATCH_DAYS. */
export const MATCH_DAYS = 5;

export type HealthRead = 'ledger' | 'mapping';
export const HEALTH_READ_NOTES: Record<HealthRead, string> = {
  ledger: "Couldn't read the Wealthfolio database, so Health wasn't checked.",
  mapping: "Couldn't read which accounts are mapped, so the rows' bank ids are missing.",
};
const READ_ORDER: HealthRead[] = ['ledger', 'mapping'];

export const HEALTH_NONE = 'Nothing the add-on checks for: no incomplete transfers, late starting balances or $CASH rows.';

export interface HealthFacts {
  ledger?: AuditLedger;
  /** account_mapping: SimpleFin id → Wealthfolio id, for the rows' tx keys. */
  mapping?: Record<string, string>;
  failed?: HealthRead[];
}

/** One row as an issue names it. */
export interface HealthLeg {
  activityId: string;
  accountId: string;
  /** Raw. */
  accountName: string;
  /** accountTxKey(SimpleFin account id, SimpleFin tx id); null when the
   *  account is not mapped or the note carries no id. */
  txKey: string | null;
  /** YYYY-MM-DD. */
  date: string;
  absCents: number;
  /** The type Health reads (the override when there is one). */
  type: string;
  currency: string;
  /** Raw. */
  description: string;
}

export type GroupProblem =
  | { kind: 'legs'; count: number }
  | { kind: 'same-direction' }
  | { kind: 'one-account' }
  | { kind: 'security' }
  /** A valid pair, but this leg is marked as money in or out of Wealthfolio. */
  | { kind: 'marked-external' };

export type HealthIssue =
  | {
    kind: 'incomplete-leg';
    /** For `findingHandle`. */
    key: string;
    leg: HealthLeg;
    /** null: not linked at all. */
    problem: GroupProblem | null;
    owner: 'you' | 'add-on';
    /** 'skipped': the add-on's own row, or a pair already linked — never matched. */
    match: 'one' | 'many' | 'none' | 'skipped';
    /** Only for match 'one'. */
    counterpart: HealthLeg | null;
  }
  | { kind: 'phantom-cash'; key: string; rows: number; accounts: Array<{ name: string; rows: number }> }
  | { kind: 'late-start'; key: string; activityId: string; accountId: string; accountName: string; date: string; earliest: string; cents: number };

export interface HealthReport {
  /** null: not checked (the database could not be read). */
  issues: HealthIssue[] | null;
  /** Issues left out to fit the snapshot (audit-snapshot.ts). */
  more?: number;
  notes: string[];
}

const INFLOW = new Set(['TRANSFER_IN', 'DEPOSIT', 'CREDIT']);
const OUTFLOW = new Set(['TRANSFER_OUT', 'WITHDRAWAL']);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** non_cash_transfer_asset_key: a cash asset id starts with `$CASH`. */
const carriesSecurity = (r: AuditLedgerRow) => r.assetId !== '' && !r.assetId.toUpperCase().startsWith('$CASH');
const isBookkeeping = (r: AuditLedgerRow) => isStartingBalanceNote(r.notes) || isCorrectionNote(r.notes);

function groupsOf(rows: AuditLedgerRow[]): Map<string, AuditLedgerRow[]> {
  const groups = new Map<string, AuditLedgerRow[]>();
  for (const r of rows) {
    if (!isTransferType(r.type) || !r.group.trim()) continue;
    groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  }
  return groups;
}

function groupProblem(legs: AuditLedgerRow[]): GroupProblem | null {
  if (legs.length !== 2) return { kind: 'legs', count: legs.length };
  if (legs.filter((l) => l.type === 'TRANSFER_IN').length !== 1) return { kind: 'same-direction' };
  if (legs[0].accountId === legs[1].accountId) {
    // 3.10: a same-account cash FX conversion (different currencies, both amounts non-zero) is a pair.
    const fx = legs[0].currency !== legs[1].currency && legs[0].absCents > 0 && legs[1].absCents > 0;
    if (!fx) return { kind: 'one-account' };
  }
  if (legs.some(carriesSecurity)) {
    const [a, b] = legs;
    const key = (r: AuditLedgerRow) => (carriesSecurity(r) ? r.assetId : '');
    if (key(a) !== key(b)) return { kind: 'security' };
    // Same asset: invalid only when both quantities are known and differ.
    // Wealthfolio's transfer_pair_tolerance (transfer_pairs.rs): 0.000001.
    if (a.quantity != null && b.quantity != null && Math.abs(Math.abs(a.quantity) - Math.abs(b.quantity)) > 1e-6) {
      return { kind: 'security' };
    }
  }
  return null;
}

export function healthIssues(facts: HealthFacts): HealthReport {
  const failed = new Set(facts.failed ?? []);
  const notes = READ_ORDER.filter((r) => failed.has(r)).map((r) => HEALTH_READ_NOTES[r]);
  if (!facts.ledger) {
    return { issues: null, notes: notes.includes(HEALTH_READ_NOTES.ledger) ? notes : [HEALTH_READ_NOTES.ledger, ...notes] };
  }

  const accounts = new Map(facts.ledger.accounts.map((a) => [a.id, a]));
  const sfinOf = new Map(Object.entries(facts.mapping ?? {}).filter(([, wf]) => !!wf).map(([sfin, wf]) => [wf, sfin]));
  const legOf = (r: AuditLedgerRow): HealthLeg => {
    const sfin = sfinOf.get(r.accountId);
    const txId = txIdFromComment(r.notes);
    return {
      activityId: r.id, accountId: r.accountId, accountName: accounts.get(r.accountId)?.name ?? r.accountId,
      txKey: sfin && txId ? accountTxKey(sfin, txId) : null,
      date: r.date, absCents: r.absCents, type: r.type, currency: r.currency, description: descriptionFromComment(r.notes),
    };
  };
  const rows = [...facts.ledger.rows].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // ── 1. transfer legs, as Health reads them: pairs from every row, legs
  //       reported only in active accounts that are not archived ──
  const groups = groupsOf(rows);
  const eligible = (r: AuditLedgerRow) => {
    const a = accounts.get(r.accountId);
    return !!a && !a.archived && a.active !== false;
  };
  const incomplete: Array<{ row: AuditLedgerRow; problem: GroupProblem | null }> = [];
  for (const r of rows) {
    if (!isTransferType(r.type) || r.status !== 'POSTED' || !eligible(r)) continue;
    const problem = r.group.trim() ? groupProblem(groups.get(r.group)!) : null;
    if (r.group.trim() && !problem) {
      if (r.external) incomplete.push({ row: r, problem: { kind: 'marked-external' } });
      continue;
    }
    if (!r.external) incomplete.push({ row: r, problem });
  }

  // ── fix-transfers.mjs's matcher, over accounts that are not archived ──
  const live = rows.filter((r) => !accounts.get(r.accountId)?.archived);
  // A pair is valid by ALL rows' groups: a partner in an archived account still counts.
  const inValidPair = (r: AuditLedgerRow) => isTransferType(r.type) && !!r.group && groupProblem(groups.get(r.group) ?? []) === null;
  const userLegs = live.filter((r) => eligible(r) && isTransferType(r.type) && r.status === 'POSTED' && !inValidPair(r) && !r.external
    && !isBookkeeping(r) && !isPlaceholderNote(r.notes));
  const userIds = new Set(userLegs.map((l) => l.id));
  // A pending row (the sync's ` · pending` note) is never offered: the sync never pairs one.
  const counterparts = (leg: AuditLedgerRow) => live.filter((c) => c.id !== leg.id && c.accountId !== leg.accountId
    && c.currency === leg.currency && c.status === 'POSTED' && !isPendingNote(c.notes) && !isBookkeeping(c) && !inValidPair(c)
    // A transfer-typed row in a (broken) group is somebody's half already; Link would delete and re-create it.
    && !(isTransferType(c.type) && c.group.trim())
    && c.absCents === leg.absCents && Math.abs(dayMs(c.date) - dayMs(leg.date)) <= MATCH_DAYS * 86_400_000
    && (leg.type === 'TRANSFER_OUT' ? INFLOW.has(c.type) : OUTFLOW.has(c.type)));
  const claims = new Map<string, number>();
  const proposals: Array<{ leg: AuditLedgerRow; other: AuditLedgerRow }> = [];
  const many = new Set<string>();
  for (const leg of userLegs) {
    const cs = counterparts(leg);
    if (cs.length === 1) {
      proposals.push({ leg, other: cs[0] });
      claims.set(cs[0].id, (claims.get(cs[0].id) ?? 0) + 1);
    } else if (cs.length > 1) many.add(leg.id);
  }
  // Unique both ways; a pair of two incomplete legs is found from both ends.
  const seen = new Set<string>();
  const pairs: Array<{ leg: AuditLedgerRow; other: AuditLedgerRow }> = [];
  for (const p of proposals) {
    const key = [p.leg.id, p.other.id].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const contested = ((claims.get(p.other.id) ?? 0) > 1 && !userIds.has(p.other.id)) || many.has(p.other.id);
    if (contested) many.add(p.leg.id);
    else pairs.push(p);
  }
  const listed = new Set(incomplete.map((i) => i.row.id));

  const issues: HealthIssue[] = [];
  for (const { row, problem } of incomplete) {
    const owner = isBookkeeping(row) || isPlaceholderNote(row.notes) ? 'add-on' as const : 'you' as const;
    const paired = problem?.kind === 'marked-external';
    let match: 'one' | 'many' | 'none' | 'skipped' = owner === 'you' && !paired ? 'none' : 'skipped';
    let counterpart: HealthLeg | null = null;
    if (match === 'none') {
      const pair = pairs.find((p) => p.leg.id === row.id || p.other.id === row.id);
      const found = pair && (pair.leg.id === row.id ? pair.other : pair.leg);
      // Found from the other end: a grouped transfer row is never the answer for an ungrouped one.
      if (pair && found && !(isTransferType(found.type) && found.group.trim() && !row.group.trim())) {
        const other = found;
        // Both halves incomplete: one issue, from the leg the money left.
        if (listed.has(other.id) && row.type !== 'TRANSFER_OUT' && other.type === 'TRANSFER_OUT') continue;
        match = 'one';
        counterpart = legOf(other);
      } else if (many.has(row.id)) match = 'many';
    }
    issues.push({ kind: 'incomplete-leg', key: `leg:${row.id}`, leg: legOf(row), problem, owner, match, counterpart });
  }

  // ── 2. starting balances dated on or after the earliest other row ──
  const late = rows
    .filter((r) => isStartingBalanceNote(r.notes))
    .flatMap((r) => {
      const earliest = rows.filter((b) => b.accountId === r.accountId && !isStartingBalanceNote(b.notes)).map((b) => b.date).sort()[0];
      if (!earliest || r.date < earliest) return [];
      const account = accounts.get(r.accountId);
      return [{
        kind: 'late-start' as const, key: `late-start:${r.id}`, activityId: r.id, accountId: r.accountId,
        accountName: account?.name ?? r.accountId, date: r.date, earliest, cents: r.absCents,
      }];
    })
    .sort((a, b) => a.accountName.localeCompare(b.accountName) || a.date.localeCompare(b.date));
  issues.push(...late);

  // ── 3. the phantom $CASH security ──
  const phantom = rows.filter((r) => r.phantomCash);
  if (phantom.length > 0) {
    const byAccount = new Map<string, number>();
    for (const r of phantom) {
      const name = accounts.get(r.accountId)?.name ?? r.accountId;
      byAccount.set(name, (byAccount.get(name) ?? 0) + 1);
    }
    issues.push({
      kind: 'phantom-cash', key: 'phantom-cash', rows: phantom.length,
      accounts: [...byAccount].sort(([a], [b]) => a.localeCompare(b)).map(([name, n]) => ({ name, rows: n })),
    });
  }
  return { issues, notes };
}

/** How many issues, or null when Health was not checked. */
export function healthCount(r: HealthReport): number | null {
  return r.issues === null ? null : r.issues.length + (r.more ?? 0);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "TRANSFER TO ALLY · $600.00 · PNC Checking · Oct 4". Raw. */
export function healthLegLine(l: HealthLeg): string {
  return `${l.description || 'A transaction'} · ${changeMoney(l.absCents)} · ${l.accountName} · ${changeDay(l.date)}`;
}

/** The issue's one-line title. Raw. */
export function healthIssueTitle(i: HealthIssue): string {
  switch (i.kind) {
    case 'incomplete-leg': return healthLegLine(i.leg);
    case 'phantom-cash':
      return `${i.rows} ${plural(i.rows, 'row points', 'rows point')} at a $CASH asset (${i.accounts.map((a) => `${a.name}: ${a.rows}`).join(', ')})`;
    case 'late-start':
      return i.date === i.earliest
        ? `${i.accountName}'s starting balance is dated ${changeDay(i.date)}, the same day as its earliest transaction`
        : `${i.accountName}'s starting balance is dated ${changeDay(i.date)}, after its earliest transaction (${changeDay(i.earliest)})`;
  }
}

function problemText(p: GroupProblem): string {
  switch (p.kind) {
    case 'legs': return `its group has ${p.count} transfer rows`;
    case 'same-direction': return 'both rows move money the same way';
    case 'one-account': return 'both rows are in one account';
    case 'security': return 'the rows carry different assets or quantities';
    case 'marked-external': return 'marked-external';
  }
}

/** What the issue is and what to do about it. Raw. */
export function healthIssueLines(i: HealthIssue): string[] {
  switch (i.kind) {
    case 'incomplete-leg': {
      if (i.problem?.kind === 'marked-external' && i.owner === 'add-on') {
        return [
          'Linked, but marked as money moving in or out of Wealthfolio, which contradicts the pair.',
          "One of the add-on's own rows — the sync handles its marks itself.",
        ];
      }
      if (i.problem?.kind === 'marked-external') {
        return [
          'Linked, but marked as money moving in or out of Wealthfolio, which contradicts the pair.',
          'Unlink the two and link them again in Wealthfolio — linking clears the mark.',
        ];
      }
      const what = i.problem === null ? 'Not linked to its other half.' : `Linked, but Wealthfolio won't accept the pair: ${problemText(i.problem)}.`;
      const todo = i.owner === 'add-on' ? "One of the add-on's own rows — the sync marks these so Health skips them."
        : i.match === 'one' && i.counterpart ? `Likely the other half: ${healthLegLine(i.counterpart)}`
            : i.match === 'many' ? 'It could pair with more than one row — link the right two in Wealthfolio.'
              : `No likely other half within ${MATCH_DAYS} days — if it has one, link the two in Wealthfolio.`;
      return [what, todo];
    }
    case 'phantom-cash':
      return ['Older Wealthfolio versions filed these under a $CASH asset. Clean-up needs the server tool fix-transfers.mjs.'];
    case 'late-start':
      return ['A deep scan moves it to the day before your earliest transaction.'];
  }
}
