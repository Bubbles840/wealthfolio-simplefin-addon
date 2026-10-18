import { describe, it, expect, vi } from 'vitest';
import { findingHandle } from '../../shared/findings.js';
import { editSubscriptionPrefs, emptySubscriptionPrefs, type SubscriptionPrefs } from '../../shared/subscription-prefs.js';
import { localIsoDay } from '../../shared/subscription-roster.js';
import { readSubscriptionRoster } from './subscription-data.js';
import {
  createSubscriptionsMenu, renderSubscriptionDetail, OPEN_SUBSCRIPTIONS, SUBSCRIPTIONS_GONE_ANSWER,
  SUBSCRIPTIONS_UNREACHABLE_REPLY, SUBSCRIPTIONS_UNREADABLE_REPLY, type SubscriptionsMenuDeps,
} from './subscriptions-menu.js';

const NOW = new Date(2026, 9, 12, 9, 0, 0);
const H = (key: string) => findingHandle(key);

/** report_cube exactly as the companion publishes it. */
const cubeJson = (subscriptions: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, asOf: '2026-10-12T06:00:00.000Z', months: ['2026-09', '2026-10'], categories: [], accounts: [],
  spend: [[], []], uncategorized: [[], []], income: [[], []], budgets: [[], []], merchants: [[], []],
  feesInterest: [0, 0], netWorth: [null, null], liquid: [null, null], pool: null, subscriptions, ...extra,
});
const det = (name: string, over: Record<string, unknown> = {}) => ({
  name, monthlyCents: 1199, count: 5, lastDate: '2026-09-15', lastCents: 1199, prevCents: 1199, creep: false,
  kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }], ...over,
});
const doc = (over: Partial<SubscriptionPrefs> = {}) => JSON.stringify({ ...emptySubscriptionPrefs(), ...over });
const HULU = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly' as const, nextDate: '2026-10-20' };

/** Real reader and writer over a Map; every tap builds a NEW menu, as after a restart. */
function harness(entries: Record<string, string>) {
  const secrets = new Map(Object.entries(entries));
  const get = vi.fn(async (k: string) => secrets.get(k) ?? null);
  const set = vi.fn(async (k: string, v: string) => { secrets.set(k, v); });
  const deps: SubscriptionsMenuDeps = {
    read: (now) => readSubscriptionRoster(get, localIsoDay(now)),
    edit: (edit, now) => editSubscriptionPrefs(get, set, edit, now),
    now: () => NOW,
    log: vi.fn(),
  };
  const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
  const tap = (data: string) => createSubscriptionsMenu(deps).onCallback({ data, chatId: 1 }, ui);
  const stored = () => JSON.parse(secrets.get('subscription_prefs') ?? 'null');
  return { secrets, get, set, ui, tap, stored };
}
const datas = (kb: any): string[] => kb.inline_keyboard.flat().map((b: any) => b.callback_data);
const texts = (kb: any): string[] => kb.inline_keyboard.flat().map((b: any) => b.text);
const BASE = () => ({
  report_cube: cubeJson([det('SPOTIFY'), det('MYSTERY BOX', { kind: 'possible', monthlyCents: 1500, lastCents: 1500, count: 2 })]),
});

