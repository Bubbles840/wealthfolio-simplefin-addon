import { describe, it, expect, vi } from 'vitest';
import {
  acceptLink, addManual, confirmKey, declineLink, deleteManual, editSubscriptionPrefs, emptySubscriptionPrefs,
  hideKey, isUnreadablePrefsError, loadSubscriptionPrefs, newManualId, parseSubscriptionPrefs, pruneDeleted,
  renameKey, restoreDeleted, setRemind, SubscriptionPrefsUnreadableError, SubscriptionPrefsInvalidError,
  SUBSCRIPTION_PREFS_SECRET_KEY, unconfirmKey, undoRename, unhideKey, updateManual, type ManualSubscription,
  type SubscriptionPrefs,
} from './subscription-prefs.js';
import { CONFIRMED_SUBSCRIPTIONS_SECRET_KEY, HIDDEN_SUBSCRIPTIONS_SECRET_KEY } from './subscriptions.js';

const NOW = new Date('2026-10-12T15:00:00Z');
const HULU: ManualSubscription = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' };
const prefs = (over: Partial<SubscriptionPrefs> = {}): SubscriptionPrefs => ({ ...emptySubscriptionPrefs(), ...over });

/** A Map behind get/set, exactly as both hosts' secrets behave: JSON strings. */
const memory = (entries: Record<string, string> = {}) => {
  const data = new Map(Object.entries(entries));
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
  };
};

describe('parseSubscriptionPrefs', () => {
  it.each([null, undefined, '', '   '])('reads %j as absent', (raw) => {
    expect(parseSubscriptionPrefs(raw as string | null | undefined)).toEqual({ kind: 'absent' });
  });

  it.each([
    'not json',
    '[]',
    '{"v":2}',
    '{"hidden":[]}',
    '{"v":1,"hidden":"SPOTIFY"}',
    '{"v":1,"remind":{"SPOTIFY":5}}',
    '{"v":1,"names":{"SPOTIFY":7}}',
    '{"v":1,"manual":[{"id":"x","name":"X","cents":0,"cadence":"monthly","nextDate":"2026-10-20"}]}',
    '{"v":1,"manual":[{"id":"x","name":"X","cents":999,"cadence":"weekly","nextDate":"2026-10-20"}]}',
    '{"v":1,"deleted":[{"id":"x","name":"X","cents":999,"cadence":"monthly","nextDate":"2026-10-20"}]}',
  ])('reads %s as corrupt, never as empty', (raw) => {
    expect(parseSubscriptionPrefs(raw)).toEqual({ kind: 'corrupt' });
  });

  it('fills missing fields with defaults', () => {
    expect(parseSubscriptionPrefs('{"v":1}')).toEqual({ kind: 'ok', prefs: emptySubscriptionPrefs() });
  });

  it('round-trips a full document', () => {
    const doc = prefs({
      hidden: ['QR LIBRARY', 'm:hulu0001'], confirmed: ['RENT LLC'], names: { SPOTIFY: 'Spotify' },
      prevNames: { SPOTIFY: null }, remind: { SPOTIFY: 3 }, manual: [{ ...HULU, merchant: 'HULU' }],
      deleted: [{ ...HULU, id: 'gone0001', deletedAt: '2026-10-10T12:00:00.000Z' }],
      declinedLinks: ['hulu0001|DISNEY PLUS'],
    });
    expect(parseSubscriptionPrefs(JSON.stringify(doc))).toEqual({ kind: 'ok', prefs: doc });
  });
});

describe('loadSubscriptionPrefs', () => {
  it('builds the document from the two legacy settings while none is stored', async () => {
    const { get } = memory({ hidden_subscriptions: '["QR LIBRARY"]', confirmed_subscriptions: '["RENT LLC"]' });
    expect(await loadSubscriptionPrefs(get)).toEqual({
      prefs: prefs({ hidden: ['QR LIBRARY'], confirmed: ['RENT LLC'] }), unreadable: false,
    });
  });

  it('prefers the stored document over the legacy settings', async () => {
    const { get } = memory({
      [SUBSCRIPTION_PREFS_SECRET_KEY]: JSON.stringify(prefs({ hidden: ['NETFLIX'] })),
      hidden_subscriptions: '["QR LIBRARY"]',
    });
    expect((await loadSubscriptionPrefs(get)).prefs.hidden).toEqual(['NETFLIX']);
  });

  it('falls back to the legacy lists, flagged unreadable, when the document is corrupt', async () => {
    const { get } = memory({ [SUBSCRIPTION_PREFS_SECRET_KEY]: '{"v":1,"hidden":', hidden_subscriptions: '["QR LIBRARY"]' });
    expect(await loadSubscriptionPrefs(get)).toEqual({ prefs: prefs({ hidden: ['QR LIBRARY'] }), unreadable: true });
  });

  it('lets a failed read reject — unreachable is not empty', async () => {
    await expect(loadSubscriptionPrefs(async () => { throw new Error('ECONNREFUSED'); })).rejects.toThrow('ECONNREFUSED');
  });
});

