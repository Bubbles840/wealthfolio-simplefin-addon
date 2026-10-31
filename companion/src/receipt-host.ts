/**
 * companion/src/receipt-host.ts
 *
 * The receipt reader's I/O (docs/superpowers/specs/2026-10-29-receipt-reader-design.md):
 * a photo sent to the bot is queued, read by the model on the person's own
 * computer, checked (shared/receipt.ts), proposed with buttons
 * (shared/receipt-flow.ts) and, on Confirm, filed — the card charge split, the
 * gift-card rows added.
 *
 * Every dependency is injected, as in the Telegram listener, so the whole flow
 * runs in tests without a network, a database or a model.
 *
 * ONE writer, one lock. The companion alone writes `receipt_state`, but a drain
 * and a button tap run concurrently inside it, so every read-modify-write of
 * the state goes through `withState`, one at a time.
 */
import { buildReceipt, RECEIPT_PROBLEM_TEXT } from '../../shared/receipt.js';
import { parseTranscript, receiptChatRequest } from '../../shared/receipt-prompt.js';
import {
  categoryChatRequest, parseCategories, rememberedCategory, type CategoryChoice,
} from '../../shared/receipt-categories.js';
import {
  NO_CATEGORY, RECEIPT_CALLBACK_PREFIX, RECEIPT_LIMITS, RECEIPT_CONFIG_SECRET_KEY, RECEIPT_STATE_SECRET_KEY, RECEIPT_STATUS_SECRET_KEY,
  modelProblem, parseReceiptHostStatus,
  confirmedFilings, filedSummary, fullyCategorized, giftAccountKey, giftCardWrites, matchingCharges, money, moveItem,
  newProposal, parseReceiptReaderConfig, parseReceiptState, parseReceiptTap, proposalRowsByPayment, pruneReceiptState,
  receiptFingerprint, renderCategoryPicker, renderChargePicker, renderGiftAccountPicker, renderItemPicker, renderProposal,
  splitLines, undoKeyboard,
  type ReceiptCategory, type ReceiptProposal, type ReceiptReaderConfig, type ReceiptState, type SplitLine,
} from '../../shared/receipt-flow.js';
import { escapeMarkdown, type InlineKeyboard } from '../../shared/telegram.js';
import type { ActivityWrite } from '../../shared/sync-host.js';
import type { SpendRow } from '../../shared/wf-spending.js';

/** How long a model call may take: the default model needs one to two minutes per photo. */
export const MODEL_TIMEOUT_MS = 5 * 60_000;
/** How long the reachability check waits. */
const PING_TIMEOUT_MS = 5_000;
/** How often an unchanged host status is written again, so the card's "checked" time stays honest. */
const STATUS_REFRESH_MS = 60 * 60_000;

const DAY_MS = 86_400_000;

export interface ReceiptUi {
  edit: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
  answer: (text?: string) => Promise<void>;
  send: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
}

export interface ReceiptHostDeps {
  io: { get: (key: string) => Promise<string | null>; set: (key: string, value: string) => Promise<void> };
  fetchImpl: typeof fetch;
  /** The photo's bytes, from Telegram. */
  downloadPhoto: (fileId: string) => Promise<Uint8Array>;
  /** A new message in the configured chat; never rejects. */
  send: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
  categories: () => ReceiptCategory[];
  /** Activities whose stored date is in [fromDay, toDayExclusive). */
  spendRows: (fromDay: string, toDayExclusive: string) => SpendRow[];
  /** The accounts the Spending page reads; null: every account. */
  spendingAccountIds: () => string[] | null;
  cashAccounts: () => Promise<Array<{ id: string; name: string; currency: string }>>;
  wf: {
    replaceSplits: (activityId: string, lines: SplitLine[]) => Promise<void>;
    clearSplits: (activityId: string) => Promise<void>;
    spendingCategoryOf: (activityId: string) => Promise<string | null>;
    assign: (activityId: string, categoryId: string) => Promise<void>;
    /** Creates the rows and returns their ids, in order. */
    create: (writes: ActivityWrite[]) => Promise<string[]>;
    remove: (activityIds: string[]) => Promise<void>;
  };
  log: (msg: string) => void;
  now: () => Date;
  randomId: () => string;
}

