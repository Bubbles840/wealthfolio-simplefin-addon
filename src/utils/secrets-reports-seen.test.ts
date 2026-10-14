import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import { REPORTS_SEEN_SECRET_KEY } from '../../shared/reports-seen';

const ctxOver = (data: Record<string, string>, fail = false) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => { if (fail) throw new Error('host'); return data[k] ?? null; }),
      set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
      delete: vi.fn(async (k: string) => { delete data[k]; }),
    },
  },
}) as any;

describe('SecretsStore — reports seen', () => {
  it('reads what was seen: ok, absent on a first run, corrupt when unreadable', async () => {
    const seen = { daily: '2026-10-14T12:00:00.000Z' };
    expect(await new SecretsStore(ctxOver({ [REPORTS_SEEN_SECRET_KEY]: JSON.stringify(seen) })).getReportsSeen()).toEqual({ kind: 'ok', seen });
    expect(await new SecretsStore(ctxOver({})).getReportsSeen()).toEqual({ kind: 'absent' });
    expect(await new SecretsStore(ctxOver({ [REPORTS_SEEN_SECRET_KEY]: '{oops' })).getReportsSeen()).toEqual({ kind: 'corrupt' });
  });

  it('rejects when the host read fails, so the page can write nothing', async () => {
    await expect(new SecretsStore(ctxOver({}, true)).getReportsSeen()).rejects.toThrow('host');
  });

  it('writes the document, and Reset clears it', async () => {
    const data: Record<string, string> = {};
    const store = new SecretsStore(ctxOver(data));
    await store.setReportsSeen({ weekly: '2026-10-11T23:00:00.000Z' });
    expect(JSON.parse(data[REPORTS_SEEN_SECRET_KEY])).toEqual({ weekly: '2026-10-11T23:00:00.000Z' });
    await store.clearAll();
    expect(data[REPORTS_SEEN_SECRET_KEY]).toBeUndefined();
  });
});
