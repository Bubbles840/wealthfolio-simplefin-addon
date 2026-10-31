/**
 * shared/receipt-flow.ts
 *
 * The receipt reader's state, its Telegram screens and its writes, decided
 * purely (docs/superpowers/specs/2026-10-29-receipt-reader-design.md). The
 * companion (companion/src/receipt-host.ts) reads the photo, calls the model,
 * and carries out what this module decides.
 *
 * Two secrets: `receipt_reader`, the settings the add-on writes, and
 * `receipt_state`, which only the companion writes — the queue, the proposals
 * waiting for a tap, and what the reader has learned (which account tracks a
 * store's gift card, how items were filed, the tax rates receipts printed).
 *
 * Nothing is written to Wealthfolio before Confirm. A card payment splits the
 * charge the bank feed already imported; a gift card adds rows to the cash
 * account that tracks it.
 */
import type { InlineKeyboard } from './telegram.js';
import { escapeMarkdown } from './telegram.js';
import { bankDayInstant } from './bank-day.js';
import type { ActivityWrite } from './sync-host.js';
import { effectiveType, type SpendRow } from './wf-spending.js';
import {
  groupByCategory, rowsByPayment, type CategoryRow, type Receipt, type ReceiptItem, type ReceiptPayment, type TaxBasis,
} from './receipt.js';
import type { ItemFiling } from './receipt-categories.js';

export const RECEIPT_CONFIG_SECRET_KEY = 'receipt_reader';
export const RECEIPT_STATE_SECRET_KEY = 'receipt_state';
export const DEFAULT_RECEIPT_MODEL = 'qwen2.5vl:32b';
export const SPENDING_TAXONOMY = 'spending_categories';

// ── Settings ─────────────────────────────────────────────────────────────

export interface ReceiptReaderConfig {
  enabled: boolean;
  /** The model host, e.g. `http://192.168.1.20:11434`. */
  url: string;
  model: string;
}

/** The settings as stored, for the settings card; empty when unset or unreadable. */
export function receiptReaderConfigForEditing(raw: string | null | undefined): ReceiptReaderConfig {
  try {
    const v = JSON.parse(raw ?? '') as Partial<ReceiptReaderConfig>;
    return {
      enabled: v.enabled !== false,
      url: typeof v.url === 'string' ? v.url : '',
      model: typeof v.model === 'string' && v.model.trim() ? v.model : DEFAULT_RECEIPT_MODEL,
    };
  } catch {
    return { enabled: true, url: '', model: DEFAULT_RECEIPT_MODEL };
  }
}

/** The settings when the reader is switched on and has a host; null otherwise. */
export function parseReceiptReaderConfig(raw: string | null | undefined): ReceiptReaderConfig | null {
  const c = receiptReaderConfigForEditing(raw);
  return c.enabled && c.url.trim() ? { ...c, url: c.url.trim().replace(/\/+$/, ''), model: c.model.trim() } : null;
}

/** The companion's last look at the model host, for the settings card. */
export const RECEIPT_STATUS_SECRET_KEY = 'receipt_status';

export interface ReceiptHostStatus {
  checkedAt: string;
  /** Null: the host answered and has the model. */
  error: string | null;
}

export function parseReceiptHostStatus(raw: string | null | undefined): ReceiptHostStatus | null {
  try {
    const v = JSON.parse(raw ?? '') as Partial<ReceiptHostStatus>;
    return typeof v.checkedAt === 'string' ? { checkedAt: v.checkedAt, error: typeof v.error === 'string' ? v.error : null } : null;
  } catch {
    return null;
  }
}

/** What the host's model list (`/api/tags`) says about `model`; null when it is installed. */
export function modelProblem(tags: unknown, model: string): string | null {
  const names = Array.isArray((tags as { models?: unknown })?.models)
    ? ((tags as { models: Array<{ name?: unknown; model?: unknown }> }).models).flatMap((m) => [m.name, m.model]).filter((x): x is string => typeof x === 'string')
    : [];
  const wanted = model.includes(':') ? model : `${model}:latest`;
  return names.includes(wanted) ? null : `${model} isn't installed on the model host (ollama pull ${model})`;
}

// ── State ────────────────────────────────────────────────────────────────

