import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { startTelegramListener, type TelegramListenerDeps } from './telegram-listener.js';
import { TELEGRAM_COMMAND_MENU } from '../../shared/telegram-commands.js';

const CHAT_ID = '42';

/** Derived from the dep, never re-declared, so a test cannot assert against a
 *  shape the listener no longer hands out. */
type MenuHandler = NonNullable<TelegramListenerDeps['onMenuCallback']>;
type MenuCallback = Parameters<MenuHandler>[0];
type MenuUi = Parameters<MenuHandler>[1];

/** Same fake-fetch shape `dismissals.test.ts` uses: an object with `json()`. */
const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body });
const updatesResponse = (result: unknown[]) => jsonResponse({ ok: true, result });
/** What `sendMessage` / `answerCallbackQuery` / `setMyCommands` return on success. */
const apiOkResponse = () => jsonResponse({ ok: true, result: true });

/**
 * Drives the listener by yielding MICROTASKS only.
 *
 * Every injected dep resolves immediately, so a running listener never yields to
 * the macrotask queue — a `setTimeout`/`setImmediate`-based wait here would never
 * be reached and the suite would hang (the same class of hang Task 4 hit). The
 * tick budget is the second half of that guarantee: a predicate that never comes
 * true fails loudly instead of spinning the event loop forever, which no vitest
 * timeout could interrupt.
 */
async function waitFor(label: string, predicate: () => boolean, budgetTicks = 5000): Promise<void> {
  for (let i = 0; i < budgetTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`waitFor(${label}) never became true within ${budgetTicks} microtask ticks`);
}

/** Lets the listener make whatever progress it can, for proving that it makes NONE. */
async function drainTicks(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/**
 * A fetch implementation that answers by URL instead of by call order.
 *
 * The menu-callback tests interleave `editMessageText` / `answerCallbackQuery` /
 * `sendMessage` requests BETWEEN polls, and an ordered `mockResolvedValueOnce`
 * chain would bake that interleaving into the test — so a harmless change in how
 * many calls a screen makes would break tests that are not about ordering.
 * `batches` are served to successive `getUpdates` calls; every later poll gets an
 * empty batch, which is the normal long-poll timeout.
 */
function pollingRoute(
  batches: unknown[][],
  overrides: Record<string, () => Promise<unknown>> = {},
): (url: unknown) => Promise<unknown> {
  const queue = [...batches];
  return async (url: unknown) => {
    const u = String(url);
    for (const [fragment, handler] of Object.entries(overrides)) {
      if (u.includes(fragment)) return handler();
    }
    if (u.includes('/getUpdates')) return updatesResponse(queue.shift() ?? []);
    return apiOkResponse();
  };
}

function harness(overrides: Partial<TelegramListenerDeps> = {}) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  const fetchImpl = vi.fn();
  const readConfig = vi.fn(async () => ({ botToken: 'T', chatId: CHAT_ID }));
  const readOffset = vi.fn(async () => null as number | null);
  const writeOffset = vi.fn(async (_n: number) => {});
  const applyDismissal = vi.fn(async (_id: string) => {});
  const onCommand = vi.fn(async (_cmd: any, _reply: (t: string) => Promise<void>) => {});

  const deps: TelegramListenerDeps = {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    log: (msg: string) => { logs.push(msg); },
    readConfig: readConfig as unknown as TelegramListenerDeps['readConfig'],
    readOffset,
    writeOffset,
    applyDismissal,
    onCommand: onCommand as unknown as TelegramListenerDeps['onCommand'],
    sleep: vi.fn(async (ms: number) => { sleeps.push(ms); }),
    ...overrides,
  };

  const calls = (fragment: string) => fetchImpl.mock.calls.filter((c) => String(c[0]).includes(fragment));
  // Read off `deps`, never off the locals above: an override must be the spy the
  // assertions see, or a test can pass while watching a dep nothing ever called.
  return {
    deps,
    fetchImpl,
    sleeps,
    logs,
    calls,
    readConfig: deps.readConfig as unknown as typeof readConfig,
    readOffset: deps.readOffset as unknown as typeof readOffset,
    writeOffset: deps.writeOffset as unknown as typeof writeOffset,
    applyDismissal: deps.applyDismissal as unknown as typeof applyDismissal,
    onCommand: deps.onCommand as unknown as typeof onCommand,
  };
}

/**
 * Starts the listener and guarantees it is stopped even when an assertion throws
 * first. A listener left running is an infinite loop that keeps allocating into
 * the fetch spy's call list, which OOMs the whole FILE instead of failing one
 * test — observed while producing the RED evidence for this fix round. `stop()`
 * is idempotent, so tests that stop explicitly still work.
 */
function start(deps: TelegramListenerDeps): { stop: () => Promise<void> } {
  const listener = startTelegramListener(deps);
  onTestFinished(() => listener.stop());
  return listener;
}

const messageUpdate = (updateId: number, text: string, chatId: number | undefined = Number(CHAT_ID)) => ({
  update_id: updateId,
  message: { chat: chatId === undefined ? undefined : { id: chatId }, text },
});

