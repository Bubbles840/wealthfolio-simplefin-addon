/**
 * shared/audit-balance.ts
 *
 * "Why is this account off from the bank?" (2c R1, spec A1). Pure: the
 * companion gathers the facts (companion/src/audit-facts.ts); Telegram's
 * `/audit` and the app render the lines built here.
 *
 * Every amount is in cents, in Wealthfolio's sign: money in a cash account is
 * positive and a card's debt is negative, which is also how SimpleFin reports
 * a card's balance.
 *
 *  - The bank's figure is SimpleFin's posted balance (`account_balances`).
 *  - Wealthfolio's figure is `/valuations/latest` for every account but a
 *    card, and for a card the WHOLE ledger, pending rows included — what the
 *    card's page in Wealthfolio adds up to (getNativeAccountBalances leaves
 *    pending rows out; here they are a cause of their own).
 *  - offCents = bank − Wealthfolio: the sync's drift (shared/sync-core.ts,
 *    `d = sfBalance − adjustedWfValuation`).
 *  - A cause's cents is its share of offCents, so
 *    unexplainedCents = offCents − Σ causes. A cause whose sign differs from
 *    the gap's pulls the other way and is shown with a minus.
 *
 * The causes, each a set of rows the two figures disagree about:
 *  - pending: in Wealthfolio, not yet in the bank's posted balance;
 *  - after-bank-date: dated after the bank's balance date, so newer than the
 *    bank's figure;
 *  - not-booked: a TRANSFER_OUT carrying an asset, which Wealthfolio's
 *    valuation never takes out of the cash (the sync subtracts these too:
 *    `assetBackedTransferOut`) — non-card accounts only;
 *  - held / unlinked: the other half of a transfer that left (or reached)
 *    ANOTHER account and never arrived here — a held in-transit placeholder,
 *    or a plain unlinked transfer leg ("a card payment still unlinked" on a
 *    card). Matched as companion/src/ledger-facts.ts matches a missing leg:
 *    the leg's amount, in the direction the money went, equals what is left
 *    of exactly one account's gap, and only one such leg points at it.
 */
import { changeDay, changeMoney } from './change-entries.js';
import { isTransferType } from './sync-core.js';
import {
  cashEffectCents, isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote,
  type AuditLedger, type AuditLedgerRow,
} from './audit-ledger.js';

export type BalanceRead = 'mapping' | 'balances' | 'names' | 'accounts' | 'valuations' | 'ledger';

/** One note per failed read, in this order. */
export const BALANCE_READ_NOTES: Record<BalanceRead, string> = {
  mapping: "Couldn't read which accounts are mapped.",
  balances: "Couldn't read the bank balances.",
  names: "Couldn't read the account names — showing Wealthfolio's.",
  accounts: "Couldn't read your account list just now, so no account is compared.",
  valuations: "Couldn't read Wealthfolio's balances, so cash accounts aren't compared.",
  ledger: "Couldn't read the Wealthfolio database, so cards aren't compared and nothing is explained.",
};
const READ_ORDER: BalanceRead[] = ['mapping', 'balances', 'names', 'accounts', 'valuations', 'ledger'];

export const BALANCE_NO_BANK = "The bank hasn't sent a balance for this account.";
export const BALANCE_MATCHES = 'Matches the bank.';
export const BALANCE_NOT_EXPLAINED = 'not explained by anything the add-on knows';

export interface BalanceFacts {
  /** account_mapping: SimpleFin account id → Wealthfolio account id. */
  mapping?: Record<string, string>;
  /** account_balances as stored, by SimpleFin account id. */
  balances?: Record<string, { balance?: unknown; date?: unknown } | null | undefined>;
  /** account_names: SimpleFin account id → name. */
  names?: Record<string, string>;
  /** Account type (upper-case) by Wealthfolio account id, from the accounts
   *  REST route. When present it is authoritative: an id missing from it, or
   *  with a blank type, is of UNKNOWN type and is never compared. When absent,
   *  the ledger's account types are used. */
  accountTypes?: Record<string, string>;
  /** `/valuations/latest`, in cents, by Wealthfolio account id. */
  valuations?: Record<string, number>;
  ledger?: AuditLedger;
  /** Reads that failed; each leaves out only its own part. */
  failed?: BalanceRead[];
}

