import { describe, it, expect, vi } from 'vitest';
import { importChange, stampChange, transferLinkChange } from '../../shared/change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import { findingHandle } from '../../shared/handle.js';
import { WHY_CALLBACK_PREFIX } from '../../shared/telegram.js';
import { matchesTxQuery, parseTxQuery, txQueryText, type TxSearchRow } from '../../shared/tx-search.js';
import { buildTxStory, TX_STORY_GONE, TX_STORY_UNREACHABLE, type TxStory } from '../../shared/tx-story.js';
import { answerText, startAsk } from '../../shared/ask-flow.js';
import { parseChangesData } from './changes-menu.js';
import {
  buildWhyFlow, createWhyMenu, normalizeWhyQuery, parseWhyData, renderWhyResults, renderWhyRun, renderWhyStory,
  whyData, whyRunHandle, WHY_QUERY_MAX_BYTES, WHY_RECENT_ONLY, WHY_RUN_GONE, type WhyMenuDeps, type MenuScreen,
} from './why-menu.js';

const ID = '0f8fad5b-d9cb-469f-a165-708677289501';
const NOW = new Date('2026-10-13T16:00:00Z');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);

const result = (n: number, over: Partial<TxSearchRow> = {}): TxSearchRow[] => Array.from({ length: n }, (_, i) => ({
  activityId: `act-${i}`, date: `2026-10-${String(20 - (i % 19)).padStart(2, '0')}`, description: 'KROGER #415',
  amountCents: -5420, accountName: 'PNC Checking', ...over,
}));

