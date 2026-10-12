/**
 * shared/ask-flow.ts
 *
 * The bot's question-and-answer engine: a flow is a list of steps, each a
 * typed answer or a choice, optionally ending on a summary with Save. Pure —
 * the companion owns the open question, the clock and the transport
 * (companion/src/ask-session.ts); this file only renders a step and decides
 * what an answer means.
 *
 * It never escapes text: prompts, hints, option labels and summaries arrive
 * from the flow definitions, which know which parts are user-supplied.
 */
import type { InlineKeyboard } from './telegram.js';

export const ASK_CALLBACK_PREFIX = 'cz:ak:';
const START_PREFIX = `${ASK_CALLBACK_PREFIX}go:`;

export const ASK_BACK = '‹ Back';
export const ASK_CANCEL = '✖ Cancel';
export const ASK_SAVE = '✅ Save';

const SUMMARY_HINT = 'Tap ✅ Save, or ‹ Back to change something.';
const CHOICE_HINT = 'Tap one of the buttons.';

export type Answers = Record<string, unknown>;
export type StepResult = { ok: true; value: unknown } | { ok: false; hint: string };
export interface AskOption { label: string; value: unknown }

export type AskStep =
  | {
    id: string;
    kind: 'text';
    prompt: (a: Answers) => string;
    parse: (input: string, a: Answers) => StepResult;
    /** Buttons offered beside typing, e.g. the most-used categories. */
    quick?: (a: Answers) => AskOption[];
  }
  | { id: string; kind: 'choice'; prompt: (a: Answers) => string; options: (a: Answers) => AskOption[] };

export interface AskFlow {
  id: string;
  /** The command that starts it, without the slash — named by the expiry reply. */
  command: string;
  title: string;
  steps: AskStep[];
  /** Present → the flow ends on this summary with ✅ Save. Absent → the last
   *  answer finishes it. */
  summary?: (a: Answers) => string;
}

/** `step === flow.steps.length` is the summary screen. */
export interface AskState { seq: string; step: number; answers: Answers }
export interface AskScreen { text: string; keyboard: InlineKeyboard }

export type AskOutcome =
  | { kind: 'screen'; state: AskState; screen: AskScreen; echo?: string }
  | { kind: 'retry'; state: AskState; screen: AskScreen }
  | { kind: 'done'; answers: Answers; echo?: string }
  | { kind: 'cancel' }
  | { kind: 'stale' };

type Button = { text: string; callback_data: string };

const data = (state: AskState, action: string) => `${ASK_CALLBACK_PREFIX}${state.seq}:${state.step}:${action}`;

const pairs = (list: Button[]): Button[][] => {
  const rows: Button[][] = [];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2));
  return rows;
};

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function renderAsk(flow: AskFlow, state: AskState, hint?: string): AskScreen {
  const n = flow.steps.length;
  const hintLine = hint ? [`⚠️ ${hint}`] : [];
  if (state.step >= n) {
    return {
      text: [`*${flow.title}*`, ...hintLine, flow.summary ? flow.summary(state.answers) : ''].join('\n'),
      keyboard: {
        inline_keyboard: [
          [{ text: ASK_SAVE, callback_data: data(state, 's') }],
          [{ text: ASK_BACK, callback_data: data(state, 'b') }, { text: ASK_CANCEL, callback_data: data(state, 'x') }],
        ],
      },
    };
  }
  const step = flow.steps[state.step];
  const head = n > 1 ? `*${flow.title} · ${state.step + 1} of ${n}*` : `*${flow.title}*`;
  const picks = step.kind === 'choice'
    ? step.options(state.answers).map((o, i) => ({ text: o.label, callback_data: data(state, `c${i}`) }))
    : (step.quick?.(state.answers) ?? []).map((o, i) => ({ text: o.label, callback_data: data(state, `q${i}`) }));
  return {
    text: [head, ...hintLine, step.prompt(state.answers)].join('\n'),
    keyboard: {
      inline_keyboard: [
        ...pairs(picks),
        [{ text: ASK_BACK, callback_data: data(state, 'b') }, { text: ASK_CANCEL, callback_data: data(state, 'x') }],
      ],
    },
  };
}

