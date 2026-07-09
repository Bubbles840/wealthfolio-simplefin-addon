export class WealthfolioClient {
  private token: string | null = null;

  constructor(private baseUrl: string) {}

  async login(username: string, password: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`Wealthfolio login failed: ${res.status}`);
    const data = await res.json() as { token: string };
    this.token = data.token;
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

  async importActivities(activities: unknown[]): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ activities }),
    });
    if (!res.ok) throw new Error(`importActivities failed: ${res.status}`);
  }
}
