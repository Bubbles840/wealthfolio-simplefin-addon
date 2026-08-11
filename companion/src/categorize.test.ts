import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCategorizeController, SPENDING_TAXONOMY_ID, type CategorizeDeps } from './categorize.js';
import { CATEGORIZE_ENTRY_CALLBACK, type InlineKeyboard } from '../../shared/telegram.js';
import type { DismissalLedger } from '../../shared/uncategorized.js';

const CHAT = 987654;
const DB = '/mnt/wealthfolio.db';

/** A row shaped like `getNativeUncategorizedSpending`'s output, including the
 *  RAW stored note (`<description> · <txId>`) the controller has to clean. */
interface Row {
  activityId: string;
  wfAccountId: string;
  notes: string;
  amountCents: number;
  date: string;
  accountName: string;
}

const row = (id: string, over: Partial<Row> = {}): Row => ({
  activityId: id,
  wfAccountId: 'wf-1',
  notes: `BOOK STORES ${id} · TRN-${id}`,
  amountCents: -1200,
  date: '2026-08-08',
  accountName: 'Citi Double Cash',
  ...over,
});

/** `Food & Dining` has children (so tapping it drills down); `Entertainment`
 *  has none (so tapping it files immediately). Both paths are exercised. */
const CATEGORIES = [
  { id: 'cat-food', name: 'Food & Dining', parentId: null, parentName: null },
  { id: 'cat-rest', name: 'Restaurants', parentId: 'cat-food', parentName: 'Food & Dining' },
  { id: 'cat-fun', name: 'Entertainment', parentId: null, parentName: null },
];

type Recorded = [string, InlineKeyboard | undefined];

function setup(opts: { rows?: Row[]; ledger?: DismissalLedger; dbPath?: string | null } = {}) {
  const state = {
    rows: opts.rows ?? [row('a'), row('b')],
    /** Rows a fake `assign` has taken out of the uncategorized set, so `unassign`
     *  can put them back — the DB is the thing that changes under the menu. */
    filed: [] as Row[],
    categories: [...CATEGORIES],
    ledger: { ...(opts.ledger ?? {}) } as DismissalLedger,
  };
  const readArgs: Array<[string, string, string]> = [];
  const logs: string[] = [];
  const writes: Array<{ base: DismissalLedger; next: DismissalLedger }> = [];
  /** Reads and writes in the order they happened — what proves a write had (or
   *  had not) a fresh read behind it. */
  const order: string[] = [];

  const deps = {
    dbPath: vi.fn((): string | null => (opts.dbPath === undefined ? DB : opts.dbPath)),
    readRows: vi.fn((p: string, s: string, e: string) => {
      order.push('readRows');
      readArgs.push([p, s, e]);
      return state.rows.map((r) => ({ ...r }));
    }),
    readCategories: vi.fn((_p: string) => {
      order.push('readCategories');
      return state.categories.map((c) => ({ ...c }));
    }),
    readLedger: vi.fn(async () => {
      order.push('readLedger');
      return { ...state.ledger };
    }),
    writeLedgerMerged: vi.fn(async (base: DismissalLedger, next: DismissalLedger) => {
      order.push('writeLedgerMerged');
      writes.push({ base, next });
      state.ledger = { ...next };
    }),
    assign: vi.fn(async (activityId: string, _categoryId: string) => {
      order.push('assign');
      const hit = state.rows.find((r) => r.activityId === activityId);
      if (hit) {
        state.filed.push(hit);
        state.rows = state.rows.filter((r) => r.activityId !== activityId);
      }
    }),
    unassign: vi.fn(async (activityId: string) => {
      order.push('unassign');
      const hit = state.filed.find((r) => r.activityId === activityId);
      if (hit) {
        state.filed = state.filed.filter((r) => r.activityId !== activityId);
        state.rows = [hit, ...state.rows];
      }
    }),
    createRule: vi.fn(async (_r: { name: string; pattern: string; categoryId: string }) => {
      order.push('createRule');
    }),
    republish: vi.fn(async () => {}),
    log: (m: string) => { logs.push(m); },
  } satisfies CategorizeDeps;

  const ui = {
    edit: vi.fn(async (_t: string, _k?: InlineKeyboard) => {}),
    answer: vi.fn(async (_t?: string) => {}),
    send: vi.fn(async (_t: string, _k?: InlineKeyboard) => {}),
  };
  const send = vi.fn(async (_t: string, _k?: InlineKeyboard) => {});
  const controller = createCategorizeController(deps);

  const tap = (data: string) => controller.onCallback({ data, chatId: CHAT, messageId: 55 }, ui);

  return { state, deps, ui, send, controller, tap, logs, writes, readArgs, order };
}

