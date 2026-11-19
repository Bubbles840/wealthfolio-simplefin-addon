import { describe, it, expect, vi } from 'vitest';
import { stampChange, type ChangeDraft } from '../../shared/change-entries.js';
import { planChangeUndo } from '../../shared/change-undo.js';
import { FEE_REVERSAL_FILING_WHY } from '../../shared/fee-reversal.js';
import { accountTxKey } from '../../shared/transfers.js';
import { fileFeeReversals, type FeeReversalFilingDeps } from './fee-reversal-filing.js';
import type { NativeFeeReversalRow } from './sqlite-native.js';

const TODAY = '2026-11-18';
const FEES = { categoryId: 'cat-fees', categoryName: 'Bank Fees' };
const INCOME = { categoryId: 'cat-inc', categoryName: 'Refunds' };
const row = (over: Partial<NativeFeeReversalRow>): NativeFeeReversalRow => ({
  activityId: 'x', wfAccountId: 'wf-chk', accountName: 'PNC Checking', notes: '', description: '', amountCents: 3500,
  date: '2026-11-10', direction: 'in', activityType: 'CREDIT', subtype: 'REFUND', spending: null, income: null, ...over,
});
const refund = (over: Partial<NativeFeeReversalRow> = {}) => row({ activityId: 'r', notes: 'OVERDRAFT FEE REFUND · TRN-2', description: 'OVERDRAFT FEE REFUND', ...over });
const fee = (over: Partial<NativeFeeReversalRow> = {}) => row({
  activityId: 'f', notes: 'OVERDRAFT FEE · TRN-1', description: 'OVERDRAFT FEE', date: '2026-11-09', direction: 'out',
  activityType: 'WITHDRAWAL', subtype: null, spending: FEES, ...over,
});
const KEY = accountTxKey('sfin-chk', 'TRN-2');

function make(rows: NativeFeeReversalRow[], over: Partial<FeeReversalFilingDeps> = {}) {
  const drafts: ChangeDraft[] = [];
  const deps: FeeReversalFilingDeps = {
    rows: vi.fn(async () => rows),
    assign: vi.fn(async () => {}),
    record: (d) => { drafts.push(d); },
    sfinAccountOf: (wf) => (wf === 'wf-chk' ? 'sfin-chk' : undefined),
    noAutoFile: () => false,
    anyNoAutoFile: false,
    log: vi.fn(),
    today: TODAY,
    ...over,
  };
  return { deps, drafts };
}

describe('fileFeeReversals (#79)', () => {
  it('files a refund under its fee’s spending category and records it for Undo', async () => {
    const { deps, drafts } = make([fee(), refund()]);
    expect(await fileFeeReversals(deps)).toEqual({ filed: 1 });
    expect(deps.assign).toHaveBeenCalledWith('r', 'cat-fees');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      actor: 'auto', kind: 'category-filed', why: FEE_REVERSAL_FILING_WHY,
      account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' },
      subject: { txKeys: [KEY], activityIds: ['r'], description: 'OVERDRAFT FEE REFUND', amountCents: 3500, date: '2026-11-10' },
      before: { categoryId: null }, after: { categoryId: 'cat-fees', categoryName: 'Bank Fees', taxonomyId: 'spending_categories' },
    });
  });

  it('files over a leftover income category, leaves it in place, and Undo takes only the filing off', async () => {
    const { deps, drafts } = make([fee(), refund({ income: INCOME })]);
    await fileFeeReversals(deps);
    expect(deps.assign).toHaveBeenCalledWith('r', 'cat-fees');
    expect(drafts[0].before).toMatchObject({ categoryId: 'cat-inc', categoryName: 'Refunds', taxonomyId: 'income_sources' });
    const undo = planChangeUndo(stampChange(drafts[0], 'companion', new Date('2026-11-18T12:00:00Z')), 'undo', {
      assignments: [{ taxonomyId: 'income_sources', categoryId: 'cat-inc' }, { taxonomyId: 'spending_categories', categoryId: 'cat-fees' }],
    }, { latest: null });
    expect(undo.ok && undo.plan.steps).toEqual([
      { do: 'set-tx', txKey: KEY, flag: 'noAutoFile', label: expect.any(String) },
      { do: 'unassign', activityId: 'r', taxonomyId: 'spending_categories' },
    ]);
  });

  it('never refiles a refund whose filing was undone, nor any keyless row while one is', async () => {
    const undone = make([fee(), refund()], { noAutoFile: (k) => k === KEY });
    expect(await fileFeeReversals(undone.deps)).toEqual({ filed: 0 });
    const keyless = make([fee(), refund()], { sfinAccountOf: () => undefined, anyNoAutoFile: true });
    expect(await fileFeeReversals(keyless.deps)).toEqual({ filed: 0 });
    expect(undone.deps.assign).not.toHaveBeenCalled();
    expect(keyless.deps.assign).not.toHaveBeenCalled();
  });

  it('goes on past a refusal, records only what landed, and never throws on a failed read', async () => {
    const rows = [fee(), refund(), fee({ activityId: 'f2', amountCents: 1200 }), refund({ activityId: 'r2', amountCents: 1200, notes: 'ATM FEE REBATE · TRN-4', description: 'ATM FEE REBATE' })];
    const { deps, drafts } = make(rows, { assign: vi.fn(async (id: string) => { if (id === 'r') throw new Error('400'); }) });
    expect(await fileFeeReversals(deps)).toEqual({ filed: 1 });
    expect(drafts.map((d) => d.subject.activityIds)).toEqual([['r2']]);
    const broken = make([], { rows: vi.fn(async () => { throw new Error('db gone'); }) });
    expect(await fileFeeReversals(broken.deps)).toEqual({ filed: 0 });
    expect(broken.deps.log).toHaveBeenCalled();
  });
});