describe('editSubscriptionPrefs', () => {
  it('re-reads right before writing, so a change made elsewhere since is kept', async () => {
    const m = memory({ [SUBSCRIPTION_PREFS_SECRET_KEY]: JSON.stringify(prefs({ hidden: ['NETFLIX'] })) });
    // A view taken earlier, before another writer changed the stored document.
    const seen = await loadSubscriptionPrefs(m.get);
    expect(seen.prefs.hidden).toEqual(['NETFLIX']);
    m.data.set(SUBSCRIPTION_PREFS_SECRET_KEY, JSON.stringify(prefs({ hidden: ['NETFLIX', 'HULU'] })));
    m.get.mockClear();
    const written = await editSubscriptionPrefs(m.get, m.set, (p) => hideKey(p, 'SPOTIFY'), NOW);
    // The write is based on the latest stored copy, not on the stale view.
    expect(written.hidden).toEqual(['NETFLIX', 'HULU', 'SPOTIFY']);
    expect(m.get).toHaveBeenCalledTimes(1);
    expect(JSON.parse(m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY)!)).toEqual(written);
  });

  it('refuses an edit whose result the parser would not read back — nothing is written', async () => {
    const m = memory();
    const seeded = addManual(prefs(), HULU);
    m.data.set(SUBSCRIPTION_PREFS_SECRET_KEY, JSON.stringify(seeded));
    const before = m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY);
    for (const cents of [0, Number.NaN]) {
      m.set.mockClear();
      await expect(editSubscriptionPrefs(m.get, m.set, (p) => updateManual(p, 'hulu0001', { cents }), NOW))
        .rejects.toBeInstanceOf(SubscriptionPrefsInvalidError);
      expect(m.set).not.toHaveBeenCalled();
      expect(m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY)).toBe(before);
    }
  });

  it('refuses an impossible calendar day in a hand-added entry', async () => {
    for (const nextDate of ['2026-02-31', '2026-13-45']) {
      const raw = JSON.stringify(prefs({ manual: [{ ...HULU, nextDate }] }));
      expect(parseSubscriptionPrefs(raw)).toEqual({ kind: 'corrupt' });
    }
    expect(parseSubscriptionPrefs(JSON.stringify(prefs({ manual: [{ ...HULU, nextDate: '2028-02-29' }] }))).kind).toBe('ok');
  });

  it('mirror writes are independent: a failed hidden write still writes the confirmed legacy key', async () => {
    const m = memory();
    m.set.mockImplementation(async (k: string, v: string) => {
      if (k === HIDDEN_SUBSCRIPTIONS_SECRET_KEY) throw new Error('hidden mirror down');
      m.data.set(k, v);
    });
    await editSubscriptionPrefs(m.get, m.set, (p) => confirmKey(p, 'RENT LLC'), NOW);
    expect(m.data.get(CONFIRMED_SUBSCRIPTIONS_SECRET_KEY)).toBe('["RENT LLC"]');
  });

  it('imports the legacy lists on the first write and mirrors the result back into them', async () => {
    const m = memory({ hidden_subscriptions: '["QR LIBRARY"]', confirmed_subscriptions: '["RENT LLC"]' });
    await editSubscriptionPrefs(m.get, m.set, (p) => hideKey(p, 'SPOTIFY'), NOW);
    expect(JSON.parse(m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY)!))
      .toMatchObject({ hidden: ['QR LIBRARY', 'SPOTIFY'], confirmed: ['RENT LLC'] });
    expect(m.data.get('hidden_subscriptions')).toBe('["QR LIBRARY","SPOTIFY"]');
    expect(m.data.get('confirmed_subscriptions')).toBe('["RENT LLC"]');
  });

  it('refuses to write over a corrupt document — nothing is touched', async () => {
    const m = memory({ [SUBSCRIPTION_PREFS_SECRET_KEY]: '{"v":1,"hidden":' });
    await expect(editSubscriptionPrefs(m.get, m.set, (p) => hideKey(p, 'SPOTIFY'), NOW))
      .rejects.toBeInstanceOf(SubscriptionPrefsUnreadableError);
    expect(m.set).not.toHaveBeenCalled();
    expect(m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY)).toBe('{"v":1,"hidden":');
  });

  it('keeps hand-added keys out of the legacy mirror — an older reader would take them for merchants', async () => {
    const m = memory();
    await editSubscriptionPrefs(m.get, m.set, (p) => hideKey(hideKey(p, 'm:hulu0001'), 'SPOTIFY'), NOW);
    expect(m.data.get('hidden_subscriptions')).toBe('["SPOTIFY"]');
  });

  it('a failed mirror does not fail a committed edit', async () => {
    const m = memory();
    m.set.mockImplementation(async (k: string, v: string) => {
      if (k !== SUBSCRIPTION_PREFS_SECRET_KEY) throw new Error('mirror down');
      m.data.set(k, v);
    });
    await expect(editSubscriptionPrefs(m.get, m.set, (p) => hideKey(p, 'SPOTIFY'), NOW))
      .resolves.toMatchObject({ hidden: ['SPOTIFY'] });
    expect(JSON.parse(m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY)!).hidden).toEqual(['SPOTIFY']);
  });

  it('prunes week-old deletions on every write', async () => {
    const old = { ...HULU, id: 'old00001', deletedAt: '2026-10-01T12:00:00.000Z' };
    const m = memory({ [SUBSCRIPTION_PREFS_SECRET_KEY]: JSON.stringify(prefs({ deleted: [old] })) });
    expect((await editSubscriptionPrefs(m.get, m.set, (p) => p, NOW)).deleted).toEqual([]);
  });
});

