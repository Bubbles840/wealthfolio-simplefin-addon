/**
 * companion/src/index.ts
 *
 * Cron-driven sync service: pulls transactions from SimpleFin and imports
 * them into Wealthfolio, deduplicating via checkImport on every run.
 *
 * Security requirements enforced here:
 *   - The SimpleFin access URL is NEVER logged in plaintext (masked with maskUrl)
 *   - WEALTHFOLIO_API_KEY is NEVER logged
 *   - The access URL must use https:// — HTTP rejected at startup
 *   - Credentials come from SIMPLEFIN_SETUP_TOKEN (a one-time token claimed on
 *     first run, with the resulting access URL persisted to STATE_FILE) so the
 *     env file never needs to hold live bank credentials. SIMPLEFIN_ACCESS_URL
 *     is still accepted for users who already have their URL.
 */

import cron from 'node-cron';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fetchAccountsNode, claimTokenNode } from './simplefin.js';
import { WealthfolioClient } from './wealthfolio.js';
import { mapTransaction } from '../../shared/mapper.js';
import type { AccountMapping, ActivityType, MappingRule } from '../../shared/types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActivityImport {
  accountId: string;
  activityType: ActivityType;
  date: string;
  /** Wealthfolio's reserved cash symbol: $CASH-{currency} */
  symbol: string;
  amount: number;
  currency: string;
  sourceSystem: string;
  /** "description · SimpleFin tx ID" — title in the UI, and part of the dedup key */
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

interface SyncState {
  lastSyncAt?: string;
  /** Access URL claimed from a one-time setup token — contains credentials,
   *  so the state file must live on a volume that is never committed or shared. */
  accessUrl?: string;
  /** SimpleFin account IDs that already received a starting-balance entry. */
  balanceInitialized?: string[];
}

function readState(): SyncState {
  const file = stateFilePath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SyncState;
  } catch {
    return {};
  }
}

function writeState(patch: Partial<SyncState>): void {
  const file = stateFilePath();
  const dir = dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(file, JSON.stringify({ ...readState(), ...patch }));
}

export function getLastSyncAt(): Date | null {
  const { lastSyncAt } = readState();
  return lastSyncAt ? new Date(lastSyncAt) : null;
}

export function setLastSyncAt(date: Date): void {
  writeState({ lastSyncAt: date.toISOString() });
}

function markBalanceInitialized(sfinAccountId: string): void {
  const current = readState().balanceInitialized ?? [];
  if (!current.includes(sfinAccountId)) {
    writeState({ balanceInitialized: [...current, sfinAccountId] });
  }
}

/**
 * Resolve the SimpleFin access URL, in priority order:
 *   1. Already claimed and persisted in the state file
 *   2. SIMPLEFIN_ACCESS_URL env var (users who already have their URL)
 *   3. SIMPLEFIN_SETUP_TOKEN env var — claim it now (one-time!) and persist
 *      the result so restarts don't re-claim a dead token.
 */
export async function resolveAccessUrl(): Promise<string> {
  const stored = readState().accessUrl;
  if (stored) return stored;

  const fromEnv = process.env.SIMPLEFIN_ACCESS_URL;
  if (fromEnv) return fromEnv;

  const token = process.env.SIMPLEFIN_SETUP_TOKEN;
  if (token) {
    log('Claiming SimpleFin setup token (one-time exchange)...');
    const accessUrl = await claimTokenNode(token);
    writeState({ accessUrl });
    log('Setup token claimed — access URL stored in state file. You can now remove SIMPLEFIN_SETUP_TOKEN from the env file.');
    return accessUrl;
  }

  throw new Error(
    'No SimpleFin credentials: set SIMPLEFIN_SETUP_TOKEN (recommended) or SIMPLEFIN_ACCESS_URL',
  );
}

// ── Startup validation ────────────────────────────────────────────────────────

/**
 * Validates required env vars at startup.
 * Throws with a descriptive message on the first missing / invalid var.
 * Call this before scheduling the cron job.
 */
