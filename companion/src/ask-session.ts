/**
 * companion/src/ask-session.ts
 *
 * The bot's ONE open question. The listener honours a single configured chat,
 * so this is a slot, not a per-chat map. It lives in memory on purpose: a
 * restart loses it, and the next answer is told so ("I'm not waiting for an
 * answer right now") rather than ignored.
 *
 * Text answers arrive through the listener's `onText`; buttons through
 * `onMenuCallback`, which must offer `cz:ak:` data HERE before the categorize
 * controller treats it as an expired menu.
 *
 * This module relies on the listener: `send`/`reply` and every `ui.*` method
 * never reject, and the listener wraps onCommand, onMenuCallback and onText in
 * a catch. So this module adds no try/catch around transport calls, except
 * where a failed cosmetic edit must not strand an answer (see onCallback).
 */
import {
  ASK_CALLBACK_PREFIX, answerButton, answerText, parseAskStart, startAsk,
  type AskFlow, type AskOutcome, type AskState, type Answers,
} from '../../shared/ask-flow.js';
import { escapeMarkdown, type InlineKeyboard } from '../../shared/telegram.js';

export type AskSend = (text: string, keyboard?: InlineKeyboard) => Promise<void>;
export interface AskUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  send: AskSend;
}
export interface AskRun { flow: AskFlow; onDone: (answers: Answers, send: AskSend) => Promise<void> }
/** Builds a flow when it starts. Null = cannot start; the factory has already told the user why through `send`. */
export type AskFactory = (arg: string | undefined, send: AskSend) => Promise<AskRun | null>;

export const CANCELLED_EARLIER = 'Cancelled your earlier question.';
export const NOT_WAITING = "I'm not waiting for an answer right now — /help lists what I can do.";
export const ASK_MOVED_ON = 'That question has moved on.';
const QUESTION_GONE = 'That question expired.';
const UNKNOWN_FLOW = 'That button is no longer available.';
const DONE_FAILED = 'Something went wrong finishing that — check the companion logs.';

export function expiredReply(command: string): string {
  return `That question expired — send /${command} again.`;
}

export interface AskSessions {
  register(flowId: string, factory: AskFactory): void;
  start(flowId: string, send: AskSend, arg?: string): Promise<void>;
  /** A command arrived: drop any open question. True when one was open. */
  cancelForCommand(): boolean;
  onText(text: string, send: AskSend): Promise<void>;
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: AskUi): Promise<void>;
}

interface Open { run: AskRun; state: AskState; lastAt: number; lastText: string }

export function createAskSessions(opts: {
  now?: () => number;
  ttlMs?: number;
  expiredMemoryMs?: number;
  /** First sequence number. Defaults to the process start time, so a button
   *  minted before a restart can never match a flow started after it. */
  seqBase?: number;
  log?: (m: string) => void;
} = {}): AskSessions {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 15 * 60_000;
  const expiredMemory = opts.expiredMemoryMs ?? 60 * 60_000;
  const log = opts.log ?? (() => {});
  let counter = opts.seqBase ?? Date.now();
  const factories = new Map<string, AskFactory>();
  let open: Open | null = null;
  let expired: { command: string; at: number } | null = null;

  const current = (): Open | null => {
    if (open && now() - open.lastAt > ttl) {
      expired = { command: open.run.flow.command, at: open.lastAt + ttl };
      open = null;
    }
    return open;
  };

  const show = async (o: Open, outcome: Extract<AskOutcome, { kind: 'screen' | 'retry' }>, send: AskSend) => {
    o.state = outcome.state;
    o.lastAt = now();
    o.lastText = outcome.screen.text;
    await send(outcome.screen.text, outcome.screen.keyboard);
  };

  const finish = async (run: AskRun, answers: Answers, send: AskSend) => {
    try {
      await run.onDone(answers, send);
    } catch (err) {
      log(`Ask flow ${run.flow.id}: finishing failed: ${err instanceof Error ? err.message : String(err)}`);
      await send(DONE_FAILED);
    }
  };

  const start = async (flowId: string, send: AskSend, arg?: string) => {
    const factory = factories.get(flowId);
    if (!factory) {
      log(`Ask flow ${flowId}: no such flow`);
      await send(UNKNOWN_FLOW);
      return;
    }
    // Build the flow first: a null or thrown factory leaves any open question answerable.
    const run = await factory(arg, send);
    if (!run) return;
    const replaced = current() !== null;
    const seq = (counter++).toString(36);
    const { state, screen } = startAsk(run.flow, seq);
    open = { run, state, lastAt: now(), lastText: screen.text };
    expired = null;
    await send(`${replaced ? `${CANCELLED_EARLIER}\n\n` : ''}${screen.text}`, screen.keyboard);
  };

  return {
    register(flowId, factory) {
      factories.set(flowId, factory);
    },

    start,

    cancelForCommand() {
      const had = current() !== null;
      open = null;
      expired = null;
      return had;
    },

    async onText(text, send) {
      const o = current();
      if (!o) {
        if (expired && now() - expired.at <= expiredMemory) {
          const command = expired.command;
          expired = null;
          await send(expiredReply(command));
        } else {
          expired = null;
          await send(NOT_WAITING);
        }
        return;
      }
      const outcome = answerText(o.run.flow, o.state, text);
      if (outcome.kind === 'screen' || outcome.kind === 'retry') {
        await show(o, outcome, send);
      } else if (outcome.kind === 'done') {
        open = null;
        await finish(o.run, outcome.answers, send);
      }
    },

    handles(data) {
      return data.startsWith(ASK_CALLBACK_PREFIX);
    },

    async onCallback(cb, ui) {
      const go = parseAskStart(cb.data);
      if (go) {
        await ui.answer();
        await start(go.flowId, ui.send, go.arg);
        return;
      }
      const o = current();
      if (!o) {
        await ui.answer(QUESTION_GONE);
        return;
      }
      const outcome = answerButton(o.run.flow, o.state, cb.data);
      if (outcome.kind === 'stale') {
        await ui.answer(ASK_MOVED_ON);
        return;
      }
      await ui.answer();
      // State changes before the cosmetic edit, so a failing edit cannot strand a Save or Cancel.
      const edit = async (text: string) => {
        try {
          await ui.edit(text);
        } catch (err) {
          log(`Ask flow ${o.run.flow.id}: editing the answered question failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      if (outcome.kind === 'cancel') {
        open = null;
        await edit(`${o.lastText}\n→ Cancelled.`);
        return;
      }
      // The tapped question keeps its text and loses its buttons, so the chat
      // reads as a record of what was answered.
      const shown = outcome.kind !== 'retry' && outcome.echo ? `${o.lastText}\n→ ${escapeMarkdown(outcome.echo)}` : o.lastText;
      if (outcome.kind === 'done') {
        open = null;
        await edit(shown);
        await finish(o.run, outcome.answers, ui.send);
        return;
      }
      await edit(shown);
      await show(o, outcome, ui.send);
    },
  };
}
