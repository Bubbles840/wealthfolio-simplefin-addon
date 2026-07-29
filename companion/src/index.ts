/**
 * companion/src/index.ts
 *
 * Docker companion service: runs sync on the shared core via REST host adapters.
 * Configuration and access credentials live inside Wealthfolio Addon Secrets
 * (managed in-app by the addon UI), allowing the companion to run as a thin
 * daemon with only instance URL and password.
 */

import cron from 'node-cron';
import * as fs from 'fs';
import { runSyncCore } from '../../shared/sync-core.js';
import { RestSyncHost, RestSyncStore } from './rest-host.js';
import { WealthfolioClient } from './wealthfolio.js';
import { sendTelegramMessage, formatWeeklyRemainingDigest, formatMonthlyRemainingSummary } from '../../shared/telegram.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioBudgets } from './sqlite-native.js';

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
  if (file && fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8').trim();
  }
  return '';
}

export async function runCompanionSync(): Promise<void> {
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

  log('Reading SimpleFin credentials from Wealthfolio addon secrets...');
  const accessUrl = await store.getAccessUrl();
  if (!accessUrl) {
    log('No SimpleFin access URL found in Wealthfolio addon secrets. Please configure the SimpleFin Sync addon in Wealthfolio first.');
    return;
  }

  const minIntervalHours = parseFloat(process.env.MIN_SYNC_INTERVAL_HOURS ?? '1');
  const force = minIntervalHours <= 0;

  log(`Fetching SimpleFin transactions from ${maskUrl(accessUrl)}...`);
  const result = await runSyncCore(host, store, { force });

  for (const err of result.errors) {
    log(`Sync note: ${err}`);
  }
  log(`Done: ${result.imported} imported, ${result.skipped} skipped`);

  try {
    const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
    if (tgRaw) {
      const tg = JSON.parse(tgRaw);
      if (tg.botToken && tg.chatId && tg.enabled !== false) {
        log(`Telegram notifications active (chat: ${tg.chatId}).`);
        if (result.imported > 0 && tg.notifyOnImport !== false) {
          await sendTelegramMessage(
            tg.botToken,
            tg.chatId,
            `🔔 *SimpleFin Sync Update*\nImported ${result.imported} new transaction(s) into Wealthfolio!`,
          );
        }
      }
    }
  } catch (err) {
    debug(`Telegram check note: ${formatError(err)}`);
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

function daysLeftInMonth(now: Date): number {
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(1, lastDay - now.getDate());
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
  if (!tgRaw) return;

  const tg = JSON.parse(tgRaw);
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;
  if (tg.dailyReportEnabled === false) return;

  const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
  if (!dbPath || !fs.existsSync(dbPath)) {
    log('WEALTHFOLIO_DB_PATH not found or missing, skipping daily digest.');
    return;
  }

  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const spentMap = getNativeWealthfolioSpending(dbPath, yearMonth);
  const budgetMap = getNativeWealthfolioBudgets(dbPath, yearMonth);
  const allNames = await publishAvailableCategories(wfClient, spentMap, budgetMap);

  const names = filterCategories(allNames, tg.dailyReportCategories);
  const categories = names.map((name) => ({
    name, spent: spentMap[name] ?? 0, budget: budgetMap[name] ?? 0,
  }));
  const weeksLeft = Math.max(1, Math.ceil(daysLeftInMonth(now) / 7));
  const message = formatWeeklyRemainingDigest(categories, weeksLeft);
  const result = await sendTelegramMessage(tg.botToken, tg.chatId, message);
  if (result.ok) {
    log('Daily Telegram weekly-remaining digest sent successfully.');
  } else {
    log(`Failed to send daily Telegram report: ${result.description}`);
  }
}

export async function sendWeeklyTelegramReport(wfClient: WealthfolioClient): Promise<void> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
  if (!tgRaw) return;

  const tg = JSON.parse(tgRaw);
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;
  if (tg.weeklyReportEnabled === false) return;

  const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
  if (!dbPath || !fs.existsSync(dbPath)) {
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

  try {
    validateStartupEnv();
  } catch (err) {
    console.error(`[simplefin-sync] Startup error: ${(err as Error).message}`);
    process.exit(1);
  }

  const apiUrl = process.env.WEALTHFOLIO_API_URL ?? '';
  const wfClient = new WealthfolioClient(apiUrl);

  log(`Starting companion — sync schedule: ${schedule}, daily report schedule: ${dailySchedule}, weekly report schedule: ${weeklySchedule}`);

  cron.schedule(schedule, () => {
    runCompanionSync().catch((err) => log(`Sync error: ${formatError(err)}`));
  });

  cron.schedule(dailySchedule, () => {
    log('Triggering scheduled daily budget breakdown report...');
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

  // Run initial sync on startup
  runCompanionSync().catch((err) => log(`Initial sync error: ${formatError(err)}`));
}
