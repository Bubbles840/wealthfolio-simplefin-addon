import { describe, it, expect, vi } from 'vitest';
import type { HealthIssue, HealthLeg } from './audit-health';
import {
  checkLinkPair, legFingerprint, linkablePair, linkablePairs, linkPairs, linkRunLine, pairHandle, pairsHandle,
  LINK_CARD_OUT, LINK_CHANGED, LINK_DONE, LINK_DROPPED, LINK_UNKNOWN_ACCOUNT, LINK_UNREACHABLE, type LinkIo, type LinkPair, type ReadRow,
} from './audit-link';
import type { ChangeDraft } from './change-entries';
import type { FixRow } from './fix-row';
import type { LinkLeg } from './sync-host';
import { emptySyncOverrides, setTxOverride, SYNC_OVERRIDES_UNREADABLE_MESSAGE } from './sync-overrides';
import { accountTxKey } from './transfers';

const NOW = new Date('2026-10-14T15:00:00Z');
const OUT_KEY = accountTxKey('sfin-chk', 'TRN-1');
const IN_KEY = accountTxKey('sfin-ally', 'TRN-2');
const LEG: HealthLeg = {
  activityId: 'out-1', accountId: 'wf-chk', accountName: 'PNC Checking', txKey: OUT_KEY, date: '2026-10-04', absCents: 60000,
  type: 'TRANSFER_OUT', currency: 'USD', description: 'TRANSFER TO ALLY',
};
const OTHER: HealthLeg = {
  activityId: 'in-1', accountId: 'wf-ally', accountName: 'Ally Savings', txKey: IN_KEY, date: '2026-10-05', absCents: 60000,
  type: 'DEPOSIT', currency: 'USD', description: 'FROM PNC',
};
const issue = (over: Partial<Extract<HealthIssue, { kind: 'incomplete-leg' }>> = {}): HealthIssue => ({
  kind: 'incomplete-leg', key: 'leg:out-1', leg: LEG, problem: null, owner: 'you', match: 'one', counterpart: OTHER, ...over,
});
const PAIR: LinkPair = { key: 'leg:out-1', leg: LEG, counterpart: OTHER };

/** A row as a host re-reads it, the way its Health leg showed it. */
const row = (l: HealthLeg, over: Partial<FixRow> = {}): FixRow => ({
  id: l.activityId, accountId: l.accountId, accountName: l.accountName, accountType: 'CASH', type: l.type, date: l.date,
  absCents: l.absCents, feeCents: 0, currency: 'USD', notes: `${l.description} · ${l.txKey!.split('\u0000')[1]}`,
  subtype: null, flowExternal: null, grouped: false, ...over,
});
const read = (a: Partial<FixRow> = {}, b: Partial<FixRow> = {}): [ReadRow, ReadRow] => [
  { row: row(LEG, a), linked: false }, { row: row(OTHER, b), linked: false },
];
const none = emptySyncOverrides();

/** Pair i: its own ids, keys and amount. */
const pairN = (i: number): LinkPair => ({
  key: `leg:out-${i}`,
  leg: { ...LEG, activityId: `out-${i}`, txKey: accountTxKey('sfin-chk', `TRN-o${i}`), absCents: 1000 + i },
  counterpart: { ...OTHER, activityId: `in-${i}`, txKey: accountTxKey('sfin-ally', `TRN-i${i}`), absCents: 1000 + i },
});

function fakeIo(over: Partial<LinkIo> = {}) {
  const links: Array<[LinkLeg, LinkLeg]> = [];
  const recorded: ChangeDraft[] = [];
  const io: LinkIo = {
    read: vi.fn(async (p: LinkPair): Promise<[ReadRow, ReadRow]> => [{ row: row(p.leg), linked: false }, { row: row(p.counterpart), linked: false }]),
    overrides: vi.fn(async () => ({ overrides: none, unreadable: false })),
    link: vi.fn(async (legs: [LinkLeg, LinkLeg]) => {
      links.push(legs);
      return { linked: true, groupId: `wf-transfer-${links.length}`, activityIds: [`new-${legs[0].wfId}`, `new-${legs[1].wfId}`] as [string, string] };
    }),
    restore: vi.fn(async () => ({ created: [], updated: [], errors: [] })),
    remember: vi.fn(async () => {}),
    record: vi.fn(async (d: ChangeDraft) => { recorded.push(d); }),
    log: vi.fn(),
    ...over,
  };
  return { io, links, recorded };
}

