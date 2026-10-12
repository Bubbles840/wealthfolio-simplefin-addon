import { describe, it, expect } from 'vitest';
import { answerText, startAsk, type AskOutcome } from '../../shared/ask-flow.js';
import { buildPoolClearFlow, buildPoolSetFlow } from './ask-flows.js';

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
