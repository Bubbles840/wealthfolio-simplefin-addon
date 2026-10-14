import { describe, it, expect } from 'vitest';
import {
  amazonLabelChange, balanceCorrectionChange, bankUpdateChange, categoryFiledChange, categoryRuleCreatedChange,
  duplicateRemovedChange, importChange, mappingRuleCreatedChange, openingBalanceFiledChange, reversalChange,
  stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange, venmoNoteChange,
  type ChangeDraft, type ChangeEntry,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { txIdFromComment } from './sync-core.js';
import {
  currentRowId, currentRuleId, latestReversal, planChangeUndo, REDO_FROM_TELEGRAM, undoAvailability, undoChangedSince,
  UNDO_ALREADY_UNDONE, UNDO_EXACT_COPY, UNDO_FROM_TELEGRAM, UNDO_LINKED_REFUSAL, UNDO_MAYBE_LINKED, UNDO_NO_KEY, UNDO_NOT_POSSIBLE,
  UNDO_NOT_UNDONE, UNDO_UPDATE_ADDON, UNDO_UPDATE_COMPANION, addonGateCovers, type UndoDecision, type UndoPlan, type UndoRow, type UndoState,
} from './change-undo.js';
import { accountTxKey } from './transfers.js';
import {
  addonUnderstandsVenmoNotes, companionUnderstandsOverrides, companionUnderstandsVenmoNotes, isNewerVersion, SIMPLEFIN_SYNC_VERSION,
  SYNC_OVERRIDES_SINCE, VENMO_NOTE_SINCE,
} from './version.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const CARD = { sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card' };
const KEY = accountTxKey('ACT-1f2e', 'TRN-a1b2');
const CARD_KEY = accountTxKey('ACT-9c8d', 'TRN-a1b2');
const entry = (draft: ChangeDraft, writer: 'addon' | 'companion' = 'companion'): ChangeEntry => stampChange(draft, writer, NOW);
const undo = (e: ChangeEntry, extra: Record<string, unknown> = {}) => entry(reversalChange(e, 'undo', extra), 'addon');
const redo = (e: ChangeEntry, extra: Record<string, unknown> = {}) => entry(reversalChange(e, 'redo', extra), 'addon');
const ok = (d: UndoDecision): UndoPlan => {
  if (!d.ok) throw new Error(`refused: ${d.reason}`);
  return d.plan;
};
const reason = (d: UndoDecision) => (d.ok ? 'planned' : d.reason);
const row = (over: Partial<UndoRow> = {}): UndoRow => ({
  id: 'act-1', accountId: 'wf-checking', type: 'WITHDRAWAL', date: '2026-10-11', absCents: 650, comment: 'SQ *BLUE_BOTTLE · TRN-a1b2', linked: false, ...over,
});

const amazonFiling = entry(categoryFiledChange({
  actor: 'auto', account: CARD, txKey: CARD_KEY, activityId: 'act-amz', description: 'AMAZON MKTPL*2K4', amountCents: -1080,
  before: { categoryId: 'cat-on', categoryName: 'Online Shopping', taxonomyId: 'spending_categories' },
  after: { categoryId: 'cat-pc', categoryName: 'Personal Care', taxonomyId: 'spending_categories' },
  why: 'Amazon: Hair Care',
}));
const telegramFiling = entry(categoryFiledChange({
  actor: 'you', activityId: 'act-5', description: 'VENMO *J SMITH',
  before: null, after: { categoryId: 'cat-din', categoryName: 'Dining', taxonomyId: 'spending_categories' },
}));

describe('the version gate', () => {
  it('opens at the release that obeys overrides, and with no companion at all', () => {
    expect(companionUnderstandsOverrides(SYNC_OVERRIDES_SINCE)).toBe(true);
    expect(companionUnderstandsOverrides('9.0.0')).toBe(true);
    expect(companionUnderstandsOverrides('1.59.2')).toBe(false);
    expect(companionUnderstandsOverrides('garbage')).toBe(false);
    expect(companionUnderstandsOverrides(null)).toBe(true);
  });

  it('is never above the version this build ships as, once it ships past 1.59.2', () => {
    // A release that ships Undo below SYNC_OVERRIDES_SINCE would keep its own
    // companion's undos disabled forever: lower the constant to that release.
    if (isNewerVersion(SIMPLEFIN_SYNC_VERSION, '1.59.2')) {
      expect(isNewerVersion(SYNC_OVERRIDES_SINCE, SIMPLEFIN_SYNC_VERSION)).toBe(false);
    }
  });
});

