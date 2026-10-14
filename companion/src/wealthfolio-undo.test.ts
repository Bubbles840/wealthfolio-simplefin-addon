import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WealthfolioClient } from './wealthfolio';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
beforeEach(() => mockFetch.mockReset());

describe('WealthfolioClient — what Undo needs', () => {
  it('reads an activity’s assignments, every taxonomy, camelCase as upstream sends them', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { id: 'x1', activityId: 'act 1', taxonomyId: 'spending_categories', categoryId: 'cat-gro', weight: 10000, source: 'rule', createdAt: '', updatedAt: '' },
        { id: 'x2', activityId: 'act 1', taxonomyId: 'income_categories', categoryId: 'inc-1', weight: 10000, source: 'manual' },
        { junk: true },
      ]),
    });
    const client = new WealthfolioClient('http://wf');
    expect(await client.getActivityAssignments('act 1')).toEqual([
      { taxonomyId: 'spending_categories', categoryId: 'cat-gro', source: 'rule' },
      { taxonomyId: 'income_categories', categoryId: 'inc-1', source: 'manual' },
    ]);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/spending/activities/act%201/assignments');
    expect((opts as any).method).toBeUndefined();
  });

  it('lists the categorization rules', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', matchType: 'contains', categoryId: 'cat-gro', priority: 50 },
        { id: 'rule-8', name: 'Preset', pattern: 'X', categoryId: null },
      ]),
    });
    expect(await new WealthfolioClient('http://wf').listCategorizationRules()).toEqual([
      { id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', matchType: 'contains', priority: 50 },
      { id: 'rule-8', name: 'Preset', pattern: 'X', categoryId: null },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe('http://wf/api/v1/spending/rules');
  });

  it('keeps every field Wealthfolio’s matcher reads, in the order the server lists the rules', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        {
          id: 'r-1', name: 'Big rent', pattern: 'RENT', matchType: 'starts_with', taxonomyId: 'spending_categories',
          categoryId: 'cat-home', activityType: 'WITHDRAWAL', amountOp: 'between', amountValue: '900', amountValue2: '1500.50',
          priority: 90, isGlobal: false, accountId: 'wf-chk', presetModified: false,
        },
        { id: 'r-2', name: 'Older', pattern: 'X', categoryId: 'cat-x', priority: 90 },
      ]),
    });
    expect(await new WealthfolioClient('http://wf').listCategorizationRules()).toEqual([
      {
        id: 'r-1', name: 'Big rent', pattern: 'RENT', matchType: 'starts_with', taxonomyId: 'spending_categories',
        categoryId: 'cat-home', activityType: 'WITHDRAWAL', amountOp: 'between', amountValue: '900', amountValue2: '1500.50',
        priority: 90, isGlobal: false, accountId: 'wf-chk',
      },
      { id: 'r-2', name: 'Older', pattern: 'X', categoryId: 'cat-x', priority: 90 },
    ]);
  });

  it('deletes a rule by id, treats 404 as already gone, and says why it could not', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
    const client = new WealthfolioClient('http://wf');
    await client.deleteCategorizationRule('rule/7');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/spending/rules/rule%2F7');
    expect((opts as any).method).toBe('DELETE');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Rule not found' });
    await expect(client.deleteCategorizationRule('gone')).resolves.toBeUndefined();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.deleteCategorizationRule('bad')).rejects.toThrow('deleteCategorizationRule failed: 500 - boom');
  });
});
