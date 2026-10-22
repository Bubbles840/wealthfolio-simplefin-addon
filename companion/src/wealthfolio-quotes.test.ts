import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WealthfolioClient } from './wealthfolio';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => mockFetch.mockReset());

describe('WealthfolioClient — alternative assets and quotes', () => {
  it('getAlternativeHoldings GETs /alternative-holdings and returns the rows', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{ id: 'LIAB-1', kind: 'liability' }] });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    expect(await client.getAlternativeHoldings()).toEqual([{ id: 'LIAB-1', kind: 'liability' }]);
    expect(mockFetch.mock.calls[0][0]).toBe('http://wealthfolio:8088/api/v1/alternative-holdings');
  });

  it('getAlternativeHoldings reads a non-array body as no rows, and throws on a refusal', async () => {
    const client = new WealthfolioClient('http://wealthfolio:8088');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ not: 'a list' }) });
    expect(await client.getAlternativeHoldings()).toEqual([]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.getAlternativeHoldings()).rejects.toThrow('getAlternativeHoldings failed: 500 - boom');
  });

  it('getQuoteHistory GETs the asset id URL-encoded as the symbol', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{ timestamp: '2027-04-14T00:00:00Z', close: 250000, dataSource: 'MANUAL', notes: null }] });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    const rows = await client.getQuoteHistory('LIAB/1 a');
    expect(rows).toEqual([{ timestamp: '2027-04-14T00:00:00Z', close: 250000, dataSource: 'MANUAL', notes: null }]);
    expect(mockFetch.mock.calls[0][0]).toBe('http://wealthfolio:8088/api/v1/market-data/quotes/history?symbol=LIAB%2F1%20a');
  });

  it('getQuoteHistory throws on a refusal', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'no such asset' });
    await expect(new WealthfolioClient('http://wealthfolio:8088').getQuoteHistory('X')).rejects.toThrow('getQuoteHistory failed: 404 - no such asset');
  });

  it('updateQuote PUTs the quote as JSON, amounts as numbers, to the encoded asset id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    const quote = { id: 'LIAB/1_2027-04-14_MANUAL', assetId: 'LIAB/1', close: 250000.5, volume: 0, dataSource: 'MANUAL' };
    await client.updateQuote('LIAB/1', quote);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/market-data/quotes/LIAB%2F1');
    expect((opts as any).method).toBe('PUT');
    expect((opts as any).headers['Content-Type']).toBe('application/json');
    expect(JSON.parse((opts as any).body)).toEqual(quote);
    expect(typeof JSON.parse((opts as any).body).close).toBe('number');
  });

  it('updateQuote throws on a refusal', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad quote' });
    await expect(new WealthfolioClient('http://wealthfolio:8088').updateQuote('X', {})).rejects.toThrow('updateQuote failed: 400 - bad quote');
  });
});