const imp = (activityId: string, run: string, description = 'KROGER #415'): ChangeLogItem => stampChange(importChange({
  account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: `k-${activityId}`, activityId,
  description, amountCents: -5420, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date('2026-10-04T12:00:00Z'), run);

const storyFor = (over: Partial<TxStory> = {}): TxStory => ({
  ...buildTxStory({
    now: NOW,
    row: { activityId: ID, note: 'KROGER #415 · TRN-1', absCents: 5420, date: '2026-10-04', activityType: 'WITHDRAWAL', accountName: 'PNC Checking' },
    feed: { sfinAccountId: 'ACT-chk' }, partner: null, category: { name: 'Groceries', filer: { kind: 'rule', pattern: 'KROGER' } },
    history: [imp(ID, 'c1')],
  }),
  ...over,
});

describe('normalizeWhyQuery', () => {
  it('keeps a short query as words then the amount', () => {
    expect(normalizeWhyQuery('  $54.20   Kroger ')).toBe('$54.20 kroger');
  });

  it('drops words from the end, keeping the amount, until it fits', () => {
    const q = normalizeWhyQuery('heine brothers coffee shop 12.50');
    expect(bytes(q)).toBeLessThanOrEqual(WHY_QUERY_MAX_BYTES);
    expect(q).toBe('$12.50 heine');
  });

  it('cuts one long word at a character, never mid-byte', () => {
    const q = normalizeWhyQuery('ééééééééééééééééééé');
    expect(bytes(q)).toBeLessThanOrEqual(WHY_QUERY_MAX_BYTES);
    expect(q).toBe('éééééééé');
  });
});

describe('a canonical query parses back to the same query', () => {
  it.each(['kroger 415 54.20', '7 eleven 5.43', 'kroger 415 54', '$415 kroger 54.20', '54.20', 'kroger', '$1,250.50 rent', 'heine brothers coffee shop 12.50'])('%s', (t) => {
    const q = parseTxQuery(t);
    const n = normalizeWhyQuery(t);
    if (bytes(txQueryText(q)) <= WHY_QUERY_MAX_BYTES) expect(parseTxQuery(n)).toEqual(q);
    else expect(parseTxQuery(n).amount).toEqual(q.amount);
  });

  it('pages and Back keep two amount-like tokens: the same rows are listed', async () => {
    const rows = [{ activityId: ID, date: '2026-10-04', description: 'KROGER #415', amountCents: -5420, accountName: 'PNC Checking' }];
    const search = vi.fn(async (q: ReturnType<typeof parseTxQuery>) => ({
      kind: 'ok' as const, result: { rows: rows.filter((r) => matchesTxQuery(r, q)), truncated: false }, recentOnly: false,
    }));
    const menu = createWhyMenu({
      search, story: vi.fn(async () => ({ kind: 'ok' as const, story: storyFor(), facts: {} as never })),
      read: vi.fn(), now: () => NOW, log: vi.fn(),
    } as unknown as WhyMenuDeps);
    const sent: Array<[string, any]> = [];
    await menu.reply('kroger 415 54.20', async (t, k) => { sent.push([t, k]); });
    expect(sent[0][1].inline_keyboard).toHaveLength(1);
    const open = sent[0][1].inline_keyboard[0][0].callback_data as string;
    const edits: Array<[string, any]> = [];
    const u = { edit: vi.fn(async (t: string, k: any) => { edits.push([t, k]); }), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
    await menu.onCallback({ data: open }, u);
    const back = edits[0][1].inline_keyboard.at(-1)[0].callback_data as string;
    await menu.onCallback({ data: back }, u);
    expect(edits[1][0]).toBe(sent[0][0]);
    expect(edits[1][1]).toEqual(sent[0][1]);
  });
});

describe('the results', () => {
  it('lists matches as buttons, newest first, with the date, description, amount and account', () => {
    const s = renderWhyResults({ result: { rows: result(2), truncated: false }, recentOnly: false }, 'kroger', 0, NOW);
    expect(s.text).toBe(['🔎 *Why is this here?* kroger', '', 'Tap one to see its story.'].join('\n'));
    expect(s.keyboard.inline_keyboard[0]).toEqual([{ text: 'Oct 20 · KROGER #415 · -$54.20 · PNC Checking', callback_data: 'cz:wy:tact-0:s0:kroger' }]);
  });

  it('pages by 8, with a page count, and says when there were too many', () => {
    const found = { result: { rows: result(40), truncated: true }, recentOnly: false };
    const first = renderWhyResults(found, '54', 0, NOW);
    expect(first.keyboard.inline_keyboard).toHaveLength(9);
    expect(first.text).toContain('Page 1 of 5');
    expect(first.text).toContain('Too many matches — add a word or an amount.');
    expect(labels(first).at(-1)).toBe('‹ Older');
    const last = renderWhyResults(found, '54', 4, NOW);
    expect(labels(last).at(-1)).toBe('Newer ›');
    expect(allData(last)).toContain('cz:wy:s3:54');
  });

  it('says when it could only search the last 12 months', () => {
    expect(renderWhyResults({ result: { rows: result(1), truncated: false }, recentOnly: true }, 'kroger', 0, NOW).text).toContain(WHY_RECENT_ONLY);
  });

  it('says nothing matches, pointing at /changes with the words', () => {
    const none = { result: { rows: [], truncated: false }, recentOnly: false };
    expect(renderWhyResults(none, 'venmo jane', 0, NOW).text).toBe('🔎 *Why is this here?* venmo jane\n\nNothing matches. If it was removed, try /changes venmo jane.');
    expect(renderWhyResults(none, '54.20', 0, NOW).text).toContain('Nothing matches. If it was removed, try /changes with a word from its description.');
    expect(renderWhyResults(none, '54.20', 0, NOW).keyboard.inline_keyboard).toEqual([]);
  });

  it('escapes a bank name full of Markdown characters and keeps it out of every entity', () => {
    const s = renderWhyResults({ result: { rows: result(1, { description: 'SQ *COFFEE_CLUB [2]' }), truncated: false }, recentOnly: false }, 'sq *coffee_', 0, NOW);
    expect(s.text.split('\n')[0]).toBe('🔎 *Why is this here?* sq \\*coffee\\_');
    // Button labels are not Markdown: they stay as the bank wrote them.
    expect(labels(s)[0]).toBe('Oct 20 · SQ *COFFEE_CLUB [2] · -$54.20 · PNC Checking');
  });
});

describe('the year', () => {
  it('the story title shows it too, against the clock it was built with', () => {
    const build = (now: Date) => buildTxStory({
      now, row: { activityId: ID, note: 'KROGER #415 · TRN-1', absCents: 5420, date: '2026-10-04', activityType: 'WITHDRAWAL', accountName: 'PNC Checking' },
    });
    expect(renderWhyStory(build(NOW), ID, { kind: 'none' }).text.split('\n')[0]).toBe('🔎 KROGER #415 · -$54.20 · Oct 4');
    expect(renderWhyStory(build(new Date('2027-01-01T12:00:00Z')), ID, { kind: 'none' }).text.split('\n')[0]).toBe('🔎 KROGER #415 · -$54.20 · Oct 4, 2026');
  });

  it('shows it on a result from another year, and not for this one', () => {
    const s = renderWhyResults({ result: { rows: result(1, { date: '2024-10-04' }), truncated: false }, recentOnly: false }, 'kroger', 0, NOW);
    expect(labels(s)[0]).toBe('Oct 4, 2024 · KROGER #415 · -$54.20 · PNC Checking');
    const row2026 = { result: { rows: result(1, { date: '2026-10-04' }), truncated: false }, recentOnly: false };
    expect(labels(renderWhyResults(row2026, 'kroger', 0, NOW))[0]).toMatch(/^Oct 4 · /);
    expect(labels(renderWhyResults(row2026, 'kroger', 0, new Date('2027-01-01T12:00:00Z')))[0]).toMatch(/^Oct 4, 2026 · /);
  });
});

describe('the story', () => {
  it('answers, then lists what happened, each line a button into /changes that comes back here', () => {
    const story = storyFor();
    const s = renderWhyStory(story, ID, { kind: 'search', page: 1, query: 'kroger' });
    expect(s.text).toBe([
      '🔎 KROGER #415 · -$54.20 · Oct 4',
      'PNC Checking',
      '',
      'From your PNC Checking bank feed.',
      'Spending.',
      "Filed under Groceries by a rule — 'KROGER' matches it.",
      '',
      '*What happened*',
      '1. Oct 4 · Imported KROGER #415',
    ].join('\n'));
    const line = s.keyboard.inline_keyboard[0][0];
    expect(line.text).toBe('1');
    expect(parseChangesData(line.callback_data)).toEqual({
      kind: 'detail', entry: findingHandle(story.history![0].entryId), back: { kind: 'why', activityId: ID },
    });
    expect(s.keyboard.inline_keyboard.at(-1)).toEqual([{ text: '⬅️ Back', callback_data: 'cz:wy:s1:kroger' }]);
  });

  it('a story sent as a new message, or reached from /changes, has no Back', () => {
    expect(labels(renderWhyStory(storyFor(), ID, { kind: 'none' }))).toEqual(['1']);
    expect(labels(renderWhyStory(storyFor(), ID, { kind: 'changes' }))).toEqual(['1']);
    expect(renderWhyStory(storyFor(), ID, { kind: 'run', run: 'abcd1234', page: 2 }).keyboard.inline_keyboard.at(-1))
      .toEqual([{ text: '⬅️ Back', callback_data: 'cz:wy:rabcd1234:2' }]);
  });

  it('says when nothing happened in 90 days, and leaves the section out when the log was unreadable', () => {
    expect(renderWhyStory(storyFor({ history: [] }), ID, { kind: 'none' }).text).toContain('*What happened*\nNo changes in the last 90 days.');
    const unread = renderWhyStory(storyFor({ history: null, notes: ["Couldn't read the change log just now."] }), ID, { kind: 'none' });
    expect(unread.text).not.toContain('What happened');
    expect(unread.text.endsWith("\n\n⚠️ Couldn't read the change log just now.")).toBe(true);
  });

  it('escapes bank text in the title, the account and the answer, and keeps it out of every entity', () => {
    const story = buildTxStory({
      now: NOW,
      row: { activityId: ID, note: 'SQ *COFFEE_CLUB [2] · TRN-1', absCents: 500, date: '2026-10-04', activityType: 'WITHDRAWAL', accountName: "Joe's *Visa*" },
      feed: { sfinAccountId: 'x' }, partner: null, history: [],
    });
    const s = renderWhyStory(story, ID, { kind: 'none' });
    const lines = s.text.split('\n');
    expect(lines[0]).toBe('🔎 SQ \\*COFFEE\\_CLUB \\[2] · -$5.00 · Oct 4');
    expect(lines[1]).toBe("Joe's \\*Visa\\*");
    expect(lines[3]).toBe("From your Joe's \\*Visa\\* bank feed.");
    expect(lines.filter((l) => /^[*_]/.test(l))).toEqual(['*What happened*']);
  });

  it('shows the newest 20 lines of a long history', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ entryId: `e${i}`, line: `Oct 4 · step ${i}` }));
    const s = renderWhyStory(storyFor({ history: many }), ID, { kind: 'none' });
    expect(s.text).toContain('…and 3 earlier — /changes lists them.');
    expect(s.text).toContain('1. Oct 4 · step 3');
    expect(labels(s)).toHaveLength(20);
  });
});

