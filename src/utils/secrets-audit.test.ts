import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import { AUDIT_SNAPSHOT_SECRET_KEY } from '../../shared/audit-snapshot';

const ctxOver = (data: Record<string, string>, fail = false) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => { if (fail) throw new Error('host'); return data[k] ?? null; }),
      set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
      delete: vi.fn(async (k: string) => { delete data[k]; }),
    },
  },
}) as any;

const SNAPSHOT = {
  v: 1, at: '2026-10-13T18:00:00.000Z', balances: {}, balanceNotes: [],
  headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, reasons: null, unexplainedCents: null, notes: [] },
  health: { issues: [], notes: [] },
};

describe('SecretsStore — audit snapshot', () => {
  it('reads the snapshot the companion publishes', async () => {
    const read = await new SecretsStore(ctxOver({ [AUDIT_SNAPSHOT_SECRET_KEY]: JSON.stringify(SNAPSHOT) })).getAuditSnapshot();
    expect(read).toEqual({ kind: 'ok', snapshot: SNAPSHOT });
  });

  it('tells none published from one it cannot read — and a failed host read is never "none"', async () => {
    expect(await new SecretsStore(ctxOver({})).getAuditSnapshot()).toEqual({ kind: 'absent' });
    expect(await new SecretsStore(ctxOver({ [AUDIT_SNAPSHOT_SECRET_KEY]: '{oops' })).getAuditSnapshot()).toEqual({ kind: 'corrupt' });
    expect(await new SecretsStore(ctxOver({}, true)).getAuditSnapshot()).toEqual({ kind: 'corrupt' });
  });

  it('Reset clears it', async () => {
    const data = { [AUDIT_SNAPSHOT_SECRET_KEY]: JSON.stringify(SNAPSHOT) };
    await new SecretsStore(ctxOver(data)).clearAll();
    expect(data[AUDIT_SNAPSHOT_SECRET_KEY]).toBeUndefined();
  });
});
