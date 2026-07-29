import { describe, it, expect, beforeEach } from 'vitest';
import { runSyncCore, VALUATION_POLL, IN_TRANSIT_TIMEOUT_SECONDS } from './sync-core.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';

describe('runSyncCore', () => {
  beforeEach(() => {
    // Keep the same-run valuation poll effectively instant (mirrors sync.test.ts).
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 3;
  });

  it('imports a new transaction with the cash symbol and tx-id comment', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '100.00',
        'balance-date': 1700000000,
        transactions: [{ id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
    });
    const result = await runSyncCore(host, store, {});
    expect(result.imported).toBe(1);
    const create = saved[0].creates![0];
    expect(create.symbol).toEqual({ symbol: '$CASH-USD' });
    expect(create.comment).toBe('Coffee · tx-1');
  });

  it('finds an existing starting balance on an account with more than a page of activities', async () => {
    // The marker is by construction the OLDEST row on the account, so a
    // recent-first page misses it once the account outgrows one page — and the
    // guard would then write a SECOND baseline, silently doubling it.
    const filler: Array<{
      id: string; accountId: string; activityType: string; date: string;
      amount: number; comment: string;
    }> = [{
      id: 'sb', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2020-01-01',
      amount: 500, comment: 'Starting balance · sfin-1',
    }];
    for (let i = 0; i < 600; i++) {
      // No ' · ' in the comment, so these are invisible to the tx-id matcher and
      // only serve to push the marker off a recent-first page.
      const day = String((i % 28) + 1).padStart(2, '0');
      const month = String((i % 12) + 1).padStart(2, '0');
      filler.push({
        id: `old-${i}`, accountId: 'wf-a', activityType: 'DEPOSIT',
        date: `2025-${month}-${day}`, amount: 1, comment: `Filler ${i}`,
      });
    }
    const { host, store, imported } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '100.00',
        'balance-date': 1700000000,
        transactions: [{ id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      // Readable valuation → the starting-balance branch runs, and the guard is
      // the only thing standing between it and a duplicate baseline.
      valuations: new Map([['wf-a', 0]]),
      existing: new Map([['wf-a', filler.map((r) => ({ ...r, sourceGroupId: null }))]]),
    });

    await runSyncCore(host, store, {});

    const startingBalanceImports = imported
      .flat()
      .filter((r) => r.comment === 'Starting balance · sfin-1');
    expect(startingBalanceImports).toEqual([]);
  });

  /** A matching TRANSFER_OUT (sfin-1) / TRANSFER_IN (sfin-2) inside the 3-day
   *  pairing window — the smallest input that makes the core link something. */
  const transferPairSeed = (): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [
      { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Card' }] },
      { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
    ] },
    mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
  });

  it('asks the host to link each detected pair exactly once', async () => {
    const { host, store, links } = createFakeHost(transferPairSeed());
    await runSyncCore(host, store, {});
    expect(links).toHaveLength(1);
    const [a, b] = links[0];
    expect(new Set([a.activityType, b.activityType]))
      .toEqual(new Set(['TRANSFER_OUT', 'TRANSFER_IN']));
    // Each leg carries everything a host needs to re-create it.
    for (const leg of [a, b]) {
      expect(leg.wfId).toBeTruthy();
      expect(leg.absCents).toBe(50000);
      expect(leg.currency).toBe('USD');
      expect(leg.comment).toContain(leg.txId);
    }
    expect(new Set([a.accountId, b.accountId])).toEqual(new Set(['wf-a', 'wf-b']));
  });

  it('skips the ledger when the host reads sourceGroupId back', async () => {
    const { host, store } = createFakeHost(transferPairSeed());
    await runSyncCore(host, store, {});
    expect(await store.getLinkedGroups()).toEqual({});
  });

  it('does not re-link a pair the host already reports as grouped', async () => {
    const { host, store, links } = createFakeHost(transferPairSeed());
    await runSyncCore(host, store, {});
    expect(links).toHaveLength(1);
    // Second run: listActivities now returns both legs carrying the gid linkPair
    // stamped, so the capability branch recognises them without any ledger.
    await runSyncCore(host, store, { force: true });
    expect(links).toHaveLength(1);
  });

  it('omits the asset on transfer legs', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Card' }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
    });
    await runSyncCore(host, store, {});
    const creates = saved.flatMap((s) => s.creates ?? []);
    const out = creates.find((c) => c.comment.includes('tx-out'))!;
    expect(out.activityType).toBe('TRANSFER_OUT');
    expect(out.symbol).toBeUndefined();
  });

  // --- Task 5: Healing + baseline correction via the core ---

  it('plugs CASH drift with a spending-neutral CREDIT', async () => {
    const { host, store, imported } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'C', currency: 'USD',
        balance: '100.00', 'balance-date': 1,
        transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      valuations: new Map([['wf-a', 0]]),
      autoHeal: true,
      autoAdjust: true,
    });
    await runSyncCore(host, store, { heal: true });
    const plug = imported.flat().find((r) => r.comment.startsWith('Balance adjustment'))!;
    expect(plug).toBeTruthy();
    expect(plug.activityType).toBe('CREDIT');
    expect(plug.amount).toBe(100);
    expect(plug.fee).toBe(0);
  });

  it('nets pre-baseline history out of the starting balance', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'C', currency: 'USD',
        balance: '3200.38', 'balance-date': 1,
        transactions: [{
          id: 'tx-old',
          posted: Math.floor(Date.parse('2026-04-23T12:00:00Z') / 1000),
          amount: '-1300.00',
          description: 'ACH Withdrawal',
        }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      existing: new Map([['wf-a', [{
        id: 'act-start', accountId: 'wf-a', activityType: 'DEPOSIT',
        date: '2026-06-18', amount: 4500.38, comment: 'Starting balance · sfin-1',
        sourceGroupId: null,
      }]]]),
    });
    await runSyncCore(host, store, {});
    const update = saved.flatMap((s) => s.updates ?? []).find((u) => u.id === 'act-start')!;
    expect(update).toBeTruthy();
    expect(update.amount).toBeCloseTo(5800.38, 2);
    expect(update.activityType).toBe('DEPOSIT');
  });

  it('plugs negative CASH drift with a fee-based CREDIT', async () => {
    const { host, store, imported } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'C', currency: 'USD',
        balance: '-50.00', 'balance-date': 1,
        transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      valuations: new Map([['wf-a', 0]]),
      autoHeal: true,
      autoAdjust: true,
    });
    await runSyncCore(host, store, { heal: true });
    const plug = imported.flat().find((r) => r.comment.startsWith('Balance adjustment'))!;
    expect(plug).toBeTruthy();
    expect(plug.activityType).toBe('CREDIT');
    expect(plug.amount).toBe(0);
    expect(plug.fee).toBe(50);
  });

  it('uses DEPOSIT/WITHDRAWAL for non-CASH account drift plugs', async () => {
    const { host, store, imported } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Brokerage', currency: 'USD',
        balance: '200.00', 'balance-date': 1,
        transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'SECURITIES' },
      valuations: new Map([['wf-a', 0]]),
      autoHeal: true,
      autoAdjust: true,
    });
    await runSyncCore(host, store, { heal: true });
    const plug = imported.flat().find((r) => r.comment.startsWith('Balance adjustment'))!;
    expect(plug).toBeTruthy();
    expect(plug.activityType).toBe('DEPOSIT');
    expect(plug.amount).toBe(200);
    expect(plug.fee).toBe(0);
  });

  // --- Task 6: in-transit transfer placeholders ---

  /** Posted an hour ago: recent enough that the other leg is still plausibly in
   *  flight, so an unpaired transfer-typed row lands as a placeholder rather
   *  than timing out. Must be relative to now — the timeout is measured against
   *  the wall clock, so a fixed epoch would silently expire as time passes. */
  const recentEpoch = () => Math.floor(Date.now() / 1000) - 3600;

  /** One CASH account holding a single unpaired outbound transfer leg. */
  const soloOutLegSeed = () => ({
    accountSet: { errors: [], accounts: [{
      id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
      transactions: [{
        id: 'tx-out', posted: recentEpoch(), amount: '-1300.00',
        description: 'Online Transfer to Savings',
      }],
    }] },
    mapping: { 'sfin-1': 'wf-a' } as Record<string, string>,
    accountTypes: { 'wf-a': 'CASH' } as Record<string, string>,
  });

  it('imports a solo transfer-typed leg as a spending-neutral placeholder, not a bare transfer', async () => {
    const { host, store, saved } = createFakeHost(soloOutLegSeed());
    const result = await runSyncCore(host, store, {});
    expect(result.imported).toBe(1);
    const create = saved[0].creates![0];
    // CREDIT (not TRANSFER_OUT), fee-side of the split since the amount left the account.
    expect(create.activityType).toBe('CREDIT');
    expect(create.fee).toBe(1300);
    expect(create.amount).toBe(0);
    // CREDIT books real cash only with the reserved cash asset attached.
    expect(create.symbol).toEqual({ symbol: '$CASH-USD' });
    expect(create.comment).toContain('↔️ In-transit transfer · ');
    expect(create.comment).toContain('· tx-out');
  });

  it('adds cash for a solo INBOUND CASH transfer leg (amount side of the split)', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{
          id: 'tx-in', posted: recentEpoch(), amount: '1300.00',
          description: 'Online Transfer from Savings',
        }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
    });
    await runSyncCore(host, store, {});
    const create = saved[0].creates![0];
    expect(create.activityType).toBe('CREDIT');
    expect(create.amount).toBe(1300);
    expect(create.fee).toBeUndefined();
    expect(create.comment).toContain('↔️ In-transit transfer · ');
  });

  it('uses the card-shaped DEPOSIT for a solo CREDIT_CARD payment leg (no CREDIT, no fee split)', async () => {
    // mapper types a positive, payment-shaped card amount as TRANSFER_IN, so an
    // unpaid-off card payment reaches the placeholder path. On a card the proven
    // spending-neutral shape is a plain DEPOSIT — CREDIT is only established for CASH.
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{
          id: 'tx-pay', posted: recentEpoch(), amount: '1300.00',
          description: 'PAYMENT THANK YOU',
        }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CREDIT_CARD' },
    });
    await runSyncCore(host, store, {});
    const create = saved[0].creates![0];
    expect(create.activityType).toBe('DEPOSIT');
    expect(create.amount).toBe(1300);
    expect(create.fee).toBeUndefined();
    expect(create.symbol).toEqual({ symbol: '$CASH-USD' });
    expect(create.comment).toContain('↔️ In-transit transfer · ');
    expect(create.comment).toContain('· tx-pay');
  });

  it('promotes a placeholder to a real linked transfer once the matching leg appears on a later sync', async () => {
    const seed = soloOutLegSeed();
    const { host, store, saved, activities, links } = createFakeHost(seed);
    await runSyncCore(host, store, {}); // first run: other leg not posted yet
    expect(saved[0].creates![0].activityType).toBe('CREDIT');
    const placeholderId = activities.get('wf-a')![0].id;

    // Second run: the savings side has posted and that account is mapped too.
    seed.accountSet.accounts.push({
      id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': 1,
      transactions: [{
        id: 'tx-in', posted: recentEpoch(), amount: '1300.00',
        description: 'Online Transfer from Checking',
      }],
    });
    seed.mapping['sfin-2'] = 'wf-b';
    await runSyncCore(host, store, { force: true });

    // Updated in place — same row id, no second row.
    expect(activities.get('wf-a')).toHaveLength(1);
    const promoted = activities.get('wf-a')!.find((a) => a.id === placeholderId)!;
    expect(promoted.activityType).toBe('TRANSFER_OUT');
    expect(promoted.comment).not.toContain('In-transit');

    // ...and the leg handed to linkPair reflects the promotion, not the stale
    // placeholder: a host that re-creates both legs (the addon does) would
    // otherwise resurrect a $0 CREDIT.
    // The promoting update must state fee: 0 — the server leaves an omitted
    // numeric field unchanged, so the fee-side split would otherwise survive.
    const update = saved.flatMap((s) => s.updates ?? []).find((u) => u.id === placeholderId)!;
    expect(update.amount).toBe(1300);
    expect(update.fee).toBe(0);

    expect(links).toHaveLength(1);
    const outLeg = links[0].find((l) => l.txId === 'tx-out')!;
    expect(outLeg.wfId).toBe(placeholderId);
    expect(outLeg.activityType).toBe('TRANSFER_OUT');
    expect(outLeg.absCents).toBe(130000);
    expect(outLeg.comment).toBe('Online Transfer to Savings · tx-out');
  });

  it('converts a solo transfer-typed leg to plain WITHDRAWAL once it is older than the in-transit timeout', async () => {
    const staleEpoch = Math.floor(Date.now() / 1000) - (IN_TRANSIT_TIMEOUT_SECONDS + 3600);
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{
          id: 'tx-out', posted: staleEpoch, amount: '-1300.00',
          description: 'Online Transfer to Savings',
        }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
    });
    const result = await runSyncCore(host, store, { force: true });
    expect(result.imported).toBe(1);
    const create = saved[0].creates![0];
    expect(create.activityType).toBe('WITHDRAWAL');
    expect(create.amount).toBe(1300);
    expect(create.fee).toBeUndefined();
    expect(create.comment).not.toContain('In-transit');
  });

  it('converts an already-imported placeholder in place when it times out, clearing the fee side', async () => {
    const staleEpoch = Math.floor(Date.now() / 1000) - (IN_TRANSIT_TIMEOUT_SECONDS + 3600);
    const staleDate = new Date(staleEpoch * 1000).toISOString().split('T')[0];
    const { host, store, saved, activities } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{
          id: 'tx-out', posted: staleEpoch, amount: '-1300.00',
          description: 'Online Transfer to Savings',
        }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      // The placeholder as an earlier run wrote it: the whole amount sits in
      // `fee`, so the row a host reads back carries amount 0.
      existing: new Map([['wf-a', [{
        id: 'ph-1', accountId: 'wf-a', activityType: 'CREDIT', date: staleDate,
        amount: 0, comment: '↔️ In-transit transfer · Online Transfer to Savings · tx-out',
        sourceGroupId: null,
      }]]]),
    });
    await runSyncCore(host, store, { force: true });

    const update = saved.flatMap((s) => s.updates ?? []).find((u) => u.id === 'ph-1')!;
    expect(update).toBeTruthy();
    expect(update.activityType).toBe('WITHDRAWAL');
    expect(update.amount).toBe(1300);
    expect(update.fee).toBe(0); // the fee side must be zeroed, not left as-is
    expect(update.comment).toBe('Online Transfer to Savings · tx-out');
    expect(activities.get('wf-a')).toHaveLength(1); // converted, not duplicated
  });

  it('drops the in-transit prefix when a NON-CASH placeholder times out (the only field that differs)', async () => {
    // On a card, neutralAdjustmentFields and the expiry branch produce the SAME
    // DEPOSIT with no fee split — so type, amount, date and pending are all
    // identical and only the comment marks the row as still in transit. Without
    // comparing placeholder-ness, no update is planned and the row wears
    // "In-transit" forever on a payment that will never pair.
    const staleEpoch = Math.floor(Date.now() / 1000) - (IN_TRANSIT_TIMEOUT_SECONDS + 3600);
    const staleDate = new Date(staleEpoch * 1000).toISOString().split('T')[0];
    const { host, store, saved, activities } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{
          id: 'tx-pay', posted: staleEpoch, amount: '1300.00',
          description: 'PAYMENT THANK YOU',
        }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CREDIT_CARD' },
      existing: new Map([['wf-a', [{
        id: 'ph-card', accountId: 'wf-a', activityType: 'DEPOSIT', date: staleDate,
        amount: 1300, comment: '↔️ In-transit transfer · PAYMENT THANK YOU · tx-pay',
        sourceGroupId: null,
      }]]]),
    });
    await runSyncCore(host, store, { force: true });

    const update = saved.flatMap((s) => s.updates ?? []).find((u) => u.id === 'ph-card')!;
    expect(update).toBeTruthy();
    expect(update.comment).toBe('PAYMENT THANK YOU · tx-pay');
    expect(update.comment).not.toContain('In-transit');
    expect(update.activityType).toBe('DEPOSIT');
    expect(update.amount).toBe(1300);
    expect(activities.get('wf-a')).toHaveLength(1); // rewritten, not duplicated
  });

  it('leaves an unchanged in-transit placeholder alone on the next sync (no update churn)', async () => {
    const { host, store, saved } = createFakeHost(soloOutLegSeed());
    await runSyncCore(host, store, {});
    saved.length = 0;
    // The fee-side placeholder stores amount 0, so reconciliation has to compare
    // the BOOKED amount (absCents − feeCents) or it re-updates the row forever.
    const second = await runSyncCore(host, store, { force: true });
    expect(saved).toEqual([]);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  // --- Drift: which signal says a TRANSFER_OUT is already linked ---

  /** The drift the run stored for an account, as the Sync page reads it. */
  const storedDrift = async (
    store: { getAccountBalances(): Promise<Record<string, unknown>> },
    sfinAccountId: string,
  ): Promise<number | null> => {
    const balances = await store.getAccountBalances();
    return (balances[sfinAccountId] as { drift: number | null } | undefined)?.drift ?? null;
  };

  /** A seeded starting-balance marker: its presence stops the one-time baseline
   *  correction from firing, keeping these tests about drift only. */
  const startingBalanceRow = (accountId: string, sfinAccountId: string) => ({
    id: `sb-${accountId}`, accountId, activityType: 'DEPOSIT', date: '2026-01-01',
    amount: 0.01, comment: `Starting balance · ${sfinAccountId}`, sourceGroupId: null,
  });

  it("does not inflate drift with a LINKED TRANSFER_OUT on a host that reads sourceGroupId (the user's Spend account)", async () => {
    // Real figures from the live companion: bank 3475.23, Wealthfolio 2175.23,
    // 7350.45 of correctly-linked TRANSFER_OUT rows whose cash Wealthfolio has
    // ALREADY deducted. True drift is 1300.00; treating those legs as unlinked
    // reported 8650.45 and would have plugged that much into a real account.
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Spend', currency: 'USD',
        balance: '3475.23', 'balance-date': 1, transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      valuations: new Map([['wf-a', 2175.23]]),
      existing: new Map([['wf-a', [
        startingBalanceRow('wf-a', 'sfin-1'),
        { id: 'out-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-01',
          amount: 6050.45, comment: 'Online Transfer to Savings · tx-a',
          sourceGroupId: 'wf-transfer-aaa' },
        { id: 'out-2', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-02',
          amount: 1300.0, comment: 'Online Transfer to Savings · tx-b',
          sourceGroupId: 'wf-transfer-bbb' },
      ]]]),
    });
    await runSyncCore(host, store, {});
    expect(await storedDrift(store, 'sfin-1')).toBeCloseTo(1300.0, 2);
  });

  it('still accounts for an UNLINKED TRANSFER_OUT (null sourceGroupId) on a host that reads groups', async () => {
    // Nothing has deducted this leg's 500 from Wealthfolio's valuation yet, so
    // subtracting it is what keeps an in-flight transfer from reading as drift.
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Spend', currency: 'USD',
        balance: '3475.23', 'balance-date': 1, transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      valuations: new Map([['wf-a', 2675.23]]),
      existing: new Map([['wf-a', [
        startingBalanceRow('wf-a', 'sfin-1'),
        { id: 'out-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-01',
          amount: 500.0, comment: 'Online Transfer to Savings · tx-a', sourceGroupId: null },
      ]]]),
    });
    await runSyncCore(host, store, {});
    // 2675.23 − 500 = 2175.23 adjusted, so 3475.23 − 2175.23 = 1300.00.
    expect(await storedDrift(store, 'sfin-1')).toBeCloseTo(1300.0, 2);
  });

  it('ignores a row-level sourceGroupId on a ledger-backed host (the addon), where it is not trustworthy', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Spend', currency: 'USD',
        balance: '3475.23', 'balance-date': 1, transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      valuations: new Map([['wf-a', 2675.23]]),
      existing: new Map([['wf-a', [
        startingBalanceRow('wf-a', 'sfin-1'),
        { id: 'out-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-01',
          amount: 500.0, comment: 'Online Transfer to Savings · tx-a',
          sourceGroupId: 'wf-transfer-aaa' },
      ]]]),
    });
    // The addon's profile: ActivityDetails hides sourceGroupId, so whatever a row
    // appears to carry must not be believed — only the ledger may vouch.
    host.capabilities.readsSourceGroupId = false;
    await runSyncCore(host, store, {});
    // Ledger is empty → the leg still counts as unlinked, exactly as before.
    expect(await storedDrift(store, 'sfin-1')).toBeCloseTo(1300.0, 2);
  });

  it('lets the ledger clear a TRANSFER_OUT on a ledger-backed host', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '1010.00', 'balance-date': 1,
          transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Card' }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
      accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CREDIT_CARD' },
      valuations: new Map([['wf-a', 1000], ['wf-b', 0]]),
      existing: new Map([
        ['wf-a', [
          startingBalanceRow('wf-a', 'sfin-1'),
          { id: 'act-out', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2023-11-14',
            amount: 500.0, comment: 'Payment to Card · tx-out', sourceGroupId: null },
        ]],
        ['wf-b', [
          startingBalanceRow('wf-b', 'sfin-2'),
          { id: 'act-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2023-11-15',
            amount: 500.0, comment: 'PAYMENT THANK YOU · tx-in', sourceGroupId: null },
        ]],
      ]),
    });
    host.capabilities.readsSourceGroupId = false;
    // Both legs already recorded under one echo-confirmed group id.
    await store.setLinkedGroups({ 'tx-out': 'wf-transfer-g1', 'tx-in': 'wf-transfer-g1' });
    await runSyncCore(host, store, {});
    // Ledger vouches → the 500 is NOT subtracted: 1010.00 − 1000 = 10.00.
    expect(await storedDrift(store, 'sfin-1')).toBeCloseTo(10.0, 2);
  });

  // --- Task 7: stuck-transfer failure tracking and alerting ---

  it('reports a stuck-transfer alert after 3 consecutive failed link attempts on the same pair', async () => {
    let attempt = 0;
    const seed = transferPairSeed();

    for (let i = 0; i < 3; i++) {
      const { host, store } = createFakeHost(seed);
      host.linkPair = async () => ({ linked: false });
      const result = await runSyncCore(host, store, { force: true });
      attempt++;
      if (attempt < 3) {
        expect(result.stuckTransferAlerts).toEqual([]);
      } else {
        expect(result.stuckTransferAlerts).toHaveLength(1);
        expect(result.stuckTransferAlerts[0].outTxId).toBe('tx-out');
        expect(result.stuckTransferAlerts[0].amountCents).toBe(50000);
        expect(result.stuckTransferAlerts[0].currency).toBe('USD');
      }
      // Persist the failure ledger to the next iteration's fresh host, the
      // way the real companion persists addon secrets across cron runs.
      seed.transferLinkFailures = await store.getTransferLinkFailures();
    }
  });

  it('does not re-alert on the same pair after it has already alerted once', async () => {
    const seed = transferPairSeed();
    seed.transferLinkFailures = {
      'tx-out': { count: 5, firstFailedAt: '2026-07-01T00:00:00Z', alerted: true },
    };
    const { host, store } = createFakeHost(seed);
    host.linkPair = async () => ({ linked: false });
    const result = await runSyncCore(host, store, { force: true });
    expect(result.stuckTransferAlerts).toEqual([]);
  });

  it('clears a failure entry once the pair successfully links', async () => {
    const seed = transferPairSeed();
    seed.transferLinkFailures = {
      'tx-out': { count: 2, firstFailedAt: '2026-07-01T00:00:00Z', alerted: false },
    };
    const { host, store } = createFakeHost(seed);
    await runSyncCore(host, store, { force: true }); // fake host's default linkPair succeeds
    expect(await store.getTransferLinkFailures()).toEqual({});
  });

  // --- Large-transaction alerts ---

  /** One $1,240 card purchase on a CASH account whose Wealthfolio account is
   *  named "Spend", with the alert threshold set to $1,000. The descriptor
   *  carries a literal `*` on purpose: real card-network descriptors do, and it
   *  is the input most likely to break a Markdown-parsed send. */
  const largeSpendSeed = (): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [{
      id: 'sfin-1', name: 'Spend Bank', currency: 'USD', balance: '0', 'balance-date': 1,
      transactions: [{
        id: 'tx-1', posted: recentEpoch(), amount: '-1240.00',
        description: 'AMAZON *MKTPLACE',
      }],
    }] },
    mapping: { 'sfin-1': 'wf-a' },
    accountTypes: { 'wf-a': 'CASH' },
    accountNames: { 'wf-a': 'Spend' },
    largeTransactionThreshold: 1000,
  });

  it('reports a large-transaction alert for a newly-created spending row over the threshold', async () => {
    const { host, store } = createFakeHost(largeSpendSeed());
    const result = await runSyncCore(host, store, {});
    expect(result.largeTransactionAlerts).toEqual([{
      txId: 'tx-1',
      description: 'AMAZON *MKTPLACE',
      amountCents: 124000,
      currency: 'USD',
      accountName: 'Spend',
    }]);
  });

  it('names the SimpleFin account when the host reports no Wealthfolio account name', async () => {
    const seed = largeSpendSeed();
    delete seed.accountNames;
    const { host, store } = createFakeHost(seed);
    const result = await runSyncCore(host, store, {});
    expect(result.largeTransactionAlerts[0].accountName).toBe('Spend Bank');
  });

  it('does not alert on a large DEPOSIT — a big inflow is not alarming', async () => {
    const seed = largeSpendSeed();
    seed.accountSet!.accounts[0].transactions = [{
      id: 'tx-1', posted: recentEpoch(), amount: '4200.00', description: 'PAYROLL ACME',
    }];
    const { host, store } = createFakeHost(seed);
    const result = await runSyncCore(host, store, {});
    expect(result.largeTransactionAlerts).toEqual([]);
  });

  it('alerts on a rule-typed FEE, matching the spending query’s WITHDRAWAL/FEE/TAX set', async () => {
    const seed = largeSpendSeed();
    seed.mappingRules = [{ pattern: 'WIRE FEE', matchType: 'contains', activityType: 'FEE' }];
    seed.accountSet!.accounts[0].transactions = [{
      id: 'tx-1', posted: recentEpoch(), amount: '-1500.00', description: 'WIRE FEE',
    }];
    const { host, store } = createFakeHost(seed);
    const result = await runSyncCore(host, store, {});
    expect(result.largeTransactionAlerts.map((a) => a.amountCents)).toEqual([150000]);
  });

  it('does not alert on an in-transit transfer placeholder that happens to be a WITHDRAWAL', async () => {
    // On a non-CASH account the spending-neutral placeholder IS a WITHDRAWAL, so
    // the activity type alone would let a plain internal transfer read as a large
    // purchase.
    const seed = largeSpendSeed();
    seed.accountTypes = { 'wf-a': 'SECURITIES' };
    seed.accountSet!.accounts[0].transactions = [{
      id: 'tx-1', posted: recentEpoch(), amount: '-1240.00',
      description: 'Online Transfer to Savings',
    }];
    const { host, store, saved } = createFakeHost(seed);
    const result = await runSyncCore(host, store, {});
    expect(saved[0].creates![0].activityType).toBe('WITHDRAWAL'); // the trap
    expect(saved[0].creates![0].comment).toContain('↔️ In-transit transfer · ');
    expect(result.largeTransactionAlerts).toEqual([]);
  });

  it('is off when no threshold has ever been set', async () => {
    const seed = largeSpendSeed();
    delete seed.largeTransactionThreshold;
    const { host, store } = createFakeHost(seed);
    const result = await runSyncCore(host, store, {});
    expect(result.largeTransactionAlerts).toEqual([]);
  });

  it('is off for an explicit 0 or a negative threshold', async () => {
    for (const threshold of [0, -50]) {
      const seed = largeSpendSeed();
      seed.largeTransactionThreshold = threshold;
      const { host, store } = createFakeHost(seed);
      const result = await runSyncCore(host, store, {});
      expect(result.largeTransactionAlerts).toEqual([]);
    }
  });

  it('takes "exceeds" literally — an amount exactly on the threshold does not alert', async () => {
    const seed = largeSpendSeed();
    seed.largeTransactionThreshold = 1240;
    const { host, store } = createFakeHost(seed);
    const result = await runSyncCore(host, store, {});
    expect(result.largeTransactionAlerts).toEqual([]);
  });

  it('does not re-alert when a pending row posts under the SAME tx id', async () => {
    const seed = largeSpendSeed();
    const pendingEpoch = recentEpoch();
    seed.accountSet!.accounts[0].transactions = [{
      id: 'tx-1', posted: 0, transacted_at: pendingEpoch, amount: '-1240.00',
      description: 'AMAZON *MKTPLACE', pending: true,
    }];
    const { host, store, saved } = createFakeHost(seed);
    const first = await runSyncCore(host, store, {});
    expect(first.largeTransactionAlerts).toHaveLength(1);

    // The same transaction, now settled. Reconciliation matches it by tx id and
    // UPDATES the stored row in place, so it never reaches plan.creates again.
    saved.length = 0;
    seed.accountSet!.accounts[0].transactions = [{
      id: 'tx-1', posted: pendingEpoch, amount: '-1240.00', description: 'AMAZON *MKTPLACE',
    }];
    const second = await runSyncCore(host, store, { force: true });
    expect(saved[0].updates).toHaveLength(1);   // it really was promoted, not skipped
    expect(saved[0].creates).toEqual([]);
    expect(second.largeTransactionAlerts).toEqual([]);
  });

  it('does not re-alert when a pending row posts under a NEW tx id', async () => {
    const seed = largeSpendSeed();
    const pendingEpoch = recentEpoch();
    seed.accountSet!.accounts[0].transactions = [{
      id: 'tx-pending', posted: 0, transacted_at: pendingEpoch, amount: '-1240.00',
      description: 'AMAZON *MKTPLACE', pending: true,
    }];
    const { host, store, saved } = createFakeHost(seed);
    const first = await runSyncCore(host, store, {});
    expect(first.largeTransactionAlerts).toHaveLength(1);

    // The bank dropped the pending row and re-issued it posted under a fresh id.
    // planReconciliation claims the create as an in-place update of the pending
    // row, so it must not be counted as a new import either.
    saved.length = 0;
    seed.accountSet!.accounts[0].transactions = [{
      id: 'tx-posted', posted: pendingEpoch, amount: '-1240.00', description: 'AMAZON *MKTPLACE',
    }];
    const second = await runSyncCore(host, store, { force: true });
    expect(saved[0].updates).toHaveLength(1);
    expect(saved[0].creates).toEqual([]);
    expect(second.largeTransactionAlerts).toEqual([]);
  });

  it('does not alert for a create the host reported an error on', async () => {
    const { host, store } = createFakeHost(largeSpendSeed());
    const realSaveMany = host.saveMany.bind(host);
    host.saveMany = async (req) => {
      const res = await realSaveMany(req);
      // The row was rejected: nothing was created, so nothing may be announced.
      return { ...res, created: [], errors: [{ action: 'create', message: 'rejected' }] };
    };
    const result = await runSyncCore(host, store, {});
    expect(result.largeTransactionAlerts).toEqual([]);
  });
});
