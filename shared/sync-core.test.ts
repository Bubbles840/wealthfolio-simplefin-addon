import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runSyncCore, applyBaselineFix, VALUATION_POLL, IN_TRANSIT_TIMEOUT_SECONDS, descriptionFromComment, txIdFromComment, planDuplicatePrune, IN_TRANSIT_COMMENT_PREFIX } from './sync-core.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { linkPairByRecreate } from './link-pair.js';
import type { LinkLeg, SyncHost } from './sync-host.js';

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

  // --- Drift: which TRANSFER_OUT legs never booked their cash ---
  //
  // The property that decides it is the leg's ASSET, not its link state:
  // handlers/transfers.rs books cash only when asset_id is empty (see
  // companion/upstream-pr.md issue #5). Linking classifies the pair; it does not
  // move money. So an asset-free leg is never compensated for and an
  // asset-carrying one always is, on either host capability.

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

  /**
   * A drift with an EMPTY reconciliation plan is a proof, not a guess: every
   * transaction the bank reports over the heal window is already present and
   * already matches, so nothing inside the window can explain the gap. What's
   * left is the starting-balance baseline — the one row that stands for history
   * we never saw. Correcting THAT is right; plugging a `Balance adjustment`
   * invents a transaction dated today to paper over a wrong constant.
   *
   * Real figures from the live 360 Savings account: bank $10.65, Wealthfolio
   * $1,310.65, baseline $11,355.12 — which should have been $10,055.12.
   */
  it('offers a baseline correction when a drift is provably baseline-shaped', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '10.65', 'balance-date': 1,
          transactions: [{ id: 'tx-1', posted: 1700000000, amount: '-1300.00', description: 'GROCERY STORE' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a' },
      valuations: new Map([['wf-a', 1310.65]]),
      existing: new Map([['wf-a', [
        { id: 'sb-wf-a', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2023-11-01',
          amount: 11355.12, comment: 'Starting balance · sfin-1', sourceGroupId: null },
        { id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2023-11-14',
          amount: 1300.0, comment: 'GROCERY STORE · tx-1', sourceGroupId: null },
      ]]]),
    });
    await runSyncCore(host, store, { heal: true });
    const balances = await store.getAccountBalances();
    const snap = balances['sfin-1'] as { drift: number | null; baselineFix?: unknown };
    expect(snap.drift).toBeCloseTo(-1300.0, 2);
    expect(snap.baselineFix).toEqual({
      activityId: 'sb-wf-a',
      currentAmount: 11355.12,
      suggestedAmount: 10055.12,
    });
  });

  /**
   * The dangerous case. If ANY transaction is still unaccounted for, the drift
   * may simply be that transaction — and folding it into the baseline would bake
   * a missing row into a constant, making it permanently invisible and wrong in
   * the same breath. The empty plan is the whole licence for this feature.
   */
  it('does NOT offer a baseline correction while a transaction could still explain the drift', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '10.65', 'balance-date': 1,
          transactions: [
            { id: 'tx-1', posted: 1700000000, amount: '-1300.00', description: 'GROCERY STORE' },
            // Reported by the bank, never imported — so the plan has a create.
            { id: 'tx-2', posted: 1700086400, amount: '-25.00', description: 'COFFEE' },
          ] },
      ] },
      mapping: { 'sfin-1': 'wf-a' },
      valuations: new Map([['wf-a', 1310.65]]),
      existing: new Map([['wf-a', [
        { id: 'sb-wf-a', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2023-11-01',
          amount: 11355.12, comment: 'Starting balance · sfin-1', sourceGroupId: null },
        { id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2023-11-14',
          amount: 1300.0, comment: 'GROCERY STORE · tx-1', sourceGroupId: null },
      ]]]),
    });
    await runSyncCore(host, store, { heal: true });
    const snap = (await store.getAccountBalances())['sfin-1'] as { baselineFix?: unknown };
    expect(snap.baselineFix).toBeUndefined();
  });

  /** Only the baseline row itself: enough to correct it, nothing else to disturb. */
  const baselineOnlySeed = (): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [
      { id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '10.65', 'balance-date': 1, transactions: [] },
    ] },
    mapping: { 'sfin-1': 'wf-a' },
    existing: new Map([['wf-a', [
      { id: 'sb-wf-a', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2023-11-01',
        amount: 11355.12, comment: 'Starting balance · sfin-1', sourceGroupId: null },
    ]]]),
  });

  it('rewrites the baseline row in place, keeping its date and marker comment', async () => {
    const { host, saved } = createFakeHost(baselineOnlySeed());
    const res = await applyBaselineFix(host, {
      wfAccountId: 'wf-a', sfAccountId: 'sfin-1', suggestedAmount: 10055.12, currency: 'USD',
    });
    expect(res.applied).toBe(true);
    // In place, so the account keeps ONE baseline row: a delete-and-re-create
    // would lose the marker's identity and a second plug row would accumulate.
    const updates = saved.flatMap((r) => r.updates ?? []);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: 'sb-wf-a',
      accountId: 'wf-a',
      activityType: 'DEPOSIT',
      activityDate: '2023-11-01',
      amount: 10055.12,
      comment: 'Starting balance · sfin-1',
    });
    expect(saved.flatMap((r) => r.creates ?? [])).toEqual([]);
    expect(saved.flatMap((r) => r.deleteIds ?? [])).toEqual([]);
  });

  it('flips the baseline to WITHDRAWAL when the correction takes it negative', async () => {
    const { host, saved } = createFakeHost(baselineOnlySeed());
    await applyBaselineFix(host, {
      wfAccountId: 'wf-a', sfAccountId: 'sfin-1', suggestedAmount: -42.5, currency: 'USD',
    });
    // `amount` is a magnitude; the sign lives in the type, so a correction that
    // crosses zero has to change the type or it silently lands as +42.50.
    expect(saved.flatMap((r) => r.updates ?? [])[0]).toMatchObject({
      activityType: 'WITHDRAWAL', amount: 42.5,
    });
  });

  it('writes nothing and reports failure when the account has no baseline row', async () => {
    const { host, saved } = createFakeHost({ mapping: { 'sfin-1': 'wf-a' } });
    const res = await applyBaselineFix(host, {
      wfAccountId: 'wf-a', sfAccountId: 'sfin-1', suggestedAmount: 1, currency: 'USD',
    });
    expect(res.applied).toBe(false);
    expect(saved).toEqual([]);
  });

  it("does not inflate drift with the user's Spend-account TRANSFER_OUT rows, linked or not", async () => {
    // Regression for e80707a: real figures from the live companion — bank
    // 3475.23, Wealthfolio 2175.23, 7350.45 of TRANSFER_OUT rows whose cash
    // Wealthfolio has ALREADY deducted. True drift is 1300.00; the original bug
    // reported 8650.45 and would have plugged that much into a real account.
    //
    // e80707a made that pass by trusting the rows' sourceGroupId. That was the
    // wrong property: these legs carry no asset, which is what actually booked
    // their cash. The second pass below strips the group ids and demands the very
    // same figure, so this test can no longer pass for the old reason alone.
    const seed = (sourceGroupIds: [string | null, string | null]): FakeHostSeed => ({
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
          sourceGroupId: sourceGroupIds[0] },
        { id: 'out-2', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-02',
          amount: 1300.0, comment: 'Online Transfer to Savings · tx-b',
          sourceGroupId: sourceGroupIds[1] },
      ]]]),
    });

    const linked = createFakeHost(seed(['wf-transfer-aaa', 'wf-transfer-bbb']));
    await runSyncCore(linked.host, linked.store, {});
    expect(await storedDrift(linked.store, 'sfin-1')).toBeCloseTo(1300.0, 2);

    const unlinked = createFakeHost(seed([null, null]));
    await runSyncCore(unlinked.host, unlinked.store, {});
    expect(await storedDrift(unlinked.store, 'sfin-1')).toBeCloseTo(1300.0, 2);
  });

  it("reproduces the user's live database: asset-free legs booked their cash, linked or not", async () => {
    // Straight off the production database. Every one of his 18 TRANSFER_OUT
    // legs carries NO asset, so every one of them booked cash (handlers/
    // transfers.rs books cash only on the `asset_id.is_empty()` branch —
    // upstream-pr.md issue #5). Four of them (4000.00 across two accounts) were
    // merely UNLINKED, and subtracting those double-counted money already gone:
    // Spend read 2700.00 instead of 1300.00, Save 3897.50 instead of 1297.50.
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Spend', currency: 'USD',
          balance: '3475.23', 'balance-date': 1, transactions: [] },
        { id: 'sfin-2', name: 'Save', currency: 'USD',
          balance: '5297.50', 'balance-date': 1, transactions: [] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
      accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
      valuations: new Map([['wf-a', 2175.23], ['wf-b', 4000.0]]),
      existing: new Map([
        ['wf-a', [
          startingBalanceRow('wf-a', 'sfin-1'),
          { id: 'out-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-01',
            amount: 900.0, comment: 'Online Transfer to Savings · tx-a', sourceGroupId: null },
          { id: 'out-2', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-02',
            amount: 500.0, comment: 'Online Transfer to Savings · tx-b', sourceGroupId: null },
        ]],
        ['wf-b', [
          startingBalanceRow('wf-b', 'sfin-2'),
          { id: 'out-3', accountId: 'wf-b', activityType: 'TRANSFER_OUT', date: '2026-07-01',
            amount: 2000.0, comment: 'Online Transfer to Spend · tx-c', sourceGroupId: null },
          { id: 'out-4', accountId: 'wf-b', activityType: 'TRANSFER_OUT', date: '2026-07-02',
            amount: 600.0, comment: 'Online Transfer to Spend · tx-d', sourceGroupId: null },
        ]],
      ]),
    });
    const result = await runSyncCore(host, store, {});
    // Plain sfBalance − wfValuation, no adjustment: the cash is already out.
    expect(await storedDrift(store, 'sfin-1')).toBeCloseTo(1300.0, 2);
    expect(await storedDrift(store, 'sfin-2')).toBeCloseTo(1297.5, 2);
    // Both are past the $100 default, so he is legitimately alerted — off the
    // CORRECTED figure, which is the same one the Sync page shows.
    expect(result.balanceDriftAlerts.map((a) => [a.sfinAccountId, a.driftAmount])).toEqual([
      ['sfin-1', 1300.0],
      ['sfin-2', 1297.5],
    ]);
  });

  it('still compensates for a TRANSFER_OUT that CARRIES an asset (it booked no cash)', async () => {
    // An asset-carrying leg takes the non-cash branch in handlers/transfers.rs,
    // so Wealthfolio's valuation never moved — netting it out is what keeps it
    // from reading as drift. (The relink sweep re-creates it asset-free, so this
    // compensation applies to the run that finds it.)
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
          assetId: '$CASH', sourceGroupId: null },
      ]]]),
    });
    await runSyncCore(host, store, {});
    // 2675.23 − 500 = 2175.23 adjusted, so 3475.23 − 2175.23 = 1300.00.
    expect(await storedDrift(store, 'sfin-1')).toBeCloseTo(1300.0, 2);
  });

  it.each([
    { readsGroups: true, linked: true },
    { readsGroups: true, linked: false },
    { readsGroups: false, linked: true },
    { readsGroups: false, linked: false },
  ])(
    'never compensates for an asset-free TRANSFER_OUT (readsGroups=$readsGroups, linked=$linked)',
    async ({ readsGroups, linked }) => {
      // Link state is irrelevant to cash: an asset-free leg books cash either
      // way, so all four combinations must land on the same unadjusted figure.
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
            sourceGroupId: linked ? 'wf-transfer-aaa' : null },
        ]]]),
      });
      host.capabilities.readsSourceGroupId = readsGroups;
      if (linked && !readsGroups) {
        // On the addon a row's apparent group means nothing and only the ledger
        // may vouch — seeded here so neither signal is left untried.
        await store.setLinkedGroups({ 'tx-a': 'wf-transfer-aaa' });
      }
      await runSyncCore(host, store, {});
      // 3475.23 − 2675.23, with nothing netted out.
      expect(await storedDrift(store, 'sfin-1')).toBeCloseTo(800.0, 2);
    },
  );

  it('reads no drift from a ledger-vouched, asset-free pair on a ledger-backed host', async () => {
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
    // Both legs already recorded under one echo-confirmed group id, so the
    // linking step leaves the pair alone (no churn on a re-sync).
    await store.setLinkedGroups({ 'tx-out': 'wf-transfer-g1', 'tx-in': 'wf-transfer-g1' });
    await runSyncCore(host, store, {});
    // The out leg carries no asset, so its 500 is already out of Wealthfolio's
    // valuation and is NOT subtracted: 1010.00 − 1000 = 10.00.
    expect(await storedDrift(store, 'sfin-1')).toBeCloseTo(10.0, 2);
    expect(await store.getLinkedGroups()).toEqual({
      'tx-out': 'wf-transfer-g1',
      'tx-in': 'wf-transfer-g1',
    });
  });

  /**
   * The ledger is the ONLY thing a host that can't read `sourceGroupId` back
   * (the companion) has to decide whether a pair is already linked. Keyed by
   * bare tx id, a shared-id pair collapses to ONE entry — and that entry cannot
   * distinguish "both legs confirmed" from "the echo collapsed and only one leg
   * was grouped", because the writer that produced it could not tell either.
   * Trusting it means the companion skips a half-linked pair forever, which
   * silently leaves a transfer leg counting as spending.
   */
  it('re-verifies a shared-id pair that only a legacy bare-txId entry vouches for', async () => {
    const sharedId = (): FakeHostSeed => ({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'TRN-shared', posted: 1700000000, amount: '-500.00', description: 'Payment to Card' }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'TRN-shared', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
    });
    const { host, store, links } = createFakeHost(sharedId());
    host.capabilities.readsSourceGroupId = false;
    await store.setLinkedGroups({ 'TRN-shared': 'wf-transfer-g1' });
    await runSyncCore(host, store, {});
    expect(links).toHaveLength(1);
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

  /**
   * `linkPair` deletes both rows before re-creating them, so a refused re-create
   * loses financial rows. Reporting only "1 transfer leg(s) could not be linked"
   * gives no way to tell a rejected duplicate from a validation error from a
   * silently dropped group — and that message is heal-gated, so a routine sync
   * could lose rows and say nothing at all. The reason travels with the failure.
   */
  it('surfaces WHY a link failed, not just that one did', async () => {
    const { host, store } = createFakeHost(transferPairSeed());
    host.linkPair = async () => ({
      linked: false,
      problems: ['save (create): duplicate activity'],
    });
    const result = await runSyncCore(host, store, { force: true });
    expect(result.errors.join('\n')).toContain('duplicate activity');
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

  // --- Balance-drift alerts ---

  /** The user's real Spend account: bank 3475.23, Wealthfolio 2175.23, so a
   *  settled $1,300.00 of drift. No transactions, so the run creates nothing and
   *  the drift figure is trustworthy. */
  const driftSeed = (valuations = new Map([['wf-a', 2175.23]])): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [{
      id: 'sfin-1', name: 'Spend Bank', currency: 'USD',
      balance: '3475.23', 'balance-date': 1, transactions: [],
    }] },
    mapping: { 'sfin-1': 'wf-a' },
    accountTypes: { 'wf-a': 'CASH' },
    accountNames: { 'wf-a': 'Spend' },
    valuations,
    existing: new Map([['wf-a', [startingBalanceRow('wf-a', 'sfin-1')]]]),
  });

  it('reports a balance-drift alert with everything needed to act on it', async () => {
    const { host, store } = createFakeHost(driftSeed());
    const result = await runSyncCore(host, store, {});
    expect(result.balanceDriftAlerts).toEqual([{
      sfinAccountId: 'sfin-1',
      accountName: 'Spend',
      driftAmount: 1300.0,
      currency: 'USD',
      bankBalance: 3475.23,
    }]);
  });

  it('records the episode so a second sync does not re-alert', async () => {
    const seed = driftSeed();
    const { host, store } = createFakeHost(seed);
    await runSyncCore(host, store, {});
    expect(await store.getDriftAlerts()).toEqual({
      'sfin-1': { driftAmount: 1300.0, firstDetectedAt: expect.any(String), alerted: true },
    });
    const second = await runSyncCore(host, store, { force: true });
    expect(second.balanceDriftAlerts).toEqual([]);
  });

  it('re-arms when the account comes back under the threshold, and alerts again on a recurrence', async () => {
    const valuations = new Map([['wf-a', 2175.23]]);
    const { host, store } = createFakeHost(driftSeed(valuations));
    expect((await runSyncCore(host, store, {})).balanceDriftAlerts).toHaveLength(1);

    // The user reconciled: Wealthfolio now matches the bank.
    valuations.set('wf-a', 3475.23);
    const healthy = await runSyncCore(host, store, { force: true });
    expect(healthy.balanceDriftAlerts).toEqual([]);
    expect(await store.getDriftAlerts()).toEqual({}); // re-armed, not just quiet

    // It drifts again — a genuinely new episode, so it must be announced again.
    valuations.set('wf-a', 2175.23);
    const recurrence = await runSyncCore(host, store, { force: true });
    expect(recurrence.balanceDriftAlerts).toHaveLength(1);
  });

  it('defaults to a $100 threshold when the user has never set one', async () => {
    const under = createFakeHost(driftSeed(new Map([['wf-a', 3400.0]])));
    // 3475.23 − 3400.00 = 75.23: real, shown on the Sync page, not worth a ping.
    expect((await runSyncCore(under.host, under.store, {})).balanceDriftAlerts).toEqual([]);
    expect(await storedDrift(under.store, 'sfin-1')).toBeCloseTo(75.23, 2);

    const over = createFakeHost(driftSeed(new Map([['wf-a', 3300.0]])));
    // 175.23 — over the default, so it pings.
    expect((await runSyncCore(over.host, over.store, {})).balanceDriftAlerts).toHaveLength(1);
  });

  it('honours a configured threshold instead of the default', async () => {
    const seed = driftSeed();
    seed.driftAlertThreshold = 2000;
    const { host, store } = createFakeHost(seed);
    expect((await runSyncCore(host, store, {})).balanceDriftAlerts).toEqual([]);
  });

  it('is off for an explicit 0 or a negative threshold', async () => {
    for (const threshold of [0, -50]) {
      const seed = driftSeed();
      seed.driftAlertThreshold = threshold;
      const { host, store } = createFakeHost(seed);
      const result = await runSyncCore(host, store, {});
      expect(result.balanceDriftAlerts).toEqual([]);
      expect(await store.getDriftAlerts()).toEqual({});
    }
  });

  it('never alerts off the DISPLAY threshold — a $2 drift is shown, not announced', async () => {
    // DRIFT_THRESHOLD_DOLLARS is 1, and reusing it here would ping on every
    // rounding wobble. It decides what the Sync page SHOWS, nothing more.
    const { host, store } = createFakeHost(driftSeed(new Map([['wf-a', 3473.23]])));
    const result = await runSyncCore(host, store, {});
    expect(await storedDrift(store, 'sfin-1')).toBeCloseTo(2.0, 2);
    expect(result.balanceDriftAlerts).toEqual([]);
  });

  it('says nothing — and re-arms nothing — on a run where drift is not measurable', async () => {
    // A pending row makes the SimpleFin posted balance and Wealthfolio's
    // valuation incomparable, so runSyncCore leaves drift null on purpose.
    // Treating that as "back under the threshold" would clear the episode and
    // re-alert on the very next measurable run: alert spam via the back door.
    const seed = driftSeed();
    seed.accountSet!.accounts[0].transactions = [{
      id: 'tx-p', posted: 0, transacted_at: recentEpoch(), amount: '-5.00',
      description: 'Coffee', pending: true,
    }];
    seed.driftAlerts = {
      'sfin-1': { driftAmount: 1300.0, firstDetectedAt: '2026-07-01T00:00:00Z', alerted: true },
    };
    const { host, store } = createFakeHost(seed);
    const result = await runSyncCore(host, store, {});
    expect(await storedDrift(store, 'sfin-1')).toBeNull();
    expect(result.balanceDriftAlerts).toEqual([]);
    expect(await store.getDriftAlerts()).toEqual({
      'sfin-1': { driftAmount: 1300.0, firstDetectedAt: '2026-07-01T00:00:00Z', alerted: true },
    });
  });

  it('does not alert on drift an already-cashed TRANSFER_OUT only appears to cause', async () => {
    // The bug fixed in e80707a reported 8650.45 of phantom drift on this exact
    // account. The alert must never fire off a figure like that — the leg is
    // asset-free, so its cash left the valuation when it was written.
    const { host, store } = createFakeHost({
      ...driftSeed(new Map([['wf-a', 3475.23]])),
      existing: new Map([['wf-a', [
        startingBalanceRow('wf-a', 'sfin-1'),
        { id: 'out-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-01',
          amount: 6050.45, comment: 'Online Transfer to Savings · tx-a',
          sourceGroupId: 'wf-transfer-aaa' },
      ]]]),
    });
    const result = await runSyncCore(host, store, {});
    expect(await storedDrift(store, 'sfin-1')).toBeNull();
    expect(result.balanceDriftAlerts).toEqual([]);
  });

  it('does not alert when aggressive auto-heal already plugged the drift this run', async () => {
    const seed = driftSeed();
    seed.autoHeal = true;
    seed.autoAdjust = true;
    const { host, store, imported } = createFakeHost(seed);
    const result = await runSyncCore(host, store, { heal: true });
    // The plug really happened — so there is nothing left for the user to do.
    expect(imported.flat().some((r) => r.comment.startsWith('Balance adjustment'))).toBe(true);
    expect(result.balanceDriftAlerts).toEqual([]);
    expect(await store.getDriftAlerts()).toEqual({});
  });

  it('names the SimpleFin account when the host reports no Wealthfolio account name', async () => {
    const seed = driftSeed();
    delete seed.accountNames;
    const { host, store } = createFakeHost(seed);
    const result = await runSyncCore(host, store, {});
    expect(result.balanceDriftAlerts[0].accountName).toBe('Spend Bank');
  });

  // ── Feed dedup by SimpleFin transaction id ───────────────────────────────
  //
  // Live incident (2026-07-27, the user's savings account): two activities with
  // the SAME SimpleFin transaction id, both created in one batch, reading the
  // account $1,297.50 too low. Wealthfolio's own duplicate guard rejects a
  // colliding create ACROSS batches with a 400, but cannot compare two rows
  // inside a single request against each other — so the feed itself has to be
  // collapsed before the plan is built.

  it('creates ONE row when SimpleFin returns the same transaction id twice in one account', async () => {
    const repeated = {
      id: 'TRN-ce426394', posted: 1751328000, amount: '2.50',
      description: 'Monthly Interest Paid',
    };
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '610.65',
        'balance-date': 1,
        transactions: [{ ...repeated }, { ...repeated }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
    });
    const result = await runSyncCore(host, store, {});
    const creates = saved.flatMap((s) => s.creates ?? []);
    expect(creates.filter((c) => c.comment.includes('TRN-ce426394'))).toHaveLength(1);
    expect(result.imported).toBe(1);
  });

  it('keeps the POSTED copy when the same transaction id arrives pending and posted', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [
          { id: 'TRN-dup', posted: 0, transacted_at: 1751328000, amount: '2.50',
            description: 'Monthly Interest Paid', pending: true },
          { id: 'TRN-dup', posted: 1751500000, amount: '2.50',
            description: 'Monthly Interest Paid' },
        ],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
    });
    await runSyncCore(host, store, {});
    const creates = saved.flatMap((s) => s.creates ?? []);
    expect(creates).toHaveLength(1);
    // No ` · pending` suffix: the settled copy won regardless of feed order.
    expect(creates[0].comment).toBe('Monthly Interest Paid · TRN-dup');
  });

  it('keeps the posted copy even when the pending one comes last', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [
          { id: 'TRN-dup', posted: 1751500000, amount: '2.50', description: 'Interest' },
          { id: 'TRN-dup', posted: 0, transacted_at: 1751328000, amount: '2.50',
            description: 'Interest', pending: true },
        ],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
    });
    await runSyncCore(host, store, {});
    const creates = saved.flatMap((s) => s.creates ?? []);
    expect(creates).toHaveLength(1);
    expect(creates[0].comment).toBe('Interest · TRN-dup');
  });

  it('keeps the LAST copy when a restated amount arrives under the same id', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [
          { id: 'TRN-dup', posted: 1751500000, amount: '-12.50', description: 'Coffee' },
          { id: 'TRN-dup', posted: 1751500000, amount: '-14.75', description: 'Coffee' },
        ],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
    });
    await runSyncCore(host, store, {});
    const creates = saved.flatMap((s) => s.creates ?? []);
    expect(creates).toHaveLength(1);
    expect(creates[0].amount).toBe(14.75);
  });

  it('logs a greppable line naming the dropped transaction id and its account', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const repeated = {
        id: 'TRN-3917f117', posted: 1753574400, amount: '-1300.00',
        description: 'PNC BANK Transfer',
      };
      const { host, store } = createFakeHost({
        accountSet: { errors: [], accounts: [{
          id: 'sfin-savings', name: 'Savings', currency: 'USD', balance: '0',
          'balance-date': 1, transactions: [{ ...repeated }, { ...repeated }],
        }] },
        mapping: { 'sfin-savings': 'wf-a' },
        accountTypes: { 'wf-a': 'CASH' },
      });
      await runSyncCore(host, store, {});
      const line = warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('duplicate-feed-tx'));
      expect(line).toBeDefined();
      expect(line).toContain('TRN-3917f117');
      expect(line).toContain('sfin-savings');
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT dedup across accounts — one transaction id can legitimately be in two', async () => {
    // Confirmed in the user's live data (TRN-41fee96e sits in two accounts as the
    // two halves of one transfer). Deduplicating globally would destroy the pair.
    // Same-sign amounts here so no transfer pairing runs and the assertion is
    // purely about the dedup's per-account keying.
    const shared = {
      id: 'TRN-41fee96e', posted: 1753574400, amount: '25.00',
      description: 'Interest Paid',
    };
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ ...shared }] },
        { id: 'sfin-2', name: 'Spend', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ ...shared }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
      accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
    });
    const result = await runSyncCore(host, store, {});
    const creates = saved.flatMap((s) => s.creates ?? []);
    expect(creates.filter((c) => c.comment.includes('TRN-41fee96e'))).toHaveLength(2);
    expect(new Set(creates.map((c) => c.accountId))).toEqual(new Set(['wf-a', 'wf-b']));
    expect(result.imported).toBe(2);
  });

  // ── Pruning duplicates already in the database (heal/reconcile only) ──────

  /** Recent enough that the unpaired PNC transfer is still "in transit" (the
   *  placeholder window is 10 days), so the stored rows below are exactly the
   *  spending-neutral CREDIT shape production holds. */
  const pncEpoch = () => Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
  const INTEREST_EPOCH = Math.floor(Date.parse('2026-06-30T12:00:00Z') / 1000);
  const INTEREST_DATE = '2026-06-30';

  /**
   * The live incident, reproduced: the user's savings account holding TWO copies
   * of each of two SimpleFin transactions — the $1,300 in-transit PNC transfer
   * (stored as a CREDIT with the amount on the FEE side, hence `amount: 0`) and
   * the $2.50 monthly interest. Net effect on his balance was −$1,297.50.
   *
   * The duplicate ids are deliberately stored with the HIGHER activity id first,
   * so "keep the lowest id" is tested against insertion order rather than
   * accidentally agreeing with it.
   */
  const duplicateSeed = (): FakeHostSeed => {
    const pnc = pncEpoch();
    const pncDate = new Date(pnc * 1000).toISOString().slice(0, 10);
    const inTransitComment =
      '↔️ In-transit transfer · PNC BANK 1234 Transfer · TRN-3917f117';
    return {
      accountSet: { errors: [], accounts: [{
        id: 'sfin-savings', name: 'Savings Bank', currency: 'USD',
        balance: '610.65', 'balance-date': 1,
        transactions: [
          { id: 'TRN-3917f117', posted: pnc, amount: '-1300.00', description: 'PNC BANK 1234 Transfer' },
          { id: 'TRN-ce426394', posted: INTEREST_EPOCH, amount: '2.50', description: 'Monthly Interest Paid' },
        ],
      }] },
      mapping: { 'sfin-savings': 'wf-sav' },
      accountTypes: { 'wf-sav': 'CASH' },
      accountNames: { 'wf-sav': 'Savings' },
      existing: new Map([['wf-sav', [
        { id: 'act-2', accountId: 'wf-sav', activityType: 'CREDIT', date: pncDate,
          amount: 0, comment: inTransitComment, sourceGroupId: null },
        { id: 'act-1', accountId: 'wf-sav', activityType: 'CREDIT', date: pncDate,
          amount: 0, comment: inTransitComment, sourceGroupId: null },
        { id: 'act-4', accountId: 'wf-sav', activityType: 'DEPOSIT', date: INTEREST_DATE,
          amount: 2.5, comment: 'Monthly Interest Paid · TRN-ce426394', sourceGroupId: null },
        { id: 'act-3', accountId: 'wf-sav', activityType: 'DEPOSIT', date: INTEREST_DATE,
          amount: 2.5, comment: 'Monthly Interest Paid · TRN-ce426394', sourceGroupId: null },
      ]]]),
    };
  };

  it('prunes the live duplicate pair down to one row each on a reconcile', async () => {
    const { host, store, saved, activities } = createFakeHost(duplicateSeed());
    const result = await runSyncCore(host, store, { heal: true });

    const deleted = saved.flatMap((s) => s.deleteIds ?? []);
    expect(deleted).toEqual(['act-2', 'act-4']);
    // One copy of each transaction survives, and it is the lowest-id one.
    const left = activities.get('wf-sav')!.map((r) => r.id).sort();
    expect(left).toEqual(['act-1', 'act-3']);

    expect(result.prunedDuplicates).toEqual([
      {
        sfinAccountId: 'sfin-savings',
        accountName: 'Savings',
        txId: 'TRN-3917f117',
        // Stripped of both the in-transit prefix and the tx-id suffix.
        description: 'PNC BANK 1234 Transfer',
        date: new Date(pncEpoch() * 1000).toISOString().slice(0, 10),
        // The FULL magnitude, from the feed: the stored row books it as `fee`, so
        // its own `amount` is 0 and reporting that would say "$0.00 removed".
        amountCents: 130000,
        currency: 'USD',
        wfId: 'act-2',
      },
      {
        sfinAccountId: 'sfin-savings',
        accountName: 'Savings',
        txId: 'TRN-ce426394',
        description: 'Monthly Interest Paid',
        date: INTEREST_DATE,
        amountCents: 250,
        currency: 'USD',
        wfId: 'act-4',
      },
    ]);
  });

  it('does NOT prune on a routine sync — only heal/reconcile deletes rows', async () => {
    const { host, store, saved, activities } = createFakeHost(duplicateSeed());
    const result = await runSyncCore(host, store, {});
    expect(saved.flatMap((s) => s.deleteIds ?? [])).toEqual([]);
    expect(result.prunedDuplicates).toEqual([]);
    expect(activities.get('wf-sav')).toHaveLength(4);
  });

  it('converges: a second reconcile finds nothing left to prune', async () => {
    const { host, store, saved } = createFakeHost(duplicateSeed());
    await runSyncCore(host, store, { heal: true });
    const deletesAfterFirst = saved.flatMap((s) => s.deleteIds ?? []).length;
    await runSyncCore(host, store, { heal: true });
    expect(saved.flatMap((s) => s.deleteIds ?? []).length).toBe(deletesAfterFirst);
  });

  it('never deletes a starting-balance baseline or two same-date balance adjustments', async () => {
    // The sharpest trap in this sweep: `txIdFromComment` reads the segment after
    // the last ' · ', so a starting-balance row yields the ACCOUNT ID as its
    // "transaction id" and a balance adjustment yields its DATE — so two
    // adjustments written on one day look exactly like a duplicate pair, and
    // deleting the baseline would silently corrupt the account's whole history.
    const seed = duplicateSeed();
    seed.existing = new Map([['wf-sav', [
      { id: 'sb-1', accountId: 'wf-sav', activityType: 'DEPOSIT', date: '2026-01-01',
        amount: 500, comment: 'Starting balance · sfin-savings', sourceGroupId: null },
      { id: 'adj-1', accountId: 'wf-sav', activityType: 'CREDIT', date: '2026-07-29',
        amount: 12.34, comment: 'Balance adjustment · sfin-savings · 2026-07-29', sourceGroupId: null },
      { id: 'adj-2', accountId: 'wf-sav', activityType: 'CREDIT', date: '2026-07-29',
        amount: 56.78, comment: 'Balance adjustment · sfin-savings · 2026-07-29', sourceGroupId: null },
    ]]]);
    const { host, store, saved, activities } = createFakeHost(seed);
    const result = await runSyncCore(host, store, { heal: true });
    expect(saved.flatMap((s) => s.deleteIds ?? [])).toEqual([]);
    expect(result.prunedDuplicates).toEqual([]);
    expect(activities.get('wf-sav')!.map((r) => r.id)).toEqual(
      expect.arrayContaining(['sb-1', 'adj-1', 'adj-2']),
    );
  });

  it('leaves one transaction id that legitimately sits in two accounts alone', async () => {
    // Confirmed live (TRN-41fee96e). The sweep is per account, so a single copy
    // in each of two accounts is not a duplicate — deleting one would destroy
    // half of a transfer pair.
    const shared = {
      id: 'TRN-41fee96e', posted: INTEREST_EPOCH, amount: '25.00',
      description: 'Interest Paid',
    };
    const row = (id: string, accountId: string) => ({
      id, accountId, activityType: 'DEPOSIT', date: INTEREST_DATE, amount: 25,
      comment: 'Interest Paid · TRN-41fee96e', sourceGroupId: null,
    });
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ ...shared }] },
        { id: 'sfin-2', name: 'Spend', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ ...shared }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
      accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
      existing: new Map([
        ['wf-a', [row('act-a', 'wf-a')]],
        ['wf-b', [row('act-b', 'wf-b')]],
      ]),
    });
    const result = await runSyncCore(host, store, { heal: true });
    expect(saved.flatMap((s) => s.deleteIds ?? [])).toEqual([]);
    expect(result.prunedDuplicates).toEqual([]);
  });

  it('does not measure drift (or plug it) on an account it pruned this run', async () => {
    // `wfValuation` was read BEFORE the prune, so it still counts the rows just
    // deleted — exactly as stale as it is after an update or a delete, which the
    // measurement already refuses to trust. With aggressive auto-heal on,
    // believing it would write the duplicate's own amount into the account as a
    // balance adjustment.
    const seed = duplicateSeed();
    seed.valuations = new Map([['wf-sav', -686.85]]);
    seed.autoHeal = true;
    seed.autoAdjust = true;
    const { host, store, imported } = createFakeHost(seed);
    const result = await runSyncCore(host, store, { heal: true });
    expect(result.prunedDuplicates).toHaveLength(2);
    expect(imported.flat().filter((r) => r.comment.startsWith('Balance adjustment · '))).toEqual([]);
    const balances = (await store.getAccountBalances()) as Record<string, { drift: number | null }>;
    expect(balances['sfin-savings'].drift).toBeNull();
    expect(result.balanceDriftAlerts).toEqual([]);
  });
});