/** A button tap as Telegram sends one, carrying the message it was tapped on. */
const callbackUpdate = (
  updateId: number,
  data: string,
  { id = 'cb-1', chatId = Number(CHAT_ID), messageId = 909 }: { id?: string; chatId?: number; messageId?: number } = {},
) => ({
  update_id: updateId,
  callback_query: { id, data, message: { chat: { id: chatId }, message_id: messageId } },
});

/** The body of the Nth matching POST, parsed. */
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as { body?: string } | undefined)?.body ?? '{}'));

describe('startTelegramListener — no config', () => {
  it('sleeps 60s and re-reads instead of ever touching the network', async () => {
    const h = harness({ readConfig: vi.fn(async () => null) });
    const listener = start(h.deps);

    await waitFor('two idle sleeps', () => h.sleeps.length >= 2);
    await listener.stop();

    expect(h.sleeps.slice(0, 2)).toEqual([60_000, 60_000]);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.readConfig.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('startTelegramListener — polling and the offset', () => {
  it('long-polls getUpdates with timeout=50, both update kinds, and the stored offset', async () => {
    const h = harness({ readOffset: vi.fn(async () => 500) });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())                            // setMyCommands
      .mockResolvedValueOnce(updatesResponse([messageUpdate(700, 'hi')]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('offset written', () => h.writeOffset.mock.calls.length >= 1);
    await listener.stop();

    const url = new URL(String(h.calls('/getUpdates')[0][0]));
    expect(url.pathname).toBe('/botT/getUpdates');
    expect(url.searchParams.get('timeout')).toBe('50');
    expect(url.searchParams.get('allowed_updates')).toBe('["message","callback_query"]');
    expect(url.searchParams.get('offset')).toBe('500');
    // maxUpdateId + 1, so Telegram never re-serves what we already handled.
    expect(h.writeOffset).toHaveBeenCalledWith(701);
  });

  it('reads the persisted offset once and then carries it forward in memory', async () => {
    const h = harness({ readOffset: vi.fn(async () => 10) });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([messageUpdate(11, 'hi')]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('two polls', () => h.calls('/getUpdates').length >= 2);
    await listener.stop();

    expect(h.readOffset).toHaveBeenCalledTimes(1);
    const second = new URL(String(h.calls('/getUpdates')[1][0]));
    expect(second.searchParams.get('offset')).toBe('12');
  });

  it('drops messages from a foreign chat, advances the offset anyway, and logs that chat once', async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([
        messageUpdate(1, '/report', 99),
        messageUpdate(2, '/left', 99),
      ]))
      .mockResolvedValueOnce(updatesResponse([messageUpdate(3, '/status', 99)]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('both batches consumed', () => h.writeOffset.mock.calls.length >= 2);
    await listener.stop();

    expect(h.onCommand).not.toHaveBeenCalled();
    expect(h.writeOffset).toHaveBeenCalledWith(3);
    expect(h.writeOffset).toHaveBeenCalledWith(4);
    // Once per chat id per process: a stranger spamming the bot must not fill the log.
    expect(h.logs.filter((l) => l.includes('99'))).toHaveLength(1);
  });
});

describe('startTelegramListener — command dispatch', () => {
  it('dispatches a parsed command and replies through sendMessage', async () => {
    const h = harness({
      onCommand: vi.fn(async (_cmd: any, reply: (t: string) => Promise<void>) => { await reply('all good'); }) as any,
    });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([messageUpdate(5, '/afford  20 shopping ')]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('reply sent', () => h.calls('/sendMessage').length >= 1);
    await listener.stop();

    expect(h.onCommand.mock.calls[0][0]).toEqual({ command: 'afford', args: '20 shopping' });
    const send = h.calls('/sendMessage')[0];
    expect(String(send[0])).toContain('/botT/sendMessage');
    expect(bodyOf(send)).toMatchObject({ chat_id: CHAT_ID, text: 'all good', parse_mode: 'Markdown' });
  });

  it('passes the configured bot name through, so /cmd@OtherBot is not answered', async () => {
    const h = harness({ readConfig: vi.fn(async () => ({ botToken: 'T', chatId: CHAT_ID, botName: 'MyBot' })) as any });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([messageUpdate(6, '/report@SomeoneElsesBot')]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('batch consumed', () => h.writeOffset.mock.calls.length >= 1);
    await listener.stop();

    expect(h.onCommand).not.toHaveBeenCalled();
    expect(h.writeOffset).toHaveBeenCalledWith(7);
  });

  it('drops non-command chatter but still advances the offset', async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([messageUpdate(8, 'what is left?')]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('batch consumed', () => h.writeOffset.mock.calls.length >= 1);
    await listener.stop();

    expect(h.onCommand).not.toHaveBeenCalled();
    expect(h.calls('/sendMessage')).toHaveLength(0);
    expect(h.writeOffset).toHaveBeenCalledWith(9);
  });
});

// Ported from dismissals.test.ts's pollTelegramDismissals cases: the `d:<activityId>`
// payload is a data contract with buildDismissKeyboard (shared/telegram.ts), and
// these assertions are what keeps it pinned once that poll function is deleted.
describe('startTelegramListener — dismiss callbacks', () => {
  it('applies d:<activityId> callbacks, answers each, and advances the offset', async () => {
    const h = harness({ readOffset: vi.fn(async () => 50) });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([
        { update_id: 100, callback_query: { id: 'cb-1', data: 'd:act-1' } },
        { update_id: 101, callback_query: { id: 'cb-2', data: 'd:act-2' } },
      ]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('both dismissals applied', () => h.applyDismissal.mock.calls.length >= 2);
    await listener.stop();

    expect(h.applyDismissal.mock.calls.map((c) => c[0])).toEqual(['act-1', 'act-2']);
    expect(h.writeOffset).toHaveBeenCalledWith(102);

    const answered = h.calls('/answerCallbackQuery');
    expect(answered).toHaveLength(2);
    const first = new URL(String(answered[0][0]));
    expect(first.searchParams.get('callback_query_id')).toBe('cb-1');
    // User-visible text, byte-identical to what the shipped build already sends.
    expect(first.searchParams.get('text')).toBe('Dismissed — dropped from future notices');
  });

  it('advances past non-dismiss callback data without applying anything', async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([
        { update_id: 7, message: { chat: { id: Number(CHAT_ID) }, text: 'hello bot' } },
        { update_id: 8, callback_query: { id: 'cb-3', data: 'unrelated' } },
      ]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('batch consumed', () => h.writeOffset.mock.calls.length >= 1);
    await listener.stop();

    expect(h.applyDismissal).not.toHaveBeenCalled();
    expect(h.calls('/answerCallbackQuery')).toHaveLength(0);
    // The offset still moves, or these updates would be re-fetched forever.
    expect(h.writeOffset).toHaveBeenCalledWith(9);
  });

  it('survives a failing applyDismissal: logged, offset still advances, loop continues', async () => {
    const h = harness({ applyDismissal: vi.fn(async () => { throw new Error('secret write refused'); }) as any });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([{ update_id: 20, callback_query: { id: 'cb-9', data: 'd:act-9' } }]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('two polls after the failure', () => h.calls('/getUpdates').length >= 3);
    await listener.stop();

    expect(h.writeOffset).toHaveBeenCalledWith(21);
    expect(h.logs.some((l) => l.includes('secret write refused'))).toBe(true);
  });
});

// The `cz:` payload is a data contract with shared/categorize-menu.ts
// (MENU_CALLBACK_PREFIX). These cases pin the ROUTING and the never-rejecting UI
// only: what a screen says and which button does what lives in that module and
// its own tests.
describe('startTelegramListener — categorize menu callbacks', () => {
  it('routes a cz: tap to onMenuCallback with its data, chat id and message id', async () => {
    const taps: MenuCallback[] = [];
    const onMenuCallback = vi.fn(async (cb: MenuCallback) => { taps.push(cb); });
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(200, 'cz:3', { id: 'cb-7', messageId: 909 })]]));

    const listener = start(h.deps);
    await waitFor('tap routed', () => taps.length >= 1);
    await listener.stop();

    expect(taps[0]).toEqual({ data: 'cz:3', chatId: Number(CHAT_ID), messageId: 909 });
    // A menu tap is not a dismissal: the ledger must not be touched.
    expect(h.applyDismissal).not.toHaveBeenCalled();
    expect(h.writeOffset).toHaveBeenCalledWith(201);
  });

  it('answers a cz: tap with an expiry notice when no menu controller is wired up', async () => {
    // What ships before the controller exists: the button must not spin forever.
    const h = harness();
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(210, 'cz:1', { id: 'cb-8' })]]));

    const listener = start(h.deps);
    await waitFor('tap answered', () => h.calls('/answerCallbackQuery').length >= 1);
    await waitFor('offset advanced', () => h.writeOffset.mock.calls.length >= 1);
    await listener.stop();

    const url = new URL(String(h.calls('/answerCallbackQuery')[0][0]));
    expect(url.searchParams.get('callback_query_id')).toBe('cb-8');
    expect(url.searchParams.get('text')).toBe('That menu expired — send /categorize again.');
    expect(h.writeOffset).toHaveBeenCalledWith(211);
    expect(h.applyDismissal).not.toHaveBeenCalled();
  });

  it('survives a throwing menu controller: logged, offset advances, polling continues', async () => {
    const onMenuCallback = vi.fn(async () => { throw new Error('menu controller exploded'); });
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(220, 'cz:2')]]));

    const listener = start(h.deps);
    await waitFor('polling continued', () => h.calls('/getUpdates').length >= 3);
    await listener.stop();

    expect(h.logs.some((l) => l.includes('menu controller exploded'))).toBe(true);
    expect(h.writeOffset).toHaveBeenCalledWith(221);
    // A handler failure is not a transport failure: nothing to back off from.
    expect(h.sleeps).toEqual([]);
  });

  it('hands the controller edit/answer/send callbacks that never reject when every request fails', async () => {
    // The Task 5 pattern: a controller may fire these without awaiting them, so a
    // rejection here would be an unhandled rejection — which kills the daemon.
    let fired: Promise<void>[] = [];
    const onMenuCallback = vi.fn(async (_cb: MenuCallback, ui: MenuUi) => {
      fired = [ui.edit('new screen'), ui.answer('toast'), ui.send('a fresh message')];
    });
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(230, 'cz:4')]], {
      '/editMessageText': async () => { throw new Error('editMessageText unreachable'); },
      '/answerCallbackQuery': async () => { throw new Error('answerCallbackQuery unreachable'); },
      '/sendMessage': async () => { throw new Error('sendMessage unreachable'); },
    }));

    const listener = start(h.deps);
    await waitFor('all three fired', () => fired.length === 3);
    for (const p of fired) await expect(p).resolves.toBeUndefined();
    await waitFor('polling continued', () => h.calls('/getUpdates').length >= 3);
    await listener.stop();

    expect(h.logs.some((l) => l.includes('editMessageText unreachable'))).toBe(true);
    expect(h.logs.some((l) => l.includes('answerCallbackQuery unreachable'))).toBe(true);
    expect(h.logs.some((l) => l.includes('sendMessage unreachable'))).toBe(true);
    expect(h.writeOffset).toHaveBeenCalledWith(231);
  });

  it('swallows Telegram\'s "message is not modified" refusal on a no-op edit, with no retry', async () => {
    // Routine, not exceptional: a user double-tapping the same button produces it.
    let edit: Promise<void> | null = null;
    const onMenuCallback = vi.fn(async (_cb: MenuCallback, ui: MenuUi) => { edit = ui.edit('the same text'); });
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(240, 'cz:5')]], {
      '/editMessageText': async () => jsonResponse({
        ok: false,
        error_code: 400,
        description: 'Bad Request: message is not modified',
      }),
    }));

    const listener = start(h.deps);
    await waitFor('edit fired', () => edit !== null);
    await expect(edit!).resolves.toBeUndefined();
    await waitFor('polling continued', () => h.calls('/getUpdates').length >= 3);
    await listener.stop();

    expect(h.calls('/editMessageText')).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('edits the tapped message in place, sending reply_markup only when given a keyboard', async () => {
    const keyboard = { inline_keyboard: [[{ text: 'Groceries', callback_data: 'cz:1' }]] };
    const onMenuCallback = vi.fn(async (_cb: MenuCallback, ui: MenuUi) => {
      await ui.edit('*Pick a category*', keyboard);
      await ui.edit('Filed.');
    });
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(250, 'cz:6', { messageId: 4321 })]]));

    const listener = start(h.deps);
    await waitFor('both edits sent', () => h.calls('/editMessageText').length >= 2);
    await listener.stop();

    expect(String(h.calls('/editMessageText')[0][0])).toContain('/botT/editMessageText');
    const bodies = h.calls('/editMessageText').map(bodyOf);
    expect(bodies[0]).toEqual({
      chat_id: Number(CHAT_ID),
      message_id: 4321,
      text: '*Pick a category*',
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
    // A final screen drops the keyboard by OMITTING the key, which is what
    // Telegram reads as "no buttons" — `reply_markup: undefined` is not.
    expect('reply_markup' in bodies[1]).toBe(false);
    expect(bodies[1]).toEqual({
      chat_id: Number(CHAT_ID),
      message_id: 4321,
      text: 'Filed.',
      parse_mode: 'Markdown',
    });
  });

  it('answers with no text at all when the controller only needs the spinner cleared', async () => {
    const onMenuCallback = vi.fn(async (_cb: MenuCallback, ui: MenuUi) => { await ui.answer(); });
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(260, 'cz:7', { id: 'cb-11' })]]));

    const listener = start(h.deps);
    await waitFor('answered', () => h.calls('/answerCallbackQuery').length >= 1);
    await listener.stop();

    const url = new URL(String(h.calls('/answerCallbackQuery')[0][0]));
    expect(url.searchParams.get('callback_query_id')).toBe('cb-11');
    expect(url.searchParams.has('text')).toBe(false);
  });

  it('sends a fresh message through ui.send, mirroring reply plus an optional keyboard', async () => {
    const keyboard = { inline_keyboard: [[{ text: 'Next', callback_data: 'cz:2' }]] };
    const onMenuCallback = vi.fn(async (_cb: MenuCallback, ui: MenuUi) => { await ui.send('a new menu', keyboard); });
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(270, 'cz:8')]]));

    const listener = start(h.deps);
    await waitFor('message sent', () => h.calls('/sendMessage').length >= 1);
    await listener.stop();

    expect(bodyOf(h.calls('/sendMessage')[0])).toEqual({
      chat_id: CHAT_ID,
      text: 'a new menu',
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
  });

  it('never routes a cz: tap from a foreign chat, and still advances the offset', async () => {
    const onMenuCallback = vi.fn(async () => {});
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(280, 'cz:9', { chatId: 99 })]]));

    const listener = start(h.deps);
    await waitFor('batch consumed', () => h.writeOffset.mock.calls.length >= 1);
    await listener.stop();

    expect(onMenuCallback).not.toHaveBeenCalled();
    expect(h.calls('/answerCallbackQuery')).toHaveLength(0);
    expect(h.calls('/editMessageText')).toHaveLength(0);
    // A stranger cannot wedge the update stream by tapping a button.
    expect(h.writeOffset).toHaveBeenCalledWith(281);
    expect(h.logs.filter((l) => l.includes('99'))).toHaveLength(1);
  });

  it('drops a cz: tap that carries no chat at all, unlike a dismissal', async () => {
    // A menu tap is answered by EDITING the message it came from, so a callback
    // with no message is both unauthorizable and unactionable. A dismissal is
    // neither — it only needs the activity id — and keeps its existing behavior.
    const onMenuCallback = vi.fn(async () => {});
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([
      [{ update_id: 290, callback_query: { id: 'cb-12', data: 'cz:10' } }],
    ]));

    const listener = start(h.deps);
    await waitFor('batch consumed', () => h.writeOffset.mock.calls.length >= 1);
    await listener.stop();

    expect(onMenuCallback).not.toHaveBeenCalled();
    expect(h.writeOffset).toHaveBeenCalledWith(291);
  });

  it('routes d: to the dismissal ledger and cz: to the menu, never crossing over', async () => {
    const onMenuCallback = vi.fn(async () => {});
    const h = harness({ onMenuCallback });
    h.fetchImpl.mockImplementation(pollingRoute([[
      callbackUpdate(300, 'd:act-42', { id: 'cb-a' }),
      callbackUpdate(301, 'cz:11', { id: 'cb-b' }),
      callbackUpdate(302, 'something-else', { id: 'cb-c' }),
    ]]));

    const listener = start(h.deps);
    await waitFor('both routed', () => h.applyDismissal.mock.calls.length >= 1 && onMenuCallback.mock.calls.length >= 1);
    await listener.stop();

    expect(h.applyDismissal.mock.calls.map((c) => c[0])).toEqual(['act-42']);
    expect(onMenuCallback.mock.calls.map((c) => (c[0] as MenuCallback).data)).toEqual(['cz:11']);
    expect(h.writeOffset).toHaveBeenCalledWith(303);
  });
});

