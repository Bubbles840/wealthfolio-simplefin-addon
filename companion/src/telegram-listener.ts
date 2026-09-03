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
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { InlineKeyboard } from '../../shared/telegram.js';

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
  /** An undo-button tap: removes one id from the ledger, through the same
   *  merge as `applyDismissal`. OPTIONAL so older harnesses keep working; absent
   *  means `u:` taps are answered with a "not available" toast. */
  undoDismissal?: (activityId: string) => Promise<void>;
  /**
   * Runs one command. The `reply` callback NEVER rejects — a transport failure is
   * logged inside the listener instead — so a handler is free to send a reply
   * without awaiting it. That guarantee exists because the alternative is an
   * unhandled promise rejection, which kills the daemon and stops bank syncing.
   * The trade is that a handler cannot observe whether a send succeeded; nothing
   * needs to, since the listener logs every failure itself.
   */
  onCommand: (cmd: ParsedCommand, reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>) => Promise<void>;
  /**
   * Menu-button taps (callback_data starting with 'cz:'). OPTIONAL: absent
   * means such callbacks are answered with a generic expiry notice. `ui`
   * mirrors `reply`'s guarantee: NONE of its methods ever reject — transport
   * failures are logged in the listener — because a rejecting UI callback in a
   * fire-and-forget position is an unhandled rejection, which kills the daemon.
   */
  /** A report-image tap (`mrep:<id>`): renders the chart as a PNG. OPTIONAL —
   *  absent (or a null render) answers the tap with a notice instead. */
  renderReportImage?: (reportId: string) => Promise<{ png: Uint8Array; title: string } | null>;
  /** Called with the sender's user id when /reports runs, building the mini
   *  app allowlist out of ordinary chat membership — no setup screen. */
  recordMiniappUser?: (userId: number) => Promise<void>;
  onMenuCallback?: (
    cb: { data: string; chatId: number; messageId: number },
    ui: {
      /** Replaces the tapped message's text and keyboard in place. */
      edit: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
      /** Clears the button's spinner, with an optional toast. */
      answer: (text?: string) => Promise<void>;
      /** A NEW message in the configured chat, for when editing is wrong. */
      send: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
    },
  ) => Promise<void>;
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
/** `/reports` keyboard buttons: `mrep:<report id>` → a rendered chart PNG.
 *  The other half lives in index.ts's /reports command. */
export const REPORT_IMAGE_PREFIX = 'mrep:';
const DISMISS_ANSWER_TEXT = 'Dismissed — dropped from future notices';
/** The way back. A dismissal used to be one tap with no undo, on a button
 *  sitting right under a thumb; the only recovery was waiting ~60 days for the
 *  ledger to forget it. Tapping Dismiss now turns that button into Undo, and
 *  Undo turns it back — the notice itself is the surface, so nothing new has
 *  to be found. */
export const UNDISMISS_PAYLOAD_PREFIX = 'u:';
const UNDISMISS_ANSWER_TEXT = 'Restored — it will show as needing a category again';
const DISMISS_BUTTON_TEXT_PREFIX = 'Dismiss: ';
export const UNDISMISS_BUTTON_TEXT_PREFIX = '↩ Undo: ';

/** Shown when a `cz:` tap arrives with nothing wired up to interpret it —
 *  either the build predates the menu controller, or the daemon restarted and
 *  the in-memory session behind those buttons is gone. Either way the honest
 *  and actionable thing to say is "ask again", not "internal error". The prefix
 *  itself is imported from shared/categorize-menu.ts rather than copied, since a
 *  second literal is the drift `DISMISS_PAYLOAD_PREFIX`'s comment warns about. */
const MENU_EXPIRED_ANSWER_TEXT = 'That menu expired — send /categorize again.';

/**
 * index.ts has its own copy and cannot be imported here: it is the daemon entry
 * point and will import THIS module, so the dependency only runs one way.
 *
 * Total by construction, for the same reason `safeLog` is: a rejection value is
 * dependency-supplied data, and stringifying one whose `toString` throws would
 * throw while BUILDING a log message — before the log call it was going to be
 * passed to, and therefore outside every guard downstream of it.
 */
