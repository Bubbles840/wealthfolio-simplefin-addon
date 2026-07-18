export type ActivityType =
  | 'BUY' | 'SELL' | 'SPLIT' | 'DIVIDEND' | 'INTEREST'
  | 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER_IN' | 'TRANSFER_OUT'
  | 'FEE' | 'TAX' | 'CREDIT' | 'ADJUSTMENT' | 'UNKNOWN';

export interface MappingRule {
  pattern: string;
  matchType: 'contains' | 'regex';
  activityType: ActivityType;
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
}

export interface SimplefinAccountSet {
  errors: Array<{ code: string; message: string }>;
  accounts: SimplefinAccount[];
}

export interface AccountMapping {
  [simpleFinAccountId: string]: string; // → Wealthfolio account ID
}