describe('startTelegramListener — undo for dismissals', () => {
  /** A callback whose message still carries its keyboard, as Telegram sends
   *  for a tap on a live notice. */
  const tapWithKeyboard = (updateId: number, data: string, keyboard: unknown, id = 'cb-k') => ({
    update_id: updateId,
    callback_query: {
      id, data,
      message: { chat: { id: Number(CHAT_ID) }, message_id: 909, reply_markup: { inline_keyboard: keyboard } },
    },
  });
  const noticeKeyboard = [
    [{ text: 'Dismiss: Frame It Easy $88.89', callback_data: 'd:act-42' }],
    [{ text: 'Dismiss: The Post $105.74', callback_data: 'd:act-43' }],
    [{ text: 'Categorize these', callback_data: 'cz:entry' }],
  ];

  it('turns the tapped Dismiss button into Undo and leaves the rest alone', async () => {
    // A dismissal was one tap with no way back, on a button right under a
    // thumb. The notice itself becomes the way back, so there is nothing new
    // to find.
    const h = harness();
    h.fetchImpl.mockImplementation(pollingRoute([[tapWithKeyboard(400, 'd:act-42', noticeKeyboard)]]));
    const listener = start(h.deps);
    await waitFor('keyboard edited', () => h.calls('/editMessageReplyMarkup').length >= 1);
    await listener.stop();

    expect(h.applyDismissal).toHaveBeenCalledWith('act-42');
    const body = bodyOf(h.calls('/editMessageReplyMarkup')[0]);
    expect(body.message_id).toBe(909);
    expect(body.reply_markup.inline_keyboard).toEqual([
      [{ text: '↩ Undo: Frame It Easy $88.89', callback_data: 'u:act-42' }],
      [{ text: 'Dismiss: The Post $105.74', callback_data: 'd:act-43' }],
      [{ text: 'Categorize these', callback_data: 'cz:entry' }],
    ]);
  });

  it('restores on an Undo tap and turns the button back into Dismiss', async () => {
    const undoDismissal = vi.fn(async () => {});
    const h = harness({ undoDismissal });
    const undone = [[{ text: '↩ Undo: Frame It Easy $88.89', callback_data: 'u:act-42' }]];
    h.fetchImpl.mockImplementation(pollingRoute([[tapWithKeyboard(401, 'u:act-42', undone)]]));
    const listener = start(h.deps);
    await waitFor('keyboard edited', () => h.calls('/editMessageReplyMarkup').length >= 1);
    await listener.stop();

    expect(undoDismissal).toHaveBeenCalledWith('act-42');
    expect(h.applyDismissal).not.toHaveBeenCalled();
    expect(String(h.calls('/answerCallbackQuery')[0][0])).toContain('Restored');
    expect(bodyOf(h.calls('/editMessageReplyMarkup')[0]).reply_markup.inline_keyboard).toEqual([
      [{ text: 'Dismiss: Frame It Easy $88.89', callback_data: 'd:act-42' }],
    ]);
  });

  it('answers honestly, without writing, when no undo is wired up', async () => {
    // An older daemon, or a harness without the dep: the tap must not crash
    // the loop and must not claim anything was restored.
    const h = harness();
    h.fetchImpl.mockImplementation(pollingRoute([[callbackUpdate(402, 'u:act-42', { id: 'cb-n' })]]));
    const listener = start(h.deps);
    await waitFor('answered', () => h.calls('/answerCallbackQuery').length >= 1);
    await listener.stop();
    expect(String(h.calls('/answerCallbackQuery')[0][0])).toContain('not+available');
    expect(h.applyDismissal).not.toHaveBeenCalled();
    expect(h.writeOffset).toHaveBeenCalledWith(403);
  });

  it('keeps a failed undo silent and leaves the button as Undo', async () => {
    const h = harness({ undoDismissal: vi.fn(async () => { throw new Error('secret write refused'); }) });
    const undone = [[{ text: '↩ Undo: X $1.00', callback_data: 'u:act-9' }]];
    h.fetchImpl.mockImplementation(pollingRoute([[tapWithKeyboard(403, 'u:act-9', undone)]]));
    const listener = start(h.deps);
    await waitFor('logged', () => h.logs.some((l) => l.includes('undo of dismissal act-9 failed')));
    await listener.stop();
    expect(h.calls('/answerCallbackQuery')).toHaveLength(0);
    expect(h.calls('/editMessageReplyMarkup')).toHaveLength(0);
  });
});

