export interface ActivitySearchItem {
  id: string;
  accountId: string;
  activityType: string;
  /** ISO date or datetime string */
  date: string;
  amount?: string | number | null;
  sourceGroupId?: string | null;
  comment?: string | null;
}

export class WealthfolioClient {
  private token: string | null = null;

  constructor(private baseUrl: string) {}

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
    return new Error(`${action} failed: ${res.status}${detail}`);
  }

  async checkImport(accountId: string, activities: unknown[]): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/import/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ accountId, activities }),
    });
    if (!res.ok) throw await this.httpError('checkImport', res);
    return res.json() as Promise<unknown[]>;
  }

  async getAccounts(): Promise<Array<{ id: string; accountType?: string }>> {
    const res = await fetch(`${this.baseUrl}/api/v1/accounts`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('getAccounts', res);
    return res.json() as Promise<Array<{ id: string; accountType?: string }>>;
  }

  /**
   * Latest per-account valuations. The accounts endpoint has no balance
   * field — totalValue here is the real current account balance.
   */
  async getLatestValuations(): Promise<Array<{ accountId: string; totalValue: string | number }>> {
    const res = await fetch(`${this.baseUrl}/api/v1/valuations/latest`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('getLatestValuations', res);
    return res.json() as Promise<Array<{ accountId: string; totalValue: string | number }>>;
  }

  /** Marks two activities as one internal transfer (shared source_group_id). */
  async linkTransferActivities(activityAId: string, activityBId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ activityAId, activityBId }),
    });
    if (!res.ok) throw new Error(`linkTransferActivities failed: ${res.status}`);
  }

  async searchActivities(body: {
    page: number;
    pageSize: number;
    accountIdFilter?: string[];
    activityTypeFilter?: string[];
    dateFrom?: string;
    dateTo?: string;
  }): Promise<ActivitySearchItem[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.httpError('searchActivities', res);
    const json = (await res.json()) as { data: ActivitySearchItem[] };
    return json.data;
  }

  async importActivities(activities: unknown[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ activities }),
    });
    if (!res.ok) throw await this.httpError('importActivities', res);
  }

  async getAddonSecret(addonId: string, key: string): Promise<string | null> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/addons/${encodeURIComponent(addonId)}/secrets?key=${encodeURIComponent(key)}`,
      { headers: this.authHeaders() },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await this.httpError('getAddonSecret', res);
    const raw = await res.text();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
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
    const res = await fetch(
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

  async saveMany(req: {
    creates?: unknown[];
    updates?: unknown[];
    deleteIds?: string[];
  }): Promise<{ created: any[]; updated: any[]; errors: any[] }> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await this.httpError('saveMany', res);
    return (await res.json()) as { created: any[]; updated: any[]; errors: any[] };
  }
}
