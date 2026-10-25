import { heldSecuritiesOf, type HeldSecurity } from '../../shared/dividends';
import { fetchAccounts } from './simplefin';
import { linkPairPreferInPlace, unlinkPairPreferInPlace, type InPlaceIo } from '../../shared/link-in-place';
import type { UnlinkLeg, UnlinkResult } from '../../shared/link-pair';
import { hostCan } from './host-can';
import { postedLedgerTotal } from '../../shared/ledger-total';
import type {
  ActivityWrite,
  HostActivity,
  ImportRow,
  LinkLeg,
  LinkResult,
  SaveManyRequest,
  SaveManyResult,
  SyncHost,
  HoldingsSyncOutcome,
} from '../../shared/sync-host';
import type { ActivityType, SimplefinAccountSet } from '../../shared/types';
import type { FeedPrice, HoldingsSnapshot } from '../../shared/holdings';
import { syncHoldingsWithFeedPrices, type PricingApi } from './holdings-prices';
import { confirmLoanBalance, linkedLoansOf, type LinkedLoan, type LoanBalance, type LoanBalanceDecision } from '../../shared/loan-balances';
import type { AddonContext, ActivityCreate, ActivitySearchFilters, ActivityUpdate, Quote } from '@wealthfolio/addon-sdk';

/**
 * Normalize a host date to YYYY-MM-DD.
 *
 * The happy path is exactly `new Date(value).toISOString().slice(0, 10)` — the
 * normalization the reconciliation planner depends on. An unparseable value is
 * passed through verbatim instead of throwing, so callers that only read a row's
 * comment (the starting-balance and balance-adjustment guards) still see
 * malformed rows, while `fetchExistingRows` still fails on them exactly as it
 * did when it called `new Date(a.date).toISOString()` itself.
 */