describe('edits', () => {
  it('hide and unhide are idempotent', () => {
    const once = hideKey(prefs(), 'SPOTIFY');
    expect(hideKey(once, 'SPOTIFY').hidden).toEqual(['SPOTIFY']);
    expect(unhideKey(once, 'SPOTIFY').hidden).toEqual([]);
    expect(unhideKey(prefs(), 'SPOTIFY').hidden).toEqual([]);
  });

  it('confirm and unconfirm', () => {
    const yes = confirmKey(prefs(), 'MYSTERY BOX');
    expect(yes.confirmed).toEqual(['MYSTERY BOX']);
    expect(confirmKey(yes, 'MYSTERY BOX').confirmed).toEqual(['MYSTERY BOX']);
    expect(unconfirmKey(yes, 'MYSTERY BOX').confirmed).toEqual([]);
  });

  it('rename keeps one level of history for Undo', () => {
    const first = renameKey(prefs(), 'SPOTIFY', '  Spotify ');
    expect(first.names).toEqual({ SPOTIFY: 'Spotify' });
    expect(first.prevNames).toEqual({ SPOTIFY: null });
    const second = renameKey(first, 'SPOTIFY', 'Spotify Duo');
    expect(second.prevNames).toEqual({ SPOTIFY: 'Spotify' });
    const undone = undoRename(second, 'SPOTIFY');
    expect(undone.names).toEqual({ SPOTIFY: 'Spotify' });
    expect(undone.prevNames).toEqual({});
    expect(undoRename(first, 'SPOTIFY').names).toEqual({});
    expect(undoRename(prefs(), 'SPOTIFY')).toEqual(prefs());
  });

  it('a blank rename changes nothing', () => {
    expect(renameKey(prefs(), 'SPOTIFY', '   ')).toEqual(prefs());
  });

  it('sets and clears a reminder', () => {
    const on = setRemind(prefs(), 'SPOTIFY', 3);
    expect(on.remind).toEqual({ SPOTIFY: 3 });
    expect(setRemind(on, 'SPOTIFY', null).remind).toEqual({});
  });

  it('adds and updates a hand-added entry', () => {
    const added = addManual(prefs(), HULU);
    expect(added.manual).toEqual([HULU]);
    expect(updateManual(added, 'hulu0001', { cents: 1099, cadence: 'yearly', nextDate: '2027-01-05' }).manual)
      .toEqual([{ ...HULU, cents: 1099, cadence: 'yearly', nextDate: '2027-01-05' }]);
  });

  it('delete leaves a tombstone that restore brings back', () => {
    const gone = deleteManual(addManual(prefs(), HULU), 'hulu0001', NOW);
    expect(gone.manual).toEqual([]);
    expect(gone.deleted).toEqual([{ ...HULU, deletedAt: '2026-10-12T15:00:00.000Z' }]);
    const back = restoreDeleted(gone, 'hulu0001');
    expect(back.manual).toEqual([HULU]);
    expect(back.deleted).toEqual([]);
  });

  it('accepting a link sets the merchant and next date, and moves hide and reminder to the hand-added key', () => {
    const before = prefs({ manual: [HULU], hidden: ['HULU'], remind: { HULU: 3 } });
    const after = acceptLink(before, { manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-08' });
    expect(after.manual).toEqual([{ ...HULU, merchant: 'HULU', nextDate: '2026-11-08' }]);
    expect(after.hidden).toEqual(['m:hulu0001']);
    expect(after.remind).toEqual({ 'm:hulu0001': 3 });
  });

  it('a yearly link moves the next date a year on', () => {
    const yearly = { ...HULU, cadence: 'yearly' as const };
    expect(acceptLink(prefs({ manual: [yearly] }), { manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-08' })
      .manual[0].nextDate).toBe('2027-10-08');
  });

  it("a link keeps the hand-added entry's own reminder over the merchant's", () => {
    const after = acceptLink(
      prefs({ manual: [HULU], remind: { HULU: 7, 'm:hulu0001': 1 } }),
      { manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-08' },
    );
    expect(after.remind).toEqual({ 'm:hulu0001': 1 });
  });

  it('declining remembers the pair once', () => {
    expect(declineLink(declineLink(prefs(), 'hulu0001', 'HULU'), 'hulu0001', 'HULU').declinedLinks)
      .toEqual(['hulu0001|HULU']);
  });

  it('pruning drops week-old tombstones with everything keyed to them', () => {
    const fresh = { ...HULU, id: 'new00001', deletedAt: '2026-10-06T15:00:00.000Z' };
    const old = { ...HULU, id: 'old00001', deletedAt: '2026-10-04T15:00:00.000Z' };
    const pruned = pruneDeleted(prefs({
      deleted: [fresh, old],
      names: { 'm:old00001': 'Old', 'm:new00001': 'New' }, remind: { 'm:old00001': 3 },
      hidden: ['m:old00001'], declinedLinks: ['old00001|HULU', 'new00001|HULU'],
    }), NOW);
    expect(pruned.deleted).toEqual([fresh]);
    expect(pruned.names).toEqual({ 'm:new00001': 'New' });
    expect(pruned.remind).toEqual({});
    expect(pruned.hidden).toEqual([]);
    expect(pruned.declinedLinks).toEqual(['new00001|HULU']);
  });

  it('makes 8-character ids', () => {
    expect(newManualId(() => 0.5)).toBe('iiiiiiii');
    expect(newManualId()).toMatch(/^[0-9a-z]{8}$/);
  });

  it('recognises the refusal by class or by name', () => {
    expect(isUnreadablePrefsError(new SubscriptionPrefsUnreadableError())).toBe(true);
    expect(isUnreadablePrefsError({ name: 'SubscriptionPrefsUnreadableError' })).toBe(true);
    expect(isUnreadablePrefsError(new Error('x'))).toBe(false);
  });
});

describe('key lookups and same-name renames', () => {
  it('a key named constructor is looked up as data, not as an inherited property', () => {
    const renamed = renameKey(prefs(), 'constructor', 'Gym');
    expect(renamed.prevNames).toEqual({ constructor: null });
    expect(undoRename(renamed, 'constructor')).toEqual(prefs());
    expect(undoRename(prefs(), 'constructor')).toEqual(prefs());
    expect(acceptLink(prefs({ manual: [HULU], remind: { constructor: 3 as const } }),
      { manualId: 'hulu0001', merchant: 'constructor', date: '2026-10-08' }).remind).toEqual({ 'm:hulu0001': 3 });
    expect(acceptLink(prefs({ manual: [HULU] }), { manualId: 'hulu0001', merchant: 'constructor', date: '2026-10-08' })
      .remind).toEqual({});
  });

  it('a rename to the name already shown changes nothing, keeping Undo history', () => {
    const first = renameKey(prefs(), 'SPOTIFY', 'Spotify');
    const second = renameKey(first, 'SPOTIFY', ' Spotify ');
    expect(second).toBe(first);
    expect(second.prevNames).toEqual({ SPOTIFY: null });
  });
});

describe('pruneDeleted edges', () => {
  it('keeps an entry exactly 7 days old and prunes one with an unparseable deletedAt', () => {
    const exact = { ...HULU, id: 'edge0001', deletedAt: '2026-10-05T15:00:00.000Z' };
    const broken = { ...HULU, id: 'bad00001', deletedAt: 'not a date' };
    const pruned = pruneDeleted(prefs({ deleted: [exact, broken] }), NOW);
    expect(pruned.deleted).toEqual([exact]);
  });
});