/** A photo waiting to be read. */
export interface QueuedReceipt {
  fileId: string;
  /** Telegram's id for the file itself: the same photo sent twice is queued once. */
  fileUniqueId: string;
  receivedAt: string;
  /** When the bot said the model host was unreachable, so it says so once. */
  offlineNoticeAt?: string;
}

/** One item as proposed: its whole cost (tax and charges included) and its category. */
export interface ProposalItem {
  text: string;
  cents: number;
  categoryId: string;
}

export interface ReceiptProposal {
  id: string;
  store: string;
  date: string;
  createdAt: string;
  items: ProposalItem[];
  payments: ReceiptPayment[];
  taxBasis: TaxBasis;
  /** Set on Confirm: a card payment whose charge has not been imported yet waits. */
  confirmedAt?: string;
}

/** A filed receipt, kept for its Undo button. */
export interface FiledReceipt {
  id: string;
  at: string;
  summary: string;
  /** The charge that was split, and the category it had before (null: none). */
  split?: { activityId: string; before: string | null };
  /** Gift-card rows created. */
  createdIds: string[];
}

export interface ReceiptState {
  queue: QueuedReceipt[];
  /** Waiting for Confirm. */
  proposals: ReceiptProposal[];
  /** Confirmed, waiting for the card charge to be imported. */
  waiting: ReceiptProposal[];
  filed: FiledReceipt[];
  /** Store key → the cash account that tracks its gift card. */
  giftAccounts: Record<string, string>;
  /** Items the person confirmed, newest last. */
  filings: ItemFiling[];
  /** Tax rates receipts printed, in basis points, newest last. */
  rates: number[];
  /** Receipts filed, to flag the same one sent again. */
  fingerprints: Array<{ key: string; at: string }>;
}

export const RECEIPT_LIMITS = {
  queue: 20, proposals: 10, waiting: 20, filed: 20, filings: 500, rates: 10, fingerprints: 200,
  /** Days a queued photo, a proposal, a waiting receipt or an Undo lasts. */
  days: 7,
  fingerprintDays: 365,
} as const;

/** How far from the receipt's date the card charge may be. */
export const CHARGE_WINDOW_DAYS = 3;

const DAY_MS = 86_400_000;

export const emptyReceiptState = (): ReceiptState => ({
  queue: [], proposals: [], waiting: [], filed: [], giftAccounts: {}, filings: [], rates: [], fingerprints: [],
});

/** The state as stored; a damaged or missing secret reads as empty. */
export function parseReceiptState(raw: string | null | undefined): ReceiptState {
  try {
    const v = JSON.parse(raw ?? '') as Partial<ReceiptState>;
    const list = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
    return {
      queue: list<QueuedReceipt>(v.queue).filter((q) => typeof q?.fileId === 'string'),
      proposals: list<ReceiptProposal>(v.proposals).filter((p) => typeof p?.id === 'string' && Array.isArray(p.items)),
      waiting: list<ReceiptProposal>(v.waiting).filter((p) => typeof p?.id === 'string' && Array.isArray(p.items)),
      filed: list<FiledReceipt>(v.filed).filter((f) => typeof f?.id === 'string'),
      giftAccounts: v.giftAccounts && typeof v.giftAccounts === 'object' && !Array.isArray(v.giftAccounts) ? v.giftAccounts : {},
      filings: list<ItemFiling>(v.filings).filter((f) => typeof f?.text === 'string' && typeof f?.categoryId === 'string'),
      rates: list<number>(v.rates).filter((r) => Number.isInteger(r) && r > 0),
      fingerprints: list<{ key: string; at: string }>(v.fingerprints).filter((f) => typeof f?.key === 'string'),
    };
  } catch {
    return emptyReceiptState();
  }
}