const lastCall = (fn: { mock: { calls: unknown[][] } }): Recorded => {
  const call = fn.mock.calls.at(-1);
  if (!call) throw new Error('nothing was sent');
  return call as Recorded;
};
const keyboardOf = (call: Recorded): InlineKeyboard => {
  if (!call[1]) throw new Error(`no keyboard on: ${call[0]}`);
  return call[1];
};
const labels = (k: InlineKeyboard): string[] => k.inline_keyboard.flat().map((b) => b.text);
const dataFor = (k: InlineKeyboard, label: string): string => {
  const btn = k.inline_keyboard.flat().find((b) => b.text.includes(label));
  if (!btn) throw new Error(`no button matching "${label}" among: ${labels(k).join(' | ')}`);
  return btn.callback_data;
};

/** open → tap the first row → we are on that row's category picker. */
async function openAtTxn(h: ReturnType<typeof setup>, label = 'BOOK STORES a') {
  await h.controller.open(h.send);
  await h.tap(dataFor(keyboardOf(lastCall(h.send)), label));
  return keyboardOf(lastCall(h.ui.edit));
}

/** open → row → `Entertainment` (childless, so it files) → the `filed` screen. */
async function openAtFiled(h: ReturnType<typeof setup>, label = 'BOOK STORES a') {
  const picker = await openAtTxn(h, label);
  await h.tap(dataFor(picker, 'Entertainment'));
  return keyboardOf(lastCall(h.ui.edit));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the taxonomy the whole feature writes into', () => {
  it('is Wealthfolio\'s spending taxonomy', () => {
    expect(SPENDING_TAXONOMY_ID).toBe('spending_categories');
  });
});

describe('open', () => {
  it('lists what needs a category, with the stored note cleaned up', async () => {
    const h = setup();
    await h.controller.open(h.send);
    const call = lastCall(h.send);
    expect(call[0]).toBe('2 transactions need a category:');
    expect(labels(keyboardOf(call))).toEqual([
      'Aug 8 · BOOK STORES a · -$12',
      'Aug 8 · BOOK STORES b · -$12',
      'Done',
    ]);
    // The ` · TRN-…` bookkeeping suffix is internal. A button label carrying it
    // is a visible defect, and using the raw note is how it gets there.
    expect(call[0] + labels(keyboardOf(call)).join()).not.toContain('TRN-');
  });

  it('reads the same 90-day window the status tile publishes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T15:30:00Z'));
    const h = setup();
    await h.controller.open(h.send);
    expect(h.readArgs).toEqual([[DB, '2026-05-10', '2026-08-09']]);
  });

  it('falls back to the raw note when the description strips to nothing', async () => {
    // Mirrors uncategorized-status.ts: an empty SimpleFin description is a real
    // state, and an empty button label says less than the stored note does.
    const h = setup({ rows: [row('a', { notes: ' · TRN-a' })] });
    await h.controller.open(h.send);
    expect(labels(keyboardOf(lastCall(h.send)))[0]).toBe('Aug 8 ·  · TRN-a · -$12');
  });

  it('leaves dismissed rows out of the list', async () => {
    const h = setup({ ledger: { b: '2026-08-01T00:00:00.000Z' } });
    await h.controller.open(h.send);
    const call = lastCall(h.send);
    expect(call[0]).toBe('1 transaction needs a category:');
    expect(labels(keyboardOf(call))).toEqual(['Aug 8 · BOOK STORES a · -$12', 'Done']);
  });

  it('says so when nothing needs a category', async () => {
    const h = setup({ rows: [] });
    await h.controller.open(h.send);
    const call = lastCall(h.send);
    expect(call[0]).toBe('Nothing needs a category right now.');
    expect(labels(keyboardOf(call))).toEqual(['Done']);
  });

  it('reports missing database access instead of an empty list, and stores no session', async () => {
    // `readRows` answers [] for a path that is not there, so a menu built anyway
    // would claim "nothing needs a category" — false rather than unknown.
    const h = setup({ dbPath: null });
    await h.controller.open(h.send);
    // No keyboard argument at all: there is no session for one to resolve into.
    expect(h.send.mock.calls.at(-1)).toEqual([
      'The companion has no database access right now, so it can\'t tell what needs a category.',
    ]);
    expect(h.deps.readRows).not.toHaveBeenCalled();
    await h.tap('cz:0');
    expect(h.ui.answer).toHaveBeenCalledWith('That menu expired — send /categorize again.');
    expect(h.ui.edit).not.toHaveBeenCalled();
  });

  it('reports a failed read rather than an empty menu', async () => {
    const h = setup();
    h.deps.readRows.mockImplementation(() => { throw new Error('database is locked'); });
    await h.controller.open(h.send);
    expect(h.send.mock.calls.at(-1)).toEqual([
      'Couldn\'t check what needs a category — database is locked',
    ]);
    expect(h.logs.join('\n')).toContain('database is locked');
  });

  it('reports an unreadable ledger instead of a list that ignores dismissals', async () => {
    const h = setup();
    h.deps.readLedger.mockRejectedValue(new Error('secret unreadable'));
    await h.controller.open(h.send);
    expect(h.send.mock.calls.at(-1)).toEqual([
      'Couldn\'t check what needs a category — secret unreadable',
    ]);
    // No session either, so nothing can be tapped into a write from here.
    await h.tap('cz:1:0');
    expect(h.ui.answer).toHaveBeenCalledWith('That menu expired — send /categorize again.');
    expect(h.deps.assign).not.toHaveBeenCalled();
  });
});

