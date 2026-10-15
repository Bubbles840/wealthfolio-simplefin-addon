import { describe, it, expect, vi } from 'vitest';
import type { InlineKeyboard } from '../../shared/telegram.js';
import type { PaybackBreadth, PaybackChoice, PaybackOutcome, PaybackRulesInput, PaybackRulesOutcome } from '../../shared/payback.js';
import { removalFingerprint } from '../../shared/tx-remove.js';
import {
  PAYBACK_PICK, PAYBACK_RULES_EXIST, PAYBACK_SWITCH, PAYBACK_UNAVAILABLE, PAYBACK_UNREACHABLE,
} from '../../shared/payback-copy.js';
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

function setup(
  payback?: (c: PaybackChoice) => Promise<PaybackOutcome>,
  paybackRules?: (i: PaybackRulesInput) => Promise<PaybackRulesOutcome>,
  paybackBreadth?: (i: { pattern: string; account: { id: string; name: string }; sourceId: string; description: string; waitingIds: string[] }) => Promise<PaybackBreadth>,
) {
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
    ...(paybackRules ? { paybackRules: vi.fn(paybackRules) } : {}),
    ...(paybackBreadth ? { paybackBreadth: vi.fn(paybackBreadth) } : {}),
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
    expect(h.labels(h.last()[1])).toEqual(['Make every VENMO CASHOUT deposit a payback', 'Next transaction', 'Done']);
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

describe('/categorize: "Make every … deposit a payback" (W10)', () => {
  const DONE = 'Done — every VENMO CASHOUT deposit into PNC Checking is a payback under Restaurants from now on. Undo either rule from /changes.';

  it('offers it after the payback, previews it, and makes both rules for the row’s account and words', async () => {
    const h = setup(async () => FILED, async () => ({ ok: true, message: DONE }));
    await h.toPaybackGrid();
    await h.press('Food & Dining');
    await h.press('Restaurants');
    await h.press('Make every VENMO CASHOUT deposit a payback');
    expect(h.last()[0].split('\n')[0]).toBe('Make every VENMO CASHOUT deposit a payback?');
    await h.press('Create both rules');
    expect(h.deps.paybackRules).toHaveBeenCalledWith({
      pattern: 'VENMO CASHOUT', account: { id: 'wf-chk', name: 'PNC Checking' }, categoryId: 'cat-rest', categoryName: 'Restaurants',
      description: 'VENMO CASHOUT',
      categories: [{ id: 'cat-food', name: 'Food & Dining' }, { id: 'cat-rest', name: 'Restaurants' }, { id: 'cat-fun', name: 'Entertainment' }],
    });
    expect(h.last()[0]).toBe(DONE);
    expect(h.labels(h.last()[1])).toEqual(['‹ Back to list', 'Done']);
  });

  it('says why when nothing was made, with nothing to tap twice', async () => {
    const h = setup(async () => FILED, async () => ({ ok: false, message: PAYBACK_RULES_EXIST }));
    await h.toPaybackGrid();
    await h.press('Entertainment');
    await h.press('Make every VENMO CASHOUT deposit a payback');
    await h.press('Create both rules');
    expect(h.last()[0]).toBe(PAYBACK_RULES_EXIST);
    expect(h.labels(h.last()[1])).not.toContain('Create both rules');
    expect(h.deps.republish).toHaveBeenCalledTimes(1);
  });
});

describe('/categorize: the breadth of the rules, read from the ledger as the preview opens (W10, I1)', () => {
  it('shows the counts the ledger gave, asking for them with the account, the words and the rows waiting', async () => {
    const h = setup(async () => FILED, undefined, async () => ({ ok: true, filed: 4, waiting: 2 }));
    await h.toPaybackGrid();
    await h.press('Entertainment');
    await h.press('Make every VENMO CASHOUT deposit a payback');
    expect(h.deps.paybackBreadth).toHaveBeenCalledWith({
      pattern: 'VENMO CASHOUT', account: { id: 'wf-chk', name: 'PNC Checking' }, sourceId: 'act-7', description: 'VENMO CASHOUT', waitingIds: expect.any(Array),
    });
    expect(h.last()[0]).toContain('6 deposits here read that way: 4 already filed, 2 waiting for a category.');
    expect(h.labels(h.last()[1])).toContain('Create both rules');
  });

  it('says why a refused breadth was refused and offers nothing to create', async () => {
    const h = setup(async () => FILED, undefined, async () => ({ ok: false, message: 'That description is only common bank words — nothing was changed.' }));
    await h.toPaybackGrid();
    await h.press('Entertainment');
    await h.press('Make every VENMO CASHOUT deposit a payback');
    expect(h.last()[0]).toBe('That description is only common bank words — nothing was changed.');
    expect(h.labels(h.last()[1])).not.toContain('Create both rules');
  });

  it('still previews, without counts, when the ledger cannot be read', async () => {
    const h = setup(async () => FILED, undefined, async () => { throw new Error('down'); });
    await h.toPaybackGrid();
    await h.press('Entertainment');
    await h.press('Make every VENMO CASHOUT deposit a payback');
    expect(h.last()[0]).not.toContain('already filed');
    expect(h.labels(h.last()[1])).toContain('Create both rules');
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