function toIsoDate(value: unknown): string {
  if (value === null || value === undefined) return '';
  const d = new Date(value as string | number | Date);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

/** Map an ActivityWrite to the SDK's create/update shape, preserving "key
 *  absent" (rather than `undefined`) for every optional field — a transfer leg
 *  must carry NO `symbol` key at all, and import writes carry no metadata or
 *  sourceGroupId. */
function toSdkWrite(w: ActivityWrite): ActivityCreate & { id?: string } {
  return {
    ...(w.id !== undefined ? { id: w.id } : {}),
    accountId: w.accountId,
    activityType: w.activityType as ActivityType,
    activityDate: w.activityDate,
    ...(w.symbol !== undefined ? { symbol: w.symbol } : {}),
    ...(w.amount !== undefined ? { amount: w.amount } : {}),
    ...(w.fee !== undefined ? { fee: w.fee } : {}),
    currency: w.currency,
    comment: w.comment,
    ...(w.metadata !== undefined ? { metadata: w.metadata } : {}),
    ...(w.sourceGroupId !== undefined ? { sourceGroupId: w.sourceGroupId } : {}),
    ...(w.subtype !== undefined ? { subtype: w.subtype } : {}),
    ...(w.needsReview !== undefined ? { needsReview: w.needsReview } : {}),
  } as ActivityCreate & { id?: string };
}

/** Normalize an ActivityDetails row returned by `activities.search`. Shared by
 *  both reads so the recent-first and oldest-first windows can never drift. */
function fromSearchRow(a: any, wfAccountId: string): HostActivity {
  return {
    id: String(a.id ?? ''),
    accountId: String(a.accountId ?? wfAccountId),
    activityType: String(a.activityType ?? ''),
    date: toIsoDate(a.date),
    amount: a.amount ?? null,
    fee: a.fee ?? null,
    comment: a.comment ?? a.notes ?? a.description ?? null,
    assetId: a.assetId ? String(a.assetId) : undefined,
    sourceGroupId: a.sourceGroupId ?? null,
    subtype: a.subtype ?? null,
    // Passed through as-is, and ABSENT (not null) when the response has no
    // such field: an older server that cannot report metadata must read as
    // "unknown", or the sync would re-stamp its rows on every run.
    ...('metadata' in a ? { metadata: a.metadata ?? null } : {}),
  };
}

/** Normalize an Activity echoed back by saveMany. The host names the comment
 *  field `notes` on the echo, which reports the just-persisted
 *  `sourceGroupId`. Also the only channel that confirms a just-written `subtype` actually persisted -
 *  worth copying here too so a caller inspecting a saveMany result sees the
 *  same truth `listActivities` would. */
function fromSdkEcho(a: any): HostActivity {
  return {
    id: String(a?.id ?? ''),
    accountId: String(a?.accountId ?? ''),
    activityType: String(a?.activityType ?? ''),
    date: toIsoDate(a?.date ?? a?.activityDate),
    amount: a?.amount ?? null,
    fee: a?.fee ?? null,
    comment: a?.notes ?? a?.comment ?? null,
    assetId: a?.assetId ? String(a.assetId) : undefined,
    sourceGroupId: a?.sourceGroupId ?? null,
    subtype: a?.subtype ?? null,
  };
}

/** One page of a card's history, and the most pages a total will read (20,000
 *  rows); a card longer than that is "not checked", never a partial sum. */
const CARD_HISTORY_PAGE_SIZE = 500;
const CARD_HISTORY_MAX_PAGES = 40;

/**
 * `SyncHost` backed by the Wealthfolio addon SDK — the in-app half of the shared
 * sync core. The Docker companion implements the same interface over REST.
 */
export class AddonSyncHost implements SyncHost {
  /** `readsSourceGroupId` is false: the search does carry each row's
   *  sourceGroupId (Wealthfolio 3.8+), but the add-on acts only on the links
   *  its own ledger recorded, and uses the group just to keep a leg something
   *  else linked as it is. `cardTransferOut`:
   *  the host is Wealthfolio 3.10+, as the companion published it — the SDK
   *  has no version call. */
  readonly capabilities: { readsSourceGroupId: boolean; cardTransferOut: boolean };

  private log?: (message: string) => void;
  private fullCardHistory: boolean;

  /** `opts.log` is the logger (Task 4); `opts.cardTransferOut` the 3.10 capability;
   *  `opts.fullCardHistory` lets `postedLedgerTotals` page a card's history (manual runs). */
  constructor(private ctx: AddonContext, opts: { cardTransferOut?: boolean; log?: (message: string) => void; fullCardHistory?: boolean } = {}) {
    this.log = opts.log;
    this.fullCardHistory = !!opts.fullCardHistory;
    this.capabilities = { readsSourceGroupId: false, cardTransferOut: !!opts.cardTransferOut };
  }

  async fetchSimplefin(
    accessUrl: string,
    since: Date,
    authKey?: string | null,
  ): Promise<SimplefinAccountSet> {
    return fetchAccounts(accessUrl, since, this.ctx.api.network, authKey ?? undefined);
  }

  async listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string; currency?: string }>> {
    const accounts = await this.ctx.api.accounts.getAll();
    return accounts.map((a) => ({
      id: a.id,
      accountType: String(a.accountType ?? ''),
      name: a.name,
      ...(a.currency ? { currency: String(a.currency) } : {}),
    }));
  }

  async latestValuations(accountIds: string[]): Promise<Map<string, number>> {
    const valuations = await this.ctx.api.portfolio.getLatestValuations(accountIds);
    return new Map(valuations.map((v): [string, number] => [v.accountId, v.totalValue ?? 0]));
  }

  /**
   * A card's posted total from its whole history (1.64, B1). Valuations are
   * cash-only, so without this every card said "not checked" after an in-app
   * Sync. Reads nothing unless this is a manual run (`fullCardHistory`, R7): a
   * scheduled run must stay cheap. A failed read, an in-transit placeholder or
   * a history past the page cap omits the card (= not checked), never guesses.
   */
  async postedLedgerTotals(accounts: ReadonlyArray<{ wfAccountId: string; accountType: string }>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.fullCardHistory) return out;
    for (const { wfAccountId, accountType } of accounts) {
      try {
        const rows: HostActivity[] = [];
        let complete = false;
        for (let page = 0; page < CARD_HISTORY_MAX_PAGES; page++) {
          const res = await this.ctx.api.activities.search(
            page, CARD_HISTORY_PAGE_SIZE, { accountIds: [wfAccountId] }, '', { id: 'date', desc: true },
          );
          const data = res.data ?? [];
          for (const a of data) rows.push(fromSearchRow(a, wfAccountId));
          if (data.length < CARD_HISTORY_PAGE_SIZE) { complete = true; break; }
        }
        if (!complete) continue;
        const total = postedLedgerTotal(rows, accountType);
        if (total !== null) out.set(wfAccountId, total);
      } catch (e) {
        this.log?.(`Card total for ${wfAccountId} not read: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  async listActivities(wfAccountId: string): Promise<HostActivity[]> {
    const res = await this.ctx.api.activities.search(
      0, 500, { accountIds: [wfAccountId] }, '', { id: 'date', desc: true },
    );
    return (res.data ?? []).map((a: any) => fromSearchRow(a, wfAccountId));
  }

  /** Bounded ascending read for the starting-balance marker — the oldest row on
   *  the account, which the 500-row recent-first page above would miss entirely
   *  once the account has more than 500 activities. */
  async listOldestActivities(wfAccountId: string, limit: number): Promise<HostActivity[]> {
    const res = await this.ctx.api.activities.search(
      0, limit, { accountIds: [wfAccountId] }, '', { id: 'date', desc: false },
    );
    return (res.data ?? []).map((a: any) => fromSearchRow(a, wfAccountId));
  }

  async saveMany(req: SaveManyRequest): Promise<SaveManyResult> {
    const res: any = await this.ctx.api.activities.saveMany({
      ...(req.creates !== undefined ? { creates: req.creates.map(toSdkWrite) as ActivityCreate[] } : {}),
      ...(req.updates !== undefined ? { updates: req.updates.map(toSdkWrite) as ActivityUpdate[] } : {}),
      ...(req.deleteIds !== undefined ? { deleteIds: req.deleteIds } : {}),
    });
    return {
      created: (res?.created ?? []).map(fromSdkEcho),
      updated: (res?.updated ?? []).map(fromSdkEcho),
      errors: (res?.errors ?? []).map((e: any) => ({
        action: String(e?.action ?? ''),
        message: String(e?.message ?? ''),
      })),
    };
  }

  async importActivities(rows: ImportRow[]): Promise<void> {
    // `sourceSystem` rides on ImportRow itself, so the payload carries it
    // without this adapter (or the companion's) having to remember to stamp it.
    await this.ctx.api.activities.import(rows as any);
  }

  /**
   * Writes one account's positions for a date. The companion has no counterpart
   * — the self-hosted REST server exposes no snapshot write route — so this
   * capability exists on the addon half alone (see `SyncHost.syncHoldings`).
   *
   * `checkImport` does double duty: it validates the batch before anything is
   * written, and its `existingDates` is the idempotency signal, which is better
   * than anything this side could persist because it describes what the host
   * actually holds. Dates are normalised on both sides before comparing — the
   * host types them as plain strings without pinning a format, and it returns
   * full ISO instants elsewhere, so a raw equality check would silently never
   * match and re-import the same snapshot on every sync.
   */
  async syncHoldings(
    wfAccountId: string,
    snapshot: HoldingsSnapshot,
    prices: FeedPrice[] = [],
    scope?: { tag: string },
  ): Promise<HoldingsSyncOutcome> {
    // The snapshot write and the feed's prices are one decision (which
    // holdings get a per-account asset), so they live together in
    // holdings-prices.ts; this adapter only supplies the SDK calls.
    const snapshots = this.ctx.api.snapshots as any;
    return syncHoldingsWithFeedPrices(
      {
        checkImport: (id, s) => snapshots.checkImport(id, s),
        importSnapshots: (id, s) => snapshots.importSnapshots(id, s),
      },
      this.pricingApi(),
      wfAccountId,
      snapshot,
      prices,
      scope?.tag,
      this.log,
    );
  }

  /** The asset and quote calls holdings-prices.ts needs, each made as a method
   *  on `ctx.api` (the sandbox's Proxy treats a detached function as one more path). */
  private pricingApi(): PricingApi {
    const api = this.ctx.api as any;
    return {
      getHoldings: (wfAccountId) => api.portfolio.getHoldings(wfAccountId),
      getProfile: (assetId) => api.assets.getProfile(assetId),
      updateQuoteMode: (assetId, mode) => api.assets.updateQuoteMode(assetId, mode),
      getHistory: (assetId) => api.quotes.getHistory(assetId),
      updateQuote: (assetId, quote) => api.quotes.update(assetId, quote),
    };
  }

  /**
   * Wealthfolio's own link or unlink through the SDK, and the exact-id read
   * right before it — or null on a host that does not offer the call (3.8:
   * `hostCan`), where the pair is re-created as it always was. Each call is
   * made as a method on `ctx.api` (the sandbox's Proxy treats `.call` as one
   * more path).
   */
  private async inPlace(method: 'activities.linkTransfer' | 'activities.unlinkTransfer'): Promise<InPlaceIo | null> {
    if (!(await hostCan(this.ctx, method))) return null;
    return {
      read: async (ids) => {
        // `activityIds` reaches Wealthfolio 3.8's exact-id filter; the SDK's filter type does not list it.
        const res = await this.ctx.api.activities.search(0, 2, { activityIds: ids } as ActivitySearchFilters, '');
        return (res.data ?? []) as unknown[];
      },
      link: async (a, b) => (await this.ctx.api.activities.linkTransfer(a, b)) as unknown[],
      unlink: async (a, b) => (await this.ctx.api.activities.unlinkTransfer(a, b)) as unknown[],
      ...(this.log ? { log: this.log } : {}),
    };
  }

  async linkPair(legs: [LinkLeg, LinkLeg]): Promise<LinkResult> {
    return linkPairPreferInPlace(await this.inPlace('activities.linkTransfer'), (req) => this.saveMany(req), legs);
  }

  async unlinkPair(legs: [UnlinkLeg, UnlinkLeg]): Promise<UnlinkResult> {
    return unlinkPairPreferInPlace(await this.inPlace('activities.unlinkTransfer'), (req) => this.saveMany(req), legs);
  }

  /** The account's held securities, for a dividend that names one. */
  async listHeldSecurities(wfAccountId: string): Promise<HeldSecurity[]> {
    return heldSecuritiesOf(await this.ctx.api.portfolio.getHoldings(wfAccountId));
  }

  /** Each call made as a method on `ctx.api`, as `inPlace` explains. */
  async listLoans(): Promise<LinkedLoan[]> {
    return linkedLoansOf(await this.ctx.api.alternativeAssets.getAll());
  }

  async confirmLoanBalance(loan: LinkedLoan, entry: LoanBalance): Promise<LoanBalanceDecision> {
    return confirmLoanBalance({
      history: async (id) => ((await this.ctx.api.quotes.getHistory(id)) ?? []).map((q) => ({
        date: String(q.timestamp).slice(0, 10), close: q.close, dataSource: q.dataSource, notes: q.notes ?? null,
      })),
      write: (id, quote) => this.ctx.api.quotes.update(id, quote as unknown as Quote),
    }, loan, entry);
  }
}