export const RECEIPT_COPY = {
  notSetUp: 'The receipt reader is off. Turn it on in the add-on: Settings → Receipt reader.',
  queued: 'Got it — reading it now. That takes a minute or two.',
  alreadyQueued: "I'm already reading that one.",
  queueFull: "I've got 20 receipts waiting to be read. Send this one again once those are done.",
  paused: 'I have 10 receipts waiting for you to confirm or cancel. I\'ll read the rest as you finish those.',
  offline: "I can't reach the computer that reads receipts. I'll read it as soon as it's back (for up to 7 days).",
  expired: "I couldn't read a receipt you sent a week ago: the computer that reads them never came back. Send it again when it's on.",
  unreadable: "I couldn't read that receipt. Try a sharper photo, flat and in good light.",
  gone: 'That receipt is no longer open.',
  needsCategory: 'Pick a category for every item first.',
  cancelled: 'Cancelled — nothing was filed.',
  undone: 'Undone — the receipt is no longer filed.',
} as const;

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (isoDay: string, n: number) => day(new Date(Date.parse(`${isoDay}T12:00:00Z`) + n * DAY_MS));

/** Category keys the model answers with: the path, lower-cased, made unique. */
export function categoryChoices(cats: readonly ReceiptCategory[]): CategoryChoice[] {
  const used = new Set<string>();
  return cats.map((c) => {
    const parent = c.parentId ? cats.find((x) => x.id === c.parentId) : undefined;
    const path = parent ? `${parent.name} / ${c.name}` : c.name;
    const base = path.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'category';
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
    used.add(key);
    return { id: c.id, key, path };
  });
}

