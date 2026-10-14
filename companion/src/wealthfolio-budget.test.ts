import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasBudget } from '../../shared/budget-suggest.js';
import { parseBudgetSnapshot, WealthfolioClient } from './wealthfolio.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
beforeEach(() => mockFetch.mockReset());

/** A `BudgetSnapshot` as Wealthfolio 3.8–3.10 serializes it (camelCase), trimmed to what is read. */
const snapshot = (targets: unknown[], groups: unknown[] = [{ id: 'g-needs', name: 'Needs' }]) => ({
  state: { groups, groupAssignments: [], targets, rolloverSettings: [] },
  computed: { currency: 'USD', periodKey: 'default', groupRows: [], ungroupedRows: [], incomeRows: [], totals: {} },
});
const wire = (over: Record<string, unknown> = {}) => ({
  id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro',
  groupId: null, amount: '425.00', createdAt: '2026-10-14T09:00:00', updatedAt: '2026-10-14T09:00:00', ...over,
});

describe('parseBudgetSnapshot', () => {
  it('reads every target, amounts in cents, and skips one it cannot identify', () => {
    expect(parseBudgetSnapshot(snapshot([
      wire(),
      wire({ id: 'bt-oct', periodKey: '2026-10', amount: '15.5', categoryId: 'cat-din' }),
      wire({ id: 'bt-buf', targetType: 'group_buffer', taxonomyId: null, categoryId: null, groupId: 'g-needs', amount: 50 }),
      wire({ id: 7 }),
    ]))).toEqual({
      enabled: true,
      targets: [
        { id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500 },
        { id: 'bt-oct', periodKey: '2026-10', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-din', amountCents: 1550 },
        { id: 'bt-buf', periodKey: 'default', targetType: 'group_buffer', taxonomyId: null, categoryId: null, amountCents: 5000 },
      ],
    });
  });

  it.each([['425'], ['425.0'], ['425.00'], [425]])('reads the amount %j as 42500 cents', (amount) => {
    expect(parseBudgetSnapshot(snapshot([wire({ amount })])).targets[0].amountCents).toBe(42500);
  });

  it('KEEPS a target whose amount does not parse, so it still blocks a write', () => {
    for (const amount of ['lots', '', null, undefined, {}]) {
      const { targets } = parseBudgetSnapshot(snapshot([wire({ amount })]));
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ id: 'bt-gro', categoryId: 'cat-gro' });
      expect(Number.isNaN(targets[0].amountCents)).toBe(true);
      // Overwrite safety never depends on the amount.
      expect(hasBudget(targets, 'cat-gro', '2026-10')).toBe(true);
    }
  });

  it('reads an empty snapshot — what Wealthfolio answers while its Spending tracker is off — as not enabled', () => {
    expect(parseBudgetSnapshot(snapshot([], []))).toEqual({ enabled: false, targets: [] });
  });

  it('rejects a reply that is not a snapshot rather than reading it as "no budgets"', () => {
    for (const body of [null, [], { state: {} }, { state: { targets: 'x' } }]) {
      expect(() => parseBudgetSnapshot(body)).toThrow(/no budget targets/);
    }
  });
});

describe('WealthfolioClient budgets', () => {
  it('reads the default view: GET /spending/budget?periodKey=default', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => snapshot([wire()]) });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    expect((await client.getBudgetTargets()).targets.map((t) => t.id)).toEqual(['bt-gro']);
    expect(mockFetch.mock.calls[0][0]).toBe('http://wealthfolio:8088/api/v1/spending/budget?periodKey=default');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.getBudgetTargets()).rejects.toThrow('getBudgetTargets failed: 500 - boom');
  });

  it("POSTs a category's default target, the amount a decimal string, and reads the stored one back", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => snapshot([wire({ id: 'bt-din', categoryId: 'cat-din', amount: '180.00' }), wire()]) });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    expect(await client.setDefaultBudgetTarget('cat-gro', 42500)).toEqual({
      id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500,
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/spending/budget/targets?periodKey=default');
    expect((opts as RequestInit).method).toBe('POST');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amount: '425.00',
    });
  });

  it('rejects a POST that fails', async () => {
    const client = new WealthfolioClient('http://wealthfolio:8088');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Category target requires taxonomyId and categoryId only' });
    await expect(client.setDefaultBudgetTarget('cat-gro', 42500)).rejects.toThrow('setBudgetTarget failed: 400 - Category target requires taxonomyId and categoryId only');
  });

  it('resolves null — never throws — once the POST succeeded but the reply names no stored target', async () => {
    const client = new WealthfolioClient('http://wealthfolio:8088');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => snapshot([], []) });
    expect(await client.setDefaultBudgetTarget('cat-gro', 42500)).toBeNull();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ state: {} }) });
    expect(await client.setDefaultBudgetTarget('cat-gro', 42500)).toBeNull();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('not json'); } });
    expect(await client.setDefaultBudgetTarget('cat-gro', 42500)).toBeNull();
  });

  it('DELETEs a target by id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => snapshot([]) });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.deleteBudgetTarget('bt/gro');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/spending/budget/targets/bt%2Fgro?periodKey=default');
    expect((opts as RequestInit).method).toBe('DELETE');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.deleteBudgetTarget('bt-gro')).rejects.toThrow('deleteBudgetTarget failed: 500 - boom');
  });
});
