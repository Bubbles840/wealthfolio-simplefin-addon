import { describe, it, expect } from 'vitest';
import { answerButton, answerText, startAsk, type AskOutcome } from '../../shared/ask-flow.js';
import { buildAffordFlow, buildNewRuleFlow, buildPoolClearFlow, buildPoolSetFlow, mostUsedCategories, buildSubAddFlow, buildSubRenameFlow } from './ask-flows.js';

const NOW = new Date('2026-10-12T15:00:00Z');

/** Feeds typed answers in order; returns the final outcome. */
function drive(flow: ReturnType<typeof buildPoolSetFlow>, answers: string[]): AskOutcome {
  let { state } = startAsk(flow, 'k1');
  let out: AskOutcome = { kind: 'stale' };
  for (const a of answers) {
    out = answerText(flow, state, a);
    if (out.kind === 'screen' || out.kind === 'retry') state = out.state;
  }
  return out;
}

describe('pool-set flow', () => {
  it('asks amount, then date, then shows a summary', () => {
    const out = drive(buildPoolSetFlow(NOW), ['16000', 'Dec 12']);
    expect(out.kind).toBe('screen');
    if (out.kind !== 'screen') return;
    expect(out.state.answers).toEqual({ amount: 1_600_000, until: '2026-12-12' });
    expect(out.screen.text).toContain('$16,000');
    expect(out.screen.text).toContain('Dec 12');
  });

  it('rolls a past month-day into next year', () => {
    const out = drive(buildPoolSetFlow(NOW), ['500', 'Jan 3']);
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.state.answers.until).toBe('2027-01-03');
  });

  it('refuses a past ISO date with a hint', () => {
    const out = drive(buildPoolSetFlow(NOW), ['500', '2026-01-03']);
    expect(out.kind).toBe('retry');
    if (out.kind !== 'retry') return;
    expect(out.screen.text).toContain('That date has passed');
  });

  it('re-asks an unreadable amount', () => {
    const out = drive(buildPoolSetFlow(NOW), ['lots']);
    expect(out.kind).toBe('retry');
    if (out.kind !== 'retry') return;
    expect(out.screen.text).toContain("Couldn't read that as an amount");
  });
});

describe('pool-clear flow', () => {
  it('finishes on "Yes, clear"', () => {
    const flow = buildPoolClearFlow();
    const { state } = startAsk(flow, 'k1');
    expect(answerText(flow, state, 'yes clear')).toEqual({ kind: 'done', answers: { confirm: true } });
  });
});

const cats = [
  { id: 'g', name: 'Groceries', parentId: null, parentName: null },
  { id: 'r', name: 'Restaurants', parentId: 'f', parentName: 'Food_Drink' },
  { id: 'h1', name: 'Home', parentId: null, parentName: null },
  { id: 'h2', name: 'Home Improvement', parentId: null, parentName: null },
];

describe('mostUsedCategories', () => {
  it('ranks spending-category assignments by count and ignores other taxonomies', () => {
    const row = (taxonomyId: string, categoryId: string) => ({ assignments: [{ taxonomyId, categoryId }] });
    const rows = [row('spending_categories', 'r'), row('spending_categories', 'r'), row('spending_categories', 'g'),
      row('income_categories', 'g'), row('income_categories', 'g'), row('spending_categories', 'gone')];
    expect(mostUsedCategories(rows, cats, 6).map((c) => c.id)).toEqual(['r', 'g']);
  });
});