/** Drops what is too old and keeps each list to its limit (newest kept). */
export function pruneReceiptState(s: ReceiptState, now: Date): ReceiptState {
  const since = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const fresh = since(RECEIPT_LIMITS.days);
  const keep = <T>(xs: T[], n: number) => xs.slice(-n);
  return {
    queue: keep(s.queue.filter((q) => q.receivedAt >= fresh), RECEIPT_LIMITS.queue),
    proposals: keep(s.proposals.filter((p) => p.createdAt >= fresh), RECEIPT_LIMITS.proposals),
    waiting: keep(s.waiting.filter((p) => (p.confirmedAt ?? p.createdAt) >= fresh), RECEIPT_LIMITS.waiting),
    filed: keep(s.filed.filter((f) => f.at >= fresh), RECEIPT_LIMITS.filed),
    giftAccounts: s.giftAccounts,
    filings: keep(s.filings, RECEIPT_LIMITS.filings),
    rates: keep(s.rates, RECEIPT_LIMITS.rates),
    fingerprints: keep(s.fingerprints.filter((f) => f.at >= since(RECEIPT_LIMITS.fingerprintDays)), RECEIPT_LIMITS.fingerprints),
  };
}

/** What makes two receipts the same purchase: the day, the total and how it was paid. */
export function receiptFingerprint(p: Pick<ReceiptProposal, 'date' | 'payments'>): string {
  const total = p.payments.reduce((s, x) => s + x.cents, 0);
  return [p.date, total, ...p.payments.map((x) => `${x.kind}:${x.cents}`).sort()].join('|');
}

/** A store name as a key: case, spacing and punctuation ignored. */
export const storeKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Which key a gift card's account is remembered under: the store, or the card's own name when no store was printed. */
export function giftAccountKey(p: Pick<ReceiptProposal, 'store' | 'payments'>): string {
  return storeKey(p.store) || storeKey(p.payments.find((x) => x.kind === 'gift_card')?.label ?? '');
}

/** A checked receipt and its items' categories as a proposal. */
export function newProposal(id: string, receipt: Receipt, categoryOf: readonly string[], now: Date): ReceiptProposal {
  return {
    id,
    store: receipt.store,
    date: receipt.date,
    createdAt: now.toISOString(),
    items: receipt.items.map((i: ReceiptItem, n) => ({ text: i.text, cents: i.cents + i.taxCents + i.chargeCents, categoryId: categoryOf[n] })),
    payments: receipt.payments,
    taxBasis: receipt.taxBasis,
  };
}

/** The proposal's rows: one per category, in the order each first appears. */
export function proposalRows(p: Pick<ReceiptProposal, 'items'>): CategoryRow[] {
  return groupByCategory(
    p.items.map((i) => ({ text: i.text, cents: i.cents, taxable: false, taxCents: 0, chargeCents: 0 })),
    p.items.map((i) => i.categoryId),
  );
}

/** The rows each payment covers, in the proposal's payment order. */
export function proposalRowsByPayment(p: Pick<ReceiptProposal, 'items' | 'payments'>): CategoryRow[][] {
  return rowsByPayment(proposalRows(p), p.payments);
}

// ── Screens ──────────────────────────────────────────────────────────────

/** Telegram callback data for this flow; every payload stays under Telegram's 64 bytes. */
export const RECEIPT_CALLBACK_PREFIX = 'cz:rc:';

