/**
 * companion/src/index.ts
 *
 * Docker companion service: runs sync on the shared core via REST host adapters.
 * Configuration and access credentials live inside Wealthfolio Addon Secrets
 * (managed in-app by the addon UI), allowing the companion to run as a thin
 * daemon with only instance URL and password.
 */

import cron from 'node-cron';
import { readFileSync, existsSync } from 'fs';
import { runSyncCore, descriptionFromComment } from '../../shared/sync-core.js';
import type { SyncResult } from '../../shared/sync-core.js';
import { RestSyncHost, RestSyncStore } from './rest-host.js';
import { WealthfolioClient } from './wealthfolio.js';
import { sendTelegramMessage, formatDailySpendingDigest, formatMonthlyRemainingSummary, formatMonthlyWrapUp, formatSyncHealthFooter, formatLargeTransactionAlert, formatBalanceDriftAlert, formatFeedLagNotice, formatStuckTransferAlert, formatDuplicatePruneAlert, formatImportNotice, buildDismissKeyboard, IMPORT_NOTICE_UNCATEGORIZED_CAP, escapeMarkdown, LARGE_TX_OUTBOX_SECRET_KEY } from '../../shared/telegram.js';
import { pruneDismissals, mergeDismissals } from './dismissals.js';
import { startTelegramListener } from './telegram-listener.js';
import { createImapSource, ingestAmazonMail, amazonMailConfigured } from './amazon-mail.js';
import type { AmazonIngestResult, AmazonMailConfig, MailSource } from './amazon-mail.js';
import { DEFAULT_GLYPH_STYLE } from '../../shared/telegram.js';
import type { GlyphStyle } from '../../shared/telegram.js';
import type { DismissalLedger } from './dismissals.js';
import type { SyncHealth } from '../../shared/telegram.js';
import { SIMPLEFIN_SYNC_VERSION, COMPANION_VERSION_SECRET_KEY } from '../../shared/version.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategoryCatalog, getNativeSubcategorySpending } from './sqlite-native.js';
import { publishUncategorizedStatusForDbPath } from './uncategorized-status.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';
import {
  formatHelpReply,
  formatLeftReply,
  formatAffordReply,
  formatStatusReply,
  formatReportFooter,
  formatSyncReply,
  parseAffordArgs,
} from '../../shared/telegram-commands.js';
import type { CategoryBudgetSnapshot, BudgetPeriod, ParsedCommand, StatusReplyInput } from '../../shared/telegram-commands.js';

const logLevel: 'info' | 'debug' =
  process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info';

function log(message: string): void {
  console.log(`[simplefin-sync] ${message}`);
}

function debug(message: string): void {
  if (logLevel === 'debug') {
    console.log(`[simplefin-sync:debug] ${message}`);
  }
}

/** Mask the user:pass portion of a URL before logging */
export function maskUrl(url: string): string {
  return url.replace(/\/\/[^@]+@/, '//***@');
}

/** Validates required env vars at startup */
export function validateStartupEnv(): void {
  if (!process.env.WEALTHFOLIO_API_URL) {
    throw new Error('Missing required env var: WEALTHFOLIO_API_URL');
  }
  const hasPassword =
    !!process.env.WEALTHFOLIO_PASSWORD ||
    !!process.env.WEALTHFOLIO_PASSWORD_FILE ||
    !!process.env.WEALTHFOLIO_API_KEY;
  if (!hasPassword) {
    throw new Error('Missing required authentication: set WEALTHFOLIO_PASSWORD, WEALTHFOLIO_PASSWORD_FILE, or WEALTHFOLIO_API_KEY');
  }
}

export function resolvePassword(): string {
  if (process.env.WEALTHFOLIO_PASSWORD) return process.env.WEALTHFOLIO_PASSWORD;
  const file = process.env.WEALTHFOLIO_PASSWORD_FILE;
  if (file && existsSync(file)) {
    return readFileSync(file, 'utf8').trim();
  }
  return '';
}

const SYNC_HEALTH_ALERT_MS = 24 * 60 * 60 * 1000;

/**
 * Parses an addon-secret payload, treating a corrupt one as absent.
 *
 * Every secret this daemon reads is JSON it wrote itself, so a parse failure
 * means the value was truncated or hand-edited — a state no amount of retrying
 * fixes. A bare `JSON.parse` there throws *synchronously* out of whatever loop
 * it sits in, and the blast radius was wildly out of proportion to the cause:
 * a corrupt `sync_health` secret, read only to decorate the daily digest with
 * a one-line footer, destroyed the entire digest; a corrupt `telegram_config`
 * read inside the stuck-transfer alert loop aborted the remaining alerts, skipped
 * the un-alert rollback for entries already marked delivered, and made
 * `updateSyncHealth` record a *failure* for a sync that had actually succeeded.
 *
 * Returning `null` collapses "no secret" and "unreadable secret" into the one
 * case every caller already handles. `updateSyncHealth` guarded its own parse
 * for exactly this reason; this makes that the rule rather than the exception.
 */
function parseSecretJson<T>(raw: string | null | undefined, label: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    log(`Ignoring unreadable ${label} secret (treating as unset): ${formatError(err)}`);
    return null;
  }
}

/**
 * Persists sync outcome to the `sync_health` addon secret: `error === null`
 * records a success and clears any in-progress failure streak; a non-null
 * error starts (or continues) a streak, setting `firstFailedAt` only on the
 * FIRST failure so the 24h alert clock doesn't reset on every retry.
 *
 * Documented limitation: this writes through the same authenticated wfClient
 * the sync itself uses. If login to Wealthfolio fails outright, there is no
 * authenticated channel left to record or alert on that — it still only
 * surfaces via `docker logs`, same as today. This only covers failures
 * *after* a successful login (SimpleFin errors, runSyncCore throwing, etc.).
 *
 * This function must never throw: a failure here (bad JSON, a transient
 * write error) must not replace the real sync error in the caller's catch
 * block, so every fallible step is individually guarded.
 */
async function updateSyncHealth(wfClient: WealthfolioClient, error: Error | null): Promise<void> {
  try {
    const raw = await wfClient.getAddonSecret('simplefin-sync', 'sync_health').catch(() => null);
    const health: SyncHealth = parseSecretJson<SyncHealth>(raw, 'sync_health') ?? {};
    const now = new Date().toISOString();
    const next: SyncHealth = error === null
      ? { lastSuccessAt: now }
      : {
          lastSuccessAt: health.lastSuccessAt ?? null,
          firstFailedAt: health.firstFailedAt ?? now,
          lastError: error.message,
          alerted: health.alerted ?? false,
        };
    await wfClient.setAddonSecret('simplefin-sync', 'sync_health', JSON.stringify(next)).catch(() => {});
  } catch (err) {
    debug(`Sync health update failed (original sync error, if any, is preserved): ${formatError(err)}`);
  }
}

/** Sends a one-time Telegram alert once a failure streak has been active for
 *  24h, then marks the streak `alerted` — but ONLY once the send is confirmed
 *  delivered (`sendTelegramMessage` resolves `{ ok: true }`; it does not
 *  throw on an API-level failure like a bad token, rate limit, or a 400 from
 *  malformed Markdown). Marking `alerted` on an unconfirmed send would be
 *  indistinguishable from a real delivery to every future run — combined
 *  with the once-per-streak guard below, the user would then silently never
 *  be notified for the rest of the streak, defeating the point of the
 *  alert. Leaving `alerted` false on a failed send means the next sync
 *  simply retries; since at most one alert attempt happens per sync run and
 *  the message is identical each time, retrying until Telegram accepts it
 *  cannot spam the user — it only delays the single notification until
 *  delivery actually succeeds.
 *
 *  Runs in a `finally`, so it must be a no-op on a healthy streak. */
async function checkSyncHealthAlert(wfClient: WealthfolioClient): Promise<void> {
  const raw = await wfClient.getAddonSecret('simplefin-sync', 'sync_health').catch(() => null);
  const health = parseSecretJson<SyncHealth>(raw, 'sync_health');
  if (!health) return;
  if (!health.firstFailedAt || health.alerted) return;
  if (Date.now() - new Date(health.firstFailedAt).getTime() < SYNC_HEALTH_ALERT_MS) return;

  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null);
  const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
  if (!tg) return;
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;

  const lastError = escapeMarkdown(health.lastError ?? 'unknown error');
  const result = await sendTelegramMessage(
    tg.botToken,
    tg.chatId,
    `⚠️ *SimpleFin Sync has been failing since ${new Date(health.firstFailedAt).toLocaleString()}*\nLast error: ${lastError}`,
  );
  if (!result.ok) {
    log(`Sync health alert failed to send, will retry next sync: ${result.description}`);
    return;
  }
  await wfClient.setAddonSecret('simplefin-sync', 'sync_health', JSON.stringify({ ...health, alerted: true })).catch(() => {});
}