describe('newrule flow', () => {
  const flow = buildNewRuleFlow({ categories: cats, mostUsed: [cats[1], cats[0]], countMatches: (p) => (p === 'trader joes' ? 12 : 0) });

  it('asks for words, then names the match count when asking for the category', () => {
    const { state } = startAsk(flow, 'k1');
    const out = answerText(flow, state, 'trader joes');
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.text).toContain('12 transactions in the past year match "trader joes"');
  });

  it('says plainly when nothing matches yet', () => {
    const { state } = startAsk(flow, 'k1');
    const out = answerText(flow, state, 'nothing here');
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.text).toContain('No transactions in the past year match');
  });

  it('escapes Markdown in the echoed words while quick-pick labels stay plain', () => {
    const { state } = startAsk(flow, 'k1');
    const out = answerText(flow, state, 'kids_*club');
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.text).toContain('kids\\_\\*club');
    const labels = out.screen.keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('Restaurants (Food_Drink)');
  });

  it('finishes with the category id from a typed name', () => {
    const at1 = { seq: 'k1', step: 1, answers: { pattern: 'trader joes' } };
    expect(answerText(flow, at1, 'groc')).toEqual({ kind: 'done', answers: { pattern: 'trader joes', category: 'g' } });
  });

  it('finishes with the category id from a quick pick', () => {
    const at1 = { seq: 'k1', step: 1, answers: { pattern: 'trader joes' } };
    const out = answerButton(flow, at1, 'cz:ak:k1:1:q0');
    expect(out).toMatchObject({ kind: 'done', answers: { pattern: 'trader joes', category: 'r' } });
  });

  it('re-asks with the ambiguity reply when a name matches several', () => {
    const at1 = { seq: 'k1', step: 1, answers: { pattern: 'lowes' } };
    const out = answerText(flow, at1, 'hom');
    expect(out.kind).toBe('retry');
    if (out.kind !== 'retry') return;
    expect(out.screen.text).toContain('Which one? Home, Home Improvement');
  });

  it('refuses text with = or → and points at the next question', () => {
    const { state } = startAsk(flow, 'k1');
    for (const text of ['trader joes = groceries', 'trader joes → groceries']) {
      const out = answerText(flow, state, text);
      expect(out.kind).toBe('retry');
      if (out.kind !== 'retry') return;
      expect(out.screen.text).toContain("Just the words — I'll ask for the category next.");
    }
  });

  it('refuses empty or digits-only words', () => {
    const { state } = startAsk(flow, 'k1');
    expect(answerText(flow, state, '1234').kind).toBe('retry');
  });
});