describe('startTelegramListener — replies that carry a keyboard', () => {
  it('threads a handler\'s keyboard into sendMessage as reply_markup', async () => {
    const keyboard = { inline_keyboard: [[{ text: 'Coffee', callback_data: 'cz:0' }]] };
    const h = harness({
      onCommand: vi.fn(async (_cmd: any, reply: (t: string, k?: unknown) => Promise<void>) => {
        await reply('*3 need a category*', keyboard);
      }) as any,
    });
    h.fetchImpl.mockImplementation(pollingRoute([[messageUpdate(310, '/categorize')]]));

    const listener = start(h.deps);
    await waitFor('reply sent', () => h.calls('/sendMessage').length >= 1);
    await listener.stop();

    expect(bodyOf(h.calls('/sendMessage')[0])).toEqual({
      chat_id: CHAT_ID,
      text: '*3 need a category*',
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });
  });

  it('omits reply_markup entirely for the one-argument reply every existing handler uses', async () => {
    // Byte-identical to what the shipped build sends: the key is ABSENT, not
    // present-and-undefined, so no existing command's message changes shape.
    const h = harness({
      onCommand: vi.fn(async (_cmd: any, reply: (t: string) => Promise<void>) => { await reply('plain'); }) as any,
    });
    h.fetchImpl.mockImplementation(pollingRoute([[messageUpdate(320, '/report')]]));

    const listener = start(h.deps);
    await waitFor('reply sent', () => h.calls('/sendMessage').length >= 1);
    await listener.stop();

    const body = bodyOf(h.calls('/sendMessage')[0]);
    expect('reply_markup' in body).toBe(false);
    expect(body).toEqual({
      chat_id: CHAT_ID,
      text: 'plain',
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  });
});

describe('startTelegramListener — a throwing handler cannot kill the loop', () => {
  it('apologizes, logs the real error, and keeps polling', async () => {
    const h = harness({
      onCommand: vi.fn(async () => { throw new Error('database is locked'); }) as any,
    });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([messageUpdate(30, '/report')]))
      .mockResolvedValueOnce(apiOkResponse())                              // the apology
      .mockResolvedValueOnce(updatesResponse([messageUpdate(31, '/status')]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('second command dispatched', () => h.onCommand.mock.calls.length >= 2);
    await listener.stop();

    const apology = h.calls('/sendMessage');
    expect(bodyOf(apology[0]).text).toBe('Something went wrong running that command — check the companion logs.');
    expect(h.logs.some((l) => l.includes('database is locked'))).toBe(true);
    expect(h.writeOffset).toHaveBeenCalledWith(31);
    expect(h.writeOffset).toHaveBeenCalledWith(32);
  });

  it('keeps polling even when the apology itself cannot be delivered', async () => {
    const h = harness({ onCommand: vi.fn(async () => { throw new Error('handler exploded'); }) as any });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([messageUpdate(40, '/report')]))
      .mockRejectedValueOnce(new Error('sendMessage unreachable'))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('polling resumed', () => h.calls('/getUpdates').length >= 3);
    await listener.stop();

    expect(h.writeOffset).toHaveBeenCalledWith(41);
  });
});

describe('startTelegramListener — backoff', () => {
  it('backs off 1s, 2s, 4s on transport errors and resets after a success', async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(updatesResponse([]))                          // success resets the ladder
      .mockRejectedValueOnce(new Error('network down again'))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('four backoff sleeps', () => h.sleeps.length >= 4);
    await listener.stop();

    expect(h.sleeps.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 1_000]);
    expect(h.logs.some((l) => l.includes('network down'))).toBe(true);
  });

  it('caps the backoff at 60s', async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockRejectedValue(new Error('network down'));

    const listener = start(h.deps);
    await waitFor('eight backoff sleeps', () => h.sleeps.length >= 8);
    await listener.stop();

    expect(h.sleeps.slice(0, 8)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  it('names a rival getUpdates consumer on 409 so "the bot ignores me" is diagnosable', async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error_code: 409,
        description: 'Conflict: terminated by other getUpdates request',
      }))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('one backoff sleep', () => h.sleeps.length >= 1);
    await listener.stop();

    expect(h.logs.some((l) => l.includes('another getUpdates consumer'))).toBe(true);
    expect(h.sleeps[0]).toBe(1_000);
    expect(h.writeOffset).not.toHaveBeenCalled();
  });
});