/** A category as the screens need it. */
export interface ReceiptCategory {
  id: string;
  name: string;
  parentId: string | null;
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** An item no category was found for: Confirm waits until the person picks one. */
export const NO_CATEGORY = '';

function categoryPath(id: string, cats: readonly ReceiptCategory[]): string {
  if (id === NO_CATEGORY) return 'Needs a category';
  const c = cats.find((x) => x.id === id);
  if (!c) return 'Unknown category';
  const parent = c.parentId ? cats.find((x) => x.id === c.parentId) : undefined;
  return parent ? `${parent.name} / ${c.name}` : c.name;
}

const TAX_NOTE: Record<TaxBasis, string> = {
  printed: 'Tax: from the rate printed on the receipt.',
  'known-rate': 'Tax: worked out from a rate an earlier receipt printed.',
  shared: 'Tax: shared over every item (nothing showed which items were taxed).',
};

const ITEM_PREVIEW = 4;

/** Telegram's ceiling is 4096; a long receipt's item names are cut, never its rows. */
const MAX_TEXT = 3500;

function paymentLine(pay: ReceiptPayment, giftAccountName?: string): string {
  return pay.kind === 'gift_card'
    ? `${money(pay.cents)} by ${pay.label || 'gift card'} → rows in ${giftAccountName ?? 'the account that tracks it (I\'ll ask which)'}`
    : `${money(pay.cents)} by ${pay.label || 'card'} → splits the matching charge`;
}

/**
 * The proposal: its rows, how it is paid, and Confirm / Change / Cancel.
 * `giftAccountName` is the account a gift card's rows will go to, when one is
 * remembered: shown so a wrong one is caught before Confirm.
 */
export function renderProposal(
  p: ReceiptProposal, cats: readonly ReceiptCategory[], opts: { duplicateOf?: boolean; giftAccountName?: string } = {},
): { text: string; keyboard: InlineKeyboard } {
  const total = p.payments.reduce((s, x) => s + x.cents, 0);
  const head = [`🧾 *${escapeMarkdown(p.store || 'Receipt')}* · ${p.date} · ${money(total)}`, ''];
  const tail = ['', ...p.payments.map((x) => escapeMarkdown(paymentLine(x, opts.giftAccountName))), escapeMarkdown(TAX_NOTE[p.taxBasis])];
  if (opts.duplicateOf) tail.push('', escapeMarkdown('⚠️ A receipt with the same date, total and payments was filed before.'));
  // Whole rows are left out past Telegram's limit, never cut mid-line: a cut can split a Markdown pair and the message is refused.
  const rows = proposalRows(p);
  const body: string[] = [];
  let length = [...head, ...tail].join('\n').length;
  for (const [n, row] of rows.entries()) {
    const shown = row.items.slice(0, ITEM_PREVIEW).join(', ') + (row.items.length > ITEM_PREVIEW ? `, +${row.items.length - ITEM_PREVIEW} more` : '');
    const entry = [`*${escapeMarkdown(categoryPath(row.categoryId, cats))}* — ${money(row.cents)}`, `  ${escapeMarkdown(shown)}`];
    if (length + entry.join('\n').length + 40 > MAX_TEXT) {
      body.push(escapeMarkdown(`…and ${rows.length - n} more categories (✎ Change lists every item).`));
      break;
    }
    body.push(...entry);
    length += entry.join('\n').length + 2;
  }
  const text = [...head, ...body, ...tail].join('\n');
  return {
    text,
    keyboard: { inline_keyboard: [[
      { text: '✓ Confirm', callback_data: `${RECEIPT_CALLBACK_PREFIX}ok:${p.id}` },
      { text: '✎ Change', callback_data: `${RECEIPT_CALLBACK_PREFIX}ch:${p.id}:0` },
      { text: '✕ Cancel', callback_data: `${RECEIPT_CALLBACK_PREFIX}x:${p.id}` },
    ]] },
  };
}

export const RECEIPT_PAGE_SIZE = 8;

type ButtonRows = Array<Array<{ text: string; callback_data: string }>>;

const short = (s: string, n = 38) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Which item to move: one button per item, a page at a time. */
export function renderItemPicker(p: ReceiptProposal, cats: readonly ReceiptCategory[], page: number): { text: string; keyboard: InlineKeyboard } {
  const pages = Math.max(1, Math.ceil(p.items.length / RECEIPT_PAGE_SIZE));
  const at = Math.min(Math.max(0, page), pages - 1);
  const rows: ButtonRows = p.items
    .slice(at * RECEIPT_PAGE_SIZE, (at + 1) * RECEIPT_PAGE_SIZE)
    .map((item, k) => {
      const n = at * RECEIPT_PAGE_SIZE + k;
      return [{ text: short(`${item.text} · ${categoryPath(item.categoryId, cats)}`, 60), callback_data: `${RECEIPT_CALLBACK_PREFIX}it:${p.id}:${n}` }];
    });
  const nav = [
    ...(at > 0 ? [{ text: '‹ Prev', callback_data: `${RECEIPT_CALLBACK_PREFIX}ch:${p.id}:${at - 1}` }] : []),
    { text: '« Back', callback_data: `${RECEIPT_CALLBACK_PREFIX}bk:${p.id}` },
    ...(at < pages - 1 ? [{ text: 'Next ›', callback_data: `${RECEIPT_CALLBACK_PREFIX}ch:${p.id}:${at + 1}` }] : []),
  ];
  rows.push(nav);
  return { text: escapeMarkdown('Which item goes under a different category?'), keyboard: { inline_keyboard: rows } };
}

/** Where to move it: the top-level categories, or one parent's children. */
export function renderCategoryPicker(
  p: ReceiptProposal, n: number, cats: readonly ReceiptCategory[], parentId: string | null,
): { text: string; keyboard: InlineKeyboard } {
  const item = p.items[n];
  const shown = cats.filter((c) => c.parentId === parentId);
  const hasChildren = (id: string) => cats.some((c) => c.parentId === id);
  const buttons = shown.map((c) => ({
    text: hasChildren(c.id) ? `${c.name} ›` : c.name,
    callback_data: `${RECEIPT_CALLBACK_PREFIX}${hasChildren(c.id) ? 'pa' : 'set'}:${p.id}:${n}:${c.id}`,
  }));
  if (parentId) {
    const parent = cats.find((c) => c.id === parentId);
    buttons.unshift({ text: `Just ${parent?.name ?? 'this'}`, callback_data: `${RECEIPT_CALLBACK_PREFIX}set:${p.id}:${n}:${parentId}` });
  }
  const rows: ButtonRows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: '« Back', callback_data: `${RECEIPT_CALLBACK_PREFIX}${parentId ? `it:${p.id}:${n}` : `ch:${p.id}:0`}` }]);
  return { text: escapeMarkdown(`Move "${short(item?.text ?? '', 60)}" to:`), keyboard: { inline_keyboard: rows } };
}

