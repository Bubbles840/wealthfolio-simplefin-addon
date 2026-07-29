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
import { runSyncCore } from '../../shared/sync-core.js';
import type { SyncResult } from '../../shared/sync-core.js';
import { RestSyncHost, RestSyncStore } from './rest-host.js';
import { WealthfolioClient } from './wealthfolio.js';
import { sendTelegramMessage, formatDailySpendingDigest, formatMonthlyRemainingSummary, formatMonthlyWrapUp, formatSyncHealthFooter, formatLargeTransactionAlert, formatBalanceDriftAlert, escapeMarkdown } from '../../shared/telegram.js';
import type { SyncHealth } from '../../shared/telegram.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets } from './sqlite-native.js';

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
  const amount = (alert.amountCents / 100).toFixed(2);
  // `alert.description` is built from bank/card transaction comments — real
  // merchant descriptors routinely contain `*`/`_` (card-network descriptors
  // like "AMAZON *MKTPLACE"), so this needs escaping same as any other
  // arbitrary text reaching a Markdown-parsed message.
  const result = await sendTelegramMessage(
    tg.botToken,
    tg.chatId,
    `⚠️ *Transfer stuck — couldn't auto-link after 3 tries*\n${escapeMarkdown(alert.description)}\nAmount: $${amount} ${alert.currency}\nTry "Reconcile & link" in the addon, or check for a duplicate/mismatched leg.`,
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
  const result = await sendTelegramMessage(tg.botToken, tg.chatId, formatBalanceDriftAlert(alert));
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
  undeliveredAccountIds: string[],
): Promise<void> {
  if (undeliveredAccountIds.length === 0) return;
  try {
    const alerts = await store.getDriftAlerts();
    let changed = false;
    for (const sfinAccountId of undeliveredAccountIds) {
      if (alerts[sfinAccountId]?.alerted) {
        alerts[sfinAccountId] = { ...alerts[sfinAccountId], alerted: false };
        changed = true;
      }
    }
    if (changed) await store.setDriftAlerts(alerts);
  } catch (err) {
    debug(`Balance-drift alert rollback failed (will retry as still-alerted next sync): ${formatError(err)}`);
  }
}

/** Addon secret holding large-transaction alerts a previous run could not
 *  deliver. See `deliverLargeTransactionAlerts` for why an outbox rather than a
 *  rollback flag. */
