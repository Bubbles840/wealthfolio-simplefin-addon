import { describe, it, expect } from 'vitest';
import {
  ASK_CALLBACK_PREFIX, answerButton, answerText, askStartData, parseAskStart, renderAsk, startAsk,
  type AskFlow,
} from './ask-flow';

const flow: AskFlow = {
  id: 'demo',
  command: 'demo',
  title: 'Demo',
  steps: [
    {
      id: 'amount', kind: 'text', prompt: () => 'How much?',
      parse: (input) => (/^\d+$/.test(input) ? { ok: true, value: Number(input) } : { ok: false, hint: 'Numbers only.' }),
      quick: () => [{ label: '10', value: 10 }],
    },
    {
      id: 'cadence', kind: 'choice', prompt: (a) => `Every what, for ${a.amount}?`,
      options: () => [{ label: 'Monthly', value: 'monthly' }, { label: 'Yes, clear', value: 'yearly' }],
    },
  ],
  summary: (a) => `${a.amount} ${a.cadence}`,
};

const buttons = (screen: { keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }) =>
  screen.keyboard.inline_keyboard.flat();

describe('startAsk / renderAsk', () => {
  it('shows the title with a step counter, the prompt, quick picks, then Back and Cancel', () => {
    const { state, screen } = startAsk(flow, 'k1');
    expect(state).toEqual({ seq: 'k1', step: 0, answers: {} });
    expect(screen.text).toBe('*Demo · 1 of 2*\nHow much?');
    expect(buttons(screen).map((b) => [b.text, b.callback_data])).toEqual([
      ['10', 'cz:ak:k1:0:q0'],
      ['‹ Back', 'cz:ak:k1:0:b'],
      ['✖ Cancel', 'cz:ak:k1:0:x'],
    ]);
  });

  it('drops the counter for a one-step flow', () => {
    const one: AskFlow = { ...flow, steps: [flow.steps[0]], summary: undefined };
    expect(startAsk(one, 'k1').screen.text).toBe('*Demo*\nHow much?');
  });

  it('puts a retry hint above the prompt', () => {
    const { state } = startAsk(flow, 'k1');
    expect(renderAsk(flow, state, 'Numbers only.').text).toBe('*Demo · 1 of 2*\n⚠️ Numbers only.\nHow much?');
  });

  it('keeps every button under Telegram\'s 64-byte limit', () => {
    const { screen } = startAsk(flow, (Date.UTC(2099, 0, 1) + 999_999).toString(36));
    for (const b of buttons(screen)) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
  });
});

describe('answerText', () => {
  it('advances on a parsed answer and renders the next prompt from the answers so far', () => {
    const { state } = startAsk(flow, 'k1');
    const out = answerText(flow, state, ' 25 ');
    expect(out.kind).toBe('screen');
    if (out.kind !== 'screen') return;
    expect(out.state).toEqual({ seq: 'k1', step: 1, answers: { amount: 25 } });
    expect(out.screen.text).toContain('Every what, for 25?');
  });

  it('re-asks the same question with the hint on a bad answer', () => {
    const { state } = startAsk(flow, 'k1');
    const out = answerText(flow, state, 'lots');
    expect(out.kind).toBe('retry');
    if (out.kind !== 'retry') return;
    expect(out.state).toEqual(state);
    expect(out.screen.text).toContain('⚠️ Numbers only.');
  });

  it('accepts a typed choice that matches an option label, ignoring case and punctuation', () => {
    const at1 = { seq: 'k1', step: 1, answers: { amount: 25 } };
    const out = answerText(flow, at1, 'yes clear');
    expect(out.kind).toBe('screen');
    if (out.kind !== 'screen') return;
    expect(out.state.answers).toEqual({ amount: 25, cadence: 'yearly' });
  });

  it('re-asks a choice step when the typed text matches no option', () => {
    const at1 = { seq: 'k1', step: 1, answers: { amount: 25 } };
    const out = answerText(flow, at1, 'weekly');
    expect(out.kind).toBe('retry');
    if (out.kind !== 'retry') return;
    expect(out.screen.text).toContain('⚠️ Tap one of the buttons.');
  });

  it('reaches the summary with Save, Back and Cancel', () => {
    const at1 = { seq: 'k1', step: 1, answers: { amount: 25 } };
    const out = answerText(flow, at1, 'monthly');
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.state.step).toBe(2);
    expect(out.screen.text).toBe('*Demo*\n25 monthly');
    expect(buttons(out.screen).map((b) => b.callback_data)).toEqual(['cz:ak:k1:2:s', 'cz:ak:k1:2:b', 'cz:ak:k1:2:x']);
  });

  it('answers typed text at the summary with a hint, not a save', () => {
    const atSummary = { seq: 'k1', step: 2, answers: { amount: 25, cadence: 'monthly' } };
    const out = answerText(flow, atSummary, 'save');
    expect(out.kind).toBe('retry');
    if (out.kind !== 'retry') return;
    expect(out.screen.text).toContain('⚠️ Tap ✅ Save, or ‹ Back to change something.');
  });

  it('finishes on the last answer when the flow has no summary', () => {
    const noSummary: AskFlow = { ...flow, summary: undefined };
    const out = answerText(noSummary, { seq: 'k1', step: 1, answers: { amount: 25 } }, 'Monthly');
    expect(out).toEqual({ kind: 'done', answers: { amount: 25, cadence: 'monthly' } });
  });
});