describe('startTelegramListener — the loop outlives its own dependencies', () => {
  it('keeps looping when sleep itself rejects, instead of dying inside the catch', async () => {
    // A rejecting sleep awaited inside the loop's catch would take control out of
    // the while entirely: dead listener, one log line, nothing to restart it.
    const h = harness({ sleep: vi.fn(async () => { throw new Error('sleep aborted'); }) });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(updatesResponse([messageUpdate(60, '/report')]));

    const listener = start(h.deps);
    await waitFor('polling after the failed sleep', () => h.onCommand.mock.calls.length >= 1);
    await listener.stop();

    expect(h.logs.some((l) => l.includes('sleep aborted'))).toBe(true);
    expect(h.calls('/getUpdates').length).toBeGreaterThanOrEqual(2);
  });

  it('never hands a handler a reply callback that can reject', async () => {
    // A handler firing a reply without awaiting it must not leave a rejected
    // promise behind — that is an unhandled rejection, which kills the daemon.
    let fireAndForget: Promise<void> | null = null;
    const h = harness({
      onCommand: vi.fn(async (_cmd: any, reply: (t: string) => Promise<void>) => {
        fireAndForget = reply('never arrives');
      }) as any,
    });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([messageUpdate(70, '/report')]))
      .mockRejectedValueOnce(new Error('sendMessage unreachable'))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('polling continued', () => h.calls('/getUpdates').length >= 3);
    await listener.stop();

    await expect(fireAndForget!).resolves.toBeUndefined();
    expect(h.logs.some((l) => l.includes('sendMessage unreachable'))).toBe(true);
    // Not an apology case: the handler itself never threw.
    expect(h.writeOffset).toHaveBeenCalledWith(71);
  });

  it('survives a logger that throws on every call, stacked on a rejecting sleep', async () => {
    // Pins all three places a throwing `deps.log` could escape at once: the catch
    // inside pause(), the loop's own catch, and the fire-and-forget reply's catch.
    // Each of those catches exists to stop something worse, so a throw from the
    // log call inside one re-creates exactly what it was written to prevent.
    let fireAndForget: Promise<void> | null = null;
    const h = harness({
      log: () => { throw new Error('logger is broken'); },
      sleep: vi.fn(async () => { throw new Error('sleep aborted'); }),
      onCommand: vi.fn(async (_cmd: any, reply: (t: string) => Promise<void>) => {
        fireAndForget = reply('never arrives');
      }) as any,
    });
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())                               // setMyCommands
      .mockRejectedValueOnce(new Error('network down'))                     // loop catch → log throws → pause → sleep rejects → log throws
      .mockResolvedValueOnce(updatesResponse([messageUpdate(80, '/report')]))
      .mockRejectedValueOnce(new Error('sendMessage unreachable'))          // safeReply catch → log throws
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('still polling past all three', () => h.calls('/getUpdates').length >= 3);

    await expect(fireAndForget!).resolves.toBeUndefined();
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it('throttles a batch whose updates carry no update_id instead of re-fetching hot', async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([{ message: { chat: { id: Number(CHAT_ID) }, text: '/report' } }]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('the spin was throttled', () => h.sleeps.length >= 1);
    await listener.stop();

    expect(h.sleeps[0]).toBe(1_000);
    expect(h.writeOffset).not.toHaveBeenCalled();
    expect(h.logs.some((l) => l.includes('no update_id'))).toBe(true);
  });
});

