import { describe, it, expect, vi } from 'vitest';
import { categoryFiledChange, importChange, stampChange, transferLinkChange } from '../../shared/change-entries.js';
import type { ChangeLogRead } from '../../shared/change-log.js';
import { SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions.js';
import { OPENING_BALANCES_CATEGORY } from './opening-balance-category.js';
import { accountTxKey } from '../../shared/transfers.js';
import { TX_FACT_NOTES, TX_STORY_NO_HISTORY, TX_STORY_SPENDING } from '../../shared/tx-story.js';
import { parseTxQuery } from '../../shared/tx-search.js';
import { companionStoryReaders, companionTxSearch, companionTxStory, type StoryReaders } from './tx-story-host.js';
import { renderWhyStory } from './why-menu.js';
import type { ActivitySearchItem } from './wealthfolio.js';

const NOW = new Date('2026-10-13T16:00:00Z');
const KEY = accountTxKey('ACT-chk', 'TRN-1');

/** The REST row as `POST /activities/search` returns it (camelCase). */
const restRow = (over: Partial<ActivitySearchItem> = {}): ActivitySearchItem => ({
  id: 'act-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'WITHDRAWAL',
  date: '2026-10-04T04:00:00+00:00', amount: '54.20', comment: 'KROGER #415 · TRN-1', sourceGroupId: null, subtype: null, ...over,
});

const logOf = (...entries: ChangeLogRead['entries']): ChangeLogRead => ({ entries, gaps: [], trimmed: 0, unreadable: [] });
const imported = stampChange(importChange({
  account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: KEY, activityId: 'act-1',
  description: 'KROGER #415', amountCents: -5420, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date('2026-10-04T12:00:00Z'));
const filedByYou = stampChange(categoryFiledChange({
  actor: 'you', activityId: 'act-1', description: 'KROGER #415', before: null, after: { categoryId: 'cat-gro', categoryName: 'Groceries' },
}), 'companion', new Date('2026-10-05T12:00:00Z'));

function readers(over: Partial<StoryReaders> = {}, secrets: Record<string, string | null> = {}): StoryReaders {
  const stored: Record<string, string | null> = {
    account_mapping: JSON.stringify({ 'ACT-chk': 'wf-chk', 'ACT-ally': 'wf-ally' }),
    [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify({ v: 1, tx: { [KEY]: { noAutoFile: true, at: '2026-10-06T00:00:00Z' } }, accounts: {} }),
    [SKIPPED_TRANSACTIONS_SECRET_KEY]: null,
    ...secrets,
  };
  return {
    row: vi.fn(async (id: string) => (id === 'act-1' ? restRow() : null)),
    details: vi.fn(() => ({
      accountType: 'CASH',
      assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro', categoryName: 'Groceries', source: 'rule' }],
    })),
    partner: vi.fn(() => null),
    rules: vi.fn(async () => [{ id: 'r1', name: 'Kroger', pattern: 'KROGER', matchType: 'contains', categoryId: 'cat-gro', priority: 0 }]),
    changeLog: vi.fn(async () => logOf(imported)),
    secret: vi.fn(async (key: string) => stored[key] ?? null),
    searchRows: vi.fn(() => []),
    recentRows: vi.fn(async () => ({ rows: [], truncated: false })),
    ...over,
  };
}

describe('companionTxStory', () => {
  it('tells the whole story from REST, the database, the rules, the log and the settings', async () => {
    const out = await companionTxStory(readers(), 'act-1', NOW);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.story.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(out.story.answer).toEqual([
      'From your PNC Checking bank feed.',
      TX_STORY_SPENDING,
      "Filed under Groceries by a rule — 'KROGER' matches it.",
      "You told the sync: don't file it automatically.",
    ]);
    expect(out.story.history!.map((h) => h.entryId)).toEqual([imported.id]);
    expect(out.story.notes).toEqual([]);
  });

  it('finds the other half of a link by its group', async () => {
    const r = readers({
      row: vi.fn(async () => restRow({ activityType: 'TRANSFER_OUT', amount: '600', comment: 'TRANSFER TO ALLY · TRN-2', sourceGroupId: 'wf-transfer-9' })),
      details: vi.fn(() => ({ accountType: 'CASH', assignments: [] })),
      partner: vi.fn(() => ({ activityId: 'act-3', accountName: 'Ally Savings', date: '2026-10-06' })),
    });
    const out = await companionTxStory(r, 'act-1', NOW);
    expect(r.partner).toHaveBeenCalledWith('wf-transfer-9', 'act-1');
    expect(out.kind === 'ok' && out.story.answer[1]).toBe('Half of a transfer: ↔ $600.00 into Ally Savings, Oct 6.');
  });

  it('a person’s filing says "by you, in Telegram" with the day, and rules are not read', async () => {
    const r = readers({
      details: vi.fn(() => ({ accountType: 'CASH', assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro', categoryName: 'Groceries', source: 'manual' }] })),
      changeLog: vi.fn(async () => logOf(filedByYou, imported)),
    });
    const out = await companionTxStory(r, 'act-1', NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe('Filed under Groceries by you, in Telegram, Oct 5.');
    expect(r.rules).not.toHaveBeenCalled();
  });

  it('a card opening balance the companion filed over REST (never logged) is the add-on’s, not "set by hand"', async () => {
    const opening = (categoryName: string) => readers({
      row: vi.fn(async () => restRow({ accountId: 'wf-card', accountName: 'Citi Card', comment: 'Starting balance · ACT-card', amount: '464.60' })),
      details: vi.fn(() => ({
        accountType: 'CREDIT_CARD',
        assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-open', categoryName, source: 'manual' }],
      })),
      changeLog: vi.fn(async () => logOf()),
    });
    const filed = await companionTxStory(opening(OPENING_BALANCES_CATEGORY), 'act-1', NOW);
    expect(filed.kind === 'ok' && filed.story.answer).toEqual([
      'The starting balance the add-on set so Citi Card matches the bank from Oct 4.',
      "Filed under Opening balances by the add-on — an opening balance isn't spending.",
    ]);
    const moved = await companionTxStory(opening('Groceries'), 'act-1', NOW);
    expect(moved.kind === 'ok' && moved.story.answer.at(-1)).toBe('Filed under Groceries.');
  });

  describe('a row a transfer link re-created', () => {
    const lnk = stampChange(transferLinkChange(
      { account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: KEY, description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'act-old', newActivityId: 'act-1' },
      { account: { sfinId: 'ACT-ally', wfId: 'wf-ally', name: 'Ally Savings' }, txKey: accountTxKey('ACT-ally', 'TRN-2'), description: 'TRANSFER FROM PNC', amountCents: 60000, date: '2026-10-04', oldActivityId: 'act-old-2', newActivityId: 'act-2' },
    ), 'companion', new Date('2026-10-04T13:00:00Z'));

    it('a story by its old id follows the link to the row that stands for it now', async () => {
      const r = readers({ changeLog: vi.fn(async () => logOf(lnk, imported)) });
      const out = await companionTxStory(r, 'act-old', NOW);
      expect(out.kind).toBe('ok');
      if (out.kind !== 'ok') return;
      expect(r.row).toHaveBeenCalledWith('act-old');
      expect(r.row).toHaveBeenLastCalledWith('act-1');
      expect(out.movedTo).toBe('act-1');
      expect(out.facts.row.activityId).toBe('act-1');
      expect(out.story.title).toBe('KROGER #415 · -$54.20 · Oct 4');
      expect(out.story.history!.map((h) => h.entryId)).toEqual([imported.id, lnk.id]);
    });

    it('an undone link is not followed: the old id is gone', async () => {
      const undone = { ...lnk, undone: { by: 'u1', at: '2026-10-05T12:00:00Z' } };
      const r = readers({ changeLog: vi.fn(async () => logOf(undone, imported)) });
      expect(await companionTxStory(r, 'act-old', NOW)).toEqual({ kind: 'gone' });
    });

    it('a row found where it was carries no movedTo', async () => {
      const out = await companionTxStory(readers(), 'act-1', NOW);
      expect(out.kind === 'ok' && 'movedTo' in out).toBe(false);
    });
  });

  it('is "gone" when the row no longer exists, and "unreachable" when it cannot be read', async () => {
    expect(await companionTxStory(readers(), 'act-old', NOW)).toEqual({ kind: 'gone' });
    expect(await companionTxStory(readers({ row: vi.fn(async () => { throw new Error('502'); }) }), 'act-1', NOW)).toEqual({ kind: 'unreachable' });
  });

  const failing: Array<[string, Partial<StoryReaders>, Record<string, string | null>, keyof typeof TX_FACT_NOTES]> = [
    ['the category', { details: vi.fn(() => { throw new Error('locked'); }) }, {}, 'category'],
    ['the partner', { row: vi.fn(async () => restRow({ sourceGroupId: 'g1' })), partner: vi.fn(() => { throw new Error('locked'); }) }, {}, 'partner'],
    ['the rules', { rules: vi.fn(async () => { throw new Error('500'); }) }, {}, 'rules'],
    ['the change log', { changeLog: vi.fn(async () => { throw new Error('500'); }) }, {}, 'changeLog'],
    ['the mapping', {}, { account_mapping: '{not json' }, 'mapping'],
    ['the overrides', {}, { [SYNC_OVERRIDES_SECRET_KEY]: '{"v":9}' }, 'overridesUnreadable'],
  ];
  it.each(failing)('a failed read of %s still tells the story, with a note', async (_what, over, secrets, fact) => {
    const out = await companionTxStory(readers(over, secrets), 'act-1', NOW);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.story.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(out.story.notes).toEqual([TX_FACT_NOTES[fact]]);
  });

  it.each([
    ['an unreadable bucket', { unreadable: [{ writer: 'companion' as const, month: '2026-10', paused: false }] }],
    ['a gap in the log', { gaps: [{ at: '2026-10-05T12:00:00Z', count: 1, reason: "couldn't save the log", writer: 'companion' as const }] }],
  ])('%s that may hold the Telegram filing: no "set by hand", no "No changes…", and a note', async (_what, part) => {
    // The person's filing sat in the bucket that can't be read: the log as read has nothing about this row.
    const r = readers({
      details: vi.fn(() => ({ accountType: 'CASH', assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro', categoryName: 'Groceries', source: 'manual' }] })),
      changeLog: vi.fn(async () => ({ ...logOf(), ...part })),
    });
    const out = await companionTxStory(r, 'act-1', NOW);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.story.answer).toContain('Filed under Groceries.');
    expect(out.story.answer.join(' ')).not.toContain('set by hand');
    expect(out.story.history).toEqual([]);
    expect(out.story.notes).toEqual([TX_FACT_NOTES.changeLogPartial]);
    const text = renderWhyStory(out.story, 'act-1', { kind: 'none' }).text;
    expect(text).not.toContain(TX_STORY_NO_HISTORY);
    expect(text).toContain(TX_FACT_NOTES.changeLogPartial);
  });

  it('a change log read in part keeps the entries it could read', async () => {
    const r = readers({ changeLog: vi.fn(async () => ({ ...logOf(imported), unreadable: [{ writer: 'addon' as const, month: '2026-09', paused: false }] })) });
    const out = await companionTxStory(r, 'act-1', NOW);
    expect(out.kind === 'ok' && out.story.history!.map((h) => h.entryId)).toEqual([imported.id]);
    expect(out.kind === 'ok' && out.story.notes).toEqual([TX_FACT_NOTES.changeLogPartial]);
  });

  it('a secret read that fails reports the overrides and the skip list, never "none"', async () => {
    const r = readers({
      secret: vi.fn(async (key: string) => {
        if (key === 'account_mapping') return JSON.stringify({ 'ACT-chk': 'wf-chk' });
        throw new Error('timeout');
      }),
    });
    const out = await companionTxStory(r, 'act-1', NOW);
    expect(out.kind === 'ok' && out.story.notes).toEqual([TX_FACT_NOTES.overrides, TX_FACT_NOTES.skipList]);
  });

  it('a corrupt skip list is reported, never read as "none"; the rest of the answer is unchanged', async () => {
    const base = await companionTxStory(readers({}, { [SKIPPED_TRANSACTIONS_SECRET_KEY]: null }), 'act-1', NOW);
    for (const bad of ['{not json', '[{"account":1}]', '{"a":1}']) {
      const out = await companionTxStory(readers({}, { [SKIPPED_TRANSACTIONS_SECRET_KEY]: bad }), 'act-1', NOW);
      expect(out.kind === 'ok' && out.story.notes).toEqual([TX_FACT_NOTES.skipList]);
      expect(out.kind === 'ok' && base.kind === 'ok' && out.story.answer).toEqual(base.story.answer);
    }
  });

  it('a row on the skip list says so', async () => {
    const out = await companionTxStory(readers({}, {
      [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([{ account: 'ACT-chk', txId: 'TRN-1' }]),
      [SYNC_OVERRIDES_SECRET_KEY]: null,
    }), 'act-1', NOW);
    expect(out.kind === 'ok' && out.story.answer.at(-1)).toBe("You told the sync: don't import it.");
  });
});

describe('companionTxSearch', () => {
  const dbRow = (activityId: string, date: string, notes: string, absCents: number, activityType = 'WITHDRAWAL') => ({
    activityId, date, absCents, activityType, accountName: 'PNC Checking', accountType: 'CASH', notes,
  });

  it('searches all of history in the database', async () => {
    const r = readers({ searchRows: vi.fn(() => [dbRow('a1', '2024-01-02', 'KROGER #415 · TRN-1', 5420), dbRow('a2', '2026-10-01', 'TARGET · TRN-2', 5420)]) });
    const out = await companionTxSearch(r, parseTxQuery('54.20'), NOW);
    expect(out).toEqual({
      kind: 'ok', recentOnly: false,
      result: {
        rows: [
          { activityId: 'a2', date: '2026-10-01', description: 'TARGET', amountCents: -5420, accountName: 'PNC Checking' },
          { activityId: 'a1', date: '2024-01-02', description: 'KROGER #415', amountCents: -5420, accountName: 'PNC Checking' },
        ],
        truncated: false,
      },
    });
    expect(r.recentRows).not.toHaveBeenCalled();
  });

  it('falls back to the last 12 months over REST when the database cannot be read', async () => {
    const r = readers({
      searchRows: vi.fn(() => { throw new Error('no database'); }),
      recentRows: vi.fn(async () => ({ rows: [{ ...restRow(), accountType: 'CASH' }], truncated: false })),
    });
    const out = await companionTxSearch(r, parseTxQuery('kroger'), NOW);
    expect(r.recentRows).toHaveBeenCalledWith('2025-10-13');
    expect(out).toEqual({
      kind: 'ok', recentOnly: true,
      result: { rows: [{ activityId: 'act-1', date: '2026-10-04', description: 'KROGER #415', amountCents: -5420, accountName: 'PNC Checking' }], truncated: false },
    });
  });

  it('the REST fallback signs by account type, leaves archived accounts out and says when it is cut short', async () => {
    const searchActivities = vi.fn(async (body: { page: number }) =>
      Array.from({ length: 500 }, (_, i) => restRow({ id: `p${body.page}-${i}`, accountId: i === 0 ? 'wf-old' : 'wf-card', activityType: 'INTEREST', amount: '10', comment: 'PAYMENT' })));
    const client = {
      searchActivities, listCategorizationRules: vi.fn(async () => []),
      getAccounts: vi.fn(async () => [{ id: 'wf-card', accountType: 'CREDIT_CARD' }, { id: 'wf-old', accountType: 'CASH', isArchived: true }]),
      getAddonSecret: vi.fn(async () => null), setAddonSecret: vi.fn(async () => {}),
    };
    const r = companionStoryReaders(client, '/nope/wealthfolio.db');
    const recent = await r.recentRows('2025-10-13');
    expect(recent.truncated).toBe(true);
    expect(searchActivities).toHaveBeenCalledTimes(20);
    expect(recent.rows).toHaveLength(20 * 499);
    expect(recent.rows[0].accountType).toBe('CREDIT_CARD');
    const out = await companionTxSearch(r, parseTxQuery('payment'), NOW);
    expect(out.kind === 'ok' && out.recentOnly).toBe(true);
    expect(out.kind === 'ok' && out.result.truncated).toBe(true);
    expect(out.kind === 'ok' && out.result.rows[0].amountCents).toBe(-1000);
  });

  it('a full read of the last year is not marked cut short', async () => {
    const r = readers({ searchRows: vi.fn(() => { throw new Error('x'); }) });
    const out = await companionTxSearch(r, parseTxQuery('kroger'), NOW);
    expect(out.kind === 'ok' && out.result.truncated).toBe(false);
  });

  it('is unreachable when neither can be read', async () => {
    const r = readers({
      searchRows: vi.fn(() => { throw new Error('no database'); }),
      recentRows: vi.fn(async () => { throw new Error('502'); }),
    });
    expect(await companionTxSearch(r, parseTxQuery('kroger'), NOW)).toEqual({ kind: 'unreachable' });
  });
});

describe('companionStoryReaders', () => {
  it('reads the row by id over REST, and pages the last year until a short page', async () => {
    const searchActivities = vi.fn(async (body: { page: number; pageSize: number; activityIdFilter?: string[]; dateFrom?: string }) => {
      if (body.activityIdFilter) return [restRow({ id: 'other' }), restRow()];
      return body.page === 0 ? Array.from({ length: 500 }, (_, i) => restRow({ id: `p${i}` })) : [restRow({ id: 'last' })];
    });
    const client = {
      searchActivities, listCategorizationRules: vi.fn(async () => []),
      getAccounts: vi.fn(async () => []),
      getAddonSecret: vi.fn(async () => null), setAddonSecret: vi.fn(async () => {}),
    };
    const r = companionStoryReaders(client, '/nope/wealthfolio.db');
    expect((await r.row('act-1'))?.id).toBe('act-1');
    expect(searchActivities).toHaveBeenCalledWith({ page: 0, pageSize: 1, activityIdFilter: ['act-1'] });
    expect(await r.row('missing')).toBeNull();
    const recent = await r.recentRows('2025-10-13');
    expect(recent.rows).toHaveLength(501);
    expect(recent.truncated).toBe(false);
    expect(searchActivities).toHaveBeenCalledWith({ page: 1, pageSize: 500, dateFrom: '2025-10-13' });
    expect(() => r.searchRows()).toThrow();
  });
});
