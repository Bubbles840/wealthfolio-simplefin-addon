import { describe, it, expect } from 'vitest';
import {
  balanceCauseLines, balanceHeaderLine, balanceIncludesLine, balanceShort, explainBalance, explainBalances,
  BALANCE_MATCHES, BALANCE_NO_BANK, BALANCE_READ_NOTES, type BalanceFacts, type BalanceRead,
} from './audit-balance';
import { cashEffectCents, type AuditAccount, type AuditLedgerRow } from './audit-ledger';

/** SimpleFin's balance-date for a UTC day, at noon. */
const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;

const acct = (id: string, name: string, type = 'CASH'): AuditAccount => ({ id, name, type, archived: false });
let seq = 0;
const row = (over: Partial<AuditLedgerRow> = {}): AuditLedgerRow => {
  seq += 1;
  return {
    id: `act-${seq}`, accountId: 'wf-chk', date: '2026-10-01', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL',
    status: 'POSTED', absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: `ROW · TRN-${seq}`,
    ...over,
  };
};

/** PNC Checking, the spec's example: two pending charges and $11.80 nobody can name. */
function pncFacts(): BalanceFacts {
  return {
    mapping: { 'sfin-chk': 'wf-chk' },
    balances: { 'sfin-chk': { balance: 2481.07, date: day('2026-10-13') } },
    names: { 'sfin-chk': 'PNC Checking' },
    valuations: { 'wf-chk': 243107 },
    ledger: {
      accounts: [acct('wf-chk', 'Checking (Wealthfolio)')],
      rows: [
        row({ rawType: 'DEPOSIT', absCents: 120400, date: '2026-08-02', notes: 'Starting balance · ACT-1' }),
        row({ rawType: 'DEPOSIT', absCents: 1240, date: '2026-09-30', notes: 'Balance adjustment · ACT-1 · 2026-09-30' }),
        row({ rawType: 'WITHDRAWAL', absCents: 1910, date: '2026-10-12', notes: 'COFFEE · TRN-7 · pending' }),
        row({ rawType: 'WITHDRAWAL', absCents: 1910, date: '2026-10-12', notes: 'LUNCH · TRN-8 · pending' }),
      ],
    },
  };
}

describe('cashEffectCents', () => {
  it('signs by type, with a card’s interest as a charge', () => {
    expect(cashEffectCents({ rawType: 'DEPOSIT', absCents: 500 }, 'CASH')).toBe(500);
    expect(cashEffectCents({ rawType: 'TRANSFER_OUT', absCents: 500 }, 'CASH')).toBe(-500);
    expect(cashEffectCents({ rawType: 'INTEREST', absCents: 500 }, 'CASH')).toBe(500);
    expect(cashEffectCents({ rawType: 'INTEREST', absCents: 500 }, 'CREDIT_CARD')).toBe(-500);
    expect(cashEffectCents({ rawType: 'SPLIT', absCents: 500 }, 'CASH')).toBe(0);
  });
});