describe('startTelegramListener — setMyCommands', () => {
  it('registers the menu once per token, not once per config re-read', async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('several polls', () => h.calls('/getUpdates').length >= 3);
    await listener.stop();

    const registrations = h.calls('/setMyCommands');
    expect(registrations).toHaveLength(1);
    expect(bodyOf(registrations[0]).commands).toEqual(TELEGRAM_COMMAND_MENU.map((c) => ({
      command: c.command,
      description: c.description,
    })));
  });

  it('re-registers when the token changes', async () => {
    let reads = 0;
    const h = harness({
      readConfig: vi.fn(async () => {
        reads += 1;
        return { botToken: reads <= 2 ? 'TOK-A' : 'TOK-B', chatId: CHAT_ID };
      }) as any,
    });
    h.fetchImpl.mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('token B registered', () => h.calls('/setMyCommands').length >= 2);
    await listener.stop();

    const registrations = h.calls('/setMyCommands').map((c) => String(c[0]));
    expect(registrations[0]).toContain('/botTOK-A/setMyCommands');
    expect(registrations[1]).toContain('/botTOK-B/setMyCommands');
  });

  it('resets the offset when the token changes, so the new bot\'s updates are not confirmed away unseen', async () => {
    // A new bot's update_ids start from ITS own sequence, which is typically far
    // BELOW the previous bot's. Carrying the old offset over means every update
    // this bot sends is already "confirmed" — the bot ignores you, forever, with
    // nothing in the log to explain it.
    let reads = 0;
    const h = harness({
      readOffset: vi.fn(async () => 900_000),
      readConfig: vi.fn(async () => {
        reads += 1;
        return { botToken: reads <= 2 ? 'TOK-A' : 'TOK-B', chatId: CHAT_ID };
      }) as any,
    });
    h.fetchImpl.mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('token B registered', () => h.calls('/setMyCommands').length >= 2);
    await waitFor('a poll on the new token', () => h.calls('/botTOK-B/getUpdates').length >= 1);
    await listener.stop();

    // The previous bot's offset is neither sent to the new bot…
    for (const call of h.calls('/botTOK-B/getUpdates')) {
      expect(new URL(String(call[0])).searchParams.get('offset')).toBeNull();
    }
    // …nor left in storage for the next container start to read back.
    expect(h.writeOffset).toHaveBeenCalledWith(0);
    // And it is SAID, because this failure is otherwise invisible.
    expect(h.logs.some((l) => /token changed/i.test(l) && /offset/i.test(l))).toBe(true);
    // The first token must NOT trigger a reset: that would wipe the stored
    // offset on every single container start.
    expect(h.calls('/botTOK-A/getUpdates').every(
      (call) => new URL(String(call[0])).searchParams.get('offset') === '900000',
    )).toBe(true);
  });

  it('treats a failed registration as cosmetic: logged, non-fatal, not retried', async () => {
    const h = harness();
    h.fetchImpl
      .mockRejectedValueOnce(new Error('setMyCommands refused'))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('polling anyway', () => h.calls('/getUpdates').length >= 3);
    await listener.stop();

    expect(h.logs.some((l) => l.includes('setMyCommands refused'))).toBe(true);
    expect(h.calls('/setMyCommands')).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });
});

