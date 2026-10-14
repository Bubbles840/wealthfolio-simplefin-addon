import { describe, it, expect, vi } from 'vitest';
import type { InlineKeyboard } from '../../shared/telegram.js';
import type { PaybackChoice, PaybackOutcome } from '../../shared/payback.js';
import { removalFingerprint } from '../../shared/tx-remove.js';
import { PAYBACK_PICK, PAYBACK_SWITCH, PAYBACK_UNAVAILABLE, PAYBACK_UNREACHABLE } from '../../shared/payback-copy.js';
import { createCategorizeController, type CategorizeDeps } from './categorize.js';

const CATS = [
  { id: 'cat-food', name: 'Food & Dining', parentId: null, parentName: null },
  { id: 'cat-rest', name: 'Restaurants', parentId: 'cat-food', parentName: 'Food & Dining' },
  { id: 'cat-fun', name: 'Entertainment', parentId: null, parentName: null },
];
const DEPOSIT = {
  activityId: 'act-7', wfAccountId: 'wf-chk', notes: 'VENMO CASHOUT · TRN-77', amountCents: 1400, date: '2026-10-09',
  accountName: 'PNC Checking', direction: 'in' as const, incomeEligible: true, activityType: 'DEPOSIT', pending: false,
};
const FILED: PaybackOutcome = {
  kind: 'filed', message: 'Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.\nUndo it from /changes.',
};

