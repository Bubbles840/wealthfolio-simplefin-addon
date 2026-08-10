import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { startTelegramListener, type TelegramListenerDeps } from './telegram-listener.js';
import { TELEGRAM_COMMAND_MENU } from '../../shared/telegram-commands.js';

const CHAT_ID = '42';

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
