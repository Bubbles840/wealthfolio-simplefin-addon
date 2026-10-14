/**
 * shared/tx-story.ts
 *
 * "Why is this here?" — one transaction's story, told the same way in `/why`
 * and in the app: a title (description · signed amount · date, the account
 * below), a few plain lines that answer why — where it came from, what it is,
 * who filed it, what you told the sync — then "What happened", the change-log
 * entries about it, oldest first.
 *
 * Pure. Each host gathers what IT can see into `TxStoryFacts`
 * (companion/src/tx-story-host.ts, src/utils/tx-story.ts). Only the row is
 * required: a fact that is absent leaves its line out, and a read that FAILED
 * is named in `failed`, which leaves its line out and adds a note instead.
 *
 * Who filed a row is inferred honestly (`resolveFiler`): Wealthfolio records
 * THAT a rule filed it, not which rule, so the rule named is the one
 * Wealthfolio applies first among those that would file this row under this
 * category today — its rule list comes back highest priority first, and the
 * first wins a tie (upstream `match_compiled`, strict `>`).
 *
 * Every string returned is RAW. Telegram escapes bank and user text at render
 * and keeps it outside every `*…*`/`_…_`; the app renders it as text.
 */
import { amazonLabelOf, changeDay, changeDayYear, changeMoney, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { changeLocalDay } from './change-view.js';
import { IN_TRANSIT_COMMENT_PREFIX } from './reconcile.js';
import {
  BALANCE_ADJUSTMENT_COMMENT_PREFIX, IN_TRANSIT_TIMEOUT_SECONDS, PENDING_SUFFIX, STARTING_BALANCE_COMMENT_PREFIX,
  isTransferType, txIdFromComment,
} from './sync-core.js';
import type { TxOverrideFlag } from './sync-overrides.js';
import { txDescription } from './tx-search.js';

// ── Copy ─────────────────────────────────────────────────────────────────

export const TX_STORY_NOT_FROM_FEED = 'Not from your bank feed — added in Wealthfolio by hand or from a file.';
export const TX_STORY_SPENDING = 'Spending.';
export const TX_STORY_MONEY_IN = 'Money in.';
export const TX_STORY_NOT_FILED = "Not filed yet — it's on your needs-a-category list.";
export const TX_STORY_ASK_TELEGRAM = 'Ask /why in Telegram to see who filed it.';
export const TX_STORY_SET_IN_WEALTHFOLIO = 'Category set in Wealthfolio.';
export const TX_STORY_NO_HISTORY = 'No changes in the last 90 days.';
export const TX_STORY_WHAT_HAPPENED = 'What happened';
export const TX_STORY_UNREACHABLE = "Couldn't reach Wealthfolio — try again.";
/** A Telegram button whose transaction no longer exists (a transfer link
 *  re-created it, or it was removed). */
export const TX_STORY_GONE = 'That transaction has changed since — search again with /why.';
/** The same, in the app, which has its own search box. */
export const TX_STORY_GONE_APP = 'That transaction has changed since — search for it again.';

/** Reads a host can fail, each with the note the story carries. */
export type TxFactName =
  | 'mapping' | 'partner' | 'category' | 'rules' | 'changeLog' | 'overrides' | 'overridesUnreadable' | 'skipList';

export const TX_FACT_NOTES: Record<TxFactName, string> = {
  mapping: "Couldn't read your account mapping just now, so where it came from is left out.",
  partner: "Couldn't read the other half of this transfer just now.",
  category: "Couldn't read its category just now.",
  rules: "Couldn't read your category rules just now, so the rule isn't named.",
  changeLog: "Couldn't read the change log just now.",
  overrides: "Couldn't read your overrides just now.",
  overridesUnreadable: "Your sync overrides can't be read, so any you set aren't shown.",
  skipList: "Couldn't read your skip list just now.",
};
const FACT_ORDER: readonly TxFactName[] = ['mapping', 'partner', 'category', 'rules', 'changeLog', 'overrides', 'overridesUnreadable', 'skipList'];

/** "You told the sync: …" — one phrase per override, and the skip list. */
export const TX_OVERRIDE_WORDS: Record<TxOverrideFlag | 'skipped', string> = {
  notTransfer: 'not a transfer',
  keepDuplicate: 'keep this duplicate',
  noAutoFile: "don't file it automatically",
  noAmazonLabel: 'no Amazon label',
  skipped: "don't import it",
};
const OVERRIDE_ORDER: ReadonlyArray<TxOverrideFlag | 'skipped'> = ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel', 'skipped'];

// ── Facts ────────────────────────────────────────────────────────────────

export interface TxStoryRow {
  activityId: string;
  /** The stored note, raw. */
  note: string;
  /** Unsigned cents: Wealthfolio's type carries the direction. */
  absCents: number;
  /** YYYY-MM-DD. */
  date: string;
  activityType: string;
  accountName: string;
  /** Wealthfolio account type (CASH, CREDIT_CARD, …); absent when unknown. */
  accountType?: string;
}

/** The other half of a linked transfer. */
export interface TxPartner {
  accountName: string;
  /** YYYY-MM-DD, when the host can see it. */
  date?: string;
}

/** Who put the category on. `rule.pattern` null: none of the current rules
 *  would file it; `unknown`: the rules could not be read. */
export type TxFiler =
  | { kind: 'rule'; pattern: string | null; unknown?: true }
  | { kind: 'you'; at?: string }
  | { kind: 'amazon'; label: string }
  | { kind: 'opening' }
  | { kind: 'hand' };

export interface TxStoryFacts {
  row: TxStoryRow;
  /** The clock the title's year is judged against; defaults to the real one. */
  now?: Date;
  /** The SimpleFin account the row's account syncs from; null when the
   *  add-on does not sync that account. */
  feed?: { sfinAccountId: string } | null;
  /** The other half of a linked transfer; null when the row is not linked. */
  partner?: TxPartner | null;
  /** Its category; null when it has none. `filer` absent: can't be told. */
  category?: { name: string; filer?: TxFiler | null } | null;
  /** On the needs-a-category list — all the app knows of an unfiled row. */
  needsCategory?: boolean;
  /** The app cannot see a filing: where to send the reader. */
  filerHint?: 'telegram' | 'wealthfolio';
  /** What you told the sync about this transaction. */
  overrides?: readonly TxOverrideFlag[];
  /** On the skip list. */
  skipped?: boolean;
  /** Change-log entries about it (`changesForTransaction`), in any order. */
  history?: readonly ChangeLogItem[];
  /** Reads that failed. Each leaves its line out and adds a note. */
  failed?: readonly TxFactName[];
}

export interface TxStoryHistoryLine {
  entryId: string;
  /** `Oct 4 · <summary>`. */
  line: string;
}

export interface TxStory {
  /** `<description> · <signed amount> · <date>`. */
  title: string;
  accountLine: string;
  answer: string[];
  /** Oldest first. Null when the change log was not read. */
  history: TxStoryHistoryLine[] | null;
  notes: string[];
}

// ── Helpers both hosts use ───────────────────────────────────────────────

const OUTFLOW = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX']);

/** Money out: the spending types, and interest charged on a card. */
export function isOutflow(activityType: string, accountType?: string): boolean {
  const t = activityType.toUpperCase();
  return OUTFLOW.has(t) || (t === 'INTEREST' && (accountType ?? '').toUpperCase() === 'CREDIT_CARD');
}

/** Signed cents for a row: money out negative. */
export function signedCents(row: Pick<TxStoryRow, 'absCents' | 'activityType' | 'accountType'>): number {
  const abs = Math.abs(Math.round(row.absCents));
  return isOutflow(row.activityType, row.accountType) ? -abs : abs;
}

const AMAZON_MARK = ' · Amazon: ';

/** A description's own words and the Amazon label the sync appended. */
export function splitAmazonLabel(description: string): { bare: string; label: string | null } {
  const at = description.indexOf(AMAZON_MARK);
  if (at === -1) return { bare: description, label: null };
  const bare = description.slice(0, at);
  const label = amazonLabelOf(bare, description).trim();
  return { bare, label: label || null };
}

/** A Wealthfolio categorization rule, as much of it as decides a match. */
export interface CategoryRuleLike {
  id: string;
  pattern: string;
  /** `contains` (the default), `starts_with`, `exact`, `regex`. */
  matchType?: string | null;
  /** The taxonomy the rule files into (informational: category ids are
   *  unique across taxonomies, so inference compares the category). */
  taxonomyId?: string | null;
  categoryId: string | null;
  priority?: number | null;
  /** False: only `accountId`'s rows. */
  isGlobal?: boolean | null;
  accountId?: string | null;
  activityType?: string | null;
  /** On the unsigned amount: eq, gt, gte, lt, lte, between. */
  amountOp?: string | null;
  amountValue?: number | string | null;
  amountValue2?: number | string | null;
}

/** What a rule is matched against. */
export interface RuleRow {
  note: string;
  activityType: string;
  /** Wealthfolio account id. */
  accountId: string;
  absCents: number;
}

/** Wealthfolio's own matcher, transcribed (upstream `match_compiled`):
 *  account scope, activity type, the amount condition, then the pattern —
 *  case-insensitive except a regex, which a bad pattern never matches. */
export function ruleMatchesRow(rule: CategoryRuleLike, row: RuleRow): boolean {
  if (rule.isGlobal === false && rule.accountId !== row.accountId) return false;
  if (rule.activityType && rule.activityType.toUpperCase() !== row.activityType.toUpperCase()) return false;
  if (rule.amountOp) {
    const amount = Math.abs(row.absCents) / 100;
    const value = Number(rule.amountValue);
    if (rule.amountValue === null || rule.amountValue === undefined || !Number.isFinite(value)) return false;
    const upper = Number(rule.amountValue2);
    const ok = rule.amountOp === 'eq' ? amount === value
      : rule.amountOp === 'gt' ? amount > value
        : rule.amountOp === 'gte' ? amount >= value
          : rule.amountOp === 'lt' ? amount < value
            : rule.amountOp === 'lte' ? amount <= value
              : rule.amountOp === 'between' ? Number.isFinite(upper) && amount >= value && amount <= upper
                : false;
    if (!ok) return false;
  }
  const note = row.note;
  const pattern = rule.pattern ?? '';
  switch (rule.matchType ?? 'contains') {
    case 'starts_with': return note.toUpperCase().startsWith(pattern.toUpperCase());
    case 'exact': return note.toUpperCase() === pattern.toUpperCase();
    case 'regex':
      try {
        return new RegExp(pattern).test(note);
      } catch {
        return false;
      }
    default: return note.toUpperCase().includes(pattern.toUpperCase());
  }
}

/** The rule that would file this row under this category, the one Wealthfolio
 *  applies first: highest priority, the earlier-listed one on a tie (the list
 *  arrives priority-first, oldest-first). Null when none would. */
export function inferFilingRule(rules: readonly CategoryRuleLike[], row: RuleRow, categoryId: string): CategoryRuleLike | null {
  const ranked = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.categoryId === categoryId && ruleMatchesRow(rule, row))
    .sort((a, b) => ((b.rule.priority ?? 0) - (a.rule.priority ?? 0)) || a.index - b.index);
  return ranked[0]?.rule ?? null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const afterCategoryId = (e: ChangeEntry) => (isRecord(e.after) && typeof e.after.categoryId === 'string' ? e.after.categoryId : null);

export interface FilerInput {
  /** The assignment's `source` (`rule`, `manual`, …). */
  source: string | null | undefined;
  categoryId: string;
  row: RuleRow;
  /** Entries about this transaction; null when the log could not be read. */
  history: readonly ChangeEntry[] | null;
  /** The categorization rules, listed as Wealthfolio lists them; null when
   *  they could not be read. Only read for a rule's filing. */
  rules: readonly CategoryRuleLike[] | null;
}

/**
 * Who filed it. A rule's filing names the rule (`inferFilingRule`). Anything
 * else is the newest log entry that set THIS category — you in Telegram, the
 * Amazon email, the opening-balance filing — then the note's Amazon label;
 * failing all of those, a person set it in Wealthfolio. Null when that cannot
 * be told: the log was unreadable, and nothing else says.
 */
export function resolveFiler(f: FilerInput): TxFiler | null {
  if ((f.source ?? '').toLowerCase() === 'rule') {
    if (f.rules === null) return { kind: 'rule', pattern: null, unknown: true };
    const rule = inferFilingRule(f.rules, f.row, f.categoryId);
    return { kind: 'rule', pattern: rule ? rule.pattern : null };
  }
  // A non-"Amazon: " auto filing reads as by hand: the Amazon filer is the only auto filer today.
  const filing = [...(f.history ?? [])]
    .filter((e) => (e.kind === 'category-filed' || e.kind === 'opening-balance-filed') && afterCategoryId(e) === f.categoryId)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  if (filing?.kind === 'opening-balance-filed') return { kind: 'opening' };
  if (filing?.actor === 'you') return { kind: 'you', at: filing.at };
  if (filing?.why?.startsWith('Amazon: ')) return { kind: 'amazon', label: filing.why.slice('Amazon: '.length) };
  const label = splitAmazonLabel(txDescription(f.row.note)).label;
  if (label) return { kind: 'amazon', label };
  if (f.history === null) return null;
  return { kind: 'hand' };
}

/** A filer from the report cube says "you" without a day: the day comes from
 *  the newest filing by you in the log, when there is one. */
export function withFilingDay(filer: TxFiler, history: readonly ChangeEntry[] | null | undefined): TxFiler {
  if (filer.kind !== 'you' || filer.at) return filer;
  const mine = [...(history ?? [])]
    .filter((e) => e.kind === 'category-filed' && e.actor === 'you' && afterCategoryId(e) !== null)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  return mine ? { kind: 'you', at: mine.at } : filer;
}

/** The report cube's short code for a filer (`DrillTx.f`). */
export function encodeFiler(filer: TxFiler | null | undefined): string | undefined {
  if (!filer) return undefined;
  switch (filer.kind) {
    case 'rule': return filer.unknown ? 'r?' : filer.pattern === null ? 'r' : `r:${filer.pattern}`;
    case 'you': return 'y';
    case 'amazon': return `a:${filer.label}`;
    case 'opening': return 'o';
    case 'hand': return 'h';
  }
}

/** A cube code back to a filer; null for anything this build does not know. */
export function decodeFiler(code: unknown): TxFiler | null {
  if (typeof code !== 'string') return null;
  if (code === 'r?') return { kind: 'rule', pattern: null, unknown: true };
  if (code === 'r') return { kind: 'rule', pattern: null };
  if (code.startsWith('r:') && code.length > 2) return { kind: 'rule', pattern: code.slice(2) };
  if (code === 'y') return { kind: 'you' };
  if (code.startsWith('a:') && code.length > 2) return { kind: 'amazon', label: code.slice(2) };
  if (code === 'o') return { kind: 'opening' };
  if (code === 'h') return { kind: 'hand' };
  return null;
}

// ── The story ────────────────────────────────────────────────────────────

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function filedLine(name: string, filer: TxFiler | null | undefined): string {
  if (!filer) return `Filed under ${name}.`;
  switch (filer.kind) {
    case 'rule':
      return filer.unknown
        ? `Filed under ${name} by a rule.`
        : filer.pattern === null
          ? `Filed under ${name} by a rule (none of your current rules matches it).`
          : `Filed under ${name} by a rule — '${filer.pattern}' matches it.`;
    case 'you':
      return filer.at ? `Filed under ${name} by you, in Telegram, ${changeDay(changeLocalDay(filer.at))}.` : `Filed under ${name} by you, in Telegram.`;
    case 'amazon': return `Filed under ${name} from an Amazon email.`;
    case 'opening': return `Filed under ${name} by the add-on — an opening balance isn't spending.`;
    case 'hand': return `Filed under ${name} — set by hand.`;
  }
}

export function buildTxStory(facts: TxStoryFacts): TxStory {
  const { row } = facts;
  const failed = new Set(facts.failed ?? []);
  const note = row.note ?? '';
  const out = isOutflow(row.activityType, row.accountType);
  const description = txDescription(note) || 'A transaction';
  const held = note.startsWith(IN_TRANSIT_COMMENT_PREFIX);
  const starting = note.startsWith(STARTING_BALANCE_COMMENT_PREFIX);
  const correction = note.startsWith(BALANCE_ADJUSTMENT_COMMENT_PREFIX);
  const special = held || starting || correction;
  const linked = !!facts.partner;
  const answer: string[] = [];

  // 1. Where it came from.
  if (!special && !failed.has('mapping') && facts.feed !== undefined) {
    answer.push(facts.feed && txIdFromComment(note)
      ? `From your ${row.accountName} bank feed.${note.endsWith(PENDING_SUFFIX) ? ' Still pending.' : ''}`
      : TX_STORY_NOT_FROM_FEED);
  }

  // 2. What it is.
  if (held) {
    const until = changeDay(addDays(row.date, IN_TRANSIT_TIMEOUT_SECONDS / 86_400));
    answer.push(`A transfer the sync is holding: it waits until ${until} for its other half, then counts as ${out ? 'spending' : 'money in'}.`);
  } else if (starting) {
    answer.push(`The starting balance the add-on set so ${row.accountName} matches the bank from ${changeDay(row.date)}.`);
  } else if (correction) {
    const day = /(\d{4}-\d{2}-\d{2})$/.exec(note)?.[1] ?? row.date;
    answer.push(`A correction the add-on added on ${changeDay(day)} so ${row.accountName} matches the bank.`);
  } else if (!failed.has('partner')) {
    // A failed partner read drops this whole line: a card outflow is a WITHDRAWAL and can still be linked.
    if (facts.partner) {
      const when = facts.partner.date ? `, ${changeDay(facts.partner.date)}` : '';
      answer.push(`Half of a transfer: ↔ ${changeMoney(Math.abs(row.absCents))} ${out ? 'into' : 'from'} ${facts.partner.accountName}${when}.`);
    } else if (facts.partner === null || !isTransferType(row.activityType.toUpperCase())) {
      answer.push(out ? TX_STORY_SPENDING : TX_STORY_MONEY_IN);
    }
  }

  // 3. Its category, and who filed it.
  if (!failed.has('category')) {
    const routine = !special && !linked && !isTransferType(row.activityType.toUpperCase());
    if (facts.category) answer.push(filedLine(facts.category.name, facts.category.filer));
    else if (facts.needsCategory || (facts.category === null && routine)) answer.push(TX_STORY_NOT_FILED);
    else if (facts.category === undefined && facts.filerHint && routine) {
      answer.push(facts.filerHint === 'telegram' ? TX_STORY_ASK_TELEGRAM : TX_STORY_SET_IN_WEALTHFOLIO);
    }
  }

  // 4. What you told the sync.
  const told = new Set<TxOverrideFlag | 'skipped'>([...(facts.overrides ?? []), ...(facts.skipped ? ['skipped' as const] : [])]);
  const words = OVERRIDE_ORDER.filter((w) => told.has(w)).map((w) => TX_OVERRIDE_WORDS[w]);
  if (words.length) answer.push(`You told the sync: ${words.join(', ')}.`);

  const history = failed.has('changeLog') || !facts.history
    ? null
    : [...facts.history]
      .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1))
      .map((e) => ({ entryId: e.id, line: `${changeDay(changeLocalDay(e.at))} · ${e.summary}` }));

  return {
    title: `${description} · ${changeMoney(signedCents(row))} · ${changeDayYear(row.date, facts.now ?? new Date())}`,
    accountLine: row.accountName,
    answer,
    history,
    notes: FACT_ORDER.filter((f) => failed.has(f)).map((f) => TX_FACT_NOTES[f]),
  };
}
