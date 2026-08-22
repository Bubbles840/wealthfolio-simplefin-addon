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
}

export interface SimplefinAccountSet {
  // SimpleFin returns errors as an array of human-readable strings.
  errors: string[];
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
