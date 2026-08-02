import { describe, it, expect, vi } from 'vitest';
import { pollTelegramDismissals, pruneDismissals } from './dismissals.js';

const updatesResponse = (updates: unknown[]) => ({
  ok: true,
  json: async () => ({ ok: true, result: updates }),
});

describe('pollTelegramDismissals', () => {
  it('collects d:<activityId> callbacks, answers each, and advances the offset', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(updatesResponse([
        { update_id: 100, callback_query: { id: 'cb-1', data: 'd:act-1' } },
        { update_id: 101, callback_query: { id: 'cb-2', data: 'd:act-2' } },
      ]))
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const res = await pollTelegramDismissals({ botToken: 'T', offset: 50, fetchImpl: fetchImpl as any });
    expect(res.dismissedActivityIds).toEqual(['act-1', 'act-2']);
    expect(res.nextOffset).toBe(102);

    const getUpdatesUrl = String(fetchImpl.mock.calls[0][0]);
    expect(getUpdatesUrl).toContain('/botT/getUpdates');
    expect(getUpdatesUrl).toContain('offset=50');
    // Both callbacks answered, so the user's button press stops spinning.
    const answered = fetchImpl.mock.calls.slice(1).map((c) => String(c[0]));
    expect(answered.filter((u) => u.includes('answerCallbackQuery'))).toHaveLength(2);
  });

  it('advances past non-dismiss updates without reporting them', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(updatesResponse([
      { update_id: 7, message: { text: 'hello bot' } },
      { update_id: 8, callback_query: { id: 'cb-3', data: 'unrelated' } },
    ])).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    const res = await pollTelegramDismissals({ botToken: 'T', offset: null, fetchImpl: fetchImpl as any });
    expect(res.dismissedActivityIds).toEqual([]);
    // The offset still moves, or these updates would be re-fetched forever.
    expect(res.nextOffset).toBe(9);
  });

  it('returns the offset unchanged and no ids when the poll fails, without throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const res = await pollTelegramDismissals({ botToken: 'T', offset: 42, fetchImpl: fetchImpl as any });
    expect(res).toEqual({ dismissedActivityIds: [], nextOffset: 42 });
  });
});

describe('pruneDismissals', () => {
  it('drops entries older than 60 days and keeps the rest', () => {
    const now = new Date('2026-07-30T00:00:00Z');
    const pruned = pruneDismissals(
      { 'act-old': '2026-05-01T00:00:00Z', 'act-new': '2026-07-20T00:00:00Z' },
      now,
    );
    expect(pruned).toEqual({ 'act-new': '2026-07-20T00:00:00Z' });
  });
});
