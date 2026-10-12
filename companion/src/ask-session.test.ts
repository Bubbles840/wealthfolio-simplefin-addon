import { describe, it, expect, vi } from 'vitest';
import type { AskFlow } from '../../shared/ask-flow.js';
import {
  ASK_MOVED_ON, CANCELLED_EARLIER, NOT_WAITING, createAskSessions, expiredReply, type AskRun,
} from './ask-session.js';

const flow: AskFlow = {
  id: 'demo', command: 'pool', title: 'Demo',
  steps: [
    { id: 'amount', kind: 'text', prompt: () => 'How much?',
      parse: (s) => (/^\d+$/.test(s) ? { ok: true, value: Number(s) } : { ok: false, hint: 'Numbers only.' }) },
    { id: 'kind', kind: 'choice', prompt: () => 'Which?', options: () => [{ label: 'Monthly', value: 'm' }] },
  ],
  summary: (a) => `${a.amount} ${a.kind}`,
};

function setup(start = 1_000_000) {
  let clock = start;
  const done = vi.fn(async (_answers: Record<string, unknown>, _send: unknown) => {});
  const sessions = createAskSessions({ now: () => clock, seqBase: 0 });
  sessions.register('demo', async () => ({ flow, onDone: done } as AskRun));
  const sent: Array<[string, unknown]> = [];
  const send = vi.fn(async (text: string, keyboard?: unknown) => { sent.push([text, keyboard]); });
  const ui = {
    edit: vi.fn(async (_t: string, _k?: unknown) => {}),
    answer: vi.fn(async (_t?: string) => {}),
    send,
  };
  return { sessions, done, sent, send, ui, tick: (ms: number) => { clock += ms; } };
}

const lastButtons = (sent: Array<[string, unknown]>) =>
  ((sent[sent.length - 1][1] as any).inline_keyboard as Array<Array<{ callback_data: string }>>).flat().map((b) => b.callback_data);

describe('firstQuestionNote', () => {
  it('is appended to the first question only', async () => {
    const sessions = createAskSessions({ seqBase: 0, firstQuestionNote: async () => 'Reply to answer.' });
    sessions.register('demo', async () => ({ flow, onDone: async () => {} } as AskRun));
    const sent: string[] = [];
    const send = async (t: string) => { sent.push(t); };
    await sessions.start('demo', send);
    await sessions.onText('25', send);
    expect(sent[0]).toBe('*Demo · 1 of 2*\nHow much?\n\nReply to answer.');
    expect(sent[1]).not.toContain('Reply to answer.');
  });

  it('a failing or null note costs nothing', async () => {
    for (const firstQuestionNote of [async () => null, async (): Promise<string | null> => { throw new Error('x'); }]) {
      const sessions = createAskSessions({ seqBase: 0, firstQuestionNote });
      sessions.register('demo', async () => ({ flow, onDone: async () => {} } as AskRun));
      const sent: string[] = [];
      await sessions.start('demo', async (t) => { sent.push(t); });
      expect(sent[0]).toBe('*Demo · 1 of 2*\nHow much?');
    }
  });
});

