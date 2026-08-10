/**
 * companion/src/telegram-listener.ts
 *
 * The always-on half of the Telegram bot: a long-poll loop that reads
 * `getUpdates`, authorizes, and dispatches.
 *
 * WHY A LOOP AND NOT A WEBHOOK. A webhook needs an inbound HTTPS endpoint the
 * user can reach from the internet; the companion is a container on a home
 * network with no such surface. Long-polling needs nothing but outbound HTTPS,
 * which the companion already makes to SimpleFin and Telegram.
 *
 * WHY THIS BECOMES THE BOT'S ONLY CONSUMER. Telegram serves `getUpdates` to
 * exactly ONE reader per bot token; a second reader gets HTTP 409 and the
 * visible symptom is a bot that silently ignores you. So this loop owns the
 * update stream and the stored offset outright, and takes over the import
 * notice's dismiss buttons from the once-per-sync poll that used to collect
 * them (a tap now lands in the ledger in a second instead of up to six hours
 * later). The 409 case is logged in words that name the cause, because nothing
 * else about it is observable from outside.
 *
 * WHY EVERY DEPENDENCY IS INJECTED. This runs forever inside a daemon whose
 * real job is syncing money. Two things must be impossible by construction:
 * a command handler's exception killing the loop (the bot would go silent
 * until someone restarts a container), and a rejected promise escaping it (an
 * unhandled rejection takes the whole daemon down and stops bank syncing — the
 * same hazard the cron callbacks in index.ts guard with `.catch`). Both are
 * only testable if the network, the clock, the secret store and the handlers
 * are all parameters, so they are.
 */

import { parseCommand, TELEGRAM_COMMAND_MENU, type ParsedCommand } from '../../shared/telegram-commands.js';

export interface TelegramListenerDeps {
  fetchImpl: typeof fetch;
  log: (msg: string) => void;
  /** Re-read every idle cycle so addon-side config changes land within ~a minute. */
  readConfig: () => Promise<{ botToken: string; chatId: string; botName?: string } | null>;
  readOffset: () => Promise<number | null>;
  writeOffset: (n: number) => Promise<void>;
  /**
   * A dismiss-button tap. Implementations MUST merge into the persisted
   * dismissal ledger rather than overwrite it — a sync running concurrently
   * writes the same secret, and a whole-object write from a stale snapshot is
   * exactly the 1.10.1 bug (`mergeDismissals` exists for this).
   */
  applyDismissal: (activityId: string) => Promise<void>;
  /**
   * Runs one command. The `reply` callback NEVER rejects — a transport failure is
   * logged inside the listener instead — so a handler is free to send a reply
   * without awaiting it. That guarantee exists because the alternative is an
   * unhandled promise rejection, which kills the daemon and stops bank syncing.
   * The trade is that a handler cannot observe whether a send succeeded; nothing
   * needs to, since the listener logs every failure itself.
   */
  onCommand: (cmd: ParsedCommand, reply: (text: string) => Promise<void>) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

/** Derived from the dep rather than declared twice, so the two cannot drift. */
type ListenerConfig = NonNullable<Awaited<ReturnType<TelegramListenerDeps['readConfig']>>>;

/** Telegram holds the request open this long when there is nothing to report,
 *  so an idle loop costs one request per ~50s and a command answers instantly.
 *  Under Telegram's own 60s ceiling with room for the response to travel. */
const LONG_POLL_SECONDS = 50;

/** How long an unconfigured listener waits before looking again: configuring or
 *  deconfiguring Telegram in the addon takes effect within a minute, with no
 *  container restart. */
const IDLE_CONFIG_RECHECK_MS = 60_000;

const BACKOFF_FLOOR_MS = 1_000;
const BACKOFF_CEILING_MS = 60_000;

/** Sent when a handler throws. Deliberately vague about the cause and explicit
 *  about where the cause is: a chat message is not a stack trace's audience. */
const HANDLER_FAILURE_REPLY = 'Something went wrong running that command — check the companion logs.';

/** A data contract with `buildDismissKeyboard` in shared/telegram.ts, which
 *  emits `d:${activityId}` — keyed by activity id alone because Telegram caps
 *  `callback_data` at 64 bytes and two uuids plus a prefix run ~85. Both halves
 *  are pinned by tests; changing either one alone silently breaks the button. */
const DISMISS_PAYLOAD_PREFIX = 'd:';
const DISMISS_ANSWER_TEXT = 'Dismissed — dropped from future notices';

/** index.ts has its own copy and cannot be imported here: it is the daemon entry
 *  point and will import THIS module, so the dependency only runs one way. */
function formatError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { message?: string } }).cause;
    return cause ? `${err.message} (${cause.message ?? cause})` : err.message;
  }
  return String(err);
}