export type BankFigure =
  /** `date`: the bank's balance date as YYYY-MM-DD (UTC, like every stored
   *  row date); null when SimpleFin sent none. */
  | { kind: 'ok'; cents: number; date: string | null }
  /** SimpleFin sent no numeric balance. */
  | { kind: 'none' }
  /** account_balances could not be read. */
  | { kind: 'unread' };

export type BalanceCauseKind = 'pending' | 'after-bank-date' | 'held' | 'unlinked' | 'not-booked';
export interface BalanceCause { kind: BalanceCauseKind; cents: number; count: number }

export interface BalanceIncludes {
  start: { cents: number; date: string } | null;
  corrections: { count: number; cents: number; latest: string } | null;
}

export interface BalanceExplanation {
  wfAccountId: string;
  /** Raw: escaped by Telegram, rendered as text by the app. */
  name: string;
  /** Upper-case; '' when the database could not say. */
  accountType: string;
  bank: BankFigure;
  /** null: Wealthfolio's figure could not be read. */
  wealthfolioCents: number | null;
  /** bank − Wealthfolio; null when either is unknown. */
  offCents: number | null;
  /** null: the database could not be read, so nothing is explained. */
  causes: BalanceCause[] | null;
  /** null when offCents or causes is. */
  unexplainedCents: number | null;
  includes: BalanceIncludes | null;
}

export interface BalanceReport {
  /** Mapped accounts, in mapping order. */
  accounts: BalanceExplanation[];
  notes: string[];
}

function bankFigure(facts: BalanceFacts, sfinId: string): BankFigure {
  if (!facts.balances) return { kind: 'unread' };
  const snap = facts.balances[sfinId];
  if (!snap || typeof snap.balance !== 'number' || !Number.isFinite(snap.balance)) return { kind: 'none' };
  const date = typeof snap.date === 'number' && snap.date > 0 ? new Date(snap.date * 1000).toISOString().slice(0, 10) : null;
  return { kind: 'ok', cents: Math.round(snap.balance * 100), date };
}

interface Draft { e: BalanceExplanation; residual: number | null }

function draft(sfinId: string, wfId: string, facts: BalanceFacts, rows: AuditLedgerRow[]): Draft {
  const account = facts.ledger?.accounts.find((a) => a.id === wfId);
  const accountType = facts.accountTypes ? (facts.accountTypes[wfId] ?? '') : (account?.type ?? '');
  const isCard = accountType === 'CREDIT_CARD';
  const name = facts.names?.[sfinId] || account?.name || sfinId;
  const bank = bankFigure(facts, sfinId);
  const wealthfolioCents = isCard
    ? (facts.ledger ? rows.reduce((sum, r) => sum + cashEffectCents(r, accountType), 0) : null)
    : (facts.valuations ? (facts.valuations[wfId] ?? null) : null);
  const offCents = bank.kind === 'ok' && wealthfolioCents !== null ? bank.cents - wealthfolioCents : null;
  const e: BalanceExplanation = {
    wfAccountId: wfId, name, accountType, bank, wealthfolioCents, offCents,
    causes: null, unexplainedCents: null, includes: null,
  };
  if (!facts.ledger) return { e, residual: null };

  const bankDay = bank.kind === 'ok' ? bank.date : null;
  const sum = { pending: { cents: 0, count: 0 }, after: { cents: 0, count: 0 }, notBooked: { cents: 0, count: 0 } };
  for (const r of rows) {
    const effect = cashEffectCents(r, accountType);
    // In neither figure: the valuation never booked it, and the bank has not
    // posted it (pending) or not yet counted it (after its date).
    const unbooked = !isCard && r.rawType === 'TRANSFER_OUT' && r.assetId !== '';
    if (isPendingNote(r.notes)) {
      if (!unbooked) { sum.pending.cents -= effect; sum.pending.count += 1; }
    } else if (bankDay !== null && r.date > bankDay) {
      if (!unbooked) { sum.after.cents -= effect; sum.after.count += 1; }
    } else if (unbooked) {
      sum.notBooked.cents += effect;
      sum.notBooked.count += 1;
    }
  }
  const causes: BalanceCause[] = [];
  if (sum.pending.cents !== 0) causes.push({ kind: 'pending', ...sum.pending });
  if (sum.after.cents !== 0) causes.push({ kind: 'after-bank-date', ...sum.after });
  if (sum.notBooked.cents !== 0) causes.push({ kind: 'not-booked', ...sum.notBooked });
  e.causes = causes;

  const starts = rows.filter((r) => isStartingBalanceNote(r.notes)).sort((a, b) => a.date.localeCompare(b.date));
  const fixes = rows.filter((r) => isCorrectionNote(r.notes));
  e.includes = {
    start: starts[0] ? { cents: cashEffectCents(starts[0], accountType), date: starts[0].date } : null,
    corrections: fixes.length === 0 ? null : {
      count: fixes.length,
      cents: fixes.reduce((s, r) => s + cashEffectCents(r, accountType), 0),
      latest: fixes.map((r) => r.date).sort().at(-1)!,
    },
  };
  const residual = offCents === null ? null : offCents - causes.reduce((s, c) => s + c.cents, 0);
  return { e, residual };
}

