import { describe, it, expect } from 'vitest';
import { fixRowOf, linkedState, recreateWrite, type FixRow } from './fix-row';

/** An ActivityDetails row as the SDK and REST search both return it. */
const details = (over: Record<string, unknown> = {}) => ({
  id: 'act-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'deposit', date: '2026-10-09T00:00:00+00:00',
  amount: '600', fee: '0', currency: 'usd', comment: 'MOBILE DEPOSIT · TRN-600', subtype: null, sourceGroupId: null, metadata: null,
  ...over,
});
const fix = (over: Partial<FixRow> = {}): FixRow => ({ ...fixRowOf(details(), 'CASH')!, ...over });

describe('fixRowOf', () => {
  it('reads an ActivityDetails row: upper-case type and currency, cents, the UTC day, raw text', () => {
    expect(fixRowOf(details(), 'cash')).toEqual({
      id: 'act-1', accountId: 'wf-chk', accountName: 'PNC Checking', accountType: 'CASH', type: 'DEPOSIT', date: '2026-10-09',
      absCents: 60000, feeCents: 0, currency: 'USD', notes: 'MOBILE DEPOSIT · TRN-600', subtype: null, flowExternal: null, grouped: false,
    });
  });

  it('reads a 3.10 local-midnight instant as its UTC day, a group, metadata as an object or a string, and notes under either name', () => {
    const r = fixRowOf(details({ date: '2026-10-01T04:00:00+00:00', sourceGroupId: 'wf-transfer-1', metadata: { flow: { is_external: false } } }), 'CASH')!;
    expect(r).toMatchObject({ date: '2026-10-01', grouped: true, flowExternal: false });
    expect(fixRowOf(details({ metadata: '{"flow":{"is_external":true}}' }), 'CASH')!.flowExternal).toBe(true);
    const { comment: _c, metadata: _m, ...noComment } = details();
    expect(fixRowOf({ ...noComment, notes: 'N · TRN-1' }, 'CASH')).toMatchObject({ notes: 'N · TRN-1', flowExternal: undefined });
  });

  it('is null for a row it cannot write back', () => {
    for (const over of [{ id: '' }, { accountId: undefined }, { activityType: 5 }, { date: null }, { date: 'soon' }, { currency: undefined }]) {
      expect(fixRowOf(details(over), 'CASH')).toBeNull();
    }
    expect(fixRowOf(null, 'CASH')).toBeNull();
  });
});

describe('recreateWrite', () => {
  it('writes ordinary money with the cash symbol, and a transfer leg with none', () => {
    expect(recreateWrite(fix())).toEqual({
      accountId: 'wf-chk', activityType: 'DEPOSIT', activityDate: '2026-10-09', symbol: { symbol: '$CASH-USD' }, amount: 600,
      currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-600',
    });
    expect(recreateWrite(fix({ type: 'TRANSFER_OUT', feeCents: 125, subtype: 'REIMBURSEMENT', flowExternal: true }))).toEqual({
      accountId: 'wf-chk', activityType: 'TRANSFER_OUT', activityDate: '2026-10-09', amount: 600, fee: 1.25, currency: 'USD',
      comment: 'MOBILE DEPOSIT · TRN-600', subtype: 'REIMBURSEMENT', metadata: '{"flow":{"is_external":true}}',
    });
  });
});

describe('recreateWrite metadata', () => {
  it('writes back every metadata key the host reported', () => {
    const r = fixRowOf(details({ activityType: 'transfer_out', metadata: { flow: { is_external: false }, tag: 'x' } }), 'CASH')!;
    expect(JSON.parse(recreateWrite(r).metadata as string)).toEqual({ flow: { is_external: false }, tag: 'x' });
  });
});

describe('linkedState', () => {
  const leg = (over: Partial<FixRow> = {}) => fix({ type: 'TRANSFER_OUT', ...over });
  const addon = { readsGroups: false, ledgerKnows: false };

  it('is confirmed by a group on the row or the add-on’s ledger, and never more than that on the companion', () => {
    expect(linkedState(fix({ grouped: true }), { readsGroups: true, ledgerKnows: false })).toBe('confirmed');
    expect(linkedState(leg(), { readsGroups: false, ledgerKnows: true })).toBe('confirmed');
    expect(linkedState(leg(), { readsGroups: true, ledgerKnows: false })).toBe(false);
  });

  it('on the add-on, a transfer-typed row nothing marks unpaired may be linked; ordinary money never is', () => {
    expect(linkedState(leg(), addon)).toBe('maybe');
    expect(linkedState(leg({ flowExternal: true }), addon)).toBe(false);
    expect(linkedState(leg({ notes: '↔️ In-transit transfer · X · TRN-1', flowExternal: undefined }), addon)).toBe(false);
    expect(linkedState(fix(), addon)).toBe(false);
  });

  it('for a row the snapshot read unpaired, only a mark a linker leaves — or no metadata at all — makes it maybe', () => {
    const seen = { ...addon, unpairedWhenRead: true };
    expect(linkedState(leg({ flowExternal: null }), seen)).toBe(false);
    expect(linkedState(leg({ flowExternal: false }), seen)).toBe('maybe');
    expect(linkedState(leg({ flowExternal: undefined }), seen)).toBe('maybe');
    expect(linkedState(leg({ flowExternal: true }), seen)).toBe(false);
  });
});
