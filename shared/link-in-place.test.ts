import { describe, it, expect } from 'vitest';
import type { UnlinkLeg } from './link-pair.js';
import {
  HALF_OF_ANOTHER_TRANSFER, inPlaceRefusal, ledgerGroupId, unlinkInPlaceRefusal, linkPairPreferInPlace, storedLegOf, unlinkPairPreferInPlace, type InPlaceIo,
} from './link-in-place.js';
import type { ActivityWrite, LinkLeg, SaveManyRequest, SaveManyResult } from './sync-host.js';

interface Row {
  id: string; accountId: string; activityType: string; date: string; amount: string; currency: string; comment: string;
  assetId?: string; subtype?: string; fee?: string; sourceGroupId: string | null; metadata: string | null;
}

const OUT_LEG: LinkLeg = {
  wfId: 'out-1', accountId: 'wf-chk', txId: 'TRN-1', activityType: 'TRANSFER_OUT', date: '2026-10-08', absCents: 46460, currency: 'USD', comment: 'CITI AUTOPAY · TRN-1',
};
const IN_LEG: LinkLeg = {
  wfId: 'in-1', accountId: 'wf-card', txId: 'TRN-2', activityType: 'TRANSFER_IN', date: '2026-10-09', absCents: 46460, currency: 'USD', comment: 'PAYMENT THANK YOU · TRN-2',
};
/** A row stored the way the sync writes the leg (noon UTC on the bank's day). */
const stored = (leg: LinkLeg, over: Partial<Row> = {}): Row => ({
  id: leg.wfId, accountId: leg.accountId, activityType: leg.activityType, date: `${leg.date}T12:00:00.000Z`, amount: '464.60', currency: 'USD',
  comment: leg.comment, sourceGroupId: null, metadata: null, ...over,
});

/**
 * Wealthfolio in memory: the exact-id read, its link and unlink (one
 * transaction each; a refusal writes nothing), and the bulk endpoint.
 */
function wealthfolio(rows: Row[], opts: { refuseLink?: string; loseLinkAnswer?: boolean; refuseUnlink?: string; loseUnlinkAnswer?: boolean; refuseUpdate?: string; throwUpdate?: 'landed' | 'lost'; failReadsFrom?: number } = {}) {
  let n = 0;
  const calls: string[] = [];
  const asSearch = (r: Row) => ({
    id: r.id, accountId: r.accountId, activityType: r.activityType, date: r.date, amount: r.amount, currency: r.currency, comment: r.comment,
    assetId: r.assetId ?? '', subtype: r.subtype ?? null, fee: r.fee ?? '0', sourceGroupId: r.sourceGroupId, metadata: r.metadata ? JSON.parse(r.metadata) : null,
  });
  const flow = (r: Row, external: boolean) => JSON.stringify({ ...(r.metadata ? JSON.parse(r.metadata) : {}), flow: { is_external: external } });
  const logs: string[] = [];
  let reads = 0;
  const io: InPlaceIo = {
    log: (m) => { logs.push(m); },
    read: async (ids) => {
      calls.push('read');
      if (opts.failReadsFrom !== undefined && ++reads >= opts.failReadsFrom) throw new Error('fetch failed');
      return rows.filter((r) => ids.includes(r.id)).map(asSearch);
    },
    link: async (a, b) => {
      calls.push(`link ${a} ${b}`);
      if (opts.refuseLink) throw new Error(opts.refuseLink);
      const pair = [a, b].map((id) => rows.find((r) => r.id === id)!);
      const group = `uuid-${++n}`;
      for (const r of pair) {
        r.sourceGroupId = group;
        r.metadata = flow(r, false);
      }
      if (opts.loseLinkAnswer) throw new Error('fetch failed');
      // Transfer-in first, as upstream answers.
      return [...pair].sort((x, y) => Number(y.activityType === 'TRANSFER_IN') - Number(x.activityType === 'TRANSFER_IN'))
        .map((r) => ({ id: r.id, accountId: r.accountId, activityType: r.activityType, activityDate: r.date, notes: r.comment, sourceGroupId: r.sourceGroupId }));
    },
    unlink: async (a, b) => {
      calls.push(`unlink ${a} ${b}`);
      if (opts.refuseUnlink) throw new Error(opts.refuseUnlink);
      const pair = [a, b].map((id) => rows.find((r) => r.id === id)!);
      for (const r of pair) {
        r.sourceGroupId = null;
        r.metadata = flow(r, true);
      }
      if (opts.loseUnlinkAnswer) throw new Error('fetch failed');
      return pair.map(asSearch);
    },
  };
  const write = (w: ActivityWrite, row: Row) => Object.assign(row, {
    accountId: w.accountId, activityType: w.activityType, date: w.activityDate, amount: String(w.amount), currency: w.currency, comment: w.comment,
    ...(w.sourceGroupId !== undefined ? { sourceGroupId: w.sourceGroupId } : {}),
    ...(w.metadata !== undefined ? { metadata: w.metadata } : {}),
    ...(w.fee !== undefined ? { fee: String(w.fee) } : {}),
  });
  const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> => {
    calls.push(`saveMany${req.deleteIds?.length ? ' delete' : ''}${req.creates?.length ? ' create' : ''}${req.updates?.length ? ' update' : ''}`);
    if (req.updates?.length && opts.refuseUpdate) return { created: [], updated: [], errors: [{ action: 'update', message: opts.refuseUpdate }] };
    if (req.updates?.length && opts.throwUpdate === 'lost') throw new Error('fetch failed');
    for (const id of req.deleteIds ?? []) rows.splice(rows.findIndex((r) => r.id === id), 1);
    const created = (req.creates ?? []).map((w) => {
      const row = write(w, { id: `new-${++n}`, sourceGroupId: null, metadata: null } as Row);
      rows.push(row);
      return { id: row.id, accountId: row.accountId, activityType: row.activityType, date: row.date, amount: row.amount, comment: row.comment, sourceGroupId: row.sourceGroupId };
    });
    const updated = (req.updates ?? []).map((w) => {
      const row = write(w, rows.find((r) => r.id === w.id)!);
      return { id: row.id, accountId: row.accountId, activityType: row.activityType, date: row.date, amount: row.amount, comment: row.comment, sourceGroupId: row.sourceGroupId };
    });
    if (req.updates?.length && opts.throwUpdate === 'landed') throw new Error('fetch failed');
    return { created, updated, errors: [] };
  };
  return { io, saveMany, rows, calls, logs };
}

