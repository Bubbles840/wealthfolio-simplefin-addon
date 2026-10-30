import { randomUUID } from 'node:crypto';
import { isUuid, PROFILE_ID_FORMAT } from './profile-id.js';
import type { BudgetTarget } from '../../shared/budget-suggest.js';
import type { CategoryRuleLike } from '../../shared/tx-story.js';

/** A categorization rule as `GET /spending/rules` lists it (upstream
 *  `CategorizationRule`, camelCase): what Undo needs and what rule inference
 *  (shared/tx-story.ts) reads. Optional fields are absent when the server did
 *  not send them. */
export interface WealthfolioRule extends CategoryRuleLike {
  name: string;
}

export interface ActivitySearchItem {
  id: string;
  accountId: string;
  activityType: string;
  /** ISO date or datetime string */
  date: string;
  amount?: string | number | null;
  sourceGroupId?: string | null;
  comment?: string | null;
  subtype?: string | null;
  /** Upstream `ActivityDetails.accountName`. */
  accountName?: string | null;
  /** Upstream `ActivityDetails.currency`. */
  currency?: string | null;
}

/**
 * The budget targets in a `BudgetSnapshot` (upstream crates/spending
 * budget/model.rs, camelCase; the same on 3.8, 3.9 and 3.10): `state.targets`,
 * each `{ id, periodKey, targetType, taxonomyId, categoryId, groupId, amount }`
 * with `amount` a decimal STRING — read here as cents. A target missing an id,
 * period or type is skipped; one whose AMOUNT does not parse is KEPT with
 * `amountCents: NaN`, because overwrite safety (`hasBudget`) must never depend
 * on reading the amount — Wealthfolio's POST is an upsert, and a target we
 * cannot price is still a budget. `enabled` is false when the snapshot has no
 * budget groups: Wealthfolio answers an EMPTY snapshot while its Spending
 * tracker is off (`BudgetService::get`), and otherwise always has its system
 * groups — so an empty list there is not "no budgets". A reply that is not a
 * snapshot throws.
 */
export function parseBudgetSnapshot(body: unknown): { enabled: boolean; targets: BudgetTarget[] } {
  const state = (body && typeof body === 'object' && !Array.isArray(body) ? (body as { state?: unknown }).state : null) as
    { groups?: unknown; targets?: unknown } | null | undefined;
  if (!state || typeof state !== 'object' || !Array.isArray(state.targets)) {
    throw new Error("Wealthfolio's budget reply carried no budget targets");
  }
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const targets: BudgetTarget[] = [];
  for (const raw of state.targets as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const amount = typeof t.amount === 'number' ? t.amount : typeof t.amount === 'string' && t.amount.trim() !== '' ? Number(t.amount) : NaN;
    const id = text(t.id);
    const periodKey = text(t.periodKey);
    const targetType = text(t.targetType);
    if (!id || !periodKey || !targetType) continue;
    targets.push({
      id, periodKey, targetType, taxonomyId: text(t.taxonomyId), categoryId: text(t.categoryId),
      amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : NaN,
    });
  }
  return { enabled: Array.isArray(state.groups) && state.groups.length > 0, targets };
}

/** Wealthfolio 3.10's profile scope header (crates/core/src/profiles). */
export const PROFILE_SCOPE_HEADER = 'x-wf-profile-scope';


/** `WEALTHFOLIO_PROFILE_ID` and what the companion does around opening it (#50). */
export interface ProfileOptions {
  /** The profile's ID, a UUID in any case. */
  id: string;
  /** Runs each time the profile is opened, with its accounts, before any other
   *  request uses the session. Throwing refuses the profile. */
  verify?: (accounts: Array<{ id: string }>) => void | Promise<void>;
  /** Where the profile list goes when the ID is unknown: the log, never the error. */
  log?: (line: string) => void;
}

/**
 * Open profile sessions, shared by every client in the process. Wealthfolio
 * keeps ONE grant per signed-in owner and every unlock replaces it, so two
 * clients on one credential (an API key: the sync and the long-lived Telegram
 * client) must share a session rather than cancel each other's. Keyed by
 * profile and credential; a password login is a new owner, so a new key.
 */
