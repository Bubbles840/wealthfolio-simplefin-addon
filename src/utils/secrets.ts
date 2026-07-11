import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { AccountMapping, MappingRule } from '../../shared/types';

const KEYS = {
  accessUrl: 'simplefin_access_url',
  authB64: 'simplefin_auth_b64',
  accountMapping: 'account_mapping',
  accountNames: 'account_names',
  // No longer written (starting balances are companion-only now); kept in
  // KEYS so clearAll() still wipes the orphaned secret from older installs.
  balanceInitialized: 'balance_initialized',
  mappingRules: 'mapping_rules',
  syncScheduleHours: 'sync_schedule_hours',
  lastSyncAt: 'last_sync_at',
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

  async getLastSyncAt(): Promise<Date | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.lastSyncAt);
    return raw ? new Date(raw) : null;
  }
  async setLastSyncAt(date: Date): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.lastSyncAt, date.toISOString());
  }

  async clearAll(): Promise<void> {
    await Promise.all(Object.values(KEYS).map((k) => this.ctx.api.secrets.delete(k)));
  }
}
