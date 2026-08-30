import { describe, it, expect, vi } from 'vitest';
import { createTransferLearning, rulePatternFor } from './transfer-learning.js';

function make(existing: any[] = []) {
  const state = { rules: existing };
  const deps = {
    readRules: vi.fn(async () => state.rules),
    writeRules: vi.fn(async (r: any[]) => { state.rules = r; }),
    log: vi.fn(),
  };
  return { menu: createTransferLearning(deps as any), deps, state };
}

const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}) });

const tx = (over: Partial<any> = {}) => ({
  description: 'Payment to Ccb Credit Card Payments',
  amountCents: 14098,
  activityType: 'WITHDRAWAL',
  accountName: 'Spend (4937)',
  ...over,
});

/** Walks all three taps: open the picker, choose an entry, confirm the rule.
 *  The confirm step exists because the rule is retroactive and silent. */
async function teach(menu: any, candidates: any[], index = 0) {
  const row = menu.entryButton(candidates)!;
  const token = row[0].callback_data.slice('cz:tl:'.length);
  await menu.onCallback({ data: `cz:tl:${token}` }, ui());
  await menu.onCallback({ data: `cz:tlc:${token}:${index}` }, ui());
  const u = ui();
  await menu.onCallback({ data: `cz:tlk:${token}:${index}` }, u);
  return u;
}

/** Stops at the preview, which is where the warnings live. */
async function preview(menu: any, candidates: any[], index = 0) {
  const row = menu.entryButton(candidates)!;
  const token = row[0].callback_data.slice('cz:tl:'.length);
  await menu.onCallback({ data: `cz:tl:${token}` }, ui());
  const u = ui();
  await menu.onCallback({ data: `cz:tlc:${token}:${index}` }, u);
  return u;
}

describe('rulePatternFor', () => {
  it('keeps the payee wording a bank repeats verbatim', () => {
    expect(rulePatternFor('Payment to Ccb Credit Card Payments'))
      .toBe('Payment to Ccb Credit Card Payments');
  });

  it('drops a trailing reference number, which changes every time', () => {
    // Pinning the rule to one day's reference would make it match once, ever.
    expect(rulePatternFor('ACH WITHDRAWAL 99182')).toBe('ACH WITHDRAWAL');
  });

  it('survives punctuation banks sprinkle through descriptors', () => {
    expect(rulePatternFor('TST*HAMMERHEADS #12')).toBe('TST HAMMERHEADS');
  });

  it('is empty for a description with nothing to match on', () => {
    expect(rulePatternFor('***')).toBe('');
  });
});