export function validateStartupEnv(): void {
  const accessUrl = process.env.SIMPLEFIN_ACCESS_URL;
  const setupToken = process.env.SIMPLEFIN_SETUP_TOKEN;
  const alreadyClaimed = !!readState().accessUrl;
  if (!accessUrl && !setupToken && !alreadyClaimed) {
    throw new Error(
      'Missing SimpleFin credentials: set SIMPLEFIN_SETUP_TOKEN (recommended) or SIMPLEFIN_ACCESS_URL',
    );
  }
  if (accessUrl && !accessUrl.startsWith('https://')) {
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
  const accessUrl = await resolveAccessUrl();
  if (!accessUrl.startsWith('https://')) {
    throw new Error('SimpleFin access URL must start with https://');
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
    // Wealthfolio uses password-only auth (no username)
    const password = process.env.WEALTHFOLIO_PASSWORD;
    if (password) {
      await wfClient.login(password);
      debug('Authenticated with password');
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
  let accountErrors = 0;
  const balanceInitialized = readState().balanceInitialized ?? [];
  // Current balances come from the valuations endpoint — the accounts
  // endpoint has no balance field. Any account missing here is treated as 0,
  // which is only correct for brand-new accounts, so a fetch failure aborts
  // starting-balance creation rather than under-correcting.
  let wfBalances: Map<string, number> | null = null;
  try {
    wfBalances = new Map(
      (await wfClient.getLatestValuations()).map((v): [string, number] => [
        v.accountId,
        parseFloat(String(v.totalValue)),
      ]),
    );
  } catch (err) {
    log(`Could not fetch Wealthfolio balances — skipping starting-balance checks this run: ${(err as Error).message}`);
  }

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) {
      debug(`No mapping for SimpleFin account ${sfAccount.id} — skipping`);
      continue;
    }

    // Pending transactions often have no posted timestamp yet (posted: 0),
    // producing a 1970 date the server rejects. They import once posted.
    const transactions = (sfAccount.transactions ?? []).filter(
      (tx) => !tx.pending && tx.posted > 0,
    );

    debug(
      `Processing ${transactions.length} transactions for ${sfAccount.id} → ${wfAccountId}`,
    );

    const activities: ActivityImport[] = transactions.map((tx) => ({
      accountId: wfAccountId,
      activityType: mapTransaction(tx.description, parseFloat(tx.amount), rules),
      date: new Date(tx.posted * 1000).toISOString().split('T')[0],
      symbol: `$CASH-${sfAccount.currency}`,
      amount: Math.abs(parseFloat(tx.amount)),
      currency: sfAccount.currency,
      sourceSystem: 'simplefin',
      // Shown as the activity title; also part of the dedup key, so the
      // SimpleFin tx ID keeps it unique per transaction
      comment: `${tx.description} · ${tx.id}`,
      isValid: true,
      isDraft: false,
    }));

    try {
      // Duplicate detection runs BEFORE the starting-balance calculation so
      // the correction only counts transactions that will actually import.
      // This makes it safe to run the companion alongside the addon's own
      // sync (even on a different SimpleFin token): anything the addon
      // already imported is a duplicate here, contributes nothing to the
      // delta, and the starting balance self-cancels to zero.
      const checked = activities.length > 0
        ? ((await wfClient.checkImport(wfAccountId, activities)) as ActivityImport[])
        : [];

      const toImport = checked.filter((a) => !a.isDuplicate);
      const skipped = checked.length - toImport.length;
      totalSkipped += skipped;

      // One-time starting balance so the account lands on SimpleFin's
      // reported balance instead of just the fetch window's deltas.
      // Skipped entirely when balances couldn't be fetched — a missing
      // balance must never be treated as 0 (that under-corrects).
      const importList = [...toImport];
      if (wfBalances !== null && !balanceInitialized.includes(sfAccount.id)) {
        const signedByComment = new Map(
          transactions.map((tx) => [`${tx.description} · ${tx.id}`, parseFloat(tx.amount)]),
        );
        const targetBalance = parseFloat(sfAccount.balance);
        const windowDelta = toImport.reduce(
          (sum, a) => sum + (signedByComment.get(a.comment) ?? 0),
          0,
        );
        const currentWfBalance = wfBalances.get(wfAccountId) ?? 0;
        const starting = targetBalance - windowDelta - currentWfBalance;
        if (Number.isFinite(starting) && Math.abs(starting) >= 0.01) {
          const oldestPosted = transactions.length > 0
            ? Math.min(...transactions.map((tx) => tx.posted))
            : Math.floor(Date.now() / 1000);
          const dayBefore = new Date((oldestPosted - 24 * 60 * 60) * 1000);
          importList.unshift({
            accountId: wfAccountId,
            activityType: starting > 0 ? 'DEPOSIT' : 'WITHDRAWAL',
            date: dayBefore.toISOString().split('T')[0],
            symbol: `$CASH-${sfAccount.currency}`,
            amount: Math.abs(Math.round(starting * 100) / 100),
            currency: sfAccount.currency,
            sourceSystem: 'simplefin',
            comment: `Starting balance · ${sfAccount.id}`,
            isValid: true,
            isDraft: false,
          });
        }
      }

      if (importList.length > 0) {
        await wfClient.importActivities(importList);
        totalImported += importList.length;
      }

      debug(
        `Account ${wfAccountId}: ${importList.length} imported, ${skipped} duplicate(s) skipped`,
      );
      // Only mark initialized when the starting-balance check actually ran
      if (wfBalances !== null) {
        markBalanceInitialized(sfAccount.id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Error syncing account ${wfAccountId}: ${msg}`);
      accountErrors += 1;
    }
  }

  // Only advance lastSyncAt on a clean run. Advancing it after failures would
  // make the next run skip the same window ("minimum sync interval") and the
  // failed accounts' transactions would be lost until the lookback expires.
  if (accountErrors === 0) {
    setLastSyncAt(new Date());
  } else {
    log(`Not advancing lastSyncAt (${accountErrors} account error(s)) — next run retries the same window`);
  }
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