describe('startTelegramListener — stop', () => {
  it('resolves only after the in-flight poll finishes, and issues no further fetches', async () => {
    const h = harness();
    let releasePoll: ((v: unknown) => void) | null = null;
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockImplementationOnce(() => new Promise((resolve) => { releasePoll = resolve; }))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('poll in flight', () => releasePoll !== null);

    let settled = false;
    const stopping = listener.stop().then(() => { settled = true; });
    await drainTicks(20);
    expect(settled).toBe(false);

    releasePoll!(updatesResponse([]));
    await stopping;
    expect(settled).toBe(true);

    const fetchesAtStop = h.fetchImpl.mock.calls.length;
    await drainTicks(50);
    expect(h.fetchImpl.mock.calls.length).toBe(fetchesAtStop);
  });

  it('is safe to call twice', async () => {
    const h = harness();
    h.fetchImpl.mockResolvedValueOnce(apiOkResponse()).mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('first poll', () => h.calls('/getUpdates').length >= 1);
    await Promise.all([listener.stop(), listener.stop()]);
    // Reaching here at all is the assertion: a second stop() must not hang on a
    // loop that has already exited.
    expect(h.calls('/getUpdates').length).toBeGreaterThanOrEqual(1);
  });
});

describe('startTelegramListener — report images and mini app users (v1.44)', () => {
  it('a report-image tap renders through the dep and sends a photo', async () => {
    const renderReportImage = vi.fn(async (_id: string) => ({
      png: new Uint8Array([137, 80, 78, 71]),
      title: 'Cash flow',
    }));
    const h = harness({ renderReportImage } as any);
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([callbackUpdate(30, 'mrep:cash-flow')]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('photo sent', () => h.calls('/sendPhoto').length >= 1);
    await listener.stop();

    expect(renderReportImage).toHaveBeenCalledWith('cash-flow');
    const send = h.calls('/sendPhoto')[0];
    const form = (send[1] as { body: FormData }).body;
    expect(String(form.get('chat_id'))).toBe(String(Number(CHAT_ID)));
    expect(String(form.get('caption'))).toBe('Cash flow');
  });

  it('a tap without the renderer answers instead of hanging the spinner', async () => {
    const h = harness();
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([callbackUpdate(31, 'mrep:cash-flow')]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('answered', () => h.calls('/answerCallbackQuery').length >= 1);
    await listener.stop();
    expect(h.calls('/sendPhoto')).toHaveLength(0);
  });

  it('/reports records the sender for the mini app allowlist', async () => {
    const recordMiniappUser = vi.fn(async (_id: number) => {});
    const h = harness({ recordMiniappUser } as any);
    h.fetchImpl
      .mockResolvedValueOnce(apiOkResponse())
      .mockResolvedValueOnce(updatesResponse([{
        update_id: 32,
        message: { chat: { id: Number(CHAT_ID) }, from: { id: 777 }, text: '/charts' },
      }]))
      .mockResolvedValue(updatesResponse([]));

    const listener = start(h.deps);
    await waitFor('command ran', () => h.onCommand.mock.calls.length >= 1);
    await listener.stop();
    expect(recordMiniappUser).toHaveBeenCalledWith(777);
  });
});