describe('transfer learning', () => {
  it('offers one entry button, not one per transaction', () => {
    // The notice already carries a dismiss row per uncategorized charge.
    const row = make().menu.entryButton([tx(), tx({ description: 'Payment to Discover Bank' })])!;
    expect(row).toHaveLength(1);
    expect(row[0].text).toContain('transfer');
    expect(Buffer.byteLength(row[0].callback_data)).toBeLessThanOrEqual(64);
  });

  it('offers nothing when everything is already a transfer', () => {
    const { menu } = make();
    expect(menu.entryButton([tx({ activityType: 'TRANSFER_OUT' })])).toBeUndefined();
    expect(menu.entryButton([])).toBeUndefined();
  });

  it('offers nothing for an in-transit placeholder, which IS a transfer already', () => {
    // The live case, 2026-08-25: a savings->bank transfer's first leg arrived
    // ahead of its counterpart, was booked as the spending-neutral placeholder
    // (a transfer wearing a CREDIT type), and the notice offered to "mark it
    // as a transfer". Filtering by activityType alone cannot catch it —
    // that is the disguise. Teaching a rule from it would be worse than
    // pointless: its descriptor names the user's own bank, so the rule would
    // convert every future deposit from that bank into a transfer leg.
    const { menu } = make();
    expect(menu.entryButton([tx({ activityType: 'CREDIT', inTransit: true })])).toBeUndefined();
  });

  it('still offers the button when a real candidate rides alongside a placeholder', () => {
    const { menu } = make();
    const row = menu.entryButton([
      tx({ activityType: 'CREDIT', inTransit: true, description: 'PNC BANK, NATIONAL' }),
      tx(),
    ]);
    expect(row).toHaveLength(1);
  });

  it('writes a rule that types future payments as transfers out', async () => {
    // The live case: "Ccb" is Coastal Community Bank, the Robinhood card's
    // issuer — a string no keyword list would ever have contained.
    const { menu, state } = make();
    await teach(menu, [tx()]);
    expect(state.rules).toEqual([
      { pattern: 'Payment to Ccb Credit Card Payments', matchType: 'contains', activityType: 'TRANSFER_OUT' },
    ]);
  });

  it('preserves direction rather than guessing it', async () => {
    const { menu, state } = make();
    await teach(menu, [tx({ activityType: 'DEPOSIT', description: 'Transfer from Savings' })]);
    expect(state.rules[0].activityType).toBe('TRANSFER_IN');
  });

  it('appends, so rules the user wrote by hand survive', async () => {
    const mine = { pattern: 'Venmo', matchType: 'contains', activityType: 'CREDIT' };
    const { menu, state } = make([mine]);
    await teach(menu, [tx()]);
    expect(state.rules[0]).toEqual(mine);
    expect(state.rules).toHaveLength(2);
  });

  it('does not add the same rule twice', async () => {
    const { menu, state, deps } = make([
      { pattern: 'Payment to Ccb Credit Card Payments', matchType: 'contains', activityType: 'TRANSFER_OUT' },
    ]);
    const u = await teach(menu, [tx()]);
    expect(state.rules).toHaveLength(1);
    expect(deps.writeRules).not.toHaveBeenCalled();
    // Still confirms, so a second tap does not look like a failure.
    expect(u.answer).toHaveBeenCalled();
  });

  it('tells the user the change applies on the next sync', async () => {
    // The rule is what makes it permanent; reconciliation retypes the existing
    // row because its resolved type now differs from what is stored.
    const { menu } = make();
    const u = await teach(menu, [tx()]);
    expect(u.edit.mock.calls[0][0]).toContain('next sync');
  });

  it('writes nothing until the rule is confirmed', async () => {
    // The preview is the whole safeguard: a rule is retroactive and silent.
    const { menu, deps } = make();
    await preview(menu, [tx()]);
    expect(deps.writeRules).not.toHaveBeenCalled();
  });

  it('warns how much else a broad pattern would swallow', async () => {
    // "ACH WITHDRAWAL" would retype every ACH withdrawal as a transfer and
    // remove all of it from spending, silently, and backwards.
    const { menu } = make();
    const m = createTransferLearning({
      readRules: async () => [],
      writeRules: vi.fn(),
      countMatches: async () => ({ total: 24, spending: 22 }),
      log: vi.fn(),
    } as any);
    void menu;
    const u = await preview(m, [tx({ description: 'ACH WITHDRAWAL 4471' })]);
    const text = u.edit.mock.calls[0][0];
    expect(text).toContain('*23* other transactions');
    expect(text).toContain('22 of which currently count as spending');
  });

  it('says plainly when the pattern catches only this transaction', async () => {
    const m = createTransferLearning({
      readRules: async () => [],
      writeRules: vi.fn(),
      countMatches: async () => ({ total: 1, spending: 1 }),
      log: vi.fn(),
    } as any);
    const u = await preview(m, [tx()]);
    expect(u.edit.mock.calls[0][0]).toContain('only this transaction');
  });

  it('still offers the rule when the count cannot be read', async () => {
    // No database mount is a supported way to run the companion.
    const m = createTransferLearning({
      readRules: async () => [],
      writeRules: vi.fn(),
      countMatches: async () => { throw new Error('no db'); },
      log: vi.fn(),
    } as any);
    const u = await preview(m, [tx()]);
    expect(u.edit.mock.calls[0][1].inline_keyboard[0][0].text).toContain('Make the rule');
  });

  it('warns when an earlier rule already shadows the new one', async () => {
    // `matchRule` returns the FIRST match, and new rules are appended — so an
    // existing broad rule wins and the button would otherwise look broken.
    const { menu, state } = make([
      { pattern: 'Payment', matchType: 'contains', activityType: 'WITHDRAWAL' },
    ]);
    const u = await teach(menu, [tx()]);
    expect(u.edit.mock.calls[0][0]).toContain('earlier rule');
    // Still written: the user may reorder them, and refusing to save would
    // leave nothing to reorder.
    expect(state.rules).toHaveLength(2);
  });

  it('claims only its own callbacks', async () => {
    const { menu } = make();
    expect(menu.handles('cz:tl:1')).toBe(true);
    expect(menu.handles('cz:tlc:1:0')).toBe(true);
    // The transaction menu's and the Amazon menu's, which must pass through.
    expect(menu.handles('cz:3:2')).toBe(false);
    expect(menu.handles('cz:tlk:1:0')).toBe(true);
    expect(menu.handles('cz:al:1')).toBe(false);
  });

  it('answers rather than hangs when the session outlived a restart', async () => {
    const { menu, deps } = make();
    const u = ui();
    await menu.onCallback({ data: 'cz:tlc:999:0' }, u);
    expect(u.answer).toHaveBeenCalledWith(expect.stringContaining('expired'));
    expect(deps.writeRules).not.toHaveBeenCalled();
  });

  it('never leaves the button spinning when the write fails', async () => {
    const { menu } = make();
    (menu as any);
    const failing = createTransferLearning({
      readRules: async () => [],
      writeRules: async () => { throw new Error('secret write failed'); },
      log: vi.fn(),
    } as any);
    const row = failing.entryButton([tx()])!;
    const token = row[0].callback_data.slice('cz:tl:'.length);
    await failing.onCallback({ data: `cz:tl:${token}` }, ui());
    const u = ui();
    await expect(failing.onCallback({ data: `cz:tlc:${token}:0` }, u)).resolves.toBeUndefined();
    expect(u.answer).toHaveBeenCalled();
  });
  it('offers an undo button on confirmation of a new rule', async () => {
    // The rule takes effect at the next sync, retroactively and silently, so
    // the confirmation itself carries the way back.
    const { menu } = make();
    const u = await teach(menu, [tx()]);
    const button = u.edit.mock.calls[0][1].inline_keyboard[0][0];
    expect(button.text).toContain('Undo');
    expect(button.callback_data.startsWith('cz:tlu:')).toBe(true);
    expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  });

  it('removes exactly the taught rule and leaves existing rules untouched on undo', async () => {
    // Hand-written rules live in the same list and must survive an undo of
    // the one this menu wrote.
    const mine = { pattern: 'Venmo', matchType: 'contains', activityType: 'CREDIT' };
    const { menu, state } = make([mine]);
    const u = await teach(menu, [tx()]);
    const data = u.edit.mock.calls[0][1].inline_keyboard[0][0].callback_data;
    const u2 = ui();
    await menu.onCallback({ data }, u2);
    expect(state.rules).toEqual([mine]);
    expect(u2.answer).toHaveBeenCalledWith('Rule removed');
    expect(u2.edit.mock.calls[0][0]).toContain('Rule removed');
  });

  it('answers that the rule is already gone when undo is tapped twice', async () => {
    // A doubled tap is a safe no-op that says so, with no second write.
    const { menu, deps } = make();
    const u = await teach(menu, [tx()]);
    const data = u.edit.mock.calls[0][1].inline_keyboard[0][0].callback_data;
    await menu.onCallback({ data }, ui());
    const u3 = ui();
    await menu.onCallback({ data }, u3);
    expect(u3.answer).toHaveBeenCalledWith('That rule is already gone');
    expect(deps.writeRules).toHaveBeenCalledTimes(2);
  });

  it('does not offer an undo button when the rule already existed', async () => {
    // Undo there would delete a rule the user wrote earlier, not one this
    // tap created.
    const { menu } = make([
      { pattern: 'Payment to Ccb Credit Card Payments', matchType: 'contains', activityType: 'TRANSFER_OUT' },
    ]);
    const u = await teach(menu, [tx()]);
    expect(u.edit.mock.calls[0][1]).toBeUndefined();
  });

  it('handles an expired session on undo without writing rules', async () => {
    // After a daemon restart the in-memory session is gone; the honest answer
    // is "expired", and nothing must be written on a guess.
    const { menu, deps } = make();
    const u = ui();
    await menu.onCallback({ data: 'cz:tlu:999:0' }, u);
    expect(u.answer).toHaveBeenCalledWith(expect.stringContaining('expired'));
    expect(deps.writeRules).not.toHaveBeenCalled();
  });
});
