import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import { LOAN_LINKS_SECRET_KEY } from '../../shared/loan-balances';
import { requireWealthfolioSecretKey } from '../../shared/__fixtures__/wealthfolio-secret-key';

const ctxOver = (data: Record<string, string>) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => { requireWealthfolioSecretKey(k); return data[k] ?? null; }),
      set: vi.fn(async (k: string, v: string) => { requireWealthfolioSecretKey(k); data[k] = v; }),
      delete: vi.fn(async (k: string) => { requireWealthfolioSecretKey(k); delete data[k]; }),
    },
  },
}) as any;

describe('SecretsStore — loan links', () => {
  it('writes the links under the key the companion reads, and reads them back', async () => {
    const data: Record<string, string> = {};
    const store = new SecretsStore(ctxOver(data));
    await store.setLoanLinks({ 'sfin-loan': 'LIAB-1' });
    expect(JSON.parse(data[LOAN_LINKS_SECRET_KEY])).toEqual({ 'sfin-loan': 'LIAB-1' });
    expect(await store.getLoanLinks()).toEqual({ 'sfin-loan': 'LIAB-1' });
  });

  it('reads absent and corrupt links as none', async () => {
    expect(await new SecretsStore(ctxOver({})).getLoanLinks()).toEqual({});
    expect(await new SecretsStore(ctxOver({ [LOAN_LINKS_SECRET_KEY]: 'not json' })).getLoanLinks()).toEqual({});
  });
});
