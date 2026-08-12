import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createCategorizeController,
  INCOME_TAXONOMY_NOTE,
  SPENDING_TAXONOMY_ID,
  type CategorizeDeps,
} from './categorize.js';
import { bucketFor, taxonomyForBucket } from '../../shared/cash-flow-bucket.js';
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

/** A non-spending taxonomy id, deliberately NOT the literal string `income`:
 *  the controller has to detect the income side by
 *  `taxonomyId !== SPENDING_TAXONOMY_ID`, never by matching a name (see
 *  `INCOME_TAXONOMY_NOTE`, which is prose, not an id). */
const INCOME_TAXONOMY_ID = 'income_categories';
/** A THIRD taxonomy, so "clear every non-spending assignment" can be shown to
 *  mean every one of them rather than "the first". */
const SAVINGS_TAXONOMY_ID = 'savings_categories';
/** Wealthfolio's REAL income taxonomy id (docs/upstream-spending-buckets.md §3),
 *  needed wherever an income assignment has to be RESTORED rather than merely
 *  cleared: the bucket predicate compares literal taxonomy ids, so only this one
 *  can ever be legal on an income-bucketed row, and the fictional id above is
 *  refused there exactly as the server would refuse it.
 *
 *  Both ids stay: clearing is id-agnostic (the controller clears every taxonomy
 *  that is not the spending one, whatever it turns out to be), and the fiction is
 *  what pins that — an implementation matching on a known income id would leave
 *  it in place and those tests would fail. */
const WF_INCOME_TAXONOMY_ID = 'income_sources';

/** Non-spending category names live outside `CATEGORIES` (the spending tree the
 *  picker renders) — that separation is the whole point of `currentCategory`
 *  carrying a taxonomy id and a display name rather than an index into it. */
const OFF_TREE_CATEGORY_NAMES: Record<string, string> = {
  'inc-reimb': 'Reimbursements',
  'sav-goal': 'House Fund',
};

interface Assignment { taxonomyId: string; categoryId: string; categoryName: string }

/** A row shaped like `getNativeCategorizedSpending`'s output: the RAW note plus
 *  EVERY taxonomy's assignment on that activity. */
interface CatRow {
  activityId: string;
  notes: string;
  amountCents: number;
  date: string;
  accountName: string;
  activityType: string;
  /** Raw stored subtype, `''` when absent — exactly what the native reader
   *  hands over. With `accountType` and `activityType` it is what decides the
   *  row's cash-flow bucket, and therefore whether a spending category may be
   *  assigned to it at all. */
  subtype: string;
  /** The account's Wealthfolio type. Every fixture states it, because a row
   *  whose account type is unknown is `neutral` to the predicate — nothing
   *  assignable — and a fixture that left it out would be testing that case
   *  by accident. */
  accountType: string;
  assignments: Assignment[];
}

const spendingAt = (categoryId: string, categoryName: string): Assignment =>
  ({ taxonomyId: SPENDING_TAXONOMY_ID, categoryId, categoryName });
const incomeAt = (categoryId: string, categoryName: string): Assignment =>
  ({ taxonomyId: INCOME_TAXONOMY_ID, categoryId, categoryName });
const savingsAt = (categoryId: string, categoryName: string): Assignment =>
  ({ taxonomyId: SAVINGS_TAXONOMY_ID, categoryId, categoryName });
const wfIncomeAt = (categoryId: string, categoryName: string): Assignment =>
  ({ taxonomyId: WF_INCOME_TAXONOMY_ID, categoryId, categoryName });

/** The DEFAULT is the row the whole bug is about: a CASH `DEPOSIT`, which is
 *  Wealthfolio's `income` bucket, so a spending category on it is refused. Any
 *  fixture that needs a legal spending move states so explicitly — see
 *  `REIMBURSED` and `CARD_REFUND`. */
const catRow = (id: string, assignments: Assignment[], over: Partial<CatRow> = {}): CatRow => ({
  activityId: id,
  notes: `VENMO PAYMENT ${id} · TRN-${id}`,
  amountCents: 2400,
  date: '2026-08-09',
  accountName: 'Citi Double Cash',
  activityType: 'DEPOSIT',
  subtype: '',
  accountType: 'CASH',
  assignments,
  ...over,
});

/** The override that puts a CASH row in the SPENDING bucket, and the ONLY way a
 *  Venmo payback legally gets there: imported as a `CREDIT` marked
 *  `REIMBURSEMENT`, which is what a transaction rule now does for it. Every
 *  cross-taxonomy move below uses it, because a move off a plain CASH `DEPOSIT`
 *  is a write Wealthfolio refuses — the fixture that made those tests pass was
 *  describing a state the server never allows. */
const REIMBURSED: Partial<CatRow> = { activityType: 'CREDIT', subtype: 'REIMBURSEMENT' };

type Recorded = [string, InlineKeyboard | undefined];