/** Every mapped account, explained. */
export function explainBalances(facts: BalanceFacts): BalanceReport {
  const failed = new Set(facts.failed ?? []);
  const notes = READ_ORDER.filter((r) => failed.has(r)).map((r) => BALANCE_READ_NOTES[r]);
  if (!facts.mapping) return { accounts: [], notes };

  const rowsByAccount = new Map<string, AuditLedgerRow[]>();
  for (const r of facts.ledger?.rows ?? []) {
    const list = rowsByAccount.get(r.accountId) ?? [];
    list.push(r);
    rowsByAccount.set(r.accountId, list);
  }
  const drafts = Object.entries(facts.mapping)
    .filter(([, wfId]) => !!wfId)
    .map(([sfinId, wfId]) => draft(sfinId, wfId, facts, rowsByAccount.get(wfId) ?? []));

  // The other half of a transfer elsewhere: a leg that matches exactly one
  // account's remaining gap, and the only leg that matches it.
  const residuals = new Map(drafts.filter((d) => d.residual !== null && d.residual !== 0).map((d) => [d.e.wfAccountId, d.residual!]));
  const claimed = new Map<string, AuditLedgerRow[]>();
  for (const leg of facts.ledger?.rows ?? []) {
    if (!isTransferType(leg.rawType) || leg.group !== '' || isPendingNote(leg.notes)
      || isStartingBalanceNote(leg.notes) || isCorrectionNote(leg.notes)) continue;
    const want = leg.rawType === 'TRANSFER_OUT' ? leg.absCents : -leg.absCents;
    const hits = [...residuals].filter(([id, residual]) => id !== leg.accountId && residual === want);
    if (hits.length === 1) claimed.set(hits[0][0], [...(claimed.get(hits[0][0]) ?? []), leg]);
  }
  for (const d of drafts) {
    const legs = claimed.get(d.e.wfAccountId) ?? [];
    if (legs.length !== 1 || !d.e.causes) continue;
    const leg = legs[0];
    const cause: BalanceCause = {
      kind: isPlaceholderNote(leg.notes) ? 'held' : 'unlinked',
      cents: leg.rawType === 'TRANSFER_OUT' ? leg.absCents : -leg.absCents,
      count: 1,
    };
    const at = d.e.causes.findIndex((c) => c.kind === 'not-booked');
    d.e.causes.splice(at === -1 ? d.e.causes.length : at, 0, cause);
  }
  for (const d of drafts) {
    if (d.e.offCents !== null && d.e.causes) {
      d.e.unexplainedCents = d.e.offCents - d.e.causes.reduce((s, c) => s + c.cents, 0);
    }
  }
  return { accounts: drafts.map((d) => d.e), notes };
}