/** Which cash account tracks this gift card: one button per cash account. */
export function renderGiftAccountPicker(
  p: ReceiptProposal, accounts: ReadonlyArray<{ id: string; name: string }>,
): { text: string; keyboard: InlineKeyboard } {
  const card = p.payments.find((x) => x.kind === 'gift_card');
  const rows: ButtonRows = accounts.map((a) => [{ text: short(a.name, 60), callback_data: `${RECEIPT_CALLBACK_PREFIX}ga:${p.id}:${a.id}` }]);
  rows.push([{ text: '✕ Cancel', callback_data: `${RECEIPT_CALLBACK_PREFIX}x:${p.id}` }]);
  return {
    text: escapeMarkdown(`Which account tracks your ${card?.label || 'gift card'}${p.store ? ` at ${p.store}` : ''}? I'll remember it.`),
    keyboard: { inline_keyboard: rows },
  };
}

/** Which imported charge the card paid: one button per candidate. */
export function renderChargePicker(p: ReceiptProposal, charges: readonly SpendRow[]): { text: string; keyboard: InlineKeyboard } {
  const rows: ButtonRows = charges.map((c) => [{
    text: short(`${c.date.slice(0, 10)} · ${c.accountName} · ${money(c.absCents)}`, 60),
    callback_data: `${RECEIPT_CALLBACK_PREFIX}cg:${p.id}:${c.id}`,
  }]);
  rows.push([{ text: '✕ Cancel', callback_data: `${RECEIPT_CALLBACK_PREFIX}x:${p.id}` }]);
  return { text: escapeMarkdown('More than one charge matches this receipt. Which one was it?'), keyboard: { inline_keyboard: rows } };
}

/** Whether every item has a category, so the proposal can be filed. */
export const fullyCategorized = (p: Pick<ReceiptProposal, 'items'>) => p.items.every((i) => i.categoryId !== NO_CATEGORY);

export type ReceiptTap =
  | { kind: 'confirm' | 'cancel' | 'back' | 'undo'; id: string }
  | { kind: 'charge'; id: string; activityId: string }
  | { kind: 'items'; id: string; page: number }
  | { kind: 'item'; id: string; n: number }
  | { kind: 'parent' | 'set'; id: string; n: number; categoryId: string }
  | { kind: 'gift-account'; id: string; accountId: string };

