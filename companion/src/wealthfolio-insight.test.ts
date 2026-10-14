import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WealthfolioClient } from './wealthfolio.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
beforeEach(() => mockFetch.mockReset());

describe('WealthfolioClient.getSpendingInsightSpent', () => {
  it('POSTs the window to /spending/insight and returns the headline’s spent', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ headline: { spent: 1301.4, income: 9 } }) });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    expect(await client.getSpendingInsightSpent('2026-10-01T04:00:00.000Z', '2026-11-01T03:59:59.999Z')).toBe(1301.4);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/spending/insight');
    expect((opts as any).method).toBe('POST');
    expect(JSON.parse((opts as any).body)).toEqual({ startDate: '2026-10-01T04:00:00.000Z', endDate: '2026-11-01T03:59:59.999Z' });
  });

  it('rejects an error status or a reply without a figure, rather than reading it as $0', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'no route' });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await expect(client.getSpendingInsightSpent('a', 'b')).rejects.toThrow();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ headline: {} }) });
    await expect(client.getSpendingInsightSpent('a', 'b')).rejects.toThrow(/headline.spent/);
  });
});
