import { describe, it, expect, vi } from 'vitest';
import { categoryFiledChange, importChange, stampChange, transferLinkChange } from '../../shared/change-entries';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import { emptySyncOverrides } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { parseTxQuery } from '../../shared/tx-search';
import {
  TX_FACT_NOTES, TX_STORY_ASK_TELEGRAM, TX_STORY_NOT_FILED, TX_STORY_SET_IN_WEALTHFOLIO, TX_STORY_SPENDING,
} from '../../shared/tx-story';
import { appTxSearch, appTxStory, type StoryStore } from './tx-story';

const NOW = new Date('2026-10-13T16:00:00Z');
const KEY = accountTxKey('ACT-chk', 'TRN-1');

/** `activities.search` rows as the SDK hands them back (`ActivityDetails`). */
const detail = (over: Record<string, unknown> = {}) => ({
  id: 'act-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'WITHDRAWAL',
  date: '2026-10-04T04:00:00.000Z', amount: '54.20', comment: 'KROGER #415 · TRN-1', ...over,
});

function ctxWith(search: (...args: any[]) => any) {
  return {
    api: {
      activities: { search: vi.fn(search) },
      accounts: { getAll: vi.fn(async () => [
        { id: 'wf-chk', name: 'PNC Checking', accountType: 'CASH' },
        { id: 'wf-ally', name: 'Ally Savings', accountType: 'CASH' },
      ]) },
    },
  } as any;
}

const logOf = (...entries: ChangeLogItem[]): ChangeLogRead => ({ entries, gaps: [], trimmed: 0, unreadable: [] });
const imported = stampChange(importChange({
  account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: KEY, activityId: 'act-1',
  description: 'KROGER #415', amountCents: -5420, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date('2026-10-04T12:00:00Z'));

const store = (over: Partial<StoryStore> = {}): StoryStore => ({
  getAccountMapping: vi.fn(async () => ({ 'ACT-chk': 'wf-chk', 'ACT-ally': 'wf-ally' })),
  getChangeLog: vi.fn(async () => logOf(imported)),
  readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })),
  readSkippedTransactions: vi.fn(async () => ({ kind: 'ok' as const, list: [] })),
  getLinkedGroups: vi.fn(async () => ({})),
  getCompanionVersion: vi.fn(async () => '1.61.0'),
  getUncategorizedStatus: vi.fn(async () => null),
  getReportCube: vi.fn(async () => null),
  ...over,
});

const byId = (rows: any[]) => async (_p: number, _s: number, filters: any) =>
  ({ data: rows.filter((r) => r.id === filters.activityIds?.[0]), meta: { totalRowCount: 1 } });