function setup(
  opts: { rows?: Row[]; categorized?: CatRow[]; ledger?: DismissalLedger; dbPath?: string | null } = {},
) {
  /** The invariant the two native readers guarantee: an activity is in EXACTLY
   *  one of the two sweeps. Enforced on the fixtures as well as at read time
   *  (see `readRows`) because the fake WRITES read `state.rows` too — one
   *  activity in both sets would let a filing take its description from the
   *  wrong copy of itself. */
  const categorizedIds = new Set((opts.categorized ?? []).map((r) => r.activityId));
  const state = {
    rows: (opts.rows ?? [row('a'), row('b')]).filter((r) => !categorizedIds.has(r.activityId)),
    /** Rows a fake `assign` has taken out of the uncategorized set, so `unassign`
     *  can put them back — the DB is the thing that changes under the menu. */
    filed: [] as Row[],
    /** The categorized side of the same database. The two sets PARTITION the
     *  rows, exactly as the two native readers do, so a fake write that files a
     *  row moves it from one to the other — which is what lets a test observe
     *  "a delete succeeded and the assign did not, so /categorize sees it now". */
    categorized: (opts.categorized ?? []).map((r) => ({ ...r, assignments: r.assignments.map((a) => ({ ...a })) })),
    categories: [...CATEGORIES],
    ledger: { ...(opts.ledger ?? {}) } as DismissalLedger,
  };
  const readArgs: Array<[string, string, string]> = [];
  /** Kept apart from `readArgs` so the categorize window assertions keep
   *  measuring only the uncategorized sweep. */
  const recatArgs: Array<[string, string, string]> = [];
  const logs: string[] = [];
  const writes: Array<{ base: DismissalLedger; next: DismissalLedger }> = [];
  /** Reads and writes in the order they happened — what proves a write had (or
   *  had not) a fresh read behind it. */
  const order: string[] = [];

  /** The name a category id shows up under — the spending tree first, then the
   *  off-tree (income/savings) names, so a fake write records what the real
   *  reader would read back. */
  const nameFor = (categoryId: string): string =>
    state.categories.find((c) => c.id === categoryId)?.name ?? OFF_TREE_CATEGORY_NAMES[categoryId] ?? categoryId;

  /** The activity-level facts of a row that has dropped out of the categorized
   *  sweep. In Wealthfolio these live on the ACTIVITY, not on its assignments, so
   *  deleting the last assignment cannot change the row's type, subtype or
   *  account — and therefore cannot change its cash-flow bucket. That matters
   *  precisely on the undo path, which deletes before it writes: the row the next
   *  write lands on has to be the same transaction, at the same bucket, not a
   *  freshly invented card spend. */
  const detached = new Map<string, CatRow>();

  /** A row that has lost its LAST assignment is uncategorized, so it leaves the
   *  categorized set and joins the one `/categorize` sweeps. Modelling this is
   *  what makes the delete-then-assign ordering observable end to end. */
  const dropIfBare = (activityId: string): void => {
    const cat = state.categorized.find((r) => r.activityId === activityId);
    if (!cat || cat.assignments.length > 0) return;
    detached.set(activityId, cat);
    state.categorized = state.categorized.filter((r) => r.activityId !== activityId);
    if (!state.rows.some((r) => r.activityId === activityId)) {
      state.rows = [{
        activityId,
        wfAccountId: 'wf-1',
        notes: cat.notes,
        amountCents: cat.amountCents,
        date: cat.date,
        accountName: cat.accountName,
      }, ...state.rows];
    }
  };

  const deps = {
    dbPath: vi.fn((): string | null => (opts.dbPath === undefined ? DB : opts.dbPath)),
    readRows: vi.fn((p: string, s: string, e: string) => {
      order.push('readRows');
      readArgs.push([p, s, e]);
      // The real reader's `LEFT JOIN ... IS NULL`: a row that HAS an assignment is
      // not part of the uncategorized sweep. Applied at read time rather than at
      // setup so a test that changes what a row is filed under mid-flow — which is
      // most of the freshness ones — moves it between the two sweeps the way the
      // database would.
      const assigned = new Set(state.categorized.filter((c) => c.assignments.length > 0).map((c) => c.activityId));
      return state.rows.filter((r) => !assigned.has(r.activityId)).map((r) => ({ ...r }));
    }),
    readCategorized: vi.fn((p: string, s: string, e: string) => {
      order.push('readCategorized');
      recatArgs.push([p, s, e]);
      return state.categorized.map((r) => ({ ...r, assignments: r.assignments.map((a) => ({ ...a })) }));
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
    assign: vi.fn(async (activityId: string, categoryId: string, taxonomyId: string = SPENDING_TAXONOMY_ID) => {
      // The taxonomy is recorded in the order log: an assign that dropped it on
      // the floor and wrote the spending taxonomy for an income restore is
      // exactly the silent failure this dep's third parameter exists to prevent.
      order.push(`assign:${taxonomyId}`);
      const hit = state.rows.find((r) => r.activityId === activityId);
      // THE SERVER'S OWN RULE, before anything is written: a row may only carry
      // the ONE taxonomy its cash-flow bucket accepts
      // (`ensure_activity_assignment_allowed`, docs/upstream-spending-buckets.md
      // §1), and the bucket is derived from the row AS IT IS NOW — its account
      // type, activity type and subtype. Enforced here because a fake that
      // accepted any taxonomy on any row is what let this suite certify a
      // delete-then-400 sequence as working: the forward move's fixtures were
      // corrected by hand once, and the undo's were not. `unassignTaxonomy`
      // below stays permissive, matching upstream (§1: `enforce_bucket=false`
      // on unassign) — that asymmetry is the whole mechanism, since it is what
      // lets a restore clear the new category and then fail to put the old one
      // back.
      const bucketOf = state.categorized.find((r) => r.activityId === activityId) ?? detached.get(activityId);
      const expected = taxonomyForBucket(bucketFor(bucketOf
        ? { accountType: bucketOf.accountType, activityType: bucketOf.activityType, subtype: bucketOf.subtype }
        // A row that has never been categorized comes from the UNcategorized
        // sweep, which this fake models as a card spend — the same shape it
        // gives the row it is about to create below.
        : { accountType: 'CREDIT_CARD', activityType: 'WITHDRAWAL', subtype: '' }));
      if (expected !== taxonomyId) {
        // Upstream's own two 400 sentences, verbatim (§1), so a leak of this
        // prose into user-visible copy is recognisable in a diff — the copy
        // tests assert against these exact strings.
        throw new Error(expected === null
          ? '400 Bad Request: Neutral transfers cannot be categorized. Change or unlink the transfer if it should count as spending.'
          : '400 Bad Request: Income activities can only use income categories. '
            + 'Categories label the cash-flow bucket; they do not change it.');
      }
      if (hit) {
        state.filed.push(hit);
        state.rows = state.rows.filter((r) => r.activityId !== activityId);
      }
      let cat = state.categorized.find((r) => r.activityId === activityId);
      if (!cat) {
        const src = hit ?? state.filed.find((r) => r.activityId === activityId);
        const known = detached.get(activityId);
        cat = {
          activityId,
          notes: known?.notes ?? src?.notes ?? `ROW ${activityId} · TRN-${activityId}`,
          amountCents: known?.amountCents ?? src?.amountCents ?? 0,
          date: known?.date ?? src?.date ?? '2026-08-08',
          accountName: known?.accountName ?? src?.accountName ?? 'Citi Double Cash',
          // A row that came back from `detached` keeps the activity it always was;
          // one that arrived from the UNcategorized sweep is a card spend —
          // CREDIT_CARD + WITHDRAWAL, which is the spending bucket.
          activityType: known?.activityType ?? 'WITHDRAWAL',
          subtype: known?.subtype ?? '',
          accountType: known?.accountType ?? 'CREDIT_CARD',
          assignments: [],
        };
        state.categorized = [...state.categorized, cat];
      }
      // One assignment per taxonomy — the server's own shape, and the reason a
      // cross-taxonomy move has to DELETE rather than overwrite.
      cat.assignments = [
        ...cat.assignments.filter((a) => a.taxonomyId !== taxonomyId),
        { taxonomyId, categoryId, categoryName: nameFor(categoryId) },
      ];
    }),
    unassign: vi.fn(async (activityId: string) => {
      order.push('unassign');
      const hit = state.filed.find((r) => r.activityId === activityId);
      if (hit) {
        state.filed = state.filed.filter((r) => r.activityId !== activityId);
        state.rows = [hit, ...state.rows];
      }
      const cat = state.categorized.find((r) => r.activityId === activityId);
      if (cat) {
        cat.assignments = cat.assignments.filter((a) => a.taxonomyId !== SPENDING_TAXONOMY_ID);
        dropIfBare(activityId);
      }
    }),
    unassignTaxonomy: vi.fn(async (activityId: string, taxonomyId: string) => {
      order.push(`unassignTaxonomy:${taxonomyId}`);
      const cat = state.categorized.find((r) => r.activityId === activityId);
      if (!cat) return;
      cat.assignments = cat.assignments.filter((a) => a.taxonomyId !== taxonomyId);
      dropIfBare(activityId);
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

  return { state, deps, ui, send, controller, tap, logs, writes, readArgs, recatArgs, order };
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

/** /recategorize → tap the named row → that row's picker. */
async function openRecatAtTxn(h: ReturnType<typeof setup>, label = 'VENMO PAYMENT a') {
  await h.controller.openRecategorize(undefined, h.send);
  await h.tap(dataFor(keyboardOf(lastCall(h.send)), label));
  return keyboardOf(lastCall(h.ui.edit));
}

/** /recategorize → row → a childless category → the `refiled` screen. */
async function openRecatAtRefiled(
  h: ReturnType<typeof setup>,
  label = 'VENMO PAYMENT a',
  category = 'Entertainment',
) {
  const picker = await openRecatAtTxn(h, label);
  await h.tap(dataFor(picker, category));
  return keyboardOf(lastCall(h.ui.edit));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the taxonomy the whole feature writes into', () => {
  it('is Wealthfolio\'s spending taxonomy', () => {
    expect(SPENDING_TAXONOMY_ID).toBe('spending_categories');
  });

  it('names the income side in prose, with no id anyone could match on', () => {
    // `income` is what the feature CALLS the other side of the ledger, and it is
    // deliberately not usable as a taxonomy id: a Wealthfolio instance's income
    // taxonomy is `income_categories`, there is a savings one too, and a release
    // can add more. Detection is `taxonomyId !== SPENDING_TAXONOMY_ID`, which the
    // cross-taxonomy tests below pin behaviourally — their fixture taxonomies are
    // real ids that this constant does not match, so an implementation comparing
    // against it clears nothing and those tests fail.
    expect(INCOME_TAXONOMY_NOTE).toBe('income');
    expect(INCOME_TAXONOMY_NOTE).not.toBe(SPENDING_TAXONOMY_ID);
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

  it('reports missing database access in ITS OWN words — /newrule lists nothing', async () => {
    // The menu's sentence ("can't tell what needs a category") describes a list
    // this path never shows: `/newrule` was given a pattern and a category, and
    // what the database is needed for is looking that category up.
    const h = setup({ dbPath: null });
    await h.controller.openRulePreview('trader joes', 'cat-fun', h.send);
    expect(h.send.mock.calls.at(-1)).toEqual([
      'The companion has no database access right now, so it can\'t look up your categories.',
    ]);
    expect(h.deps.createRule).not.toHaveBeenCalled();
  });

  it('names the rule, not a list, when the read itself fails', async () => {
    const h = setup();
    h.deps.readLedger.mockRejectedValueOnce(new Error('secret store down'));
    await h.controller.openRulePreview('trader joes', 'cat-fun', h.send);
    expect(h.send.mock.calls.at(-1)).toEqual([
      'Couldn\'t set that rule up — secret store down',
    ]);
    expect(h.deps.createRule).not.toHaveBeenCalled();
  });

  it('does not re-offer Create rule once the rule exists, so the obvious retry cannot duplicate it', async () => {
    // The write succeeds and the render that would CONFIRM it fails, leaving the
    // reader on an error screen with `« Back`. Back used to return to the PREVIEW,
    // whose `Create rule` button writes the very same rule again — harmless in
    // outcome (the second rule is identical) but it clutters Wealthfolio's rules
    // list with duplicates nobody asked for.
    const h = setup();
    await h.controller.openRulePreview('trader joes', 'cat-fun', h.send);
    h.deps.readLedger.mockRejectedValueOnce(new Error('secret store down'));
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'Create rule'));

    expect(h.deps.createRule).toHaveBeenCalledTimes(1);
    const failed = lastCall(h.ui.edit);
    expect(failed[0]).toBe('Couldn\'t set that rule up — secret store down');
    expect(labels(keyboardOf(failed))).toEqual(['« Back', 'Done']);

    await h.tap(dataFor(keyboardOf(failed), '« Back'));
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).not.toContain('Create rule');
    expect(lastCall(h.ui.edit)[0]).toBe(
      'Rule created — future matches will file automatically under Entertainment.',
    );
    expect(h.deps.createRule).toHaveBeenCalledTimes(1);
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

  it('reads the row\'s CURRENT assignment before un-filing it — the closed v1.12.0 blind spot', async () => {
    // This test used to pin the opposite: until a reader for a row's current
    // assignment existed, Undo wrote with no read behind it, and the hazard was
    // documented rather than fixed. `readCategorized` closes it, so the order
    // now starts with a verification read — the write can no longer be the first
    // thing that happens on this path.
    const h = setup();
    const filed = await openAtFiled(h);
    const mark = h.order.length;
    await h.tap(dataFor(filed, 'Undo'));
    expect(h.order.slice(mark)).toEqual([
      'readCategorized', 'unassign', 'readRows', 'readLedger', 'readCategories',
    ]);
    expect(h.deps.unassign.mock.calls[0]).toEqual(['a']);
  });

  it('declines the undo when something else re-filed the row under a different category', async () => {
    // The erasure the blind write could cause: a rule (or the addon, or the
    // other host) moved this row to Restaurants between the filing and the tap.
    // Un-filing now would delete THAT category, not the one this menu set.
    const h = setup();
    const filed = await openAtFiled(h);
    h.state.categorized = [catRow('a', [spendingAt('cat-rest', 'Restaurants')], { notes: 'BOOK STORES a · TRN-a' })];
    await h.tap(dataFor(filed, 'Undo'));
    expect(h.deps.unassign).not.toHaveBeenCalled();
    expect(lastCall(h.ui.edit)[0]).toContain('That transaction changed elsewhere — leaving it as is.');
    // Refreshed, not left on a dead screen: what the list shows now is the truth.
    expect(lastCall(h.ui.edit)[0]).toContain('need');
  });

  it('declines the undo when the row carries no assignment at all any more', async () => {
    // Someone already un-filed it. There is nothing this menu set left to undo,
    // and clearing an empty assignment would report success for a no-op.
    const h = setup();
    const filed = await openAtFiled(h);
    h.state.categorized = [];
    await h.tap(dataFor(filed, 'Undo'));
    expect(h.deps.unassign).not.toHaveBeenCalled();
    expect(lastCall(h.ui.edit)[0]).toContain('That transaction changed elsewhere — leaving it as is.');
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

// ---- /recategorize ---------------------------------------------------------

/** The realistic case the whole feature exists for, BEFORE any rule touches it:
 *  a Venmo payback that arrived as a CASH `DEPOSIT` and auto-filed under an
 *  INCOME category. Its bucket is `income`, so Wealthfolio refuses a spending
 *  category on it — this is the fixture the refusal gate is about. */
const VENMO_INCOME = catRow('a', [incomeAt('inc-reimb', 'Reimbursements')]);
/** The SAME payback after a transaction rule has brought it in as a `CREDIT`
 *  marked `REIMBURSEMENT`: its bucket is now `spending`, so filing it under a
 *  spending category is an ordinary legal write, and the dangling income
 *  assignment is what the move clears. */
const VENMO_REIMBURSED = catRow('a', [incomeAt('inc-reimb', 'Reimbursements')], REIMBURSED);
/** A bare CASH `CREDIT` with no refund subtype: `Ignored` upstream, which is the
 *  `neutral` bucket — NO taxonomy may be attached to it at all, which is a
 *  different refusal from the income one. */
const BARE_CREDIT = catRow('a', [incomeAt('inc-reimb', 'Reimbursements')], { activityType: 'CREDIT' });
/** A credit-card refund. Every `CREDIT` on a CREDIT_CARD account is an expense
 *  refund upstream — spending bucket, subtype irrelevant — so this one needs no
 *  rule and no gate. */
const CARD_REFUND = catRow('c', [incomeAt('inc-reimb', 'Reimbursements')], {
  notes: 'AMZN REFUND c · TRN-c',
  amountCents: 1800,
  date: '2026-08-06',
  activityType: 'CREDIT',
  accountType: 'CREDIT_CARD',
});
/** The same-taxonomy case: already a spending category, just the wrong one. A
 *  card purchase, so its bucket is `spending` and the move is legal. */
const GROCERIES = catRow('b', [spendingAt('cat-rest', 'Restaurants')], {
  notes: 'TRADER JOES b · TRN-b',
  amountCents: -4500,
  date: '2026-08-07',
  activityType: 'WITHDRAWAL',
  accountType: 'CREDIT_CARD',
});

describe('openRecategorize', () => {
  it('lists categorized rows with their current category, notes cleaned', async () => {
    const h = setup({ categorized: [VENMO_INCOME, GROCERIES] });
    await h.controller.openRecategorize(undefined, h.send);
    const call = lastCall(h.send);
    expect(call[0]).toBe('Recategorize — tap a transaction');
    expect(labels(keyboardOf(call))).toEqual([
      'Aug 9 · VENMO PAYMENT a · $24 · Reimbursements',
      'Aug 7 · TRADER JOES b · -$45 · Restaurants',
      'Done',
    ]);
    // The bookkeeping suffix is internal here too.
    expect(call[0] + labels(keyboardOf(call)).join()).not.toContain('TRN-');
  });

  it('reads the categorized sweep over the same 90-day window, and never the dismissal ledger', async () => {
    // The ledger answers "does this still need a category", which is not a
    // question /recategorize asks — every row it lists already has one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T15:30:00Z'));
    const h = setup({ categorized: [VENMO_INCOME] });
    await h.controller.openRecategorize(undefined, h.send);
    expect(h.recatArgs).toEqual([[DB, '2026-05-10', '2026-08-09']]);
    expect(h.deps.readRows).not.toHaveBeenCalled();
    expect(h.deps.readLedger).not.toHaveBeenCalled();
  });

  it('falls back to the raw note when the description strips to nothing', async () => {
    const h = setup({ categorized: [catRow('a', [spendingAt('cat-fun', 'Entertainment')], { notes: ' · TRN-a' })] });
    await h.controller.openRecategorize(undefined, h.send);
    expect(labels(keyboardOf(lastCall(h.send)))[0]).toBe('Aug 9 ·  · TRN-a · $24 · Entertainment');
  });

  it('filters case-insensitively on the CLEANED description', async () => {
    const h = setup({ categorized: [VENMO_INCOME, GROCERIES] });
    await h.controller.openRecategorize('vEnMo', h.send);
    expect(labels(keyboardOf(lastCall(h.send)))).toEqual([
      'Aug 9 · VENMO PAYMENT a · $24 · Reimbursements',
      'Done',
    ]);
  });

  it('does not match on the stored note\'s bookkeeping suffix', async () => {
    // Proof the filter runs on the cleaned description, not the raw note: the
    // tx id is in every note and would otherwise make `trn` match everything.
    const h = setup({ categorized: [VENMO_INCOME, GROCERIES] });
    await h.controller.openRecategorize('trn-a', h.send);
    expect(lastCall(h.send)[0]).toBe('Nothing categorized in the last 90 days matches.');
  });

  it('treats a blank argument as no filter at all', async () => {
    const h = setup({ categorized: [VENMO_INCOME, GROCERIES] });
    await h.controller.openRecategorize('   ', h.send);
    expect(labels(keyboardOf(lastCall(h.send)))).toHaveLength(3);
  });

  it('says nothing matches rather than showing an empty menu', async () => {
    const h = setup({ categorized: [VENMO_INCOME] });
    await h.controller.openRecategorize('costco', h.send);
    const call = lastCall(h.send);
    expect(call[0]).toBe('Nothing categorized in the last 90 days matches.');
    expect(labels(keyboardOf(call))).toEqual(['Done']);
  });

  it('shows the SPENDING assignment as the current category when a row carries both', async () => {
    // The user recognises the spending category — it is the one their budgets
    // and every /left figure are about.
    const h = setup({
      categorized: [catRow('a', [incomeAt('inc-reimb', 'Reimbursements'), spendingAt('cat-rest', 'Restaurants')])],
    });
    await h.controller.openRecategorize(undefined, h.send);
    expect(labels(keyboardOf(lastCall(h.send)))[0]).toContain('· Restaurants');
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'VENMO PAYMENT a'));
    expect(lastCall(h.ui.edit)[0]).toContain('Currently: Restaurants');
  });

  it('offers no Keep uncategorized button — the row already has a category', async () => {
    const h = setup({ categorized: [VENMO_INCOME] });
    const picker = await openRecatAtTxn(h);
    expect(labels(picker)).not.toContain('Keep uncategorized');
    expect(labels(picker)).toEqual(['Food & Dining', 'Entertainment', '« Back']);
    expect(lastCall(h.ui.edit)[0]).toBe(
      'VENMO PAYMENT a\n$24 · Aug 9 · Citi Double Cash\nCurrently: Reimbursements',
    );
  });

  it('leaves out a row that carries no assignment at all', async () => {
    // It belongs to /categorize, and a row with nothing to move FROM cannot
    // render the old → new confirmation this menu is built around.
    const h = setup({ categorized: [VENMO_INCOME, catRow('z', [])] });
    await h.controller.openRecategorize(undefined, h.send);
    expect(labels(keyboardOf(lastCall(h.send)))).toEqual([
      'Aug 9 · VENMO PAYMENT a · $24 · Reimbursements',
      'Done',
    ]);
  });

  it('reports missing database access in its own words, and stores no session', async () => {
    const h = setup({ categorized: [VENMO_INCOME], dbPath: null });
    await h.controller.openRecategorize(undefined, h.send);
    expect(h.send.mock.calls.at(-1)).toEqual([
      'The companion has no database access right now, so it can\'t look up your transactions.',
    ]);
    expect(h.deps.readCategorized).not.toHaveBeenCalled();
    await h.tap('cz:1:0');
    expect(h.ui.answer).toHaveBeenCalledWith('That menu expired — send /categorize again.');
  });

  it('reports a failed read in its own words rather than an empty menu', async () => {
    const h = setup({ categorized: [VENMO_INCOME] });
    h.deps.readCategorized.mockImplementation(() => { throw new Error('database is locked'); });
    await h.controller.openRecategorize(undefined, h.send);
    expect(h.send.mock.calls.at(-1)).toEqual([
      'Couldn\'t look up your transactions — database is locked',
    ]);
    expect(h.logs.join('\n')).toContain('database is locked');
  });

  it('replaces a live /categorize menu, so its buttons go stale', async () => {
    const h = setup({ categorized: [VENMO_INCOME] });
    await h.controller.open(h.send);
    const oldList = keyboardOf(lastCall(h.send));
    await h.controller.openRecategorize(undefined, h.send);
    expect(lastCall(h.send)[0]).toBe('Recategorize — tap a transaction');
    await h.tap(dataFor(oldList, 'BOOK STORES b'));
    expect(h.ui.answer).toHaveBeenLastCalledWith('That menu expired — send /categorize again.');
    expect(h.deps.assign).not.toHaveBeenCalled();
  });

  it('re-renders the recategorize list — not the categorize one — on every transition', async () => {
    const h = setup({ categorized: [VENMO_INCOME, GROCERIES] });
    const picker = await openRecatAtTxn(h);
    await h.tap(dataFor(picker, '« Back'));
    expect(lastCall(h.ui.edit)[0]).toBe('Recategorize — tap a transaction');
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual([
      'Aug 9 · VENMO PAYMENT a · $24 · Reimbursements',
      'Aug 7 · TRADER JOES b · -$45 · Restaurants',
      'Done',
    ]);
    expect(h.deps.readRows).not.toHaveBeenCalled();
  });

  it('keeps the search scope across every later render', async () => {
    // The list the user is looking at must not silently widen under them.
    const h = setup({ categorized: [VENMO_INCOME, GROCERIES] });
    await h.controller.openRecategorize('venmo', h.send);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'VENMO PAYMENT a'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), '« Back'));
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual([
      'Aug 9 · VENMO PAYMENT a · $24 · Reimbursements',
      'Done',
    ]);
  });
});

describe('openRecategorizeForTxIds — the import notice\'s button', () => {
  it('scopes the list to the given tx ids, matched on the note\'s id suffix', async () => {
    const h = setup({ categorized: [VENMO_INCOME, GROCERIES] });
    await h.controller.openRecategorizeForTxIds(['TRN-b'], h.send);
    expect(labels(keyboardOf(lastCall(h.send)))).toEqual([
      'Aug 7 · TRADER JOES b · -$45 · Restaurants',
      'Done',
    ]);
  });

  it('falls back to the plain recent list when the import\'s identity is gone', async () => {
    // A companion restart loses which rows an old notice was about; the honest
    // degradation is the same list a bare /recategorize shows.
    const h = setup({ categorized: [VENMO_INCOME, GROCERIES] });
    await h.controller.openRecategorizeForTxIds(null, h.send);
    expect(labels(keyboardOf(lastCall(h.send)))).toEqual([
      'Aug 9 · VENMO PAYMENT a · $24 · Reimbursements',
      'Aug 7 · TRADER JOES b · -$45 · Restaurants',
      'Done',
    ]);
  });

  it('matches nothing for an import that brought nothing categorized', async () => {
    const h = setup({ categorized: [VENMO_INCOME] });
    await h.controller.openRecategorizeForTxIds([], h.send);
    expect(lastCall(h.send)[0]).toBe('Nothing categorized in the last 90 days matches.');
  });

  it('keeps the scope across later renders, and its taps write', async () => {
    // The reimbursed fixture, because this test's subject is the SCOPE surviving
    // a write — and a write only happens on a row whose bucket allows one.
    const h = setup({ categorized: [VENMO_REIMBURSED, GROCERIES] });
    await h.controller.openRecategorizeForTxIds(['TRN-a'], h.send);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'VENMO PAYMENT a'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Entertainment'));
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-fun');
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Next transaction'));
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual([
      'Aug 9 · VENMO PAYMENT a · $24 · Entertainment',
      'Done',
    ]);
  });
});

/** The three refusal screens, verbatim. Written out here rather than imported so
 *  a change to any of these sentences has to be made twice, deliberately — this
 *  is the copy a user sees instead of losing a category.
 *
 *  Two of the three end with the reimbursement line and one does not, which is
 *  the whole point: it is offered only where a refund subtype could actually
 *  lift the refusal. */
const REFUSED_INCOME_TEXT =
  'It is recorded as money in and can only take an income category while that is true.\n'
  + 'A payback can be turned into a spending offset by marking it a reimbursement in Advanced → Transaction Rules.';
const REFUSED_NEUTRAL_SUBTYPE_TEXT =
  'The transaction is not counted as spending or income at all, so no category can be attached to it as it stands.\n'
  + 'A payback can be turned into a spending offset by marking it a reimbursement in Advanced → Transaction Rules.';
/** No second line: on these rows the ACCOUNT TYPE decides, and no subtype moves
 *  them — see the SECURITIES/unknown-account test below. */
const REFUSED_NEUTRAL_TEXT =
  'The transaction is not counted as spending or income at all, so no category can be attached to it as it stands.';

describe('reassign — the gate that refuses a move Wealthfolio would reject', () => {
  it('writes NOTHING for an income-bucketed row, the failure that destroyed a real category', async () => {
    // THE regression. A Venmo payback filed under income, tapped toward a
    // spending category. Wealthfolio refuses that assignment outright, and the
    // version without this gate found out from the 400 — AFTER it had already
    // deleted the income assignment, leaving a real user's transaction with no
    // category at all. Predicting the refusal is the only way the delete does
    // not happen: there is no endpoint that answers "would this be accepted".
    const h = setup({ categorized: [VENMO_INCOME] });
    const picker = await openRecatAtTxn(h);
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.republish).not.toHaveBeenCalled();
    // And the row really is untouched — still filed exactly where it was.
    expect(h.state.categorized[0].assignments).toEqual([
      { taxonomyId: INCOME_TAXONOMY_ID, categoryId: 'inc-reimb', categoryName: 'Reimbursements' },
    ]);
    const refusal = lastCall(h.ui.edit);
    expect(refusal[0]).toBe(REFUSED_INCOME_TEXT);
    expect(labels(keyboardOf(refusal))).toEqual(['« Back', 'Done']);
  });

  it('leaves the reader somewhere they can act — « Back returns to the row', async () => {
    const h = setup({ categorized: [VENMO_INCOME] });
    const picker = await openRecatAtTxn(h);
    await h.tap(dataFor(picker, 'Entertainment'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), '« Back'));
    expect(lastCall(h.ui.edit)[0]).toBe(
      'VENMO PAYMENT a\n$24 · Aug 9 · Citi Double Cash\nCurrently: Reimbursements',
    );
  });

  it('says NEUTRAL for a bare credit, not that it can only take an income category', async () => {
    // A CASH CREDIT with no refund subtype is `Ignored` upstream: NO taxonomy is
    // assignable to it, so telling its reader it "can only take an income
    // category" would be false — they would go and file it as income and be
    // refused again.
    const h = setup({ categorized: [BARE_CREDIT] });
    const picker = await openRecatAtTxn(h);
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.republish).not.toHaveBeenCalled();
    const refusal = lastCall(h.ui.edit);
    // A CASH credit IS the row a refund subtype lifts, so this one keeps the
    // reimbursement line — the account-type cases below do not.
    expect(refusal[0]).toBe(REFUSED_NEUTRAL_SUBTYPE_TEXT);
    expect(refusal[0]).not.toContain('can only take an income category');
    expect(labels(keyboardOf(refusal))).toEqual(['« Back', 'Done']);
  });

  it('offers NO reimbursement route when the account type is what refuses the row', async () => {
    // `neutral` is much wider than "a credit not yet marked a refund": it is also
    // every activity on an account type outside CASH/CREDIT_CARD, and every row
    // whose account type could not be resolved at all (the native reader hands
    // over `''`). No subtype moves any of those, so naming the reimbursement rule
    // would cost its reader a trip to a settings screen and change nothing —
    // exactly the reasoning that keeps the hint off the `scope` refusal.
    for (const accountType of ['SECURITIES', 'SOMETHING_NEW', '']) {
      const h = setup({ categorized: [catRow('a', [incomeAt('inc-reimb', 'Reimbursements')], { accountType })] });
      const picker = await openRecatAtTxn(h);
      await h.tap(dataFor(picker, 'Entertainment'));
      expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
      expect(h.deps.assign).not.toHaveBeenCalled();
      expect(h.deps.republish).not.toHaveBeenCalled();
      const refusal = lastCall(h.ui.edit);
      expect(refusal[0]).toBe(REFUSED_NEUTRAL_TEXT);
      expect(refusal[0]).not.toContain('reimbursement');
      expect(refusal[0]).not.toContain('Transaction Rules');
      expect(labels(keyboardOf(refusal))).toEqual(['« Back', 'Done']);
    }
  });

  it('never pastes Wealthfolio\'s own API sentence into either refusal', async () => {
    // The 400 the user actually saw reported this verbatim. It names internal
    // enum labels and reads as a developer's error, and the neutral one
    // ("Neutral transfers cannot be categorized") describes an internal transfer
    // the row is not.
    const expected = [REFUSED_INCOME_TEXT, REFUSED_NEUTRAL_SUBTYPE_TEXT];
    for (const [i, fixture] of [VENMO_INCOME, BARE_CREDIT].entries()) {
      const h = setup({ categorized: [fixture] });
      const picker = await openRecatAtTxn(h);
      await h.tap(dataFor(picker, 'Entertainment'));
      const text = lastCall(h.ui.edit)[0];
      // The positive anchor first: absences alone would also hold on the
      // CONFIRMATION screen, so this test has to know it is looking at a
      // refusal at all.
      expect(text).toBe(expected[i]);
      expect(text).not.toContain('Income activities can only use income categories');
      expect(text).not.toContain('Categories label the cash-flow bucket');
      expect(text).not.toContain('do not change it');
      expect(text).not.toContain('Neutral transfers cannot be categorized');
      expect(text).not.toContain('assignActivityCategory failed');
      expect(text).not.toContain('400');
    }
  });

  it('lets a CREDIT_CARD refund through untouched — its bucket is already spending', async () => {
    const h = setup({ categorized: [CARD_REFUND] });
    const refiled = await openRecatAtRefiled(h, 'AMZN REFUND c');
    expect(h.deps.unassignTaxonomy).toHaveBeenCalledWith('c', INCOME_TAXONOMY_ID);
    expect(h.deps.assign).toHaveBeenCalledWith('c', 'cat-fun');
    expect(h.deps.republish).toHaveBeenCalledTimes(1);
    expect(lastCall(h.ui.edit)[0]).toBe(
      'AMZN REFUND c: Reimbursements → Entertainment.\n'
      + 'This payment now offsets Entertainment instead of counting toward its previous category.\n'
      // A card CREDIT is in the spending bucket unconditionally, so the income
      // assignment this move cleared can never go back on it — see the undo
      // describe below. The move is fine; only the way back is not.
      + 'This transaction can no longer hold the category it had before the move, so there is no Undo.',
    );
    expect(labels(refiled)).toEqual(['Next transaction', 'Done']);
  });

  it('lets the SAME payback through once a rule has marked it a reimbursement', async () => {
    // The two fixtures differ only in activity type and subtype, which is the
    // whole point: the gate is about the row's bucket, and a rule is what moves
    // it. Same tap, same row, opposite outcome.
    const h = setup({ categorized: [VENMO_REIMBURSED] });
    await openRecatAtRefiled(h);
    expect(h.deps.unassignTaxonomy).toHaveBeenCalledWith('a', INCOME_TAXONOMY_ID);
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-fun');
    expect(lastCall(h.ui.edit)[0]).toContain('VENMO PAYMENT a: Reimbursements → Entertainment.');
  });

  it('adds no read of its own — the gate runs off the freshness sweep', async () => {
    // Zero new REST calls, and zero new database reads: the row the freshness
    // check just verified already carries the account type, activity type and
    // subtype the predicate needs.
    const h = setup({ categorized: [VENMO_INCOME] });
    const picker = await openRecatAtTxn(h);
    const mark = h.order.length;
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(h.order.slice(mark)).toEqual(['readCategorized', 'readCategories']);
  });
});

/**
 * Every test below moves a row ACROSS taxonomies, which Wealthfolio only accepts
 * when the row's own cash-flow bucket is already spending — so every fixture
 * here is a reimbursement-marked credit or a card row, never a plain CASH
 * `DEPOSIT`. That is not a convenience: these tests used to run on a `DEPOSIT`
 * carrying an income assignment, a state in which the real server rejects the
 * assign with a 400, and they passed only because the fake API accepted it. The
 * refusal that a `DEPOSIT` now gets is pinned in the gate's own describe above.
 */
describe('reassign — the cross-taxonomy move', () => {
  it('DELETES the income assignment and only then assigns the spending one', async () => {
    // THE ordering of this feature. The other order leaves a window in which the
    // row counts as income AND as a spending offset — a silent double count no
    // freshness check can see. This one leaves at worst an uncategorized row,
    // which /categorize offers back in a single tap.
    const h = setup({ categorized: [VENMO_REIMBURSED] });
    const refiled = await openRecatAtRefiled(h);
    expect(h.order).toEqual([
      'readCategorized', 'readCategories',          // the list
      'readCategorized', 'readCategories',          // the txn screen
      'readCategorized', 'readCategories',          // the tap's freshness re-read
      `unassignTaxonomy:${INCOME_TAXONOMY_ID}`,
      `assign:${SPENDING_TAXONOMY_ID}`,
      'readCategorized', 'readCategories',          // the confirmation's fresh sweep
    ]);
    expect(h.deps.unassignTaxonomy).toHaveBeenCalledWith('a', INCOME_TAXONOMY_ID);
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-fun');
    expect(h.deps.republish).toHaveBeenCalledTimes(1);
    expect(lastCall(h.ui.edit)[0]).toBe(
      'VENMO PAYMENT a: Reimbursements → Entertainment.\n'
      + 'This payment now offsets Entertainment instead of counting toward its previous category.\n'
      // No Undo on a cross-taxonomy move: the bucket that makes the move legal is
      // the one that refuses the assignment going back (see the undo describe).
      + 'This transaction can no longer hold the category it had before the move, so there is no Undo.',
    );
    expect(labels(refiled)).toEqual(['Next transaction', 'Done']);
  });

  it('clears EVERY non-spending taxonomy, not just the first', async () => {
    const h = setup({
      categorized: [catRow(
        'a',
        [incomeAt('inc-reimb', 'Reimbursements'), savingsAt('sav-goal', 'House Fund')],
        REIMBURSED,
      )],
    });
    await openRecatAtRefiled(h);
    expect(h.deps.unassignTaxonomy.mock.calls).toEqual([
      ['a', INCOME_TAXONOMY_ID],
      ['a', SAVINGS_TAXONOMY_ID],
    ]);
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-fun');
  });

  it('deletes nothing when the move stays inside the spending taxonomy', async () => {
    const h = setup({ categorized: [GROCERIES] });
    await openRecatAtRefiled(h, 'TRADER JOES b');
    expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
    expect(h.deps.assign).toHaveBeenCalledWith('b', 'cat-fun');
    // No offset warning: nothing stopped counting as income.
    expect(lastCall(h.ui.edit)[0]).toBe('TRADER JOES b: Restaurants → Entertainment.');
  });

  it('re-filing to the identical category writes nothing at all, and offers no Undo', async () => {
    const h = setup({ categorized: [catRow('a', [spendingAt('cat-fun', 'Entertainment')], REIMBURSED)] });
    const refiled = await openRecatAtRefiled(h);
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
    expect(h.deps.republish).not.toHaveBeenCalled();
    // Honest rather than clever: the confirmation still says where it sits.
    expect(lastCall(h.ui.edit)[0]).toBe('VENMO PAYMENT a: Entertainment → Entertainment.');
    // Nothing was written, so there is nothing to reverse — and an Undo that
    // rewrote the category the row already has would report a restore it did not
    // perform.
    expect(labels(refiled)).toEqual(['Next transaction', 'Done']);
  });

  it('still clears the income side when the spending category is already the tapped one', async () => {
    // The double-counted state itself: spending Entertainment AND income
    // Reimbursements at once. "Same category" is not a no-op here — the income
    // assignment is exactly what has to go.
    const h = setup({
      categorized: [catRow(
        'a',
        [incomeAt('inc-reimb', 'Reimbursements'), spendingAt('cat-fun', 'Entertainment')],
        REIMBURSED,
      )],
    });
    await openRecatAtRefiled(h);
    expect(h.deps.unassignTaxonomy).toHaveBeenCalledWith('a', INCOME_TAXONOMY_ID);
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(lastCall(h.ui.edit)[0]).toContain('now offsets Entertainment instead of counting toward its previous category');
  });

  it('writes NOTHING when the row\'s category changed between the render and the tap', async () => {
    // The freshness rule at its sharpest: the picker on screen describes a move
    // FROM Reimbursements, and that is no longer where the row is.
    const h = setup({ categorized: [VENMO_INCOME] });
    const picker = await openRecatAtTxn(h);
    h.state.categorized = [catRow('a', [spendingAt('cat-rest', 'Restaurants')])];
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
    expect(h.deps.unassign).not.toHaveBeenCalled();
    expect(h.deps.republish).not.toHaveBeenCalled();
    const declined = lastCall(h.ui.edit);
    expect(declined[0]).toBe(
      'That transaction changed elsewhere — leaving it as is.\n\nRecategorize — tap a transaction',
    );
    expect(labels(keyboardOf(declined))).toEqual([
      'Aug 9 · VENMO PAYMENT a · $24 · Restaurants',
      'Done',
    ]);
  });

  it('writes nothing when the row became uncategorized between the render and the tap', async () => {
    const h = setup({ categorized: [VENMO_INCOME] });
    const picker = await openRecatAtTxn(h);
    h.state.categorized = [];
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
    expect(lastCall(h.ui.edit)[0]).toContain('That transaction changed elsewhere — leaving it as is.');
  });

  it('reports a refused DELETE without touching the category', async () => {
    const h = setup({ categorized: [VENMO_REIMBURSED] });
    const picker = await openRecatAtTxn(h);
    h.deps.unassignTaxonomy.mockRejectedValue(new Error('403 Forbidden: token *expired*'));
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.republish).not.toHaveBeenCalled();
    const failure = lastCall(h.ui.edit);
    expect(failure[0]).toBe(
      'Couldn\'t move that — Wealthfolio said: 403 Forbidden: token \\*expired\\*'
      + '\n\nNothing changed — this transaction still has the category it had.',
    );
    expect(labels(keyboardOf(failure))).toEqual(['« Back', 'Done']);
    expect(h.logs.join('\n')).toContain('403 Forbidden');
  });

  it('says the new category was NOT set when the delete worked and the assign did not', async () => {
    // The one state the pinned ordering can leave behind, stated plainly rather
    // than discovered from a wrong budget figure later. A 500, not the bucket
    // 400 the gate now predicts: a server can still fail for its own reasons,
    // and the copy for that has to stay honest.
    const h = setup({ categorized: [VENMO_REIMBURSED] });
    const picker = await openRecatAtTxn(h);
    h.deps.assign.mockRejectedValue(new Error('500 Internal Server Error'));
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(h.deps.unassignTaxonomy).toHaveBeenCalledWith('a', INCOME_TAXONOMY_ID);
    const failure = lastCall(h.ui.edit);
    expect(failure[0]).toBe(
      'Couldn\'t move that — Wealthfolio said: 500 Internal Server Error'
      + '\n\nThe new category was NOT set, and the old one is already cleared — '
      + 'this transaction is uncategorized now, so /categorize will offer it.',
    );
    expect(failure[0]).not.toContain('Nothing changed');
  });

  it('leaves the row where /categorize can fix it in one tap after that failure', async () => {
    // The reason delete-then-assign is the safe order: the worst case is a row
    // with no category, which the other menu already exists to file.
    const h = setup({ rows: [], categorized: [VENMO_REIMBURSED] });
    const picker = await openRecatAtTxn(h);
    h.deps.assign.mockRejectedValue(new Error('500 Internal Server Error'));
    await h.tap(dataFor(picker, 'Entertainment'));
    await h.controller.open(h.send);
    expect(lastCall(h.send)[0]).toBe('1 transaction needs a category:');
    expect(labels(keyboardOf(lastCall(h.send)))).toEqual([
      'Aug 9 · VENMO PAYMENT a · $24',
      'Done',
    ]);
  });

  it('reports the truth when one of several deletes fails after another succeeded', async () => {
    const h = setup({
      categorized: [catRow(
        'a',
        [incomeAt('inc-reimb', 'Reimbursements'), savingsAt('sav-goal', 'House Fund')],
        REIMBURSED,
      )],
    });
    const picker = await openRecatAtTxn(h);
    h.deps.unassignTaxonomy.mockImplementation(async (_id: string, taxonomyId: string) => {
      if (taxonomyId === SAVINGS_TAXONOMY_ID) throw new Error('409 Conflict');
    });
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(lastCall(h.ui.edit)[0]).toBe(
      'Couldn\'t move that — Wealthfolio said: 409 Conflict'
      + '\n\nThe new category was NOT set. Some of the old assignments were already cleared — '
      + 'check this transaction in Wealthfolio.',
    );
  });

  it('renders an error screen when the freshness re-read itself fails', async () => {
    const h = setup({ categorized: [VENMO_INCOME] });
    const picker = await openRecatAtTxn(h);
    h.deps.readCategorized.mockImplementation(() => { throw new Error('db vanished'); });
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(lastCall(h.ui.edit)[0]).toBe('Couldn\'t look up your transactions — db vanished');
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
  });

  it('drills through subcategories in recategorize mode too', async () => {
    const h = setup({ categorized: [VENMO_REIMBURSED] });
    const picker = await openRecatAtTxn(h);
    await h.tap(dataFor(picker, 'Food & Dining'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Restaurants'));
    expect(h.deps.unassignTaxonomy).toHaveBeenCalledWith('a', INCOME_TAXONOMY_ID);
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-rest');
    expect(lastCall(h.ui.edit)[0]).toContain('VENMO PAYMENT a: Reimbursements → Restaurants.');
  });
});

/**
 * A restore writes in the OPPOSITE bucket direction from the move, so the two
 * halves are not legal or illegal together — which is the whole subject of this
 * describe. The move needs the row's bucket to be `spending`; putting an income
 * assignment back needs it to be `income`. A row cannot be both, so for a
 * CROSS-taxonomy move the way back is refused as long as the row stays what it
 * was when the move succeeded, and Undo is not offered at all
 * (docs/upstream-spending-buckets.md §1: the bucket check is skipped on unassign
 * and enforced on assign, so a replay would clear the new category and then 400).
 *
 * That leaves two shapes where an undo runs: a spending→spending move, whose
 * restore is as legal as the move was, and a cross-taxonomy move on a row that
 * has since gone back to being income-bucketed — see
 * `openRecatAtRefiledThenIncomeAgain`.
 */
describe('undoing a reassignment', () => {
  /**
   * The move on this release's headline row, then that row going back to a plain
   * CASH `DEPOSIT` underneath the menu — someone editing the activity in
   * Wealthfolio, or dropping the rule that typed it — which is the only state in
   * which restoring its income assignment is legal at all.
   *
   * Every render re-decides, so the re-render a stale tap forces is what brings
   * the Undo button back; the button is deliberately absent on the confirmation
   * itself, which this helper asserts on the way through.
   */
  async function openRecatAtRefiledThenIncomeAgain(h: ReturnType<typeof setup>) {
    const refiled = await openRecatAtRefiled(h);
    expect(labels(refiled)).not.toContain('Undo');
    const row = h.state.categorized.find((r) => r.activityId === 'a')!;
    row.activityType = 'DEPOSIT';
    row.subtype = '';
    await h.tap('cz:nope');
    return keyboardOf(lastCall(h.ui.edit));
  }

  it('withholds Undo, and says why, when the row can no longer hold what the move cleared', async () => {
    // CRITICAL. The four steps end to end: the rule backfills the payback to
    // CREDIT + REIMBURSEMENT, the move off its now-dangling income assignment is
    // legal and happens, and the way back is NOT — restoring `income_sources` on
    // a spending-bucketed row is a 400, which would arrive after the delete had
    // already removed the category the user just chose. The button that would do
    // that is not offered, and the screen states the limitation rather than
    // quietly losing a button the reader saw last time.
    const h = setup({ categorized: [catRow('a', [wfIncomeAt('inc-reimb', 'Reimbursements')], REIMBURSED)] });
    const refiled = await openRecatAtRefiled(h);
    // The move itself still ran — this is not the gate over-refusing.
    expect(h.deps.unassignTaxonomy).toHaveBeenCalledWith('a', WF_INCOME_TAXONOMY_ID);
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-fun');
    expect(labels(refiled)).toEqual(['Next transaction', 'Done']);
    expect(lastCall(h.ui.edit)[0]).toBe(
      'VENMO PAYMENT a: Reimbursements → Entertainment.\n'
      + 'This payment now offsets Entertainment instead of counting toward its previous category.\n'
      + 'This transaction can no longer hold the category it had before the move, so there is no Undo.',
    );
    // And the row is exactly where the move put it: one spending assignment,
    // nothing cleared afterwards by a restore that could not finish.
    expect(h.state.categorized[0].assignments).toEqual([
      { taxonomyId: SPENDING_TAXONOMY_ID, categoryId: 'cat-fun', categoryName: 'Entertainment' },
    ]);
  });

  it('withholds Undo when only SOME of the restore is legal, rather than putting back the legal part', async () => {
    // All legs or no button. This row was double counted — spending Entertainment
    // AND income Reimbursements — so the move cleared the income side and left the
    // spending one. Replaying just the spending assignment (the legal leg, and the
    // one the confirmation displays) would drop Reimbursements for good while
    // reporting the undo as done: the worst defect of the original build.
    const h = setup({
      categorized: [catRow(
        'a',
        [wfIncomeAt('inc-reimb', 'Reimbursements'), spendingAt('cat-fun', 'Entertainment')],
        REIMBURSED,
      )],
    });
    const refiled = await openRecatAtRefiled(h);
    expect(labels(refiled)).not.toContain('Undo');
    expect(lastCall(h.ui.edit)[0]).toContain(
      'This transaction can no longer hold the category it had before the move, so there is no Undo.',
    );
  });

  it('withholds Undo for a savings assignment, which no bucket this predicate can report ever accepts', async () => {
    // The savings taxonomy is only assignable to a `saving`-bucketed row, and that
    // bucket comes from a transfer-linkage path no column here can express
    // (docs/upstream-spending-buckets.md §2) — so a cleared savings assignment can
    // never be put back, whatever else happens to the row.
    const h = setup({
      categorized: [catRow(
        'a',
        [wfIncomeAt('inc-reimb', 'Reimbursements'), savingsAt('sav-goal', 'House Fund')],
        REIMBURSED,
      )],
    });
    const refiled = await openRecatAtRefiled(h);
    expect(h.deps.unassignTaxonomy.mock.calls).toEqual([
      ['a', WF_INCOME_TAXONOMY_ID],
      ['a', SAVINGS_TAXONOMY_ID],
    ]);
    expect(labels(refiled)).not.toContain('Undo');
  });

  it('writes NOTHING when a tap to undo arrives for a restore the row can no longer take', async () => {
    // The gate BEHIND the button, which exists because a tap can arrive without a
    // matching render: here the restore was legal when the confirmation was drawn
    // (spending → spending) and the row's subtype was then removed in Wealthfolio,
    // which drops it to the neutral bucket where no category is assignable at all.
    // The replay must not delete the category the move set and discover that after.
    const h = setup({ categorized: [catRow('b', [spendingAt('cat-rest', 'Restaurants')], REIMBURSED)] });
    const refiled = await openRecatAtRefiled(h, 'VENMO PAYMENT b');
    expect(labels(refiled)).toContain('Undo');
    const undo = dataFor(refiled, 'Undo');
    const row = h.state.categorized.find((r) => r.activityId === 'b')!;
    row.subtype = '';
    const mark = h.order.length;
    await h.tap(undo);
    // Not one write, of either kind — the delete included, since that is the half
    // that always succeeds.
    expect(h.order.slice(mark)).toEqual(['readCategorized', 'readCategories']);
    expect(lastCall(h.ui.edit)[0]).toContain('That transaction changed elsewhere — leaving it as is.');
    // The category the move set is untouched: the row is filed, not bare.
    expect(h.state.categorized[0].assignments).toEqual([
      { taxonomyId: SPENDING_TAXONOMY_ID, categoryId: 'cat-fun', categoryName: 'Entertainment' },
    ]);
    expect(h.logs.join('\n')).toContain('refusing to undo b');
  });

  it('puts an income category back where a plain unassign could not, once the row is income-bucketed again', async () => {
    // `unassign` restores "no spending category", which is NOT where this row
    // came from. Restoring an income assignment is a delete plus an assign under
    // the other taxonomy — and in that order, for the same reason as the move.
    const h = setup({ categorized: [catRow('a', [wfIncomeAt('inc-reimb', 'Reimbursements')], REIMBURSED)] });
    const refiled = await openRecatAtRefiledThenIncomeAgain(h);
    const mark = h.order.length;
    await h.tap(dataFor(refiled, 'Undo'));
    expect(h.order.slice(mark)).toEqual([
      'readCategorized', 'readCategories',
      `unassignTaxonomy:${SPENDING_TAXONOMY_ID}`,
      `assign:${WF_INCOME_TAXONOMY_ID}`,
      'readCategorized', 'readCategories',
    ]);
    expect(h.deps.assign).toHaveBeenLastCalledWith('a', 'inc-reimb', WF_INCOME_TAXONOMY_ID);
    expect(lastCall(h.ui.edit)[0]).toBe('Refiling undone — VENMO PAYMENT a is back under Reimbursements.');
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual(['Back to list', 'Done']);
    expect(h.state.categorized[0].assignments).toEqual([
      { taxonomyId: WF_INCOME_TAXONOMY_ID, categoryId: 'inc-reimb', categoryName: 'Reimbursements' },
    ]);
  });

  it('restores a spending category with one PUT and no delete', async () => {
    // The row had a spending assignment before the move, so the move replaced it
    // rather than adding one: replacing it back is a single PUT with no window in
    // which the row is uncategorized, and nothing to clear. Legal in both
    // directions, because both ends are the same taxonomy as the row's bucket.
    const h = setup({ categorized: [GROCERIES] });
    const refiled = await openRecatAtRefiled(h, 'TRADER JOES b');
    expect(labels(refiled)).toContain('Undo');
    await h.tap(dataFor(refiled, 'Undo'));
    expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
    // The replay always names the taxonomy it recorded, spending included — one
    // loop over the restore list, no special case to get wrong.
    expect(h.deps.assign).toHaveBeenLastCalledWith('b', 'cat-rest', SPENDING_TAXONOMY_ID);
    expect(lastCall(h.ui.edit)[0]).toBe('Refiling undone — TRADER JOES b is back under Restaurants.');
    expect(h.state.categorized[0].assignments).toEqual([
      { taxonomyId: SPENDING_TAXONOMY_ID, categoryId: 'cat-rest', categoryName: 'Restaurants' },
    ]);
  });

  it('declines when the row is no longer where this menu put it', async () => {
    const h = setup({ categorized: [GROCERIES] });
    const refiled = await openRecatAtRefiled(h, 'TRADER JOES b');
    // Something else moved it on again after the confirmation was drawn.
    h.state.categorized = [{ ...GROCERIES, assignments: [spendingAt('cat-rest', 'Restaurants')] }];
    const assignsBefore = h.deps.assign.mock.calls.length;
    await h.tap(dataFor(refiled, 'Undo'));
    expect(h.deps.assign.mock.calls.length).toBe(assignsBefore);
    expect(h.deps.unassignTaxonomy).not.toHaveBeenCalled();
    expect(lastCall(h.ui.edit)[0]).toBe(
      'That transaction changed elsewhere — leaving it as is.\n\nRecategorize — tap a transaction',
    );
  });

  it('declines when the row lost its category entirely', async () => {
    const h = setup({ categorized: [GROCERIES] });
    const refiled = await openRecatAtRefiled(h, 'TRADER JOES b');
    h.state.categorized = [];
    const assignsBefore = h.deps.assign.mock.calls.length;
    await h.tap(dataFor(refiled, 'Undo'));
    expect(h.deps.assign.mock.calls.length).toBe(assignsBefore);
    expect(lastCall(h.ui.edit)[0]).toContain('That transaction changed elsewhere — leaving it as is.');
  });

  it('reports a refused restore in UNDO\'s words, not the move\'s', async () => {
    // The move's copy says "the new category was NOT set, and the old one is
    // already cleared". On an undo both halves are the other way round: it is the
    // OLD category that failed to be set and the NEW one that is already gone.
    // Only the actionable half survives that swap, which is how inverted copy
    // ships unnoticed.
    //
    // The one shape that reaches this suffix at all: a restore whose spending
    // assignment has to be DELETED first, which only an income-bucketed row can
    // legally follow with a PUT. A 500, not the bucket 400 the gate predicts —
    // the server can still fail for its own reasons.
    const h = setup({ categorized: [catRow('a', [wfIncomeAt('inc-reimb', 'Reimbursements')], REIMBURSED)] });
    const refiled = await openRecatAtRefiledThenIncomeAgain(h);
    h.deps.assign.mockRejectedValue(new Error('500 Internal Server Error'));
    await h.tap(dataFor(refiled, 'Undo'));
    expect(lastCall(h.ui.edit)[0]).toBe(
      'Couldn\'t undo that — Wealthfolio said: 500 Internal Server Error'
      + '\n\nThe old category was NOT restored, and the one the move set is already cleared — '
      + 'this transaction is uncategorized now, so /categorize will offer it.',
    );
    expect(lastCall(h.ui.edit)[0]).not.toContain('The new category was NOT set');
    expect(h.logs.join('\n')).toContain('500 Internal Server Error');
  });

  it('says nothing was restored when the first write of the undo is refused', async () => {
    const h = setup({ categorized: [catRow('a', [wfIncomeAt('inc-reimb', 'Reimbursements')], REIMBURSED)] });
    const refiled = await openRecatAtRefiledThenIncomeAgain(h);
    h.deps.unassignTaxonomy.mockRejectedValue(new Error('403 Forbidden'));
    // Captured BEFORE the tap: taken afterwards it could only ever equal itself.
    const assignsBefore = h.deps.assign.mock.calls.length;
    await h.tap(dataFor(refiled, 'Undo'));
    expect(lastCall(h.ui.edit)[0]).toBe(
      'Couldn\'t undo that — Wealthfolio said: 403 Forbidden'
      + '\n\nNothing was restored — this transaction is still under the category the move set.',
    );
    // And it really did stop: no PUT went out after the refused DELETE.
    expect(h.deps.assign.mock.calls.length).toBe(assignsBefore);
  });

  it('offers no Undo at all when the move wrote nothing', async () => {
    const h = setup({ categorized: [catRow('a', [spendingAt('cat-fun', 'Entertainment')], REIMBURSED)] });
    const refiled = await openRecatAtRefiled(h);
    expect(labels(refiled)).not.toContain('Undo');
    expect(h.state.categorized[0].assignments).toEqual([
      { taxonomyId: SPENDING_TAXONOMY_ID, categoryId: 'cat-fun', categoryName: 'Entertainment' },
    ]);
  });

  it('keeps offering the OLD category as the restore target after the refile', async () => {
    // The confirmation is rendered from a sweep in which the row already carries
    // its NEW category; the Undo button has to name the one it had BEFORE, or it
    // restores the state it was meant to reverse.
    const h = setup({ categorized: [GROCERIES] });
    await openRecatAtRefiled(h, 'TRADER JOES b');
    // A stale token forces a re-render of the same screen — the old category has
    // to survive that too.
    await h.tap('cz:nope');
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Undo'));
    expect(h.deps.assign).toHaveBeenLastCalledWith('b', 'cat-rest', SPENDING_TAXONOMY_ID);
  });
});
