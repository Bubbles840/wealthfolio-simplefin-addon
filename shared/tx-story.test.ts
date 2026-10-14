import { describe, it, expect } from 'vitest';
import {
  amazonLabelChange, bankUpdateChange, categoryFiledChange, importChange, openingBalanceFiledChange, stampChange,
  transferLinkChange, transferTypeChange, type ChangeDraft,
} from './change-entries';
import type { ChangeLogItem } from './change-log';
import { OPENING_BALANCES_CATEGORY } from './sync-core';
import {
  buildTxStory, decodeFiler, encodeFiler, inferFilingRule, resolveFiler, ruleMatchesRow, signedCents, splitAmazonLabel,
  TX_FACT_NOTES, TX_STORY_ASK_TELEGRAM, TX_STORY_MONEY_IN, TX_STORY_NOT_FILED, TX_STORY_NOT_FROM_FEED,
  TX_STORY_SET_IN_WEALTHFOLIO, TX_STORY_SPENDING, withFilingDay, type CategoryRuleLike, type TxFactName,
  type TxStoryFacts, type TxStoryRow,
} from './tx-story';

const CHECKING = { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' };
const ALLY = { sfinId: 'ACT-ally', wfId: 'wf-ally', name: 'Ally Savings' };
/** Midday UTC: the same calendar day in every US zone. */
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12, 0));
const item = (draft: ChangeDraft, day: number, writer: 'addon' | 'companion' = 'companion'): ChangeLogItem => stampChange(draft, writer, at(day));

const row = (over: Partial<TxStoryRow> = {}): TxStoryRow => ({
  activityId: 'act-1', note: 'KROGER #415 · TRN-1', absCents: 5420, date: '2026-10-04',
  activityType: 'WITHDRAWAL', accountName: 'PNC Checking', accountType: 'CASH', ...over,
});
// A fixed clock, so "Oct 4" never turns into "Oct 4, 2026" when the year turns.
const NOW = new Date('2026-10-13T12:00:00Z');
const story = (over: Partial<TxStoryFacts> = {}) => buildTxStory({ now: NOW, row: row(), feed: { sfinAccountId: 'ACT-chk' }, partner: null, history: [], ...over });