describe('planDuplicatePrune', () => {
  const row = (wfId: string, txId: string, comment: string) => ({
    wfId, wfAccountId: 'wf-a', txId, absCents: 100, type: 'DEPOSIT',
    date: '2026-07-01', pending: false, comment,
  });

  it('keeps the lowest activity id and returns every other copy', () => {
    const rows = [
      row('c', 'TRN-1', 'Coffee · TRN-1'),
      row('a', 'TRN-1', 'Coffee · TRN-1'),
      row('b', 'TRN-1', 'Coffee · TRN-1'),
    ];
    const removed = planDuplicatePrune(rows, new Set(['TRN-1']));
    expect(removed.map((r) => r.wfId)).toEqual(['b', 'c']);
  });

  it('refuses to touch internal marker rows even when the feed claims their parsed id', () => {
    // `txIdFromComment` gives the ACCOUNT ID for a starting balance and the DATE
    // for a balance adjustment. Both are excluded by NOTE PREFIX, never by the
    // shape of the parsed id — so even a feed that somehow contained those exact
    // strings cannot make the sweep delete bookkeeping rows.
    const rows = [
      row('sb-1', 'sfin-1', 'Starting balance · sfin-1'),
      row('sb-2', 'sfin-1', 'Starting balance · sfin-1'),
      row('adj-1', '2026-07-29', 'Balance adjustment · sfin-1 · 2026-07-29'),
      row('adj-2', '2026-07-29', 'Balance adjustment · sfin-1 · 2026-07-29'),
    ];
    expect(planDuplicatePrune(rows, new Set(['sfin-1', '2026-07-29']))).toEqual([]);
  });

  it('ignores duplicates whose id this run\'s feed does not vouch for', () => {
    // A hand-entered Wealthfolio note ending in the same word parses to the same
    // "tx id" ("Lunch · Tuesday" / "Coffee · Tuesday"). Requiring SimpleFin to
    // have just reported the id for this account is what keeps such rows out.
    const rows = [
      row('h-1', 'Tuesday', 'Lunch · Tuesday'),
      row('h-2', 'Tuesday', 'Coffee · Tuesday'),
    ];
    expect(planDuplicatePrune(rows, new Set(['TRN-1']))).toEqual([]);
  });

  it('returns nothing when every id appears once', () => {
    const rows = [row('a', 'TRN-1', 'Coffee · TRN-1'), row('b', 'TRN-2', 'Tea · TRN-2')];
    expect(planDuplicatePrune(rows, new Set(['TRN-1', 'TRN-2']))).toEqual([]);
  });
});

