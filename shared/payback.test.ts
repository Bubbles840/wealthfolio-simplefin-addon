import { describe, it, expect } from 'vitest';
import { paybackFiledChange, reversalChange, stampChange } from './change-entries.js';
import { changeBeforeAfter, changeGroupOf } from './change-view.js';
import { paybackRowOf, planPayback, type PaybackFacts } from './payback.js';
import { isPaybackRow, paybackRetype, type PaybackRow } from './payback-row.js';
import {
  PAYBACK_ALREADY, PAYBACK_ZERO, PAYBACK_GONE, PAYBACK_LINKED, PAYBACK_MANAGED, PAYBACK_NOT_CASH, PAYBACK_NOT_DEPOSIT, PAYBACK_NOT_FEED,
  PAYBACK_PENDING, PAYBACK_TRANSFER, paybackDone,
} from './payback-copy.js';
import { emptySyncOverrides, setTxOverride, SYNC_OVERRIDES_UNREADABLE_MESSAGE } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-chk', 'TRN-77');

/** Wealthfolio's ActivityDetails for a Venmo payback that landed as a plain deposit. */
const DETAILS = {
  id: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T12:00:00Z',
  amount: '14', fee: '0', currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: null, sourceGroupId: null,
};
const deposit = (over: Partial<PaybackRow> = {}): PaybackRow => ({ ...paybackRowOf(DETAILS, 'CASH')!, ...over });
const facts = (over: Partial<PaybackFacts> = {}): PaybackFacts => ({
  row: deposit(),
  feeds: ['sfin-chk'],
  overrides: { overrides: emptySyncOverrides(), unreadable: false },
  category: { id: 'cat-rest', name: 'Restaurants' },
  ...over,
});

describe('paybackRowOf', () => {
  it('reads the fixes’ row and keeps the stored instant exactly', () => {
    const row = paybackRowOf(DETAILS, 'cash')!;
    expect(row).toMatchObject({
      id: 'act-7', accountId: 'wf-chk', accountType: 'CASH', type: 'DEPOSIT', date: '2026-10-09', absCents: 1400,
      currency: 'USD', notes: 'VENMO CASHOUT · TRN-77', subtype: null, grouped: false, instant: '2026-10-09T12:00:00Z',
    });
    expect(paybackRowOf({ ...DETAILS, date: '2026-10-09T00:00:00+00:00' }, 'CASH')!.instant).toBe('2026-10-09T00:00:00+00:00');
  });

  it('is null for a row the fixes cannot read', () => {
    expect(paybackRowOf({ ...DETAILS, currency: undefined }, 'CASH')).toBeNull();
    expect(paybackRowOf('nope', 'CASH')).toBeNull();
  });

  it('knows a payback by its type and subtype, in any case', () => {
    expect(isPaybackRow({ type: 'CREDIT', subtype: 'reimbursement' })).toBe(true);
    expect(isPaybackRow({ type: 'CREDIT', subtype: null })).toBe(false);
    expect(isPaybackRow({ type: 'DEPOSIT', subtype: 'REIMBURSEMENT' })).toBe(false);
  });
});