describe('linking in place', () => {
  it('links two rows stored exactly as the legs, through Wealthfolio, keeping their ids', async () => {
    const wf = wealthfolio([stored(OUT_LEG), stored(IN_LEG)]);
    const result = await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(result).toEqual({ linked: true, groupId: 'uuid-1', activityIds: ['out-1', 'in-1'], inPlace: true });
    expect(wf.calls).toEqual(['read', 'link out-1 in-1']);
    expect(wf.rows.map((r) => [r.id, r.sourceGroupId])).toEqual([['out-1', 'uuid-1'], ['in-1', 'uuid-1']]);
  });

  it.each([
    ['a leg stored as ordinary money (in place cannot retype it)', { activityType: 'DEPOSIT' }],
    ['a leg carrying an asset (the phantom "$CASH" security books no cash)', { assetId: '9231cb80-4223-4c04-98e3-dd3b1af60311' }],
    ['a leg with another note', { comment: 'PAYMENT THANK YOU · TRN-2 · edited' }],
    ['a leg with another amount', { amount: '464.70' }],
    ['a leg on another day', { date: '2026-10-10T12:00:00.000Z' }],
    ['a leg carrying a subtype', { subtype: 'REIMBURSEMENT' }],
    ['a leg carrying a fee', { fee: '1.00' }],
    ['a held placeholder (marked external): its bookkeeping filing must not stay on a real transfer', { metadata: '{"flow":{"is_external":true}}' }],
  ])('re-creates the pair, as before, for %s', async (_what, over) => {
    const wf = wealthfolio([stored(OUT_LEG), stored(IN_LEG, over as Partial<Row>)]);
    const result = await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(wf.calls).toEqual(['read', 'saveMany delete', 'saveMany create']);
    expect(result.linked).toBe(true);
    expect(result.inPlace).toBeUndefined();
    expect(result.activityIds).toEqual(['new-1', 'new-2']);
  });

  it('re-creates the pair when Wealthfolio refuses to link it in place for another reason — nothing was written by the refusal, and the log says why', async () => {
    const wf = wealthfolio([stored(OUT_LEG), stored(IN_LEG)], { refuseLink: 'Security transfer legs use different assets' });
    const result = await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(wf.calls).toEqual(['read', 'link out-1 in-1', 'read', 'saveMany delete', 'saveMany create']);
    expect(result).toMatchObject({ linked: true, activityIds: ['new-1', 'new-2'] });
    expect(wf.logs.join('\n')).toContain('Security transfer legs use different assets');
    expect(wf.logs.at(-1)).toContain('re-creating instead of linking in place');
  });

  it('leaves the pair unlinked, deleting and creating nothing, when a row is already half of ANOTHER transfer', async () => {
    const refusal = 'linkTransferActivities failed: 400 - One or both activities are already linked to another transfer';
    const rows = [stored(OUT_LEG, { sourceGroupId: 'other-pair' }), stored(IN_LEG)];
    const wf = wealthfolio(rows, { refuseLink: refusal });
    const result = await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(result).toEqual({ linked: false, problems: [HALF_OF_ANOTHER_TRANSFER] });
    expect(HALF_OF_ANOTHER_TRANSFER).toBe('One of these is already half of another transfer — nothing was changed.');
    expect(wf.calls).toEqual(['read', 'link out-1 in-1']);
    expect(wf.rows.map((r) => r.id)).toEqual(['out-1', 'in-1']);
    expect(wf.logs.join('\n')).toContain(refusal);
  });

  it('does not take a group the rows were already in as proof the link went through (an older Wealthfolio refuses a pair already linked to each other)', async () => {
    const wf = wealthfolio([stored(OUT_LEG, { sourceGroupId: 'old' }), stored(IN_LEG, { sourceGroupId: 'old' })], { refuseLink: 'Selected activities already belong to a transfer' });
    const result = await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(wf.calls).toEqual(['read', 'link out-1 in-1', 'read', 'saveMany delete', 'saveMany create']);
    expect(result.inPlace).toBeUndefined();
    expect(result.activityIds).toEqual(['new-1', 'new-2']);
  });

  it('does not take an unchanged pre-existing shared group in the re-read after a lost answer either', async () => {
    const wf = wealthfolio([stored(OUT_LEG, { sourceGroupId: 'old' }), stored(IN_LEG, { sourceGroupId: 'old' })]);
    const io = { ...wf.io, link: async () => { throw new Error('fetch failed'); } };
    const result = await linkPairPreferInPlace(io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(result.inPlace).toBeUndefined();
    expect(wf.calls).toEqual(['read', 'read', 'saveMany delete', 'saveMany create']);
  });

  it('re-creates when Wealthfolio says it linked but the answer shows no shared group, and a read agrees', async () => {
    const wf = wealthfolio([stored(OUT_LEG), stored(IN_LEG)]);
    const io = { ...wf.io, link: async () => [{ id: 'in-1', accountId: 'wf-card', sourceGroupId: null }, { id: 'out-1', accountId: 'wf-chk', sourceGroupId: null }] };
    const result = await linkPairPreferInPlace(io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(wf.calls).toEqual(['read', 'read', 'saveMany delete', 'saveMany create']);
    expect(result).toMatchObject({ linked: true, activityIds: ['new-1', 'new-2'] });
    expect(result.inPlace).toBeUndefined();
    expect(wf.logs.join('\n')).toContain('without a shared group');
  });

  it('refuses in place a stored row whose outside-transfer mark is unknown, and logs why it re-created', async () => {
    const s = (leg: LinkLeg, over: Partial<Row> = {}) => storedLegOf(stored(leg, over));
    const { metadata: _drop, ...noMetadata } = stored(IN_LEG);
    expect(inPlaceRefusal([OUT_LEG, IN_LEG], [s(OUT_LEG), storedLegOf(noMetadata)])).toBe('in-1 could not be checked for an outside-transfer mark');
    expect(inPlaceRefusal([OUT_LEG, IN_LEG], [s(OUT_LEG), s(IN_LEG, { metadata: '{not json' })])).toBe('in-1 could not be checked for an outside-transfer mark');
    const wf = wealthfolio([stored(OUT_LEG), stored(IN_LEG)]);
    const io = { ...wf.io, read: async (ids: [string, string]) => (await wf.io.read(ids)).map((r) => { const { metadata: _m, ...rest } = r as Record<string, unknown>; return rest; }) };
    await linkPairPreferInPlace(io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(wf.calls).toEqual(['read', 'saveMany delete', 'saveMany create']);
    expect(wf.logs).toEqual(['link out-1/in-1: re-creating instead of linking in place (out-1 could not be checked for an outside-transfer mark)']);
  });

  it('reads again when the answer is lost, and keeps a link that went through', async () => {
    const wf = wealthfolio([stored(OUT_LEG), stored(IN_LEG)], { loseLinkAnswer: true });
    const result = await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(result).toEqual({ linked: true, groupId: 'uuid-1', activityIds: ['out-1', 'in-1'], inPlace: true });
    expect(wf.calls).toEqual(['read', 'link out-1 in-1', 'read']);
  });

  it('re-creates, as before, on a host without Wealthfolio\'s link (a 3.8 add-on) or when the rows cannot be read', async () => {
    const none = wealthfolio([stored(OUT_LEG), stored(IN_LEG)]);
    expect((await linkPairPreferInPlace(null, none.saveMany, [OUT_LEG, IN_LEG])).activityIds).toEqual(['new-1', 'new-2']);
    expect(none.calls).toEqual(['saveMany delete', 'saveMany create']);
    const blind = wealthfolio([stored(OUT_LEG), stored(IN_LEG)]);
    const io = { ...blind.io, read: async () => { throw new Error('fetch failed'); } };
    expect((await linkPairPreferInPlace(io, blind.saveMany, [OUT_LEG, IN_LEG])).inPlace).toBeUndefined();
    expect(blind.calls).toEqual(['saveMany delete', 'saveMany create']);
  });

  it('a lost answer with a row still in the group it had at the first read, its partner not sharing it, is half of another transfer: no delete, no create, retried next sync', async () => {
    const wf = wealthfolio([stored(OUT_LEG, { sourceGroupId: 'other-pair' }), stored(IN_LEG)]);
    const io = { ...wf.io, link: async () => { wf.calls.push('link out-1 in-1'); throw new Error('link failed: 502 Bad Gateway'); } };
    const result = await linkPairPreferInPlace(io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(result).toEqual({ linked: false, problems: [HALF_OF_ANOTHER_TRANSFER] });
    expect(wf.calls).toEqual(['read', 'link out-1 in-1', 'read']);
    expect(wf.rows.map((r) => r.id)).toEqual(['out-1', 'in-1']);
  });

  it('logs "could not check" when the re-read after a failed link throws, instead of saying Wealthfolio did not link them', async () => {
    const wf = wealthfolio([stored(OUT_LEG), stored(IN_LEG)], { refuseLink: 'Security transfer legs use different assets', failReadsFrom: 2 });
    await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(wf.logs.at(-1)).toBe('link out-1/in-1: re-creating instead of linking in place (could not check: fetch failed)');
    expect(wf.logs.join('\n')).not.toContain('did not link them');
  });

  it('already linked to each other with a marker (external false on both) is reported linked under that group: ids kept, no re-read, no re-create', async () => {
    const mark = '{"flow":{"is_external":false}}';
    const wf = wealthfolio([stored(OUT_LEG, { sourceGroupId: 'grp-x', metadata: mark }), stored(IN_LEG, { sourceGroupId: 'grp-x', metadata: mark })], { refuseLink: 'One or both activities are already linked to another transfer' });
    const result = await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(result).toEqual({ linked: true, groupId: 'grp-x', activityIds: ['out-1', 'in-1'], inPlace: true });
    expect(wf.calls).toEqual(['read', 'link out-1 in-1']);
  });

  it('already linked to each other under a wf-transfer- group is reported linked too', async () => {
    const wf = wealthfolio([stored(OUT_LEG, { sourceGroupId: 'wf-transfer-9' }), stored(IN_LEG, { sourceGroupId: 'wf-transfer-9' })], { refuseLink: 'Selected activities already linked' });
    const result = await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(result).toEqual({ linked: true, groupId: 'wf-transfer-9', activityIds: ['out-1', 'in-1'], inPlace: true });
    expect(wf.calls).toEqual(['read', 'link out-1 in-1']);
  });

  it('already linked to each other without a marker keeps today\'s adaptation: re-create', async () => {
    const wf = wealthfolio([stored(OUT_LEG, { sourceGroupId: 'old' }), stored(IN_LEG, { sourceGroupId: 'old' })], { refuseLink: 'One or both activities are already linked to another transfer' });
    const result = await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG]);
    expect(result.inPlace).toBeUndefined();
    expect(wf.calls).toEqual(['read', 'link out-1 in-1', 'read', 'saveMany delete', 'saveMany create']);
  });

  it('names why a pair cannot link in place', () => {
    const s = (leg: LinkLeg, over: Partial<Row> = {}) => storedLegOf(stored(leg, over));
    expect(inPlaceRefusal([OUT_LEG, IN_LEG], [s(OUT_LEG), s(IN_LEG)])).toBeNull();
    expect(inPlaceRefusal([OUT_LEG, { ...IN_LEG, activityType: 'DEPOSIT' }], [s(OUT_LEG), s(IN_LEG)])).toBe('Wealthfolio links one transfer out with one transfer in');
    expect(inPlaceRefusal([OUT_LEG, { ...IN_LEG, accountId: 'wf-chk' }], [s(OUT_LEG), s(IN_LEG)])).toBe('both legs are in one account');
    expect(inPlaceRefusal([OUT_LEG, IN_LEG], [s(OUT_LEG), null])).toBe('in-1 could not be read');
    expect(inPlaceRefusal([OUT_LEG, IN_LEG], [s(OUT_LEG), s(IN_LEG, { activityType: 'CREDIT' })])).toBe('in-1 is stored as CREDIT and links as TRANSFER_IN');
  });
});

describe('unlinking in place (Undo of a link)', () => {
  const unlinkLegs = (): [UnlinkLeg, UnlinkLeg] => [
    { ...OUT_LEG, accountName: 'Checking', newType: 'WITHDRAWAL' },
    { ...IN_LEG, accountName: 'Citi Card', newType: 'CREDIT' },
  ];
  const linked = (): Row[] => [
    stored(OUT_LEG, { sourceGroupId: 'uuid-9', metadata: '{"flow":{"is_external":false}}' }),
    stored(IN_LEG, { sourceGroupId: 'uuid-9', metadata: '{"flow":{"is_external":false}}' }),
  ];

  it('unlinks through Wealthfolio, then retypes both rows as ordinary money in one update — same ids, same instants', async () => {
    const wf = wealthfolio(linked());
    const result = await unlinkPairPreferInPlace(wf.io, wf.saveMany, unlinkLegs());
    expect(result).toEqual({ unlinked: true, inPlace: true, activityIds: ['out-1', 'in-1'] });
    expect(wf.calls).toEqual(['read', 'unlink out-1 in-1', 'saveMany update']);
    expect(wf.rows.map((r) => [r.id, r.activityType, r.sourceGroupId, r.date])).toEqual([
      ['out-1', 'WITHDRAWAL', null, '2026-10-08T12:00:00.000Z'],
      ['in-1', 'CREDIT', null, '2026-10-09T12:00:00.000Z'],
    ]);
  });

  it('round-trips: linked in place, then unlinked in place, the same two rows', async () => {
    const wf = wealthfolio([stored(OUT_LEG), stored(IN_LEG)]);
    expect((await linkPairPreferInPlace(wf.io, wf.saveMany, [OUT_LEG, IN_LEG])).activityIds).toEqual(['out-1', 'in-1']);
    expect((await unlinkPairPreferInPlace(wf.io, wf.saveMany, unlinkLegs())).activityIds).toEqual(['out-1', 'in-1']);
    expect(wf.rows.map((r) => [r.id, r.activityType, r.sourceGroupId])).toEqual([['out-1', 'WITHDRAWAL', null], ['in-1', 'CREDIT', null]]);
    expect(wf.calls.filter((c) => c.includes('create') || c.includes('delete'))).toEqual([]);
  });

  it('re-creates, as before, when Wealthfolio refuses the unlink, or a leg carries an asset', async () => {
    const refused = wealthfolio(linked(), { refuseUnlink: 'Selected activities belong to different linked transfers' });
    const r1 = await unlinkPairPreferInPlace(refused.io, refused.saveMany, unlinkLegs());
    expect(refused.calls).toEqual(['read', 'unlink out-1 in-1', 'read', 'saveMany create', 'saveMany delete']);
    expect(r1).toMatchObject({ unlinked: true, activityIds: ['new-1', 'new-2'] });
    const asset = linked();
    asset[0].assetId = '9231cb80';
    const wf = wealthfolio(asset);
    await unlinkPairPreferInPlace(wf.io, wf.saveMany, unlinkLegs());
    expect(wf.calls).toEqual(['read', 'saveMany create', 'saveMany delete']);
  });

  it('keeps an unlink whose answer was lost but which landed, and retypes', async () => {
    const wf = wealthfolio(linked(), { loseUnlinkAnswer: true });
    const result = await unlinkPairPreferInPlace(wf.io, wf.saveMany, unlinkLegs());
    expect(result).toEqual({ unlinked: true, inPlace: true, activityIds: ['out-1', 'in-1'] });
    expect(wf.calls).toEqual(['read', 'unlink out-1 in-1', 'read', 'saveMany update']);
  });

  it('names why an unlink cannot be done in place', () => {
    const legs = unlinkLegs();
    const s = (leg: LinkLeg, over: Partial<Row> = {}) => storedLegOf(stored(leg, { sourceGroupId: 'g', ...over }));
    expect(unlinkInPlaceRefusal(legs, [s(OUT_LEG), s(IN_LEG)])).toBeNull();
    expect(unlinkInPlaceRefusal(legs, [s(OUT_LEG), s(IN_LEG, { sourceGroupId: 'h' })])).toBe('the two rows are in different groups');
    expect(unlinkInPlaceRefusal(legs, [s(OUT_LEG), s(IN_LEG, { sourceGroupId: null })])).toBe('in-1 is not linked');
    expect(unlinkInPlaceRefusal(legs, [s(OUT_LEG), null])).toBe('in-1 could not be read');
  });

  it('says what a retype that THROWS left: still transfers when a read shows it, none when it landed, may still be when it cannot tell', async () => {
    const lost = wealthfolio(linked(), { throwUpdate: 'lost' });
    const r1 = await unlinkPairPreferInPlace(lost.io, lost.saveMany, unlinkLegs());
    expect(r1.problems?.[0]).toContain('but they are still typed as transfers (fetch failed)');
    const landed = wealthfolio(linked(), { throwUpdate: 'landed' });
    expect(await unlinkPairPreferInPlace(landed.io, landed.saveMany, unlinkLegs())).toEqual({ unlinked: true, inPlace: true, activityIds: ['out-1', 'in-1'] });
    expect(landed.logs.at(-1)).toBe('unlink out-1/in-1: the retype threw (fetch failed) but landed');
    const blind = wealthfolio(linked(), { throwUpdate: 'lost', failReadsFrom: 2 });
    const r3 = await unlinkPairPreferInPlace(blind.io, blind.saveMany, unlinkLegs());
    expect(r3.problems?.[0]).toContain('but they may still be typed as transfers (fetch failed)');
  });

  it('logs why an unlink fell back to re-creating, with Wealthfolio\'s refusal', async () => {
    const wf = wealthfolio(linked(), { refuseUnlink: 'Selected activities belong to different linked transfers' });
    await unlinkPairPreferInPlace(wf.io, wf.saveMany, unlinkLegs());
    expect(wf.logs.join('\n')).toContain('Selected activities belong to different linked transfers');
    expect(wf.logs.at(-1)).toContain('re-creating instead of unlinking in place');
  });

  it('says so when the pair unlinked but the retype was refused — the rows stay, unlinked, under their ids', async () => {
    const wf = wealthfolio(linked(), { refuseUpdate: 'Activity validation failed' });
    const result = await unlinkPairPreferInPlace(wf.io, wf.saveMany, unlinkLegs());
    expect(result).toEqual({
      unlinked: true, inPlace: true, activityIds: ['out-1', 'in-1'],
      problems: ['unlinked Checking 2026-10-08 464.60 "CITI AUTOPAY · TRN-1" and Citi Card 2026-10-09 464.60 "PAYMENT THANK YOU · TRN-2" in place, but they are still typed as transfers (update: Activity validation failed); a later sync retypes each while the bank feed still sends it'],
    });
    expect(wf.rows.map((r) => [r.activityType, r.sourceGroupId])).toEqual([['TRANSFER_OUT', null], ['TRANSFER_IN', null]]);
  });
});

describe('the add-on ledger value for a pair', () => {
  it('keeps a wf-transfer- group, and files Wealthfolio\'s own uuid under the prefix the ledger keeps', () => {
    expect(ledgerGroupId('wf-transfer-abc')).toBe('wf-transfer-abc');
    expect(ledgerGroupId('3f6c0f2e-0000-4000-8000-000000000001')).toBe('wf-transfer-3f6c0f2e-0000-4000-8000-000000000001');
  });
});