describe('descriptionFromComment', () => {
  // The inverse of `txIdFromComment`: what a stored note looks like to a HUMAN.
  // Every synced activity's note is `<bank description> · <SimpleFin tx id>`,
  // optionally ` · pending`, optionally behind the in-transit marker — so the raw
  // value is never display-ready. Rendering it as-is would show a reader
  // `WHOLEFOODS #123 · TRN-a1b2c3d4-…`, leaking an internal id.
  it('drops the tx-id suffix from a plain synced note', () => {
    expect(descriptionFromComment('WHOLEFOODS #123 · TRN-a1b2c3d4')).toBe('WHOLEFOODS #123');
  });

  it('drops the pending marker as well as the tx id', () => {
    expect(descriptionFromComment('WHOLEFOODS #123 · TRN-a1b2c3d4 · pending')).toBe('WHOLEFOODS #123');
  });

  it('strips the in-transit prefix, which sits in FRONT of the description', () => {
    expect(descriptionFromComment(`${IN_TRANSIT_COMMENT_PREFIX}Online Transfer to Savings · tx-a`))
      .toBe('Online Transfer to Savings');
  });

  it('handles the in-transit prefix and the pending marker together', () => {
    expect(descriptionFromComment(`${IN_TRANSIT_COMMENT_PREFIX}Online Transfer to Savings · tx-a · pending`))
      .toBe('Online Transfer to Savings');
  });

  it('keeps a ` · ` that is part of the description itself', () => {
    // `lastIndexOf` is what makes this work, and the side matters: everything
    // BEFORE the final separator is the description, so only the trailing field
    // (the id) is removed. Taking everything before the FIRST separator instead
    // would silently truncate the merchant to "COSTCO GAS", and `txIdFromComment`
    // — which reads the same separator from the same end — would disagree with
    // this helper about where the id begins.
    expect(descriptionFromComment('COSTCO GAS · PUMP 4 · TRN-a1b2c3d4')).toBe('COSTCO GAS · PUMP 4');
    expect(txIdFromComment('COSTCO GAS · PUMP 4 · TRN-a1b2c3d4')).toBe('TRN-a1b2c3d4');
  });

  it('returns a note that carries no separator unchanged', () => {
    // A hand-entered Wealthfolio activity is not a synced row and has no id to
    // strip; showing its note verbatim is right.
    expect(descriptionFromComment('Lunch with Ana')).toBe('Lunch with Ana');
  });

  it('returns an empty string for a missing note rather than throwing', () => {
    expect(descriptionFromComment(null)).toBe('');
    expect(descriptionFromComment(undefined)).toBe('');
    expect(descriptionFromComment('')).toBe('');
  });

  it('returns an empty string when the note is only an id', () => {
    // Reachable: the SimpleFin description can be blank, in which case the note
    // is written as ` · <txId>`. Callers render the category alone rather than a
    // blank merchant.
    expect(descriptionFromComment(' · TRN-a1b2c3d4')).toBe('');
  });
});

