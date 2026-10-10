import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runSyncCore, VALUATION_POLL, DUPLICATE_REFUSAL_LOG_TAG } from './sync-core.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { linkPairByRecreate } from './link-pair.js';
import type { SyncHost } from './sync-host.js';
import type { SimplefinTransaction } from './types.js';

/**
 * One transfer seen from both ends, against a host that writes the way
 * Wealthfolio 3.8 does (see `upstreamWriteRules`): updating one linked leg copies
 * its date and note onto the other, and a create is refused when its fingerprint
 * matches the one a stored row was CREATED with.
 *
 * Live, 2026-10-09: three card/savings legs carried PNC's description, date and
 * transaction id instead of their own, so every forced sync planned the bank's
 * own copy as a create and Wealthfolio refused it as a duplicate.
 */
const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);

const SPEND_TX: SimplefinTransaction = {
  id: 'TRN-spend-c727', posted: 0, amount: '-532.05', description: 'PAYMENT ROBINHOOD CCB ACH DEBIT',
};
const CARD_TX: SimplefinTransaction = {
  id: 'TRN-card-a1ce', posted: 0, amount: '532.05', description: 'Payment',
};

function pairWorld(opts: { spend?: SimplefinTransaction[]; card?: SimplefinTransaction[] } = {}) {
  const spendAt = nowSec() - 2 * DAY;
  const seed: FakeHostSeed & { accountSet: NonNullable<FakeHostSeed['accountSet']> } = {
    accountSet: { errors: [], accounts: [
      { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '0', 'balance-date': nowSec(),
        transactions: opts.spend ?? [{ ...SPEND_TX, posted: spendAt }] },
      { id: 'sfin-card', name: 'Card', currency: 'USD', balance: '0', 'balance-date': nowSec(),
        transactions: opts.card ?? [{ ...CARD_TX, posted: spendAt - DAY }] },
    ] },
    mapping: { 'sfin-spend': 'wf-spend', 'sfin-card': 'wf-card' },
    accountTypes: { 'wf-spend': 'CASH', 'wf-card': 'CREDIT_CARD' },
    upstreamWriteRules: true,
  };
  const fake = createFakeHost(seed);
  // Both production hosts link by delete-and-re-create.
  const host: SyncHost = {
    ...fake.host,
    linkPair: (legs) => linkPairByRecreate((req) => fake.host.saveMany(req), legs),
  };
  const rows = (wfId: string) => fake.activities.get(wfId) ?? [];
  return { seed, fake, host, rows, spendAt };
}