describe('explainBalances', () => {
  it('explains the spec’s example: pending charges, a remainder nobody knows, what the balance includes', () => {
    const e = explainBalance(pncFacts(), 'wf-chk')!;
    expect(e.offCents).toBe(5000);
    expect(e.causes).toEqual([{ kind: 'pending', cents: 3820, count: 2 }]);
    expect(e.unexplainedCents).toBe(1180);
    expect(balanceHeaderLine(e)).toBe('Bank: $2,481.07 (Oct 13) · Wealthfolio: $2,431.07 · Off by $50.00');
    expect(balanceCauseLines(e)).toEqual([
      "$38.20 in 2 pending transactions the bank hasn't posted",
      '$11.80 not explained by anything the add-on knows',
    ]);
    expect(balanceIncludesLine(e)).toBe('Includes: starting balance $1,204.00 (Aug 2) · 1 correction, +$12.40 (Sep 30)');
    expect(balanceShort(e)).toBe('off by $50.00');
  });

  it('takes an account’s type from accountTypes when given, and reads a missing one as unknown (the companion drops its valuation)', () => {
    const typed = explainBalances({ ...pncFacts(), accountTypes: { 'wf-chk': 'CASH' } });
    expect(typed.accounts[0]).toMatchObject({ accountType: 'CASH', wealthfolioCents: 243107, offCents: 5000 });
    const unknown = explainBalances({ ...pncFacts(), accountTypes: {} });
    expect(unknown.accounts[0]).toMatchObject({ accountType: '', wealthfolioCents: 243107 });
    expect(BALANCE_READ_NOTES.accounts).toBe("Couldn't read your account list just now, so no account is compared.");
    expect(explainBalances({ ...pncFacts(), failed: ['accounts'] }).notes).toEqual([BALANCE_READ_NOTES.accounts]);
  });

  it('leaves the "not explained" line out when two pending charges are the whole gap', () => {
    const facts = pncFacts();
    facts.valuations = { 'wf-chk': 244287 };
    const e = explainBalance(facts, 'wf-chk')!;
    expect(e.offCents).toBe(3820);
    expect(e.unexplainedCents).toBe(0);
    expect(balanceCauseLines(e)).toEqual(["$38.20 in 2 pending transactions the bank hasn't posted"]);
  });

  it('reads a card from its whole ledger, pending included, in the bank’s sign (debt is negative)', () => {
    const e = explainBalances({
      mapping: { 'sfin-card': 'wf-card' },
      balances: { 'sfin-card': { balance: -500, date: day('2026-10-13') } },
      names: { 'sfin-card': 'Discover It' },
      ledger: {
        accounts: [acct('wf-card', 'Discover', 'CREDIT_CARD')],
        rows: [
          row({ accountId: 'wf-card', rawType: 'WITHDRAWAL', absCents: 48000, date: '2026-09-01', notes: 'Starting balance · ACT-2' }),
          row({ accountId: 'wf-card', rawType: 'WITHDRAWAL', absCents: 2000, date: '2026-10-05' }),
          row({ accountId: 'wf-card', rawType: 'INTEREST', absCents: 0, date: '2026-10-06' }),
          row({ accountId: 'wf-card', rawType: 'WITHDRAWAL', absCents: 1500, date: '2026-10-12', notes: 'GAS · TRN-40 · pending' }),
        ],
      },
    }).accounts[0];
    expect(e.wealthfolioCents).toBe(-51500);
    expect(e.offCents).toBe(1500);
    expect(e.causes).toEqual([{ kind: 'pending', cents: 1500, count: 1 }]);
    expect(e.unexplainedCents).toBe(0);
    expect(balanceHeaderLine(e)).toBe('Bank: -$500.00 (Oct 13) · Wealthfolio: -$515.00 · Off by $15.00');
    expect(balanceIncludesLine(e)).toBe('Includes: starting balance -$480.00 (Sep 1)');
  });

  it('names rows dated after the bank’s balance date', () => {
    const e = explainBalances({
      mapping: { 'sfin-chk': 'wf-chk' },
      balances: { 'sfin-chk': { balance: 100, date: day('2026-10-10') } },
      valuations: { 'wf-chk': 7500 },
      ledger: { accounts: [acct('wf-chk', 'Checking')], rows: [row({ absCents: 2500, date: '2026-10-12' }), row({ absCents: 900, date: '2026-10-10' })] },
    }).accounts[0];
    expect(e.causes).toEqual([{ kind: 'after-bank-date', cents: 2500, count: 1 }]);
    expect(balanceCauseLines(e)).toEqual(["$25.00 in 1 transaction newer than the bank's figure, which is from Oct 10"]);
  });

  it('names a transfer out carrying an asset, which the valuation never took out (the sync’s assetBackedTransferOut)', () => {
    const e = explainBalances({
      mapping: { 'sfin-chk': 'wf-chk' },
      balances: { 'sfin-chk': { balance: 60, date: day('2026-10-13') } },
      valuations: { 'wf-chk': 10000 },
      ledger: { accounts: [acct('wf-chk', 'Checking')], rows: [row({ rawType: 'TRANSFER_OUT', absCents: 4000, assetId: '$CASH', date: '2026-07-01' })] },
    }).accounts[0];
    expect(e.offCents).toBe(-4000);
    expect(e.causes).toEqual([{ kind: 'not-booked', cents: -4000, count: 1 }]);
    expect(e.unexplainedCents).toBe(0);
    expect(balanceCauseLines(e)).toEqual(['$40.00 in 1 transfer out that Wealthfolio never took out of this balance (it carries an asset)']);
  });

  it('names a transfer held in another account waiting for its other half here', () => {
    const report = explainBalances({
      mapping: { 'sfin-spend': 'wf-spend', 'sfin-save': 'wf-save' },
      balances: {
        'sfin-spend': { balance: 1000, date: day('2026-10-13') },
        'sfin-save': { balance: 5000, date: day('2026-10-13') },
      },
      names: { 'sfin-spend': 'Spend', 'sfin-save': 'Savings' },
      valuations: { 'wf-spend': 100000, 'wf-save': 200000 },
      ledger: {
        accounts: [acct('wf-spend', 'Spend'), acct('wf-save', 'Savings')],
        rows: [row({ accountId: 'wf-spend', rawType: 'TRANSFER_OUT', absCents: 300000, date: '2026-08-10', notes: '↔️ In-transit transfer · ONLINE TRANSFER · TRN-9' })],
      },
    });
    const save = report.accounts.find((a) => a.wfAccountId === 'wf-save')!;
    expect(save.causes).toEqual([{ kind: 'held', cents: 300000, count: 1 }]);
    expect(save.unexplainedCents).toBe(0);
    expect(balanceCauseLines(save)).toEqual(['$3,000.00 in 1 transfer held waiting for its other half']);
    expect(report.accounts.find((a) => a.wfAccountId === 'wf-spend')!.offCents).toBe(0);
  });

  it('names a card payment still unlinked: it left checking and never reached the card', () => {
    const card = explainBalances({
      mapping: { 'sfin-chk': 'wf-chk', 'sfin-card': 'wf-card' },
      balances: { 'sfin-chk': { balance: 400, date: day('2026-10-13') }, 'sfin-card': { balance: -100, date: day('2026-10-13') } },
      valuations: { 'wf-chk': 40000 },
      ledger: {
        accounts: [acct('wf-chk', 'Checking'), acct('wf-card', 'Citi', 'CREDIT_CARD')],
        rows: [
          row({ accountId: 'wf-chk', rawType: 'TRANSFER_OUT', absCents: 60000, date: '2026-10-04', notes: 'CITI AUTOPAY · TRN-5' }),
          row({ accountId: 'wf-card', rawType: 'WITHDRAWAL', absCents: 70000, date: '2026-09-20' }),
        ],
      },
    }).accounts.find((a) => a.wfAccountId === 'wf-card')!;
    expect(card.offCents).toBe(60000);
    expect(card.causes).toEqual([{ kind: 'unlinked', cents: 60000, count: 1 }]);
    expect(balanceCauseLines(card)).toEqual(['$600.00 in 1 card payment still unlinked']);
  });

  it('names no other half when two accounts are off by the same amount', () => {
    const report = explainBalances({
      mapping: { 'sfin-a': 'wf-a', 'sfin-b': 'wf-b', 'sfin-c': 'wf-c' },
      balances: { 'sfin-a': { balance: 600, date: null }, 'sfin-b': { balance: 600, date: null }, 'sfin-c': { balance: 0, date: null } },
      valuations: { 'wf-a': 0, 'wf-b': 0, 'wf-c': 0 },
      ledger: {
        accounts: [acct('wf-a', 'A'), acct('wf-b', 'B'), acct('wf-c', 'C')],
        rows: [row({ accountId: 'wf-c', rawType: 'TRANSFER_OUT', absCents: 60000, notes: 'TO SAVINGS · TRN-6' })],
      },
    });
    for (const id of ['wf-a', 'wf-b']) {
      const e = report.accounts.find((a) => a.wfAccountId === id)!;
      expect(e.causes).toEqual([]);
      expect(e.unexplainedCents).toBe(60000);
    }
  });

  it('shows a cause that pulls against the gap with a minus, so the lines still add up', () => {
    const e = explainBalances({
      mapping: { 'sfin-chk': 'wf-chk' },
      balances: { 'sfin-chk': { balance: 110, date: day('2026-10-13') } },
      valuations: { 'wf-chk': 10000 },
      ledger: { accounts: [acct('wf-chk', 'Checking')], rows: [row({ rawType: 'DEPOSIT', absCents: 2000, notes: 'REFUND · TRN-3 · pending' })] },
    }).accounts[0];
    expect(e.offCents).toBe(1000);
    expect(e.causes).toEqual([{ kind: 'pending', cents: -2000, count: 1 }]);
    expect(balanceCauseLines(e)).toEqual([
      "-$20.00 in 1 pending transaction the bank hasn't posted",
      '$30.00 not explained by anything the add-on knows',
    ]);
  });

  it('says "Matches the bank." and lists nothing when the two agree', () => {
    const facts = pncFacts();
    facts.valuations = { 'wf-chk': 248107 };
    const e = explainBalance(facts, 'wf-chk')!;
    expect(balanceHeaderLine(e)).toBe(`Bank: $2,481.07 (Oct 13) · Wealthfolio: $2,481.07 · ${BALANCE_MATCHES}`);
    expect(balanceCauseLines(e)).toEqual([]);
    expect(balanceShort(e)).toBe('matches');
  });

  it('says the bank has not sent a balance, and lists only mapped accounts in mapping order', () => {
    const report = explainBalances({
      mapping: { 'sfin-b': 'wf-b', 'sfin-a': 'wf-a', 'sfin-gone': '' },
      balances: { 'sfin-a': { balance: null, date: null }, 'sfin-b': { balance: 1, date: null } },
      valuations: { 'wf-a': 0, 'wf-b': 100 },
      ledger: { accounts: [acct('wf-a', 'A'), acct('wf-b', 'B'), acct('wf-x', 'Not mapped')], rows: [] },
    });
    expect(report.accounts.map((a) => a.wfAccountId)).toEqual(['wf-b', 'wf-a']);
    const a = report.accounts[1];
    expect(balanceHeaderLine(a)).toBe(BALANCE_NO_BANK);
    expect(balanceShort(a)).toBe('no bank balance');
    expect(balanceHeaderLine(report.accounts[0])).toBe(`Bank: $1.00 · Wealthfolio: $1.00 · ${BALANCE_MATCHES}`);
  });

  it('keeps bank text raw — escaping is the renderer’s job', () => {
    const facts = pncFacts();
    facts.names = { 'sfin-chk': "Joe's *Visa*_[1]" };
    expect(explainBalance(facts, 'wf-chk')!.name).toBe("Joe's *Visa*_[1]");
  });

  it.each<BalanceRead>(['mapping', 'balances', 'names', 'valuations', 'ledger'])('a failed %s read says so and leaves out only its own part', (read) => {
    const facts = pncFacts();
    if (read === 'mapping') delete facts.mapping;
    if (read === 'balances') delete facts.balances;
    if (read === 'names') delete facts.names;
    if (read === 'valuations') delete facts.valuations;
    if (read === 'ledger') delete facts.ledger;
    facts.failed = [read];
    const report = explainBalances(facts);
    expect(report.notes).toEqual([BALANCE_READ_NOTES[read]]);
    if (read === 'mapping') return void expect(report.accounts).toEqual([]);
    const e = report.accounts[0];
    if (read === 'balances') {
      expect(e.bank).toEqual({ kind: 'unread' });
      expect(balanceHeaderLine(e)).toBe('Bank: — · Wealthfolio: $2,431.07');
      expect(e.causes).toEqual([{ kind: 'pending', cents: 3820, count: 2 }]);
      expect(e.unexplainedCents).toBeNull();
    }
    if (read === 'names') expect(e.name).toBe('Checking (Wealthfolio)');
    if (read === 'valuations') {
      expect(e.wealthfolioCents).toBeNull();
      expect(balanceShort(e)).toBe('not compared');
      expect(balanceCauseLines(e)).toEqual([]);
    }
    if (read === 'ledger') {
      // Never "nothing explains it": the reasons were not looked for.
      expect(e.causes).toBeNull();
      expect(e.unexplainedCents).toBeNull();
      expect(e.offCents).toBe(5000);
      expect(balanceCauseLines(e)).toEqual([]);
      expect(e.name).toBe('PNC Checking');
    }
  });

  it('reads no card without the database', () => {
    const e = explainBalances({
      mapping: { 'sfin-card': 'wf-card' },
      balances: { 'sfin-card': { balance: -10, date: null } },
      valuations: {},
      failed: ['ledger'],
    }).accounts[0];
    expect(e.wealthfolioCents).toBeNull();
    expect(e.offCents).toBeNull();
  });
});
