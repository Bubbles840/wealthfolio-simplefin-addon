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

  it('keeps a question alive while answers keep coming', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    t.tick(10 * 60_000);
    await t.sessions.onText('25', t.send);
    t.tick(10 * 60_000);
    await t.sessions.onText('monthly', t.send);
    expect(t.sent[t.sent.length - 1][0]).toContain('25 m');
  });

  it('forgets an expired command after an hour', async () => {
    const t = setup();
    await t.sessions.start('demo', t.send);
    t.tick(15 * 60_000 + 1);
    await t.sessions.cancelForCommand();      // first look marks it expired
    t.tick(60 * 60_000 + 1);
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

  it('answers a go: button for an unknown flow without throwing', async () => {
    const t = setup();
    await t.sessions.onCallback({ data: 'cz:ak:go:nope' }, t.ui);
    expect(t.sent[0][0]).toBe('That button is no longer available.');
  });

  it('answers a tap on a question that no longer exists', async () => {
    const t = setup();
    await t.sessions.onCallback({ data: 'cz:ak:abc:0:x' }, t.ui);
    expect(t.ui.answer).toHaveBeenCalledWith('That question expired.');
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