describe('buildTxStory — one fixture per row kind', () => {
  it('a bank import: the feed, spending, the rule that filed it, its history', () => {
    const imp = item(importChange({
      account: CHECKING, txKey: 'k1', activityId: 'act-1', description: 'KROGER #415', amountCents: -5420, date: '2026-10-04',
      pending: false, activityType: 'WITHDRAWAL',
    }), 4);
    const s = story({ category: { name: 'Groceries', filer: { kind: 'rule', pattern: 'KROGER' } }, history: [imp] });
    expect(s).toEqual({
      title: 'KROGER #415 · -$54.20 · Oct 4',
      accountLine: 'PNC Checking',
      answer: [
        'From your PNC Checking bank feed.',
        TX_STORY_SPENDING,
        "Filed under Groceries by a rule — 'KROGER' matches it.",
      ],
      history: [{ entryId: imp.id, line: 'Oct 4 · Imported KROGER #415' }],
      notes: [],
    });
  });

  it('a pending row says so', () => {
    expect(story({ row: row({ note: 'KROGER #415 · TRN-1 · pending' }) }).answer[0]).toBe('From your PNC Checking bank feed. Still pending.');
  });

  it('a pending row that posted under a new transaction id keeps its pending history, oldest first', () => {
    const imp = item(importChange({
      account: CHECKING, txKey: 'k-old', activityId: 'act-1', description: 'KROGER #415', amountCents: -5420, date: '2026-10-03',
      pending: true, activityType: 'WITHDRAWAL',
    }), 3);
    // The posted row has its own activity id: only the old key ties it to the pending import.
    const upd = item(bankUpdateChange({
      account: CHECKING, txKey: 'k-new', activityId: 'act-2', description: 'KROGER #415', amountCents: -5420,
      before: { absCents: 5420, date: '2026-10-03', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 5420, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL' }, previousTxKey: 'k-old',
    }), 5);
    const s = story({ row: row({ activityId: 'act-2' }), history: [upd, imp] });
    expect(s.answer[0]).toBe('From your PNC Checking bank feed.');
    expect(s.history!.map((h) => h.line)).toEqual([
      'Oct 3 · Imported KROGER #415 (pending)',
      'Oct 5 · Updated KROGER #415 from the bank: Oct 3 → Oct 4, posted',
    ]);
  });

  it('a linked transfer names the other account and day, and asks for no category', () => {
    const lnk = item(transferLinkChange(
      { account: CHECKING, txKey: 'k-out', description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'o1', newActivityId: 'act-1' },
      { account: ALLY, txKey: 'k-in', description: 'TRANSFER FROM PNC', amountCents: 60000, date: '2026-10-04', oldActivityId: 'o2', newActivityId: 'act-2' },
    ), 4);
    const s = story({
      row: row({ note: 'TRANSFER TO ALLY · TRN-9', absCents: 60000, activityType: 'TRANSFER_OUT' }),
      partner: { accountName: 'Ally Savings', date: '2026-10-04' }, category: null, history: [lnk],
    });
    expect(s.answer).toEqual(['From your PNC Checking bank feed.', 'Half of a transfer: $600.00 into Ally Savings, Oct 4.']);
    const incoming = story({
      row: row({ note: 'TRANSFER FROM PNC · TRN-8', absCents: 60000, activityType: 'TRANSFER_IN', accountName: 'Ally Savings' }),
      partner: { accountName: 'PNC Checking' }, category: null,
    });
    expect(incoming.answer[1]).toBe('Half of a transfer: $600.00 from PNC Checking.');
  });

  it('a held transfer says how long it waits and what it becomes', () => {
    const held = item(transferTypeChange({
      account: CHECKING, txKey: 'k1', activityId: 'act-1', description: 'ONLINE TRANSFER TO ALLY', amountCents: -60000,
      date: '2026-10-04', activityType: 'TRANSFER_OUT', previousType: null, held: true,
    }), 4);
    const s = story({
      row: row({ note: '↔️ In-transit transfer · ONLINE TRANSFER TO ALLY · TRN-9', absCents: 60000, activityType: 'TRANSFER_OUT' }),
      category: null, history: [held],
    });
    expect(s.title).toBe('ONLINE TRANSFER TO ALLY · -$600.00 · Oct 4');
    expect(s.answer).toEqual(['A transfer the sync is holding: it waits until Oct 14 for its other half, then counts as spending.']);
    const inflow = story({
      row: row({ note: '↔️ In-transit transfer · FROM PNC · TRN-8', absCents: 60000, activityType: 'TRANSFER_IN' }), category: null,
    });
    expect(inflow.answer).toEqual(['A transfer the sync is holding: it waits until Oct 14 for its other half, then counts as money in.']);
  });

  it('a starting balance, filed by the add-on so it is not spending', () => {
    const filed = item(openingBalanceFiledChange({
      account: CHECKING, activityId: 'act-1', amountCents: -23540, date: '2026-05-01',
      category: { categoryId: 'cat-open', categoryName: 'Opening balances' },
    }), 5);
    const s = story({
      row: row({ note: 'Starting balance · ACT-chk', absCents: 23540, date: '2026-05-01', accountType: 'CREDIT_CARD' }),
      category: { name: 'Opening balances', filer: { kind: 'opening' } }, history: [filed],
    });
    expect(s.title).toBe('Starting balance · -$235.40 · May 1');
    expect(s.answer).toEqual([
      'The starting balance the add-on set so PNC Checking matches the bank from May 1.',
      "Filed under Opening balances by the add-on — an opening balance isn't spending.",
    ]);
  });

  it('a correction names the day it was added', () => {
    const s = story({ row: row({ note: 'Balance adjustment · ACT-chk · 2026-10-02', absCents: 1522, activityType: 'DEPOSIT', date: '2026-10-02' }), category: null });
    expect(s.title).toBe('Balance adjustment · $15.22 · Oct 2');
    expect(s.answer).toEqual(['A correction the add-on added on Oct 2 so PNC Checking matches the bank.']);
  });

  it('a row with no transaction id, or in an account the add-on does not sync, is not from the bank', () => {
    expect(story({ row: row({ note: 'Rent for October' }) }).answer[0]).toBe(TX_STORY_NOT_FROM_FEED);
    expect(story({ feed: null }).answer[0]).toBe(TX_STORY_NOT_FROM_FEED);
  });

  it('a transaction older than 90 days has no history to show', () => {
    expect(story({ row: row({ date: '2026-03-01' }), history: [] }).history).toEqual([]);
  });

  it('says spending or money in only for cash activity; a trade gets no "what it is" line', () => {
    for (const activityType of ['BUY', 'SELL', 'SPLIT', 'ADJUSTMENT']) {
      const s = story({ row: row({ note: 'AAPL · TRN-1', activityType }), category: null });
      expect(s.answer).toEqual(['From your PNC Checking bank feed.']);
    }
    for (const activityType of ['DEPOSIT', 'CREDIT', 'INTEREST', 'DIVIDEND']) expect(story({ row: row({ activityType }) }).answer[1]).toBe(TX_STORY_MONEY_IN);
    for (const activityType of ['WITHDRAWAL', 'FEE', 'TAX']) expect(story({ row: row({ activityType }) }).answer[1]).toBe(TX_STORY_SPENDING);
  });

  it('money in on a card, and interest a card charged', () => {
    expect(story({ row: row({ activityType: 'CREDIT', accountType: 'CREDIT_CARD' }) }).answer[1]).toBe(TX_STORY_MONEY_IN);
    expect(story({ row: row({ activityType: 'INTEREST', accountType: 'CREDIT_CARD' }) }).title).toContain('-$54.20');
    expect(story({ row: row({ activityType: 'INTEREST', accountType: 'CASH' }) }).title).toContain('$54.20');
  });
});

describe('buildTxStory — the category line', () => {
  it('words each filer', () => {
    const line = (filer: Parameters<typeof encodeFiler>[0]) => story({ category: { name: 'Groceries', filer } }).answer[2];
    expect(line({ kind: 'rule', pattern: null })).toBe('Filed under Groceries by a rule (none of your current rules matches it).');
    expect(line({ kind: 'rule', pattern: null, unknown: true })).toBe('Filed under Groceries by a rule.');
    expect(line({ kind: 'you', at: at(4).toISOString() })).toBe('Filed under Groceries by you, in Telegram, Oct 4.');
    expect(line({ kind: 'amazon', label: 'Lawn & Garden' })).toBe('Filed under Groceries from an Amazon email.');
    expect(line({ kind: 'hand' })).toBe('Filed under Groceries — set by hand.');
    expect(line(null)).toBe('Filed under Groceries.');
  });

  it('says an unfiled row is on the needs-a-category list', () => {
    expect(story({ category: null }).answer[2]).toBe(TX_STORY_NOT_FILED);
    expect(story({ category: undefined, needsCategory: true }).answer[2]).toBe(TX_STORY_NOT_FILED);
  });

  it('in the app, points at Telegram only when a companion exists', () => {
    expect(story({ category: undefined, filerHint: 'telegram' }).answer[2]).toBe(TX_STORY_ASK_TELEGRAM);
    expect(story({ category: undefined, filerHint: 'wealthfolio' }).answer[2]).toBe(TX_STORY_SET_IN_WEALTHFOLIO);
  });

  it('lists what you told the sync, the skip list included', () => {
    const s = story({ overrides: ['noAutoFile', 'notTransfer'], skipped: true });
    expect(s.answer.at(-1)).toBe("You told the sync: not a transfer, don't file it automatically, don't import it.");
  });
});

describe('buildTxStory — missing and failed facts', () => {
  it('leaves out each line whose fact is missing', () => {
    const s = buildTxStory({ now: NOW, row: row() });
    expect(s.answer).toEqual([TX_STORY_SPENDING]);
    expect(s.history).toBeNull();
    expect(s.notes).toEqual([]);
  });

  const each: TxFactName[] = ['mapping', 'partner', 'category', 'rules', 'changeLog', 'changeLogPartial', 'overrides', 'overridesUnreadable', 'skipList'];
  it.each(each)('a failed %s read still tells the story, with a note', (fact) => {
    const s = story({
      category: { name: 'Groceries', filer: { kind: 'hand' } }, overrides: ['noAutoFile'], skipped: true, failed: [fact],
    });
    const full = [
      'From your PNC Checking bank feed.',
      TX_STORY_SPENDING,
      'Filed under Groceries — set by hand.',
      "You told the sync: don't file it automatically, don't import it.",
    ];
    const expected = fact === 'mapping' ? full.slice(1)
      : fact === 'partner' ? full.filter((l) => l !== TX_STORY_SPENDING)
        : fact === 'category' ? full.filter((l) => !l.startsWith('Filed under'))
          : full;
    expect(s.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(s.answer).toEqual(expected);
    expect(s.notes).toEqual([TX_FACT_NOTES[fact]]);
    // Without the mapping, the row's keys are unknown: the overrides and the history go unchecked too.
    if (fact === 'mapping') {
      expect(s.notes).toEqual(["Couldn't read your account mapping just now, so where it came from, your overrides and its history may be incomplete."]);
    }
    if (fact === 'changeLog') expect(s.history).toBeNull();
    else expect(s.history).toEqual([]);
  });

  it('a change log read in part keeps what it read, says it may be missing changes, and never "No changes"', () => {
    const imp = item(importChange({
      account: CHECKING, txKey: 'k1', activityId: 'act-1', description: 'KROGER #415', amountCents: -5420, date: '2026-10-04',
      pending: false, activityType: 'WITHDRAWAL',
    }), 4);
    const kept = story({ history: [imp], failed: ['changeLogPartial'] });
    expect(kept.history).toEqual([{ entryId: imp.id, line: 'Oct 4 · Imported KROGER #415' }]);
    expect(kept.historyPartial).toBe(true);
    expect(kept.notes).toEqual(["Part of the change log can't be read, so this list may be missing changes."]);
    expect(story({ history: [], failed: ['changeLogPartial'] }).historyPartial).toBe(true);
    expect(story({ history: [] }).historyPartial).toBeUndefined();
  });

  it('all five things you told the sync, in order', () => {
    const s = story({ overrides: ['noAmazonLabel', 'keepDuplicate', 'noAutoFile', 'notTransfer'], skipped: true });
    expect(s.answer.at(-1)).toBe(
      "You told the sync: not a transfer, keep this duplicate, don't file it automatically, no Amazon label, don't import it.",
    );
  });

  it('a filing by you with no day says only "in Telegram"', () => {
    expect(story({ category: { name: 'Groceries', filer: { kind: 'you' } } }).answer[2]).toBe('Filed under Groceries by you, in Telegram.');
  });

  it('a transfer-typed row with no partner reads as spending or money in', () => {
    expect(story({ row: row({ activityType: 'TRANSFER_OUT' }), partner: null }).answer).toEqual(['From your PNC Checking bank feed.', TX_STORY_SPENDING]);
    expect(story({ row: row({ activityType: 'TRANSFER_IN' }), partner: null }).answer).toEqual(['From your PNC Checking bank feed.', TX_STORY_MONEY_IN]);
  });

  it('a pending mark on a row with no transaction id is still not from the bank', () => {
    expect(story({ row: row({ note: 'Rent for October · pending' }) }).answer[0]).toBe(TX_STORY_NOT_FROM_FEED);
  });

  it('keeps bank text raw — escaping is the renderer’s job', () => {
    const s = story({ row: row({ note: 'SQ *COFFEE_CLUB [2] · TRN-1', accountName: "Joe's *Visa*" }) });
    expect(s.title).toBe('SQ *COFFEE_CLUB [2] · -$54.20 · Oct 4');
    expect(s.accountLine).toBe("Joe's *Visa*");
  });
});

describe('rule inference', () => {
  const r = (over: Partial<CategoryRuleLike>): CategoryRuleLike => ({ id: 'r', pattern: 'KROGER', categoryId: 'cat-gro', priority: 0, ...over });
  const target = { note: 'KROGER #415 · TRN-1', activityType: 'WITHDRAWAL', accountId: 'wf-chk', absCents: 5420 };

  it('names the one rule that matches', () => {
    expect(inferFilingRule([r({ id: 'a' })], target, 'cat-gro')?.id).toBe('a');
  });

  it('of several, names the one Wealthfolio applies first: highest priority, then the earlier-listed', () => {
    const rules = [r({ id: 'low', priority: 10 }), r({ id: 'high-1', pattern: 'kroger #', priority: 50 }), r({ id: 'high-2', priority: 50 })];
    expect(inferFilingRule(rules, target, 'cat-gro')?.id).toBe('high-1');
  });

  it('none when no current rule would file it under this category', () => {
    expect(inferFilingRule([r({ categoryId: 'cat-din' }), r({ pattern: 'TARGET' })], target, 'cat-gro')).toBeNull();
  });

  it('follows Wealthfolio’s matcher: account scope, type, amount, match kind', () => {
    expect(ruleMatchesRow(r({ isGlobal: false, accountId: 'wf-other' }), target)).toBe(false);
    expect(ruleMatchesRow(r({ activityType: 'DEPOSIT' }), target)).toBe(false);
    expect(ruleMatchesRow(r({ amountOp: 'gt', amountValue: '100' }), target)).toBe(false);
    expect(ruleMatchesRow(r({ amountOp: 'between', amountValue: 50, amountValue2: '60' }), target)).toBe(true);
    expect(ruleMatchesRow(r({ matchType: 'starts_with', pattern: 'kroger' }), target)).toBe(true);
    expect(ruleMatchesRow(r({ matchType: 'exact' }), target)).toBe(false);
    expect(ruleMatchesRow(r({ matchType: 'regex', pattern: '^KROGER #\\d+' }), target)).toBe(true);
    expect(ruleMatchesRow(r({ matchType: 'regex', pattern: '(' }), target)).toBe(false);
  });
});

describe('resolveFiler', () => {
  const rowFor = (note = 'KROGER #415 · TRN-1') => ({ note, activityType: 'WITHDRAWAL', accountId: 'wf-chk', absCents: 5420 });
  const filedBy = (actor: 'you' | 'auto', day: number, categoryId = 'cat-gro', why?: string) => item(categoryFiledChange({
    actor, activityId: 'act-1', description: 'KROGER #415', before: null,
    after: { categoryId, categoryName: 'Groceries' }, ...(why ? { why } : {}),
  }), day);

  it('a rule’s filing names the inferred rule, or says none matches, or that rules were unreadable', () => {
    const rules = [{ id: 'a', pattern: 'KROGER', categoryId: 'cat-gro' }];
    expect(resolveFiler({ source: 'rule', categoryId: 'cat-gro', row: rowFor(), history: [], rules })).toEqual({ kind: 'rule', pattern: 'KROGER' });
    expect(resolveFiler({ source: 'RULE', categoryId: 'cat-din', row: rowFor(), history: [], rules })).toEqual({ kind: 'rule', pattern: null });
    expect(resolveFiler({ source: 'rule', categoryId: 'cat-gro', row: rowFor(), history: [], rules: null })).toEqual({ kind: 'rule', pattern: null, unknown: true });
  });

  it('a person’s filing is the newest log entry that set this category', () => {
    const history = [filedBy('auto', 2, 'cat-gro', 'Amazon: Grocery'), filedBy('you', 6)];
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history, rules: null }))
      .toEqual({ kind: 'you', at: at(6).toISOString() });
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history: [filedBy('auto', 2, 'cat-gro', 'Amazon: Grocery')], rules: null }))
      .toEqual({ kind: 'amazon', label: 'Grocery' });
  });

  it('skips a filing that was undone', () => {
    const mine = filedBy('you', 6);
    const undone = { ...mine, undone: { by: 'u1', at: at(7).toISOString() } };
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history: [filedBy('auto', 2, 'cat-gro', 'Amazon: Grocery'), undone], rules: null }))
      .toEqual({ kind: 'amazon', label: 'Grocery' });
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history: [undone], rules: null })).toEqual({ kind: 'hand' });
    // A cube "you" takes its day from a filing that stands, never an undone one.
    expect(withFilingDay({ kind: 'you' }, [filedBy('you', 4), undone])).toEqual({ kind: 'you', at: at(4).toISOString() });
  });

  it('falls back to the note’s Amazon label, then to "by hand", and to nothing when the log was unreadable', () => {
    const labelled = rowFor('AMAZON MKTPL*2K4 · Amazon: Lawn & Garden · TRN-1');
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: labelled, history: [], rules: null })).toEqual({ kind: 'amazon', label: 'Lawn & Garden' });
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history: [], rules: null })).toEqual({ kind: 'hand' });
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history: null, rules: null })).toBeNull();
  });

  it('an opening balance the companion filed', () => {
    const opening = item(openingBalanceFiledChange({
      account: CHECKING, activityId: 'act-1', amountCents: -100, date: '2026-05-01',
      category: { categoryId: 'cat-open', categoryName: 'Opening balances' },
    }), 3);
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-open', row: rowFor('Starting balance · ACT-chk'), history: [opening], rules: null }))
      .toEqual({ kind: 'opening' });
  });

  it('a starting balance with no filing in the log: the add-on’s when it is under Opening balances, else no filer', () => {
    const start = rowFor('Starting balance · ACT-card');
    const input = { source: 'manual', categoryId: 'cat-open', row: start, rules: null };
    expect(resolveFiler({ ...input, categoryName: OPENING_BALANCES_CATEGORY, history: [] })).toEqual({ kind: 'opening' });
    expect(resolveFiler({ ...input, categoryName: OPENING_BALANCES_CATEGORY, history: null })).toEqual({ kind: 'opening' });
    expect(resolveFiler({ ...input, categoryId: 'cat-gro', categoryName: 'Groceries', history: [] })).toBeNull();
    expect(resolveFiler({ ...input, history: [] })).toBeNull();
  });

  it('a cube "you" takes its day from the log', () => {
    expect(withFilingDay({ kind: 'you' }, [filedBy('you', 4)])).toEqual({ kind: 'you', at: at(4).toISOString() });
    expect(withFilingDay({ kind: 'you' }, [])).toEqual({ kind: 'you' });
    expect(withFilingDay({ kind: 'hand' }, [filedBy('you', 4)])).toEqual({ kind: 'hand' });
  });
});