/**
 * SimpleFin issues ONE transaction id for BOTH sides of a transfer between two
 * accounts it connects. Everything the sync core keys by tx id ACROSS accounts —
 * the resolved type, the bank description, the signed amount, the row to link —
 * therefore had one leg silently overwrite the other.
 *
 * These drive the whole of `runSyncCore`, not `detectTransferPairs` in isolation,
 * because the isolated call is not evidence about the end-to-end path: it was the
 * end-to-end run that showed the savings leg being UPDATED from TRANSFER_OUT to
 * TRANSFER_IN and relabelled with the other account's description, `linkPair`
 * being handed the same row twice, and the starting-balance baseline taking the
 * wrong sign.
 */
describe('runSyncCore with ONE SimpleFin tx id in two accounts', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });

  const DAY = 24 * 60 * 60;
  /** Recent, so the in-transit timeout (10 days) is never what decides a type. */
  const nowSec = () => Math.floor(Date.now() / 1000);
  const day = (epoch: number) => new Date(epoch * 1000).toISOString().split('T')[0];

  /** The live shape: one id, two mapped accounts, opposite signs, and the two
   *  stored legs ALREADY correctly typed and already grouped together. */
  const liveSharedIdSeed = (txId: string): FakeHostSeed => {
    const outAt = nowSec() - 3 * DAY;
    const inAt = outAt + 3600;
    return {
      accountSet: { errors: [], accounts: [
        { id: 'sfin-sav', name: '360 Performance Savings', currency: 'USD', balance: '610.65',
          'balance-date': nowSec(),
          transactions: [{ id: txId, posted: outAt, amount: '-1300.00', description: 'Online Transfer to Spend' }] },
        { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '3475.23',
          'balance-date': nowSec(),
          transactions: [{ id: txId, posted: inAt, amount: '1300.00', description: 'Online Transfer from Savings' }] },
      ] },
      mapping: { 'sfin-sav': 'wf-sav', 'sfin-spend': 'wf-spend' },
      accountTypes: { 'wf-sav': 'CASH', 'wf-spend': 'CASH' },
      valuations: new Map([['wf-sav', 610.65], ['wf-spend', 3475.23]]),
      existing: new Map([
        ['wf-sav', [{ id: 'row-out', accountId: 'wf-sav', activityType: 'TRANSFER_OUT',
          date: day(outAt), amount: 1300, comment: `Online Transfer to Spend · ${txId}`,
          sourceGroupId: 'wf-transfer-live' }]],
        ['wf-spend', [{ id: 'row-in', accountId: 'wf-spend', activityType: 'TRANSFER_IN',
          date: day(inAt), amount: 1300, comment: `Online Transfer from Savings · ${txId}`,
          sourceGroupId: 'wf-transfer-live' }]],
      ]),
    };
  };

  // The three ids the user's live database actually holds this way.
  for (const txId of ['TRN-41fee96e', 'TRN-50be7d51', 'TRN-61654a76']) {
    it(`leaves a correctly-typed live pair (${txId}) completely untouched on a heal`, async () => {
      const { host, store, saved, links, activities } = createFakeHost(liveSharedIdSeed(txId));

      const result = await runSyncCore(host, store, { heal: true });

      // Nothing written at all: no update, no create, no delete, no relink, and
      // no re-link of a pair the rows already report as grouped. Before the fix
      // the savings leg was updated to TRANSFER_IN.
      expect(saved).toEqual([]);
      expect(links).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.imported).toBe(0);
      expect(result.skipped).toBe(2);

      // Each leg keeps its OWN type and its OWN bank description.
      expect(activities.get('wf-sav')).toEqual([{
        id: 'row-out', accountId: 'wf-sav', activityType: 'TRANSFER_OUT',
        date: expect.any(String), amount: 1300,
        comment: `Online Transfer to Spend · ${txId}`, sourceGroupId: 'wf-transfer-live',
      }]);
      expect(activities.get('wf-spend')).toEqual([{
        id: 'row-in', accountId: 'wf-spend', activityType: 'TRANSFER_IN',
        date: expect.any(String), amount: 1300,
        comment: `Online Transfer from Savings · ${txId}`, sourceGroupId: 'wf-transfer-live',
      }]);

      // Both accounts measured as in sync, and neither was alerted about.
      expect(await store.getAccountBalances()).toEqual({
        'sfin-sav': { balance: 610.65, currency: 'USD', date: expect.any(Number), drift: null },
        'sfin-spend': { balance: 3475.23, currency: 'USD', date: expect.any(Number), drift: null },
      });
      expect(result.balanceDriftAlerts).toEqual([]);
    });
  }

  it('imports a shared-id transfer as one correctly-signed leg per account', async () => {
    const outAt = nowSec() - 2 * DAY;
    const inAt = outAt + 3600;
    const TX = 'TRN-50be7d51';
    const { host, store, saved, activities } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '0.00', 'balance-date': nowSec(),
          transactions: [{ id: TX, posted: outAt, amount: '-700.00', description: 'Online Transfer to Citi' }] },
        { id: 'sfin-citi', name: 'Citi Double Cash Card', currency: 'USD', balance: '0.00', 'balance-date': nowSec(),
          transactions: [{ id: TX, posted: inAt, amount: '700.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-spend': 'wf-spend', 'sfin-citi': 'wf-citi' },
      accountTypes: { 'wf-spend': 'CASH', 'wf-citi': 'CREDIT_CARD' },
      valuations: new Map([['wf-spend', 0], ['wf-citi', 0]]),
    });

    await runSyncCore(host, store, {});

    const creates = saved.flatMap((r) => r.creates ?? []);
    // One leg per account, each with its OWN type and its OWN description.
    expect(creates.map((c) => [c.accountId, c.activityType, c.comment])).toEqual([
      ['wf-spend', 'TRANSFER_OUT', `Online Transfer to Citi · ${TX}`],
      ['wf-citi', 'TRANSFER_IN', `PAYMENT THANK YOU · ${TX}`],
    ]);
    // …and no create landed in the wrong account.
    for (const [wfId, rows] of activities) {
      expect(rows.filter((r) => (r.comment ?? '').endsWith(TX)).length,
        `one synced row expected in ${wfId}`).toBe(1);
    }
  });

  it('feeds each account its OWN sign into the starting-balance baseline', async () => {
    // `signedByTxId` was shared across accounts, so the OUT account's baseline was
    // computed from the IN account's +700: a $1,400 error on one transfer.
    const outAt = nowSec() - 2 * DAY;
    const TX = 'TRN-61654a76';
    const { host, store, imported } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '0.00', 'balance-date': nowSec(),
          transactions: [{ id: TX, posted: outAt, amount: '-700.00', description: 'Online Transfer to Citi' }] },
        { id: 'sfin-citi', name: 'Citi', currency: 'USD', balance: '0.00', 'balance-date': nowSec(),
          transactions: [{ id: TX, posted: outAt + 3600, amount: '700.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-spend': 'wf-spend', 'sfin-citi': 'wf-citi' },
      accountTypes: { 'wf-spend': 'CASH', 'wf-citi': 'CREDIT_CARD' },
      valuations: new Map([['wf-spend', 0], ['wf-citi', 0]]),
    });

    await runSyncCore(host, store, {});

    // target − windowDelta − currentValuation, per account:
    //   Spend: 0 − (−700) − 0 = +700 → DEPOSIT
    //   Citi:  0 − (+700) − 0 = −700 → WITHDRAWAL
    const baselines = imported.flat().filter((r) => r.comment.startsWith('Starting balance · '));
    expect(baselines.map((r) => [r.accountId, r.activityType, r.amount])).toEqual([
      ['wf-spend', 'DEPOSIT', 700],
      ['wf-citi', 'WITHDRAWAL', 700],
    ]);
  });

  it('measures drift per account with each leg\'s own sign', async () => {
    // A heal subtracts what it creates from the valuation, using signedByTxId. With
    // the sign shared across accounts the savings account read $2,600 out — enough
    // to trip the drift alert and, with aggressive auto-heal, be written in.
    const outAt = nowSec() - 2 * DAY;
    const TX = 'TRN-41fee96e';
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-sav', name: 'Savings', currency: 'USD', balance: '610.65', 'balance-date': nowSec(),
          transactions: [{ id: TX, posted: outAt, amount: '-1300.00', description: 'Online Transfer to Spend' }] },
        { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '3475.23', 'balance-date': nowSec(),
          transactions: [{ id: TX, posted: outAt + 3600, amount: '1300.00', description: 'Online Transfer from Savings' }] },
      ] },
      mapping: { 'sfin-sav': 'wf-sav', 'sfin-spend': 'wf-spend' },
      accountTypes: { 'wf-sav': 'CASH', 'wf-spend': 'CASH' },
      // Valuations chosen so BOTH accounts are exactly in sync once this run's
      // own creates are accounted for: 610.65 − (V − 1300) = 0 and
      // 3475.23 − (V + 1300) = 0.
      valuations: new Map([['wf-sav', 1910.65], ['wf-spend', 2175.23]]),
    });

    const result = await runSyncCore(host, store, { heal: true });

    expect(await store.getAccountBalances()).toEqual({
      'sfin-sav': { balance: 610.65, currency: 'USD', date: expect.any(Number), drift: null },
      'sfin-spend': { balance: 3475.23, currency: 'USD', date: expect.any(Number), drift: null },
    });
    expect(result.balanceDriftAlerts).toEqual([]);
  });

  it('hands linkPair two DIFFERENT rows, and leaves one row per account', async () => {
    // The failure this pins is the expensive one: `linkRowByTxId` resolved both
    // legs of a shared-id pair to the SAME row, so `linkPair` got [leg, leg] and a
    // delete-and-re-create host removed one row and created TWO in one account —
    // manufacturing the duplicate the prune sweep exists to remove — while the
    // other account's leg was never touched.
    //
    // The fake's own linkPair only stamps a gid, which is why no existing test
    // notices; this one swaps in the real `linkPairByRecreate` over the fake's
    // saveMany, which is what both production hosts do.
    const outAt = nowSec() - 2 * DAY;
    const TX = 'TRN-50be7d51';
    const fake = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '0.00', 'balance-date': nowSec(),
          transactions: [{ id: TX, posted: outAt, amount: '-700.00', description: 'Online Transfer to Citi' }] },
        { id: 'sfin-citi', name: 'Citi', currency: 'USD', balance: '0.00', 'balance-date': nowSec(),
          transactions: [{ id: TX, posted: outAt + 3600, amount: '700.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-spend': 'wf-spend', 'sfin-citi': 'wf-citi' },
      accountTypes: { 'wf-spend': 'CASH', 'wf-citi': 'CREDIT_CARD' },
      valuations: new Map([['wf-spend', 0], ['wf-citi', 0]]),
    });
    const links: Array<[LinkLeg, LinkLeg]> = [];
    const host: SyncHost = {
      ...fake.host,
      async linkPair(legs) {
        links.push(legs);
        return linkPairByRecreate((req) => fake.host.saveMany(req), legs);
      },
    };

    const result = await runSyncCore(host, store2(fake), { heal: true });

    expect(result.errors).toEqual([]);
    expect(links).toHaveLength(1);
    const [a, b] = links[0];
    expect(a.wfId).not.toBe(b.wfId);
    expect(new Set([a.accountId, b.accountId])).toEqual(new Set(['wf-spend', 'wf-citi']));
    expect(new Set([a.activityType, b.activityType]))
      .toEqual(new Set(['TRANSFER_OUT', 'TRANSFER_IN']));
    // Each leg re-created in its OWN account, with its OWN description, exactly once.
    const legRows = [...fake.activities].map(([wfId, rows]) =>
      [wfId, rows.filter((r) => (r.comment ?? '').endsWith(TX))] as const);
    for (const [wfId, rows] of legRows) {
      expect(rows.length, `one leg expected in ${wfId}`).toBe(1);
    }
    expect(legRows.map(([wfId, rows]) => [wfId, rows[0].activityType, rows[0].comment])).toEqual([
      ['wf-spend', 'TRANSFER_OUT', `Online Transfer to Citi · ${TX}`],
      ['wf-citi', 'TRANSFER_IN', `PAYMENT THANK YOU · ${TX}`],
    ]);
    // Both legs really landed in ONE group, which is what makes them an internal
    // transfer rather than two unrelated rows.
    const gids = legRows.map(([, rows]) => rows[0].sourceGroupId);
    expect(gids[0]).toBeTruthy();
    expect(gids[0]).toBe(gids[1]);
  });

  /** The fake's store, unchanged — a named helper only so the host override above
   *  reads as the one thing that differs from a plain `createFakeHost` run. */
  function store2(fake: ReturnType<typeof createFakeHost>) {
    return fake.store;
  }
});
