/**
 * companion/src/index.ts
 *
 * Cron-driven sync service: pulls transactions from SimpleFin and imports
 * them into Wealthfolio, deduplicating via checkImport on every run.
 *
 * Security requirements enforced here:
 *   - SIMPLEFIN_ACCESS_URL is NEVER logged in plaintext (masked with maskUrl)
 *   - WEALTHFOLIO_API_KEY is NEVER logged
 *   - SIMPLEFIN_ACCESS_URL must use https:// — HTTP rejected at startup
 */

import cron from 'node-cron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fetchAccountsNode } from './simplefin.js';
import { WealthfolioClient } from './wealthfolio.js';
import { mapTransaction } from '../../shared/mapper.js';
import type { AccountMapping, ActivityType, MappingRule } from '../../shared/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActivityImport {
  accountId: string;
  activityType: ActivityType;
  date: string;
  amount: number;
  currency: string;
  sourceSystem: string;
  /** SimpleFin transaction ID — used as the dedup key */
  comment: string;
  isValid: boolean;
  isDraft: boolean;
  /** Set by Wealthfolio's checkImport if the tx already exists */
  isDuplicate?: boolean;
}

// ── Configuration ─────────────────────────────────────────────────────────────

/** Returns the state file path, resolved at call time so tests can override via env. */
function stateFilePath(): string {
  return process.env.STATE_FILE ?? '/app/state.json';
}

// ── Logging ───────────────────────────────────────────────────────────────────

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

// ── Security helpers ──────────────────────────────────────────────────────────

/** Mask the user:pass portion of a URL before logging */
export function maskUrl(url: string): string {
  return url.replace(/\/\/[^@]+@/, '//***@');
}

// ── Env helpers ───────────────────────────────────────────────────────────────

function getEnv(key: string, required = true): string {
  const val = process.env[key];
  if (!val && required) throw new Error(`Missing required env var: ${key}`);
  return val ?? '';
}

// ── State persistence ─────────────────────────────────────────────────────────

export function getLastSyncAt(): Date | null {
  const file = stateFilePath();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const { lastSyncAt } = JSON.parse(raw) as { lastSyncAt?: string };
    return lastSyncAt ? new Date(lastSyncAt) : null;
  } catch {
    return null;
  }
}

export function setLastSyncAt(date: Date): void {
  const file = stateFilePath();
  const dir = dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(file, JSON.stringify({ lastSyncAt: date.toISOString() }));
}

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Validates required env vars at startup.
 * Throws with a descriptive message on the first missing / invalid var.
 * Call this before scheduling the cron job.
 */
export function validateStartupEnv(): void {
  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  if (!accessUrl) {
    throw new Error('Missing required env var: SIMPLEFIN_ACCESS_URL');
  }
  if (!accessUrl.startsWith('https://')) {
    throw new Error(
      'SIMPLEFIN_ACCESS_URL must start with https:// — HTTP URLs are not permitted',
    );
  }
  if (!process.env.WEALTHFOLIO_API_URL) {
    throw new Error('Missing required env var: WEALTHFOLIO_API_URL');
  }
  if (!process.env.ACCOUNT_MAPPING) {
    throw new Error('Missing required env var: ACCOUNT_MAPPING');
  }
}

// ── Core sync logic ───────────────────────────────────────────────────────────

/**
 * Run a single sync cycle:
 *   1. Fetch SimpleFin accounts + transactions
 *   2. For each mapped account, build ActivityImport[]
 *   3. Call checkImport to detect duplicates
 *   4. Import the non-duplicate activities
 *   5. Persist lastSyncAt to STATE_FILE
 */
