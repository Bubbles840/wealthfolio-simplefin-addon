import { describe, it, expect } from 'vitest';
import { answerButton, answerText, startAsk, type AskOutcome } from '../../shared/ask-flow.js';
import { buildAffordFlow, buildNewRuleFlow, buildPoolClearFlow, buildPoolSetFlow, mostUsedCategories } from './ask-flows.js';

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
    expect(out.screen.text).toContain('12 charges in the past year match "trader joes"');
  });

  it('says plainly when nothing matches yet', () => {
    const { state } = startAsk(flow, 'k1');
    const out = answerText(flow, state, 'nothing here');
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.text).toContain('No charges in the past year match');
  });

  it('escapes Markdown in the echoed words and in quick-pick labels', () => {
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

  it('refuses empty or digits-only words', () => {
    const { state } = startAsk(flow, 'k1');
    expect(answerText(flow, state, '1234').kind).toBe('retry');
  });
});

describe('afford flow', () => {
  const budgeted = [
    { name: 'Groceries', budget: 400, monthSpent: 100, weekSpent: 20 },
    { name: 'Dining', budget: 200, monthSpent: 50, weekSpent: 10 },
  ];
  const flow = buildAffordFlow(budgeted);

  it('asks the amount, then offers the budgeted categories as quick picks', () => {
    const { state } = startAsk(flow, 'k1');
    const out = answerText(flow, state, '$20');
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Groceries', 'Dining', '‹ Back', '✖ Cancel']);
  });

  it('finishes with the amount in cents and the category text as typed', () => {
    const at1 = { seq: 'k1', step: 1, answers: { amount: 2000 } };
    expect(answerText(flow, at1, 'groc')).toEqual({ kind: 'done', answers: { amount: 2000, query: 'groc' } });
  });

  it('caps quick picks at eight', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Cat ${i}`, budget: 10, monthSpent: 0, weekSpent: 0 }));
    const f = buildAffordFlow(many);
    const out = answerText(f, startAsk(f, 'k1').state, '5');
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.keyboard.inline_keyboard.flat().filter((b) => b.callback_data.includes(':q'))).toHaveLength(8);
  });
});