describe('typed escape words', () => {
  it.each(['cancel', 'Stop', ' CANCEL '])('%s cancels on any step', (word) => {
    expect(answerText(flow, startAsk(flow, 'k1').state, word)).toEqual({ kind: 'cancel' });
    expect(answerText(flow, { seq: 'k1', step: 1, answers: { amount: 25 } }, word)).toEqual({ kind: 'cancel' });
  });

  it('back goes one step back, and cancels on the first question', () => {
    const out = answerText(flow, { seq: 'k1', step: 1, answers: { amount: 25 } }, 'Back');
    expect(out).toMatchObject({ kind: 'screen', state: { step: 0 } });
    expect(answerText(flow, startAsk(flow, 'k1').state, 'back')).toEqual({ kind: 'cancel' });
  });

  it('works at the summary too', () => {
    const atSummary = { seq: 'k1', step: 2, answers: { amount: 25, kind: 'm' } };
    expect(answerText(flow, atSummary, 'cancel')).toEqual({ kind: 'cancel' });
    expect(answerText(flow, atSummary, 'back')).toMatchObject({ kind: 'screen', state: { step: 1 } });
  });
});

describe('answerButton', () => {
  const at1 = { seq: 'k1', step: 1, answers: { amount: 25 } };

  it('takes a choice by index and echoes its label', () => {
    const out = answerButton(flow, at1, 'cz:ak:k1:1:c0');
    expect(out.kind).toBe('screen');
    if (out.kind !== 'screen') return;
    expect(out.echo).toBe('Monthly');
    expect(out.state.answers.cadence).toBe('monthly');
  });

  it('takes a quick pick on a text step', () => {
    const out = answerButton(flow, { seq: 'k1', step: 0, answers: {} }, 'cz:ak:k1:0:q0');
    expect(out.kind).toBe('screen');
    if (out.kind !== 'screen') return;
    expect(out.state.answers.amount).toBe(10);
    expect(out.echo).toBe('10');
  });

  it('goes back one step, keeping earlier answers', () => {
    const out = answerButton(flow, at1, 'cz:ak:k1:1:b');
    expect(out.kind).toBe('screen');
    if (out.kind !== 'screen') return;
    expect(out.state).toEqual({ seq: 'k1', step: 0, answers: { amount: 25 } });
  });

  it('treats Back on the first question as Cancel', () => {
    expect(answerButton(flow, { seq: 'k1', step: 0, answers: {} }, 'cz:ak:k1:0:b')).toEqual({ kind: 'cancel' });
  });

  it('cancels', () => {
    expect(answerButton(flow, at1, 'cz:ak:k1:1:x')).toEqual({ kind: 'cancel' });
  });

  it('saves from the summary', () => {
    const out = answerButton(flow, { seq: 'k1', step: 2, answers: { amount: 25, cadence: 'monthly' } }, 'cz:ak:k1:2:s');
    expect(out).toEqual({ kind: 'done', answers: { amount: 25, cadence: 'monthly' }, echo: '✅ Save' });
  });

  it.each([
    ['another flow\'s seq', 'cz:ak:zz:1:c0'],
    ['an earlier step', 'cz:ak:k1:0:q0'],
    ['an out-of-range option', 'cz:ak:k1:1:c9'],
    ['save before the summary', 'cz:ak:k1:1:s'],
    ['garbage', 'cz:ak:nonsense'],
  ])('reports %s as stale', (_label, data) => {
    expect(answerButton(flow, at1, data)).toEqual({ kind: 'stale' });
  });
});

describe('flow-start buttons', () => {
  it('round-trips a flow id with and without an argument', () => {
    expect(askStartData('pool-set')).toBe('cz:ak:go:pool-set');
    expect(parseAskStart('cz:ak:go:pool-set')).toEqual({ flowId: 'pool-set' });
    expect(parseAskStart(askStartData('sub-rename', 'a1b2c3'))).toEqual({ flowId: 'sub-rename', arg: 'a1b2c3' });
  });

  it('does not read an answer button as a start button', () => {
    expect(parseAskStart(`${ASK_CALLBACK_PREFIX}k1:0:x`)).toBeNull();
  });
});
