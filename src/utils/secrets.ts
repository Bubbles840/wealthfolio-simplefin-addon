import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { AccountMapping, MappingRule } from '../../shared/types';

/** Per-account balance snapshot captured on each sync, for the Sync page. */
export interface AccountBalanceInfo {
  /** SimpleFin's reported balance, or null when SimpleFin didn't provide a
   *  numeric balance for the account (shown as "—" rather than a false $0.00). */
  balance: number | null;
  currency: string;
  /** SimpleFin balance-date (Unix seconds). */
  date: number;
  /** SimpleFin balance − Wealthfolio balance, set only when it was safely
   *  measurable (no imports that run) and exceeds the drift threshold; null
   *  means "in sync" (or not measurable this run). */
  drift: number | null;
}

const KEYS = {
  accessUrl: 'simplefin_access_url',
  authB64: 'simplefin_auth_b64',
  accountMapping: 'account_mapping',
  accountNames: 'account_names',
  balanceInitialized: 'balance_initialized',
  mappingRules: 'mapping_rules',
  syncScheduleHours: 'sync_schedule_hours',
  lastSyncAt: 'last_sync_at',
  linkedGroups: 'linked_groups',
  accountBalances: 'account_balances',
  autoHeal: 'auto_heal',
} as const;

export class SecretsStore {
  constructor(private ctx: AddonContext) {}

  async getAccessUrl(): Promise<string | null> {
    return this.ctx.api.secrets.get(KEYS.accessUrl);
  }
  async setAccessUrl(url: string): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.accessUrl, url);
  }

  // The Wealthfolio SDK only supports Bearer auth for brokered requests.
  // We store the pre-computed base64(user:pass) so the backend injects
  // "Authorization: Bearer <base64>" which SimpleFin may accept.
  async getAuthB64Key(): Promise<string> {
    return KEYS.authB64;
  }
  async setAuthB64(credentialsB64: string): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.authB64, credentialsB64);
  }

  async getAccountMapping(): Promise<AccountMapping | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.accountMapping);
    return raw ? (JSON.parse(raw) as AccountMapping) : null;
  }
  async setAccountMapping(mapping: AccountMapping): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.accountMapping, JSON.stringify(mapping));
  }

  /** Display names of SimpleFin accounts, keyed by SimpleFin account ID.
   *  Captured at setup so the sync page can show names instead of raw IDs. */
  async getAccountNames(): Promise<Record<string, string>> {
    const raw = await this.ctx.api.secrets.get(KEYS.accountNames);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }
  async setAccountNames(names: Record<string, string>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.accountNames, JSON.stringify(names));
  }

  /** SimpleFin account IDs that already received a starting-balance entry. */
  async getBalanceInitialized(): Promise<string[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.balanceInitialized);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }
  async addBalanceInitialized(sfinAccountId: string): Promise<void> {
    const current = await this.getBalanceInitialized();
    if (!current.includes(sfinAccountId)) {
      await this.ctx.api.secrets.set(
        KEYS.balanceInitialized,
        JSON.stringify([...current, sfinAccountId]),
      );
    }
  }

  async getMappingRules(): Promise<MappingRule[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.mappingRules);
    return raw ? (JSON.parse(raw) as MappingRule[]) : [];
  }
  async setMappingRules(rules: MappingRule[]): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.mappingRules, JSON.stringify(rules));
  }

  async getSyncScheduleHours(): Promise<number | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.syncScheduleHours);
    return raw ? Number(raw) : null;
  }
  async setSyncScheduleHours(hours: number): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.syncScheduleHours, String(hours));
  }

  /** When on, every sync runs in heal mode (wide 90-day re-scan to recover
   *  missing transactions + accurate drift). The residual plug stays manual. */
  async getAutoHeal(): Promise<boolean> {
    return (await this.ctx.api.secrets.get(KEYS.autoHeal)) === 'true';
  }
  async setAutoHeal(on: boolean): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.autoHeal, on ? 'true' : 'false');
  }

  async getLastSyncAt(): Promise<Date | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.lastSyncAt);
    return raw ? new Date(raw) : null;
  }
  async setLastSyncAt(date: Date): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.lastSyncAt, date.toISOString());
  }

  /** Ledger of SimpleFin tx id → shared sourceGroupId for linked transfer
   *  pairs. `ActivityDetails` doesn't expose sourceGroupId, so we track which
   *  pairs we've already linked here to keep re-linking idempotent (no churn). */
  async getLinkedGroups(): Promise<Record<string, string>> {
    const raw = await this.ctx.api.secrets.get(KEYS.linkedGroups);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }
  async setLinkedGroups(map: Record<string, string>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.linkedGroups, JSON.stringify(map));
  }

  /** Latest per-account SimpleFin balance + drift, keyed by SimpleFin account
   *  ID. Captured each sync so the Sync page can show balances instantly. */
  async getAccountBalances(): Promise<Record<string, AccountBalanceInfo>> {
    const raw = await this.ctx.api.secrets.get(KEYS.accountBalances);
    return raw ? (JSON.parse(raw) as Record<string, AccountBalanceInfo>) : {};
  }
  async setAccountBalances(map: Record<string, AccountBalanceInfo>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.accountBalances, JSON.stringify(map));
  }

  async clearAll(): Promise<void> {
    await Promise.all(Object.values(KEYS).map((k) => this.ctx.api.secrets.delete(k)));
  }
}
