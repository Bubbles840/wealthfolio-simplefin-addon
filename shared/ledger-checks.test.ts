import { describe, it, expect } from 'vitest';
import { evaluateLedgerChecks, nextLedgerCheckSeen, type LedgerFacts } from './ledger-checks.js';

const NOW = new Date('2026-09-20T13:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const clean = (): LedgerFacts => ({
  month: '2026-09',
  cardBalances: [],
  idleRefunds: [],
  incomeReimbursements: [],
  unlinkedTransfers: [],
  groupedNonTransfers: [],
  heldTransfers: [],
  needsReview: 0,
  categories: [],
  chronicallyOver: [],
});

describe('evaluateLedgerChecks', () => {
  it('says nothing at all about a healthy ledger', () => {
    // The whole design: these checks replace running an audit by hand, and an
    // audit that reports "fine" every morning is noise the user asked to lose.
    const { findings, keys } = evaluateLedgerChecks(clean(), {}, NOW);
    expect(findings).toEqual([]);
    expect(keys).toEqual([]);
  });

  describe('a card whose ledger disagrees with the bank', () => {
    const facts = () => ({
      ...clean(),
      cardBalances: [{ name: 'Citi Double Cash', ledger: -61.88, bank: -84.79, inFlight: false }],
    });

    it('waits two days before speaking, because a bank balance leads its own transactions', () => {
      // Measured live: a $22.91 credit was in Citi's balance two days before its
      // transaction reached the feed. Flagging the first sighting would cry wolf
      // on every such lag; a disagreement that SURVIVES two days is real.
      const first = evaluateLedgerChecks(facts(), {}, NOW);
      expect(first.findings).toEqual([]);
      expect(first.keys).toEqual(['card-balance:Citi Double Cash:2291']);

      const later = evaluateLedgerChecks(facts(), { 'card-balance:Citi Double Cash:2291': daysAgo(3) }, NOW);
      expect(later.findings).toHaveLength(1);
      expect(later.findings[0].message).toContain('Citi Double Cash');
      expect(later.findings[0].message).toContain('$22.91');
    });

    it('never judges a card with a transfer in flight', () => {
      // The two sides are measuring different moments; any gap is timing.
      const f = facts();
      f.cardBalances[0].inFlight = true;
      const { findings, keys } = evaluateLedgerChecks(f, { 'card-balance:Citi Double Cash:2291': daysAgo(9) }, NOW);
      expect(findings).toEqual([]);
      expect(keys).toEqual([]);
    });

    it('ignores a sub-dollar difference and a card the bank gave no figure for', () => {
      const f = clean();
      f.cardBalances = [
        { name: 'A', ledger: -10.4, bank: -10, inFlight: false },
        { name: 'B', ledger: -10, bank: null, inFlight: false },
      ];
      expect(evaluateLedgerChecks(f, {}, NOW).keys).toEqual([]);
    });
  });

  it('flags a refund that reduces nothing, immediately and every day until filed', () => {
    // A card credit only reduces spending once it carries a spending category.
    // It is one tap to fix, so it is worth repeating until someone does.
    const f = clean();
    f.idleRefunds = [{ id: 'r1', description: 'Thankyou Points Redeemed', amount: 22.91 }];
    const day1 = evaluateLedgerChecks(f, {}, NOW);
    const day9 = evaluateLedgerChecks(f, { 'idle-refund:r1': daysAgo(9) }, NOW);
    expect(day1.findings[0].message).toContain('Thankyou Points Redeemed');
    expect(day1.findings[0].message).toContain('$22.91');
    expect(day9.findings).toHaveLength(1);
  });

  it('mentions a deposit filed as "reimbursement" income ONCE, since it may be exactly what the user meant', () => {
    // An income category that happens to be called Reimbursements reduces no
    // spending — $137 of a $431 overage, live. But whether that deposit was a
    // payback or pay is the user's call, so it is a nudge, not a nag.
    const f = clean();
    f.incomeReimbursements = [{ id: 'd1', description: 'Atm Deposit', amount: 137, category: 'Reimbursements' }];
    const day1 = evaluateLedgerChecks(f, {}, NOW);
    expect(day1.findings).toHaveLength(1);
    expect(day1.findings[0].message).toMatch(/income/i);
    const day3 = evaluateLedgerChecks(f, { 'income-reimbursement:d1': daysAgo(3) }, NOW);
    expect(day3.findings).toEqual([]);
    // Still tracked, so it is not re-announced as new tomorrow.
    expect(day3.keys).toEqual(['income-reimbursement:d1']);
  });

  it('flags an unlinked cash transfer, which upstream counts as income or spending', () => {
    const f = clean();
    f.unlinkedTransfers = [
      { id: 't1', description: 'Transfer from Capital One', amount: 1300, direction: 'in', ageDays: 5 },
      { id: 't2', description: 'Payment to Card', amount: 700, direction: 'out', ageDays: 1 },
    ];
    const { findings } = evaluateLedgerChecks(f, {}, NOW);
    // The one-day-old leg is still inside the window where its pair normally
    // arrives, so only the settled one is worth a line.
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('$1300.00');
    expect(findings[0].message).toMatch(/income/i);
  });

  it('flags a transfer group holding a row that is not a transfer', () => {
    // $1,900 of income for two months, live: a DEPOSIT sat in a source group
    // with its TRANSFER_OUT twin, and a group only neutralises transfer types.
    const f = clean();
    f.groupedNonTransfers = [{ id: 'g1', description: 'CAPITAL ONE TRANSFER', amount: 1300, type: 'DEPOSIT' }];
    const { findings } = evaluateLedgerChecks(f, {}, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('DEPOSIT');
  });

  it('mentions a long-held transfer once, not every day its counterpart stays missing', () => {
    const f = clean();
    f.heldTransfers = [{ id: 'h1', description: 'Payment to Discover', amount: 87.26, ageDays: 31 }];
    expect(evaluateLedgerChecks(f, {}, NOW).findings).toHaveLength(1);
    expect(evaluateLedgerChecks(f, { 'held-transfer:h1': daysAgo(5) }, NOW).findings).toEqual([]);
    // Young holds are the normal case and say nothing at all.
    f.heldTransfers[0].ageDays = 3;
    expect(evaluateLedgerChecks(f, {}, NOW).keys).toEqual([]);
  });

  it('counts rows Wealthfolio flagged for review in one line', () => {
    const f = clean();
    f.needsReview = 3;
    const { findings } = evaluateLedgerChecks(f, {}, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('3');
  });

  describe('budget scenarios, not just ledger errors', () => {
    it('asks once about a single purchase bigger than the whole category budget', () => {
      // StubHub $420.52 against a $100 Entertainment budget. Nothing is broken,
      // but the budget just stopped describing reality, and the useful question
      // — reimbursable? one-off? raise the budget? — is only useful once.
      const f = clean();
      f.categories = [{ name: 'Entertainment', budget: 100, spent: 641.98, largest: { id: 'p1', description: 'StubHub', amount: 420.52 } }];
      const day1 = evaluateLedgerChecks(f, {}, NOW);
      expect(day1.findings).toHaveLength(1);
      expect(day1.findings[0].message).toContain('StubHub');
      expect(day1.findings[0].message).toContain('Entertainment');
      expect(evaluateLedgerChecks(f, { 'budget-buster:p1': daysAgo(2) }, NOW).findings).toEqual([]);
    });

    it('does not fire for small budgets being nudged over by an ordinary purchase', () => {
      const f = clean();
      f.categories = [{ name: 'Parking', budget: 10, spent: 12, largest: { id: 'p2', description: 'Parc', amount: 12 } }];
      expect(evaluateLedgerChecks(f, {}, NOW).keys).toEqual([]);
    });

    it('says once a month when a category has been over budget three months running', () => {
      // At that point the overage is not a bad month, it is a wrong budget, and
      // a red line every single day stops carrying any information.
      const f = clean();
      f.chronicallyOver = [{ name: 'Food & Dining', months: 3, averageOver: 140 }];
      const first = evaluateLedgerChecks(f, {}, NOW);
      expect(first.findings[0].message).toContain('Food & Dining');
      expect(first.keys).toEqual(['chronic:2026-09:Food & Dining']);
      expect(evaluateLedgerChecks(f, { 'chronic:2026-09:Food & Dining': daysAgo(4) }, NOW).findings).toEqual([]);
    });
  });

  it('caps the block so a bad week cannot bury the spending report', () => {
    // The digest was called bloated once already. Integrity problems come
    // first, and everything past the cap collapses into a single line.
    const f = clean();
    f.idleRefunds = Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, description: `Refund ${i}`, amount: 5 }));
    const { findings, keys } = evaluateLedgerChecks(f, {}, NOW);
    expect(findings).toHaveLength(5);
    expect(findings[4].message).toMatch(/5 more/);
    // Every condition is still tracked, shown or not.
    expect(keys).toHaveLength(9);
  });
});

describe('nextLedgerCheckSeen', () => {
  it('keeps first-seen times, stamps new conditions, and forgets cleared ones', () => {
    // Forgetting matters as much as remembering: a condition that goes away and
    // later comes back is a new event, and a "once" finding must be said again.
    const seen = { 'idle-refund:r1': daysAgo(4), 'budget-buster:p1': daysAgo(2) };
    const next = nextLedgerCheckSeen(seen, ['idle-refund:r1', 'held-transfer:h9'], NOW);
    expect(next).toEqual({ 'idle-refund:r1': daysAgo(4), 'held-transfer:h9': NOW.toISOString() });
  });
});
