export type ActivityType =
  | 'BUY' | 'SELL' | 'SPLIT' | 'DIVIDEND' | 'INTEREST'
  | 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER_IN' | 'TRANSFER_OUT'
  | 'FEE' | 'TAX' | 'CREDIT' | 'ADJUSTMENT' | 'UNKNOWN';

export interface MappingRule {
  pattern: string;
  matchType: 'contains' | 'regex';
  activityType: ActivityType;
  /** Optional Wealthfolio activity subtype applied when this rule matches.
   *  Only meaningful for CREDIT (see docs/upstream-spending-buckets.md): a
   *  DEPOSIT is income regardless of subtype. */
  subtype?: string;
}

export interface SimplefinOrg {
  domain: string;
  sfin_url: string;
}

export interface SimplefinTransaction {
  id: string;
  posted: number;        // Unix timestamp (0 for some pending rows)
  amount: string;        // Numeric string e.g. "-12.50"
  description: string;
  pending?: boolean;
  transacted_at?: number; // Unix timestamp; used to date pending rows lacking `posted`
}

/**
 * One position inside an investment account, straight from SimpleFin. Every
 * field is optional in the protocol and every numeric one arrives as a STRING:
 * share counts run to eight decimals for crypto, and routing them through a JS
 * number loses the tail.
 */
export interface SimplefinHolding {
  symbol?: string;
  /** Share count. `null` is a real answer from the Bridge, not just absence. */
  shares?: string | null;
  currency?: string | null;
  cost_basis?: string | null;
  /** Per-share cost. Becomes a position's `avgCost` when present. */
  purchase_price?: string | null;
  market_value?: string | null;
  description?: string | null;
}

export interface SimplefinAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;       // Numeric string
  'balance-date': number; // Unix timestamp
  transactions?: SimplefinTransaction[];
  /**
   * The institution the account belongs to. The SimpleFin protocol always
   * sends it, but every field inside is optional — an org may carry only a
   * `domain` or `url` and no `name` — so read it defensively.
   *
   * Optional here because nothing in this codebase depended on it until
   * unmapped-account reporting, and every stored fixture and test double
   * predates it.
   */
  org?: {
    name?: string;
    domain?: string;
    url?: string;
    'sfin-url'?: string;
  };
  /**
   * Positions, for an investment account. Absent on every bank and card
   * account, and absent from every fixture written before v1.50 — which is why
   * it is optional rather than an empty array by contract.
   */
  holdings?: SimplefinHolding[];
}

/**
 * One entry of the Bridge's structured `errlist`, which names the failing
 * connection where the older string `errors` array only described it.
 *
 * `key` is the dedupe handle: a broken institution reports once per affected
 * account, so one dead connection arrives as several identical failures.
 */
export interface SimplefinBridgeError {
  code: string;
  msg: string;
  connId: string | null;
  accountId: string | null;
  key: string;
}

export interface SimplefinAccountSet {
  /** Human-readable, one per DISTINCT failure, with the failing account named
   *  where the payload allowed it to be resolved. Built from `errorList` — see
   *  `normalizeAccountSet` — and deliberately still `string[]`, because every
   *  consumer of this field predates the structured form. */
  errors: string[];
  /** The same failures with their structure intact, for anything that needs to
   *  act per connection rather than print a line. Optional so the many test
   *  fixtures and stored payloads that predate it stay valid. */
  errorList?: SimplefinBridgeError[];
  accounts: SimplefinAccount[];
}

export interface AccountMapping {
  [simpleFinAccountId: string]: string; // → Wealthfolio account ID
}

/**
 * A SimpleFin account the feed returned that no mapping points at — so nothing
 * from it is imported.
 *
 * Lives here rather than inline in `SyncResult` because the SyncStore
 * persists it too, and `shared/sync-host.ts` importing `shared/sync-core.ts`
 * (which imports it back) would be a cycle.
 */
export interface UnmappedAccount {
  /** SimpleFin account id — the key a mapping entry would be written under. */
  sfinAccountId: string;
  /** SimpleFin's name for it, e.g. "Robinhood Gold Card". */
  accountName: string;
  /** The institution name, when SimpleFin supplies one: two accounts can share
   *  a name across banks, and this is what tells them apart. */
  orgName?: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
  notifyOnImport?: boolean;
  dailyReportEnabled?: boolean;
  weeklyReportEnabled?: boolean;
  /** Monthly wrap-up, sent on the 1st about the month that just ended. Like its
   *  two siblings, only an explicit `false` suppresses it — a config written
   *  before this report existed opts in. */
  monthlyReportEnabled?: boolean;
  /** Category names to include in the daily digest. 'all' (default) means
   *  every category the companion has published via
   *  `available_report_categories`. */
  dailyReportCategories?: string[] | 'all';
  /** Same as dailyReportCategories, for the weekly total-remaining summary. */
  weeklyReportCategories?: string[] | 'all';
  /** How many of the week's biggest individual spends the weekly report lists
   *  beneath its headline. Absent means the default of 5; `0` or negative turns
   *  the section off (and skips the query) without affecting the headline.
   *
   *  The Sync page writes this whenever Telegram settings are saved, so only a
   *  BLANK field means the default — a typed `0` is stored as `0`. */
  weeklyTopSpendCount?: number;
  /** Same as dailyReportCategories, for the monthly wrap-up. */
  monthlyReportCategories?: string[] | 'all';
  /** Dollar amount a single newly-imported SPENDING transaction has to exceed
   *  before it is announced. Absent (the default), `0`, or negative means off —
   *  a user who has never opened the setting gets no such alerts. */
  largeTransactionThreshold?: number;
  /** Dollar drift (bank balance vs Wealthfolio valuation) an account has to
   *  exceed before it is announced. Absent means the $100 default; an explicit
   *  `0` or negative means off.
   *
   *  Deliberately NOT `DRIFT_THRESHOLD_DOLLARS`, which is $1 and decides whether
   *  the Sync page DISPLAYS drift at all — alerting on that would ping on every
   *  rounding wobble. */
  driftAlertThreshold?: number;
}