const LARGE_TX_OUTBOX_KEY = 'pending_large_tx_alerts';

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
        largeTransactionAlerts: [], balanceDriftAlerts: [],
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

    log(`Fetching SimpleFin transactions from ${maskUrl(accessUrl)}...`);
    const result = await runSyncCore(host, store, { force });

    for (const err of result.errors) {
      log(`Sync note: ${err}`);
    }
    log(`Done: ${result.imported} imported, ${result.skipped} skipped`);

    const undeliveredOutTxIds: string[] = [];
    for (const alert of result.stuckTransferAlerts) {
      const delivered = await sendStuckTransferAlert(wfClient, alert);
      if (!delivered) undeliveredOutTxIds.push(alert.outTxId);
    }
    await rollBackUndeliveredStuckTransferAlerts(store, undeliveredOutTxIds);

    await deliverLargeTransactionAlerts(wfClient, result.largeTransactionAlerts);

    const undeliveredDriftAccountIds: string[] = [];
    for (const alert of result.balanceDriftAlerts) {
      const delivered = await sendBalanceDriftAlert(wfClient, alert);
      if (!delivered) undeliveredDriftAccountIds.push(alert.sfinAccountId);
    }
    await rollBackUndeliveredDriftAlerts(store, undeliveredDriftAccountIds);

    try {
      const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
      const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
      if (tg && tg.botToken && tg.chatId && tg.enabled !== false) {
        log(`Telegram notifications active (chat: ${tg.chatId}).`);
        if (result.imported > 0 && tg.notifyOnImport !== false) {
          await sendTelegramMessage(
            tg.botToken,
            tg.chatId,
            `🔔 *SimpleFin Sync Update*\nImported ${result.imported} new transaction(s) into Wealthfolio!`,
          );
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
  const backToMonday = (now.getDay() + 6) % 7; // Monday -> 0, Sunday -> 6
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - backToMonday);
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
function toDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function publishAvailableCategories(
  wfClient: WealthfolioClient,
  spentMap: Record<string, number>,
  budgetMap: Record<string, number>,
): Promise<string[]> {
  const names = unionCategoryNames(spentMap, budgetMap);
  await wfClient.setAddonSecret('simplefin-sync', 'available_report_categories', JSON.stringify(names));
  return names;
}

export async function sendDailyTelegramReport(wfClient: WealthfolioClient): Promise<void> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
  const tg = parseSecretJson<any>(tgRaw, 'telegram_config');
  if (!tg) return;
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;
  if (tg.dailyReportEnabled === false) return;

  const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
  if (!dbPath || !existsSync(dbPath)) {
    log('WEALTHFOLIO_DB_PATH not found or missing, skipping daily digest.');
    return;
  }

  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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

  // Fed from the MONTH maps on purpose: a week-scoped list would make
  // categories disappear from the addon's Report Categories checklist mid-month
  // just because nothing was spent on them this week.
  const allNames = await publishAvailableCategories(wfClient, spentMap, budgetMap);

  const names = filterCategories(allNames, tg.dailyReportCategories);
  const categories = names.map((name) => ({
    name,
    monthSpent: spentMap[name] ?? 0,
    weekSpent: weekSpentMap[name] ?? 0,
    budget: budgetMap[name] ?? 0,
  }));
  let message = formatDailySpendingDigest(categories, {
    daysFromWeekStartToMonthEnd: lastDayOfMonth(now) - weekStart.getDate() + 1,
    daysLeftInMonthInclusive: daysLeftInMonthInclusive(now),
  });

  const healthRaw = await wfClient.getAddonSecret('simplefin-sync', 'sync_health').catch(() => null);
  // Guarded parse: this secret only supplies a decorative one-line footer, so
  // an unreadable one must cost the footer, never the digest it hangs off.
  const health = parseSecretJson<SyncHealth>(healthRaw, 'sync_health');
  const footer = formatSyncHealthFooter(health);
  if (footer) {
    message += `\n\n${footer}`;
  }

  const result = await sendTelegramMessage(tg.botToken, tg.chatId, message);
  if (result.ok) {
    log('Daily Telegram spending check sent successfully.');
  } else {
    log(`Failed to send daily Telegram report: ${result.description}`);
  }
}

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
  const allNames = await publishAvailableCategories(wfClient, spentMap, budgetMap);

  const names = filterCategories(allNames, tg.weeklyReportCategories);
  const totalSpent = names.reduce((sum, n) => sum + (spentMap[n] ?? 0), 0);
  const totalBudget = names.reduce((sum, n) => sum + (budgetMap[n] ?? 0), 0);
  const message = formatMonthlyRemainingSummary(totalSpent, totalBudget);
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
  const allNames = await publishAvailableCategories(wfClient, spentMap, budgetMap);

  const names = filterCategories(allNames, tg.monthlyReportCategories);
  const categories = names.map((name) => ({
    name,
    spent: spentMap[name] ?? 0,
    budget: budgetMap[name] ?? 0,
  }));
  const message = formatMonthlyWrapUp(categories, monthName);
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

  log(`Starting companion — sync schedule: ${schedule}, daily report schedule: ${dailySchedule}, weekly report schedule: ${weeklySchedule}, monthly report schedule: ${monthlySchedule}`);

  cron.schedule(schedule, () => {
    runCompanionSync().catch((err) => log(`Sync error: ${formatError(err)}`));
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

  // Run initial sync on startup
  runCompanionSync().catch((err) => log(`Initial sync error: ${formatError(err)}`));
}