describe('a sync’s imports', () => {
  it('an empty list does not throw', () => {
    expect(renderWhyRun([], 'abcd1234', 0, NOW).text).toContain('past the change log');
  });

  it('whyRunHandle is the handle the menu reads', () => {
    expect(whyRunHandle('c1')).toBe(findingHandle('c1'));
  });

  it('lists them, each opening its story with Back to the list', () => {
    const s = renderWhyRun([imp('a1', 'c1'), imp('a2', 'c1', 'TARGET')], 'abcd1234', 0, NOW);
    expect(s.text.split('\n')[0]).toBe('🔎 *What this sync imported*');
    expect(s.keyboard.inline_keyboard[1]).toEqual([{ text: 'Oct 4 · TARGET · -$54.20 · PNC Checking', callback_data: 'cz:wy:ta2:rabcd1234:0' }]);
  });
});

describe('callback data', () => {
  it('round-trips two-digit run pages within 64 bytes', () => {
    const a = { kind: 'run', run: 'abcd1234', page: 12, fresh: false } as const;
    const b = { kind: 'story', activityId: ID, back: { kind: 'run', run: 'abcd1234', page: 12 } } as const;
    for (const v of [a, b]) {
      expect(parseWhyData(whyData(v))).toEqual(v);
      expect(bytes(whyData(v))).toBeLessThanOrEqual(64);
    }
  });

  it.each([['abcdefghijklmnopq', 64], ['😀😀😀😀', 64 - (17 - 16)]])('the widest button for %s fits and cuts no UTF-8 sequence', (q, widest) => {
    const query = normalizeWhyQuery(q);
    const found = { result: { rows: result(8, { activityId: ID }), truncated: true }, recentOnly: false };
    const data = [...allData(renderWhyResults(found, query, 1, NOW)), ...allData(renderWhyStory(storyFor(), ID, { kind: 'search', page: 4, query }))];
    for (const d of data) {
      expect(bytes(d!)).toBeLessThanOrEqual(64);
      expect(Buffer.from(d!, 'utf8').toString('utf8')).toBe(d);
      expect(d).not.toContain('\uFFFD');
    }
    expect(Math.max(...data.map((d) => bytes(d!)))).toBe(widest);
  });

  it('round-trips every view', () => {
    const views = [
      { kind: 'search', page: 3, query: 'kroger 54.20' },
      { kind: 'story', activityId: ID, back: { kind: 'none' } },
      { kind: 'story', activityId: ID, back: { kind: 'changes' } },
      { kind: 'story', activityId: ID, back: { kind: 'search', page: 0, query: 'a:b c' } },
      { kind: 'story', activityId: ID, back: { kind: 'run', run: 'abcd1234', page: 4 } },
      { kind: 'run', run: 'abcd1234', page: 0, fresh: true },
      { kind: 'run', run: 'abcd1234', page: 2, fresh: false },
    ] as const;
    for (const v of views) expect(parseWhyData(whyData(v))).toEqual(v);
    expect(parseWhyData('cz:wy:nonsense')).toBeNull();
    expect(parseWhyData('cz:cl:l0')).toBeNull();
  });

  it('the longest query still fits Telegram’s 64 bytes on every button, story Back included', () => {
    const query = normalizeWhyQuery('éééé ééé ééé 1,234,567.89 trailing words here');
    const found = { result: { rows: result(8, { activityId: ID }), truncated: true }, recentOnly: false };
    const results = renderWhyResults(found, query, 1, NOW);
    const story = renderWhyStory(storyFor(), ID, { kind: 'search', page: 4, query });
    const run = renderWhyRun([imp(ID, 'c1')], 'abcd1234', 0, NOW);
    const fromRun = renderWhyStory(storyFor(), ID, { kind: 'run', run: 'abcd1234', page: 4 });
    for (const data of [...allData(results), ...allData(story), ...allData(run), ...allData(fromRun)]) {
      expect(bytes(data)).toBeLessThanOrEqual(64);
    }
    expect(Math.max(...allData(results).map(bytes))).toBe(64 - (WHY_QUERY_MAX_BYTES - bytes(query)));
  });

  it('shares the cz: prefix every menu tap rides on', () => {
    expect(WHY_CALLBACK_PREFIX.startsWith(MENU_CALLBACK_PREFIX)).toBe(true);
  });
});

