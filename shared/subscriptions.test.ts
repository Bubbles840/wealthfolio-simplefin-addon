import { describe, it, expect } from 'vitest';
import { aliasNames, brandWord, detectionKeys, detectSubscriptions, subscriptionKey, type SubscriptionCharge } from './subscriptions.js';

const NOW = new Date('2026-09-02T12:00:00Z');
const charge = (date: string, merchant: string, cents: number) => ({ date, merchant, cents });

describe('detectSubscriptions', () => {
  it('finds a monthly charge with a stable amount', () => {
    const found = detectSubscriptions([
      charge('2026-06-15', 'NETFLIX.COM', 1549),
      charge('2026-07-15', 'NETFLIX.COM', 1549),
      charge('2026-08-15', 'NETFLIX.COM', 1549),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: 'NETFLIX.COM',
      monthlyCents: 1549,
      count: 3,
      lastDate: '2026-08-15',
      lastCents: 1549,
      creep: false,
    });
  });

  it('a single charge is never recurring', () => {
    expect(detectSubscriptions([charge('2026-08-15', 'SOME SHOP', 999)], NOW)).toEqual([]);
  });

  it('rejects merchants visited often but not on a monthly cadence', () => {
    expect(detectSubscriptions([
      charge('2026-08-01', 'CHIPOTLE', 1200),
      charge('2026-08-04', 'CHIPOTLE', 1150),
      charge('2026-08-19', 'CHIPOTLE', 1275),
    ], NOW)).toEqual([]);
  });

  it('a monthly cadence with swinging amounts is a bill, clearly labeled', () => {
    // v1.36: gas-station-on-a-coincidental-cadence is the accepted cost of
    // catching real utility bills — the card labels it "varies" and dismissal
    // is one tap.
    const found = detectSubscriptions([
      charge('2026-06-01', 'SHELL OIL', 3000),
      charge('2026-07-01', 'SHELL OIL', 5200),
      charge('2026-08-01', 'SHELL OIL', 2100),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('bill');
  });

  it('drops a subscription that has stopped charging', () => {
    // Cancelled is the good outcome; listing it forever would nag about money
    // no longer leaving.
    expect(detectSubscriptions([
      charge('2026-01-10', 'OLD GYM', 2500),
      charge('2026-02-10', 'OLD GYM', 2500),
      charge('2026-03-10', 'OLD GYM', 2500),
    ], NOW)).toEqual([]);
  });

  it('flags price creep when the newest charge tops the typical price', () => {
    const found = detectSubscriptions([
      charge('2026-06-20', 'SPOTIFY', 1099),
      charge('2026-07-20', 'SPOTIFY', 1099),
      charge('2026-08-20', 'SPOTIFY', 1199),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].creep).toBe(true);
    // The recurring price is the typical charge, not the crept one.
    expect(found[0].monthlyCents).toBe(1099);
    expect(found[0].lastCents).toBe(1199);
  });

  it('orders results by monthly cost, biggest first', () => {
    const sub = (m: string, cents: number) => [
      charge(`2026-06-05`, m, cents), charge(`2026-07-05`, m, cents), charge(`2026-08-05`, m, cents),
    ];
    const found = detectSubscriptions([...sub('SPOTIFY', 1099), ...sub('ADOBE', 5499)], NOW);
    expect(found.map((s) => s.name)).toEqual(['ADOBE', 'SPOTIFY']);
  });
});

describe('detector robustness (v1.35)', () => {
  it('groups charges whose descriptors vary only by trailing reference tokens', () => {
    // The live miss: a real subscription billed as "CLAUDE.AI *SUB 8ZK1" one
    // month and "CLAUDE.AI *SUB 41XP" the next — three groups of one under
    // exact-name grouping, one subscription in reality.
    const found = detectSubscriptions([
      charge('2026-06-14', 'CLAUDE.AI *SUB 8ZK1', 2000),
      charge('2026-07-14', 'CLAUDE.AI *SUB 41XP', 2000),
      charge('2026-08-14', 'CLAUDE.AI *SUB 99QM', 2000),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('CLAUDE.AI *SUB');
    expect(found[0].monthlyCents).toBe(2000);
  });

  it('tolerates a plan upgrade: recent charges set the price, history does not veto', () => {
    // $20/mo for months, then $100/mo — every-charge stability rejected this
    // forever. The last three charges are the subscription as it exists now.
    const found = detectSubscriptions([
      charge('2026-03-05', 'CLAUDE.AI SUBSCRIPTION', 2000),
      charge('2026-04-05', 'CLAUDE.AI SUBSCRIPTION', 2000),
      charge('2026-05-05', 'CLAUDE.AI SUBSCRIPTION', 2000),
      charge('2026-06-05', 'CLAUDE.AI SUBSCRIPTION', 10000),
      charge('2026-07-05', 'CLAUDE.AI SUBSCRIPTION', 10000),
      charge('2026-08-05', 'CLAUDE.AI SUBSCRIPTION', 10000),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].monthlyCents).toBe(10000);
    expect(found[0].creep).toBe(false);
  });

  it('judges cadence on recent charges, not a payment hiccup from months ago', () => {
    // A skipped month in March must not disqualify a subscription that has
    // billed like clockwork ever since.
    const found = detectSubscriptions([
      charge('2026-01-10', 'HULU', 999),
      charge('2026-03-25', 'HULU', 999), // the old irregular gap
      charge('2026-06-10', 'HULU', 999),
      charge('2026-07-10', 'HULU', 999),
      charge('2026-08-10', 'HULU', 999),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('HULU');
  });
});

describe('hidden subscriptions', () => {
  it('parses a stored list and rejects garbage shapes', async () => {
    const { parseHiddenSubscriptions } = await import('./subscriptions.js');
    expect(parseHiddenSubscriptions('["QR LIBRARY","OLD GYM"]')).toEqual(['QR LIBRARY', 'OLD GYM']);
    expect(parseHiddenSubscriptions(null)).toEqual([]);
    expect(parseHiddenSubscriptions('not json')).toEqual([]);
    expect(parseHiddenSubscriptions('{"a":1}')).toEqual([]);
    expect(parseHiddenSubscriptions('[1,2]')).toEqual([]);
  });
});

describe('recurring tiers (v1.36)', () => {
  it('a monthly merchant with a VARYING amount is a bill, not rejected', () => {
    // Gas & electric: perfectly recurring, never the same price. The old
    // stability rule threw it away entirely.
    const found = detectSubscriptions([
      charge('2026-06-03', 'DUKE ENERGY', 8100),
      charge('2026-07-03', 'DUKE ENERGY', 12400),
      charge('2026-08-03', 'DUKE ENERGY', 9900),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('bill');
    // The typical price is the median; creep never fires on a bill.
    expect(found[0].monthlyCents).toBe(9900);
    expect(found[0].creep).toBe(false);
  });

  it('a stable monthly price is still kind subscription', () => {
    const found = detectSubscriptions([
      charge('2026-06-15', 'NETFLIX.COM', 1549),
      charge('2026-07-15', 'NETFLIX.COM', 1549),
      charge('2026-08-15', 'NETFLIX.COM', 1549),
    ], NOW);
    expect(found[0].kind).toBe('subscription');
  });

  it('a known subscription brand needs only two charges', () => {
    // A subscription started six weeks ago has billed twice; the 3-charge bar
    // hid it for a month. For names that are obviously subscriptions, two
    // monthly charges is proof enough.
    const found = detectSubscriptions([
      charge('2026-07-20', 'CLAUDE.AI SUBSCRIPTION ANTHROPIC', 2000),
      charge('2026-08-20', 'CLAUDE.AI SUBSCRIPTION ANTHROPIC', 2000),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('subscription');
    expect(found[0].monthlyCents).toBe(2000);
  });

  it('an unknown merchant with two monthly same-price charges is only possible', () => {
    const found = detectSubscriptions([
      charge('2026-07-11', 'MYSTERY BOX CLUB', 1500),
      charge('2026-08-11', 'MYSTERY BOX CLUB', 1500),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('possible');
  });

  it('two charges a week apart are nothing at all', () => {
    expect(detectSubscriptions([
      charge('2026-08-11', 'CHIPOTLE', 1200),
      charge('2026-08-18', 'CHIPOTLE', 1200),
    ], NOW)).toEqual([]);
  });

  it('erratic amounts on an erratic cadence stay rejected', () => {
    expect(detectSubscriptions([
      charge('2026-08-01', 'CHIPOTLE', 1200),
      charge('2026-08-04', 'CHIPOTLE', 1150),
      charge('2026-08-19', 'CHIPOTLE', 1275),
    ], NOW)).toEqual([]);
  });

  it('orders by tier first (subscriptions and bills above possibles), cost within', () => {
    const found = detectSubscriptions([
      charge('2026-07-11', 'MYSTERY BOX CLUB', 99900),
      charge('2026-08-11', 'MYSTERY BOX CLUB', 99900),
      charge('2026-06-15', 'NETFLIX.COM', 1549),
      charge('2026-07-15', 'NETFLIX.COM', 1549),
      charge('2026-08-15', 'NETFLIX.COM', 1549),
    ], NOW);
    expect(found.map((s) => s.name)).toEqual(['NETFLIX.COM', 'MYSTERY BOX CLUB']);
  });
});

describe('candidates over keywords (v1.37)', () => {
  it('two monthly charges with DIFFERENT amounts still make a candidate', () => {
    // The live Claude miss: two charges bracketing a plan upgrade. Nothing
    // with a monthly cadence should vanish — it should be asked about.
    const found = detectSubscriptions([
      charge('2026-07-14', 'ANTHROPIC* CLAUDE SUB SAN FRANCISCO CA', 2000),
      charge('2026-08-14', 'ANTHROPIC* CLAUDE SUB SAN FRANCISCO CA', 20000),
    ], NOW);
    expect(found).toHaveLength(1);
    // Known brand, so it lands as a subscription outright; the price is the
    // newest charge (the plan as it exists now).
    expect(found[0].kind).toBe('subscription');
    expect(found[0].monthlyCents).toBe(20000);
  });

  it('an unknown merchant with two differing monthly charges is possible, not gone', () => {
    const found = detectSubscriptions([
      charge('2026-07-01', 'LOUISVILLE GAS & ELECTRIC', 5400),
      charge('2026-08-01', 'LOUISVILLE GAS & ELECTRIC', 6900),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('possible');
  });
});

describe('previous charge (v1.39)', () => {
  it('carries the second-newest charge so the card can show the change', () => {
    const found = detectSubscriptions([
      charge('2026-07-01', 'LOUISVILLE GAS & ELECTRIC', 5420),
      charge('2026-08-01', 'LOUISVILLE GAS & ELECTRIC', 6173),
      charge('2026-06-01', 'LOUISVILLE GAS & ELECTRIC', 4890),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0].lastCents).toBe(6173);
    expect(found[0].prevCents).toBe(5420);
  });
});

describe('recent charges (1.60)', () => {
  it('publishes the newest three charges, newest first', () => {
    const [found] = detectSubscriptions([
      charge('2026-05-15', 'NETFLIX.COM', 1549), charge('2026-06-15', 'NETFLIX.COM', 1549),
      charge('2026-07-15', 'NETFLIX.COM', 1549), charge('2026-08-15', 'NETFLIX.COM', 1599),
    ], NOW);
    expect(found.recent).toEqual([
      { date: '2026-08-15', cents: 1599 }, { date: '2026-07-15', cents: 1549 }, { date: '2026-06-15', cents: 1549 },
    ]);
  });

  it('a two-charge group publishes both', () => {
    const [found] = detectSubscriptions([charge('2026-07-20', 'SPOTIFY USA', 1199), charge('2026-08-20', 'SPOTIFY USA', 1199)], NOW);
    expect(found.recent).toEqual([{ date: '2026-08-20', cents: 1199 }, { date: '2026-07-20', cents: 1199 }]);
  });
});

describe('leading references (1.63)', () => {
  it('groups one bill across the fresh reference PNC puts in front of each charge', () => {
    const found = detectSubscriptions([
      charge('2026-06-19', '*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT', 6120),
      charge('2026-07-20', '*5521 PAYMENT LOUISVILLE GAS & ACH DEBIT', 7480),
      charge('2026-08-19', '*0937 PAYMENT LOUISVILLE GAS & ACH DEBIT', 5390),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'PAYMENT LOUISVILLE GAS & ACH', kind: 'bill', count: 3 });
  });
});

describe('subscriptionKey (R6)', () => {
  it('is the detector key, and maps a key stored before 1.63 onto it', () => {
    expect(subscriptionKey('*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT')).toBe('PAYMENT LOUISVILLE GAS & ACH');
    expect(subscriptionKey('*8712 PAYMENT LOUISVILLE GAS & ACH')).toBe('PAYMENT LOUISVILLE GAS & ACH');
    expect(subscriptionKey('HULU 877-824-4858')).toBe('HULU');
  });

  it('is idempotent', () => {
    for (const name of ['*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT', 'HULU 877-824-4858', 'GOOGLE *Google One MOUNTAIN VIEW CA', '99182', '']) {
      expect(subscriptionKey(subscriptionKey(name))).toBe(subscriptionKey(name));
    }
  });
});

describe('a price step is a plan change (C2, 1.63)', () => {
  it('in the month the price goes up: a subscription at the new price, flagged as a rise', () => {
    // Nick's Google One as it stood on 2026-09-10: $5.29 for three months, then
    // the upgrade. Before 1.63 the step made it a "bill" priced at $5.29.
    const found = detectSubscriptions([
      charge('2026-06-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
      charge('2026-06-10', 'Google One Mountain View CA', 2649),
      charge('2026-07-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
      charge('2026-08-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
      charge('2026-09-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 2119),
    ], new Date('2026-09-10T12:00:00Z'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: 'GOOGLE *Google One MOUNTAIN VIEW CA', kind: 'subscription', monthlyCents: 2119,
      lastCents: 2119, prevCents: 529, count: 4, creep: true,
    });
  });

  it('the month after: still a subscription at the new price, no longer a rise', () => {
    const found = detectSubscriptions([
      charge('2026-06-14', 'CLAUDE.AI SUBSCRIPTION', 2000),
      charge('2026-07-14', 'CLAUDE.AI SUBSCRIPTION', 10000),
      charge('2026-08-14', 'CLAUDE.AI SUBSCRIPTION', 10000),
    ], NOW);
    expect(found[0]).toMatchObject({ kind: 'subscription', monthlyCents: 10000, creep: false });
  });

  it('a step down is a plan change too, never a rise', () => {
    const found = detectSubscriptions([
      charge('2026-06-03', 'PEACOCK TV', 1500),
      charge('2026-07-03', 'PEACOCK TV', 1500),
      charge('2026-08-03', 'PEACOCK TV', 999),
    ], NOW);
    expect(found[0]).toMatchObject({ kind: 'subscription', monthlyCents: 999, creep: false });
  });

  it('"agree" is within 2% (R9): a near-repeat then a jump is a step, a wider pair is not', () => {
    const run = (b: number) => detectSubscriptions([
      charge('2026-06-03', 'ACME STORAGE', 5000),
      charge('2026-07-03', 'ACME STORAGE', b),
      charge('2026-08-03', 'ACME STORAGE', 9000),
    ], NOW)[0];
    expect(run(5100)).toMatchObject({ kind: 'subscription', monthlyCents: 9000, creep: true });
    expect(run(5110).kind).toBe('bill');
  });

  it('charges that wander stay a bill, and so does an odd one in the middle', () => {
    const lge = detectSubscriptions([
      charge('2026-06-03', 'LOUISVILLE GAS & ELECTRIC', 8412),
      charge('2026-07-03', 'LOUISVILLE GAS & ELECTRIC', 10233),
      charge('2026-08-03', 'LOUISVILLE GAS & ELECTRIC', 7655),
    ], NOW);
    expect(lge[0]).toMatchObject({ kind: 'bill', creep: false });
    const middle = detectSubscriptions([
      charge('2026-06-06', 'GOOGLE *Google One', 529),
      charge('2026-07-06', 'GOOGLE *Google One', 2119),
      charge('2026-08-06', 'GOOGLE *Google One', 529),
    ], NOW);
    expect(middle[0].kind).toBe('bill');
  });
});

describe('a renamed charge is the same subscription (C1, 1.63)', () => {
  const g = (date: string, merchant: string, cents: number, accountId: string | null = 'wf-citi'): SubscriptionCharge =>
    ({ date, merchant, cents, ...(accountId ? { accountId } : {}) });
  /** Nick's six Google rows on the Citi card. Google renamed the charge on Oct 6. */
  const GOOGLE = (): SubscriptionCharge[] => [
    g('2026-06-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
    g('2026-06-10', 'Google One Mountain View CA', 2649),
    g('2026-07-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
    g('2026-08-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
    g('2026-09-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 2119),
    g('2026-10-06', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA', 2119),
  ];
  const withOct = (over: Partial<SubscriptionCharge>) => [...GOOGLE().slice(0, 5), { ...GOOGLE()[5], ...over }];
  const OCT_22 = new Date('2026-10-22T12:00:00Z');

  it.each(['2026-10-18', '2026-10-22'])("Nick's Google One on %s: one subscription at $21.19, five charges, under the older name", (day) => {
    expect(detectSubscriptions(GOOGLE(), new Date(`${day}T12:00:00Z`))).toEqual([expect.objectContaining({
      name: 'GOOGLE *Google One MOUNTAIN VIEW CA', kind: 'subscription', monthlyCents: 2119, count: 5,
      lastDate: '2026-10-06', lastCents: 2119, creep: false,
    })]);
  });

  it('names the key it joined as an alias — only on a joined entry, never its own name (F1)', () => {
    const [google] = detectSubscriptions(GOOGLE(), OCT_22);
    expect(google.aliases).toEqual(['GOOGLE *G1AI101M MOUNTAIN VIEW CA']);
    const [apart] = detectSubscriptions(withOct({ accountId: 'wf-chase' }), new Date('2026-10-18T12:00:00Z'));
    expect(apart.name).toBe('GOOGLE *Google One MOUNTAIN VIEW CA');
    expect(apart).not.toHaveProperty('aliases');
    expect(aliasNames([google, apart])).toEqual(new Map([['GOOGLE *G1AI101M MOUNTAIN VIEW CA', 'GOOGLE *Google One MOUNTAIN VIEW CA']]));
    expect(detectionKeys(google)).toEqual(['GOOGLE *Google One MOUNTAIN VIEW CA', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA']);
    // An older cube has no aliases; a malformed one is ignored, not trusted.
    expect(aliasNames(null)).toEqual(new Map());
    expect(detectionKeys({ ...apart, aliases: [42, ''] as unknown as string[] })).toEqual(['GOOGLE *Google One MOUNTAIN VIEW CA']);
  });

  it('never joins charges on different accounts', () => {
    const moved = withOct({ accountId: 'wf-chase' });
    expect(detectSubscriptions(moved, new Date('2026-10-18T12:00:00Z'))).toEqual([expect.objectContaining({ count: 4, lastDate: '2026-09-06' })]);
    expect(detectSubscriptions(moved, OCT_22)).toEqual([]);
  });

  it('joins nothing without an account', () => {
    expect(detectSubscriptions(GOOGLE().map(({ accountId: _a, ...c }) => c), OCT_22)).toEqual([]);
  });

  it.each([
    ['a different price', { cents: 2649 }],
    ['a charge off the monthly date', { date: '2026-10-20' }],
    ['a different brand', { merchant: 'YOUTUBE PREMIUM 650-253-0000' }],
  ])('leaves a new merchant apart at %s', (_why, over) => {
    expect(detectSubscriptions(withOct(over), OCT_22)).toEqual([]);
  });

  it('leaves it apart when two new merchants could continue the old one', () => {
    const two = [...GOOGLE(), g('2026-10-07', 'GOOGLE *G1XX999Z MOUNTAIN VIEW CA', 2119)];
    expect(detectSubscriptions(two, OCT_22)).toEqual([]);
  });

  it('never joins across a date it cannot read: the gap is unknown, not in range (F4)', () => {
    // A NaN gap passed both "< 24" and "> 38" as false; the join then made the
    // malformed charge the entry's last, and the whole subscription vanished.
    expect(detectSubscriptions(withOct({ date: '2026-13-06' }), new Date('2026-10-18T12:00:00Z'))).toEqual([expect.objectContaining({
      name: 'GOOGLE *Google One MOUNTAIN VIEW CA', count: 4, lastDate: '2026-09-06',
    })]);
  });

  it('needs two charges under the old name', () => {
    const one = [g('2026-09-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 2119), g('2026-10-06', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA', 2119)];
    expect(detectSubscriptions(one, OCT_22)).toEqual([]);
  });

  it('follows a chain of renames back to the oldest name', () => {
    const chain = [
      g('2026-06-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 999), g('2026-07-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 999),
      g('2026-08-06', 'GOOGLE STORAGE 855-836-3987', 999), g('2026-09-06', 'GOOGLE STORAGE 855-836-3987', 999),
      g('2026-10-06', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA', 999),
    ];
    expect(detectSubscriptions(chain, OCT_22)).toEqual([expect.objectContaining({
      name: 'GOOGLE *Google One MOUNTAIN VIEW CA', kind: 'subscription', count: 5, monthlyCents: 999,
      aliases: ['GOOGLE STORAGE', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA'],
    })]);
  });

  it('takes the brand from the first all-letters word of 3+ letters (R8)', () => {
    expect(brandWord('GOOGLE *G1AI101M MOUNTAIN VIEW CA')).toBe('google');
    expect(brandWord('SQ *BLUE BOTTLE')).toBe('blue');
    expect(brandWord('NETFLIX.COM')).toBe('netflix');
    expect(brandWord('G1AI101M MOUNTAIN VIEW')).toBe('mountain');
    expect(brandWord('99182')).toBeNull();
  });

  it("skips the bank's own words: PNC puts PAYMENT first on every ACH row once the reference is gone (F2)", () => {
    expect(brandWord('PAYMENT LOUISVILLE GAS & ACH')).toBe('louisville');
    expect(brandWord('ACH DEBIT ROBINHOOD CCB')).toBe('robinhood');
    expect(brandWord('POS PURCHASE WEB KROGER')).toBe('kroger');
    expect(brandWord('PAYMENT ACH DEBIT')).toBeNull();
  });

  it('never joins two billers that share only the bank\'s verb (F2)', () => {
    // A cancelled insurer and a new gym, a month apart on one account: both
    // keys start PAYMENT, and "payment" made them one subscription.
    const pnc = [
      g('2026-08-01', '*1111 PAYMENT ACME INSURANCE ACH DEBIT', 5000, 'wf-pnc'),
      g('2026-09-01', '*1111 PAYMENT ACME INSURANCE ACH DEBIT', 5000, 'wf-pnc'),
      g('2026-10-01', 'PAYMENT NEWGYM CLUB', 4900, 'wf-pnc'),
    ];
    expect(detectSubscriptions(pnc, new Date('2026-10-05T12:00:00Z'))).toEqual([expect.objectContaining({
      name: 'PAYMENT ACME INSURANCE ACH DEBIT', count: 2, kind: 'possible', lastDate: '2026-09-01',
    })]);
    // Google's rename still joins.
    expect(detectSubscriptions(GOOGLE(), OCT_22)).toEqual([expect.objectContaining({ name: 'GOOGLE *Google One MOUNTAIN VIEW CA', count: 5 })]);
  });
});