describe('taps that cannot be resolved', () => {
  it('answers with the expiry notice when there is no session at all', async () => {
    const h = setup();
    await h.tap('cz:0');
    expect(h.ui.answer).toHaveBeenCalledWith('That menu expired — send /categorize again.');
    expect(h.ui.edit).not.toHaveBeenCalled();
    expect(h.deps.readRows).not.toHaveBeenCalled();
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.writeLedgerMerged).not.toHaveBeenCalled();
  });

  it('answers with the expiry notice for a token from a superseded render', async () => {
    const h = setup();
    await h.controller.open(h.send);
    // Generation 0 is one no render ever carried (the counter starts at 1), so
    // this stands in for any button from a message the menu has moved past.
    await h.tap('cz:0:0');
    expect(h.ui.answer).toHaveBeenCalledWith('That menu expired — send /categorize again.');
    expect(h.ui.edit).not.toHaveBeenCalled();
    expect(h.deps.assign).not.toHaveBeenCalled();
  });

  it('re-renders the current screen from fresh reads for a token it cannot parse', async () => {
    const h = setup();
    await h.controller.open(h.send);
    h.state.rows = [row('a'), row('b'), row('c')];
    // Any `cz:` payload that is not `<generation>:<index>` and not the import
    // notice's own entry token (see the `cz:open` block below).
    await h.tap('cz:nope');
    expect(h.ui.answer).toHaveBeenCalledWith('That button is stale — refreshing.');
    expect(lastCall(h.ui.edit)[0]).toBe('3 transactions need a category:');
  });
});

describe('the import notice\'s Categorize these button', () => {
  it('sends a FRESH message rather than editing the notice it was tapped from', async () => {
    // The notice lists what needs a category and carries its own dismiss
    // buttons; rendering the menu over it would destroy a message the user still
    // needs — and there is nothing else in the chat that says what just imported.
    const h = setup();
    await h.tap(CATEGORIZE_ENTRY_CALLBACK);
    const sent = lastCall(h.ui.send);
    expect(sent[0]).toBe('2 transactions need a category:');
    expect(labels(keyboardOf(sent))).toEqual([
      'Aug 8 · BOOK STORES a · -$12',
      'Aug 8 · BOOK STORES b · -$12',
      'Done',
    ]);
    expect(h.ui.edit).not.toHaveBeenCalled();
    // The spinner is cleared, with no toast: the new message IS the feedback.
    expect(h.ui.answer).toHaveBeenLastCalledWith();
  });

  it('does not need a session, and never answers "that menu expired"', async () => {
    // The notice's buttons outlive any menu — and every daemon restart.
    const h = setup();
    await h.tap(CATEGORIZE_ENTRY_CALLBACK);
    expect(h.ui.answer).not.toHaveBeenCalledWith('That menu expired — send /categorize again.');
    expect(h.deps.readRows).toHaveBeenCalledTimes(1);
  });

  it('leaves a live menu\'s message alone and opens a new one that taps work in', async () => {
    const h = setup();
    await h.controller.open(h.send);
    const editsBefore = h.ui.edit.mock.calls.length;
    h.state.rows = [row('c')];
    await h.tap(CATEGORIZE_ENTRY_CALLBACK);
    expect(h.ui.edit.mock.calls.length).toBe(editsBefore);
    const fresh = keyboardOf(lastCall(h.ui.send));
    expect(labels(fresh)).toEqual(['Aug 8 · BOOK STORES c · -$12', 'Done']);
    // The new message's buttons resolve — the session went to this chat, not to
    // the pending slot a /categorize reply parks it in.
    await h.tap(dataFor(fresh, 'BOOK STORES c'));
    expect(lastCall(h.ui.edit)[0]).toBe('BOOK STORES c\n-$12 · Aug 8 · Citi Double Cash');
  });

  it('reports missing database access on a fresh message too', async () => {
    const h = setup({ dbPath: null });
    await h.tap(CATEGORIZE_ENTRY_CALLBACK);
    expect(h.ui.send.mock.calls.at(-1)).toEqual([
      'The companion has no database access right now, so it can\'t tell what needs a category.',
    ]);
    expect(h.ui.edit).not.toHaveBeenCalled();
  });

  it('reports a failed read on the fresh message, and still clears the spinner', async () => {
    // The anticipated failure: a read that throws is caught by the load itself,
    // so the tap renders the reason as a new message rather than an error.
    const h = setup();
    h.deps.readLedger.mockImplementation(() => { throw new Error('secret store down'); });
    await expect(h.tap(CATEGORIZE_ENTRY_CALLBACK)).resolves.toBeUndefined();
    expect(h.ui.send.mock.calls.at(-1)).toEqual([
      'Couldn\'t check what needs a category — secret store down',
    ]);
    expect(h.ui.edit).not.toHaveBeenCalled();
    expect(h.ui.answer).toHaveBeenLastCalledWith();
  });

  it('clears the spinner even when the send itself rejects', async () => {
    // The UNANTICIPATED failure, and the only thing that reaches this path's
    // catch-all: everything the load can fail at is already rendered as text
    // above, so the remaining hazard is the send — which the listener promises
    // never rejects, exactly the kind of promise a catch-all is for. Without it
    // the tapped button spins until Telegram gives up on the query.
    const h = setup();
    h.ui.send.mockRejectedValue(new Error('telegram unreachable'));
    await expect(h.tap(CATEGORIZE_ENTRY_CALLBACK)).resolves.toBeUndefined();
    expect(h.ui.answer).toHaveBeenLastCalledWith();
    expect(h.logs.join('\n')).toContain('telegram unreachable');
  });
});