describe('transfer legs keep their own identity', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });

  it('does not rewrite a linked leg when its partner drops out of the sync window', async () => {
    const w = pairWorld();
    await runSyncCore(w.host, w.fake.store, { force: true });
    expect(w.rows('wf-card')[0].sourceGroupId).toBeTruthy();
    expect(w.rows('wf-card')[0].sourceGroupId).toBe(w.rows('wf-spend')[0].sourceGroupId);
    const spendLegId = w.rows('wf-spend')[0].id;

    // A routine window that starts after the card's leg posted: the card feed no
    // longer reports it, so on this run the Spend leg has no partner in sight.
    w.seed.accountSet.accounts[1].transactions = [];
    const saveCountBefore = w.fake.saved.length;
    await runSyncCore(w.host, w.fake.store, { force: true });

    const updatesToSpendLeg = w.fake.saved.slice(saveCountBefore)
      .flatMap((s) => s.updates ?? [])
      .filter((u) => u.id === spendLegId);
    expect(updatesToSpendLeg).toEqual([]);
    expect(w.rows('wf-card')[0].comment).toBe(`Payment · ${CARD_TX.id}`);
  });

  it('re-links a leg whose note was overwritten by its partner, under its own identity', async () => {
    const w = pairWorld();
    await runSyncCore(w.host, w.fake.store, { force: true });
    const cardDate = w.rows('wf-card')[0].date;

    // What the live database showed: an update to the Spend leg made Wealthfolio
    // copy its note and date onto the card leg, whose stored fingerprint still
    // describes the card's own transaction.
    const spendLeg = w.rows('wf-spend')[0];
    await w.fake.host.saveMany({ updates: [{
      id: spendLeg.id, accountId: 'wf-spend', activityType: spendLeg.activityType,
      activityDate: spendLeg.date, amount: Number(spendLeg.amount), currency: 'USD',
      comment: spendLeg.comment ?? '',
    }] });
    expect(w.rows('wf-card')[0].comment).toBe(spendLeg.comment);

    const result = await runSyncCore(w.host, w.fake.store, { force: true });

    expect(result.refusedCreates).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(w.rows('wf-card')).toHaveLength(1);
    expect(w.rows('wf-spend')).toHaveLength(1);
    expect(w.rows('wf-card')[0].comment).toBe(`Payment · ${CARD_TX.id}`);
    expect(w.rows('wf-card')[0].date).toBe(cardDate);
    expect(w.rows('wf-spend')[0].comment).toBe(`${SPEND_TX.description} · ${SPEND_TX.id}`);
    expect(w.rows('wf-card')[0].sourceGroupId).toBeTruthy();
    expect(w.rows('wf-card')[0].sourceGroupId).toBe(w.rows('wf-spend')[0].sourceGroupId);

    // ...and it stays repaired.
    const savesBefore = w.fake.saved.length;
    const again = await runSyncCore(w.host, w.fake.store, { force: true });
    expect(again.refusedCreates).toEqual([]);
    expect(w.fake.saved.slice(savesBefore).flatMap((s) => [...(s.creates ?? []), ...(s.deleteIds ?? [])])).toEqual([]);
  });

  it('repairs both legs when the bank revises the amount on a linked transfer', async () => {
    const w = pairWorld();
    await runSyncCore(w.host, w.fake.store, { force: true });

    // Spend is read first: its amount update makes Wealthfolio overwrite the card
    // leg (and echo that row back) before the card account is even looked at.
    w.seed.accountSet.accounts[0].transactions = [{ ...SPEND_TX, posted: w.spendAt, amount: '-532.50' }];
    w.seed.accountSet.accounts[1].transactions = [{ ...CARD_TX, posted: w.spendAt - DAY, amount: '532.50' }];
    const result = await runSyncCore(w.host, w.fake.store, { force: true });

    expect(result.refusedCreates).toEqual([]);
    expect(w.rows('wf-spend')).toHaveLength(1);
    expect(w.rows('wf-card')).toHaveLength(1);
    expect(w.rows('wf-spend')[0].comment).toBe(`${SPEND_TX.description} · ${SPEND_TX.id}`);
    expect(w.rows('wf-card')[0].comment).toBe(`Payment · ${CARD_TX.id}`);
    expect(Number(w.rows('wf-card')[0].amount)).toBe(532.5);
    expect(w.rows('wf-card')[0].sourceGroupId).toBe(w.rows('wf-spend')[0].sourceGroupId);
  });

  it("leaves an overwritten leg alone when its partner can't be re-linked, without re-importing the bank's copy", async () => {
    const w = pairWorld();
    await runSyncCore(w.host, w.fake.store, { force: true });
    const spendLeg = w.rows('wf-spend')[0];
    await w.fake.host.saveMany({ updates: [{
      id: spendLeg.id, accountId: 'wf-spend', activityType: spendLeg.activityType,
      activityDate: spendLeg.date, amount: Number(spendLeg.amount), currency: 'USD',
      comment: spendLeg.comment ?? '',
    }] });
    // Spend is no longer synced, so its leg is out of reach of a re-link — but
    // the bank still reports its transaction, which is what identifies the card
    // leg as overwritten.
    delete w.seed.mapping!['sfin-spend'];
    const linksBefore = w.fake.saved.length;

    const result = await runSyncCore(w.host, w.fake.store, { force: true });

    expect(result.refusedCreates).toEqual([]);
    expect(w.rows('wf-card')).toHaveLength(1);
    expect(w.fake.saved.slice(linksBefore).flatMap((s) => s.deleteIds ?? [])).toEqual([]);
    expect(w.rows('wf-card')[0].comment).toBe(spendLeg.comment);
  });

  it('does not guess when two of the bank\'s transactions could be the overwritten leg', async () => {
    const w = pairWorld();
    await runSyncCore(w.host, w.fake.store, { force: true });
    const spendLeg = w.rows('wf-spend')[0];
    await w.fake.host.saveMany({ updates: [{
      id: spendLeg.id, accountId: 'wf-spend', activityType: spendLeg.activityType,
      activityDate: spendLeg.date, amount: Number(spendLeg.amount), currency: 'USD',
      comment: spendLeg.comment ?? '',
    }] });
    const overwritten = { ...w.rows('wf-card')[0] };
    // A second, genuinely new card payment of the same amount, inside the window.
    w.seed.accountSet.accounts[1].transactions!.push({
      id: 'TRN-card-new', posted: w.spendAt + DAY, amount: '532.05', description: 'Payment',
    });

    await runSyncCore(w.host, w.fake.store, { force: true });

    // The new payment is imported; the overwritten row is left exactly as it was
    // (it still stands for the card's own transaction, so nothing is lost).
    const card = w.rows('wf-card');
    expect(card.some((r) => (r.comment ?? '').endsWith('TRN-card-new'))).toBe(true);
    expect(card.find((r) => r.id === overwritten.id)?.comment).toBe(overwritten.comment);
  });

  it('ends with one clean pair once the extra copy of a double-reported transfer is skipped (the live $600)', async () => {
    // Live state, after the old-wording copy was skipped and its Spend row deleted:
    // savings still holds a leg wearing that copy's id, and PNC reports the same
    // $600 again in its new wording.
    const sep = (d: number) => Math.floor(Date.UTC(2026, 8, d, 16) / 1000);
    const fake = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '0', 'balance-date': nowSec(), transactions: [
          { id: 'TRN-66c4', posted: sep(21), amount: '600.00', description: 'Transfer from Capital One Transfers' },
          { id: 'TRN-596e', posted: sep(21) + 3600, amount: '600.00', description: 'RT0553FA07D4513 TRANSFER CAPITAL ONE ACH WEB PAYMENT' },
        ] },
        { id: 'sfin-sav', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': nowSec(), transactions: [
          { id: 'TRN-208e', posted: sep(18), amount: '-600.00', description: 'PNC BANK, NATIONAL ASSOCIATION' },
        ] },
      ] },
      mapping: { 'sfin-spend': 'wf-spend', 'sfin-sav': 'wf-sav' },
      accountTypes: { 'wf-spend': 'CASH', 'wf-sav': 'CASH' },
      existing: new Map([['wf-sav', [{
        id: 'sav-leg', accountId: 'wf-sav', activityType: 'TRANSFER_OUT', date: '2026-09-21', amount: 600,
        comment: 'Transfer from Capital One Transfers · TRN-66c4', sourceGroupId: 'wf-transfer-old',
      }]]]),
      skippedTransactions: [{ account: 'sfin-spend', txId: 'TRN-66c4' }],
      upstreamWriteRules: true,
    });
    const host: SyncHost = { ...fake.host, linkPair: (legs) => linkPairByRecreate((req) => fake.host.saveMany(req), legs) };

    const result = await runSyncCore(host, fake.store, { force: true });

    expect(result.refusedCreates).toEqual([]);
    const spend = fake.activities.get('wf-spend') ?? [];
    const sav = fake.activities.get('wf-sav') ?? [];
    expect(spend.map((r) => [r.activityType, r.comment])).toEqual([
      ['TRANSFER_IN', 'RT0553FA07D4513 TRANSFER CAPITAL ONE ACH WEB PAYMENT · TRN-596e'],
    ]);
    expect(sav.map((r) => [r.activityType, r.comment, r.date])).toEqual([
      ['TRANSFER_OUT', 'PNC BANK, NATIONAL ASSOCIATION · TRN-208e', '2026-09-18'],
    ]);
    expect(spend[0].sourceGroupId).toBeTruthy();
    expect(spend[0].sourceGroupId).toBe(sav[0].sourceGroupId);
  });

  it('still imports a genuinely new same-amount transfer next to an old row whose id the bank no longer reports', async () => {
    const w = pairWorld({ spend: [], card: [] });
    // An old card payment whose own id has aged out of every feed.
    w.fake.activities.set('wf-card', [{
      id: 'old-1', accountId: 'wf-card', activityType: 'TRANSFER_IN',
      date: new Date((nowSec() - 4 * DAY) * 1000).toISOString().slice(0, 10),
      amount: 532.05, comment: 'Payment · TRN-aged-out', sourceGroupId: null,
    }]);
    w.seed.accountSet.accounts[1].transactions = [{ ...CARD_TX, posted: nowSec() - 2 * DAY }];

    const result = await runSyncCore(w.host, w.fake.store, { force: true });

    expect(result.imported).toBe(1);
    expect(w.rows('wf-card').map((r) => r.comment).sort())
      .toEqual(['Payment · TRN-aged-out', `↔️ In-transit transfer · Payment · ${CARD_TX.id}`].sort());
  });

  it("logs which stored row Wealthfolio says a refused create collided with", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    try {
      const w = pairWorld({ spend: [{ id: 'TRN-x', posted: nowSec() - DAY, amount: '-9.99', description: 'Coffee' }], card: [] });
      w.fake.activities.set('wf-spend', [{
        id: 'held-1', accountId: 'wf-spend', activityType: 'WITHDRAWAL',
        date: new Date((nowSec() - DAY) * 1000).toISOString().slice(0, 10), amount: 9.99,
        comment: 'Coffee · TRN-x', sourceGroupId: null,
      }]);
      // Rebuild with that row seeded, so it carries a creation fingerprint.
      const seeded = createFakeHost({ ...w.seed, existing: new Map(w.fake.activities) });
      // Hide the stored row from the planner so the create is attempted.
      const host: SyncHost = { ...seeded.host, listActivities: async () => [] };
      await runSyncCore(host, seeded.store, { force: true });
    } finally {
      spy.mockRestore();
    }
    const line = logs.find((l) => l.includes(DUPLICATE_REFUSAL_LOG_TAG));
    expect(line).toContain('Coffee · TRN-x');
    expect(line).toContain('(id: held-1)');
  });
});

