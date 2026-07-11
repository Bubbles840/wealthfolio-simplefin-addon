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
    if (!res.ok) throw new Error(`Wealthfolio login failed: ${res.status}`);

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

  async checkImport(accountId: string, activities: unknown[]): Promise<unknown[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/import/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ accountId, activities }),
    });
    if (!res.ok) throw new Error(`checkImport failed: ${res.status}`);
    return res.json() as Promise<unknown[]>;
  }

  async getAccounts(): Promise<Array<{ id: string; accountType?: string }>> {
    const res = await fetch(`${this.baseUrl}/api/v1/accounts`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`getAccounts failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`getLatestValuations failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`searchActivities failed: ${res.status}`);
    const json = (await res.json()) as { data: ActivitySearchItem[] };
    return json.data;
  }

  async importActivities(activities: unknown[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ activities }),
    });
    if (!res.ok) throw new Error(`importActivities failed: ${res.status}`);
  }
}