describe('openRulePreview — /newrule\'s entry point', () => {
  it('sends the same disclosure copy, with Cancel instead of Back', async () => {
    const h = setup();
    await h.controller.openRulePreview('trader joe*s', 'cat-fun', h.send);
    const sent = lastCall(h.send);
    expect(sent[0]).toBe(
      'Create this rule?\n'
      + 'Descriptions containing "trader joe\\*s" → Entertainment\n'
      + 'It will also file any other uncategorized transactions that match, now and on every future import. '
      + 'Already-categorized transactions are never touched.',
    );
    expect(labels(keyboardOf(sent))).toEqual(['Create rule', 'Cancel']);
  });

  it('creates the typed pattern verbatim through the same rule write', async () => {
    const h = setup();
    await h.controller.openRulePreview('TRADER JOE*S (#123)', 'cat-fun', h.send);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'Create rule'));
    expect(h.deps.createRule).toHaveBeenCalledWith({
      name: 'Telegram: TRADER JOE*S (#123)',
      pattern: 'TRADER JOE*S (#123)',
      categoryId: 'cat-fun',
    });
    const created = lastCall(h.ui.edit);
    expect(created[0]).toBe('Rule created — future matches will file automatically under Entertainment.');
    // No "Back to list": this path never showed a transaction to go back to.
    expect(labels(keyboardOf(created))).toEqual(['Done']);
    expect(h.deps.republish).toHaveBeenCalledTimes(1);
  });

  it('truncates the rule NAME and never the pattern, exactly as the tapped path does', async () => {
    const long = 'COSTCO WHOLESALE #1123 SEATTLE WA CARD PURCHASE 08/08 RECURRING BILLING';
    const h = setup();
    await h.controller.openRulePreview(long, 'cat-fun', h.send);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'Create rule'));
    const rule = h.deps.createRule.mock.calls[0][0];
    expect(rule.name).toBe('Telegram: COSTCO WHOLESALE #1123 SEATTLE WA CARD PURCHASE 08');
    expect(rule.pattern).toBe(long);
  });

  it('reports a refused rule without claiming it was created', async () => {
    const h = setup();
    h.deps.createRule.mockRejectedValue(new Error('422 duplicate rule'));
    await h.controller.openRulePreview('trader joes', 'cat-fun', h.send);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'Create rule'));
    expect(lastCall(h.ui.edit)[0]).toBe('Couldn\'t create that rule — Wealthfolio said: 422 duplicate rule');
  });

  it('cancels without writing anything', async () => {
    const h = setup();
    await h.controller.openRulePreview('trader joes', 'cat-fun', h.send);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'Cancel'));
    expect(lastCall(h.ui.edit)).toEqual(['Menu closed.', undefined]);
    expect(h.deps.createRule).not.toHaveBeenCalled();
  });

  it('reports missing database access instead of previewing a rule it cannot name', async () => {
    const h = setup({ dbPath: null });
    await h.controller.openRulePreview('trader joes', 'cat-fun', h.send);
    expect(h.send.mock.calls.at(-1)).toEqual([
      'The companion has no database access right now, so it can\'t tell what needs a category.',
    ]);
    expect(h.deps.createRule).not.toHaveBeenCalled();
  });
});

