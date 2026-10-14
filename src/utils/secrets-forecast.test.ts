import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import { CASH_FORECAST_SECRET_KEY } from '../../shared/cash-forecast';

const ctxOver = (data: Record<string, string>, fail = false) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => { if (fail) throw new Error('host'); return data[k] ?? null; }),
      set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
      delete: vi.fn(async (k: string) => { delete data[k]; }),
    },
  },
}) as any;

const FAILED = { v: 1, at: '2026-10-14T18:00:00.000Z', ok: false, reason: "Couldn't read the bank balances." };

describe('SecretsStore — cash forecast', () => {
  it('reads the forecast the companion publishes', async () => {
    expect(await new SecretsStore(ctxOver({ [CASH_FORECAST_SECRET_KEY]: JSON.stringify(FAILED) })).getCashForecast())
      .toEqual({ kind: 'ok', forecast: FAILED });
  });

  it('tells none published from one it cannot read — and a failed host read is never "none"', async () => {
    expect(await new SecretsStore(ctxOver({})).getCashForecast()).toEqual({ kind: 'absent' });
    expect(await new SecretsStore(ctxOver({ [CASH_FORECAST_SECRET_KEY]: '{oops' })).getCashForecast()).toEqual({ kind: 'corrupt' });
    expect(await new SecretsStore(ctxOver({}, true)).getCashForecast()).toEqual({ kind: 'corrupt' });
  });

  it('Reset clears it', async () => {
    const data = { [CASH_FORECAST_SECRET_KEY]: JSON.stringify(FAILED) };
    await new SecretsStore(ctxOver(data)).clearAll();
    expect(data[CASH_FORECAST_SECRET_KEY]).toBeUndefined();
  });
});