describe('filer codes for the report cube', () => {
  it('round-trip, short', () => {
    const filers = [
      { kind: 'rule', pattern: 'KROGER' }, { kind: 'rule', pattern: null }, { kind: 'rule', pattern: null, unknown: true },
      { kind: 'you' }, { kind: 'amazon', label: 'Lawn & Garden' }, { kind: 'opening' }, { kind: 'hand' },
    ] as const;
    expect(filers.map((f) => encodeFiler(f))).toEqual(['r:KROGER', 'r', 'r?', 'y', 'a:Lawn & Garden', 'o', 'h']);
    for (const f of filers) expect(decodeFiler(encodeFiler(f))).toEqual(f);
  });

  it('decodes anything unknown, or nothing, as null', () => {
    expect(decodeFiler(undefined)).toBeNull();
    expect(decodeFiler('z')).toBeNull();
    expect(decodeFiler(7)).toBeNull();
    expect(encodeFiler(null)).toBeUndefined();
  });
});

describe('helpers', () => {
  it('splits the Amazon label off a description', () => {
    expect(splitAmazonLabel('AMAZON MKTPL*2K4 · Amazon: Lawn & Garden')).toEqual({ bare: 'AMAZON MKTPL*2K4', label: 'Lawn & Garden' });
    expect(splitAmazonLabel('KROGER')).toEqual({ bare: 'KROGER', label: null });
  });

  it('signs a row from its type', () => {
    expect(signedCents({ absCents: 100, activityType: 'WITHDRAWAL' })).toBe(-100);
    expect(signedCents({ absCents: 100, activityType: 'DEPOSIT' })).toBe(100);
    expect(signedCents({ absCents: 100, activityType: 'TRANSFER_OUT' })).toBe(-100);
  });

  it('an Amazon label change in the history reads as its summary', () => {
    const label = item(amazonLabelChange({
      account: CHECKING, txKey: 'k1', activityId: 'act-1', description: 'AMAZON MKTPL', amountCents: -5420, date: '2026-10-04',
      beforeNote: 'AMAZON MKTPL · TRN-1', afterNote: 'AMAZON MKTPL · Amazon: Toys · TRN-1', label: 'Toys',
    }), 5);
    expect(story({ history: [label] }).history).toEqual([{ entryId: label.id, line: 'Oct 5 · Added the Amazon label "Toys" to AMAZON MKTPL' }]);
  });
});

describe('buildTxStory — the title’s year', () => {
  it('adds the year only when the row is from another year', () => {
    const in2027 = new Date('2027-01-01T12:00:00Z');
    expect(story({ now: NOW, row: row({ date: '2026-10-04' }) }).title).toMatch(/ · Oct 4$/);
    expect(story({ now: in2027, row: row({ date: '2026-10-04' }) }).title).toMatch(/ · Oct 4, 2026$/);
    expect(story({ now: NOW, row: row({ date: '2024-10-04' }) }).title).toMatch(/ · Oct 4, 2024$/);
  });
});