describe('filing a transaction', () => {
  it('files under a top-level category that has no subcategories', async () => {
    const h = setup();
    const filed = await openAtFiled(h);
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-fun');
    expect(h.deps.republish).toHaveBeenCalledTimes(1);
    // The row has left the uncategorized set by now — the confirmation still
    // names it, which is only possible because the controller keeps it.
    expect(lastCall(h.ui.edit)[0]).toBe('Filed BOOK STORES a → Entertainment.');
    expect(labels(filed)).toEqual(['Undo', 'Make this a rule', 'Next transaction', 'Done']);
  });

  it('drills into subcategories first when the category has children', async () => {
    const h = setup();
    const picker = await openAtTxn(h);
    expect(lastCall(h.ui.edit)[0]).toBe('BOOK STORES a\n-$12 · Aug 8 · Citi Double Cash');
    await h.tap(dataFor(picker, 'Food & Dining'));
    const subcats = keyboardOf(lastCall(h.ui.edit));
    expect(lastCall(h.ui.edit)[0]).toBe('Choose a subcategory of Food & Dining:');
    expect(labels(subcats)).toEqual(['Restaurants', 'Just Food & Dining itself', '« Back']);
    await h.tap(dataFor(subcats, 'Restaurants'));
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-rest');
  });

  it('clears the button spinner on a tap that worked', async () => {
    const h = setup();
    await openAtFiled(h);
    expect(h.ui.answer).toHaveBeenLastCalledWith();
  });

  it('renders what Wealthfolio said and keeps the previous screen for Back', async () => {
    const h = setup();
    const picker = await openAtTxn(h);
    h.deps.assign.mockRejectedValue(new Error('403 Forbidden: token *expired*'));
    await h.tap(dataFor(picker, 'Entertainment'));
    const failure = lastCall(h.ui.edit);
    // Escaped: the text is Markdown-parsed, and an unbalanced `*` from an API
    // body makes Telegram refuse the edit outright — a screen that never appears.
    expect(failure[0]).toBe('Couldn\'t file that — Wealthfolio said: 403 Forbidden: token \\*expired\\*');
    expect(labels(keyboardOf(failure))).toEqual(['« Back', 'Done']);
    expect(h.deps.republish).not.toHaveBeenCalled();
    expect(h.logs.join('\n')).toContain('403 Forbidden');
    // Back returns to the picker the tap came from — nothing is retried on its own.
    await h.tap(dataFor(keyboardOf(failure), '« Back'));
    expect(lastCall(h.ui.edit)[0]).toBe('BOOK STORES a\n-$12 · Aug 8 · Citi Double Cash');
  });

  it('does not file a row that stopped being uncategorized between taps', async () => {
    const h = setup();
    const picker = await openAtTxn(h);
    // A rule (or the addon) filed it while the picker sat on screen.
    h.state.rows = [row('b')];
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(lastCall(h.ui.edit)[0]).toBe(
      'That transaction is no longer uncategorized.\n\n1 transaction needs a category:',
    );
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual(['Aug 8 · BOOK STORES b · -$12', 'Done']);
  });

  it('undoes a filing through unassign', async () => {
    const h = setup();
    const filed = await openAtFiled(h);
    await h.tap(dataFor(filed, 'Undo'));
    expect(h.deps.unassign).toHaveBeenCalledWith('a');
    expect(h.deps.republish).toHaveBeenCalledTimes(2);
    const undone = lastCall(h.ui.edit);
    expect(undone[0]).toBe('Filing undone — BOOK STORES a is uncategorized again.');
    expect(labels(keyboardOf(undone))).toEqual(['Back to list', 'Done']);
  });

  it('undoes without reading which category is assigned now — a pinned, known hazard', async () => {
    // Deliberate, and pinned so the next reader knows it is a decision: this is
    // the one write on this path with no read behind it. Nothing available to
    // the controller can report the CURRENT assignment (`readRows` returns only
    // uncategorized rows and carries no category id), so if something else
    // re-filed this row under a different category in between, Undo clears that
    // instead. See the hazard note on the `unassign` case in categorize.ts.
    const h = setup();
    const filed = await openAtFiled(h);
    const mark = h.order.length;
    await h.tap(dataFor(filed, 'Undo'));
    // The write comes FIRST — no read precedes it — and the reads that follow
    // are the fresh sweep the confirmation screen is rendered from.
    expect(h.order.slice(mark)).toEqual(['unassign', 'readRows', 'readLedger', 'readCategories']);
    expect(h.deps.unassign.mock.calls[0]).toEqual(['a']);
  });

  it('reports a refused undo without claiming it worked', async () => {
    const h = setup();
    const filed = await openAtFiled(h);
    h.deps.unassign.mockRejectedValue(new Error('500 Internal Server Error'));
    await h.tap(dataFor(filed, 'Undo'));
    expect(lastCall(h.ui.edit)[0]).toBe('Couldn\'t undo that — Wealthfolio said: 500 Internal Server Error');
    expect(h.deps.republish).toHaveBeenCalledTimes(1);
    expect(h.logs.join('\n')).toContain('500 Internal Server Error');
  });
});