/** Sends the stuck-transfer Telegram alert and reports whether it was
 *  actually delivered, so the caller can roll back the ledger's `alerted`
 *  flag on a confirmed failure (see the rollback loop in runCompanionSync).
 *
 *  A "non-attempt" — no telegram_config secret, or Telegram deliberately
 *  disabled/unconfigured — reports `true` (not a failure) rather than
 *  `false`. Reporting `false` here would make the caller roll the ledger
 *  back to `alerted: false` on every single sync for a user who simply
 *  hasn't set up Telegram, which would re-queue (and rewrite the ledger
 *  secret for) an alert that can never be delivered — churn with no
 *  possible upside. Reporting `true` means the alert is silently consumed
 *  without being sent, but only for a user who has deliberately not
 *  configured or has disabled notifications; that tradeoff only applies to
 *  users who opted out, not to a delivery failure they'd want to know about. */
async function sendStuckTransferAlert(
  wfClient: WealthfolioClient,
  alert: { description: string; amountCents: number; currency: string },
): Promise<boolean> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null);
  // An unreadable config counts as a non-attempt (`true`), same as a missing
  // one: there is no token to send with, so this is not a delivery failure to
  // roll the ledger back for. See the doc comment above for why.
  const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
  if (!tg) return true;
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return true;
  // Text built by `shared/telegram.ts` — including the escaping of the
  // bank-supplied description — so the addon, which now delivers these too,
  // cannot say anything different about the same episode.
  const result = await sendTelegramMessage(
    tg.botToken,
    tg.chatId,
    formatStuckTransferAlert(alert),
  );
  if (!result.ok) {
    log(`Stuck-transfer alert failed to send, will retry next sync: ${result.description}`);
    return false;
  }
  return true;
}

/** Re-reads the transfer-link-failures ledger (rather than reusing any
 *  in-memory copy — runSyncCore already wrote it this run, so a stale copy
 *  here would clobber that) and rolls back `alerted` for exactly the entries
 *  whose delivery failed, preserving `count`/`firstFailedAt` so the 3-strike
 *  streak isn't reset. Only writes when something actually changed, matching
 *  the `linkFailuresChanged` discipline runSyncCore itself uses. Must never
 *  throw: a failure here must not abort the sync or mask a real error. */
async function rollBackUndeliveredStuckTransferAlerts(
  store: RestSyncStore,
  undeliveredOutTxIds: string[],
): Promise<void> {
  if (undeliveredOutTxIds.length === 0) return;
  try {
    const failures = await store.getTransferLinkFailures();
    let changed = false;
    for (const outTxId of undeliveredOutTxIds) {
      if (failures[outTxId]?.alerted) {
        failures[outTxId] = { ...failures[outTxId], alerted: false };
        changed = true;
      }
    }
    if (changed) await store.setTransferLinkFailures(failures);
  } catch (err) {
    debug(`Stuck-transfer alert rollback failed (will retry as still-alerted next sync): ${formatError(err)}`);
  }
}

/** Sends the balance-drift alert and reports whether it was actually delivered,
 *  so the caller can roll the drift-alert ledger's `alerted` flag back on a
 *  confirmed failure. Identical contract to `sendStuckTransferAlert`, including
 *  reporting a non-attempt (no/unreadable config, Telegram disabled) as `true`
 *  — see that function's note for why a non-attempt must not trigger a rollback
 *  on every sync for a user who never set Telegram up. */
async function sendBalanceDriftAlert(
  wfClient: WealthfolioClient,
  alert: SyncResult['balanceDriftAlerts'][number],
): Promise<boolean> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null);
  const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
  if (!tg) return true;
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return true;
  // Phase picks the voice — see the addon's deliverAddonAlerts, which makes
  // the identical choice: young informs (feed lag resolves itself), aged alarms.
  const text = alert.phase === 'aged' ? formatBalanceDriftAlert(alert) : formatFeedLagNotice(alert);
  const result = await sendTelegramMessage(tg.botToken, tg.chatId, text);
  if (!result.ok) {
    log(`Balance-drift alert failed to send, will retry next sync: ${result.description}`);
    return false;
  }
  return true;
}

/** Re-reads the drift-alert ledger (never a stale in-memory copy — runSyncCore
 *  already wrote it this run) and rolls `alerted` back for exactly the accounts
 *  whose send failed, leaving `driftAmount`/`firstDetectedAt` intact so the
 *  EPISODE survives: rolling back a delivery flag is not the same as declaring
 *  the account healthy. Only writes on a real change. Must never throw. */
async function rollBackUndeliveredDriftAlerts(
  store: RestSyncStore,
  undelivered: Array<{ sfinAccountId: string; phase: 'young' | 'aged' }>,
): Promise<void> {
  if (undelivered.length === 0) return;
  try {
    const alerts = await store.getDriftAlerts();
    let changed = false;
    for (const { sfinAccountId, phase } of undelivered) {
      const entry = alerts[sfinAccountId];
      if (!entry) continue;
      // An undelivered AGED escalation rolls back only `alertedAged`: its young
      // notice was already delivered, and re-arming that too would re-send the
      // soft message alongside the retried alarm.
      if (phase === 'aged' && entry.alertedAged) {
        alerts[sfinAccountId] = { ...entry, alertedAged: false };
        changed = true;
      } else if (phase === 'young' && entry.alerted) {
        alerts[sfinAccountId] = { ...entry, alerted: false };
        changed = true;
      }
    }
    if (changed) await store.setDriftAlerts(alerts);
  } catch (err) {
    debug(`Balance-drift alert rollback failed (will retry as still-alerted next sync): ${formatError(err)}`);
  }
}

/**
 * Announces what the reconcile sweep DELETED as surplus copies of transactions
 * the account already held.
 *
 * One message for the whole sweep rather than one per row — a reconcile cleaning
 * up a long-neglected account would otherwise arrive as a burst of pings — and no
 * ledger or rollback, unlike the three alerts above: there is no episode to
 * re-arm, nothing to mark as told, and the rows are already gone. A failed send is
 * logged and not retried; `runSyncCore` also logs every deletion individually and
 * the addon's Sync page shows them, so Telegram is not the only record of what
 * vanished.
 *
 * Text comes from `shared/telegram.ts`, the same builder the addon calls, so both
 * syncers say exactly the same thing — and the escaping of bank descriptions and
 * account names travels with it.
 *
 * Must never throw: it runs after a sync that already succeeded.
 */
async function deliverDuplicatePruneNotice(
  wfClient: WealthfolioClient,
  pruned: SyncResult['prunedDuplicates'],
): Promise<void> {
  if (pruned.length === 0) return;
  try {
    const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null);
    const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
    if (!tg || !tg.botToken || !tg.chatId || tg.enabled === false) return;
    const result = await sendTelegramMessage(tg.botToken, tg.chatId, formatDuplicatePruneAlert(pruned));
    if (!result.ok) {
      log(`Duplicate-prune notice failed to send: ${result.description}`);
    }
  } catch (err) {
    debug(`Duplicate-prune notice delivery failed: ${formatError(err)}`);
  }
}

/** Addon secret holding large-transaction alerts a previous run could not
 *  deliver — the name comes from `shared/telegram.ts` because the addon drains
 *  the same queue. See `deliverLargeTransactionAlerts` for why an outbox rather
 *  than a rollback flag. */
const LARGE_TX_OUTBOX_KEY = LARGE_TX_OUTBOX_SECRET_KEY;

/**
 * Sends this run's large-transaction alerts, retrying anything an earlier run
 * failed to deliver, and persists exactly what is still undelivered.
 *
 * An outbox rather than the stuck-transfer alert's roll-back-a-flag pattern,
 * because the two have different re-derivability. A stuck transfer is
 * re-detected on every sync, so clearing `alerted` is enough to make the next
 * run rebuild the alert. A large transaction is announced only because its row
 * was CREATED this run, and `planReconciliation` creates a given SimpleFin tx id
 * exactly once — by the next sync the row is an existing, unchanged row and
 * nothing can re-derive the alert. `sendTelegramMessage` reports an API-level
 * failure by RESOLVING `{ ok: false }` rather than throwing, so discarding the
 * result here would silently lose the notification forever, which is precisely
 * the failure this queue exists to prevent.
 *
 * A non-attempt (no `telegram_config`, unreadable config, or Telegram
 * deliberately disabled) DROPS the queue instead of growing it: there is no
 * token to send with, so retrying can never succeed, and a user who has opted
 * out would otherwise accumulate an unbounded backlog. Same tradeoff, and the
 * same reasoning, as `sendStuckTransferAlert` reporting a non-attempt as
 * delivered.
 *
 * Must never throw: it runs after a sync that already succeeded, and a
 * notification problem must not be recorded as a sync failure.
 */