/** A tapped button's data back as what it means; null when it is not this flow's or is damaged. */
export function parseReceiptTap(data: string): ReceiptTap | null {
  if (!data.startsWith(RECEIPT_CALLBACK_PREFIX)) return null;
  const [verb, id, a, b] = data.slice(RECEIPT_CALLBACK_PREFIX.length).split(':');
  if (!id) return null;
  const int = (x: string | undefined) => (x !== undefined && /^\d+$/.test(x) ? Number(x) : null);
  switch (verb) {
    case 'ok': return { kind: 'confirm', id };
    case 'x': return { kind: 'cancel', id };
    case 'bk': return { kind: 'back', id };
    case 'un': return { kind: 'undo', id };
    case 'ch': return int(a) === null ? null : { kind: 'items', id, page: int(a)! };
    case 'it': return int(a) === null ? null : { kind: 'item', id, n: int(a)! };
    case 'pa':
    case 'set': return int(a) === null || !b ? null : { kind: verb === 'pa' ? 'parent' : 'set', id, n: int(a)!, categoryId: b };
    case 'ga': return a ? { kind: 'gift-account', id, accountId: a } : null;
    case 'cg': return a ? { kind: 'charge', id, activityId: a } : null;
    default: return null;
  }
}

/** The proposal with one item moved to another category. */
export function moveItem(p: ReceiptProposal, n: number, categoryId: string): ReceiptProposal {
  return { ...p, items: p.items.map((item, k) => (k === n ? { ...item, categoryId } : item)) };
}

// ── Writes ───────────────────────────────────────────────────────────────

/**
 * The imported charges a card payment could be: a purchase on a cash or card
 * account the Spending page reads, of exactly that amount, within
 * `CHARGE_WINDOW_DAYS` of the receipt, and not already split. More than one is
 * a question for the person; none means the charge has not been imported yet.
 */
export function matchingCharges(
  rows: readonly SpendRow[], cents: number, date: string, spendingAccountIds: readonly string[] | null,
): SpendRow[] {
  const day = Date.parse(`${date}T12:00:00Z`);
  return rows.filter((r) => {
    if (r.absCents !== cents || r.splits.length > 0 || effectiveType(r) !== 'WITHDRAWAL') return false;
    if (r.accountType !== 'CASH' && r.accountType !== 'CREDIT_CARD') return false;
    if (spendingAccountIds && !spendingAccountIds.includes(r.accountId)) return false;
    return Math.abs(Date.parse(`${r.date.slice(0, 10)}T12:00:00Z`) - day) <= CHARGE_WINDOW_DAYS * DAY_MS;
  });
}

/** Wealthfolio's split line (`NewActivitySplit`). */
export interface SplitLine {
  taxonomyId: string;
  categoryId: string;
  /** Exact decimal text: Wealthfolio checks the lines add up to the charge. */
  amount: string;
  note: string | null;
  sortOrder: number;
}

const decimal = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const itemsNote = (items: readonly string[]) => short(items.join(', '), 200);

/** One split line per category the card payment covers. */
export function splitLines(rows: readonly CategoryRow[]): SplitLine[] {
  return rows.map((r, n) => ({ taxonomyId: SPENDING_TAXONOMY, categoryId: r.categoryId, amount: decimal(r.cents), note: itemsNote(r.items), sortOrder: n }));
}

/** One WITHDRAWAL per category a gift card covers, in the account that tracks it. */
export function giftCardWrites(
  p: Pick<ReceiptProposal, 'store' | 'date'>, rows: readonly CategoryRow[], accountId: string, currency: string,
): ActivityWrite[] {
  return rows.map((r) => ({
    accountId,
    activityType: 'WITHDRAWAL',
    activityDate: bankDayInstant(p.date),
    symbol: { symbol: `$CASH-${currency}` },
    amount: r.cents / 100,
    currency,
    comment: short(`${p.store ? `${p.store}: ` : ''}${r.items.join(', ')}`, 200),
  }));
}

/** What a filed receipt says on its Done message. */
export function filedSummary(p: ReceiptProposal, cats: readonly ReceiptCategory[]): string {
  return proposalRows(p).map((r) => `${categoryPath(r.categoryId, cats)} ${money(r.cents)}`).join(', ');
}

/** Items the person confirmed, to answer the same item next time without asking the model. */
export function confirmedFilings(p: ReceiptProposal): ItemFiling[] {
  return p.items.map((i) => ({ text: i.text, categoryId: i.categoryId }));
}

export function undoKeyboard(id: string): InlineKeyboard {
  return { inline_keyboard: [[{ text: '↩ Undo', callback_data: `${RECEIPT_CALLBACK_PREFIX}un:${id}` }]] };
}