describe('dismissing from the menu', () => {
  it('records the dismissal as a delta and confirms it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T15:30:00Z'));
    const h = setup();
    const picker = await openAtTxn(h);
    await h.tap(dataFor(picker, 'Keep uncategorized'));
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].base).toEqual({});
    expect(h.writes[0].next).toEqual({ a: '2026-08-08T15:30:00.000Z' });
    expect(h.deps.republish).toHaveBeenCalledTimes(1);
    const dismissed = lastCall(h.ui.edit);
    expect(dismissed[0]).toBe('BOOK STORES a will stay uncategorized.');
    expect(labels(keyboardOf(dismissed))).toEqual(['Undo', 'Back to list', 'Done']);
  });

  it('bases the merge on the ledger it just read, not the one the menu opened with', async () => {
    // `base` → `next` is the delta another writer's entry survives. A base read
    // when the menu opened would replay "delete everything added since" onto it.
    const h = setup();
    const picker = await openAtTxn(h);
    h.state.ledger = { z: '2026-08-02T00:00:00.000Z' };
    await h.tap(dataFor(picker, 'Keep uncategorized'));
    expect(h.writes[0].base).toEqual({ z: '2026-08-02T00:00:00.000Z' });
    expect(Object.keys(h.writes[0].next).sort()).toEqual(['a', 'z']);
    expect(h.writes[0].base).not.toBe(h.writes[0].next);
    expect(h.writes[0].base).not.toHaveProperty('a');
  });

  it('does not dismiss a row that stopped being uncategorized between taps', async () => {
    const h = setup();
    const picker = await openAtTxn(h);
    h.state.rows = [row('b')];
    await h.tap(dataFor(picker, 'Keep uncategorized'));
    expect(h.deps.writeLedgerMerged).not.toHaveBeenCalled();
    expect(lastCall(h.ui.edit)[0]).toContain('That transaction is no longer uncategorized.');
  });

  it('reports a failed ledger write without confirming the dismissal', async () => {
    const h = setup();
    const picker = await openAtTxn(h);
    h.deps.writeLedgerMerged.mockRejectedValue(new Error('secret write refused'));
    await h.tap(dataFor(picker, 'Keep uncategorized'));
    const failure = lastCall(h.ui.edit);
    expect(failure[0]).toBe('Couldn\'t save that — Wealthfolio said: secret write refused');
    expect(labels(keyboardOf(failure))).toEqual(['« Back', 'Done']);
    expect(h.deps.republish).not.toHaveBeenCalled();
  });

  it('undoes a dismissal by removing the id through the same merged write', async () => {
    const h = setup();
    const picker = await openAtTxn(h);
    await h.tap(dataFor(picker, 'Keep uncategorized'));
    const dismissed = keyboardOf(lastCall(h.ui.edit));
    await h.tap(dataFor(dismissed, 'Undo'));
    expect(h.writes).toHaveLength(2);
    expect(Object.keys(h.writes[1].base)).toEqual(['a']);
    expect(h.writes[1].next).toEqual({});
    expect(lastCall(h.ui.edit)[0]).toBe('Dismissal undone — BOOK STORES a is uncategorized again.');
  });
});