async function deliverLargeTransactionAlerts(
  wfClient: WealthfolioClient,
  alerts: SyncResult['largeTransactionAlerts'],
): Promise<void> {
  type Alert = SyncResult['largeTransactionAlerts'][number];
  try {
    const raw = await wfClient.getAddonSecret('simplefin-sync', LARGE_TX_OUTBOX_KEY).catch(() => null);
    const queued = parseSecretJson<Alert[]>(raw, LARGE_TX_OUTBOX_KEY) ?? [];
    // Keyed by tx id so a queued retry and a re-reported alert for the same
    // transaction can only be sent once.
    const pending = [...queued];
    for (const alert of alerts) {
      if (!pending.some((q) => q.txId === alert.txId)) pending.push(alert);
    }
    if (pending.length === 0) return;

    const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null);
    const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
    const canSend = !!tg && !!tg.botToken && !!tg.chatId && tg.enabled !== false;

    const undelivered: Alert[] = [];
    if (canSend) {
      for (const alert of pending) {
        const result = await sendTelegramMessage(
          tg.botToken,
          tg.chatId,
          formatLargeTransactionAlert(alert),
        );
        if (!result.ok) {
          log(`Large-transaction alert failed to send, will retry next sync: ${result.description}`);
          undelivered.push(alert);
        }
      }
    }

    // Only write when the stored queue actually changes, matching the
    // `linkFailuresChanged` discipline runSyncCore uses for its own ledger.
    const changed =
      undelivered.length !== queued.length ||
      undelivered.some((a, i) => a.txId !== queued[i]?.txId);
    if (changed) {
      await wfClient.setAddonSecret('simplefin-sync', LARGE_TX_OUTBOX_KEY, JSON.stringify(undelivered));
    }
  } catch (err) {
    debug(`Large-transaction alert delivery failed: ${formatError(err)}`);
  }
}

/**
 * Read the Amazon forwarding mailbox into the order ledger.
 *
 * Entirely optional and entirely non-fatal: an unconfigured mailbox returns
 * nothing, and a mailbox that will not connect logs and returns nothing. Neither
 * may stop a sync — bank data is the product, Amazon categories are a nicety, and
 * a wrong app password must not cost the user their transactions.
 */
async function pollAmazonMail(
  store: RestSyncStore,
  wfClient: WealthfolioClient,
): Promise<AmazonIngestResult['newLabels']> {
  let cfg: AmazonMailConfig | null = null;
  try {
    cfg = await store.getAmazonConfig();
  } catch {
    return [];
  }
  // Env wins over the addon card, for anyone who would rather keep credentials in
  // their compose file than in Wealthfolio's secrets.
  const merged: AmazonMailConfig = {
    ...(cfg ?? {}),
    host: process.env.AMAZON_IMAP_HOST ?? cfg?.host,
    port: process.env.AMAZON_IMAP_PORT ? Number(process.env.AMAZON_IMAP_PORT) : cfg?.port,
    user: process.env.AMAZON_IMAP_USER ?? cfg?.user,
    password: process.env.AMAZON_IMAP_PASSWORD ?? cfg?.password,
  };
  if (!amazonMailConfigured(merged)) return [];

  let source: MailSource | null = null;
  try {
    source = await createImapSource(merged);
    const result = await ingestAmazonMail(source, store, merged, Date.now());
    log(
      `Amazon mail: ${result.scanned} scanned, ${result.added} orders added` +
      `${result.ignored ? `, ${result.ignored} delivery notices skipped` : ''}` +
      `${result.unparsed ? `, ${result.unparsed} unrecognised` : ''}` +
      `${result.pruned ? `, ${result.pruned} pruned` : ''}`,
    );
    // Named senders, not just a count. Unrecognised mail from a marketing address
    // means the forwarding filter is too broad; unrecognised mail from an ORDER
    // address means Amazon changed the format and categorization has stopped
    // working. The count alone cannot distinguish those.
    for (const [who, n] of Object.entries(result.unparsedSenders)) {
      log(`Amazon mail: ${n} unrecognised message(s) from ${who}`);
    }
    // Published EVERY run the scan actually completed — including
    // `unparsed: 0` — so a parser fix clears the addon's warning instead of
    // leaving it stuck once the format breaks again. Reaching this line at
    // all already proves the scan ran; a connection error below skips it
    // entirely rather than overwriting a real warning with a false all-clear.
    // Wrapped in its own catch, same swallow-and-continue posture as every
    // other status publish here (see `publishUncategorizedStatus`): a stats
    // secret must never be able to fail a sync.
    await wfClient
      .setAddonSecret(
        'simplefin-sync',
        AMAZON_MAIL_STATUS_SECRET_KEY,
        JSON.stringify({ unparsed: result.unparsed, asOf: new Date().toISOString() }),
      )
      .catch(() => {});
    return result.newLabels;
  } catch (err) {
    log(`Amazon mail error (categorization skipped this run): ${formatError(err)}`);
    return [];
  } finally {
    await source?.close().catch(() => {});
  }
}

/**
 * Announce labels Amazon has used for the first time.
 *
 * Sent once per label, ever. An unmatched one is the actionable case — it went to
 * the default and wants a pattern — so it is called out explicitly rather than
 * listed alongside the ones that filed themselves correctly.
 */
async function sendAmazonNewLabelNotice(
  wfClient: WealthfolioClient,
  labels: AmazonIngestResult['newLabels'],
): Promise<void> {
  try {
    const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null);
    const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
    if (!tg?.botToken || !tg?.chatId) return;
    const lines = labels.map((l) =>
      l.matched
        ? `• ${escapeMarkdown(l.label)} → ${escapeMarkdown(l.category)}`
        : `• ${escapeMarkdown(l.label)} → ${escapeMarkdown(l.category)} (no rule yet)`,
    );
    const unmatched = labels.filter((l) => !l.matched).length;
    const message = [
      `*New Amazon categor${labels.length === 1 ? 'y' : 'ies'}*`,
      '',
      ...lines,
      ...(unmatched
        ? ['', escapeMarkdown('Anything marked "no rule yet" landed in the default category. Add a rule for it on the Sync page.')]
        : []),
    ].join('\n');
    await sendTelegramMessage(tg.botToken, tg.chatId, message);
  } catch (err) {
    log(`Amazon label notice error: ${formatError(err)}`);
  }
}