function setup(payback?: (c: PaybackChoice) => Promise<PaybackOutcome>) {
  let rows = [{ ...DEPOSIT }];
  const deps: CategorizeDeps = {
    dbPath: () => '/db',
    readRows: vi.fn(() => rows.map((r) => ({ ...r }))),
    readCategorized: vi.fn(() => []),
    readCategories: vi.fn(() => CATS.map((c) => ({ ...c }))),
    readIncomeCategories: vi.fn(() => [{ id: 'inc-oth', name: 'Other Income', parentId: null, parentName: null }]),
    readLedger: vi.fn(async () => ({})),
    writeLedgerMerged: vi.fn(async () => {}),
    assign: vi.fn(async () => {}),
    unassign: vi.fn(async () => {}),
    unassignTaxonomy: vi.fn(async () => {}),
    createRule: vi.fn(async () => null),
    republish: vi.fn(async () => {}),
    log: vi.fn(),
    ...(payback ? { payback: vi.fn(payback) } : {}),
  };
  const ui = { edit: vi.fn(async (_t: string, _k?: InlineKeyboard) => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
  const controller = createCategorizeController(deps);
  const tap = (data: string) => controller.onCallback({ data, chatId: 1, messageId: 2 }, ui);
  const last = () => ui.edit.mock.calls.at(-1) as unknown as [string, InlineKeyboard | undefined];
  const labels = (k?: InlineKeyboard) => (k?.inline_keyboard ?? []).flat().map((b) => b.text);
  const press = async (label: string) => {
    const btn = last()[1]!.inline_keyboard.flat().find((b) => b.text === label);
    if (!btn) throw new Error(`no "${label}" among ${labels(last()[1]).join(' | ')}`);
    await tap(btn.callback_data);
  };
  /** /categorize → the deposit → It's a payback » */
  const toPaybackGrid = async () => {
    const send = vi.fn(async (_t: string, _k?: InlineKeyboard) => {});
    await controller.open(send);
    const k = send.mock.calls[0][1]!;
    await tap(k.inline_keyboard.flat().find((b) => b.text.includes('VENMO CASHOUT'))!.callback_data);
    await press(PAYBACK_SWITCH);
  };
  return { controller, deps, ui, tap, last, labels, press, toPaybackGrid, setRows: (r: typeof rows) => { rows = r; } };
}

describe('/categorize: a deposit filed as a payback (W6)', () => {
  it('runs the payback with the category and its parent, and shows what it says, escaped, with the way on', async () => {
    const h = setup(async () => ({ ...FILED, message: FILED.message.replace('Restaurants', 'Dine_Out') }));
    await h.toPaybackGrid();
    expect(h.last()[0]).toBe(`VENMO CASHOUT\n+$14 · Oct 9 · PNC Checking\n${PAYBACK_PICK}`);
    await h.press('Food & Dining');
    await h.press('Restaurants');
    expect(h.deps.payback).toHaveBeenCalledWith({ activityId: 'act-7', categoryId: 'cat-rest', categoryName: 'Restaurants', parentName: 'Food & Dining', shown: expect.any(String) });
    expect(h.deps.assign).not.toHaveBeenCalled();
    expect(h.last()[0]).toBe('Filed as a payback under Dine\\_Out — it takes $14 off your Food & Dining spending.\nUndo it from /changes.');
    expect(h.labels(h.last()[1])).toEqual(['Next transaction', 'Done']);
    expect(h.deps.republish).toHaveBeenCalled();
  });

  it('shows a refusal with Back to the payback grid, and republishes nothing', async () => {
    const h = setup(async () => ({ kind: 'refused', message: "It's still pending — file it as a payback once it posts." }));
    await h.toPaybackGrid();
    await h.press('Entertainment');
    expect(h.last()[0]).toBe("It's still pending — file it as a payback once it posts.");
    expect(h.deps.republish).not.toHaveBeenCalled();
    await h.press('‹ Back');
    expect(h.last()[0]).toContain(PAYBACK_PICK);
  });

  it('shows a partial payback as it stands', async () => {
    const message = "It's a payback now, but Wealthfolio didn't file it under Entertainment — /categorize offers it again.\nUndo it from /changes.";
    const h = setup(async () => ({ kind: 'partial', message }));
    await h.toPaybackGrid();
    await h.press('Entertainment');
    expect(h.last()[0]).toBe(message);
  });

  it('writes nothing for a row filed elsewhere since the grid was drawn', async () => {
    const h = setup(async () => FILED);
    await h.toPaybackGrid();
    h.setRows([]);
    await h.press('Entertainment');
    expect(h.deps.payback).not.toHaveBeenCalled();
    expect(h.last()[0]).toContain('That transaction is no longer uncategorized.');
  });

  it('says it couldn’t reach Wealthfolio when the payback throws', async () => {
    const h = setup(async () => { throw new Error('boom'); });
    await h.toPaybackGrid();
    await h.press('Entertainment');
    expect(h.last()[0]).toBe(PAYBACK_UNREACHABLE);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('refuses in words when no payback is wired', async () => {
    const h = setup();
    await h.toPaybackGrid();
    await h.press('Entertainment');
    expect(h.last()[0]).toBe(PAYBACK_UNAVAILABLE);
    expect(h.deps.assign).not.toHaveBeenCalled();
  });
});

describe('/categorize: what the payback is told the menu showed (PB-B M1)', () => {
  it('passes the fingerprint of the row the menu drew, whatever the sweep says by the time of the tap', async () => {
    const h = setup(async () => FILED);
    await h.toPaybackGrid();
    // The bank text changed after the grid was drawn: the sweep now returns a different note.
    h.setRows([{ ...DEPOSIT, notes: 'VENMO CASHOUT · TRN-77 · edited' }]);
    await h.press('Entertainment');
    const shown = removalFingerprint({
      activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking',
    });
    expect(h.deps.payback).toHaveBeenCalledWith(expect.objectContaining({ activityId: 'act-7', shown }));
    expect(shown).not.toBe(removalFingerprint({
      activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77 · edited', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking',
    }));
  });
});

describe('/categorize: the payback switch is for a posted deposit only (Task 6 m1)', () => {
  /** /categorize → the one row → its screen. */
  const toRowScreen = async (row: Record<string, unknown>) => {
    const h = setup(async () => FILED);
    h.setRows([{ ...DEPOSIT, ...row } as typeof DEPOSIT]);
    const send = vi.fn(async (_t: string, _k?: InlineKeyboard) => {});
    await h.controller.open(send);
    await h.tap(send.mock.calls[0][1]!.inline_keyboard.flat()[0].callback_data);
    return h;
  };

  it('a non-pending DEPOSIT sees the switch', async () => {
    const h = await toRowScreen({});
    expect(h.labels(h.last()[1])).toContain(PAYBACK_SWITCH);
  });

  it('an INTEREST row sees the income grid and no switch', async () => {
    const h = await toRowScreen({ activityType: 'INTEREST', notes: 'INTEREST PAID · TRN-9' });
    expect(h.labels(h.last()[1])).toContain('Other Income');
    expect(h.labels(h.last()[1])).not.toContain(PAYBACK_SWITCH);
    expect(h.last()[0]).not.toContain(PAYBACK_PICK);
  });

  it('a pending DEPOSIT sees the income grid and no switch', async () => {
    const h = await toRowScreen({ pending: true, notes: 'VENMO CASHOUT · TRN-77 · pending' });
    expect(h.labels(h.last()[1])).toContain('Other Income');
    expect(h.labels(h.last()[1])).not.toContain(PAYBACK_SWITCH);
  });

  it('an INTEREST row with no income categories gets the spending grid as before, with no payback wording', async () => {
    const h = setup(async () => FILED);
    h.setRows([{ ...DEPOSIT, activityType: 'INTEREST' } as typeof DEPOSIT]);
    (h.deps.readIncomeCategories as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const send = vi.fn(async (_t: string, _k?: InlineKeyboard) => {});
    await h.controller.open(send);
    await h.tap(send.mock.calls[0][1]!.inline_keyboard.flat()[0].callback_data);
    expect(h.last()[0]).not.toContain(PAYBACK_PICK);
    expect(h.labels(h.last()[1])).toContain('Entertainment');
    await h.press('Entertainment');
    expect(h.deps.payback).not.toHaveBeenCalled();
    expect(h.deps.assign).toHaveBeenCalled();
  });
});
