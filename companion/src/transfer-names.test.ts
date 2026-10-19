import { describe, it, expect, vi } from 'vitest';
import { publishTransferNames, type PublishTransferNamesDeps } from './transfer-names.js';
import { emptySyncOverrides } from '../../shared/sync-overrides.js';
import { parseTransferNames } from '../../shared/transfer-names.js';
import type { AuditLedger } from '../../shared/audit-ledger.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const leg = (id: string, accountId: string, type: string, notes: string) => ({
  id, accountId, date: '2026-10-01', currency: 'USD', rawType: type, type, status: 'POSTED', absCents: 60000,
  group: 'g1', assetId: '', external: false, phantomCash: false, notes,
});
const LEDGER: AuditLedger = {
  accounts: [{ id: 'wf-sav', name: 'Savings', type: 'CASH', archived: false }, { id: 'wf-spend', name: 'Spend', type: 'CASH', archived: false }],
  rows: [
    leg('r1', 'wf-sav', 'TRANSFER_OUT', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'),
    leg('r2', 'wf-spend', 'TRANSFER_IN', 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT · TRN-2'),
  ],
};
const deps = (over: Partial<PublishTransferNamesDeps> = {}): PublishTransferNamesDeps & { write: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } => ({
  readLedger: () => LEDGER,
  readMapping: async () => ({ 'sfin-sav': 'wf-sav', 'sfin-spend': 'wf-spend' }),
  readOverrides: async () => emptySyncOverrides(),
  write: vi.fn(async () => {}),
  log: vi.fn(),
  now: NOW,
  ...over,
}) as any;

describe('publishTransferNames (A4)', () => {
  it('writes the learned list as the transfer_names document', async () => {
    const d = deps();
    expect(await publishTransferNames(d)).toBe(2);
    expect(parseTransferNames(d.write.mock.calls[0][0])).toEqual({ version: 1, computedAt: '2026-10-18T15:00:00.000Z', names: [
      { accountId: 'wf-sav', direction: 'out', signature: 'withdrawal to pnc bank' },
      { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
    ] });
  });

  it('keeps the previous list when the database or the overrides cannot be read', async () => {
    const noDb = deps({ readLedger: () => { throw new Error('no database'); } });
    expect(await publishTransferNames(noDb)).toBeNull();
    expect(noDb.write).not.toHaveBeenCalled();
    expect(noDb.log).toHaveBeenCalledWith(expect.stringContaining('no database'));

    const noOverrides = deps({ readOverrides: async () => null });
    expect(await publishTransferNames(noOverrides)).toBeNull();
    expect(noOverrides.write).not.toHaveBeenCalled();

    const failing = deps({ readOverrides: async () => { throw new Error('401'); } });
    expect(await publishTransferNames(failing)).toBeNull();
    expect(failing.write).not.toHaveBeenCalled();
  });
});