describe('a rule that says "transfer"', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });

  const at = () => nowSec() - 3600;
  const world = (rules: FakeHostSeed['mappingRules']) => {
    const fake = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-sav', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': nowSec(),
          transactions: [{ id: 'TRN-sav', posted: at(), amount: '-500.00', description: 'Withdrawal to 360 Checking XXXXXXX1734' }] },
        { id: 'sfin-chk', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': nowSec(),
          transactions: [{ id: 'TRN-chk', posted: at(), amount: '500.00', description: 'Deposit from 360 Performance Savings XXXXXX1580' }] },
      ] },
      mapping: { 'sfin-sav': 'wf-sav', 'sfin-chk': 'wf-chk' },
      mappingRules: rules,
    });
    return fake;
  };

  it('still pairs the leg with its counterpart (live: the $500 to 360 Checking never linked)', async () => {
    const fake = world([{ matchType: 'contains', pattern: 'Withdrawal to 360 Checking XXXXXXX1734', activityType: 'TRANSFER_OUT' }]);
    await runSyncCore(fake.host, fake.store, { force: true });
    const sav = fake.activities.get('wf-sav')![0];
    const chk = fake.activities.get('wf-chk')![0];
    expect([sav.activityType, chk.activityType]).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(sav.comment).toBe('Withdrawal to 360 Checking XXXXXXX1734 · TRN-sav');
    expect(sav.sourceGroupId).toBeTruthy();
    expect(sav.sourceGroupId).toBe(chk.sourceGroupId);
  });

  it('a rule naming any other type still keeps the leg out of pairing', async () => {
    const fake = world([{ matchType: 'contains', pattern: 'Withdrawal to 360 Checking', activityType: 'WITHDRAWAL' }]);
    await runSyncCore(fake.host, fake.store, { force: true });
    expect(fake.activities.get('wf-sav')![0].activityType).toBe('WITHDRAWAL');
    expect(fake.activities.get('wf-sav')![0].sourceGroupId).toBeFalsy();
  });

  it('a transfer rule pointing the wrong way for the money still keeps the leg out', async () => {
    const fake = world([{ matchType: 'contains', pattern: 'Withdrawal to 360 Checking', activityType: 'TRANSFER_IN' }]);
    await runSyncCore(fake.host, fake.store, { force: true });
    expect(fake.activities.get('wf-sav')![0].sourceGroupId).toBeFalsy();
  });
});