const profileSessions = new Map<string, string>();
const profileOpenings = new Map<string, Promise<string>>();
/** Old logins' sessions are dropped; a client whose entry goes simply reopens. */
const MAX_PROFILE_SESSIONS = 16;
/** Wealthfolio's owner when its auth is off: without a steady cookie every
 *  request would be a new owner, and no session could ever be used. */
const BROWSER_ID = randomUUID();

/** Test-only: forget every shared profile session. */
export function resetProfileSessionsForTest(): void {
  profileSessions.clear();
  profileOpenings.clear();
}

const NO_PROFILE_API =
  'WEALTHFOLIO_PROFILE_ID is set, but this Wealthfolio has no profiles to pick from (profiles arrived in Wealthfolio 3.10). Remove WEALTHFOLIO_PROFILE_ID, or upgrade Wealthfolio.';

export class WealthfolioClient {
  private token: string | null = null;
  private profile: (ProfileOptions & { id: string }) | null;

  constructor(private baseUrl: string, profile?: ProfileOptions) {
    if (profile && !isUuid(profile.id)) throw new Error(PROFILE_ID_FORMAT);
    // Wealthfolio names a profile's folder and compares IDs in lower case.
    this.profile = profile ? { ...profile, id: profile.id.toLowerCase() } : null;
  }