describe('planPayback', () => {
  it('re-types the deposit to a CREDIT marked REIMBURSEMENT, at its stored instant, and files it', () => {
    const plan = planPayback(facts({ feeds: ['sfin-chk', 'sfin-old'] }));
    expect(plan).toEqual({
      ok: true,
      writes: {
        txKeys: [KEY, accountTxKey('sfin-old', 'TRN-77')],
        label: 'VENMO CASHOUT · PNC Checking',
        update: {
          id: 'act-7', accountId: 'wf-chk', activityType: 'CREDIT', activityDate: '2026-10-09T12:00:00Z',
          symbol: { symbol: '$CASH-USD' }, amount: 14, currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: 'REIMBURSEMENT',
        },
        assign: { activityId: 'act-7', categoryId: 'cat-rest' },
        entry: {
          account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' },
          txKeys: [KEY, accountTxKey('sfin-old', 'TRN-77')],
          activityId: 'act-7', description: 'VENMO CASHOUT', amountCents: 1400, date: '2026-10-09', subtypeBefore: null,
          categoryId: 'cat-rest', categoryName: 'Restaurants',
        },
      },
    });
  });

  it('keeps a deposit’s own subtype in the entry, so Undo can put it back', () => {
    const plan = planPayback(facts({ row: deposit({ subtype: 'BONUS' }) }));
    expect(plan.ok && plan.writes.entry.subtypeBefore).toBe('BONUS');
  });

  it.each<[string, Partial<PaybackFacts>, string]>([
    ['a row that is gone', { row: null }, PAYBACK_GONE],
    ['a held transfer', { row: deposit({ notes: '↔️ In-transit transfer · ZELLE FROM MOM · TRN-77' }) }, PAYBACK_MANAGED],
    ['a starting balance', { row: deposit({ notes: 'Starting balance · sfin-chk' }) }, PAYBACK_MANAGED],
    ['a correction', { row: deposit({ notes: 'Balance adjustment · sfin-chk · 2026-10-09' }) }, PAYBACK_MANAGED],
    ['a row added by hand', { row: deposit({ notes: 'Dinner money' }) }, PAYBACK_NOT_FEED],
    ['an account no feed maps to', { feeds: [] }, PAYBACK_NOT_FEED],
    ['half of a linked transfer', { row: deposit({ grouped: true }) }, PAYBACK_LINKED],
    ['a transfer', { row: deposit({ type: 'TRANSFER_IN' }) }, PAYBACK_TRANSFER],
    ['a pending row', { row: deposit({ notes: 'VENMO CASHOUT · TRN-77 · pending' }) }, PAYBACK_PENDING],
    ['a card', { row: deposit({ accountType: 'CREDIT_CARD' }) }, PAYBACK_NOT_CASH],
    ['a row that is already a payback', { row: deposit({ type: 'CREDIT', subtype: 'REIMBURSEMENT' }) }, PAYBACK_ALREADY],
    ['a row whose override says so already', {
      overrides: { overrides: setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', NOW), unreadable: false },
    }, PAYBACK_ALREADY],
    ['interest', { row: deposit({ type: 'INTEREST' }) }, PAYBACK_NOT_DEPOSIT],
    ['a bare credit', { row: deposit({ type: 'CREDIT' }) }, PAYBACK_NOT_DEPOSIT],
    ['an unreadable overrides document', { overrides: { overrides: emptySyncOverrides(), unreadable: true } }, SYNC_OVERRIDES_UNREADABLE_MESSAGE],
  ])('refuses %s, in its own words, with nothing to write', (_name, over, reason) => {
    expect(planPayback(facts(over))).toEqual({ ok: false, reason });
  });

  it('refuses a row whose stored amount is not positive, writing nothing', () => {
    expect(planPayback(facts({ row: deposit({ absCents: 0 }) }))).toEqual({ ok: false, reason: PAYBACK_ZERO });
  });

  it('ends every refusal that changed nothing with "— nothing was changed."', () => {
    for (const s of [PAYBACK_MANAGED, PAYBACK_PENDING, PAYBACK_NOT_CASH]) expect(s.endsWith('— nothing was changed.')).toBe(true);
  });

  it('gives every refusal its own words', () => {
    const words = [PAYBACK_GONE, PAYBACK_MANAGED, PAYBACK_NOT_FEED, PAYBACK_LINKED, PAYBACK_TRANSFER, PAYBACK_PENDING, PAYBACK_NOT_CASH,
      PAYBACK_ALREADY, PAYBACK_NOT_DEPOSIT, PAYBACK_ZERO, SYNC_OVERRIDES_UNREADABLE_MESSAGE];
    expect(new Set(words).size).toBe(words.length);
  });

  it('clears a subtype with an explicit empty one, and keeps everything else the row had', () => {
    expect(paybackRetype(deposit({ type: 'CREDIT', subtype: 'REIMBURSEMENT' }), 'DEPOSIT', '')).toEqual({
      id: 'act-7', accountId: 'wf-chk', activityType: 'DEPOSIT', activityDate: '2026-10-09T12:00:00Z',
      symbol: { symbol: '$CASH-USD' }, amount: 14, currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: '',
    });
  });
});

describe('the payback-filed entry', () => {
  const draft = paybackFiledChange({
    account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKeys: [KEY], activityId: 'act-7',
    description: 'VENMO CASHOUT', amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: 'cat-rest', categoryName: 'Restaurants',
  });

  it('carries the interface the app’s paybacks read (W11): before, after, subject', () => {
    expect(draft).toMatchObject({
      actor: 'you', kind: 'payback-filed', undoable: true,
      account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' },
      subject: { txKeys: [KEY], activityIds: ['act-7'], description: 'VENMO CASHOUT', amountCents: 1400, date: '2026-10-09', categoryName: 'Restaurants' },
      summary: 'Filed VENMO CASHOUT as a payback under Restaurants',
    });
    expect(draft.before).toEqual({ activityType: 'DEPOSIT', subtype: null, categoryId: null });
    expect(draft.after).toEqual({
      activityType: 'CREDIT', subtype: 'REIMBURSEMENT', categoryId: 'cat-rest', categoryName: 'Restaurants', accountId: 'wf-chk',
    });
  });

  it('says so when Wealthfolio did not take the category', () => {
    const bare = paybackFiledChange({
      account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKeys: [KEY], activityId: 'act-7',
      description: 'VENMO CASHOUT', amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: null, categoryName: null,
    });
    expect(bare.summary).toBe('Made VENMO CASHOUT a payback');
    expect(bare.subject).not.toHaveProperty('categoryName');
  });

  it('is shown under Categories, before and after in words, both ways', () => {
    const entry = stampChange(draft, 'companion', NOW);
    expect(changeGroupOf('payback-filed')).toBe('categories');
    expect(changeBeforeAfter(entry)).toBe('Money in, no category → Payback under Restaurants');
    expect(changeBeforeAfter(stampChange(reversalChange(entry, 'undo'), 'companion', NOW))).toBe('Payback under Restaurants → Money in, no category');
  });

  it('words the filing as the spec does', () => {
    expect(paybackDone('Restaurants', 'Food & Dining', 1400)).toBe('Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.');
    expect(paybackDone('Entertainment', 'Entertainment', 1450)).toBe('Filed as a payback under Entertainment — it takes $14.50 off your Entertainment spending.');
    expect(paybackDone('Restaurants', 'Food & Dining', 123456)).toBe('Filed as a payback under Restaurants — it takes $1,234.56 off your Food & Dining spending.');
  });
});