describe('the Venmo note gate (ruling P3-K)', () => {
  // An add-on or companion older than this reads a `sync_overrides` document that
  // holds `noVenmoNote` as corrupt, and its sync then ignores EVERY override.
  const note = entry(venmoNoteChange({
    account: CHECKING, txKey: KEY, activityId: 'act-v', description: 'VENMO PAYMENT 1023', amountCents: -2500, date: '2026-10-04',
    beforeNote: 'VENMO PAYMENT 1023 · TRN-a1b2', afterNote: 'VENMO PAYMENT 1023 · Venmo: Rent · TRN-a1b2', note: 'Rent',
  }));
  const app = (companionVersion: string | null) => ({ host: 'addon' as const, companionVersion });

  it('is 1.61.0 — raise it to the release that ships Venmo notes — and never below the overrides gate', () => {
    expect(VENMO_NOTE_SINCE).toBe('1.61.0');
    expect(isNewerVersion(SYNC_OVERRIDES_SINCE, VENMO_NOTE_SINCE)).toBe(false);
  });

  it('is never above the version this build ships as, once it ships past 1.60.0', () => {
    // A release below VENMO_NOTE_SINCE would refuse its own Venmo-note undos forever.
    if (isNewerVersion(SIMPLEFIN_SYNC_VERSION, '1.60.0')) {
      expect(isNewerVersion(VENMO_NOTE_SINCE, SIMPLEFIN_SYNC_VERSION)).toBe(false);
    }
  });

  it('a companion understands Venmo notes from that release; no companion at all is fine', () => {
    expect(companionUnderstandsVenmoNotes(VENMO_NOTE_SINCE)).toBe(true);
    expect(companionUnderstandsVenmoNotes('9.0.0')).toBe(true);
    expect(companionUnderstandsVenmoNotes('1.60.0')).toBe(false);
    expect(companionUnderstandsVenmoNotes('garbage')).toBe(false);
    expect(companionUnderstandsVenmoNotes(null)).toBe(true);
  });

  it('an installed add-on understands them from that release; an unknown one does not', () => {
    expect(addonUnderstandsVenmoNotes(VENMO_NOTE_SINCE)).toBe(true);
    expect(addonUnderstandsVenmoNotes('9.0.0')).toBe(true);
    expect(addonUnderstandsVenmoNotes('1.60.0')).toBe(false);
    expect(addonUnderstandsVenmoNotes('garbage')).toBe(false);
    expect(addonUnderstandsVenmoNotes(null)).toBe(false);
  });

  it('the app waits for a companion that new before a Venmo note’s Undo; its Redo and other kinds are unchanged', () => {
    expect(undoAvailability(note, app('1.60.0'))).toEqual({ kind: 'update-companion', op: 'undo', text: UNDO_UPDATE_COMPANION });
    expect(undoAvailability(note, app(VENMO_NOTE_SINCE))).toEqual({ kind: 'ready', op: 'undo' });
    expect(undoAvailability(note, app(null))).toEqual({ kind: 'ready', op: 'undo' });
    expect(undoAvailability({ ...note, undone: { by: 'a1', at: NOW.toISOString() } }, app('1.60.0'))).toEqual({ kind: 'ready', op: 'redo' });
    const label = entry(amazonLabelChange({
      account: CHECKING, txKey: KEY, activityId: 'act-amz', description: 'AMAZON.COM*MB3T81', amountCents: -2118, date: '2026-08-06',
      beforeNote: 'AMAZON.COM*MB3T81 · TRN-a1b2', afterNote: 'AMAZON.COM*MB3T81 · Amazon: Lawn · TRN-a1b2', label: 'Lawn',
    }));
    expect(undoAvailability(label, app('1.60.0'))).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('the companion’s Undo and Redo of a Venmo note — and nothing else — wait for the add-on, in its update-first words', () => {
    expect(addonGateCovers(note)).toBe(true);
    expect(addonGateCovers(telegramFiling)).toBe(false);
    expect(addonGateCovers(amazonFiling)).toBe(false);
    // A companion that cannot see the add-ons directory still points somewhere that works (P3-L).
    expect(UNDO_UPDATE_ADDON).toBe("Update the add-on first — or undo it from the app's Change log.");
  });
});

describe('undoAvailability', () => {
  const link = entry(transferLinkChange(
    { account: CHECKING, txKey: KEY, description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1', newActivityId: 'n1' },
    { account: CARD, txKey: CARD_KEY, description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2', newActivityId: 'n2' },
  ));
  const app = (companionVersion: string | null) => ({ host: 'addon' as const, companionVersion });

  it('an old companion disables a sync decision’s Undo in the app, with the exact copy', () => {
    expect(undoAvailability(link, app('1.59.2'))).toEqual({ kind: 'update-companion', op: 'undo', text: 'Update the companion first' });
    expect(UNDO_UPDATE_COMPANION).toBe('Update the companion first');
    expect(undoAvailability(link, app(SYNC_OVERRIDES_SINCE))).toEqual({ kind: 'ready', op: 'undo' });
    // Telegram runs in the companion, which is new by definition.
    expect(undoAvailability(link, { host: 'companion', companionVersion: '1.59.2' })).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('a Redo, and an undo that sets no override, never wait for the companion', () => {
    const undone: ChangeLogItem = { ...link, undone: { by: 'a1', at: NOW.toISOString() } };
    expect(undoAvailability(undone, app('1.59.2'))).toEqual({ kind: 'ready', op: 'redo' });
    const yours = entry(balanceCorrectionChange({
      account: CHECKING, actor: 'you', activityId: 'plug-1', amountCents: 215, date: '2026-10-12', activityType: 'CREDIT', comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
    }));
    expect(undoAvailability(yours, app('1.59.2'))).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('points category and rule entries at Telegram in the app, only when a companion runs', () => {
    expect(undoAvailability(telegramFiling, app('1.61.0'))).toEqual({ kind: 'telegram', op: 'undo', text: UNDO_FROM_TELEGRAM });
    expect(undoAvailability({ ...telegramFiling, undone: { by: 'c', at: NOW.toISOString() } }, app('1.61.0')))
      .toEqual({ kind: 'telegram', op: 'redo', text: REDO_FROM_TELEGRAM });
    expect(undoAvailability(telegramFiling, app(null))).toEqual({ kind: 'none' });
    expect(undoAvailability(telegramFiling, { host: 'companion', companionVersion: null })).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('offers nothing for bank changes, bookkeeping, or an undo entry itself', () => {
    const update = entry(bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1,
      before: { absCents: 1, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
    }));
    expect(undoAvailability(update, app(null))).toEqual({ kind: 'none' });
    expect(undoAvailability(undo(telegramFiling), { host: 'companion', companionVersion: null })).toEqual({ kind: 'none' });
  });
});

describe('the reversal entry and what it leaves behind', () => {
  it('points back at the entry, swaps before and after on an undo, and carries the row it left', () => {
    const plug = entry(balanceCorrectionChange({
      account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
      comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
    }));
    const u = reversalChange(plug, 'undo', { activityId: undefined });
    expect(u).toMatchObject({ actor: 'you', kind: 'balance-correction', reverses: { id: plug.id, op: 'undo' }, undoable: false, summary: 'Undid: Added a balance correction' });
    expect(u.before).toEqual(plug.after);
    const r = reversalChange(plug, 'redo', { activityId: 'plug-2' });
    expect(r.after).toMatchObject({ activityId: 'plug-2', amountCents: -215 });
    expect(r.summary).toBe('Redid: Added a balance correction');
  });

  it('finds the newest reversal and the row and rule it left', () => {
    const plug = entry(balanceCorrectionChange({
      account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT', comment: 'c',
    }));
    const u = undo(plug, { activityId: undefined });
    const r = redo(plug, { activityId: 'plug-2' });
    expect(latestReversal([r, u, plug], plug.id)).toBe(r);
    expect(latestReversal([plug], plug.id)).toBeNull();
    expect(currentRowId(plug, null)).toBe('plug-1');
    expect(currentRowId(plug, u)).toBeNull();
    expect(currentRowId(plug, r)).toBe('plug-2');
    const rule = entry(categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: X', pattern: 'X', categoryId: 'c', categoryName: 'G' }));
    expect(currentRuleId(rule, null)).toBe('rule-7');
    expect(currentRuleId(rule, undo(rule, { ruleId: null }))).toBeNull();
    expect(currentRuleId(rule, redo(rule, { ruleId: 'rule-8' }))).toBe('rule-8');
  });
});

describe('planChangeUndo — state checks first', () => {
  it('refuses an undo of a filing the person re-filed since, and plans nothing', () => {
    const d = planChangeUndo(amazonFiling, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro' }] }, { latest: null });
    expect(d).toEqual({ ok: false, reason: 'It has changed since — nothing was undone.' });
    expect(undoChangedSince('redo')).toBe('It has changed since — nothing was redone.');
  });

  it('refuses to undo twice, or to redo what was never undone', () => {
    expect(reason(planChangeUndo(telegramFiling, 'undo', {}, { latest: undo(telegramFiling) }))).toBe(UNDO_ALREADY_UNDONE);
    expect(reason(planChangeUndo(telegramFiling, 'redo', {}, { latest: null }))).toBe(UNDO_NOT_UNDONE);
    expect(reason(planChangeUndo(telegramFiling, 'redo', {}, { latest: redo(telegramFiling) }))).toBe(UNDO_NOT_UNDONE);
  });

  it('refuses what is not undoable', () => {
    const update = entry(bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1,
      before: { absCents: 1, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
    }));
    expect(reason(planChangeUndo(update, 'undo', {}, { latest: null }))).toBe(UNDO_NOT_POSSIBLE);
  });
});

describe('planChangeUndo — categories', () => {
  it('an automatic filing: noAutoFile first, then the rule’s category back', () => {
    const p = ok(planChangeUndo(amazonFiling, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-pc' }] }, { latest: null }));
    expect(p.steps).toEqual([
      { do: 'set-tx', txKey: CARD_KEY, flag: 'noAutoFile', label: 'AMAZON MKTPL*2K4 · Citi Card' },
      { do: 'unassign', activityId: 'act-amz', taxonomyId: 'spending_categories' },
      { do: 'assign', activityId: 'act-amz', taxonomyId: 'spending_categories', categoryId: 'cat-on' },
    ]);
    expect(p).toMatchObject({ needsSync: false, rowAfter: 'act-amz', done: 'Undone — filed under Online Shopping.' });
    const r = ok(planChangeUndo(amazonFiling, 'redo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-on' }] }, { latest: undo(amazonFiling) }));
    expect(r.steps).toEqual([
      { do: 'clear-tx', txKey: CARD_KEY, flag: 'noAutoFile' },
      { do: 'unassign', activityId: 'act-amz', taxonomyId: 'spending_categories' },
      { do: 'assign', activityId: 'act-amz', taxonomyId: 'spending_categories', categoryId: 'cat-pc' },
    ]);
  });

  it('an automatic filing with no tx key uses one the runner derived, or refuses', () => {
    const keyless = entry({ ...categoryFiledChange({
      actor: 'auto', activityId: 'act-amz', description: 'AMAZON', before: null, after: { categoryId: 'cat-pc', categoryName: 'Personal Care' },
    }) });
    const filed = { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-pc' }] };
    expect(reason(planChangeUndo(keyless, 'undo', filed, { latest: null }))).toBe(UNDO_NO_KEY);
    expect(ok(planChangeUndo(keyless, 'undo', { ...filed, txKey: CARD_KEY }, { latest: null })).steps[0]).toMatchObject({ do: 'set-tx', txKey: CARD_KEY });
  });

  it('your filing has no override, and takes the category off', () => {
    const p = ok(planChangeUndo(telegramFiling, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-din' }] }, { latest: null }));
    expect(p.steps).toEqual([{ do: 'unassign', activityId: 'act-5', taxonomyId: 'spending_categories' }]);
    expect(p.done).toBe('Undone — no category.');
    expect(reason(planChangeUndo(telegramFiling, 'redo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-x' }] }, { latest: undo(telegramFiling) })))
      .toBe('It has changed since — nothing was redone.');
  });

  it('the undo of a move restores the complete prior state, every taxonomy', () => {
    const move = entry(categoryFiledChange({
      actor: 'you', activityId: 'act-6', description: 'GRANT',
      before: { categoryId: 'inc-1', categoryName: 'Grants', taxonomyId: 'income_categories' },
      after: { categoryId: 'cat-gro', categoryName: 'Groceries', taxonomyId: 'spending_categories' },
      restore: [{ taxonomyId: 'income_categories', categoryId: 'inc-1' }],
    }));
    const p = ok(planChangeUndo(move, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro' }] }, { latest: null }));
    expect(p.steps).toEqual([
      { do: 'unassign', activityId: 'act-6', taxonomyId: 'spending_categories' },
      { do: 'assign', activityId: 'act-6', taxonomyId: 'income_categories', categoryId: 'inc-1' },
    ]);
  });

  it('redo of a cross-taxonomy move checks the state the undo restored, then re-applies the move', () => {
    const move = entry(categoryFiledChange({
      actor: 'you', activityId: 'act-6', description: 'GRANT',
      before: { categoryId: 'inc-1', categoryName: 'Grants', taxonomyId: 'income_categories' },
      after: { categoryId: 'cat-gro', categoryName: 'Groceries', taxonomyId: 'spending_categories' },
      restore: [{ taxonomyId: 'income_categories', categoryId: 'inc-1' }],
    }));
    const restored = { assignments: [{ taxonomyId: 'income_categories', categoryId: 'inc-1' }] };
    const p = ok(planChangeUndo(move, 'redo', restored, { latest: undo(move) }));
    expect(p.steps).toEqual([
      { do: 'unassign', activityId: 'act-6', taxonomyId: 'income_categories' },
      { do: 'assign', activityId: 'act-6', taxonomyId: 'spending_categories', categoryId: 'cat-gro' },
    ]);
    expect(p.done).toBe('Redone — filed under Groceries.');
    expect(reason(planChangeUndo(move, 'redo', { assignments: [{ taxonomyId: 'income_categories', categoryId: 'inc-2' }] }, { latest: undo(move) })))
      .toBe('It has changed since — nothing was redone.');
    expect(reason(planChangeUndo(move, 'redo', { assignments: [] }, { latest: undo(move) })))
      .toBe('It has changed since — nothing was redone.');
  });

  it('an opening-balance filing: the account’s noOpeningFile, then the category off', () => {
    const opening = entry(openingBalanceFiledChange({
      account: CARD, activityId: 'sb-1', amountCents: -46460, date: '2026-06-18',
      category: { categoryId: 'cat-open', categoryName: 'Opening balances', taxonomyId: 'spending_categories' },
    }));
    const p = ok(planChangeUndo(opening, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-open' }] }, { latest: null }));
    expect(p.steps).toEqual([
      { do: 'set-account', sfinId: 'ACT-9c8d', flag: 'noOpeningFile', label: 'Citi Card' },
      { do: 'unassign', activityId: 'sb-1', taxonomyId: 'spending_categories' },
    ]);
    const r = ok(planChangeUndo(opening, 'redo', { assignments: [] }, { latest: undo(opening) }));
    expect(r.steps).toEqual([
      { do: 'clear-account', sfinId: 'ACT-9c8d', flag: 'noOpeningFile' },
      { do: 'assign', activityId: 'sb-1', taxonomyId: 'spending_categories', categoryId: 'cat-open' },
    ]);
  });
});

describe('planChangeUndo — rules', () => {
  const rule = entry(categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries' }));

  it('Undo rule deletes it; Undo rule + un-file also takes its charges out', () => {
    expect(ok(planChangeUndo(rule, 'undo', { rule: { id: 'rule-7' } }, { latest: null })).steps).toEqual([{ do: 'delete-rule', ruleId: 'rule-7' }]);
    const p = ok(planChangeUndo(rule, 'undo', { rule: { id: 'rule-7' }, ruleFiled: ['a1', 'a2'] }, { latest: null, variant: 'unfile' }));
    expect(p.steps).toEqual([
      { do: 'delete-rule', ruleId: 'rule-7' },
      { do: 'unassign', activityId: 'a1', taxonomyId: 'spending_categories' },
      { do: 'unassign', activityId: 'a2', taxonomyId: 'spending_categories' },
    ]);
    expect(p).toMatchObject({ ruleAfter: null, done: 'Undone — the rule is gone and 2 charges are back in the needs-a-category list.' });
  });

  it('refuses a rule already gone, and a redo of a rule already back', () => {
    expect(reason(planChangeUndo(rule, 'undo', { rule: null }, { latest: null }))).toBe('That rule is already gone.');
    expect(reason(planChangeUndo(rule, 'redo', { rule: { id: 'rule-9' } }, { latest: undo(rule) }))).toBe('That rule is already there.');
    expect(ok(planChangeUndo(rule, 'redo', { rule: null }, { latest: undo(rule) })).steps)
      .toEqual([{ do: 'create-rule', rule: { name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro' } }]);
  });

  it('a rule for one account is deleted by id like any other, and comes back for that account (3)', () => {
    const scoped = entry(categoryRuleCreatedChange({
      ruleId: 'rule-8', name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', categoryId: 'cat-rent', categoryName: 'Rent',
      account: { wfId: 'wf-checking', name: 'Checking' },
    }));
    expect(ok(planChangeUndo(scoped, 'undo', { rule: { id: 'rule-8' } }, { latest: null })).steps).toEqual([{ do: 'delete-rule', ruleId: 'rule-8' }]);
    expect(ok(planChangeUndo(scoped, 'redo', { rule: null }, { latest: undo(scoped) })).steps)
      .toEqual([{ do: 'create-rule', rule: { name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', categoryId: 'cat-rent', accountId: 'wf-checking' } }]);
  });

  it('a transaction rule comes out of mapping_rules and goes back, and the next sync retypes', () => {
    const mapping = entry(mappingRuleCreatedChange({ rule: { pattern: 'Payment to Ccb', matchType: 'contains', activityType: 'TRANSFER_OUT' } }));
    const r = { pattern: 'Payment to Ccb', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
    expect(ok(planChangeUndo(mapping, 'undo', { mappingRules: [r] }, { latest: null }))).toMatchObject({ needsSync: true, steps: [{ do: 'mapping-remove', rule: r }] });
    expect(reason(planChangeUndo(mapping, 'undo', { mappingRules: [] }, { latest: null }))).toBe('That transaction rule is already gone.');
    expect(ok(planChangeUndo(mapping, 'redo', { mappingRules: [] }, { latest: undo(mapping) })).steps).toEqual([{ do: 'mapping-add', rule: r }]);
    expect(reason(planChangeUndo(mapping, 'redo', { mappingRules: [r] }, { latest: undo(mapping) }))).toBe('That transaction rule is already there.');
  });
});

describe('planChangeUndo — sync decisions', () => {
  const link = entry(transferLinkChange(
    { account: CHECKING, txKey: KEY, description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1', newActivityId: 'n1' },
    { account: CARD, txKey: CARD_KEY, description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2', newActivityId: 'n2' },
  ));

  it('a link: notTransfer on both legs, then a sync; a redo clears both', () => {
    const p = ok(planChangeUndo(link, 'undo', {}, { latest: null }));
    // Each leg's override is named by that leg's own bank text.
    expect(p.steps).toEqual([
      { do: 'set-tx', txKey: KEY, flag: 'notTransfer', label: 'CITI AUTOPAY · Checking' },
      { do: 'set-tx', txKey: CARD_KEY, flag: 'notTransfer', label: 'PAYMENT THANK YOU · Citi Card' },
    ]);
    expect(p).toMatchObject({ needsSync: true, done: 'Undone — the next sync counts each half as spending or money in.' });
    expect(ok(planChangeUndo(link, 'redo', {}, { latest: undo(link) })).steps).toEqual([
      { do: 'clear-tx', txKey: KEY, flag: 'notTransfer' },
      { do: 'clear-tx', txKey: CARD_KEY, flag: 'notTransfer' },
    ]);
  });

  it('a link logged before legs carried their own text: the in-leg is named from the summary', () => {
    const legacy: ChangeEntry = {
      ...link,
      after: { ...(link.after as Record<string, unknown>), legs: (link.after as { legs: Array<Record<string, unknown>> }).legs.map(({ description: _d, ...l }) => l) },
    };
    expect(ok(planChangeUndo(legacy, 'undo', {}, { latest: null })).steps).toEqual([
      { do: 'set-tx', txKey: KEY, flag: 'notTransfer', label: 'CITI AUTOPAY · Checking' },
      { do: 'set-tx', txKey: CARD_KEY, flag: 'notTransfer', label: 'PAYMENT THANK YOU · Citi Card' },
    ]);
  });

  it('a held transfer: notTransfer on that one leg', () => {
    const held = entry(transferTypeChange({
      account: CHECKING, txKey: KEY, activityId: 'ph-1', description: 'Online Transfer to Savings', amountCents: -130000, date: '2026-10-11',
      activityType: 'TRANSFER_OUT', previousType: null, held: true,
    }));
    expect(ok(planChangeUndo(held, 'undo', {}, { latest: null }))).toMatchObject({
      needsSync: true, done: 'Undone — the next sync counts it as spending or money in.',
      steps: [{ do: 'set-tx', txKey: KEY, flag: 'notTransfer', label: 'Online Transfer to Savings · Checking' }],
    });
  });

  const dup = entry(duplicateRemovedChange({
    account: CHECKING, txKey: KEY, activityId: 'act-dup', description: 'TRADER JOE S #628', amountCents: -2120, date: '2026-08-06',
    payload: { accountId: 'wf-checking', activityType: 'WITHDRAWAL', activityDate: '2026-08-06', symbol: { symbol: '$CASH-USD' }, amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · TRN-a1b2' },
  }));

  it('a removed duplicate: keepDuplicate first, then the copy back; a copy already back is only kept', () => {
    const p = ok(planChangeUndo(dup, 'undo', { row: null }, { latest: null }));
    expect(p.steps.map((s) => s.do)).toEqual(['set-tx', 'create']);
    expect(p).toMatchObject({ rowAfter: 'created', needsSync: false });
    const again = ok(planChangeUndo(dup, 'undo', { row: row({ id: 'copy-1' }) }, { latest: redo(dup, { activityId: 'copy-1' }) }));
    expect(again.steps).toEqual([{ do: 'set-tx', txKey: KEY, flag: 'keepDuplicate', label: 'TRADER JOE S #628 · Checking' }]);
    expect(again.rowAfter).toBe('copy-1');
    expect(ok(planChangeUndo(dup, 'redo', {}, { latest: undo(dup, { activityId: 'copy-1' }) }))).toMatchObject({
      needsSync: true, rowAfter: 'copy-1', steps: [{ do: 'clear-tx', txKey: KEY, flag: 'keepDuplicate' }],
    });
    expect(UNDO_EXACT_COPY).toBe('Wealthfolio refused it as an exact copy of a transaction it already has — nothing changed.');
  });

  const imported = entry(importChange({
    account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
  }));

  it('an import: onto the skip list, then the row removed; a linked row is refused', () => {
    expect(ok(planChangeUndo(imported, 'undo', { row: row() }, { latest: null })).steps).toEqual([
      { do: 'skip', account: 'ACT-1f2e', txId: 'TRN-a1b2' },
      { do: 'delete', activityId: 'act-1' },
    ]);
    expect(reason(planChangeUndo(imported, 'undo', { row: row({ linked: 'confirmed' }) }, { latest: null }))).toBe(UNDO_LINKED_REFUSAL);
    expect(UNDO_LINKED_REFUSAL).toBe('Undo the transfer link first.');
    expect(reason(planChangeUndo(imported, 'undo', { row: row({ type: 'TRANSFER_OUT', linked: 'maybe' }) }, { latest: null }))).toBe(UNDO_MAYBE_LINKED);
    expect(ok(planChangeUndo(imported, 'undo', { row: null }, { latest: null })).steps).toEqual([{ do: 'skip', account: 'ACT-1f2e', txId: 'TRN-a1b2' }]);
    expect(ok(planChangeUndo(imported, 'redo', {}, { latest: undo(imported) }))).toMatchObject({
      needsSync: true, steps: [{ do: 'unskip', account: 'ACT-1f2e', txId: 'TRN-a1b2' }],
    });
  });

  const label = entry(amazonLabelChange({
    account: CARD, txKey: CARD_KEY, activityId: 'act-4', description: 'AMAZON MKTPL*2K4', amountCents: -1080, date: '2026-09-15',
    beforeNote: 'AMAZON MKTPL*2K4 · TRN-a1b2', afterNote: 'AMAZON MKTPL*2K4 · Amazon: Hair Care · TRN-a1b2', label: 'Hair Care',
  }));

  it('an Amazon label: noAmazonLabel, then the old note back; a changed or linked note is refused', () => {
    const labelled = row({ id: 'act-4', accountId: 'wf-citi', absCents: 1080, date: '2026-09-15', comment: 'AMAZON MKTPL*2K4 · Amazon: Hair Care · TRN-a1b2' });
    expect(ok(planChangeUndo(label, 'undo', { row: labelled, currency: 'USD' }, { latest: null })).steps).toEqual([
      { do: 'set-tx', txKey: CARD_KEY, flag: 'noAmazonLabel', label: 'AMAZON MKTPL*2K4 · Citi Card' },
      { do: 'update', write: { id: 'act-4', accountId: 'wf-citi', activityType: 'WITHDRAWAL', activityDate: '2026-09-15T12:00:00Z', amount: 10.8, currency: 'USD', comment: 'AMAZON MKTPL*2K4 · TRN-a1b2' } },
    ]);
    expect(reason(planChangeUndo(label, 'undo', { row: { ...labelled, comment: 'edited by hand' } }, { latest: null }))).toBe('It has changed since — nothing was undone.');
    expect(reason(planChangeUndo(label, 'undo', { row: { ...labelled, linked: 'confirmed' } }, { latest: null }))).toBe(UNDO_LINKED_REFUSAL);
    expect(reason(planChangeUndo(label, 'undo', { row: { ...labelled, linked: 'maybe' } }, { latest: null }))).toBe(UNDO_MAYBE_LINKED);
    expect(reason(planChangeUndo(label, 'undo', { row: null }, { latest: null }))).toBe('That transaction is gone — nothing was undone.');
    expect(ok(planChangeUndo(label, 'redo', {}, { latest: undo(label, { activityId: 'act-4' }) }))).toMatchObject({
      needsSync: true, rowAfter: 'act-4', steps: [{ do: 'clear-tx', txKey: CARD_KEY, flag: 'noAmazonLabel' }],
    });
  });

  const venmo = entry(venmoNoteChange({
    account: CHECKING, txKey: KEY, activityId: 'act-6', description: 'VENMO PAYMENT 1023', amountCents: -2500, date: '2026-10-04',
    beforeNote: 'VENMO PAYMENT 1023 · TRN-a1b2', afterNote: 'VENMO PAYMENT 1023 · Venmo: Rent October · TRN-a1b2', note: 'Rent October',
  }));

  it('a Venmo note: noVenmoNote first, then the old note back; a changed, linked or gone row is refused', () => {
    const noted = row({ id: 'act-6', absCents: 2500, date: '2026-10-04', comment: 'VENMO PAYMENT 1023 · Venmo: Rent October · TRN-a1b2' });
    const plan = ok(planChangeUndo(venmo, 'undo', { row: noted, currency: 'USD' }, { latest: null }));
    expect(plan).toMatchObject({ needsSync: false, rowAfter: 'act-6', done: 'Undone — the note is off, and stays off.' });
    expect(plan.steps).toEqual([
      { do: 'set-tx', txKey: KEY, flag: 'noVenmoNote', label: 'VENMO PAYMENT 1023 · Checking' },
      { do: 'update', write: { id: 'act-6', accountId: 'wf-checking', activityType: 'WITHDRAWAL', activityDate: '2026-10-04T12:00:00Z', amount: 25, currency: 'USD', comment: 'VENMO PAYMENT 1023 · TRN-a1b2' } },
    ]);
    expect(reason(planChangeUndo(venmo, 'undo', { row: { ...noted, comment: 'edited by hand' } }, { latest: null }))).toBe('It has changed since — nothing was undone.');
    expect(reason(planChangeUndo(venmo, 'undo', { row: { ...noted, linked: 'confirmed' } }, { latest: null }))).toBe(UNDO_LINKED_REFUSAL);
    expect(reason(planChangeUndo(venmo, 'undo', { row: { ...noted, linked: 'maybe' } }, { latest: null }))).toBe(UNDO_MAYBE_LINKED);
    const keyless = { ...venmo, subject: { ...venmo.subject, txKeys: [] } };
    expect(reason(planChangeUndo(keyless, 'undo', { row: noted }, { latest: null }))).toBe(UNDO_NO_KEY);
    expect(reason(planChangeUndo(venmo, 'undo', { row: null }, { latest: null }))).toBe('That transaction is gone — nothing was undone.');
    expect(ok(planChangeUndo(venmo, 'redo', {}, { latest: undo(venmo, { activityId: 'act-6' }) }))).toMatchObject({
      needsSync: true, rowAfter: 'act-6', done: 'Redone — the next sync adds the note again.',
      steps: [{ do: 'clear-tx', txKey: KEY, flag: 'noVenmoNote' }],
    });
  });

  it('a Venmo note on a pending row undoes to exactly the old note, tx id intact', () => {
    const pending = entry(venmoNoteChange({
      account: CHECKING, txKey: KEY, activityId: 'act-6', description: 'VENMO PAYMENT 1023', amountCents: -2500, date: '2026-10-04',
      beforeNote: 'VENMO PAYMENT 1023 · TRN-a1b2 · pending', afterNote: 'VENMO PAYMENT 1023 · Venmo: Rent October · TRN-a1b2 · pending', note: 'Rent October',
    }));
    const noted = row({ id: 'act-6', absCents: 2500, date: '2026-10-04', comment: 'VENMO PAYMENT 1023 · Venmo: Rent October · TRN-a1b2 · pending' });
    const plan = ok(planChangeUndo(pending, 'undo', { row: noted, currency: 'USD' }, { latest: null }));
    const written = (plan.steps[1] as { write: { comment: string } }).write.comment;
    expect(written).toBe('VENMO PAYMENT 1023 · TRN-a1b2 · pending');
    expect(txIdFromComment(written)).toBe('TRN-a1b2');
  });

  it('a Venmo note is a sync decision: an old companion disables its Undo in the app', () => {
    expect(undoAvailability(venmo, { host: 'addon', companionVersion: '1.59.2' })).toEqual({ kind: 'update-companion', op: 'undo', text: 'Update the companion first' });
  });

  const plug = entry(balanceCorrectionChange({
    account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
    comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
  }));

  it('an automatic correction: noAutoCorrect first, then the row removed; a redo puts it back at the same amount', () => {
    const there = row({ id: 'plug-1', absCents: 215, comment: 'Balance adjustment · ACT-1f2e · 2026-10-12' });
    expect(ok(planChangeUndo(plug, 'undo', { row: there }, { latest: null })).steps).toEqual([
      { do: 'set-account', sfinId: 'ACT-1f2e', flag: 'noAutoCorrect', label: 'Checking' },
      { do: 'delete', activityId: 'plug-1' },
    ]);
    expect(reason(planChangeUndo(plug, 'undo', { row: { ...there, absCents: 300 } }, { latest: null }))).toBe('It has changed since — nothing was undone.');
    expect(reason(planChangeUndo(plug, 'undo', { row: null }, { latest: null }))).toBe('That correction is gone — nothing was undone.');
    const r = ok(planChangeUndo(plug, 'redo', { row: null, currency: 'USD' }, { latest: undo(plug, { activityId: undefined }) }));
    expect(r.steps).toEqual([
      { do: 'clear-account', sfinId: 'ACT-1f2e', flag: 'noAutoCorrect' },
      { do: 'import', row: {
        accountId: 'wf-checking', sourceSystem: 'simplefin', activityType: 'TRANSFER_OUT', date: '2026-10-12', symbol: '$CASH-USD',
        amount: 2.15, fee: 0, currency: 'USD', comment: 'Balance adjustment · ACT-1f2e · 2026-10-12', isValid: true, isDraft: false,
      } },
    ]);
    expect(r.rowAfter).toBe('created');
  });
});

describe('planChangeUndo — starting balances', () => {
  const sb = entry(startingBalanceChange({
    account: CARD, activityId: 'sb-1', amountCents: -46460, date: '2026-06-18', activityType: 'WITHDRAWAL', comment: 'Starting balance · ACT-9c8d',
  }));

  it('a new starting balance comes out, and goes back in, warning about the bank', () => {
    const there = row({ id: 'sb-1', accountId: 'wf-citi', absCents: 46460, date: '2026-06-18', comment: 'Starting balance · ACT-9c8d' });
    const p = ok(planChangeUndo(sb, 'undo', { row: there }, { latest: null }));
    expect(p.steps).toEqual([{ do: 'delete', activityId: 'sb-1' }]);
    expect(p.done).toBe("Undone — the starting balance is gone, so the account may no longer match the bank's balance.");
    expect(reason(planChangeUndo(sb, 'redo', { startingBalanceId: 'sb-9' }, { latest: undo(sb) }))).toBe('This account has a starting balance again.');
    expect(ok(planChangeUndo(sb, 'redo', { startingBalanceId: null, currency: 'USD' }, { latest: undo(sb) })).steps[0]).toMatchObject({
      do: 'import', row: { accountId: 'wf-citi', activityType: 'WITHDRAWAL', date: '2026-06-18', amount: 464.6, comment: 'Starting balance · ACT-9c8d' },
    });
  });

  it('a moved starting balance goes back to its old amount and date, only if it still reads as moved', () => {
    const moved = entry(startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 80000, date: '2026-04-22', activityType: 'CREDIT' },
    }));
    const now = row({ id: 'sb-2', type: 'CREDIT', absCents: 80000, date: '2026-04-22', comment: 'Starting balance · ACT-1f2e' });
    expect(ok(planChangeUndo(moved, 'undo', { row: now, currency: 'USD' }, { latest: null })).steps).toEqual([{
      do: 'update',
      write: { id: 'sb-2', accountId: 'wf-checking', activityType: 'CREDIT', activityDate: '2026-06-19', amount: 1200, currency: 'USD', comment: 'Starting balance · ACT-1f2e' },
    }]);
    expect(reason(planChangeUndo(moved, 'undo', { row: { ...now, date: '2026-04-01' } }, { latest: null }))).toBe('It has changed since — nothing was undone.');
    expect(ok(planChangeUndo(moved, 'redo', { row: { ...now, absCents: 120000, date: '2026-06-19' }, currency: 'USD' }, { latest: undo(moved, { activityId: 'sb-2' }) })).steps[0])
      .toMatchObject({ do: 'update', write: { activityDate: '2026-04-22', amount: 800 } });
  });
});

describe('every undoable kind has a planner', () => {
  it('no kind marked undoable falls through to "can\'t be undone"', () => {
    const state: UndoState = {
      row: row(), assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-pc' }], rule: { id: 'rule-7' },
      mappingRules: [{ pattern: 'P', matchType: 'contains', activityType: 'TRANSFER_OUT' }], currency: 'USD',
    };
    const entries: ChangeEntry[] = [
      amazonFiling,
      entry(categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'n', pattern: 'p', categoryId: 'c', categoryName: 'G' })),
      entry(mappingRuleCreatedChange({ rule: { pattern: 'P', matchType: 'contains', activityType: 'TRANSFER_OUT' } })),
    ];
    for (const e of entries) expect(reason(planChangeUndo(e, 'undo', state, { latest: null }))).not.toBe(UNDO_NOT_POSSIBLE);
  });
});