export function startAsk(flow: AskFlow, seq: string): { state: AskState; screen: AskScreen } {
  const state: AskState = { seq, step: 0, answers: {} };
  return { state, screen: renderAsk(flow, state) };
}

function advance(flow: AskFlow, state: AskState, value: unknown, echo?: string): AskOutcome {
  const answers = { ...state.answers, [flow.steps[state.step].id]: value };
  const next = state.step + 1;
  if (next >= flow.steps.length && !flow.summary) return { kind: 'done', answers, ...(echo ? { echo } : {}) };
  const nextState: AskState = { seq: state.seq, step: next, answers };
  return { kind: 'screen', state: nextState, screen: renderAsk(flow, nextState), ...(echo ? { echo } : {}) };
}

const retry = (flow: AskFlow, state: AskState, hint: string): AskOutcome =>
  ({ kind: 'retry', state, screen: renderAsk(flow, state, hint) });

/** One step back; on the first question there is nothing to go back to, so it cancels. */
function goBack(flow: AskFlow, state: AskState): AskOutcome {
  if (state.step === 0) return { kind: 'cancel' };
  const back: AskState = { ...state, step: state.step - 1 };
  return { kind: 'screen', state: back, screen: renderAsk(flow, back) };
}

export function answerText(flow: AskFlow, state: AskState, text: string): AskOutcome {
  // Typed escape words work on every step, like the buttons they stand for.
  const word = text.trim().toLowerCase();
  if (word === 'cancel' || word === 'stop') return { kind: 'cancel' };
  if (word === 'back') return goBack(flow, state);
  if (state.step >= flow.steps.length) return retry(flow, state, SUMMARY_HINT);
  const step = flow.steps[state.step];
  const input = text.trim();
  if (step.kind === 'choice') {
    const wanted = normalize(input);
    const option = step.options(state.answers).find((o) => normalize(o.label) === wanted);
    return option ? advance(flow, state, option.value) : retry(flow, state, CHOICE_HINT);
  }
  const result = step.parse(input, state.answers);
  return result.ok ? advance(flow, state, result.value) : retry(flow, state, result.hint);
}

const ANSWER = /^cz:ak:([0-9a-z]+):(\d+):(x|b|s|c\d+|q\d+)$/;

export function answerButton(flow: AskFlow, state: AskState, raw: string): AskOutcome {
  const m = raw.match(ANSWER);
  if (!m || m[1] !== state.seq || Number(m[2]) !== state.step) return { kind: 'stale' };
  const action = m[3];
  const atSummary = state.step >= flow.steps.length;
  if (action === 'x') return { kind: 'cancel' };
  if (action === 'b') {
    return goBack(flow, state);
  }
  if (action === 's') return atSummary ? { kind: 'done', answers: state.answers, echo: ASK_SAVE } : { kind: 'stale' };
  if (atSummary) return { kind: 'stale' };
  const step = flow.steps[state.step];
  const index = Number(action.slice(1));
  const list = action[0] === 'c'
    ? (step.kind === 'choice' ? step.options(state.answers) : [])
    : (step.kind === 'text' ? step.quick?.(state.answers) ?? [] : []);
  const option = list[index];
  return option ? advance(flow, state, option.value, option.label) : { kind: 'stale' };
}

export function askStartData(flowId: string, arg?: string): string {
  return `${START_PREFIX}${flowId}${arg !== undefined ? `:${arg}` : ''}`;
}

export function parseAskStart(raw: string): { flowId: string; arg?: string } | null {
  if (!raw.startsWith(START_PREFIX)) return null;
  const [flowId, ...rest] = raw.slice(START_PREFIX.length).split(':');
  if (!flowId) return null;
  return rest.length > 0 ? { flowId, arg: rest.join(':') } : { flowId };
}