describe('the menu', () => {
  const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });
  const deps = (over: Partial<WhyMenuDeps> = {}): WhyMenuDeps => ({
    search: vi.fn(async () => ({ kind: 'ok' as const, result: { rows: result(3), truncated: false }, recentOnly: false })),
    story: vi.fn(async (id: string) => (id === ID ? { kind: 'ok' as const, story: storyFor(), facts: {} as never } : { kind: 'gone' as const })),
    read: vi.fn(async (): Promise<ChangeLogRead> => ({ entries: [imp(ID, 'c1')], gaps: [], trimmed: 0, unreadable: [] })),
    now: () => NOW,
    log: vi.fn(),
    ...over,
  });

  it('/why <words> replies with the results', async () => {
    const d = deps();
    const send = vi.fn(async () => {});
    await createWhyMenu(d).reply('Kroger', send);
    expect(d.search).toHaveBeenCalledWith(parseTxQuery('kroger'), NOW);
    expect((send.mock.calls[0] as unknown as [string])[0]).toContain('🔎 *Why is this here?* kroger');
  });

  it('/why says so when Wealthfolio cannot be reached', async () => {
    const send = vi.fn(async () => {});
    await createWhyMenu(deps({ search: vi.fn(async () => ({ kind: 'unreachable' as const })) })).reply('kroger', send);
    expect(send).toHaveBeenCalledWith(TX_STORY_UNREACHABLE);
  });

  it('pages the results in place', async () => {
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: 'cz:wy:s0:kroger' }, u);
    expect(u.edit).toHaveBeenCalledTimes(1);
    expect(u.send).not.toHaveBeenCalled();
    expect(u.answer).toHaveBeenCalledWith();
  });

  it('a result opens its story in place; a 🔎 Why? button sends it as a new message', async () => {
    const inPlace = ui();
    await createWhyMenu(deps()).onCallback({ data: `cz:wy:t${ID}:s0:kroger` }, inPlace);
    expect(inPlace.edit).toHaveBeenCalledTimes(1);
    expect(inPlace.send).not.toHaveBeenCalled();
    const fresh = ui();
    await createWhyMenu(deps()).onCallback({ data: `cz:wy:t${ID}` }, fresh);
    expect(fresh.send).toHaveBeenCalledTimes(1);
    expect(fresh.edit).not.toHaveBeenCalled();
    expect((fresh.send.mock.calls[0] as unknown as [string])[0]).toContain('🔎 KROGER #415');
  });

  it('a stale story button — the row was re-created by a transfer link — says so and changes nothing', async () => {
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: 'cz:wy:tolder-row-id:s0:kroger' }, u);
    expect(u.answer).toHaveBeenCalledWith(TX_STORY_GONE);
    expect(u.edit).not.toHaveBeenCalled();
    expect(u.send).not.toHaveBeenCalled();
  });

  it('a sync’s imports come from the change log, by the run, sent as a new message', async () => {
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: `cz:wy:r${findingHandle('c1')}` }, u);
    expect((u.send.mock.calls[0] as unknown as [string])[0]).toContain('🔎 *What this sync imported*');
    const gone = ui();
    await createWhyMenu(deps()).onCallback({ data: `cz:wy:r${findingHandle('c-old')}` }, gone);
    expect(gone.answer).toHaveBeenCalledWith(WHY_RUN_GONE);
    expect(gone.send).not.toHaveBeenCalled();
  });

  it('a sync’s imports open each one’s CURRENT row: a link in the same run re-created it', async () => {
    const out = imp('old-out', 'c1', 'TRANSFER TO ALLY');
    const kroger = imp('act-k', 'c1');
    const lnk = stampChange(transferLinkChange(
      { account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: 'k-old-out', description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'old-out', newActivityId: ID },
      { account: { sfinId: 'ACT-ally', wfId: 'wf-ally', name: 'Ally Savings' }, txKey: 'k-old-in', description: 'TRANSFER FROM PNC', amountCents: 60000, date: '2026-10-04', oldActivityId: 'old-in', newActivityId: 'new-in' },
    ), 'companion', new Date('2026-10-04T12:01:00Z'), 'c1');
    const u = ui();
    const d = deps({ read: vi.fn(async (): Promise<ChangeLogRead> => ({ entries: [lnk, kroger, out], gaps: [], trimmed: 0, unreadable: [] })) });
    await createWhyMenu(d).onCallback({ data: `cz:wy:r${findingHandle('c1')}` }, u);
    const keyboard = (u.send.mock.calls[0] as unknown as [string, { inline_keyboard: Array<Array<{ callback_data: string }>> }])[1];
    const opens = keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(opens).toContain(`cz:wy:t${ID}:r${findingHandle('c1')}:0`);
    expect(opens).toContain(`cz:wy:tact-k:r${findingHandle('c1')}:0`);
    expect(opens.some((o) => o.includes('old-out'))).toBe(false);
    // …and that button opens the story.
    const story = ui();
    await createWhyMenu(d).onCallback({ data: `cz:wy:t${ID}:r${findingHandle('c1')}:0` }, story);
    expect(story.edit).toHaveBeenCalledTimes(1);
    expect(story.answer).not.toHaveBeenCalledWith(TX_STORY_GONE);
  });

  it('a story told for a row that moved leads its history lines back to the row it is now', async () => {
    const d = deps({ story: vi.fn(async () => ({ kind: 'ok' as const, story: storyFor(), facts: {} as never, movedTo: ID })) });
    const u = ui();
    await createWhyMenu(d).onCallback({ data: 'cz:wy:tolder-row-id:s0:kroger' }, u);
    const keyboard = (u.edit.mock.calls[0] as unknown as [string, { inline_keyboard: Array<Array<{ callback_data: string }>> }])[1];
    expect(parseChangesData(keyboard.inline_keyboard[0][0].callback_data)).toMatchObject({ back: { kind: 'why', activityId: ID } });
  });

  it('sendStory sends the story, or the reason it cannot', async () => {
    const send = vi.fn(async () => {});
    await createWhyMenu(deps()).sendStory(ID, send);
    await createWhyMenu(deps()).sendStory('gone', send);
    expect((send.mock.calls[0] as unknown as [string])[0]).toContain('🔎 KROGER #415');
    expect(send.mock.calls[1]).toEqual([TX_STORY_GONE]);
  });

  it('ignores data it never emitted', async () => {
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: 'cz:wy:zz' }, u);
    expect(u.answer).toHaveBeenCalledWith();
  });
});

describe('the bare /why question', () => {
  it('asks for words or an amount, and will not take nothing', () => {
    const flow = buildWhyFlow();
    const { state, screen } = startAsk(flow, 's1');
    expect(screen.text).toBe('*Why is this here?*\nWhich transaction? Send a few words or an amount.');
    expect(answerText(flow, state, '!!').kind).toBe('done');
    const empty = answerText(flow, state, '   ');
    expect(empty.kind).toBe('retry');
  });
});