describe('rules', () => {
  const ODD = row('a', { notes: 'TRADER JOE*S (#123) · TRN-a' });

  it('previews the rule with the disclosure copy', async () => {
    const h = setup({ rows: [ODD] });
    const filed = await openAtFiled(h, 'TRADER JOE*S');
    await h.tap(dataFor(filed, 'Make this a rule'));
    expect(lastCall(h.ui.edit)[0]).toBe(
      'Create this rule?\n'
      + 'Descriptions containing "TRADER JOE\\*S (#123)" → Entertainment\n'
      + 'It will also file any other uncategorized transactions that match, now and on every future import. '
      + 'Already-categorized transactions are never touched.',
    );
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual(['Create rule', '« Back']);
  });

  it('creates a contains-rule with the description verbatim', async () => {
    const h = setup({ rows: [ODD] });
    const filed = await openAtFiled(h, 'TRADER JOE*S');
    await h.tap(dataFor(filed, 'Make this a rule'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Create rule'));
    // Verbatim: `*` and `(` are literal text to a contains-match, and escaping
    // them here would create a rule that matches nothing.
    expect(h.deps.createRule).toHaveBeenCalledWith({
      name: 'Telegram: TRADER JOE*S (#123)',
      pattern: 'TRADER JOE*S (#123)',
      categoryId: 'cat-fun',
    });
    const created = lastCall(h.ui.edit);
    expect(created[0]).toBe('Rule created — future matches will file automatically under Entertainment.');
    expect(labels(keyboardOf(created))).toEqual(['Back to list', 'Done']);
    // The server files every other uncategorized match, so the tile is stale now.
    expect(h.deps.republish).toHaveBeenCalledTimes(2);
  });

  it('truncates the rule name to 60 characters', async () => {
    const long = 'COSTCO WHOLESALE #1123 SEATTLE WA CARD PURCHASE 08/08 RECURRING BILLING';
    const h = setup({ rows: [row('a', { notes: `${long} · TRN-a` })] });
    const filed = await openAtFiled(h, 'COSTCO');
    await h.tap(dataFor(filed, 'Make this a rule'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Create rule'));
    const rule = h.deps.createRule.mock.calls[0][0];
    expect(rule.name).toBe('Telegram: COSTCO WHOLESALE #1123 SEATTLE WA CARD PURCHASE 08');
    expect(rule.name).toHaveLength(60);
    // The PATTERN is never truncated — a clipped pattern matches the wrong rows.
    expect(rule.pattern).toBe(long);
  });

  it('reports a refused rule without claiming it was created', async () => {
    const h = setup();
    const filed = await openAtFiled(h);
    h.deps.createRule.mockRejectedValue(new Error('422 duplicate rule'));
    await h.tap(dataFor(filed, 'Make this a rule'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Create rule'));
    expect(lastCall(h.ui.edit)[0]).toBe('Couldn\'t create that rule — Wealthfolio said: 422 duplicate rule');
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual(['« Back', 'Done']);
  });
});

describe('the freshness rule', () => {
  it('re-reads rows, the ledger and the categories before every render', async () => {
    const h = setup();
    await h.controller.open(h.send);
    const picker = keyboardOf(lastCall(h.send));
    await h.tap(dataFor(picker, 'BOOK STORES a'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), '« Back'));
    expect(h.deps.readRows).toHaveBeenCalledTimes(3);
    expect(h.deps.readLedger).toHaveBeenCalledTimes(3);
    expect(h.deps.readCategories).toHaveBeenCalledTimes(3);
  });

  it('drops a row categorized elsewhere from the next list render', async () => {
    const h = setup();
    await h.controller.open(h.send);
    const list = keyboardOf(lastCall(h.send));
    expect(labels(list)).toHaveLength(3);
    // The addon (or an import rule) filed row b between the two taps.
    h.state.rows = [row('a')];
    await h.tap(dataFor(list, 'BOOK STORES a'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), '« Back'));
    const refreshed = lastCall(h.ui.edit);
    expect(refreshed[0]).toBe('1 transaction needs a category:');
    expect(labels(keyboardOf(refreshed))).toEqual(['Aug 8 · BOOK STORES a · -$12', 'Done']);
  });
});

describe('sessions', () => {
  it('replaces the session on a second /categorize, so old buttons go stale', async () => {
    const h = setup({ rows: Array.from({ length: 9 }, (_, i) => row(`r${i}`)) });
    await h.controller.open(h.send);
    const old = keyboardOf(lastCall(h.send));
    const oldDone = dataFor(old, 'Done');
    h.state.rows = [row('r0')];
    await h.controller.open(h.send);
    expect(labels(keyboardOf(lastCall(h.send)))).toEqual(['Aug 8 · BOOK STORES r0 · -$12', 'Done']);

    await h.tap(oldDone);
    expect(h.ui.answer).toHaveBeenCalledWith('That menu expired — send /categorize again.');
    expect(h.ui.edit).not.toHaveBeenCalled();
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.writeLedgerMerged).not.toHaveBeenCalled();
  });

  it('refuses a tap from an older message even when its index still resolves', async () => {
    // THE wrong-row case, and the reason tokens carry a generation. Replacing
    // `buttons` on every render only catches an out-of-range index; two renders
    // of the same SHAPE — two category pickers — have identically sized arrays
    // holding different activity ids, so an in-range index from the older
    // message would resolve position-for-position against the newer picker and
    // file a transaction the user never tapped. No freshness check can see it:
    // the row it lands on genuinely is uncategorized.
    const h = setup();
    const pickerA = await openAtTxn(h, 'BOOK STORES a');
    const tokenFromOldMessage = dataFor(pickerA, 'Entertainment');

    // Meanwhile row a is filed elsewhere and row c arrives; a second
    // /categorize opens a new message, drilled into a DIFFERENT row's picker.
    h.state.rows = [row('b'), row('c')];
    await h.controller.open(h.send);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'BOOK STORES b'));
    const pickerB = keyboardOf(lastCall(h.ui.edit));
    expect(lastCall(h.ui.edit)[0]).toContain('BOOK STORES b');
    // Same button, same index, different transaction — only the generation differs.
    expect(dataFor(pickerB, 'Entertainment').split(':')[2])
      .toBe(tokenFromOldMessage.split(':')[2]);
    expect(dataFor(pickerB, 'Entertainment')).not.toBe(tokenFromOldMessage);

    const editsBefore = h.ui.edit.mock.calls.length;
    await h.tap(tokenFromOldMessage);
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.writeLedgerMerged).not.toHaveBeenCalled();
    expect(h.ui.answer).toHaveBeenLastCalledWith('That menu expired — send /categorize again.');
    expect(h.ui.edit.mock.calls.length).toBe(editsBefore);
  });

  it('gives every emitted keyboard a fresh generation, so the last one stops resolving', async () => {
    const h = setup();
    await h.controller.open(h.send);
    const list = keyboardOf(lastCall(h.send));
    await h.tap(dataFor(list, 'BOOK STORES a'));
    const picker = keyboardOf(lastCall(h.ui.edit));
    const generationOf = (k: InlineKeyboard) => k.inline_keyboard.flat()[0].callback_data.split(':')[1];
    expect(Number(generationOf(picker))).toBeGreaterThan(Number(generationOf(list)));
    // Even the list's `Done` — still in range on the picker — is dead now.
    await h.tap(dataFor(list, 'Done'));
    expect(h.ui.answer).toHaveBeenLastCalledWith('That menu expired — send /categorize again.');
  });

  it('closes the menu with no keyboard left behind, and forgets the session', async () => {
    const h = setup();
    await h.controller.open(h.send);
    const list = keyboardOf(lastCall(h.send));
    await h.tap(dataFor(list, 'Done'));
    // No reply_markup on an edit is how Telegram is told to strip the buttons.
    expect(lastCall(h.ui.edit)).toEqual(['Menu closed.', undefined]);
    await h.tap(dataFor(list, 'Done'));
    expect(h.ui.answer).toHaveBeenLastCalledWith('That menu expired — send /categorize again.');
  });

  it('never uses the callback message id, which can arrive undefined', async () => {
    // Typed `number` on the callback, but the listener reads it off an untrusted
    // payload; the UI it hands over is already bound to the message anyway.
    const h = setup();
    await h.controller.open(h.send);
    const list = keyboardOf(lastCall(h.send));
    await h.controller.onCallback(
      { data: dataFor(list, 'BOOK STORES a'), chatId: CHAT, messageId: undefined as unknown as number },
      h.ui,
    );
    expect(lastCall(h.ui.edit)[0]).toBe('BOOK STORES a\n-$12 · Aug 8 · Citi Double Cash');
  });
});