export function createReceiptHost(deps: ReceiptHostDeps) {
  let lock: Promise<unknown> = Promise.resolve();
  let draining: Promise<void> | null = null;
  /** Whether the bot has said it is waiting on open proposals; said once per pause. */
  let pausedNoticeSent = false;

  /** Runs `fn` on the current state, alone, and saves what it returns. */
  function withState<T>(fn: (s: ReceiptState) => Promise<{ state: ReceiptState; result: T }> | { state: ReceiptState; result: T }): Promise<T> {
    const run = lock.then(async () => {
      const now = deps.now();
      const state = pruneReceiptState(parseReceiptState(await deps.io.get(RECEIPT_STATE_SECRET_KEY)), now);
      const out = await fn(state);
      await deps.io.set(RECEIPT_STATE_SECRET_KEY, JSON.stringify(pruneReceiptState(out.state, now)));
      return out.result;
    });
    lock = run.catch(() => {});
    return run;
  }

  const readState = async () => pruneReceiptState(parseReceiptState(await deps.io.get(RECEIPT_STATE_SECRET_KEY)), deps.now());
  const readConfig = async () => parseReceiptReaderConfig(await deps.io.get(RECEIPT_CONFIG_SECRET_KEY));

  async function postJson(url: string, body: unknown, timeoutMs: number): Promise<any> {
    const res = await deps.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`the model host answered ${res.status}`);
    return res.json();
  }

  async function reachable(config: ReceiptReaderConfig): Promise<boolean> {
    try {
      const res = await deps.fetchImpl(`${config.url}/api/tags`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** The categories for these items: remembered ones first, the model for the rest. */
  async function categorize(config: ReceiptReaderConfig, store: string, items: string[], state: ReceiptState): Promise<string[]> {
    const cats = deps.categories();
    const known = new Set(cats.map((c) => c.id));
    const out = items.map((text) => {
      const id = rememberedCategory(text, state.filings);
      return id && known.has(id) ? id : NO_CATEGORY;
    });
    const ask = out.flatMap((id, n) => (id === NO_CATEGORY ? [n] : []));
    if (ask.length === 0 || cats.length === 0) return out;
    const choices = categoryChoices(cats);
    try {
      const json = await postJson(
        `${config.url}/api/chat`,
        categoryChatRequest(config.model, store, ask.map((n) => items[n]), choices, state.filings),
        MODEL_TIMEOUT_MS,
      );
      const ids = parseCategories(String(json?.message?.content ?? ''), choices, ask.length);
      if (ids) ask.forEach((n, k) => { out[n] = ids[k]; });
      else deps.log('Receipt reader: the model gave no usable categories; the items are left for the person to pick.');
    } catch (err) {
      deps.log(`Receipt reader: asking for categories failed: ${(err as Error).message}`);
    }
    return out;
  }

  /** The name of the account a proposal's gift card rows will go to, when one is remembered. */
  async function giftAccountName(p: ReceiptProposal, state: ReceiptState): Promise<string | undefined> {
    const id = state.giftAccounts[giftAccountKey(p)];
    if (!id || !p.payments.some((x) => x.kind === 'gift_card')) return undefined;
    return (await deps.cashAccounts().catch(() => [])).find((a) => a.id === id)?.name;
  }

  /** A photo sent to the bot. */
  async function onPhoto(photo: { fileId: string; fileUniqueId: string }, reply: (text: string) => Promise<void>): Promise<void> {
    if (!(await readConfig())) {
      await reply(RECEIPT_COPY.notSetUp);
      return;
    }
    const added = await withState((s) => {
      if (s.queue.some((q) => q.fileUniqueId === photo.fileUniqueId)) return { state: s, result: 'already' as const };
      // Full: refused out loud, never by the prune dropping the oldest photo.
      if (s.queue.length >= RECEIPT_LIMITS.queue) return { state: s, result: 'full' as const };
      return { state: { ...s, queue: [...s.queue, { ...photo, receivedAt: deps.now().toISOString() }] }, result: 'added' as const };
    });
    await reply(added === 'added' ? RECEIPT_COPY.queued : added === 'full' ? RECEIPT_COPY.queueFull : RECEIPT_COPY.alreadyQueued);
    if (added === 'added') void drain();
  }

  /** Reads every queued photo it can; one drain at a time. Never rejects. */
  function drain(): Promise<void> {
    draining ??= drainOnce().catch((err) => deps.log(`Receipt reader: ${(err as Error).message}`)).finally(() => { draining = null; });
    return draining;
  }

  async function drainOnce(): Promise<void> {
    const config = await readConfig();
    if (!config) return;
    // A photo queued a week ago is dropped by the prune; say so once, as the prune is written.
    const cutoff = new Date(deps.now().getTime() - 7 * DAY_MS).toISOString();
    if (parseReceiptState(await deps.io.get(RECEIPT_STATE_SECRET_KEY)).queue.some((q) => q.receivedAt < cutoff)) {
      await withState((s) => ({ state: s, result: undefined }));
      await deps.send(RECEIPT_COPY.expired);
    }
    for (;;) {
      const state = await readState();
      const head = state.queue[0];
      if (!head) return;
      // Open proposals are capped; reading more would push the oldest out. Confirm and Cancel start the drain again.
      if (state.proposals.length >= RECEIPT_LIMITS.proposals) {
        if (!pausedNoticeSent) await deps.send(RECEIPT_COPY.paused);
        pausedNoticeSent = true;
        return;
      }
      pausedNoticeSent = false;
      if (!(await reachable(config))) {
        if (!head.offlineNoticeAt) {
          await withState((s) => ({
            state: { ...s, queue: s.queue.map((q) => (q.fileUniqueId === head.fileUniqueId ? { ...q, offlineNoticeAt: deps.now().toISOString() } : q)) },
            result: undefined,
          }));
          await deps.send(RECEIPT_COPY.offline);
        }
        return;
      }
      if ((await readOne(config, head.fileId, head.fileUniqueId)) === 'offline') return;
    }
  }

  /** Reads one photo and proposes it, and it leaves the queue — unless the model host went away mid-read ('offline'). */
  async function readOne(config: ReceiptReaderConfig, fileId: string, fileUniqueId: string): Promise<'done' | 'offline'> {
    const dequeue = (s: ReceiptState) => ({ ...s, queue: s.queue.filter((q) => q.fileUniqueId !== fileUniqueId) });
    let reply: { text: string; keyboard?: InlineKeyboard };
    try {
      const image = Buffer.from(await deps.downloadPhoto(fileId)).toString('base64');
      const json = await postJson(`${config.url}/api/chat`, receiptChatRequest(config.model, image), MODEL_TIMEOUT_MS);
      const transcript = parseTranscript(String(json?.message?.content ?? ''));
      const state = await readState();
      const built = transcript ? buildReceipt(transcript, state.rates) : null;
      if (!built) {
        reply = { text: RECEIPT_COPY.unreadable };
      } else if (!built.ok) {
        reply = { text: `${RECEIPT_PROBLEM_TEXT[built.problem]} Nothing was filed — try a sharper photo.` };
      } else {
        const receipt = built.receipt;
        const categoryOf = await categorize(config, receipt.store, receipt.items.map((i) => i.text), state);
        const proposal = newProposal(deps.randomId(), receipt, categoryOf, deps.now());
        const duplicateOf = state.fingerprints.some((f) => f.key === receiptFingerprint(proposal));
        await withState((s) => ({
          state: { ...dequeue(s), proposals: [...s.proposals, proposal], rates: [...s.rates.filter((r) => !receipt.printedRates.includes(r)), ...receipt.printedRates] },
          result: undefined,
        }));
        const view = renderProposal(proposal, deps.categories(), { duplicateOf, giftAccountName: await giftAccountName(proposal, state) });
        await deps.send(view.text, view.keyboard);
        return 'done';
      }
    } catch (err) {
      deps.log(`Receipt reader: reading a photo failed: ${(err as Error).message}`);
      // The computer went to sleep mid-read: keep the photo for when it is back.
      if (!(await reachable(config))) return 'offline';
      reply = { text: RECEIPT_COPY.unreadable };
    }
    await withState((s) => ({ state: dequeue(s), result: undefined }));
    await deps.send(reply.text, reply.keyboard);
    return 'done';
  }

  // ── Filing ──────────────────────────────────────────────────────────────

  type Filed = { split?: { activityId: string; before: string | null }; createdIds: string[]; text: string };
  type FileOutcome =
    | { kind: 'filed'; filed: Filed }
    | { kind: 'waiting'; text: string }
    | { kind: 'ask'; view: { text: string; keyboard: InlineKeyboard } }
    | { kind: 'error'; text: string };

  /**
   * Files a proposal: the gift-card rows, then the card charge's split. With
   * `chargeId`, the charge the person picked when more than one matched. A card
   * charge not imported yet files NOTHING (`waiting`), so a receipt is never
   * half-filed; gift-card rows are made first because they can be removed again
   * if the split is refused.
   */
  async function fileProposal(p: ReceiptProposal, state: ReceiptState, chargeId?: string): Promise<FileOutcome> {
    const byPayment = proposalRowsByPayment(p);
    const giftIdx = p.payments.flatMap((x, n) => (x.kind === 'gift_card' ? [n] : []));
    const cardIdx = p.payments.findIndex((x) => x.kind === 'card');

    let giftAccount: { id: string; currency: string } | undefined;
    if (giftIdx.length > 0) {
      const accounts = await deps.cashAccounts();
      giftAccount = accounts.find((a) => a.id === state.giftAccounts[giftAccountKey(p)]);
      if (!giftAccount) return { kind: 'ask', view: renderGiftAccountPicker(p, accounts) };
    }

    let charge: SpendRow | undefined;
    if (cardIdx >= 0) {
      const rows = deps.spendRows(addDays(p.date, -4), addDays(p.date, 5));
      const candidates = matchingCharges(rows, p.payments[cardIdx].cents, p.date, deps.spendingAccountIds());
      charge = chargeId ? candidates.find((c) => c.id === chargeId) : candidates.length === 1 ? candidates[0] : undefined;
      if (!charge && chargeId) return { kind: 'error', text: 'That charge no longer matches — it may have been split or changed. Nothing was filed.' };
      if (!charge && candidates.length > 1) return { kind: 'ask', view: renderChargePicker(p, candidates) };
      if (!charge) {
        return { kind: 'waiting', text: `Saved. The ${money(p.payments[cardIdx].cents)} charge hasn't been imported yet; I'll file the receipt when it is (for up to 7 days).` };
      }
    }

    const createdIds: string[] = [];
    try {
      for (const n of giftIdx) {
        const ids = await deps.wf.create(giftCardWrites(p, byPayment[n], giftAccount!.id, giftAccount!.currency));
        createdIds.push(...ids);
        for (const [k, id] of ids.entries()) await deps.wf.assign(id, byPayment[n][k].categoryId);
      }
      let split: Filed['split'];
      if (charge) {
        const before = await deps.wf.spendingCategoryOf(charge.id);
        await deps.wf.replaceSplits(charge.id, splitLines(byPayment[cardIdx]));
        split = { activityId: charge.id, before };
      }
      const where = charge ? ` Split the ${money(charge.absCents)} charge on ${charge.accountName}.` : '';
      return { kind: 'filed', filed: { split, createdIds, text: `✅ Filed: ${filedSummary(p, deps.categories())}.${where}` } };
    } catch (err) {
      if (createdIds.length) await deps.wf.remove(createdIds).catch(() => {});
      deps.log(`Receipt reader: filing failed: ${(err as Error).message}`);
      return { kind: 'error', text: `Couldn't file it — Wealthfolio refused: ${(err as Error).message}. Nothing was filed.` };
    }
  }

  /** Records a filed receipt: its Undo, what it taught, its fingerprint; it leaves the open and waiting lists. */
  function recordFiled(s: ReceiptState, p: ReceiptProposal, filed: Filed): ReceiptState {
    const at = deps.now().toISOString();
    return {
      ...s,
      proposals: s.proposals.filter((x) => x.id !== p.id),
      waiting: s.waiting.filter((x) => x.id !== p.id),
      filed: [...s.filed, { id: p.id, at, summary: filed.text, ...(filed.split ? { split: filed.split } : {}), createdIds: filed.createdIds }],
      filings: [...s.filings, ...confirmedFilings(p)],
      fingerprints: [...s.fingerprints, { key: receiptFingerprint(p), at }],
    };
  }

  async function undo(id: string): Promise<string> {
    const state = await readState();
    const f = state.filed.find((x) => x.id === id);
    if (!f) return RECEIPT_COPY.gone;
    try {
      if (f.createdIds.length) await deps.wf.remove(f.createdIds);
      if (f.split) {
        await deps.wf.clearSplits(f.split.activityId);
        if (f.split.before) await deps.wf.assign(f.split.activityId, f.split.before);
      }
    } catch (err) {
      deps.log(`Receipt reader: undo failed: ${(err as Error).message}`);
      return `Couldn't undo it — Wealthfolio refused: ${(err as Error).message}.`;
    }
    await withState((s) => ({ state: { ...s, filed: s.filed.filter((x) => x.id !== id) }, result: undefined }));
    return RECEIPT_COPY.undone;
  }

  const handles = (data: string) => data.startsWith(RECEIPT_CALLBACK_PREFIX);

  /** A receipt button. Never rejects: the listener's ui methods never do, and every Wealthfolio call is caught. */
  async function onCallback(cb: { data: string }, ui: ReceiptUi): Promise<void> {
    const tap = parseReceiptTap(cb.data);
    if (!tap) {
      await ui.answer(RECEIPT_COPY.gone);
      return;
    }
    if (tap.kind === 'undo') {
      const text = await undo(tap.id);
      await ui.answer();
      await ui.edit(escapeMarkdown(text));
      return;
    }
    const state = await readState();
    const p = state.proposals.find((x) => x.id === tap.id);
    if (!p) {
      await ui.answer(RECEIPT_COPY.gone);
      return;
    }
    const cats = deps.categories();
    const show = async (view: { text: string; keyboard: InlineKeyboard }) => { await ui.answer(); await ui.edit(view.text, view.keyboard); };
    const save = (next: ReceiptProposal) => withState((s) => ({ state: { ...s, proposals: s.proposals.map((x) => (x.id === next.id ? next : x)) }, result: undefined }));

    switch (tap.kind) {
      case 'cancel':
        await withState((s) => ({ state: { ...s, proposals: s.proposals.filter((x) => x.id !== p.id) }, result: undefined }));
        await ui.answer();
        await ui.edit(escapeMarkdown(RECEIPT_COPY.cancelled));
        void drain();
        return;
      case 'back':
        await show(renderProposal(p, cats, { giftAccountName: await giftAccountName(p, state) }));
        return;
      case 'items':
        await show(renderItemPicker(p, cats, tap.page));
        return;
      case 'item':
        await show(renderCategoryPicker(p, tap.n, cats, null));
        return;
      case 'parent':
        await show(renderCategoryPicker(p, tap.n, cats, tap.categoryId));
        return;
      case 'set': {
        if (!cats.some((c) => c.id === tap.categoryId) || !p.items[tap.n]) {
          await ui.answer(RECEIPT_COPY.gone);
          return;
        }
        const next = moveItem(p, tap.n, tap.categoryId);
        await save(next);
        await show(renderProposal(next, cats, { giftAccountName: await giftAccountName(next, state) }));
        return;
      }
      case 'gift-account':
        await withState((s) => ({ state: { ...s, giftAccounts: { ...s.giftAccounts, [giftAccountKey(p)]: tap.accountId } }, result: undefined }));
        await confirm(p, ui);
        return;
      case 'charge':
        await confirm(p, ui, tap.activityId);
        return;
      case 'confirm':
        await confirm(p, ui);
        return;
    }
  }

  async function confirm(p: ReceiptProposal, ui: ReceiptUi, chargeId?: string): Promise<void> {
    if (!fullyCategorized(p)) {
      await ui.answer(RECEIPT_COPY.needsCategory);
      return;
    }
    await ui.answer();
    let outcome: FileOutcome;
    try {
      outcome = await fileProposal(p, await readState(), chargeId);
    } catch (err) {
      deps.log(`Receipt reader: filing failed: ${(err as Error).message}`);
      outcome = { kind: 'error', text: `Couldn't file it: ${(err as Error).message}. Nothing was filed.` };
    }
    switch (outcome.kind) {
      case 'ask':
        await ui.edit(outcome.view.text, outcome.view.keyboard);
        return;
      case 'error':
        await ui.edit(escapeMarkdown(outcome.text), renderProposal(p, deps.categories()).keyboard);
        return;
      case 'waiting':
        await withState((s) => ({
          state: { ...s, proposals: s.proposals.filter((x) => x.id !== p.id), waiting: [...s.waiting, { ...p, confirmedAt: deps.now().toISOString() }] },
          result: undefined,
        }));
        await ui.edit(escapeMarkdown(outcome.text));
        void drain();
        return;
      case 'filed':
        await withState((s) => ({ state: recordFiled(s, p, outcome.filed), result: undefined }));
        await ui.edit(escapeMarkdown(outcome.filed.text), undoKeyboard(p.id));
    }
    // A slot opened: read the next queued photo, if the reader was paused on it.
    void drain();
  }

  /**
   * After a sync: files each confirmed receipt whose card charge has now been
   * imported. More than one match asks; a receipt still unmatched after 7 days
   * is dropped with a message. Never rejects.
   */
  async function retryWaiting(): Promise<void> {
    try {
      const raw = parseReceiptState(await deps.io.get(RECEIPT_STATE_SECRET_KEY));
      const cutoff = new Date(deps.now().getTime() - 7 * DAY_MS).toISOString();
      for (const p of raw.waiting) {
        if ((p.confirmedAt ?? p.createdAt) < cutoff) {
          await withState((s) => ({ state: { ...s, waiting: s.waiting.filter((x) => x.id !== p.id) }, result: undefined }));
          await deps.send(escapeMarkdown(`The ${money(p.payments.find((x) => x.kind === 'card')?.cents ?? 0)} charge for the receipt from ${p.date} never showed up, so I stopped waiting. Nothing was filed.`));
          continue;
        }
        const outcome = await fileProposal(p, await readState());
        if (outcome.kind === 'filed') {
          await withState((s) => ({ state: recordFiled(s, p, outcome.filed), result: undefined }));
          await deps.send(escapeMarkdown(outcome.filed.text), undoKeyboard(p.id));
        } else if (outcome.kind === 'ask') {
          // The person answers on this message: the receipt moves back to the open list.
          await withState((s) => ({ state: { ...s, waiting: s.waiting.filter((x) => x.id !== p.id), proposals: [...s.proposals, p] }, result: undefined }));
          await deps.send(outcome.view.text, outcome.view.keyboard);
        }
      }
    } catch (err) {
      deps.log(`Receipt reader: filing waiting receipts failed: ${(err as Error).message}`);
    }
  }

  /**
   * Looks at the model host for the settings card: reachable, and with the
   * model installed. Written when the answer changes, and hourly otherwise, so
   * the card can say when it last looked. Never rejects.
   */
  async function check(): Promise<void> {
    try {
      const config = await readConfig();
      if (!config) return;
      let error: string | null;
      try {
        const res = await deps.fetchImpl(`${config.url}/api/tags`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
        error = res.ok ? modelProblem(await res.json(), config.model) : `the model host answered ${res.status}`;
      } catch {
        error = `Can't reach the model host at ${config.url}`;
      }
      const now = deps.now();
      const prev = parseReceiptHostStatus(await deps.io.get(RECEIPT_STATUS_SECRET_KEY));
      if (!prev || prev.error !== error || now.getTime() - Date.parse(prev.checkedAt) >= STATUS_REFRESH_MS) {
        await deps.io.set(RECEIPT_STATUS_SECRET_KEY, JSON.stringify({ checkedAt: now.toISOString(), error }));
      }
    } catch (err) {
      deps.log(`Receipt reader: checking the model host failed: ${(err as Error).message}`);
    }
  }

  /** The 5-minute tick: look at the host, then read whatever is queued. */
  async function tick(): Promise<void> {
    await check();
    await drain();
  }

  return { onPhoto, drain, handles, onCallback, retryWaiting, check, tick };
}