describe('what the Health list offers to link', () => {
  it('offers a leg of yours, not linked at all, with exactly one other half, both from the bank feed', () => {
    expect(linkablePair(issue())).toEqual(PAIR);
    for (const over of [
      { owner: 'add-on' as const }, { match: 'many' as const, counterpart: null }, { problem: { kind: 'legs' as const, count: 1 } },
      { counterpart: null }, { leg: { ...LEG, txKey: null } }, { counterpart: { ...OTHER, txKey: null } },
    ]) {
      expect(linkablePair(issue(over))).toBeNull();
    }
    const late: HealthIssue = { kind: 'late-start', key: 'late-start:s', activityId: 's', accountId: 'a', accountName: 'A', date: '2026-10-02', earliest: '2026-10-01', cents: 1 };
    expect(linkablePairs([issue(), late, issue({ owner: 'add-on' })])).toEqual([PAIR]);
    expect(linkablePairs(null)).toEqual([]);
  });

  it('fingerprints what was shown: the handle moves when a leg’s account, amount, date or type does', () => {
    expect(pairHandle(PAIR)).toMatch(/^[0-9a-f]{16}$/);
    expect(pairsHandle([PAIR, pairN(2)])).toMatch(/^[0-9a-f]{8}$/);
    for (const over of [{ accountId: 'x' }, { absCents: 1 }, { date: '2026-10-06' }, { type: 'TRANSFER_IN' }]) {
      expect(legFingerprint({ ...LEG, ...over })).not.toBe(legFingerprint(LEG));
    }
    const renamed: HealthLeg = { ...LEG, description: 'renamed' };
    expect(legFingerprint(renamed)).toBe(legFingerprint(LEG));
    expect(pairsHandle([PAIR, pairN(2)])).not.toBe(pairsHandle([PAIR, pairN(3)]));
  });
});

describe('checkLinkPair', () => {
  it('links money out first, a counterpart stored as ordinary money typed as the transfer it is, each with its own note', () => {
    expect(checkLinkPair(PAIR, read(), none)).toEqual({
      ok: true,
      legs: [
        { wfId: 'out-1', accountId: 'wf-chk', txId: 'TRN-1', activityType: 'TRANSFER_OUT', date: '2026-10-04', absCents: 60000, currency: 'USD', comment: 'TRANSFER TO ALLY · TRN-1' },
        { wfId: 'in-1', accountId: 'wf-ally', txId: 'TRN-2', activityType: 'TRANSFER_IN', date: '2026-10-05', absCents: 60000, currency: 'USD', comment: 'FROM PNC · TRN-2' },
      ],
      rows: [row(LEG), row(OTHER)],
      keys: [OUT_KEY, IN_KEY],
    });
    // A card payment: the leg is the card's money in, the counterpart the checking withdrawal.
    const card: LinkPair = {
      key: 'leg:in-9',
      leg: { ...OTHER, activityId: 'in-9', type: 'TRANSFER_IN', accountId: 'wf-card' },
      counterpart: { ...LEG, activityId: 'out-9', type: 'WITHDRAWAL' },
    };
    const check = checkLinkPair(card, [{ row: row(card.leg, { accountType: 'CREDIT_CARD' }), linked: false }, { row: row(card.counterpart), linked: false }], none);
    expect(check.ok && check.legs.map((l) => [l.wfId, l.activityType])).toEqual([['out-9', 'TRANSFER_OUT'], ['in-9', 'TRANSFER_IN']]);
  });

  it.each([
    ['gone', [null, read()[1]]],
    ['moved to another account', read({ accountId: 'wf-other' })],
    ['a new amount', read({}, { absCents: 59999 })],
    ['a new date', read({ date: '2026-10-03' })],
    ['a new type', read({}, { type: 'CREDIT' })],
    ['pending', read({ notes: 'TRANSFER TO ALLY · TRN-1 · pending' })],
    ['an in-transit placeholder', read({ notes: '↔️ In-transit transfer · TRANSFER TO ALLY · TRN-1' })],
    ['an opening balance', read({}, { notes: 'Starting balance · sfin-ally' })],
    ['a correction', read({}, { notes: 'Balance adjustment · sfin-ally · 2026-10-05' })],
    ['a different bank transaction', read({ notes: 'TRANSFER TO ALLY · TRN-77' })],
  ] as Array<[string, [ReadRow | null, ReadRow | null]]>)('refuses a row that is %s', (_why, now) => {
    expect(checkLinkPair(PAIR, now, none)).toEqual({ ok: false, reason: LINK_CHANGED });
  });

  it('refuses a row that is linked, or may be, and a leg you said is not a transfer', () => {
    const [a, b] = read();
    expect(checkLinkPair(PAIR, [{ ...a, linked: 'confirmed' }, b], none)).toEqual({ ok: false, reason: LINK_CHANGED });
    expect(checkLinkPair(PAIR, [a, { ...b, linked: 'maybe' }], none)).toEqual({ ok: false, reason: LINK_CHANGED });
    const told = setTxOverride(none, IN_KEY, 'notTransfer', NOW, { label: 'FROM PNC · Ally Savings' });
    expect(checkLinkPair(PAIR, read(), told)).toEqual({ ok: false, reason: LINK_CHANGED });
  });

  it('refuses money leaving a card unless the card already stores it as a transfer out (Wealthfolio 3.10)', () => {
    const fromCard: LinkPair = {
      key: 'leg:in-c', leg: { ...OTHER, activityId: 'in-c', type: 'TRANSFER_IN' }, counterpart: { ...LEG, activityId: 'out-c', accountId: 'wf-card', type: 'WITHDRAWAL' },
    };
    const now = (type: string): [ReadRow, ReadRow] => [
      { row: row(fromCard.leg), linked: false },
      { row: row({ ...fromCard.counterpart, type }, { accountType: 'CREDIT_CARD' }), linked: false },
    ];
    expect(checkLinkPair(fromCard, now('WITHDRAWAL'), none)).toEqual({ ok: false, reason: LINK_CARD_OUT });
    const stored = { ...fromCard, counterpart: { ...fromCard.counterpart, type: 'TRANSFER_OUT' } };
    expect(checkLinkPair(stored, now('TRANSFER_OUT'), none)).toEqual({ ok: false, reason: LINK_CARD_OUT });
  });

  it('refuses when either account type is unknown, and a row whose currency changed', () => {
    const [a, b] = read();
    expect(checkLinkPair(PAIR, [{ ...a, row: { ...a.row, accountType: '' } }, b], none)).toEqual({ ok: false, reason: LINK_UNKNOWN_ACCOUNT });
    expect(checkLinkPair(PAIR, [a, { ...b, row: { ...b.row, accountType: '' } }], none)).toEqual({ ok: false, reason: LINK_UNKNOWN_ACCOUNT });
    expect(checkLinkPair(PAIR, read({}, { currency: 'EUR' }), none)).toEqual({ ok: false, reason: LINK_CHANGED });
  });
});