describe('nothing escapes to the listener', () => {
  it('keeps the flow when republishing the status fails', async () => {
    const h = setup();
    h.deps.republish.mockRejectedValue(new Error('addon secret 401'));
    const filed = await openAtFiled(h);
    expect(lastCall(h.ui.edit)[0]).toBe('Filed BOOK STORES a → Entertainment.');
    expect(labels(filed)).toEqual(['Undo', 'Make this a rule', 'Next transaction', 'Done']);
    expect(h.logs.join('\n')).toContain('addon secret 401');
  });

  it('renders an error screen when a read fails mid-flow', async () => {
    const h = setup();
    await h.controller.open(h.send);
    const list = keyboardOf(lastCall(h.send));
    h.deps.readCategories.mockImplementation(() => { throw new Error('db vanished'); });
    await h.tap(dataFor(list, 'BOOK STORES a'));
    expect(lastCall(h.ui.edit)[0]).toBe('Couldn\'t check what needs a category — db vanished');
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual(['« Back', 'Done']);
  });

  it('reports lost database access mid-flow', async () => {
    const h = setup();
    await h.controller.open(h.send);
    const list = keyboardOf(lastCall(h.send));
    h.deps.dbPath.mockReturnValue(null);
    await h.tap(dataFor(list, 'BOOK STORES a'));
    expect(lastCall(h.ui.edit)[0]).toBe(
      'The companion has no database access right now, so it can\'t tell what needs a category.',
    );
  });

  it('renders, never rejects, when the path lookup itself throws', async () => {
    const h = setup();
    await h.controller.open(h.send);
    const list = keyboardOf(lastCall(h.send));
    const rowToken = dataFor(list, 'BOOK STORES a');
    h.deps.dbPath.mockImplementation(() => { throw new Error('existsSync exploded'); });
    await expect(h.tap(rowToken)).resolves.toBeUndefined();
    expect(lastCall(h.ui.edit)[0]).toBe(
      'The companion has no database access right now, so it can\'t tell what needs a category.',
    );
    expect(h.logs.join('\n')).toContain('existsSync exploded');
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.writeLedgerMerged).not.toHaveBeenCalled();
  });

  it('survives a logger that throws while reporting a failure', async () => {
    // Every log call in this file sits in a catch that exists to stop something
    // worse; a throwing logger inside one would recreate exactly that failure.
    const h = setup();
    const deps: CategorizeDeps = { ...h.deps, log: () => { throw new Error('logger down'); } };
    const controller = createCategorizeController(deps);
    await controller.open(h.send);
    const list = keyboardOf(lastCall(h.send));
    h.deps.assign.mockRejectedValue(new Error('403'));
    const picker = dataFor(list, 'BOOK STORES a');
    await expect(controller.onCallback({ data: picker, chatId: CHAT, messageId: 1 }, h.ui)).resolves.toBeUndefined();
    const catToken = dataFor(keyboardOf(lastCall(h.ui.edit)), 'Entertainment');
    await expect(controller.onCallback({ data: catToken, chatId: CHAT, messageId: 1 }, h.ui)).resolves.toBeUndefined();
    expect(lastCall(h.ui.edit)[0]).toBe('Couldn\'t file that — Wealthfolio said: 403');
  });
});
