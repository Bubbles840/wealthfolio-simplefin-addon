/**
 * companion/src/cash-forecast-facts.ts
 *
 * Gathers the 30-day cash forecast's reads and publishes `cash_forecast`
 * after each sync (project 5 R1, spec A). The arithmetic and the decisions
 * are shared/forecast.ts and shared/forecast-inputs.ts; this file only reads,
 * each read on its own:
 *
 *  - account_mapping, account_balances and account_names: add-on secrets;
 *  - each account's type and archived/hidden state: `GET /accounts`;
 *  - the report cube (spending history and the detected subscriptions) and
 *    the subscription document: add-on secrets, built into the roster exactly
 *    as every other surface builds it (subscription-data.ts's shape);
 *  - the bills' past charges: the merchant rows (strict — a database that
 *    cannot be read is a reason, never "no charges");
 *  - Wealthfolio's timezone: its settings, null when unreadable (the
 *    process's own zone then).
 *
 * A read that fails becomes `{ ok: false, reason }` — never a number. When
 * Wealthfolio cannot be reached at all nothing is written, so the previous
 * forecast stays.
 */
import { CASH_FORECAST_SECRET_KEY, CASH_FORECAST_STALE_MS, failedForecast, type CashForecast } from '../../shared/cash-forecast.js';
import { zonedDay } from '../../shared/forecast.js';
import {
  buildCashForecast, cashToday, historyMonths, historyWindow, type MerchantRow, type WealthfolioAccountLike,
} from '../../shared/forecast-inputs.js';
import { parseReportCube, REPORT_CUBE_SECRET_KEY } from '../../shared/report-cube.js';
import { loadSubscriptionPrefs, type LoadedSubscriptionPrefs } from '../../shared/subscription-prefs.js';
import { buildRoster } from '../../shared/subscription-roster.js';
import { getNativeAuditSettings } from './sqlite-audit.js';
import { getNativeMerchantRows } from './sqlite-native.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** Everything the forecast reads, so a test can fake each in its real shape. */
export interface ForecastReaders {
  /** One add-on secret; rejects when Wealthfolio cannot be reached. */
  secret(key: string): Promise<string | null>;
  accounts(): Promise<WealthfolioAccountLike[]>;
  /** Throws when the database cannot be read. */
  merchantRows(startInclusive: string, endExclusive: string): MerchantRow[];
  /** Wealthfolio's timezone setting; null when unset or unreadable. */
  timezone(): string | null;
}

export type ForecastClient = Pick<WealthfolioClient, 'getAddonSecret' | 'setAddonSecret' | 'getAccounts'>;

export function companionForecastReaders(client: Pick<ForecastClient, 'getAddonSecret' | 'getAccounts'>, dbPath: string): ForecastReaders {
  return {
    secret: (key) => client.getAddonSecret(ADDON_ID, key),
    accounts: () => client.getAccounts(),
    merchantRows: (start, endEx) => getNativeMerchantRows(dbPath, start, endEx, true),
    timezone: () => {
      try {
        return getNativeAuditSettings(dbPath).timezone;
      } catch {
        return null;
      }
    },
  };
}

class Unreachable extends Error {}

/** A JSON object secret: null when there is none, 'corrupt' when it is not an
 *  object; throws Unreachable when the read itself fails. */
async function readObject<T>(r: ForecastReaders, key: string): Promise<T | null | 'corrupt'> {
  let raw: string | null;
  try {
    raw = await r.secret(key);
  } catch {
    throw new Unreachable(key);
  }
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as T : 'corrupt';
  } catch {
    return 'corrupt';
  }
}

/** The forecast, the reason there is none, or null when Wealthfolio could not be reached. */
export async function runCashForecast(r: ForecastReaders, now: Date): Promise<CashForecast | null> {
  try {
    return await gather(r, now);
  } catch (e) {
    if (e instanceof Unreachable) return null;
    throw e;
  }
}

async function gather(r: ForecastReaders, now: Date): Promise<CashForecast> {
  const mapping = await readObject<Record<string, string>>(r, 'account_mapping');
  if (mapping === 'corrupt') return failedForecast('mapping', now);
  const balances = await readObject<Record<string, { balance?: unknown; date?: unknown }>>(r, 'account_balances');
  if (balances === 'corrupt') return failedForecast('balances', now);
  // Names are cosmetic: an unreadable list falls back to Wealthfolio's own.
  const names = await readObject<Record<string, string>>(r, 'account_names');
  let accounts: WealthfolioAccountLike[];
  try {
    accounts = await r.accounts();
  } catch {
    return failedForecast('accounts', now);
  }
  const cash = cashToday({
    mapping: mapping ?? {}, balances: balances ?? {}, names: names === 'corrupt' ? {} : names ?? {}, accounts,
  });
  // Nothing to forecast: say why before reading anything else.
  if (cash.accounts.length === 0) return failedForecast(cash.missing.length > 0 ? 'noBalance' : 'noCash', now);

  let cubeRaw: string | null;
  try {
    cubeRaw = await r.secret(REPORT_CUBE_SECRET_KEY);
  } catch {
    throw new Unreachable(REPORT_CUBE_SECRET_KEY);
  }
  const cube = parseReportCube(cubeRaw);
  if (!cube) return failedForecast('history', now);
  // A cube the companion has not rebuilt for CASH_FORECAST_STALE_MS has lost
  // months of bills and history: a number from it would be optimistic. An
  // unreadable cube date is as bad as an old one.
  const cubeAt = Date.parse(cube.asOf);
  if (!Number.isFinite(cubeAt) || now.getTime() - cubeAt > CASH_FORECAST_STALE_MS) return failedForecast('history', now);
  let prefs: LoadedSubscriptionPrefs;
  try {
    prefs = await loadSubscriptionPrefs((key) => r.secret(key));
  } catch {
    throw new Unreachable('subscription_prefs');
  }
  // A corrupt document would drop the hand-added bills: say so instead.
  if (prefs.unreadable) return failedForecast('bills', now);

  const today = zonedDay(now, r.timezone());
  const roster = buildRoster({
    detected: cube.subscriptions ?? null,
    merchants: cube.merchants,
    links: cube.subscriptionLinks ?? [],
    prefs: prefs.prefs,
    today,
  });
  const months = historyMonths(cube, today.slice(0, 7));
  let merchantRows: MerchantRow[] = [];
  if (months.length > 0) {
    const { startInclusive, endExclusive } = historyWindow(months);
    try {
      merchantRows = r.merchantRows(startInclusive, endExclusive);
    } catch {
      return failedForecast('database', now);
    }
  }
  return buildCashForecast({ now, today, cash, roster, manual: prefs.prefs.manual, cube, months, merchantRows });
}

/**
 * Computes and writes `cash_forecast`. Writes nothing when Wealthfolio could
 * not be reached (the previous forecast stays); rejects when the write fails.
 * The sync's caller catches and logs either way — a publish never fails or
 * changes a sync.
 */
export async function publishCashForecast(
  client: ForecastClient,
  dbPath: string,
  now: Date,
  readers: ForecastReaders = companionForecastReaders(client, dbPath),
): Promise<boolean> {
  const forecast = await runCashForecast(readers, now);
  if (!forecast) return false;
  await client.setAddonSecret(ADDON_ID, CASH_FORECAST_SECRET_KEY, JSON.stringify(forecast));
  return true;
}