describe('linkPairs', () => {
  it('links one pair, records it as yours with both legs, remembers it, and says "Linked."', async () => {
    const f = fakeIo();
    expect(await linkPairs([PAIR], f.io)).toEqual({ total: 1, linked: 1, changed: 0, failed: 0, done: ['leg:out-1'], lost: [], message: LINK_DONE });
    expect(f.links).toHaveLength(1);
    expect(f.io.remember).toHaveBeenCalledWith([OUT_KEY, IN_KEY], 'wf-transfer-1');
    expect(f.recorded[0]).toMatchObject({
      actor: 'you', kind: 'transfer-link', undoable: true, summary: 'Linked TRANSFER TO ALLY and FROM PNC as one transfer',
      subject: { txKeys: [OUT_KEY, IN_KEY], activityIds: ['new-out-1', 'new-in-1'], amountCents: -60000 },
      before: { activityIds: ['out-1', 'in-1'] },
      after: { legs: [{ accountName: 'PNC Checking', sfinAccountId: 'sfin-chk' }, { accountName: 'Ally Savings', sfinAccountId: 'sfin-ally' }] },
    });
  });

  it('writes nothing for a row that changed between the snapshot and the click', async () => {
    const f = fakeIo({ read: vi.fn(async () => read({}, { absCents: 61000 })) });
    expect((await linkPairs([PAIR], f.io)).message).toBe(LINK_CHANGED);
    expect(f.io.link).not.toHaveBeenCalled();
    expect(f.io.record).not.toHaveBeenCalled();
  });

  it.each([
    ['a pending leg', { read: vi.fn(async () => read({ notes: 'TRANSFER TO ALLY · TRN-1 · pending' })) }],
    ['a row the add-on cannot rule out as linked', { read: vi.fn(async () => { const [a, b] = read(); return [a, { ...b, linked: 'maybe' }] as [ReadRow, ReadRow]; }) }],
    ['a notTransfer override', { overrides: vi.fn(async () => ({ overrides: setTxOverride(none, OUT_KEY, 'notTransfer', NOW), unreadable: false })) }],
  ] as Array<[string, Partial<LinkIo>]>)('refuses %s and writes nothing', async (_why, over) => {
    const f = fakeIo(over);
    expect((await linkPairs([PAIR], f.io)).message).toBe(LINK_CHANGED);
    expect(f.io.link).not.toHaveBeenCalled();
  });

  it('Link all goes on past a pair that changed and one that failed, and counts each', async () => {
    const pairs = [pairN(1), pairN(2), pairN(3), pairN(4)];
    const f = fakeIo({
      read: vi.fn(async (p: LinkPair): Promise<[ReadRow, ReadRow]> => [
        { row: row(p.leg, p.key === 'leg:out-2' ? { absCents: 1 } : {}), linked: false }, { row: row(p.counterpart), linked: false },
      ]),
    });
    const link = f.io.link;
    f.io.link = vi.fn(async (legs: [LinkLeg, LinkLeg]) => {
      if (legs[0].wfId === 'out-3') throw new Error('socket hang up');
      return link(legs);
    });
    const run = await linkPairs(pairs, f.io);
    expect(run).toMatchObject({ total: 4, linked: 2, changed: 1, failed: 1, done: ['leg:out-1', 'leg:out-4'] });
    expect(run.message).toBe("Linked 2 of 4 — 1 had changed since, 1 couldn't be linked.");
    expect(f.links.map((l) => l[0].wfId)).toEqual(['out-1', 'out-4']);
    expect(f.recorded).toHaveLength(2);
  });

  it('words a run', () => {
    expect(linkRunLine({ total: 4, linked: 3, changed: 1, failed: 0 })).toBe('Linked 3 of 4 — 1 had changed since.');
    expect(linkRunLine({ total: 3, linked: 3, changed: 0, failed: 0 })).toBe('Linked all 3.');
    expect(linkRunLine({ total: 1, linked: 1, changed: 0, failed: 0 })).toBe(LINK_DONE);
    expect(linkRunLine({ total: 0, linked: 0, changed: 0, failed: 0 })).toBe(LINK_CHANGED);
  });

  /** The state a refused or thrown re-create leaves: both rows deleted. */
  const goneIo = (over: Partial<LinkIo>) => fakeIo({ read: vi.fn()
    .mockImplementationOnce(async (p: LinkPair) => [{ row: row(p.leg), linked: false }, { row: row(p.counterpart), linked: false }])
    .mockImplementation(async () => [null, null]), ...over });
  const OUT_WRITE = { accountId: 'wf-chk', activityType: 'TRANSFER_OUT', activityDate: '2026-10-04', amount: 600, currency: 'USD', comment: 'TRANSFER TO ALLY · TRN-1' };
  const IN_WRITE = { accountId: 'wf-ally', activityType: 'DEPOSIT', activityDate: '2026-10-05', symbol: { symbol: '$CASH-USD' }, amount: 600, currency: 'USD', comment: 'FROM PNC · TRN-2' };

  it('puts both rows back exactly when Wealthfolio refuses the re-create after the delete went through', async () => {
    const f = goneIo({ link: vi.fn(async () => ({ linked: false, problems: ['save (create): not supported for this account'] })) });
    const run = await linkPairs([PAIR], f.io);
    expect(run.message).toBe('Wealthfolio refused the link (not supported for this account). Both rows are back, with new ids. Their categories may need filing again.');
    expect(f.io.restore).toHaveBeenCalledWith([OUT_WRITE, IN_WRITE]);
    expect(f.io.record).not.toHaveBeenCalled();
    const kept = fakeIo({ link: vi.fn(async () => ({ linked: false, problems: ['delete (delete): not found', 'save (create): no'] })) });
    expect((await linkPairs([PAIR], kept.io)).message).toBe("Couldn't link them: delete (delete): not found.");
    expect(kept.io.restore).not.toHaveBeenCalled();
  });

  it('a THROWN re-create (the SDK, a 502 between the requests) writes back whichever rows are gone', async () => {
    const f = goneIo({ link: vi.fn(async () => { throw new Error('502 bad gateway.'); }) });
    expect((await linkPairs([PAIR], f.io)).message).toBe('Wealthfolio refused the link (502 bad gateway). Both rows are back, with new ids. Their categories may need filing again.');
    expect(f.io.restore).toHaveBeenCalledWith([OUT_WRITE, IN_WRITE]);
    // Only one gone: only that one is written back.
    const one = fakeIo({
      read: vi.fn().mockImplementationOnce(async (p: LinkPair) => [{ row: row(p.leg), linked: false }, { row: row(p.counterpart), linked: false }])
        .mockImplementation(async (p: LinkPair) => [null, { row: row(p.counterpart), linked: false }]),
      link: vi.fn(async () => { throw new Error('boom'); }),
    });
    expect((await linkPairs([PAIR], one.io)).message).toMatch(/^Wealthfolio refused the link \(boom\)\. The deleted row is back/);
    expect(one.io.restore).toHaveBeenCalledWith([OUT_WRITE]);
    // Both still there: nothing restored, said honestly.
    const there = fakeIo({ link: vi.fn(async () => { throw new Error('socket hang up'); }) });
    expect((await linkPairs([PAIR], there.io)).message).toBe("Couldn't link them: socket hang up. Check both accounts in Wealthfolio.");
    expect(there.io.restore).not.toHaveBeenCalled();
  });

  it('names each lost row, in the message, the log and the run, when the write-back fails or throws', async () => {
    const lostText = 'PNC Checking 2026-10-04 600.00 "TRANSFER TO ALLY · TRN-1"; Ally Savings 2026-10-05 600.00 "FROM PNC · TRN-2"';
    for (const restore of [
      vi.fn(async () => ({ created: [], updated: [], errors: [{ action: 'create', message: 'down' }] })),
      vi.fn(async () => { throw new Error('down'); }),
    ]) {
      const f = goneIo({ link: vi.fn(async () => { throw new Error('boom'); }), restore });
      const run = await linkPairs([PAIR], f.io);
      expect(run.message).toBe(`Wealthfolio refused the link (boom), and the two rows couldn't be put back. Deleted and not restored: ${lostText}. The next sync brings back any the bank still sends.`);
      expect(run.lost).toHaveLength(2);
      const logged = (f.io.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).join('\n');
      expect(logged).toContain('deleted and not restored');
      expect(logged).toContain('"activityType":"TRANSFER_OUT"');
    }
    // Link all says plainly which rows were deleted and not restored.
    const f = fakeIo();
    const calls = { n: 0 };
    f.io.read = vi.fn(async (p: LinkPair) => (p.key === 'leg:out-2' && calls.n++ > 0 ? [null, null] : [{ row: row(p.leg), linked: false }, { row: row(p.counterpart), linked: false }])) as unknown as LinkIo['read'];
    f.io.link = vi.fn(async (legs: [LinkLeg, LinkLeg]) => { if (legs[0].wfId === 'out-2') throw new Error('boom'); return { linked: true, groupId: 'g', activityIds: ['a', 'b'] as [string, string] }; });
    f.io.restore = vi.fn(async () => { throw new Error('down'); });
    const run = await linkPairs([pairN(1), pairN(2)], f.io);
    expect(run.message).toMatch(/^Linked 1 of 2 — 1 couldn't be linked\. Deleted and not restored: PNC Checking 2026-10-04 10\.02 .*; Ally Savings .*\.$/);
    expect(linkRunLine({ total: 2, linked: 1, changed: 0, failed: 1, lost: ['x'] })).toBe("Linked 1 of 2 — 1 couldn't be linked. Deleted and not restored: x.");
  });

  it('says plainly when both rows were re-created but Wealthfolio kept no group, and records it', async () => {
    const f = fakeIo({ link: vi.fn(async () => ({ linked: false, problems: ['the host stored no shared group for both legs (got none / none)'] })) });
    expect((await linkPairs([PAIR], f.io)).message).toBe(LINK_DROPPED);
    expect(f.io.restore).not.toHaveBeenCalled();
    expect(f.recorded[0]).toMatchObject({ kind: 'bookkeeping', undoable: false, subject: { txKeys: [OUT_KEY, IN_KEY] } });
  });

  it('never lets the log or the ledger cost the link', async () => {
    const f = fakeIo({ record: vi.fn(async () => { throw new Error('log down'); }), remember: vi.fn(async () => { throw new Error('ledger corrupt'); }) });
    expect((await linkPairs([PAIR], f.io)).message).toBe(LINK_DONE);
    expect(f.io.log).toHaveBeenCalledTimes(2);
  });

  it('reads and writes nothing when the overrides cannot be read', async () => {
    const f = fakeIo({ overrides: vi.fn(async () => ({ overrides: none, unreadable: true })) });
    expect((await linkPairs([PAIR, pairN(2)], f.io)).message).toBe(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
    expect(f.io.read).not.toHaveBeenCalled();
    const down = fakeIo({ overrides: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect((await linkPairs([PAIR], down.io)).message).toBe(LINK_UNREACHABLE);
  });
});