  /**
   * Every request but the login goes through here. Without a profile it is
   * plain `fetch`, unchanged. With one, the request carries the profile's
   * session, opened (and checked) first if need be; a 423 means the session is
   * gone, because Wealthfolio restarted or another client on this credential
   * reopened it, so the request is retried once on the current session.
   */
  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    if (!this.profile) return fetch(url, init);
    const scope = await this.profileScope();
    const res = await fetch(url, this.scoped(init, scope));
    if (res.status !== 423) return res;
    return fetch(url, this.scoped(init, await this.profileScope(scope)));
  }

  private scoped(init: RequestInit, scope: string): RequestInit {
    return {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), [PROFILE_SCOPE_HEADER]: scope, Cookie: `wf_browser=${BROWSER_ID}` },
    };
  }

  private profileKey(): string {
    return `${this.profile!.id}\u0000${this.token ?? ''}`;
  }

  /** The current session, opening one when there is none or it is `stale`.
   *  Concurrent callers share one opening. */
  private async profileScope(stale?: string): Promise<string> {
    const key = this.profileKey();
    const current = profileSessions.get(key);
    if (current && current !== stale) return current;
    let opening = profileOpenings.get(key);
    if (!opening) {
      opening = this.openProfile()
        .then((scope) => {
          profileSessions.delete(key);
          profileSessions.set(key, scope);
          while (profileSessions.size > MAX_PROFILE_SESSIONS) profileSessions.delete(profileSessions.keys().next().value!);
          return scope;
        })
        .finally(() => profileOpenings.delete(key));
      profileOpenings.set(key, opening);
    }
    return opening;
  }

  /**
   * Opens the profile for this credential: find it (unknown, locked, or a
   * Wealthfolio without profiles is refused), unlock it, then check it with
   * its accounts before the session is handed to anything else.
   */
  private async openProfile(): Promise<string> {
    const { id, verify, log } = this.profile!;
    const state = await this.profileCommand('get_profile_state', {});
    const profiles = (state as { profiles?: unknown } | null)?.profiles;
    if (!Array.isArray(profiles)) throw new Error(NO_PROFILE_API);
    const listed = profiles.filter((p): p is { id: string; name?: unknown; lockEnabled?: unknown } =>
      !!p && typeof (p as { id?: unknown }).id === 'string');
    const match = listed.find((p) => p.id.toLowerCase() === id);
    if (!match) {
      const clean = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 80);
      log?.(`Wealthfolio's profiles: ${listed.map((p) => `${clean(p.name)} (${clean(p.id)})`).join(', ') || 'none'}.`);
      throw new Error(`Wealthfolio has no profile with ID ${id} (WEALTHFOLIO_PROFILE_ID). The companion log lists its profiles.`);
    }
    if (match.lockEnabled === true) {
      throw new Error(`Profile ${id} has a lock. The companion can only sync a profile without one: remove its lock in Wealthfolio, or pick another profile.`);
    }
    const session = await this.profileCommand('unlock_profile', { profileId: id });
    const scope = (session as { scopeId?: unknown } | null)?.scopeId;
    if (typeof scope !== 'string' || !isUuid(scope)) {
      throw new Error(`Wealthfolio opened profile ${id} but sent back no usable session.`);
    }
    const res = await fetch(`${this.baseUrl}/api/v1/accounts`, this.scoped({ headers: this.authHeaders() }, scope));
    if (!res.ok) throw await this.httpError('Profile check (getAccounts)', res);
    const accounts: unknown = await res.json();
    if (!Array.isArray(accounts)) throw new Error(`Profile check: Wealthfolio's account list for profile ${id} was not a list.`);
    await verify?.(accounts as Array<{ id: string }>);
    return scope;
  }

  /** `POST /api/v1/profiles/<command>`. A server without that route (before
   *  3.10), or one that answers with something other than JSON, has no profiles. */
  private async profileCommand(command: 'get_profile_state' | 'unlock_profile', body: Record<string, string>): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/v1/profiles/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders(), Cookie: `wf_browser=${BROWSER_ID}` },
      body: JSON.stringify(body),
    });
    if (res.status === 404 || res.status === 405) throw new Error(NO_PROFILE_API);
    if (!res.ok) throw await this.httpError(`Wealthfolio ${command}`, res);
    try {
      return await res.json();
    } catch {
      throw new Error(NO_PROFILE_API);
    }
  }

  /**
   * Wealthfolio's server uses password-only auth: POST /api/v1/auth/login
   * with { password } returns the session JWT in a Set-Cookie header
   * (wf_session=<jwt>), not in the response body. The same JWT is accepted
   * as an Authorization: Bearer header on subsequent requests.
   */
  async login(password: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) throw await this.httpError('Wealthfolio login', res);

    const setCookies: string[] =
      typeof (res.headers as any).getSetCookie === 'function'
        ? (res.headers as any).getSetCookie()
        : [res.headers.get('set-cookie') ?? ''];
    for (const cookie of setCookies) {
      const match = /(?:^|;\s*)wf_session=([^;]+)/.exec(cookie);
      if (match && match[1]) {
        this.token = match[1];
        return;
      }
    }
    throw new Error('Wealthfolio login succeeded but no wf_session cookie was returned');
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) return {};
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * Builds an error that carries the server's explanation, not just the
   * status code. Only ever reads the *response* body (never a request
   * body, so a secret being written can't be echoed back into a log) and
   * bounds it so a large HTML error page can't flood the logs.
   */
  private async httpError(action: string, res: Response): Promise<Error> {
    // Wealthfolio 3.10 answers 423 PROFILE_LOCKED to a request with no profile
    // scope when the instance has several profiles or a locked one.
    if (res.status === 423 && !this.profile) {
      return new Error(
        'Wealthfolio refused the request: a profile is locked or there is more than one profile (HTTP 423 PROFILE_LOCKED). Set WEALTHFOLIO_PROFILE_ID to the profile to sync; it must have no lock.',
      );
    }
    const MAX_BODY_CHARS = 300;
    let body = '';
    try {
      body = (await res.text()).trim();
    } catch {
      // response body not readable (e.g. already consumed) - fall back to status only
    }
    if (body.length > MAX_BODY_CHARS) {
      body = `${body.slice(0, MAX_BODY_CHARS)}…`;
    }
    const detail = body ? ` - ${body}` : '';
    if (res.status === 423 && this.profile) {
      // Still a temporary failure to `isRowRefusal`, which reads only 400/422.
      return new Error(`${action} failed: Wealthfolio refused profile ${this.profile.id} (HTTP 423)${detail}`);
    }
    return new Error(`${action} failed: ${res.status}${detail}`);
  }

  async checkImport(accountId: string, activities: unknown[]): Promise<unknown[]> {
    const res = await this.send(`${this.baseUrl}/api/v1/activities/import/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ accountId, activities }),
    });
    if (!res.ok) throw await this.httpError('checkImport', res);
    return res.json() as Promise<unknown[]>;
  }

  /** Every account. `name` and `isActive` (false = hidden) feed the cash
   *  forecast (project 5); every field is optional because the server's DTO
   *  is not ours to pin. */
  async getAccounts(): Promise<Array<{ id: string; name?: string; accountType?: string; isArchived?: boolean; isActive?: boolean }>> {
    const res = await this.send(`${this.baseUrl}/api/v1/accounts`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('getAccounts', res);
    return res.json() as Promise<Array<{ id: string; name?: string; accountType?: string; isArchived?: boolean; isActive?: boolean }>>;
  }

  /**
   * Latest per-account valuations. The accounts endpoint has no balance
   * field — totalValue here is the real current account balance.
   */
  async getLatestValuations(): Promise<Array<{ accountId: string; totalValue: string | number }>> {
    const res = await this.send(`${this.baseUrl}/api/v1/valuations/latest`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('getLatestValuations', res);
    return res.json() as Promise<Array<{ accountId: string; totalValue: string | number }>>;
  }

  /**
   * What Wealthfolio's Spending page counts as spent between two instants
   * (`POST /spending/insight`, upstream `SpendingInsightRequest` →
   * `SpendingInsight.headline.spent`, Wealthfolio 3.8), in the base currency.
   * The page sends its "This month" as the calendar month in its timezone,
   * RFC 3339, both ends inclusive.
   */
  async getSpendingInsightSpent(startDate: string, endDate: string): Promise<number> {
    const res = await this.send(`${this.baseUrl}/api/v1/spending/insight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ startDate, endDate }),
    });
    if (!res.ok) throw await this.httpError('getSpendingInsight', res);
    const body = (await res.json()) as { headline?: { spent?: unknown } } | null;
    const spent = body?.headline?.spent;
    if (typeof spent !== 'number' || !Number.isFinite(spent)) throw new Error('getSpendingInsight: the reply carried no headline.spent');
    return spent;
  }

  /**
   * Every budget target (`GET /spending/budget?periodKey=default`, upstream
   * `get_budget`; `state.targets` lists every period's targets, and the
   * `'default'` view skips the month's actuals). See `parseBudgetSnapshot`.
   */
  async getBudgetTargets(): Promise<{ enabled: boolean; targets: BudgetTarget[] }> {
    const res = await this.send(`${this.baseUrl}/api/v1/spending/budget?periodKey=default`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.httpError('getBudgetTargets', res);
    return parseBudgetSnapshot(await res.json());
  }

  /**
   * Sets a category's default monthly budget (`POST /spending/budget/targets`,
   * upstream `NewBudgetTarget`: `periodKey: 'default'`, `targetType:
   * 'category'`, the spending taxonomy, the category, and `amount` as a
   * decimal string — `validate_budget_target` requires taxonomyId and
   * categoryId and no groupId). Upstream this is an UPSERT on (period,
   * taxonomy, category): an existing target is overwritten, so callers
   * re-read first. Resolves the stored target, read back from the snapshot
   * the reply carries — or null when the POST succeeded but the reply names
   * no such target (or is not a snapshot): the budget IS written, so this
   * never throws after a 2xx, and the caller must record it without an id.
   */
  async setDefaultBudgetTarget(categoryId: string, amountCents: number): Promise<BudgetTarget | null> {
    const res = await this.send(`${this.baseUrl}/api/v1/spending/budget/targets?periodKey=default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        periodKey: 'default',
        targetType: 'category',
        taxonomyId: 'spending_categories',
        categoryId,
        amount: (amountCents / 100).toFixed(2),
      }),
    });
    if (!res.ok) throw await this.httpError('setBudgetTarget', res);
    try {
      return parseBudgetSnapshot(await res.json()).targets.find((t) => t.periodKey === 'default'
        && t.targetType === 'category' && t.taxonomyId === 'spending_categories' && t.categoryId === categoryId) ?? null;
    } catch {
      return null;
    }
  }

  /** Deletes a budget target (`DELETE /spending/budget/targets/{id}`). Upstream
   *  deleting one that is already gone succeeds; Undo re-reads first anyway. */
  async deleteBudgetTarget(id: string): Promise<void> {
    const res = await this.send(`${this.baseUrl}/api/v1/spending/budget/targets/${encodeURIComponent(id)}?periodKey=default`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('deleteBudgetTarget', res);
  }

  /** Links two activities as one internal transfer, in place (`POST
   *  /activities/link`, Wealthfolio 3.8+): one transaction that refuses with
   *  nothing written. Resolves to the two rows it wrote, transfer-in first. */
  async linkTransferActivities(activityAId: string, activityBId: string): Promise<unknown[]> {
    const res = await this.send(`${this.baseUrl}/api/v1/activities/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ activityAId, activityBId }),
    });
    if (!res.ok) throw await this.httpError('linkTransferActivities', res);
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows : [];
  }

  /** An account's holdings (`GET /holdings?accountId=`). */
  async getHoldings(accountId: string): Promise<unknown[]> {
    const res = await this.send(`${this.baseUrl}/api/v1/holdings?accountId=${encodeURIComponent(accountId)}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('getHoldings', res);
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows : [];
  }

  /** An account's holdings snapshots dated `from`..`to` (`GET /snapshots`). */
  async getSnapshots(accountId: string, from: string, to: string): Promise<unknown[]> {
    const q = new URLSearchParams({ accountId, dateFrom: from, dateTo: to });
    const res = await this.send(`${this.baseUrl}/api/v1/snapshots?${q}`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.httpError('getSnapshots', res);
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows : [];
  }

  /** The holdings in an account's snapshot of `date` (`GET /snapshots/holdings`). */
  async getSnapshotHoldings(accountId: string, date: string): Promise<unknown[]> {
    const q = new URLSearchParams({ accountId, date });
    const res = await this.send(`${this.baseUrl}/api/v1/snapshots/holdings?${q}`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.httpError('getSnapshotHoldings', res);
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows : [];
  }

  /** Property, vehicles, loans and the rest (`GET /alternative-holdings`). */
  async getAlternativeHoldings(): Promise<unknown[]> {
    const res = await this.send(`${this.baseUrl}/api/v1/alternative-holdings`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('getAlternativeHoldings', res);
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows : [];
  }

  /** An asset's quotes (`GET /market-data/quotes/history`). A liability's are its
   *  recorded balances. */
  async getQuoteHistory(assetId: string): Promise<Array<{ timestamp: string; close: string | number; dataSource: string; notes?: string | null }>> {
    const res = await this.send(`${this.baseUrl}/api/v1/market-data/quotes/history?symbol=${encodeURIComponent(assetId)}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('getQuoteHistory', res);
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows : [];
  }

  /** Saves one quote (`PUT /market-data/quotes/{assetId}`), the route the app's
   *  own manual quote edit uses. A MANUAL one replaces that day's MANUAL quote. */
  async updateQuote(assetId: string, quote: Record<string, unknown>): Promise<void> {
    const res = await this.send(`${this.baseUrl}/api/v1/market-data/quotes/${encodeURIComponent(assetId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(quote),
    });
    if (!res.ok) throw await this.httpError('updateQuote', res);
  }

  /** Unlinks a linked pair in place (`POST /activities/unlink`, 3.8+): both
   *  rows lose their group and are marked external; nothing else changes. */
  async unlinkTransferActivities(activityAId: string, activityBId: string): Promise<unknown[]> {
    const res = await this.send(`${this.baseUrl}/api/v1/activities/unlink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ activityAId, activityBId }),
    });
    if (!res.ok) throw await this.httpError('unlinkTransferActivities', res);
    const rows = (await res.json()) as unknown;
    return Array.isArray(rows) ? rows : [];
  }

  async searchActivities(body: {
    page: number;
    pageSize: number;
    accountIdFilter?: string[];
    activityTypeFilter?: string[];
    /** Exact ids (upstream `activityIdFilter`, Wealthfolio 3.8). */
    activityIdFilter?: string[];
    dateFrom?: string;
    dateTo?: string;
  }): Promise<ActivitySearchItem[]> {
    const res = await this.send(`${this.baseUrl}/api/v1/activities/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.httpError('searchActivities', res);
    const json = (await res.json()) as { data: ActivitySearchItem[] };
    return json.data;
  }

  async importActivities(activities: unknown[]): Promise<void> {
    const res = await this.send(`${this.baseUrl}/api/v1/activities/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ activities }),
    });
    if (!res.ok) throw await this.httpError('importActivities', res);
  }

  async getAddonSecret(addonId: string, key: string): Promise<string | null> {
    const res = await this.send(
      `${this.baseUrl}/api/v1/addons/${encodeURIComponent(addonId)}/secrets?key=${encodeURIComponent(key)}`,
      { headers: this.authHeaders() },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await this.httpError('getAddonSecret', res);
    const raw = await res.text();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      // An absent secret is `null` with 200, not a 404.
      if (parsed === null) return null;
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed === 'object' && 'value' in parsed) {
        return (parsed as { value: string }).value;
      }
      return String(parsed);
    } catch {
      return raw.replace(/^"|"$/g, '');
    }
  }

  async setAddonSecret(addonId: string, key: string, value: string): Promise<void> {
    const res = await this.send(
      `${this.baseUrl}/api/v1/addons/${encodeURIComponent(addonId)}/secrets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ key, secret: value }),
      },
    );
    // Only the server's response body is ever included here - never the
    // request body, which contains the secret we just tried to write.
    if (!res.ok) throw await this.httpError('setAddonSecret', res);
  }

  /** Assigns a spending category to one activity. `taxonomyId` is always the
   *  literal `'spending_categories'` today, but the server takes it explicitly
   *  because Wealthfolio also has income/savings taxonomies. */
  async assignActivityCategory(activityId: string, taxonomyId: string, categoryId: string): Promise<void> {
    const res = await this.send(
      `${this.baseUrl}/api/v1/spending/activities/${encodeURIComponent(activityId)}/assignments`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ taxonomyId, categoryId }),
      },
    );
    if (!res.ok) throw await this.httpError('assignActivityCategory', res);
  }

  /** Creates a top-level spending category and returns its id. The key is the
   *  name in snake case, which is how Wealthfolio keys its own categories. */
  async createSpendingCategory(
    name: string,
    description = 'Balances an account already had when syncing began. Not spending.',
  ): Promise<string> {
    const res = await this.send(`${this.baseUrl}/api/v1/taxonomies/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        taxonomyId: 'spending_categories',
        parentId: null,
        name,
        key: name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
        color: '#9ca3af',
        description,
        sortOrder: 999,
      }),
    });
    if (!res.ok) throw await this.httpError('createSpendingCategory', res);
    const created = (await res.json()) as { id?: unknown };
    if (typeof created.id !== 'string' || !created.id) throw new Error('createSpendingCategory returned no id');
    return created.id;
  }

  /** The host's version (`GET /api/v1/app/info` → `version`, on 3.8 and 3.10),
   *  or null on any failure: callers treat an unknown host as an old one. */
  async getAppVersion(): Promise<string | null> {
    try {
      const res = await this.send(`${this.baseUrl}/api/v1/app/info`, { headers: this.authHeaders() });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      return typeof body?.version === 'string' && body.version ? body.version : null;
    } catch {
      return null;
    }
  }

  /** Wealthfolio's own `spending.excluded_category_ids` (`GET /spending/settings`,
   *  3.9+). Throws when it cannot be read: a writer that replaces the list whole
   *  must not guess. */
  async getExcludedSpendingCategories(): Promise<string[]> {
    const res = await this.send(`${this.baseUrl}/api/v1/spending/settings`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.httpError('getExcludedSpendingCategories', res);
    const body = (await res.json()) as { excludedCategoryIds?: unknown };
    const ids = body?.excludedCategoryIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new Error('getExcludedSpendingCategories: no excludedCategoryIds list');
    return ids as string[];
  }

  /** Sets `spending.excluded_category_ids`. The route is a patch: omitted
   *  fields (the account list, the enabled flag) are left as they are. */
  async setExcludedSpendingCategories(categoryIds: string[]): Promise<void> {
    const res = await this.send(`${this.baseUrl}/api/v1/spending/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ excludedCategoryIds: categoryIds }),
    });
    if (!res.ok) throw await this.httpError('setExcludedSpendingCategories', res);
  }

  /**
   * Pushes a notification to every browser that enabled Wealthfolio's Web Push.
   * Resolves `null` when the server has no push endpoint (an older Wealthfolio,
   * or the desktop app): push is an extra, never a requirement.
   */
  async sendNotification(notification: {
    title: string; body: string; url?: string; tag?: string;
  }): Promise<{ delivered: number; removed: number; failed: number } | null> {
    const res = await this.send(`${this.baseUrl}/api/v1/notifications/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(notification),
    });
    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok) throw await this.httpError('sendNotification', res);
    return (await res.json()) as { delivered: number; removed: number; failed: number };
  }

  /** Removes a taxonomy's category assignment from one activity - the undo
   *  side of `assignActivityCategory`. No request body: the taxonomy to clear
   *  is a path segment, matching the server's DELETE route shape. */
  async unassignActivityCategory(activityId: string, taxonomyId: string): Promise<void> {
    const res = await this.send(
      `${this.baseUrl}/api/v1/spending/activities/${encodeURIComponent(activityId)}/assignments/${encodeURIComponent(taxonomyId)}`,
      {
        method: 'DELETE',
        headers: this.authHeaders(),
      },
    );
    if (!res.ok) throw await this.httpError('unassignActivityCategory', res);
  }

  /**
   * Creates a "contains"-match auto-categorisation rule. `matchType` is
   * hardcoded to `'contains'` because that's the only pattern kind this
   * feature ever generates. The preset fields (`presetId`, `presetRuleKey`,
   * `presetVersion`) are omitted entirely rather than sent as null - upstream
   * (`apps/server/src/api/spending.rs`) documents that user-facing rule
   * creation leaves them None, and it's the presence of the keys, not just
   * their value, that marks a rule as preset-derived to the server.
   *
   * Resolves the new rule's id: the server answers with the rule it stored
   * (`create_categorization_rule` returns `Json<CategorizationRule>`, camelCase,
   * `id: String` — upstream `apps/server/src/api/spending.rs`). The change log
   * keeps it so R2 can delete the rule (`DELETE /api/v1/spending/rules/{id}`).
   * Null when a server answers without one.
   */
  async createCategorizationRule(rule: {
    name: string;
    pattern: string;
    categoryId: string;
    taxonomyId: string;
    priority: number;
    /** For one account only (3, L5): `isGlobal: false` with its id. Absent:
     *  every account, and no `accountId` key — upstream refuses a global rule
     *  that names an account (`validate_rule_scope`, 3.8–3.10). */
    accountId?: string;
    /** For one activity type only (a payback rule files CREDITs, W10): the
     *  matcher skips any other (`match_compiled`, 3.8–3.10). Absent: every type. */
    activityType?: string;
  }): Promise<string | null> {
    const res = await this.send(`${this.baseUrl}/api/v1/spending/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        name: rule.name,
        pattern: rule.pattern,
        matchType: 'contains',
        taxonomyId: rule.taxonomyId,
        categoryId: rule.categoryId,
        priority: rule.priority,
        isGlobal: !rule.accountId,
        ...(rule.accountId ? { accountId: rule.accountId } : {}),
        ...(rule.activityType ? { activityType: rule.activityType } : {}),
      }),
    });
    if (!res.ok) throw await this.httpError('createCategorizationRule', res);
    try {
      const created = (await res.json()) as { id?: unknown } | null;
      return typeof created?.id === 'string' && created.id ? created.id : null;
    } catch {
      return null;
    }
  }

  /** Every taxonomy's category on one activity, as the server stores it now —
   *  what an Undo checks before it changes a filing. Upstream route
   *  `GET /spending/activities/{id}/assignments` (`Vec<ActivityTaxonomyAssignment>`,
   *  camelCase). An activity with none answers `[]`; any non-2xx — a 404 for
   *  one that is gone included — throws, so the Undo says it couldn't reach
   *  Wealthfolio and changes nothing. */
  async getActivityAssignments(activityId: string): Promise<Array<{ taxonomyId: string; categoryId: string; source?: string }>> {
    const res = await this.send(
      `${this.baseUrl}/api/v1/spending/activities/${encodeURIComponent(activityId)}/assignments`,
      { headers: this.authHeaders() },
    );
    if (!res.ok) throw await this.httpError('getActivityAssignments', res);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .filter((r) => typeof r.taxonomyId === 'string' && typeof r.categoryId === 'string')
      .map((r) => ({
        taxonomyId: r.taxonomyId as string,
        categoryId: r.categoryId as string,
        ...(typeof r.source === 'string' ? { source: r.source } : {}),
      }));
  }

  /** Every categorization rule (`GET /spending/rules`, `Vec<CategorizationRule>`):
   *  how an Undo finds a rule the log knows only by name, and what "which rule
   *  filed this" is inferred from. Kept in the server's order — priority
   *  first, then oldest first — which is the order Wealthfolio applies them in
   *  (upstream `CategorizationRulesRepository::list`). */
  async listCategorizationRules(): Promise<WealthfolioRule[]> {
    const res = await this.send(`${this.baseUrl}/api/v1/spending/rules`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.httpError('listCategorizationRules', res);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
      .map((r) => {
        const rule: WealthfolioRule = {
          id: r.id as string,
          name: typeof r.name === 'string' ? r.name : '',
          pattern: typeof r.pattern === 'string' ? r.pattern : '',
          categoryId: typeof r.categoryId === 'string' ? r.categoryId : null,
        };
        if (text(r.matchType)) rule.matchType = text(r.matchType);
        if (text(r.taxonomyId)) rule.taxonomyId = text(r.taxonomyId);
        if (text(r.activityType)) rule.activityType = text(r.activityType);
        if (text(r.amountOp)) rule.amountOp = text(r.amountOp);
        if (typeof r.amountValue === 'string' || typeof r.amountValue === 'number') rule.amountValue = r.amountValue;
        if (typeof r.amountValue2 === 'string' || typeof r.amountValue2 === 'number') rule.amountValue2 = r.amountValue2;
        if (typeof r.priority === 'number') rule.priority = r.priority;
        if (typeof r.isGlobal === 'boolean') rule.isGlobal = r.isGlobal;
        if (text(r.accountId)) rule.accountId = text(r.accountId);
        return rule;
      });
  }

  /** Deletes a categorization rule (`DELETE /spending/rules/{id}`, upstream
   *  `delete_categorization_rule`). Filings the rule already made stay. A 404
   *  means the rule is already gone (deleted in Wealthfolio): that resolves, so
   *  an undo of it is not stranded. */
  async deleteCategorizationRule(id: string): Promise<void> {
    const res = await this.send(`${this.baseUrl}/api/v1/spending/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (res.status === 404) return;
    if (!res.ok) throw await this.httpError('deleteCategorizationRule', res);
  }

  async saveMany(req: {
    creates?: unknown[];
    updates?: unknown[];
    deleteIds?: string[];
  }): Promise<{ created: any[]; updated: any[]; errors: any[] }> {
    const res = await this.send(`${this.baseUrl}/api/v1/activities/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.httpError('saveMany', res);
    return (await res.json()) as { created: any[]; updated: any[]; errors: any[] };
  }
}