describe('afford flow', () => {
  const budgeted = [
    { name: 'Groceries', budget: 400, monthSpent: 100, weekSpent: 20 },
    { name: 'Dining', budget: 200, monthSpent: 50, weekSpent: 10 },
    { name: 'Dining Out', budget: 0, monthSpent: 5, weekSpent: 0 },
    { name: 'Hobbies', budget: 0, monthSpent: 5, weekSpent: 0 },
  ];
  const flow = buildAffordFlow(budgeted);

  it('asks the amount, then offers the budgeted categories as quick picks', () => {
    const { state } = startAsk(flow, 'k1');
    const out = answerText(flow, state, '$20');
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Groceries', 'Dining', '‹ Back', '✖ Cancel']);
  });

  it('finishes with the amount in cents and the RESOLVED category name', () => {
    const at1 = { seq: 'k1', step: 1, answers: { amount: 2000 } };
    expect(answerText(flow, at1, 'groc')).toEqual({ kind: 'done', answers: { amount: 2000, query: 'Groceries' } });
    expect(answerText(flow, at1, 'dining')).toMatchObject({ kind: 'done', answers: { query: 'Dining' } });
  });

  it('re-asks only the category on a typo, with a hint that fits a question', () => {
    const at1 = { seq: 'k1', step: 1, answers: { amount: 2000 } };
    const out = answerText(flow, at1, 'xyzzy');
    expect(out.kind).toBe('retry');
    if (out.kind !== 'retry') return;
    expect(out.screen.text).toContain('No category starts with "xyzzy"');
    expect(out.screen.text).toContain('Type one of your budget categories, or tap one.');
    expect(out.screen.text).not.toContain('/left');
  });

  it('re-asks naming the options on an ambiguous prefix', () => {
    const at1 = { seq: 'k1', step: 1, answers: { amount: 2000 } };
    const amb = answerText(buildAffordFlow([...budgeted, { name: 'Dinner', budget: 5, monthSpent: 0, weekSpent: 0 }]), at1, 'din');
    expect(amb.kind).toBe('retry');
    if (amb.kind !== 'retry') return;
    expect(amb.screen.text).toContain('Which one? Dining, Dining Out, Dinner');
  });

  it('caps quick picks at eight', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Cat ${i}`, budget: 10, monthSpent: 0, weekSpent: 0 }));
    const f = buildAffordFlow(many);
    const out = answerText(f, startAsk(f, 'k1').state, '5');
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.keyboard.inline_keyboard.flat().filter((b) => b.callback_data.includes(':q'))).toHaveLength(8);
  });
});

describe('sub-add flow', () => {
  const NOW_LOCAL = new Date(2026, 9, 12, 9, 0, 0);
  const driveSub = (answers: string[]) => drive(buildSubAddFlow(NOW_LOCAL), answers);

  it('counts its five questions in the title', () => {
    expect(startAsk(buildSubAddFlow(NOW_LOCAL), 'k1').screen.text).toBe("*New subscription · 1 of 5*\nWhat's it called? (e.g. Hulu)");
  });

  it('asks name, amount, how often, next date, reminder — then a summary', () => {
    const out = driveSub(['Hulu', '9.99', 'Monthly', 'Oct 20', '3d']);
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.state.answers).toEqual({ name: 'Hulu', amount: 999, cadence: 'monthly', nextDate: '2026-10-20', remind: 3 });
    expect(out.screen.text).toBe('*New subscription*\nHulu — $9.99 a month, next charge *Oct 20*.\n🔔 Reminder 3 days before.');
  });

  it('rolls a past date forward by the cadence', () => {
    const monthly = driveSub(['Gym', '40', 'Monthly', 'Oct 3', 'No']);
    const yearly = driveSub(['Domain', '15', 'Yearly', 'Oct 3', 'No']);
    if (monthly.kind !== 'screen' || yearly.kind !== 'screen') throw new Error('not at the summary');
    expect(monthly.state.answers.nextDate).toBe('2026-11-03');
    expect(yearly.state.answers.nextDate).toBe('2027-10-03');
    expect(yearly.screen.text).toContain('No reminder.');
  });

  it('lands Feb 29 on Feb 28 in a year without one (R2-4)', () => {
    const out = driveSub(['Domain', '15', 'Yearly', 'Feb 29', 'No']);
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.state.answers.nextDate).toBe('2027-02-28');
  });

  it('re-asks an empty name, a bad amount and a bad date with the shared hints', () => {
    expect(driveSub(['   ']).kind).toBe('retry');
    const badAmount = driveSub(['Hulu', '9,99']);
    if (badAmount.kind !== 'retry') throw new Error(badAmount.kind);
    expect(badAmount.screen.text).toContain("Couldn't read that as an amount — try 9.99.");
    const badDate = driveSub(['Hulu', '9.99', 'Monthly', 'someday']);
    if (badDate.kind !== 'retry') throw new Error(badDate.kind);
    expect(badDate.screen.text).toContain("Couldn't read that date — try Oct 20 or 2026-10-20.");
  });

  it('escapes the name and keeps it out of bold', () => {
    const out = driveSub(['Max_Ultimate*', '20', 'Monthly', 'Oct 20', 'No']);
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.text).toContain('\nMax\\_Ultimate\\* — $20 a month, next charge *Oct 20*.');
  });
});

describe('sub-rename flow', () => {
  it('asks once and re-asks an empty answer', () => {
    const flow = buildSubRenameFlow('SPOTIFY');
    const { state, screen } = startAsk(flow, 'k1');
    expect(screen.text).toBe('*Rename*\nNew name for SPOTIFY?');
    expect(answerText(flow, state, '   ').kind).toBe('retry');
    expect(answerText(flow, state, ' Spotify ')).toEqual({ kind: 'done', answers: { name: 'Spotify' } });
  });

  it('escapes the current name in the question', () => {
    expect(startAsk(buildSubRenameFlow('SQ *COFFEE_CLUB'), 'k1').screen.text).toBe('*Rename*\nNew name for SQ \\*COFFEE\\_CLUB?');
  });
});