describe('appTxStory', () => {
  it('reads the row by its id and tells what the add-on can see, pointing at Telegram for the filer', async () => {
    const ctx = ctxWith(byId([detail()]));
    const out = await appTxStory(ctx, store(), { activityId: 'act-1' }, NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledWith(0, 1, { activityIds: ['act-1'] }, '');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.story.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(out.story.answer).toEqual(['From your PNC Checking bank feed.', TX_STORY_SPENDING, TX_STORY_ASK_TELEGRAM]);
    expect(out.story.history).toEqual([{ entryId: imported.id, line: 'Oct 4 · Imported KROGER #415' }]);
    expect(out.entries).toEqual([imported]);
  });

  it('without a companion says the category was set in Wealthfolio', async () => {
    const out = await appTxStory(ctxWith(byId([detail()])), store({ getCompanionVersion: vi.fn(async () => null) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe(TX_STORY_SET_IN_WEALTHFOLIO);
  });

  it('a drill-down row brings its category and who filed it; "you" takes its day from the log', async () => {
    const filed = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-1', description: 'KROGER #415', before: null, after: { categoryId: 'cat-gro', categoryName: 'Groceries' },
    }), 'companion', new Date('2026-10-05T12:00:00Z'));
    const out = await appTxStory(ctxWith(byId([detail()])), store({ getChangeLog: vi.fn(async () => logOf(imported, filed)) }),
      { activityId: 'act-1', categoryName: 'Food', filer: 'y' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe('Filed under Food by you, in Telegram, Oct 5.');
  });

  it('finds the filer in the report cube when the row is in its drill-down', async () => {
    const cube = { drill: { Groceries: [{ d: '2026-10-04', n: 'KROGER #415', c: 5420, a: 'PNC Checking', i: 'act-1', f: 'r:KROGER' }] } };
    const out = await appTxStory(ctxWith(byId([detail()])), store({ getReportCube: vi.fn(async () => cube as any) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe("Filed under Groceries by a rule — 'KROGER' matches it.");
  });

  it('says a row on the companion’s needs-a-category list is not filed yet', async () => {
    const status = { count: 1, asOf: '', rows: [{ activityId: 'act-1', description: 'KROGER', amountCents: 5420, date: '2026-10-04', accountName: 'PNC Checking' }] };
    const out = await appTxStory(ctxWith(byId([detail()])), store({ getUncategorizedStatus: vi.fn(async () => status as any) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe(TX_STORY_NOT_FILED);
  });

  it('names the other half of a transfer from the change log’s link', async () => {
    const link = stampChange(transferLinkChange(
      { account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: KEY, description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'o1', newActivityId: 'act-1' },
      { account: { sfinId: 'ACT-ally', wfId: 'wf-ally', name: 'Ally Savings' }, txKey: accountTxKey('ACT-ally', 'TRN-2'), description: 'FROM PNC', amountCents: 60000, date: '2026-10-04', oldActivityId: 'o2', newActivityId: 'act-2' },
    ), 'companion', new Date('2026-10-04T13:00:00Z'));
    const ctx = ctxWith(byId([detail({ activityType: 'TRANSFER_OUT', amount: '600', comment: 'TRANSFER TO ALLY · TRN-1' })]));
    const out = await appTxStory(ctx, store({ getChangeLog: vi.fn(async () => logOf(link)) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer.slice(0, 2)).toEqual(['From your PNC Checking bank feed.', 'Half of a transfer: ↔ $600.00 into Ally Savings.']);
  });

  it('or from the add-on’s own linked groups', async () => {
    const ctx = ctxWith(byId([detail({ activityType: 'TRANSFER_OUT', amount: '600', comment: 'TRANSFER TO ALLY · TRN-1' })]));
    const groups = { [KEY]: 'wf-transfer-1', [accountTxKey('ACT-ally', 'TRN-2')]: 'wf-transfer-1' };
    const out = await appTxStory(ctx, store({ getChangeLog: vi.fn(async () => logOf()), getLinkedGroups: vi.fn(async () => groups) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[1]).toBe('Half of a transfer: ↔ $600.00 into Ally Savings.');
  });

  it('is "gone" for a row that no longer exists and "unreachable" when the read fails', async () => {
    expect(await appTxStory(ctxWith(byId([])), store(), { activityId: 'act-1' }, NOW)).toEqual({ kind: 'gone' });
    expect(await appTxStory(ctxWith(async () => { throw new Error('down'); }), store(), { activityId: 'act-1' }, NOW)).toEqual({ kind: 'unreachable' });
  });

  const failing: Array<[string, Partial<StoryStore>, keyof typeof TX_FACT_NOTES]> = [
    ['the mapping', { getAccountMapping: vi.fn(async () => { throw new SyntaxError('bad JSON'); }) }, 'mapping'],
    ['the change log', { getChangeLog: vi.fn(async () => null) }, 'changeLog'],
    ['the overrides', { readSyncOverrides: vi.fn(async () => null) }, 'overrides'],
    ['an unreadable overrides document', { readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: true })) }, 'overridesUnreadable'],
    ['the skip list', { readSkippedTransactions: vi.fn(async () => { throw new Error('down'); }) }, 'skipList'],
    ['a corrupt skip list', { readSkippedTransactions: vi.fn(async () => ({ kind: 'corrupt' as const })) }, 'skipList'],
  ];
  it.each(failing)('a failed read of %s still tells the story, with a note', async (_what, over, fact) => {
    const out = await appTxStory(ctxWith(byId([detail()])), store(over), { activityId: 'act-1' }, NOW);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.story.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(out.story.notes).toEqual([TX_FACT_NOTES[fact]]);
  });

  it('a skipped transaction says so, and an absent skip list is none', async () => {
    const skipped = { readSkippedTransactions: vi.fn(async () => ({ kind: 'ok' as const, list: [{ account: 'ACT-chk', txId: 'TRN-1' }] })) };
    const out = await appTxStory(ctxWith(byId([detail()])), store(skipped), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer.join(' ')).toContain("don't import it");
    const none = await appTxStory(ctxWith(byId([detail()])), store({ readSkippedTransactions: vi.fn(async () => ({ kind: 'absent' as const })) }), { activityId: 'act-1' }, NOW);
    expect(none.kind === 'ok' && none.story.notes).toEqual([]);
  });

  const xfer = () => ctxWith(byId([detail({ activityType: 'TRANSFER_OUT', amount: '600', comment: 'TRANSFER TO ALLY · TRN-1' })]));
  const ground = (out: Awaited<ReturnType<typeof appTxStory>>) => (out.kind === 'ok' ? out.story : (null as never));

  it('a throwing or corrupt linked-groups ledger is a partner note, and a transfer with no partner has no "what it is" line', async () => {
    const out = ground(await appTxStory(xfer(), store({ getChangeLog: vi.fn(async () => logOf()), getLinkedGroups: vi.fn(async () => { throw new SyntaxError('bad JSON'); }) }), { activityId: 'act-1' }, NOW));
    expect(out.notes).toEqual([TX_FACT_NOTES.partner]);
    expect(out.answer).toEqual(['From your PNC Checking bank feed.']);
  });

  it('a transfer-typed row with no partner leaves "what it is" out, with no note when the ledger reads fine', async () => {
    const out = ground(await appTxStory(xfer(), store({ getChangeLog: vi.fn(async () => logOf()) }), { activityId: 'act-1' }, NOW));
    expect(out.notes).toEqual([]);
    expect(out.answer.some((l) => l.includes('transfer') || l === TX_STORY_SPENDING)).toBe(false);
  });

  it('a missing linked-groups method is not a failure', async () => {
    const { getLinkedGroups: _g, ...rest } = store({ getChangeLog: vi.fn(async () => logOf()) });
    expect(ground(await appTxStory(xfer(), rest, { activityId: 'act-1' }, NOW)).notes).toEqual([]);
  });

  it.each([
    ['the report cube', { getReportCube: vi.fn(async () => { throw new Error('down'); }) }],
    ['the needs-a-category list', { getUncategorizedStatus: vi.fn(async () => { throw new Error('down'); }) }],
  ])('a throwing read of %s is a category note', async (_what, over) => {
    const out = ground(await appTxStory(ctxWith(byId([detail()])), store(over), { activityId: 'act-1' }, NOW));
    expect(out.notes).toEqual([TX_FACT_NOTES.category]);
  });

  it('a companion-version read that throws gives neither filer line; a resolved null says Wealthfolio', async () => {
    const out = ground(await appTxStory(ctxWith(byId([detail()])), store({ getCompanionVersion: vi.fn(async () => { throw new Error('down'); }) }), { activityId: 'act-1' }, NOW));
    expect(out.answer).toEqual(['From your PNC Checking bank feed.', TX_STORY_SPENDING]);
    expect(out.notes).toEqual([]);
  });

  it('a missing mapping method leaves the feed line out, with no note', async () => {
    const { getAccountMapping: _m, ...rest } = store();
    const out = ground(await appTxStory(ctxWith(byId([detail()])), rest, { activityId: 'act-1' }, NOW));
    expect(out.notes).toEqual([]);
    expect(out.answer.join(' ')).not.toContain('Not from your bank feed');
    expect(out.answer.join(' ')).not.toContain('bank feed.');
  });

  it('a failed accounts read is a mapping note', async () => {
    const ctx = ctxWith(byId([detail()]));
    ctx.api.accounts.getAll = vi.fn(async () => { throw new Error('down'); });
    expect(ground(await appTxStory(ctx, store(), { activityId: 'act-1' }, NOW)).notes).toEqual([TX_FACT_NOTES.mapping]);
  });

  it('an older store without the newer reads still tells the story', async () => {
    const out = await appTxStory(ctxWith(byId([detail()])), { getAccountMapping: vi.fn(async () => ({ 'ACT-chk': 'wf-chk' })) }, { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.notes).toEqual([]);
  });
});

describe('appTxSearch', () => {
  it('asks Wealthfolio for the word no account name contains, then matches every word here', async () => {
    const rows = [detail(), detail({ id: 'act-2', comment: 'KROGER FUEL · TRN-2', accountName: 'Ally Savings' })];
    const ctx = ctxWith(async () => ({ data: rows, meta: { totalRowCount: 2 } }));
    const out = await appTxSearch(ctx, parseTxQuery('pnc kroger'), NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledWith(0, 500, {}, 'kroger', { id: 'date', desc: true });
    expect(out).toEqual({
      kind: 'ok',
      result: { rows: [{ activityId: 'act-1', date: '2026-10-04', description: 'KROGER #415', amountCents: -5420, accountName: 'PNC Checking' }], truncated: false },
    });
  });

  it('searches by amount alone over the last 12 months, newest first, stopping at older rows', async () => {
    const page0 = [detail(), detail({ id: 'old', date: '2025-09-01T04:00:00.000Z' })];
    const ctx = ctxWith(async () => ({ data: page0, meta: { totalRowCount: 2 } }));
    const out = await appTxSearch(ctx, parseTxQuery('54.20'), NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledTimes(1);
    expect(ctx.api.activities.search).toHaveBeenCalledWith(0, 500, {}, '', { id: 'date', desc: true });
    expect(out.kind === 'ok' && out.result.rows.map((r) => r.activityId)).toEqual(['act-1']);
  });

  it('pages until a short page', async () => {
    const full = Array.from({ length: 500 }, (_, i) => detail({ id: `p${i}`, comment: 'TARGET · TRN-x' }));
    const ctx = ctxWith(async (page: number) => ({ data: page === 0 ? full : [detail()], meta: { totalRowCount: 501 } }));
    const out = await appTxSearch(ctx, parseTxQuery('kroger'), NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledTimes(2);
    expect(out.kind === 'ok' && out.result.rows.map((r) => r.activityId)).toEqual(['act-1']);
  });

  it('says there may be more when it runs out of pages while pages are still full', async () => {
    const full = Array.from({ length: 500 }, (_, i) => detail({ id: `p${i}`, comment: 'TARGET · TRN-x' }));
    const ctx = ctxWith(async () => ({ data: full, meta: { totalRowCount: 99999 } }));
    const out = await appTxSearch(ctx, parseTxQuery('kroger'), NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledTimes(10);
    expect(out.kind === 'ok' && out.result).toEqual({ rows: [], truncated: true });
  });

  it('stops early past 40 matches and says there were more', async () => {
    const full = Array.from({ length: 500 }, (_, i) => detail({ id: `k${i}`, comment: 'KROGER · TRN-x' }));
    const ctx = ctxWith(async () => ({ data: full, meta: { totalRowCount: 99999 } }));
    const out = await appTxSearch(ctx, parseTxQuery('kroger'), NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledTimes(1);
    expect(out.kind === 'ok' && out.result.truncated).toBe(true);
    expect(out.kind === 'ok' && out.result.rows).toHaveLength(40);
  });

  it('is unreachable when Wealthfolio cannot be read', async () => {
    expect(await appTxSearch(ctxWith(async () => { throw new Error('down'); }), parseTxQuery('kroger'), NOW)).toEqual({ kind: 'unreachable' });
  });
});
