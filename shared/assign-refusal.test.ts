import { describe, it, expect } from 'vitest';
import { assignRefusalOf } from './cash-flow-bucket.js';
import { assignFailureText, ASSIGN_FAILED_TEXT, REFILE_ASSIGN_FAILED_TEXT, UNDO_ASSIGN_FAILED_TEXT } from './categorize-menu.js';

describe('a refused assignment (W9)', () => {
  it.each([
    ['assignActivityCategory failed: 400 - Neutral transfers cannot be categorized. Change or unlink the transfer if it should count as spending.', 'neutral'],
    ['assignActivityCategory failed: 400 - Income activities can only use income categories. Categories label the cash-flow bucket; they do not change it.', 'wrong-bucket'],
    ['assignActivityCategory failed: 400 - Spending activities can only use spending categories. Categories label the cash-flow bucket; they do not change it.', 'wrong-bucket'],
    ['assignActivityCategory failed: 400 - Activity account is not opted into spending tracking', 'scope'],
    ['assignActivityCategory failed: 400 - Activity account does not support spending tracking', 'scope'],
    ['assignActivityCategory failed: 400 - Spending tracking is disabled', 'off'],
    ['assignActivityCategory failed: 403 - Forbidden', null],
    ['fetch failed', null],
  ])('reads "%s" as %s', (message, reason) => {
    expect(assignRefusalOf(message)).toBe(reason);
  });

  it('leads with what did not happen and adds the reason in its own words — never Wealthfolio’s', () => {
    const raw = 'assignActivityCategory failed: 400 - Income activities can only use income categories. Categories label the cash-flow bucket; they do not change it.';
    expect(assignFailureText(ASSIGN_FAILED_TEXT, raw)).toBe(
      "Couldn't file that — Wealthfolio didn't take it, so it still has no category.\nIt is recorded as money in and can only take an income category while that is true.",
    );
    expect(assignFailureText(REFILE_ASSIGN_FAILED_TEXT, 'socket hang up')).toBe("Couldn't move that — Wealthfolio didn't take the new category.");
    expect(assignFailureText(UNDO_ASSIGN_FAILED_TEXT, '500')).toBe("Couldn't undo that — Wealthfolio didn't take the old category back.");
    for (const lead of [ASSIGN_FAILED_TEXT, REFILE_ASSIGN_FAILED_TEXT, UNDO_ASSIGN_FAILED_TEXT]) {
      expect(assignFailureText(lead, raw)).not.toMatch(/Income activities|Categories label/);
    }
  });

  it('PB-G: the wrong-bucket line says money in or money out, as Wealthfolio named the bucket', () => {
    const income = 'assignActivityCategory failed: 400 - Income activities can only use income categories. Categories label the cash-flow bucket; they do not change it.';
    const spending = 'assignActivityCategory failed: 400 - Spending activities can only use spending categories. Categories label the cash-flow bucket; they do not change it.';
    expect(assignFailureText(ASSIGN_FAILED_TEXT, income)).toContain('It is recorded as money in and can only take an income category while that is true.');
    const out = assignFailureText(ASSIGN_FAILED_TEXT, spending);
    expect(out).toContain('It is recorded as money out and can only take a spending category while that is true.');
    expect(out).not.toContain('money in');
    expect(out).not.toMatch(/Spending activities|Categories label/);
  });

  it('PB-G: a bucket the add-on does not name (Saving) gets a neutral line, never "money in"', () => {
    const saving = 'assignActivityCategory failed: 400 - Saving activities can only use savings categories. Categories label the cash-flow bucket; they do not change it.';
    const out = assignFailureText(ASSIGN_FAILED_TEXT, saving);
    expect(out).toContain('Wealthfolio counts it as a different kind of money, so that category does not fit it.');
    expect(out).not.toMatch(/money in|money out|Saving activities/);
  });
});