describe('createAskSessions', () => {
  it('starts a flow by id and sends its first question', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    expect(t.sent[0][0]).toBe('*Demo · 1 of 2*\nHow much?');
  });

  it('takes the next plain message as the answer and sends the next question', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.onText('25', t.send);
    expect(t.sent[1][0]).toContain('Which?');
  });

  it('re-asks with the hint on a bad answer', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.onText('lots', t.send);
    expect(t.sent[1][0]).toContain('⚠️ Numbers only.');
  });

  it('runs onDone with every answer after Save, and closes the question', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.onText('25', t.send);
    await t.sessions.onText('monthly', t.send);
    const save = lastButtons(t.sent)[0];
    await t.sessions.onCallback({ data: save }, t.ui);
    expect(t.done).toHaveBeenCalledWith({ amount: 25, kind: 'm' }, t.ui.send);
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toBe(NOT_WAITING);
  });

  it('edits a tapped question to show the choice, then sends the next screen as a new message', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.onText('25', t.send);
    const monthly = lastButtons(t.sent)[0];
    await t.sessions.onCallback({ data: monthly }, t.ui);
    expect(t.ui.edit).toHaveBeenCalledWith(expect.stringContaining('→ Monthly'));
    expect(t.ui.answer).toHaveBeenCalled();
    expect(t.sent[t.sent.length - 1][0]).toContain('25 m');
  });

  it('answers a button from an earlier question with "moved on" and changes nothing', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    const firstCancel = lastButtons(t.sent)[1];
    await t.sessions.onText('25', t.send);
    await t.sessions.onCallback({ data: firstCancel }, t.ui);
    expect(t.ui.answer).toHaveBeenCalledWith(ASK_MOVED_ON);
    await t.sessions.onText('monthly', t.send);
    expect(t.sent[t.sent.length - 1][0]).toContain('25 m');
  });

  it('cancels from the Cancel button and stops waiting', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    const cancel = lastButtons(t.sent)[1];
    await t.sessions.onCallback({ data: cancel }, t.ui);
    expect(t.ui.edit).toHaveBeenCalledWith(expect.stringContaining('→ Cancelled.'));
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toBe(NOT_WAITING);
  });

  it('expires after 15 minutes and names the command once', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    t.tick(15 * 60_000 + 1);
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toBe(expiredReply('pool'));
    expect(expiredReply('pool')).toBe('That question expired — send /pool again.');
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toBe(NOT_WAITING);
  });

  it('stays silent in a group when no question is open', async () => {
    const t = setup();
    await t.sessions.onText('hi', t.send, { privateChat: false });
    expect(t.sent).toHaveLength(0);
  });

  it('still names an expired command in a group', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    t.tick(15 * 60_000 + 1);
    await t.sessions.onText('25', t.send, { privateChat: false });
    expect(t.sent[t.sent.length - 1][0]).toBe(expiredReply('pool'));
  });

  it('keeps a question alive while answers keep coming', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    t.tick(10 * 60_000);
    await t.sessions.onText('25', t.send);
    t.tick(10 * 60_000);
    await t.sessions.onText('monthly', t.send);
    expect(t.sent[t.sent.length - 1][0]).toContain('25 m');
  });

  it('forgets an expired command an hour after it timed out', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    t.tick(15 * 60_000 + 60 * 60_000 + 2);
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toBe(NOT_WAITING);
  });

  it('a command clears the expiry notice', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    t.tick(15 * 60_000 + 1);
    expect(t.sessions.cancelForCommand()).toBe(false);
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toBe(NOT_WAITING);
  });

  it('says nothing is waiting when no question was ever asked', async () => {
    const t = setup();
    await t.sessions.onText('hello', t.send);
    expect(t.sent).toEqual([[NOT_WAITING, undefined]]);
  });

  it('cancelForCommand reports and drops an open question', async () => {
    const t = setup();
    expect(t.sessions.cancelForCommand()).toBe(false);
    await t.sessions.start('demo', t.send);
    expect(t.sessions.cancelForCommand()).toBe(true);
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toBe(NOT_WAITING);
  });

  it('replacing an open question says so on the new first question', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.start('demo', t.send);
    expect(t.sent[1][0]).toBe(`${CANCELLED_EARLIER}\n\n*Demo · 1 of 2*\nHow much?`);
  });

  it('starts a flow from a go: button as a new message', async () => {
    const t = setup();
    await t.sessions.onCallback({ data: 'cz:ak:go:demo' }, t.ui);
    expect(t.ui.answer).toHaveBeenCalled();
    expect(t.sent[0][0]).toContain('How much?');
  });

  it('passes a go: button\'s argument to the factory', async () => {
    const t = setup();
    const factory = vi.fn(async () => null);
    t.sessions.register('with-arg', factory);
    await t.sessions.onCallback({ data: 'cz:ak:go:with-arg:abc' }, t.ui);
    expect(factory).toHaveBeenCalledWith('abc', t.ui.send);
  });

  it('answers a go: button for an unknown flow without disturbing an open question', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.onCallback({ data: 'cz:ak:go:nope' }, t.ui);
    expect(t.sent[1][0]).toBe('That button is no longer available.');
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toContain('Which?');
  });

  it('a flow that cannot start leaves the open question answerable', async () => {
    const t = setup();
    t.sessions.register('blocked', async () => null);
    await t.sessions.start('demo', t.send);
    await t.sessions.start('blocked', t.send);
    expect(t.sent[t.sent.length - 1][0]).not.toContain(CANCELLED_EARLIER);
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toContain('Which?');
  });

  it('a failing edit cannot strand Save: onDone still runs once', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.onText('25', t.send);
    await t.sessions.onText('monthly', t.send);
    const failingEdit = { ...t.ui, edit: vi.fn(async () => { throw new Error('edit gone'); }) };
    await t.sessions.onCallback({ data: lastButtons(t.sent)[0] }, failingEdit);
    expect(t.done).toHaveBeenCalledTimes(1);
    expect(t.done).toHaveBeenCalledWith({ amount: 25, kind: 'm' }, t.ui.send);
  });

  it('answers a tap with nothing open as moved on, not expired', async () => {
    const t = setup();
    await t.sessions.onCallback({ data: 'cz:ak:abc:0:x' }, t.ui);
    expect(t.ui.answer).toHaveBeenCalledWith(ASK_MOVED_ON);
  });

  it('says expired only when an expiry is remembered', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    t.tick(15 * 60_000 + 1);
    await t.sessions.onCallback({ data: 'cz:ak:abc:0:x' }, t.ui);
    expect(t.ui.answer).toHaveBeenCalledWith('That question expired.');
  });

  it('says moved on after a flow finished or was cancelled', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.onText('cancel', t.send);
    await t.sessions.onCallback({ data: 'cz:ak:abc:0:x' }, t.ui);
    expect(t.ui.answer).toHaveBeenCalledWith(ASK_MOVED_ON);
  });

  it('typed cancel closes the question and says so', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.onText('Stop', t.send);
    expect(t.sent[t.sent.length - 1][0]).toBe('Cancelled.');
    await t.sessions.onText('25', t.send);
    expect(t.sent[t.sent.length - 1][0]).toBe(NOT_WAITING);
  });

  it('typed back returns to the previous question', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    await t.sessions.onText('25', t.send);
    await t.sessions.onText('back', t.send);
    expect(t.sent[t.sent.length - 1][0]).toContain('How much?');
  });

  it('only claims cz:ak: data', () => {
    const t = setup();
    expect(t.sessions.handles('cz:ak:go:demo')).toBe(true);
    expect(t.sessions.handles('cz:fx:o')).toBe(false);
  });

  it('reports a failing onDone instead of throwing', async () => {
    const t = setup();
    t.done.mockRejectedValueOnce(new Error('boom'));
    await t.sessions.start('demo', t.send);
    await t.sessions.onText('25', t.send);
    await t.sessions.onText('monthly', t.send);
    await t.sessions.onCallback({ data: lastButtons(t.sent)[0] }, t.ui);
    expect(t.sent[t.sent.length - 1][0]).toBe('Something went wrong finishing that — check the companion logs.');
  });

  it('escapes a user-supplied choice label in the echo', async () => {
    const t = setup();
    t.sessions.register('cats', async () => ({
      flow: { id: 'cats', command: 'newrule', title: 'Cats', steps: [
        { id: 'c', kind: 'choice', prompt: () => 'Which?', options: () => [{ label: 'Food_Drink', value: 1 }] },
      ] },
      onDone: async () => {},
    }));
    await t.sessions.start('cats', t.send);
    await t.sessions.onCallback({ data: lastButtons(t.sent)[0] }, t.ui);
    expect(t.ui.edit).toHaveBeenCalledWith(expect.stringContaining('→ Food\\_Drink'));
  });
});