export function startTelegramListener(deps: TelegramListenerDeps): { stop: () => Promise<void> } {
  let stopped = false;
  let backoffMs = BACKOFF_FLOOR_MS;

  /** The offset is read from storage ONCE and carried in memory after that:
   *  this loop is the stream's only consumer, so storage cannot be more current
   *  than memory, and re-reading a secret per poll buys nothing. */
  let offset: number | null = null;
  let offsetLoaded = false;

  let registeredToken: string | null = null;
  let announcedUnconfigured = false;
  let sleepFailureLogged = false;

  /** Foreign senders are logged once per chat id per process. A stranger who
   *  finds the bot can send messages indefinitely; one line per message would
   *  bury the daemon's real log in someone else's chatter. */
  const loggedForeignChats = new Set<string>();

  const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

  /**
   * The only way this module ever waits, because `deps.sleep` REJECTING must not
   * be fatal. An `await deps.sleep(...)` inside the loop's own catch would take
   * control out of the `while` on rejection: the listener would be dead for the
   * rest of the process lifetime with one log line and nothing to restart it.
   * Unreachable with a `setTimeout`-based sleep, but exactly the trap waiting for
   * whoever makes `sleep` abortable to shorten `stop()`.
   *
   * Logged once: a sleep that always rejects means the backoff no longer
   * throttles, and one line per iteration would then be the loudest thing in the
   * log while saying nothing new.
   */
  async function pause(ms: number): Promise<void> {
    try {
      await deps.sleep(ms);
    } catch (err) {
      if (!sleepFailureLogged) {
        sleepFailureLogged = true;
        deps.log(`Telegram listener: sleep(${ms}) rejected — continuing unthrottled rather than dying: ${formatError(err)}`);
      }
    }
  }

  const readJson = async (res: unknown): Promise<any> => {
    try {
      return await (res as { json: () => Promise<unknown> }).json();
    } catch {
      return null;
    }
  };

  /**
   * Mirrors `sendTelegramMessage`'s request body from shared/telegram.ts rather
   * than calling it: that function closes over the global `fetch`, and this
   * module's whole testability rests on the transport being injected. A `ok:
   * false` response is logged because the likeliest cause — Markdown the
   * formatters did not escape — is otherwise a reply that vanishes silently.
   */
  async function reply(config: ListenerConfig, text: string): Promise<void> {
    const res = await deps.fetchImpl(api(config.botToken, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const json = await readJson(res);
    if (json && json.ok === false) {
      deps.log(`Telegram listener: reply refused by Telegram: ${json.description ?? 'no description given'}`);
    }
  }

  function noteForeignChat(chatId: unknown): void {
    const key = String(chatId);
    if (loggedForeignChats.has(key)) return;
    loggedForeignChats.add(key);
    deps.log(`Telegram listener: ignoring updates from chat ${key} — only the configured chat is honored.`);
  }

  async function handleMessage(config: ListenerConfig, message: any): Promise<void> {
    // An absent chat is treated as foreign, not as "probably ours": authorizing
    // on a field that isn't there is how a bot answers strangers.
    if (message?.chat?.id !== Number(config.chatId)) {
      noteForeignChat(message?.chat?.id);
      return;
    }
    const parsed = parseCommand(message?.text, config.botName);
    if (!parsed) return;

    // The callback handed to a handler can NEVER reject — see `onCommand`'s doc
    // comment. A handler that fires a reply without awaiting it (`void reply(…)`,
    // a reply sent from a `.then`, a reply after the handler's own return) would
    // otherwise leave a rejected promise nobody holds, and an unhandled rejection
    // takes the whole daemon down and stops bank syncing. Guaranteed here, in the
    // code, rather than in a comment the next implementer has to read.
    const safeReply = async (text: string): Promise<void> => {
      try {
        await reply(config, text);
      } catch (err) {
        deps.log(`Telegram listener: reply to /${parsed.command} was not delivered: ${formatError(err)}`);
      }
    };

    try {
      await deps.onCommand(parsed, safeReply);
    } catch (err) {
      deps.log(`Telegram listener: /${parsed.command} failed: ${formatError(err)}`);
      try {
        await reply(config, HANDLER_FAILURE_REPLY);
      } catch (replyErr) {
        // Both the command AND the apology failed, which means the network is
        // the problem. Logged, swallowed: there is nothing left to tell the user
        // with, and the loop must outlive it.
        deps.log(`Telegram listener: could not deliver the failure notice: ${formatError(replyErr)}`);
      }
    }
  }

  async function handleCallbackQuery(config: ListenerConfig, cq: any): Promise<void> {
    // A callback_query carries its originating message only while that message
    // still exists, so an ABSENT chat is honored here (unlike a message's) —
    // the only buttons in existence were sent to the configured chat. A chat id
    // that IS present and differs is a foreign tap and drops.
    const chatId = cq?.message?.chat?.id;
    if (typeof chatId === 'number' && chatId !== Number(config.chatId)) {
      noteForeignChat(chatId);
      return;
    }
    if (typeof cq?.data !== 'string' || !cq.data.startsWith(DISMISS_PAYLOAD_PREFIX)) return;
    const activityId = cq.data.slice(DISMISS_PAYLOAD_PREFIX.length);

    try {
      await deps.applyDismissal(activityId);
    } catch (err) {
      // The offset still advances (the caller does that regardless), because a
      // failed ledger write must not wedge the stream on one un-acknowledged
      // update. No answerCallbackQuery either: confirming "Dismissed" for
      // something that was not recorded would be a lie the user acts on.
      deps.log(`Telegram listener: dismissal of ${activityId} failed: ${formatError(err)}`);
      return;
    }

    try {
      await deps.fetchImpl(`${api(config.botToken, 'answerCallbackQuery')}?${new URLSearchParams({
        callback_query_id: String(cq?.id),
        text: DISMISS_ANSWER_TEXT,
      })}`);
    } catch {
      /* answered or not, the dismissal itself is recorded */
    }
  }

  /**
   * The structural guarantee that one malformed or unlucky update cannot abort
   * the rest of the batch — which would also mean skipping the offset write and
   * re-fetching that same update forever.
   */
  async function processUpdate(config: ListenerConfig, update: any): Promise<void> {
    try {
      if (update?.message) {
        await handleMessage(config, update.message);
      } else if (update?.callback_query) {
        await handleCallbackQuery(config, update.callback_query);
      }
    } catch (err) {
      deps.log(`Telegram listener: update ${update?.update_id} could not be processed: ${formatError(err)}`);
    }
  }

  /**
   * One long poll. Throws on anything that means "we got no updates" so the
   * caller's single backoff path handles transport failures and Telegram-side
   * refusals identically — there is only one thing to do about either.
   */
  async function pollOnce(config: ListenerConfig): Promise<void> {
    const params = new URLSearchParams({
      timeout: String(LONG_POLL_SECONDS),
      allowed_updates: '["message","callback_query"]',
    });
    if (offset !== null) params.set('offset', String(offset));

    const res = await deps.fetchImpl(`${api(config.botToken, 'getUpdates')}?${params}`);
    const json = await readJson(res);

    if (json?.error_code === 409) {
      throw new Error(
        'Telegram reports another getUpdates consumer on this bot token (409) — only one is allowed, '
        + 'and while a rival holds the stream this bot appears to ignore every command. '
        + 'Stop the other companion, webhook, or debug script using this token.',
      );
    }
    if (!json?.ok) {
      throw new Error(`Telegram getUpdates failed: ${json?.description ?? 'unreadable response'}`);
    }

    const updates: any[] = Array.isArray(json.result) ? json.result : [];
    let maxUpdateId: number | null = null;
    for (const update of updates) {
      if (typeof update?.update_id === 'number') {
        maxUpdateId = maxUpdateId === null ? update.update_id : Math.max(maxUpdateId, update.update_id);
      }
      await processUpdate(config, update);
    }
    if (maxUpdateId === null) {
      // An EMPTY batch is the normal long-poll timeout. A NON-empty batch with no
      // usable `update_id` is not something this bot can advance past, so it would
      // be re-served immediately and forever: treated as an error purely so the
      // backoff throttles it, because a tight unthrottled loop against a remote
      // host is the worse failure. Only reachable from a non-Telegram response.
      if (updates.length > 0) {
        throw new Error(`Telegram returned ${updates.length} update(s) carrying no update_id — cannot advance the offset past them.`);
      }
      return;
    }

    // In-memory first, then persisted: a failed secret write must not make this
    // process re-handle updates it already handled (a duplicate /sync from one
    // tap is worse than an offset that catches up on the next successful write).
    offset = maxUpdateId + 1;
    await deps.writeOffset(offset);
  }

  /**
   * Registers the ☰ menu, once per token per process. The token is marked as
   * attempted BEFORE the request, so neither a config re-read every cycle nor a
   * failure turns into a re-POST every ~50 seconds: the menu is cosmetic (every
   * command works without it) and it is not worth a recurring log line.
   */
  async function registerCommandMenu(token: string): Promise<void> {
    registeredToken = token;
    try {
      const res = await deps.fetchImpl(api(token, 'setMyCommands'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commands: TELEGRAM_COMMAND_MENU.map((c) => ({ command: c.command, description: c.description })),
        }),
      });
      const json = await readJson(res);
      if (json && json.ok === false) {
        deps.log(`Telegram listener: command menu refused by Telegram (commands still work): ${json.description ?? 'no description given'}`);
      }
    } catch (err) {
      deps.log(`Telegram listener: command menu registration failed (commands still work, the menu just will not list them): ${formatError(err)}`);
    }
  }

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        const config = await deps.readConfig();
        if (!config?.botToken || !config?.chatId) {
          // Logged on the transition only: an install that never configures
          // Telegram would otherwise write 1,440 identical lines a day.
          if (!announcedUnconfigured) {
            announcedUnconfigured = true;
            deps.log('Telegram listener idle: no Telegram configuration yet — re-checking every 60s.');
          }
          await pause(IDLE_CONFIG_RECHECK_MS);
          continue;
        }
        announcedUnconfigured = false;

        if (!offsetLoaded) {
          offset = await deps.readOffset();
          offsetLoaded = true;
        }
        if (registeredToken !== config.botToken) {
          await registerCommandMenu(config.botToken);
        }

        await pollOnce(config);
        // Reset only after a poll that actually completed, so a flapping network
        // does not restart the ladder at 1s on every other attempt.
        backoffMs = BACKOFF_FLOOR_MS;
      } catch (err) {
        deps.log(`Telegram listener error (retrying in ${Math.round(backoffMs / 1000)}s): ${formatError(err)}`);
        await pause(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
      }
    }
  }

  // `run` should never reject — every iteration's body is inside the try — but
  // the `.catch` is the same guard the cron callbacks in index.ts carry, and for
  // the same reason: a rejection escaping this promise is an unhandled
  // rejection, which kills the daemon and stops bank syncing over a bot bug.
  const finished = run().catch((err) => {
    deps.log(`Telegram listener stopped unexpectedly: ${formatError(err)}`);
  });

  return {
    /**
     * Requests shutdown and resolves once the loop has left its current
     * iteration — an in-flight poll is allowed to finish and its updates to be
     * handled, so a command is never dropped half-answered. It resolves no
     * faster than the work already in flight (up to the long-poll timeout, or
     * the current backoff sleep); nothing in the daemon blocks on it, and tests
     * await it so no test can end with the loop still scheduled.
     */
    stop: async () => {
      stopped = true;
      await finished;
    },
  };
}