export async function runCompanionSync(): Promise<SyncResult> {
  const apiUrl = process.env.WEALTHFOLIO_API_URL ?? '';
  if (!apiUrl) throw new Error('Missing WEALTHFOLIO_API_URL');

  const wfClient = new WealthfolioClient(apiUrl);
  const apiKey = process.env.WEALTHFOLIO_API_KEY;
  log(`Connecting to Wealthfolio at ${apiUrl}...`);
  if (apiKey) {
    (wfClient as unknown as { token: string }).token = apiKey;
    debug('Using WEALTHFOLIO_API_KEY for authentication');
  } else {
    const password = resolvePassword();
    if (password) {
      log('Authenticating with Wealthfolio...');
      let attempts = 0;
      while (true) {
        try {
          await wfClient.login(password);
          log('Authenticated successfully.');
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 5) throw err;
          log(`Wealthfolio starting up — retrying connection in 3s (${attempts}/5)...`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

  const store = new RestSyncStore(wfClient);
  const host = new RestSyncHost(wfClient);

  try {
    log('Reading SimpleFin credentials from Wealthfolio addon secrets...');
    const accessUrl = await store.getAccessUrl();
    if (!accessUrl) {
      log('No SimpleFin access URL found in Wealthfolio addon secrets. Please configure the SimpleFin Sync addon in Wealthfolio first.');
      const empty: SyncResult = {
        imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [],
        importedTransactions: [], largeTransactionAlerts: [], balanceDriftAlerts: [],
        prunedDuplicates: [],
      };
      // Not-yet-configured is treated as healthy, not a failure: it's the
      // expected state before the user sets up SimpleFin, and would
      // otherwise spam a "sync is broken" alert on every fresh install.
      // Caveat: this can't distinguish "never configured" from "the access
      // URL secret was cleared after previously working" — either way health
      // reports OK and the failure-streak clock never starts. Judged an
      // acceptable blind spot since nothing in this codebase clears that
      // secret except the addon's own setup flow.
      await updateSyncHealth(wfClient, null);
      return empty;
    }

    const minIntervalHours = parseFloat(process.env.MIN_SYNC_INTERVAL_HOURS ?? '1');
    const force = minIntervalHours <= 0;

    // Amazon mail is read here rather than on a cron of its own. The ledger is
    // only ever READ during a sync, so polling more often buys nothing but
    // another moving part — and Amazon's order emails arrive a day or two ahead
    // of the charge anyway. Doing it immediately before the sync also makes the
    // ordering guaranteed instead of a race between two schedules.
    const amazonNewLabels = await pollAmazonMail(store, wfClient);

    log(`Fetching SimpleFin transactions from ${maskUrl(accessUrl)}...`);
    const result = await runSyncCore(host, store, { force });

    for (const err of result.errors) {
      log(`Sync note: ${err}`);
    }
    log(`Done: ${result.imported} imported, ${result.skipped} skipped`);

    // Record which companion build produced this run, so the Sync page can show
    // it. Best-effort: a failure here must never affect the sync.
    await wfClient
      .setAddonSecret('simplefin-sync', COMPANION_VERSION_SECRET_KEY, SIMPLEFIN_SYNC_VERSION)
      .catch(() => {});

    // Every sync, not just report runs: the addon's category selector is
    // unusable without this, and a sync happens far more often than a report.
    await publishCategoryCatalog(wfClient, currentYearMonth(new Date()));

    // Guarded inside publishUncategorizedStatusForDbPath on the path existing:
    // with no database there is no count, and publishing 0 would claim "nothing
    // needs a category", which is false rather than unknown.
    //
    // Same `|| '/mnt/wealthfolio.db'` default as every other db reader in this
    // file, not a bare `?? ''`. `''` never exists, so an install that mounted the
    // database but did not set the variable — which the compose snippets have not
    // always asked for — published nothing at all and the "Needs a category" tile
    // simply never appeared, with no error to explain why. The default is safe
    // precisely because of the guard: a wrong path publishes nothing, exactly as
    // an empty one did, rather than a confident zero.
    await publishUncategorizedStatusForDbPath(
      process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db',
      (key, value) => wfClient.setAddonSecret('simplefin-sync', key, value),
      (dbPath, start, end) => getNativeUncategorizedSpending(dbPath, start, end),
      async () => parseSecretJson<DismissalLedger>(
        await wfClient.getAddonSecret('simplefin-sync', 'uncategorized_dismissals'),
        'uncategorized_dismissals',
      ) ?? {},
    );

    const undeliveredOutTxIds: string[] = [];
    for (const alert of result.stuckTransferAlerts) {
      const delivered = await sendStuckTransferAlert(wfClient, alert);
      if (!delivered) undeliveredOutTxIds.push(alert.outTxId);
    }
    await rollBackUndeliveredStuckTransferAlerts(store, undeliveredOutTxIds);

    await deliverLargeTransactionAlerts(wfClient, result.largeTransactionAlerts);

    if (amazonNewLabels.length > 0) {
      await sendAmazonNewLabelNotice(wfClient, amazonNewLabels);
    }

    const undeliveredDrift: Array<{ sfinAccountId: string; phase: 'young' | 'aged' }> = [];
    for (const alert of result.balanceDriftAlerts) {
      const delivered = await sendBalanceDriftAlert(wfClient, alert);
      if (!delivered) undeliveredDrift.push({ sfinAccountId: alert.sfinAccountId, phase: alert.phase });
    }
    await rollBackUndeliveredDriftAlerts(store, undeliveredDrift);

    await deliverDuplicatePruneNotice(wfClient, result.prunedDuplicates);

    try {
      const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
      const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
      if (tg && tg.botToken && tg.chatId && tg.enabled !== false) {
        log(`Telegram notifications active (chat: ${tg.chatId}).`);
        if (result.imported > 0 && tg.notifyOnImport !== false) {
          await sendImportNotice(wfClient, tg, result);
        }
      }
    } catch (err) {
      debug(`Telegram check note: ${formatError(err)}`);
    }

    await updateSyncHealth(wfClient, null);
    return result;
  } catch (err) {
    await updateSyncHealth(wfClient, err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    await checkSyncHealthAlert(wfClient).catch(() => {});
  }
}

/** The currently in-flight sync, or `null` when none is running. Module-level
 *  so `/sync` (Task 6) and the cron schedule genuinely share one lock instead
 *  of each starting its own overlapping run against the same SimpleFin
 *  session and database. */
let syncInFlight: Promise<SyncResult> | null = null;

/**
 * Starts `runner()` unless a previous call is still in flight, in which case
 * it hands back the SAME promise instead of starting a second run.
 *
 * `runner` defaults to `runCompanionSync` and only exists as a parameter so
 * tests can control exactly when a run settles (a plain `vi.mock` cannot fake
 * one export of this module from another export of the SAME module).
 *
 * The slot is cleared in `.finally`, not just on success: a rejected sync
 * that left the slot occupied would wedge `/sync` and the cron schedule
 * behind a permanently "in flight" run until the container restarts.
 */
export function runCompanionSyncExclusive(
  runner: () => Promise<SyncResult> = runCompanionSync,
): { started: boolean; result: Promise<SyncResult> } {
  if (syncInFlight) {
    return { started: false, result: syncInFlight };
  }
  const result = runner().finally(() => {
    syncInFlight = null;
  });
  syncInFlight = result;
  return { started: true, result };
}

function unionCategoryNames(spentMap: Record<string, number>, budgetMap: Record<string, number>): string[] {
  return Array.from(new Set([...Object.keys(spentMap), ...Object.keys(budgetMap)])).sort();
}

function filterCategories(names: string[], selection: string[] | 'all' | undefined): string[] {
  if (!selection || selection === 'all') return names;
  const allowed = new Set(selection);
  return names.filter((n) => allowed.has(n));
}

function lastDayOfMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

/** Days remaining in the month COUNTING TODAY — 1 on the last day, because
 *  today is still a day money can be spent. The digest divides by this kind of
 *  inclusive horizon directly, so an off-by-one here silently mis-sizes every
 *  figure in the message. */
function daysLeftInMonthInclusive(now: Date): number {
  return Math.max(1, lastDayOfMonth(now) - now.getDate() + 1);
}

/**
 * The most recent Monday on or before `now` — the calendar week, with no month
 * boundary applied.
 *
 * Split out of `weekStartDate` so the two consumers can differ on the clamp
 * without either recomputing "which Monday": the daily digest needs the clamped
 * start (a budget cannot be spent before its month), the weekly report's
 * biggest-spends window needs the true week (see `sendWeeklyTelegramReport`).
 */
export function mondayOnOrBefore(now: Date): Date {
  const backToMonday = (now.getDay() + 6) % 7; // Monday -> 0, Sunday -> 6
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - backToMonday);
}

/**
 * The start of the week the weekly envelope is measured from: the most recent
 * Monday on or before today, clamped to the 1st of the month.
 *
 * The clamp is not cosmetic. A monthly budget cannot be spent before the month
 * started, so a week reaching back into the previous month would size the
 * envelope over days that no part of this budget covers — in a month starting
 * mid-week, that understates the first week's allowance and makes
 * `monthSpent - weekSpent` meaningless.
 *
 * Exported for tests; the date arithmetic deliberately lives here rather than
 * in `shared/`, which stays a pure string builder fed plain numbers.
 */
export function weekStartDate(now: Date): Date {
  const monday = mondayOnOrBefore(now);
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return monday.getTime() < firstOfMonth.getTime() ? firstOfMonth : monday;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The calendar month BEFORE `now`: the `YYYY-MM` key the native readers take,
 * plus its display name.
 *
 * The monthly wrap-up runs on the 1st and describes the month that just ended,
 * so every figure and the header both hang off this one computation. The
 * year rollover is the case worth a helper of its own: on 1 January the answer
 * is December of the PREVIOUS year, and the naive `month - 1` asks for
 * `2027-00`, which matches no `activity_date` and no `period_key`. That failure
 * is silent — the report renders as "nothing to report" — and it happens once a
 * year, so it would be noticed, if at all, long after the data was gone.
 * `new Date(y, m - 1, 1)` normalises `-1` to the previous December for free.
 *
 * Both fields come from the same `Date` deliberately: a header naming a
 * different month from the figures beneath it is the other way this goes wrong.
 * Month names are a literal table rather than `toLocaleString`, so the output
 * cannot shift with the container's locale.
 *
 * The day of `now` is irrelevant — a manual run mid-month still describes the
 * month that ended — which is why the 1st is nowhere in this arithmetic.
 *
 * Exported for tests; like `weekStartDate`, the date arithmetic lives here
 * rather than in `shared/`, which stays a pure string builder fed plain data.
 */
export function previousYearMonth(now: Date): { yearMonth: string; monthName: string } {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return {
    yearMonth: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    monthName: MONTH_NAMES[d.getMonth()],
  };
}

/** Local-time `YYYY-MM-DD`. Deliberately not `toISOString()`, which converts to
 *  UTC and would shift the date by a day for anyone west of Greenwich —
 *  `activity_date` in wealthfolio.db is a plain local date string. */

const UNCATEGORIZED_SWEEP_DAYS = 30;

/**
 * The per-sync import notice: what this run imported, plus a sweep of EVERY
 * spending row from the last 30 days that still has no category — not just this
 * run's rows. The sweep is what makes the DB snapshot's write lag harmless (an
 * invisible row is caught by the next notice instead of being mislabelled now)
 * and what covers addon-imported transactions, which have no notice of their
 * own. Design: docs/superpowers/specs/2026-07-30-import-notice-and-daily-split-design.md
 */
export async function sendImportNotice(
  wfClient: WealthfolioClient,
  tg: { botToken: string; chatId: string },
  result: Pick<SyncResult, 'imported' | 'importedTransactions'>,
): Promise<void> {
  // Read the ledger BEFORE the sweep, because it is what filters the notice.
  // Button presses are already in it: the always-on listener
  // (companion/src/telegram-listener.ts) records a tap within about a second, so
  // this path no longer polls Telegram for them — and must not, since Telegram
  // serves `getUpdates` to exactly one reader per bot token.
  let ledger: DismissalLedger =
    parseSecretJson<DismissalLedger>(
      await wfClient.getAddonSecret('simplefin-sync', 'uncategorized_dismissals'),
      'uncategorized_dismissals',
    ) ?? {};
  // Unmutated copy of that first read — this is `base` for the merge at write
  // time: what this run's delta (the entries it ages out) is measured against,
  // not what ends up on disk.
  const base: DismissalLedger = { ...ledger };

  // Pruning stays on the sync path, and this is the only place it happens: the
  // listener's per-tap write deliberately only ever ADDS one id, so without
  // this the ledger would grow forever.
  const pruned = pruneDismissals(ledger, new Date());
  const prunedAnything = Object.keys(pruned).length !== Object.keys(ledger).length;
  ledger = pruned;
  if (prunedAnything) {
    // Re-read immediately before writing rather than reuse the read from above.
    // Both the addon AND the listener write this same secret with no
    // compare-and-swap, so persisting the earlier snapshot would silently erase
    // a dismissal made in between — the row would just reappear as needing a
    // category. Merge this run's own delta (`base` → `ledger`) onto whatever is
    // persisted right now instead.
    const persisted =
      parseSecretJson<DismissalLedger>(
        await wfClient.getAddonSecret('simplefin-sync', 'uncategorized_dismissals'),
        'uncategorized_dismissals',
      ) ?? {};
    const merged = pruneDismissals(mergeDismissals(persisted, base, ledger), new Date());
    await wfClient.setAddonSecret('simplefin-sync', 'uncategorized_dismissals', JSON.stringify(merged));
  }

  // End bound is TOMORROW: activity_date carries a time component, so a
  // same-day row would fall outside a today-exclusive window.
  const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
  const now = Date.now();
  const uncategorized = getNativeUncategorizedSpending(
    dbPath,
    toDateString(new Date(now - UNCATEGORIZED_SWEEP_DAYS * 86400_000)),
    toDateString(new Date(now + 86400_000)),
  ).filter((r) => !(r.activityId in ledger));

  const display = (notes: string) => descriptionFromComment(notes) || notes;
  const text = formatImportNotice(
    result.importedTransactions,
    uncategorized.map((r) => ({
      description: display(r.notes),
      amountCents: r.amountCents,
      date: r.date,
      accountName: r.accountName,
    })),
  );
  // Buttons for exactly the rows the notice SHOWS — a button for a "+N more"
  // row would dismiss something the user never saw.
  const shown = uncategorized.slice(0, IMPORT_NOTICE_UNCATEGORIZED_CAP);
  const keyboard = shown.length > 0
    ? buildDismissKeyboard(shown.map((r) => ({
        activityId: r.activityId,
        description: display(r.notes),
        amountCents: r.amountCents,
      })))
    : undefined;
  await sendTelegramMessage(tg.botToken, tg.chatId, text, undefined, keyboard);
}


/**
 * The user's chosen report decoration, or the clean default.
 *
 * Read per report rather than cached: the companion is long-lived and the setting
 * is edited in the addon, so a cached copy would ignore a change until the next
 * container restart. A corrupt or absent secret reads as the default, which is
 * the same "treat unreadable as unset" rule every other secret here follows.
 */
async function readGlyphStyle(wfClient: WealthfolioClient): Promise<GlyphStyle> {
  const raw = await wfClient
    .getAddonSecret('simplefin-sync', 'report_glyph_style')
    .catch(() => null);
  const parsed = parseSecretJson<Partial<GlyphStyle>>(raw, 'report_glyph_style');
  if (!parsed) return DEFAULT_GLYPH_STYLE;
  return {
    mode: parsed.mode === 'glyphs' ? 'glyphs' : 'clean',
    overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
  };
}


/** The user's subcategory display choice; `rollup` unless explicitly set, so the
 *  default report shape is unchanged. */
async function readSubcategoryDisplay(wfClient: WealthfolioClient): Promise<'rollup' | 'breakdown'> {
  const raw = await wfClient
    .getAddonSecret('simplefin-sync', 'subcategory_display')
    .catch(() => null);
  return raw === 'breakdown' ? 'breakdown' : 'rollup';
}

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Publish the category catalog the addon's selector reads.
 *
 * Separate from the report paths because it belongs to neither: it describes what
 * categories EXIST, which is true whether or not a report is due. Living only
 * inside the daily/weekly/monthly functions meant a fresh deployment showed the
 * legacy budget-or-spent list — no icons, no subcategories — until 8am the next
 * morning (observed 2026-08-07).
 *
 * Best-effort: a failure here must never affect a sync or a report.
 */
async function publishCategoryCatalog(
  wfClient: WealthfolioClient,
  yearMonth: string,
): Promise<void> {
  try {
    const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio/wealthfolio.db';
    const catalog = getNativeCategoryCatalog(dbPath, yearMonth);
    if (catalog.length === 0) return;
    await wfClient.setAddonSecret(
      'simplefin-sync',
      'report_category_catalog',
      JSON.stringify(catalog),
    );
  } catch (err) {
    debug(`Category catalog publish skipped: ${formatError(err)}`);
  }
}

/** `YYYY-MM` for the given moment, matching how budgets are keyed. */
function currentYearMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function publishAvailableCategories(
  wfClient: WealthfolioClient,
  spentMap: Record<string, number>,
  budgetMap: Record<string, number>,
  yearMonth?: string,
): Promise<string[]> {
  const names = unionCategoryNames(spentMap, budgetMap);
  await wfClient.setAddonSecret('simplefin-sync', 'available_report_categories', JSON.stringify(names));

  // The old string array above is still written so an addon that predates the
  // catalog keeps working; the catalog itself is what the current selector reads.
  if (yearMonth) await publishCategoryCatalog(wfClient, yearMonth);
  return names;
}

/**
 * The raw per-category budget/spend numbers for `now`'s month, EVERY category
 * seen in either the spend or the budget map — never filtered by the digest's
 * `dailyReportCategories` selection, which is a presentation choice that
 * belongs to the digest path, not this data seam. `/left` (Task 6) deliberately
 * sees every category, configured or not.
 *
 * Pure and synchronous: no `wfClient`, no secret reads, no awaits. The daily
 * digest below and the command handlers both build on this same assembly so
 * the two can never disagree about what "this week" or "this month" means.
 */
export function readBudgetSnapshot(dbPath: string, now: Date): {
  categories: CategoryBudgetSnapshot[];
  period: BudgetPeriod;
} {
  const yearMonth = currentYearMonth(now);
  const spentMap = getNativeWealthfolioSpending(dbPath, yearMonth);
  const budgetMap = getNativeWealthfolioBudgets(dbPath, yearMonth);

  const weekStart = weekStartDate(now);
  const nextMonthStart = toDateString(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  // Same upper bound as the month reader, not "up to today": that keeps
  // `monthSpent - weekSpent` exactly equal to "spent earlier this month", even
  // when an activity carries a date later in the month. A tighter bound here
  // would push such an activity into `spentBeforeWeek` and shrink the week's
  // envelope for a purchase that has not happened yet.
  const weekSpentMap = getNativeWealthfolioSpendingBetween(dbPath, toDateString(weekStart), nextMonthStart);

  const names = unionCategoryNames(spentMap, budgetMap);
  const categories: CategoryBudgetSnapshot[] = names.map((name) => ({
    name,
    budget: budgetMap[name] ?? 0,
    monthSpent: spentMap[name] ?? 0,
    weekSpent: weekSpentMap[name] ?? 0,
  }));

  return {
    categories,
    period: {
      daysFromWeekStartToMonthEnd: lastDayOfMonth(now) - weekStart.getDate() + 1,
      daysLeftInMonthInclusive: daysLeftInMonthInclusive(now),
    },
  };
}

/**
 * Builds the daily digest message — everything `sendDailyTelegramReport` used
 * to do, minus the send — so a command handler (Task 6) can obtain the exact
 * same text without a Telegram config in hand. Returns `null` when telegram is
 * unconfigured/disabled or the database is missing, mirroring the conditions
 * that used to make `sendDailyTelegramReport` return early without sending.
 */
export async function composeDailyDigestMessage(wfClient: WealthfolioClient): Promise<string | null> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
  const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
  if (!tg) return null;
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return null;
  if (tg.dailyReportEnabled === false) return null;

  const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
  if (!dbPath || !existsSync(dbPath)) {
    log('WEALTHFOLIO_DB_PATH not found or missing, skipping daily digest.');
    return null;
  }

  const now = new Date();
  const yearMonth = currentYearMonth(now);
  const { categories: snapshot, period } = readBudgetSnapshot(dbPath, now);
  const spentMap: Record<string, number> = {};
  const budgetMap: Record<string, number> = {};
  const weekSpentMap: Record<string, number> = {};
  for (const c of snapshot) {
    spentMap[c.name] = c.monthSpent;
    budgetMap[c.name] = c.budget;
    weekSpentMap[c.name] = c.weekSpent;
  }

  // Fed from the MONTH maps on purpose: a week-scoped list would make
  // categories disappear from the addon's Report Categories checklist mid-month
  // just because nothing was spent on them this week.
  const allNames = await publishAvailableCategories(wfClient, spentMap, budgetMap, yearMonth);

  const names = filterCategories(allNames, tg.dailyReportCategories);
  // Children are gathered ONLY when the breakdown is asked for: the extra query
  // buys nothing in rollup mode, which is the default.
  const subcategoryDisplay = await readSubcategoryDisplay(wfClient);
  const childrenByParent = new Map<string, Array<{ name: string; monthSpent: number }>>();
  if (subcategoryDisplay === 'breakdown') {
    const nextMonthStart = toDateString(new Date(now.getFullYear(), now.getMonth() + 1, 1));
    for (const row of getNativeSubcategorySpending(dbPath, `${yearMonth}-01`, nextMonthStart)) {
      if (!row.child) continue; // booked on the parent itself — already in its total
      const list = childrenByParent.get(row.parent) ?? [];
      list.push({ name: row.child, monthSpent: row.spent });
      childrenByParent.set(row.parent, list);
    }
  }

  const categories = names.map((name) => ({
    name,
    monthSpent: spentMap[name] ?? 0,
    weekSpent: weekSpentMap[name] ?? 0,
    budget: budgetMap[name] ?? 0,
    children: childrenByParent.get(name),
  }));
  let message = formatDailySpendingDigest(categories, period, await readGlyphStyle(wfClient), subcategoryDisplay);

  const healthRaw = await wfClient.getAddonSecret('simplefin-sync', 'sync_health').catch(() => null);
  // Guarded parse: this secret only supplies a decorative one-line footer, so
  // an unreadable one must cost the footer, never the digest it hangs off.
  const health = parseSecretJson<SyncHealth>(healthRaw, 'sync_health');
  const footer = formatSyncHealthFooter(health);
  if (footer) {
    message += `\n\n${footer}`;
  }

  return message;
}

export async function sendDailyTelegramReport(wfClient: WealthfolioClient): Promise<void> {
  const message = await composeDailyDigestMessage(wfClient);
  if (message === null) return;

  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
  const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
  if (!tg || !tg.botToken || !tg.chatId) return;

  const result = await sendTelegramMessage(tg.botToken, tg.chatId, message);
  if (result.ok) {
    log('Daily Telegram spending check sent successfully.');
  } else {
    log(`Failed to send daily Telegram report: ${result.description}`);
  }
}

/** How many of the week's biggest spends the Saturday report lists when the
 *  config says nothing. Five fits a phone screen under the headline without
 *  turning the report into a statement. */
const DEFAULT_WEEKLY_TOP_SPEND_COUNT = 5;

/**
 * Sends the Saturday check-in: the month's remaining figure, plus the week's
 * biggest individual spends underneath it so that one number has a "why".
 *
 * The window for those spends is the TRUE calendar week — `mondayOnOrBefore`,
 * NOT the digest's `weekStartDate`. The digest clamps its week to the 1st of the
 * month because a monthly budget cannot be spent before the month began; that
 * reasoning does not apply to "what did I spend this week", and the clamp would
 * do real damage here. This report is scheduled for Saturday, so on any month
 * whose 1st falls Tue–Sat the clamp would silently shrink the window — on
 * Saturday 1 August 2026 to a single day — while the heading still said
 * "this week". The bound stays half-open and runs a full seven days from that
 * Monday, so the section covers exactly Monday–Sunday however the month falls
 * and whatever day the report is triggered on.
 */
export async function sendWeeklyTelegramReport(wfClient: WealthfolioClient): Promise<void> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
  const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
  if (!tg) return;
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;
  if (tg.weeklyReportEnabled === false) return;

  const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
  if (!dbPath || !existsSync(dbPath)) {
    log('WEALTHFOLIO_DB_PATH not found or missing, skipping weekly summary.');
    return;
  }

  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const spentMap = getNativeWealthfolioSpending(dbPath, yearMonth);
  const budgetMap = getNativeWealthfolioBudgets(dbPath, yearMonth);
  const allNames = await publishAvailableCategories(wfClient, spentMap, budgetMap, yearMonth);

  const names = filterCategories(allNames, tg.weeklyReportCategories);
  const totalSpent = names.reduce((sum, n) => sum + (spentMap[n] ?? 0), 0);
  const totalBudget = names.reduce((sum, n) => sum + (budgetMap[n] ?? 0), 0);

  // `0` (or negative) turns the section off without touching the rest of the
  // report; absent means the default, so a config written before this section
  // existed gets it.
  const topCount = typeof tg.weeklyTopSpendCount === 'number'
    ? tg.weeklyTopSpendCount
    : DEFAULT_WEEKLY_TOP_SPEND_COUNT;
  const weekStart = mondayOnOrBefore(now);
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
  // Deliberately NOT filtered by `weeklyReportCategories`: the categories list
  // narrows which BUDGETS the headline totals, whereas this section answers
  // "where did the money go this week", and hiding the week's largest charge
  // because its category is not budgeted would make the section quietly
  // misleading. Its rows are labelled with their category, so nothing is
  // ambiguous.
  const topSpends = topCount > 0
    ? getNativeWealthfolioTopSpending(dbPath, toDateString(weekStart), toDateString(weekEnd), topCount)
    : [];

  const message = formatMonthlyRemainingSummary(
    totalSpent,
    totalBudget,
    topSpends.map((t) => ({ amount: t.amount, description: t.description, category: t.categoryName })),
    await readGlyphStyle(wfClient),
  );
  const result = await sendTelegramMessage(tg.botToken, tg.chatId, message);
  if (result.ok) {
    log('Weekly Telegram total-remaining summary sent successfully.');
  } else {
    log(`Failed to send weekly Telegram report: ${result.description}`);
  }
}

/**
 * Sends the monthly wrap-up: how the month that just ended actually finished,
 * per category and in total. Third of the three scheduled reports, and the only
 * retrospective one — the daily digest and the Saturday check-in both describe
 * the month in progress.
 *
 * The one thing this does differently from its two siblings is WHICH month it
 * asks for. It runs on the 1st, so every read is for the PREVIOUS month (see
 * `previousYearMonth`, including the 1-January rollover). Both native readers
 * take that same `YYYY-MM`:
 *
 *  - `getNativeWealthfolioSpending` derives its own `[month-01, nextMonth-01)`
 *    bounds internally, rollover included, so the month string is all it needs.
 *  - `getNativeWealthfolioBudgets` selects `period_key = <month> OR 'default'`
 *    and ranks `(period_key = <month>) DESC, updated_at DESC`, taking the top row
 *    per category. Asking it for a past month is therefore right: a
 *    month-specific budget for that month wins, and only in its absence does
 *    `'default'` stand in. Caveat worth knowing: `'default'` is read as it
 *    stands TODAY, so a default the user has since raised or lowered is applied
 *    retroactively to a closed month. Storing history is the budget table's job,
 *    not this report's.
 *
 * Gated on `monthlyReportEnabled !== false`, matching its siblings: a
 * `telegram_config` written before this report existed opts in rather than
 * silently never firing.
 */
export async function sendMonthlyTelegramReport(wfClient: WealthfolioClient): Promise<void> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
  // Guarded parse: a corrupt secret costs the report that needs it, never a throw
  // escaping into the cron callback.
  const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
  if (!tg) return;
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;
  if (tg.monthlyReportEnabled === false) return;

  const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
  if (!dbPath || !existsSync(dbPath)) {
    log('WEALTHFOLIO_DB_PATH not found or missing, skipping monthly wrap-up.');
    return;
  }

  const { yearMonth, monthName } = previousYearMonth(new Date());
  const spentMap = getNativeWealthfolioSpending(dbPath, yearMonth);
  const budgetMap = getNativeWealthfolioBudgets(dbPath, yearMonth);
  const allNames = await publishAvailableCategories(wfClient, spentMap, budgetMap, yearMonth);

  const names = filterCategories(allNames, tg.monthlyReportCategories);
  const categories = names.map((name) => ({
    name,
    spent: spentMap[name] ?? 0,
    budget: budgetMap[name] ?? 0,
  }));
  const message = formatMonthlyWrapUp(categories, monthName, await readGlyphStyle(wfClient));
  // The result is inspected, not discarded: `sendTelegramMessage` reports an
  // API-level failure (bad token, rate limit, a 400 from malformed Markdown) by
  // RESOLVING `{ ok: false }`, and this report is produced once a month — a
  // silently swallowed failure is a month-long gap nobody is told about.
  const result = await sendTelegramMessage(tg.botToken, tg.chatId, message);
  if (result.ok) {
    log('Monthly Telegram wrap-up sent successfully.');
  } else {
    log(`Failed to send monthly Telegram report: ${result.description}`);
  }
}

/**
 * Records one dismiss-button tap in `uncategorized_dismissals` — the listener's
 * `applyDismissal` dependency.
 *
 * MERGES, never overwrites, and that is the whole point of the function. The
 * addon writes this same secret, and there is no compare-and-swap on an addon
 * secret: a whole-object write from a snapshot read moments earlier silently
 * erases whatever the other host wrote in between, and the symptom is a row the
 * user already dismissed quietly reappearing as needing a category. That was the
 * 1.10.1 bug; `mergeDismissals` exists so it cannot come back. Only the delta
 * (`base` → `next`, i.e. this one id) is replayed onto what is persisted.
 *
 * One read, not two: unlike the sync path's write — which follows a database
 * sweep — nothing slow happens between this read and its write, so a second
 * read immediately after the first would buy nothing but another round trip.
 *
 * An id the ledger already holds writes nothing at all: a second tap on the same
 * button is not a change, and re-writing it would only move its timestamp
 * forward and delay its eventual pruning.
 *
 * Deliberately NOT guarded against a failed write — the listener catches that,
 * logs it, and skips the "Dismissed" confirmation, because confirming a
 * dismissal that was never recorded is a lie the user acts on.
 */
export async function applyTelegramDismissal(
  wfClient: WealthfolioClient,
  activityId: string,
): Promise<void> {
  const base: DismissalLedger =
    parseSecretJson<DismissalLedger>(
      await wfClient.getAddonSecret('simplefin-sync', 'uncategorized_dismissals'),
      'uncategorized_dismissals',
    ) ?? {};
  if (activityId in base) return;
  const next: DismissalLedger = { ...base, [activityId]: new Date().toISOString() };
  const merged = pruneDismissals(mergeDismissals(base, base, next), new Date());
  await wfClient.setAddonSecret('simplefin-sync', 'uncategorized_dismissals', JSON.stringify(merged));
}

/** `/report`'s footer needs the last sync as an ISO string. Read through
 *  `RestSyncStore` rather than the raw secret so the "unparseable date reads as
 *  never" rule lives in exactly one place (see `getLastSyncAt`). */
async function readLastSyncAtIso(wfClient: WealthfolioClient): Promise<string | null> {
  const at = await new RestSyncStore(wfClient).getLastSyncAt().catch(() => null);
  return at ? at.toISOString() : null;
}

/** The `account_balances` snapshot as this file READS it. Structurally the
 *  addon's `AccountBalanceInfo` and `sync-core`'s `AccountBalanceSnapshot`,
 *  neither of which is importable here (one is addon-side React code, the other
 *  is not exported). Both nullable fields are load-bearing: `balance` is null
 *  when SimpleFin reported no numeric balance, and `measured` is absent in a
 *  snapshot written by an older companion build. */
interface StoredAccountBalance {
  balance: number | null;
  currency: string;
  date: number;
  drift: number | null;
  measured?: boolean;
}

/**
 * Assembles `/status` from the secrets the companion already publishes.
 *
 * Every read is guarded INDIVIDUALLY and degrades to omitting its own line: a
 * status command that fails because one optional signal is unreadable is worse
 * than a status command that admits it does not know that one thing.
 *
 * A missing count becomes `null`, never `0`. `formatStatusReply` renders the two
 * differently on purpose — "Needs a category: 0" is a clean bill of health, and
 * an unpublished secret does not support one (see `StatusReplyInput`'s doc
 * comment).
 */
async function readStatusReplyInput(wfClient: WealthfolioClient): Promise<StatusReplyInput> {
  const secret = (key: string) => wfClient.getAddonSecret('simplefin-sync', key).catch(() => null);

  const health = parseSecretJson<SyncHealth>(await secret('sync_health'), 'sync_health');
  const balances =
    parseSecretJson<Record<string, StoredAccountBalance>>(await secret('account_balances'), 'account_balances') ?? {};
  const names = parseSecretJson<Record<string, string>>(await secret('account_names'), 'account_names') ?? {};
  const uncategorized = parseSecretJson<{ count?: number }>(
    await secret(UNCATEGORIZED_STATUS_SECRET_KEY),
    UNCATEGORIZED_STATUS_SECRET_KEY,
  );
  const amazon = parseSecretJson<{ unparsed?: number }>(
    await secret(AMAZON_MAIL_STATUS_SECRET_KEY),
    AMAZON_MAIL_STATUS_SECRET_KEY,
  );

  const accounts: StatusReplyInput['accounts'] = [];
  for (const [sfinAccountId, info] of Object.entries(balances)) {
    // An account SimpleFin gave no numeric balance for is OMITTED rather than
    // reported as $0.00 — the addon shows "—" for exactly this state, and a
    // chat line has no room for the distinction. `/status` is a "what do I need
    // to look at" summary, and an invented zero balance is the one thing here
    // that could be acted on wrongly.
    if (!info || typeof info.balance !== 'number') continue;
    accounts.push({
      // The SimpleFin id as a last resort: an unnamed account is still a real
      // one, and dropping it would silently shorten the list.
      name: names[sfinAccountId] ?? sfinAccountId,
      balance: info.balance,
      currency: typeof info.currency === 'string' ? info.currency : 'USD',
      drift: typeof info.drift === 'number' ? info.drift : null,
      // Absent reads as false: an older build's snapshot proves nothing about
      // whether a comparison actually happened.
      measured: info.measured === true,
    });
  }

  return {
    version: SIMPLEFIN_SYNC_VERSION,
    lastSyncAt: health?.lastSuccessAt ?? null,
    // Nothing persists a per-run import/skip summary today — `sync_health`
    // carries timings and the last error, not counts — so this is honestly
    // `null` rather than a reconstructed guess. `/sync` reports its own run's
    // counts; adding a stored summary would mean a new field in a secret the
    // addon also reads, which is not this task's to change.
    lastSyncSummary: null,
    accounts,
    uncategorizedCount: typeof uncategorized?.count === 'number' ? uncategorized.count : null,
    amazonUnparsed: typeof amazon?.unparsed === 'number' ? amazon.unparsed : null,
  };
}

/** Sent when `/report` has no digest to send: Telegram unconfigured or
 *  disabled, the daily report switched off, or no readable database. Names both
 *  places the fix lives, since neither is discoverable from a chat window. */
const REPORT_UNAVAILABLE_REPLY =
  "Telegram reports are not configured — check budgets and the addon's Notifications tab.";

/** One line for every way `/afford`'s arguments can fail to parse — see
 *  `parseAffordArgs`, which deliberately does not distinguish them. */
const AFFORD_USAGE_REPLY = 'Usage: /afford 20 shopping';

const SYNC_STARTED_REPLY = 'Syncing…';
const SYNC_ALREADY_RUNNING_REPLY = 'Already syncing — hang on.';

/**
 * The bot's command handler: the listener's `onCommand` dependency.
 *
 * Every reply is produced by a formatter in shared/telegram-commands.ts, and
 * every value handed to one is RAW — those formatters own their own
 * `escapeMarkdown` calls, so pre-escaping here would double-escape and show the
 * user backslashes.
 *
 * Nothing is caught: the listener wraps this call, logs whatever escapes, and
 * apologises in the chat. A local catch per command would only duplicate that
 * and risk swallowing something the log needs.
 */
export function buildTelegramCommandHandler(
  wfClient: WealthfolioClient,
): (cmd: ParsedCommand, reply: (text: string) => Promise<void>) => Promise<void> {
  /** `/left` and `/afford` read the same snapshot the daily digest is built
   *  from, so the three can never disagree about what "this week" means. */
  const budgetSnapshot = async () => {
    const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
    return {
      ...readBudgetSnapshot(dbPath, new Date()),
      style: await readGlyphStyle(wfClient),
    };
  };

  return async (cmd, reply) => {
    switch (cmd.command) {
      case 'report': {
        const digest = await composeDailyDigestMessage(wfClient);
        if (digest === null) {
          await reply(REPORT_UNAVAILABLE_REPLY);
          return;
        }
        // The footer reads `last_sync_at` — the timestamp the sync itself
        // stamps — not `sync_health`, so it describes how fresh the DATA behind
        // the digest is rather than when a run last reported success.
        const footer = formatReportFooter(await readLastSyncAtIso(wfClient), new Date());
        await reply(`${digest}\n\n${footer}`);
        return;
      }

      case 'left': {
        const { categories, period, style } = await budgetSnapshot();
        // Empty args mean the bare listing, not a query for "".
        await reply(formatLeftReply(categories, period, style, cmd.args || undefined));
        return;
      }

      case 'afford': {
        const parsed = parseAffordArgs(cmd.args);
        if (!parsed) {
          await reply(AFFORD_USAGE_REPLY);
          return;
        }
        const { categories, period, style } = await budgetSnapshot();
        await reply(formatAffordReply(categories, period, style, parsed.amount, parsed.query));
        return;
      }

      case 'status':
        await reply(formatStatusReply(await readStatusReplyInput(wfClient), new Date()));
        return;

      case 'sync': {
        const { started, result } = runCompanionSyncExclusive();
        // Both handlers are attached to `result` BEFORE the first `await`, and
        // in BOTH branches. That ordering is the point: a sync that rejects
        // while this function is suspended on its acknowledgement reply would
        // otherwise be an unhandled rejection, which kills the daemon and stops
        // bank syncing — the same hazard the cron callbacks' `.catch` guards.
        // Mapping to a string rather than replying inside the callbacks also
        // keeps the order deterministic: the acknowledgement always lands first.
        const summary = result.then(
          (r) => formatSyncReply({
            imported: r.imported,
            skipped: r.skipped,
            driftAlerts: r.balanceDriftAlerts.length,
            errors: r.errors,
          }),
          // RAW error text: `formatSyncReply` escapes it itself.
          (err) => formatSyncReply({ imported: 0, skipped: 0, driftAlerts: 0, errors: [formatError(err)] }),
        );
        await reply(started ? SYNC_STARTED_REPLY : SYNC_ALREADY_RUNNING_REPLY);
        // Awaited in both branches, including `started: false` — a second
        // `/sync` still deserves the outcome of the run it joined, and awaiting
        // is what makes the promise observed rather than floating.
        await reply(await summary);
        return;
      }

      case 'help':
      default:
        // An unknown command gets the same menu, with a line naming what was not
        // understood — a typo is the likeliest reason anyone lands here.
        await reply(formatHelpReply(cmd.command === 'help' ? undefined : cmd.command));
    }
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as any).cause ? ` (${(err as any).cause?.message ?? (err as any).cause})` : '';
    return `${err.message}${cause}`;
  }
  return String(err);
}

// Guard ensures this block does not execute during vitest runs.
if (!process.env.VITEST) {
  const schedule = process.env.SYNC_SCHEDULE ?? '0 */6 * * *';
  const dailySchedule = process.env.DAILY_REPORT_SCHEDULE ?? '0 8 * * *';
  const weeklySchedule = process.env.WEEKLY_REPORT_SCHEDULE ?? '0 9 * * 6'; // Saturday 9am
  const monthlySchedule = process.env.MONTHLY_REPORT_SCHEDULE ?? '0 9 1 * *'; // 1st of the month, 9am

  try {
    validateStartupEnv();
  } catch (err) {
    console.error(`[simplefin-sync] Startup error: ${(err as Error).message}`);
    process.exit(1);
  }

  const apiUrl = process.env.WEALTHFOLIO_API_URL ?? '';
  const wfClient = new WealthfolioClient(apiUrl);

  // Version FIRST in the banner: "which build is running?" is the first
  // question any live diagnosis asks, and until 1.7.0 the only answer was
  // grepping compiled JavaScript inside the container.
  log(`Starting companion v${SIMPLEFIN_SYNC_VERSION} — sync schedule: ${schedule}, daily report schedule: ${dailySchedule}, weekly report schedule: ${weeklySchedule}, monthly report schedule: ${monthlySchedule}`);

  cron.schedule(schedule, () => {
    // Exclusive: `/sync` (Task 6) can fire in between two schedule ticks, and
    // the two must share one lock rather than run two syncs against the same
    // SimpleFin session and database at once.
    runCompanionSyncExclusive().result.catch((err) => log(`Sync error: ${formatError(err)}`));
  });

  cron.schedule(dailySchedule, () => {
    log('Triggering scheduled daily spending check (per-category weekly envelope)...');
    const password = resolvePassword();
    const apiKey = process.env.WEALTHFOLIO_API_KEY;
    if (apiKey) {
      (wfClient as unknown as { token: string }).token = apiKey;
    }
    const loginPromise = apiKey ? Promise.resolve() : (password ? wfClient.login(password) : Promise.resolve());
    loginPromise
      .then(() => sendDailyTelegramReport(wfClient))
      .catch((err) => log(`Daily report error: ${formatError(err)}`));
  });

  cron.schedule(weeklySchedule, () => {
    log('Triggering scheduled weekly budget summary report...');
    const password = resolvePassword();
    const apiKey = process.env.WEALTHFOLIO_API_KEY;
    if (apiKey) {
      (wfClient as unknown as { token: string }).token = apiKey;
    }
    const loginPromise = apiKey ? Promise.resolve() : (password ? wfClient.login(password) : Promise.resolve());
    loginPromise
      .then(() => sendWeeklyTelegramReport(wfClient))
      .catch((err) => log(`Weekly report error: ${formatError(err)}`));
  });

  cron.schedule(monthlySchedule, () => {
    log('Triggering scheduled monthly wrap-up report (previous month)...');
    const password = resolvePassword();
    const apiKey = process.env.WEALTHFOLIO_API_KEY;
    if (apiKey) {
      (wfClient as unknown as { token: string }).token = apiKey;
    }
    const loginPromise = apiKey ? Promise.resolve() : (password ? wfClient.login(password) : Promise.resolve());
    // The `.catch` is the whole point of the chain: a rejection escaping a cron
    // callback is an unhandled rejection, which takes the daemon down and stops
    // syncing entirely over a failed report.
    loginPromise
      .then(() => sendMonthlyTelegramReport(wfClient))
      .catch((err) => log(`Monthly report error: ${formatError(err)}`));
  });

  /**
   * Keeps the session behind the listener's reads usable.
   *
   * The cron callbacks above re-login on every tick because the wf_session JWT
   * does not outlive a process that runs for weeks. The listener has no ticks —
   * it starts once and reads secrets forever — so it needs its own refresh, and
   * without one every read would eventually 401 and the bot would answer
   * nothing while looking perfectly healthy.
   *
   * Bounded by age rather than done per poll: the loop wakes roughly every 50
   * seconds, and a login on each of those would be ~1,700 pointless
   * authentications a day. A throw propagates to `readConfig`, which is exactly
   * where the listener's backoff-and-log path wants it.
   */
  const SESSION_MAX_AGE_MS = 30 * 60 * 1000;
  let sessionEstablishedAt = 0;
  const ensureSession = async (): Promise<void> => {
    if (Date.now() - sessionEstablishedAt < SESSION_MAX_AGE_MS) return;
    const key = process.env.WEALTHFOLIO_API_KEY;
    if (key) {
      (wfClient as unknown as { token: string }).token = key;
    } else {
      const password = resolvePassword();
      if (password) await wfClient.login(password);
    }
    sessionEstablishedAt = Date.now();
  };

  /**
   * The bot's slash commands, and now the ONLY consumer of this token's
   * `getUpdates` stream, dismiss buttons included. Telegram serves that
   * stream to exactly ONE reader, so the once-per-sync poll this replaces had to
   * go in the same commit: two readers means 409s and a bot that appears to
   * ignore every command, none means dismiss buttons stop working.
   *
   * Deliberately never stopped. `stop()` waits out the in-flight long poll — up
   * to ~60 seconds — so hanging a SIGTERM handler on it would either delay
   * every container restart by a minute or, with a timeout, be a promise nobody
   * finishes waiting for. The process exiting drops the connection, which is all
   * the shutdown this loop needs.
   */
  startTelegramListener({
    fetchImpl: fetch,
    // The companion's own SYNCHRONOUS logger, and never wrapped in an `async`
    // function: the listener's `safeLog` guards a THROWN error, and a rejected
    // promise from an async logger would sail straight past that guard —
    // void-return bivariance lets one through the type unnoticed.
    log,
    // Re-read every idle cycle, so configuring or disabling Telegram in the
    // addon takes effect within a minute instead of at the next restart.
    readConfig: async () => {
      await ensureSession();
      const raw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null);
      const tg = parseSecretJson<any>(raw, 'telegram_config');
      // `enabled === false` idles the listener for the same reason it silences
      // every other Telegram path in this file: the user turned the bot off.
      if (!tg?.botToken || !tg?.chatId || tg.enabled === false) return null;
      return {
        botToken: String(tg.botToken),
        chatId: String(tg.chatId),
        // Nothing writes this today; it is read so that a config which later
        // carries the bot's @name makes `/cmd@SomeOtherBot` fall through
        // instead of being answered. Undefined means "answer any @suffix".
        botName: tg.botName ? String(tg.botName) : undefined,
      };
    },
    readOffset: async () => {
      const raw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_update_offset');
      const n = Number(raw);
      return raw != null && raw !== '' && Number.isFinite(n) ? n : null;
    },
    writeOffset: async (n) => {
      await wfClient.setAddonSecret('simplefin-sync', 'telegram_update_offset', String(n));
    },
    applyDismissal: (activityId) => applyTelegramDismissal(wfClient, activityId),
    onCommand: buildTelegramCommandHandler(wfClient),
    // A plain `setTimeout` promise, which cannot reject. The listener hardened
    // itself against a rejecting `sleep` precisely so nobody makes this one
    // abortable to shorten `stop()`; see `pause` in telegram-listener.ts.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  // Run initial sync on startup — through the same guard as the cron tick and
  // `/sync`, so a command arriving while this is still running joins it instead
  // of starting a second sync against the same SimpleFin session and database.
  // The `.catch` is not optional: an unhandled rejection here takes the daemon
  // down and stops syncing entirely.
  runCompanionSyncExclusive().result.catch((err) => log(`Initial sync error: ${formatError(err)}`));
}