function formatError(err: unknown): string {
  try {
    if (err instanceof Error) {
      const cause = (err as { cause?: { message?: string } }).cause;
      return cause ? `${err.message} (${cause.message ?? cause})` : err.message;
    }
    return String(err);
  } catch {
    return 'an error that could not be stringified';
  }
}

export function startTelegramListener(deps: TelegramListenerDeps): { stop: () => Promise<void> } {
  let stopped = false;
  let backoffMs = BACKOFF_FLOOR_MS;

  /** The offset is read from storage ONCE and carried in memory after that:
   *  this loop is the stream's only consumer, so storage cannot be more current
   *  than memory, and re-reading a secret per poll buys nothing. The one thing
   *  that invalidates it is the bot TOKEN changing — an offset is only meaningful
   *  against the bot that issued it — so `run` clears both halves in that case. */
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
   * The only way this module ever logs. `deps.log` is an injected dependency like
   * any other, so it is treated as hostile: EVERY log call in this file sits in a
   * catch block that exists to stop something worse, and a throwing `log` inside
   * one of those catches escapes it and re-creates the exact failure the catch was
   * written to prevent — a dead loop, or an unhandled rejection that takes the
   * daemon down with it. Reporting a problem must never be able to cause one.
   *
   * The swallow is total and silent by necessity: there is no second channel to
   * report a broken reporting channel on.
   */
  function safeLog(msg: string): void {
    try {
      deps.log(msg);
    } catch {
      /* a logger that throws cannot be told about it */
    }
  }

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
        safeLog(`Telegram listener: sleep(${ms}) rejected — continuing unthrottled rather than dying: ${formatError(err)}`);
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
   *
   * `keyboard` is spread in only when supplied, so a one-argument call — which is
   * every existing handler — produces the byte-identical body it always has. A
   * `reply_markup: undefined` key would not be: Telegram's parser reads the key's
   * presence, and JSON.stringify's dropping of undefined values is an
   * implementation detail to lean on, not a contract.
   */
  async function reply(config: ListenerConfig, text: string, keyboard?: InlineKeyboard): Promise<void> {
    const res = await deps.fetchImpl(api(config.botToken, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }),
    });
    const json = await readJson(res);
    if (json && json.ok === false) {
      safeLog(`Telegram listener: reply refused by Telegram: ${json.description ?? 'no description given'}`);
    }
  }

  function noteForeignChat(chatId: unknown): void {
    const key = String(chatId);
    if (loggedForeignChats.has(key)) return;
    loggedForeignChats.add(key);
    safeLog(`Telegram listener: ignoring updates from chat ${key} — only the configured chat is honored.`);
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
    const safeReply = async (text: string, keyboard?: InlineKeyboard): Promise<void> => {
      try {
        await reply(config, text, keyboard);
      } catch (err) {
        safeLog(`Telegram listener: reply to /${parsed.command} was not delivered: ${formatError(err)}`);
      }
    };

    // The mini app's allowlist is "has used /reports in the configured chat":
    // recorded BEFORE the handler runs, so the button it replies with works
    // on the very first try.
    if (parsed.command === 'reports' && typeof message?.from?.id === 'number') {
      await deps.recordMiniappUser?.(message.from.id).catch(
        (err: unknown) => safeLog(`Telegram listener: recording mini-app user failed: ${formatError(err)}`),
      );
    }
    try {
      await deps.onCommand(parsed, safeReply);
    } catch (err) {
      safeLog(`Telegram listener: /${parsed.command} failed: ${formatError(err)}`);
      try {
        await reply(config, HANDLER_FAILURE_REPLY);
      } catch (replyErr) {
        // Both the command AND the apology failed, which means the network is
        // the problem. Logged, swallowed: there is nothing left to tell the user
        // with, and the loop must outlive it.
        safeLog(`Telegram listener: could not deliver the failure notice: ${formatError(replyErr)}`);
      }
    }
  }

  /**
   * Builds the UI a menu controller acts through. Bound to ONE tap: the message
   * to edit and the callback query to answer are closed over, so a controller
   * cannot address someone else's message and the callback query id never becomes
   * part of the public dep shape.
   *
   * None of the three can reject — see `onMenuCallback`'s doc comment for why
   * that is a hard requirement rather than a convenience. Each awaits its own
   * request inside a try, and its catch does nothing but `safeLog`, which cannot
   * throw by construction. That makes every method safe in a fire-and-forget
   * position, which is how the controller uses them.
   */
  function buildMenuUi(config: ListenerConfig, chatId: number, messageId: number, callbackQueryId: string) {
    return {
      /**
       * The whole point of a tappable menu: one message that becomes the next
       * screen, instead of a chat filling with dead keyboards.
       *
       * Telegram refuses a no-op edit with 400 "message is not modified", which a
       * user double-tapping one button produces routinely. It is deliberately NOT
       * special-cased: it lands in the same `ok: false` log as a real refusal
       * (unescaped Markdown, most likely) and is otherwise ignored. Retrying it
       * would be retrying a request whose desired state already holds.
       */
      edit: async (text: string, keyboard?: InlineKeyboard): Promise<void> => {
        try {
          const res = await deps.fetchImpl(api(config.botToken, 'editMessageText'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: messageId,
              text,
              parse_mode: 'Markdown',
              // Omitted, not `undefined`: for an EDIT, no `reply_markup` is how
              // Telegram is told to leave the message with no buttons at all —
              // which is exactly what a final screen wants.
              ...(keyboard ? { reply_markup: keyboard } : {}),
            }),
          });
          const json = await readJson(res);
          if (json && json.ok === false) {
            safeLog(`Telegram listener: menu edit refused by Telegram: ${json.description ?? 'no description given'}`);
          }
        } catch (err) {
          safeLog(`Telegram listener: menu edit was not delivered: ${formatError(err)}`);
        }
      },
      /**
       * Clears the tapped button's spinner, optionally with a toast. The response
       * body is not inspected: a query Telegram considers too old is refused, and
       * that is a non-event next to whatever the tap actually did.
       */
      answer: async (text?: string): Promise<void> => {
        try {
          const params = new URLSearchParams({ callback_query_id: callbackQueryId });
          if (text !== undefined) params.set('text', text);
          await deps.fetchImpl(`${api(config.botToken, 'answerCallbackQuery')}?${params}`);
        } catch (err) {
          safeLog(`Telegram listener: callback answer was not delivered: ${formatError(err)}`);
        }
      },
      /** For the cases editing cannot express — a screen that should not replace
       *  the one the user tapped. Mirrors `reply`, including its `ok: false` log. */
      send: async (text: string, keyboard?: InlineKeyboard): Promise<void> => {
        try {
          await reply(config, text, keyboard);
        } catch (err) {
          safeLog(`Telegram listener: menu message was not delivered: ${formatError(err)}`);
        }
      },
    };
  }

  async function handleMenuCallback(config: ListenerConfig, cq: any, chatId: number): Promise<void> {
    const ui = buildMenuUi(config, chatId, cq?.message?.message_id, String(cq?.id));

    // Shippable before the controller exists, and the honest answer after a
    // restart wipes the session those buttons belonged to.
    if (!deps.onMenuCallback) {
      await ui.answer(MENU_EXPIRED_ANSWER_TEXT);
      return;
    }

    try {
      await deps.onMenuCallback({ data: cq.data, chatId, messageId: cq?.message?.message_id }, ui);
    } catch (err) {
      // Logged and swallowed, exactly like a thrown command — but with NO
      // consolation message of its own. The controller owns the screen and may
      // already have answered this query or edited an apology into it; a second
      // answerCallbackQuery from out here would be refused by Telegram anyway,
      // and a message the controller did not choose would contradict its screen.
      safeLog(`Telegram listener: menu tap ${cq.data} failed: ${formatError(err)}`);
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
    if (typeof cq?.data !== 'string') return;

    if (cq.data.startsWith(MENU_CALLBACK_PREFIX)) {
      // A menu tap authorizes like a MESSAGE does, not like a dismissal: an
      // absent chat id is treated as foreign rather than assumed to be ours.
      // Nothing is lost by being stricter here — the reply to a menu tap is an
      // edit of the message it came from, so a callback with no message is not
      // actionable in the first place. The caller advances the offset either way,
      // so a stranger still cannot wedge the update stream.
      if (typeof chatId !== 'number') {
        noteForeignChat(chatId);
        return;
      }
      await handleMenuCallback(config, cq, chatId);
      return;
    }

    if (cq.data.startsWith(REPORT_IMAGE_PREFIX)) {
      const reportId = cq.data.slice(REPORT_IMAGE_PREFIX.length);
      if (!deps.renderReportImage) {
        await answer(config, cq, 'Chart images are not available in this build');
        return;
      }
      await answer(config, cq, 'Rendering…');
      try {
        const image = await deps.renderReportImage(reportId);
        if (!image) {
          safeLog(`Telegram listener: no image for report ${reportId}`);
          return;
        }
        // Multipart, not JSON: a PNG travels as a file part. Node's global
        // FormData/Blob make this dependency-free.
        const form = new FormData();
        form.set('chat_id', String(config.chatId));
        form.set('caption', image.title);
        form.set('photo', new Blob([Buffer.from(image.png)], { type: 'image/png' }), `${reportId}.png`);
        await deps.fetchImpl(api(config.botToken, 'sendPhoto'), { method: 'POST', body: form });
      } catch (err) {
        safeLog(`Telegram listener: report image ${reportId} failed: ${formatError(err)}`);
      }
      return;
    }

    if (cq.data.startsWith(UNDISMISS_PAYLOAD_PREFIX)) {
      const activityId = cq.data.slice(UNDISMISS_PAYLOAD_PREFIX.length);
      if (!deps.undoDismissal) {
        await answer(config, cq, 'Undo is not available in this build');
        return;
      }
      try {
        await deps.undoDismissal(activityId);
      } catch (err) {
        // Same rule as a failed dismissal: no confirmation for a write that did
        // not land. The button stays as Undo, so the user can simply tap again.
        safeLog(`Telegram listener: undo of dismissal ${activityId} failed: ${formatError(err)}`);
        return;
      }
      await answer(config, cq, UNDISMISS_ANSWER_TEXT);
      await swapButton(config, cq, UNDISMISS_PAYLOAD_PREFIX, DISMISS_PAYLOAD_PREFIX,
        UNDISMISS_BUTTON_TEXT_PREFIX, DISMISS_BUTTON_TEXT_PREFIX);
      return;
    }

    if (!cq.data.startsWith(DISMISS_PAYLOAD_PREFIX)) return;
    const activityId = cq.data.slice(DISMISS_PAYLOAD_PREFIX.length);

    try {
      await deps.applyDismissal(activityId);
    } catch (err) {
      // The offset still advances (the caller does that regardless), because a
      // failed ledger write must not wedge the stream on one un-acknowledged
      // update. No answerCallbackQuery either: confirming "Dismissed" for
      // something that was not recorded would be a lie the user acts on.
      safeLog(`Telegram listener: dismissal of ${activityId} failed: ${formatError(err)}`);
      return;
    }

    await answer(config, cq, DISMISS_ANSWER_TEXT);
    await swapButton(config, cq, DISMISS_PAYLOAD_PREFIX, UNDISMISS_PAYLOAD_PREFIX,
      DISMISS_BUTTON_TEXT_PREFIX, UNDISMISS_BUTTON_TEXT_PREFIX);
  }

  /** Clears the spinner with a toast. Never throws: answered or not, the
   *  ledger write it follows is already recorded. */
  async function answer(config: ListenerConfig, cq: any, text: string): Promise<void> {
    try {
      await deps.fetchImpl(`${api(config.botToken, 'answerCallbackQuery')}?${new URLSearchParams({
        callback_query_id: String(cq?.id),
        text,
      })}`);
    } catch {
      /* see above */
    }
  }

  /**
   * Rewrites the tapped button in place — Dismiss becomes Undo, or back — and
   * leaves every other button exactly as it was. Best effort: a callback with
   * no message attached (an old notice Telegram no longer describes, or one
   * relayed from elsewhere) simply keeps its keyboard; the ledger write that
   * matters has already happened by the time this runs.
   */
  async function swapButton(
    config: ListenerConfig, cq: any,
    fromData: string, toData: string, fromText: string, toText: string,
  ): Promise<void> {
    const msg = cq?.message;
    const rows: Array<Array<{ text: string; callback_data?: string }>> | undefined =
      msg?.reply_markup?.inline_keyboard;
    if (typeof msg?.message_id !== 'number' || !Array.isArray(rows)) return;
    let changed = false;
    const next = rows.map((row) => row.map((btn) => {
      if (btn.callback_data !== cq.data) return btn;
      changed = true;
      const label = btn.text.startsWith(fromText) ? btn.text.slice(fromText.length) : btn.text;
      return { text: `${toText}${label}`, callback_data: `${toData}${cq.data.slice(fromData.length)}` };
    }));
    if (!changed) return;
    try {
      await deps.fetchImpl(api(config.botToken, 'editMessageReplyMarkup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: msg.chat?.id, message_id: msg.message_id,
          reply_markup: { inline_keyboard: next },
        }),
      });
    } catch (err) {
      safeLog(`Telegram listener: could not update the button after ${cq.data}: ${formatError(err)}`);
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
      safeLog(`Telegram listener: update ${update?.update_id} could not be processed: ${formatError(err)}`);
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
        safeLog(`Telegram listener: command menu refused by Telegram (commands still work): ${json.description ?? 'no description given'}`);
      }
    } catch (err) {
      safeLog(`Telegram listener: command menu registration failed (commands still work, the menu just will not list them): ${formatError(err)}`);
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
            safeLog('Telegram listener idle: no Telegram configuration yet — re-checking every 60s.');
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
          // A DIFFERENT bot, not merely the first one. The stored offset belongs
          // to the token that produced it: a new bot's `update_id`s come from its
          // own sequence, typically far BELOW the previous bot's, so carrying the
          // old offset over tells Telegram every update is already confirmed and
          // the bot ignores every command forever — the same invisible symptom
          // the 409 message above exists to make diagnosable, with no log line at
          // all. So the offset is dropped from memory AND from storage.
          //
          // `registeredToken === null` is the FIRST config read of the process,
          // not a change: resetting there would wipe the stored offset on every
          // container start and re-serve whatever Telegram still held.
          if (registeredToken !== null) {
            offset = null;
            // 0 is Telegram's own "no offset": `getUpdates` treats it as
            // unspecified and serves the oldest update it still holds, which is
            // exactly what a fresh bot should start from. Written BEFORE the
            // token is marked as registered (`registerCommandMenu` does that
            // first), so a failed write throws into the loop's backoff and the
            // reset is retried on the next cycle instead of leaving storage
            // poisoned for the next container start.
            await deps.writeOffset(0);
            safeLog(
              'Telegram listener: bot token changed — the stored update offset belonged to the previous bot '
              + 'and has been reset, so this bot\'s updates are not confirmed away unseen.',
            );
          }
          await registerCommandMenu(config.botToken);
        }

        await pollOnce(config);
        // Reset only after a poll that actually completed, so a flapping network
        // does not restart the ladder at 1s on every other attempt.
        backoffMs = BACKOFF_FLOOR_MS;
      } catch (err) {
        safeLog(`Telegram listener error (retrying in ${Math.round(backoffMs / 1000)}s): ${formatError(err)}`);
        await pause(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_CEILING_MS);
      }
    }
  }

  // `run` should never reject — every iteration's body is inside the try — but
  // the `.catch` is the same guard the cron callbacks in index.ts carry, and for
  // the same reason: a rejection escaping this promise is an unhandled
  // rejection, which kills the daemon and stops bank syncing over a bot bug.
  //
  // `finished` therefore ALWAYS fulfils, never rejects, which is what makes
  // `stop()` total: this handler's only two statements are `formatError` and
  // `safeLog`, and neither can throw by construction (see both). A throwing
  // handler here would leave `finished` rejected and unobserved until some later
  // `stop()` — a rejection nobody is waiting for, i.e. the very thing the
  // `.catch` is here to prevent.
  const finished = run().catch((err) => {
    safeLog(`Telegram listener stopped unexpectedly: ${formatError(err)}`);
  });

  return {
    /**
     * Requests shutdown and resolves once the loop has left its current
     * iteration — an in-flight poll is allowed to finish and its updates to be
     * handled, so a command is never dropped half-answered. It resolves no
     * faster than the work already in flight (up to the long-poll timeout, or
     * the current backoff sleep); nothing in the daemon blocks on it, and tests
     * await it so no test can end with the loop still scheduled.
     *
     * Cannot reject: setting a boolean cannot throw and `finished` cannot reject
     * (see above), so no caller of `stop()` needs a `.catch` of its own.
     */
    stop: async () => {
      stopped = true;
      await finished;
    },
  };
}