describe('subscriptions menu', () => {
  it('the report button sends the list as a NEW message — the report is never drawn over', async () => {
    const h = harness(BASE());
    await h.tap(OPEN_SUBSCRIPTIONS);
    expect(h.ui.edit).not.toHaveBeenCalled();
    const [text, kb] = h.ui.send.mock.calls[0] as unknown as [string, any];
    expect(text).toContain('💳 *Subscriptions* · $11.99/mo');
    expect(datas(kb)).toEqual([`cz:sb:d:${H('SPOTIFY')}`, 'cz:sb:mb', 'cz:ak:go:sub-add']);
    expect(texts(kb)).toEqual(['SPOTIFY', '❓ 1 maybe', '➕ Add']);
  });

  it('a row opens its detail: last charges, reminder choices, rename, hide, back', async () => {
    const h = harness(BASE());
    await h.tap(`cz:sb:d:${H('SPOTIFY')}`);
    const [text, kb] = h.ui.edit.mock.calls[0] as unknown as [string, any];
    expect(text).toBe([
      'SPOTIFY',
      '$11.99 a month · next Oct 15',
      'Last charges: Sep 15 $11.99',
      '🔔 Remind: off',
    ].join('\n'));
    expect(texts(kb)).toEqual(['1d', '3d', '7d', '✓ Off', '✏️ Rename', '🙈 Hide / I cancelled it', '‹ Back']);
    expect(datas(kb)).toContain(`cz:ak:go:sub-rename:${H('SPOTIFY')}`);
  });

  it('remind writes the document and marks the choice', async () => {
    const h = harness(BASE());
    await h.tap(`cz:sb:r3:${H('SPOTIFY')}`);
    expect(h.stored().remind).toEqual({ SPOTIFY: 3 });
    expect(texts((h.ui.edit.mock.calls[0] as unknown as [string, any])[1])).toContain('✓ 3d');
    expect(h.ui.answer).toHaveBeenCalledWith('Reminder: 3 days before');
    await h.tap(`cz:sb:r0:${H('SPOTIFY')}`);
    expect(h.stored().remind).toEqual({});
    expect(h.ui.answer).toHaveBeenLastCalledWith('Reminder off');
  });

  it('hide is instant, mirrored for older readers, and Undo puts it back', async () => {
    const h = harness(BASE());
    await h.tap(`cz:sb:h:${H('SPOTIFY')}`);
    expect(h.stored().hidden).toEqual(['SPOTIFY']);
    expect(h.secrets.get('hidden_subscriptions')).toBe('["SPOTIFY"]');
    const [text, kb] = h.ui.edit.mock.calls[0] as unknown as [string, any];
    expect(text).toBe("🙈 Hid SPOTIFY. It's out of every total and report — Undo puts it back.");
    expect(datas(kb)).toEqual([`cz:sb:uh:${H('SPOTIFY')}`, 'cz:sb:l:0']);
    await h.tap(`cz:sb:uh:${H('SPOTIFY')}`);
    expect(h.stored().hidden).toEqual([]);
    expect(h.ui.answer).toHaveBeenLastCalledWith('Undone');
  });

  it('Restore and Undo find a choice stored under a key from before 1.63 (R6)', async () => {
    const LGE = 'PAYMENT LOUISVILLE GAS & ACH';
    const VENMO = 'PAYMENT VENMO ACH WEB';
    const h = harness({
      report_cube: cubeJson([det(LGE, { kind: 'bill' }), det(VENMO, { kind: 'possible', count: 2 })]),
      subscription_prefs: doc({ hidden: ['*8712 PAYMENT LOUISVILLE GAS & ACH'], confirmed: ['*8768 PAYMENT VENMO ACH WEB'] }),
    });
    await h.tap(`cz:sb:u:${H(LGE)}`);
    expect(h.stored().hidden).toEqual([]);
    await h.tap(`cz:sb:uc:${H(VENMO)}`);
    expect(h.stored().confirmed).toEqual([]);
  });

  it('Restore clears a hide stored under a renamed charge\'s key, joined into the entry (F1)', async () => {
    const OLD = 'GOOGLE *Google One MOUNTAIN VIEW CA';
    const NEW = 'GOOGLE *G1AI101M MOUNTAIN VIEW CA';
    const h = harness({
      report_cube: cubeJson([det('SPOTIFY'), det(OLD, { monthlyCents: 2119, lastCents: 2119, aliases: [NEW] })]),
      subscription_prefs: doc({ hidden: [NEW] }),
    });
    await h.tap(`cz:sb:u:${H(OLD)}`);
    expect(h.stored().hidden).toEqual([]);
    expect(h.ui.answer).toHaveBeenLastCalledWith(`Restored ${OLD}`);
  });

  it('a maybe answered Yes counts from then on; Undo takes it back', async () => {
    const h = harness(BASE());
    await h.tap('cz:sb:mb');
    const [question, qkb] = h.ui.edit.mock.calls[0] as unknown as [string, any];
    expect(question).toBe('❓ Is MYSTERY BOX a subscription?\n$15 a month · last charged Sep 15');
    expect(texts(qkb)).toEqual(["✅ Yes, it's a subscription", '🙈 No', '‹ Back']);
    await h.tap(`cz:sb:c:${H('MYSTERY BOX')}`);
    expect(h.stored().confirmed).toEqual(['MYSTERY BOX']);
    expect((h.ui.edit.mock.calls[1] as unknown as [string])[0]).toBe('✅ MYSTERY BOX now counts as a subscription.');
    await h.tap(`cz:sb:uc:${H('MYSTERY BOX')}`);
    expect(h.stored().confirmed).toEqual([]);
  });

  it('No on a maybe hides it; the Hidden screen restores it', async () => {
    const h = harness(BASE());
    await h.tap(`cz:sb:hm:${H('MYSTERY BOX')}`);
    expect(h.stored().hidden).toEqual(['MYSTERY BOX']);
    await h.tap('cz:sb:hd');
    expect(texts((h.ui.edit.mock.calls[1] as unknown as [string, any])[1])).toEqual(['↩ MYSTERY BOX', '‹ Back']);
    await h.tap(`cz:sb:u:${H('MYSTERY BOX')}`);
    expect(h.stored().hidden).toEqual([]);
    expect(h.ui.answer).toHaveBeenLastCalledWith('Restored MYSTERY BOX');
  });

  it('a hand-added entry is deleted, not hidden, and Undo restores it', async () => {
    const h = harness({ ...BASE(), subscription_prefs: doc({ manual: [HULU] }) });
    await h.tap(`cz:sb:d:${H('m:hulu0001')}`);
    const detail = texts((h.ui.edit.mock.calls[0] as unknown as [string, any])[1]);
    expect(detail).toContain('🗑 Delete');
    expect(detail).not.toContain('🙈 Hide / I cancelled it');
    await h.tap(`cz:sb:x:${H('m:hulu0001')}`);
    expect(h.stored().manual).toEqual([]);
    expect(h.stored().deleted).toEqual([{ ...HULU, deletedAt: NOW.toISOString() }]);
    await h.tap(`cz:sb:ux:${H('m:hulu0001')}`);
    expect(h.stored().manual).toEqual([HULU]);
  });

  it('Undo on a rename puts the old name back', async () => {
    const h = harness({ ...BASE(), subscription_prefs: doc({ names: { SPOTIFY: 'Spotify' }, prevNames: { SPOTIFY: null } }) });
    await h.tap(`cz:sb:un:${H('SPOTIFY')}`);
    expect(h.stored()).toMatchObject({ names: {}, prevNames: {} });
    expect(h.ui.answer).toHaveBeenLastCalledWith('Undone');
  });

  it('asks about a link suggestion above the list; Yes links, No sticks', async () => {
    const entries = {
      report_cube: cubeJson([det('SPOTIFY')], { subscriptionLinks: [{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }] }),
      subscription_prefs: doc({ manual: [HULU] }),
    };
    const yes = harness(entries);
    await yes.tap(OPEN_SUBSCRIPTIONS);
    const [text, kb] = yes.ui.send.mock.calls[0] as unknown as [string, any];
    expect(text.split('\n')[0]).toBe('Is HULU your Hulu? ($9.99 on Sep 19)');
    expect(datas(kb).slice(0, 2)).toEqual([`cz:sb:ly:${H('m:hulu0001')}`, `cz:sb:ln:${H('m:hulu0001')}`]);
    await yes.tap(`cz:sb:ly:${H('m:hulu0001')}`);
    expect(yes.stored().manual).toEqual([{ ...HULU, merchant: 'HULU', nextDate: '2026-10-19' }]);
    expect(yes.ui.answer).toHaveBeenLastCalledWith('Linked to Hulu');
    const no = harness(entries);
    await no.tap(`cz:sb:ln:${H('m:hulu0001')}`);
    expect(no.stored().declinedLinks).toEqual(['hulu0001|HULU']);
  });

  it('pages a long list', async () => {
    const h = harness({ report_cube: cubeJson(Array.from({ length: 12 }, (_, i) => det(`SUB ${String(i).padStart(2, '0')}`, { monthlyCents: 1000 + i }))) });
    await h.tap(OPEN_SUBSCRIPTIONS);
    expect(datas((h.ui.send.mock.calls[0] as unknown as [string, any])[1])).toContain('cz:sb:l:1');
    await h.tap('cz:sb:l:1');
    expect((h.ui.edit.mock.calls[0] as unknown as [string])[0]).toContain('_Page 2 of 2_');
  });

  it('a report Hide button hides and answers in a NEW message', async () => {
    const h = harness({ report_cube: cubeJson([det('NETFLIX', { lastDate: '2026-09-03' })]) });
    await h.tap(`cz:sb:hr:${H('NETFLIX')}`);
    expect(h.stored().hidden).toEqual(['NETFLIX']);
    expect(h.ui.edit).not.toHaveBeenCalled();
    expect((h.ui.send.mock.calls[0] as unknown as [string])[0]).toContain('🙈 Hid NETFLIX.');
  });

  it('a report Hide button hides a LINKED hand-added entry too; Undo offered, Hidden lists it with Restore', async () => {
    const LINKED = { ...HULU, merchant: 'HULU', nextDate: '2026-10-02' };
    const h = harness({
      report_cube: cubeJson([det('HULU', { lastDate: '2026-09-02', monthlyCents: 999, lastCents: 999 })]),
      subscription_prefs: doc({ manual: [LINKED] }),
    });
    await h.tap(`cz:sb:hr:${H('m:hulu0001')}`);
    expect(h.stored().hidden).toEqual(['m:hulu0001']);
    expect(h.ui.edit).not.toHaveBeenCalled();
    const [text, kb] = h.ui.send.mock.calls[0] as unknown as [string, any];
    expect(text).toContain('🙈 Hid Hulu.');
    expect(datas(kb)).toContain(`cz:sb:uh:${H('m:hulu0001')}`);
    await h.tap('cz:sb:hd');
    expect(texts((h.ui.edit.mock.calls[0] as unknown as [string, any])[1])).toEqual(['↩ Hulu', '‹ Back']);
    await h.tap(`cz:sb:u:${H('m:hulu0001')}`);
    expect(h.stored().hidden).toEqual([]);
  });

  // Review Focus: a report button tapped after the entry already left.
  it('a report button for an entry hidden since: "already sorted", the list as a NEW message, no write', async () => {
    const h = harness({
      report_cube: cubeJson([det('SPOTIFY'), det('NETFLIX', { lastDate: '2026-09-03' })]),
      subscription_prefs: doc({ hidden: ['NETFLIX'] }),
    });
    await h.tap(`cz:sb:hr:${H('NETFLIX')}`);
    expect(h.ui.answer).toHaveBeenCalledWith(SUBSCRIPTIONS_GONE_ANSWER);
    expect(h.ui.edit).not.toHaveBeenCalled();
    expect((h.ui.send.mock.calls[0] as unknown as [string])[0]).toContain('💳 *Subscriptions*');
    expect(h.set).not.toHaveBeenCalled();
  });

  // Review Focus: a corrupt document when a button is tapped.
  it('a corrupt document: the tap is refused, the stored text untouched, the list still honours the old hides', async () => {
    const h = harness({ ...BASE(), subscription_prefs: '{"v":1,"hidden":', hidden_subscriptions: '["MYSTERY BOX"]' });
    await h.tap(`cz:sb:h:${H('SPOTIFY')}`);
    expect(h.ui.answer).toHaveBeenCalledWith(SUBSCRIPTIONS_UNREADABLE_REPLY);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.secrets.get('subscription_prefs')).toBe('{"v":1,"hidden":');
    await h.tap(OPEN_SUBSCRIPTIONS);
    const [text, kb] = h.ui.send.mock.calls[0] as unknown as [string, any];
    expect(text.split('\n')[0]).toContain("Couldn't read your subscription settings");
    expect(texts(kb)).toContain('🙈 1 hidden');
    expect(texts(kb)).not.toContain('❓ 1 maybe');
  });

  it('Wealthfolio unreachable: one answer, nothing sent or written', async () => {
    const h = harness(BASE());
    h.get.mockRejectedValue(new Error('ECONNREFUSED'));
    await h.tap(`cz:sb:h:${H('SPOTIFY')}`);
    expect(h.ui.answer).toHaveBeenCalledWith(SUBSCRIPTIONS_UNREACHABLE_REPLY);
    expect(h.ui.send).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('an edit the parser would reject: "couldn\'t save that", nothing written, no escape', async () => {
    const h = harness(BASE());
    const { SubscriptionPrefsInvalidError } = await import('../../shared/subscription-prefs.js');
    const deps: SubscriptionsMenuDeps = {
      read: (now) => readSubscriptionRoster(h.get, localIsoDay(now)),
      edit: async () => { throw new SubscriptionPrefsInvalidError(); },
      now: () => NOW,
      log: vi.fn(),
    };
    await createSubscriptionsMenu(deps).onCallback({ data: `cz:sb:h:${H('SPOTIFY')}`, chatId: 1 }, h.ui);
    expect(h.ui.answer).toHaveBeenCalledTimes(1);
    expect(h.ui.answer).toHaveBeenCalledWith("Couldn't save that — nothing was changed.");
    expect(h.ui.edit).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('bank names are escaped and never bold', () => {
    const screen = renderSubscriptionDetail({
      key: 'SQ *COFFEE_CLUB', displayName: 'SQ *COFFEE_CLUB', group: 'subscription', source: 'detected',
      cents: 900, cadence: 'monthly', nextDate: '2026-10-15', recent: [], handle: H('SQ *COFFEE_CLUB'),
    });
    expect(screen.text.split('\n')[0]).toBe('SQ \\*COFFEE\\_CLUB');
  });

  it('a name with an emoji at the cut never leaves half of it, on list rows and the report button', async () => {
    const name = `${'a'.repeat(26)}😀bbb`;
    const h = harness({ report_cube: cubeJson([det(name)]) });
    await h.tap(OPEN_SUBSCRIPTIONS);
    const rowLabel = texts((h.ui.send.mock.calls[0] as unknown as [string, any])[1])[0];
    expect(rowLabel).toBe(`${'a'.repeat(26)}😀…`);
    const { hideFromReportButton } = await import('./subscriptions-menu.js');
    const entry = (await readSubscriptionRoster(h.get, '2026-10-12')).roster.subscriptions[0];
    expect(hideFromReportButton(entry).text).toBe(`🙈 Hide ${'a'.repeat(23)}…`);
    expect(hideFromReportButton({ ...entry, displayName: `${'a'.repeat(22)}😀bbb` }).text).toBe(`🙈 Hide ${'a'.repeat(22)}😀…`);
  });

  it('no reminder choices where a reminder can never fire: a watched or overdue entry', async () => {
    const h = harness({
      report_cube: cubeJson([det('NETFLIX', { lastDate: '2026-09-03' })]),
      subscription_prefs: doc({ confirmed: ['WATCHED CO'] }),
    });
    for (const name of ['NETFLIX', 'WATCHED CO']) {
      h.ui.edit.mockClear();
      await h.tap(`cz:sb:d:${H(name)}`);
      const [text, kb] = h.ui.edit.mock.calls[0] as unknown as [string, any];
      expect(text).toContain('Reminders start once a charge date is known.');
      expect(text).not.toContain('Remind:');
      expect(texts(kb)).not.toContain('1d');
      expect(texts(kb)).not.toContain('✓ Off');
    }
  });

  it('a re-read that fails AFTER a good write still answers with the success, from the old list', async () => {
    const h = harness(BASE());
    const deps: SubscriptionsMenuDeps = {
      read: (() => {
        let n = 0;
        return (now: Date) => (++n === 1 ? readSubscriptionRoster(h.get, localIsoDay(now)) : Promise.reject(new Error('ECONNRESET')));
      })(),
      edit: (edit, now) => editSubscriptionPrefs(h.get, h.set, edit, now),
      now: () => NOW,
      log: vi.fn(),
    };
    await createSubscriptionsMenu(deps).onCallback({ data: `cz:sb:r3:${H('SPOTIFY')}`, chatId: 1 }, h.ui);
    expect(h.stored().remind).toEqual({ SPOTIFY: 3 });
    expect(h.ui.answer).toHaveBeenCalledTimes(1);
    expect(h.ui.answer).toHaveBeenCalledWith('Reminder: 3 days before');
    expect(texts((h.ui.edit.mock.calls[0] as unknown as [string, any])[1])).toContain('✓ 3d');
    // The list-returning paths too (Undo of a hide).
    const h2 = harness({ ...BASE(), subscription_prefs: doc({ hidden: ['SPOTIFY'] }) });
    let n = 0;
    await createSubscriptionsMenu({
      read: (now) => (++n === 1 ? readSubscriptionRoster(h2.get, localIsoDay(now)) : Promise.reject(new Error('down'))),
      edit: (edit, now) => editSubscriptionPrefs(h2.get, h2.set, edit, now),
      now: () => NOW,
      log: vi.fn(),
    }).onCallback({ data: `cz:sb:uh:${H('SPOTIFY')}`, chatId: 1 }, h2.ui);
    expect(h2.stored().hidden).toEqual([]);
    expect(h2.ui.answer).toHaveBeenCalledTimes(1);
    expect(h2.ui.answer).toHaveBeenCalledWith('Undone');
  });

  it('ignores data it does not know', async () => {
    const h = harness(BASE());
    await h.tap('cz:sb:zz:nothex!');
    expect(h.ui.answer).toHaveBeenCalledWith();
    expect(h.ui.edit).not.toHaveBeenCalled();
  });
});