/** One account's explanation, or null when it is not mapped. */
export function explainBalance(facts: BalanceFacts, wfAccountId: string): BalanceExplanation | null {
  return explainBalances(facts).accounts.find((a) => a.wfAccountId === wfAccountId) ?? null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const signed = (cents: number) => `${cents > 0 ? '+' : ''}${changeMoney(cents)}`;

/** "Bank: $2,481.07 (Oct 13) · Wealthfolio: $2,431.07 · Off by $50.00". Raw. */
export function balanceHeaderLine(e: BalanceExplanation): string {
  if (e.bank.kind === 'none') return BALANCE_NO_BANK;
  const bank = e.bank.kind === 'ok'
    ? `Bank: ${changeMoney(e.bank.cents)}${e.bank.date ? ` (${changeDay(e.bank.date)})` : ''}`
    : 'Bank: —';
  const wf = `Wealthfolio: ${e.wealthfolioCents === null ? '—' : changeMoney(e.wealthfolioCents)}`;
  const verdict = e.offCents === null ? null : e.offCents === 0 ? BALANCE_MATCHES : `Off by ${changeMoney(Math.abs(e.offCents))}`;
  return [bank, wf, verdict].filter((p): p is string => !!p).join(' · ');
}

function causePhrase(c: BalanceCause, e: BalanceExplanation): string {
  const n = c.count;
  switch (c.kind) {
    case 'pending':
      return `in ${n} pending ${plural(n, 'transaction', 'transactions')} the bank hasn't posted`;
    case 'after-bank-date': {
      const day = e.bank.kind === 'ok' && e.bank.date ? changeDay(e.bank.date) : '';
      return `in ${n} ${plural(n, 'transaction', 'transactions')} newer than the bank's figure, which is from ${day}`;
    }
    case 'held':
      return `in ${n} ${plural(n, 'transfer', 'transfers')} held waiting for ${plural(n, 'its', 'their')} other half`;
    case 'unlinked':
      return e.accountType === 'CREDIT_CARD'
        ? `in ${n} card ${plural(n, 'payment', 'payments')} still unlinked`
        : `in ${n} ${plural(n, 'transfer', 'transfers')} still unlinked`;
    case 'not-booked':
      return `in ${n} ${plural(n, 'transfer', 'transfers')} out that Wealthfolio never took out of this balance (${plural(n, 'it carries', 'they carry')} an asset)`;
  }
}

/** One line per cause, then what is left: shown only while the account is off. Raw. */
export function balanceCauseLines(e: BalanceExplanation): string[] {
  if (e.offCents === null || e.offCents === 0 || e.causes === null) return [];
  const off = e.offCents;
  const shown = (cents: number) => changeMoney(off < 0 ? -cents : cents);
  const lines = e.causes.map((c) => `${shown(c.cents)} ${causePhrase(c, e)}`);
  if (e.unexplainedCents) lines.push(`${shown(e.unexplainedCents)} ${BALANCE_NOT_EXPLAINED}`);
  return lines;
}

/** "Includes: starting balance $1,204.00 (Aug 2) · 1 correction, +$12.40 (Sep 30)", or null. Raw. */
export function balanceIncludesLine(e: BalanceExplanation): string | null {
  const inc = e.includes;
  if (!inc || (!inc.start && !inc.corrections)) return null;
  const parts: string[] = [];
  if (inc.start) parts.push(`starting balance ${changeMoney(inc.start.cents)} (${changeDay(inc.start.date)})`);
  if (inc.corrections) {
    const c = inc.corrections;
    parts.push(c.count === 1
      ? `1 correction, ${signed(c.cents)} (${changeDay(c.latest)})`
      : `${c.count} corrections, ${signed(c.cents)} (latest ${changeDay(c.latest)})`);
  }
  return `Includes: ${parts.join(' · ')}`;
}

/** The account's state in a few words, for a list: "off by $50.00". Raw. */
export function balanceShort(e: BalanceExplanation): string {
  if (e.bank.kind === 'none') return 'no bank balance';
  if (e.offCents === null) return 'not compared';
  return e.offCents === 0 ? 'matches' : `off by ${changeMoney(Math.abs(e.offCents))}`;
}