export async function runCompanionSync(): Promise<void> {
  const accessUrl = getEnv('SIMPLEFIN_ACCESS_URL');
  if (!accessUrl.startsWith('https://')) {
    throw new Error('SIMPLEFIN_ACCESS_URL must start with https://');
  }

  const apiUrl = getEnv('WEALTHFOLIO_API_URL');
  const apiKey = process.env.WEALTHFOLIO_API_KEY; // intentionally not logged
  const mapping: AccountMapping = JSON.parse(getEnv('ACCOUNT_MAPPING'));
  const rules: MappingRule[] = JSON.parse(process.env.MAPPING_RULES ?? '[]');
  const lookbackDays = parseInt(process.env.LOOKBACK_DAYS ?? '7', 10);
  const minIntervalMs =
    parseFloat(process.env.MIN_SYNC_INTERVAL_HOURS ?? '1') * 60 * 60 * 1000;

  // Enforce minimum sync interval to prevent hammering SimpleFin / Wealthfolio
  const lastSyncAt = getLastSyncAt();
  if (lastSyncAt !== null && Date.now() - lastSyncAt.getTime() < minIntervalMs) {
    log('Skipping: minimum sync interval not elapsed');
    return;
  }

  const startDate =
    lastSyncAt ?? new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  debug(`Fetching SimpleFin data from ${maskUrl(accessUrl)} since ${startDate.toISOString()}`);

  // Build Wealthfolio client and authenticate
  const wfClient = new WealthfolioClient(apiUrl);

  if (apiKey) {
    // Inject a pre-provided Bearer token (WEALTHFOLIO_API_KEY).
    // WealthfolioClient.token is TypeScript-private but not a JS private field,
    // so this cast is safe at runtime.
    (wfClient as unknown as { token: string }).token = apiKey;
    debug('Using WEALTHFOLIO_API_KEY for authentication');
  } else {
    const username = process.env.WEALTHFOLIO_USERNAME;
    const password = process.env.WEALTHFOLIO_PASSWORD;
    if (username && password) {
      await wfClient.login(username, password);
      debug('Authenticated with username/password');
    } else {
      debug('No credentials configured — using unauthenticated mode');
    }
  }

  // Fetch accounts from SimpleFin
  const accountSet = await fetchAccountsNode(accessUrl, startDate);

  for (const err of accountSet.errors) {
    log(`SimpleFin error: ${err.code} — ${err.message}`);
  }

  let totalImported = 0;
  let totalSkipped = 0;

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) {
      debug(`No mapping for SimpleFin account ${sfAccount.id} — skipping`);
      continue;
    }

    const transactions = sfAccount.transactions ?? [];
    if (transactions.length === 0) {
      debug(`No transactions for account ${sfAccount.id}`);
      continue;
    }

    debug(
      `Processing ${transactions.length} transactions for ${sfAccount.id} → ${wfAccountId}`,
    );

    const activities: ActivityImport[] = transactions.map((tx) => ({
      accountId: wfAccountId,
      activityType: mapTransaction(tx.description, parseFloat(tx.amount), rules),
      date: new Date(tx.posted * 1000).toISOString().split('T')[0],
      amount: Math.abs(parseFloat(tx.amount)),
      currency: sfAccount.currency,
      sourceSystem: 'simplefin',
      comment: tx.id, // SimpleFin tx ID used as dedup key
      isValid: true,
      isDraft: false,
    }));

    try {
      const checked = (await wfClient.checkImport(
        wfAccountId,
        activities,
      )) as ActivityImport[];

      const toImport = checked.filter((a) => !a.isDuplicate);
      const skipped = checked.length - toImport.length;
      totalSkipped += skipped;

      if (toImport.length > 0) {
        await wfClient.importActivities(toImport);
        totalImported += toImport.length;
      }

      debug(
        `Account ${wfAccountId}: ${toImport.length} imported, ${skipped} duplicate(s) skipped`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Error syncing account ${wfAccountId}: ${msg}`);
    }
  }

  setLastSyncAt(new Date());
  log(`Done: ${totalImported} imported, ${totalSkipped} skipped`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

// Guard ensures this block does not execute during vitest runs.
// Vitest sets process.env.VITEST automatically.
if (!process.env.VITEST) {
  const schedule = process.env.SYNC_SCHEDULE ?? '0 */6 * * *';

  try {
    validateStartupEnv();
  } catch (err) {
    console.error(`[simplefin-sync] Startup error: ${(err as Error).message}`);
    process.exit(1);
  }

  log(`Starting — schedule: ${schedule}`);

  cron.schedule(schedule, () => {
    runCompanionSync().catch((err: Error) => log(`Sync error: ${err.message}`));
  });

  // Run immediately so operators get feedback on startup without waiting for
  // the first cron fire.
  runCompanionSync().catch((err: Error) => log(`Initial sync error: ${err.message}`));
}
