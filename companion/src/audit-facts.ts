/**
 * companion/src/audit-facts.ts
 *
 * Gathers the three checks' facts (2c R1, spec B2) and publishes the
 * snapshot the app reads. Every read is wrapped on its own: a failure is
 * named in that check's `failed` (the shared module words the note) and
 * leaves out only its own part — never "nothing wrong".
 *
 * Where each fact comes from:
 *  - account_mapping, account_balances, account_names and the report cube:
 *    add-on secrets, over REST;
 *  - every account's type: `GET /accounts` (so a database that is down costs
 *    only the ledger's part; an account of unknown type is never compared);
 *  - Wealthfolio's figures: `/valuations/latest` and `/spending/insight`;
 *  - from the read-only database (sqlite-audit.ts): the whole ledger (read
 *    once, shared by the balance and Health checks), the month's rows, and
 *    the Spending page's settings — its timezone, excluded categories,
 *    on/off, accounts — with each spending category's parent.
 *
 * `/audit` re-runs these on every tap; the publish runs them after each sync.
 */
import { explainBalances, type BalanceFacts, type BalanceRead } from '../../shared/audit-balance.js';
import { explainHeadline, zonedMonthBounds, type HeadlineDbRow, type HeadlineFacts, type HeadlineRead } from '../../shared/audit-headline.js';
import { healthIssues, type HealthFacts, type HealthRead } from '../../shared/audit-health.js';
import type { AuditLedger } from '../../shared/audit-ledger.js';
import { AUDIT_SNAPSHOT_SECRET_KEY, buildAuditSnapshot, type AuditResults } from '../../shared/audit-snapshot.js';
import { monthlySpendTotals, parseReportCube, REPORT_CUBE_SECRET_KEY } from '../../shared/report-cube.js';
import { heldFromLedger } from '../../shared/held-transfers.js';
import { hasTxOverride, loadSyncOverrides } from '../../shared/sync-overrides.js';
import { getNativeAuditLedger, getNativeAuditSettings, getNativeHeadlineRows } from './sqlite-audit.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** Everything the checks read, so a test can fake each in its real shape. */
export interface AuditReaders {
  /** One add-on secret; rejects when Wealthfolio cannot be reached. */
  secret(key: string): Promise<string | null>;
  valuations(): Promise<Array<{ accountId: string; totalValue: string | number }>>;
  /** Every account with its type (REST), so the type does not depend on the database. */
  accounts(): Promise<Array<{ id: string; accountType?: string }>>;
  /** Throws when the database cannot be read. */
  ledger(): AuditLedger;
  /** Throws when the database cannot be read. */
  headlineRows(startInclusive: string, endExclusive: string): HeadlineDbRow[];
  /** Throws when the database cannot be read. */
  settings(): {
    timezone: string | null; baseCurrency?: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null>; spendingOn: boolean;
    spendingAccountIds: string[];
  };
  /** Wealthfolio's Spending page `headline.spent`, in dollars. */
  spendingSpent(startIso: string, endIso: string): Promise<number>;
}

export type AuditClient = Pick<WealthfolioClient, 'getAddonSecret' | 'getLatestValuations' | 'getAccounts' | 'getSpendingInsightSpent'>;

export function companionAuditReaders(client: AuditClient, dbPath: string): AuditReaders {
  return {
    secret: (key) => client.getAddonSecret(ADDON_ID, key),
    valuations: () => client.getLatestValuations(),
    accounts: () => client.getAccounts(),
    ledger: () => getNativeAuditLedger(dbPath),
    headlineRows: (start, endEx) => getNativeHeadlineRows(dbPath, start, endEx),
    settings: () => getNativeAuditSettings(dbPath),
    spendingSpent: (start, end) => client.getSpendingInsightSpent(start, end),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The companion's own month, the report cube's newest. */
const localMonth = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const nextMonthStart = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
};

/** A JSON secret on its own: `ok: false` when the read or the parse failed;
 *  a secret that is not there is `null`. */
async function readJson<T>(r: AuditReaders, key: string): Promise<{ ok: true; value: T | null } | { ok: false }> {
  try {
    const raw = await r.secret(key);
    if (!raw) return { ok: true, value: null };
    const value: unknown = JSON.parse(raw);
    // Every secret read here is a keyed object; anything else is unreadable,
    // not "empty" (an empty mapping would explain nothing and say nothing).
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as T };
  } catch {
    return { ok: false };
  }
}

type Mapping = { ok: true; value: Record<string, string> | null } | { ok: false };
/** The account mapping, read once per run and shared by the balance and Health checks. */
export const readMapping = (r: AuditReaders): Promise<Mapping> => readJson<Record<string, string>>(r, 'account_mapping');

/** The ledger, read once and shared by the balance and Health checks;
 *  undefined when the database could not be read. */
export function readAuditLedger(r: AuditReaders): AuditLedger | undefined {
  try {
    return r.ledger();
  } catch {
    return undefined;
  }
}

export async function gatherBalanceFacts(r: AuditReaders, ledger: AuditLedger | undefined, sharedMapping?: Mapping): Promise<BalanceFacts> {
  const facts: BalanceFacts = {};
  const failed: BalanceRead[] = [];
  const mapping = sharedMapping ?? await readMapping(r);
  if (mapping.ok) facts.mapping = mapping.value ?? {};
  else failed.push('mapping');
  const balances = await readJson<NonNullable<BalanceFacts['balances']>>(r, 'account_balances');
  if (balances.ok) facts.balances = balances.value ?? {};
  else failed.push('balances');
  const names = await readJson<Record<string, string>>(r, 'account_names');
  if (names.ok) facts.names = names.value ?? {};
  else failed.push('names');
  // The type comes from REST, so a database that is down costs only the
  // ledger part. An account of unknown type (no type given, or the whole list
  // unread) is left uncompared: its valuation is dropped, so a card's debt is
  // never compared against a cash-style valuation.
  const accountTypes: Record<string, string> = {};
  try {
    for (const a of await r.accounts()) {
      const type = typeof a.accountType === 'string' ? a.accountType.trim().toUpperCase() : '';
      if (type !== '') accountTypes[a.id] = type;
    }
  } catch {
    failed.push('accounts');
  }
  facts.accountTypes = accountTypes;
  try {
    const valuations: Record<string, number> = {};
    for (const v of await r.valuations()) {
      const dollars = typeof v.totalValue === 'number' ? v.totalValue : parseFloat(String(v.totalValue));
      // A valuation that is not a number costs only its own account.
      if (Number.isFinite(dollars) && accountTypes[v.accountId]) valuations[v.accountId] = Math.round(dollars * 100);
    }
    facts.valuations = valuations;
  } catch {
    failed.push('valuations');
  }
  if (ledger) facts.ledger = ledger;
  else failed.push('ledger');
  if (failed.length > 0) facts.failed = failed;
  return facts;
}

export async function gatherHeadlineFacts(
  r: AuditReaders, now: Date, sharedMapping?: Mapping,
  /** The sync's tripwire: a cube published before this moment is from an earlier run (this run's publish failed or was skipped), so its figure is not read. */
  cubeNotBefore?: Date,
): Promise<HeadlineFacts> {
  const month = localMonth(now);
  const facts: HeadlineFacts = { month };
  const failed: HeadlineRead[] = [];
  // The report covers the mapped accounts only (the cube drops any other).
  const mapping = sharedMapping ?? await readMapping(r);
  if (mapping.ok) facts.reportAccountIds = Object.values(mapping.value ?? {}).filter((id) => !!id);
  else failed.push('mapping');
  try {
    // The report's "Spent this month": the cube's newest month, which must be this one.
    const cube = parseReportCube(await r.secret(REPORT_CUBE_SECRET_KEY));
    const fromThisRun = !cubeNotBefore || (cube !== null && Date.parse(cube.asOf) >= cubeNotBefore.getTime());
    if (cube && fromThisRun && cube.months.at(-1) === month) facts.reportCents = Math.round(monthlySpendTotals(cube).at(-1) ?? 0);
    else failed.push('report');
  } catch {
    failed.push('report');
  }
  let timezone: string | null = null;
  let spendingOn = true;
  try {
    const settings = r.settings();
    timezone = settings.timezone;
    facts.baseCurrency = settings.baseCurrency ?? null;
    facts.excludedCategoryIds = settings.excludedCategoryIds;
    facts.categoryParents = settings.categoryParents;
    facts.spendingAccountIds = settings.spendingAccountIds;
    spendingOn = settings.spendingOn;
  } catch {
    failed.push('settings');
  }
  // Wealthfolio's month is placed by the zone the Spending page is asked in.
  facts.timezone = timezone;
  // A Spending page that is off answers a meaningless $0: not a figure to compare.
  if (!spendingOn) failed.push('spending-off');
  else try {
    const { start, end } = zonedMonthBounds(month, timezone);
    const spent = await r.spendingSpent(start, end);
    if (typeof spent !== 'number' || !Number.isFinite(spent)) throw new Error('no spent figure');
    facts.wealthfolioCents = Math.round(spent * 100);
  } catch {
    failed.push('wealthfolio');
  }
  try {
    facts.rows = r.headlineRows(`${month}-01`, nextMonthStart(month));
  } catch {
    failed.push('ledger');
  }
  if (failed.length > 0) facts.failed = failed;
  return facts;
}

export async function gatherHealthFacts(r: AuditReaders, ledger: AuditLedger | undefined, sharedMapping?: Mapping): Promise<HealthFacts> {
  const facts: HealthFacts = {};
  const failed: HealthRead[] = [];
  if (ledger) facts.ledger = ledger;
  else failed.push('ledger');
  const mapping = sharedMapping ?? await readMapping(r);
  if (mapping.ok) facts.mapping = mapping.value ?? {};
  else failed.push('mapping');
  // A row the payback setting is on is never offered as a transfer's other half (1.62).
  // Unread or unreadable: none known, and Link's own re-read refuses one.
  try {
    const loaded = await loadSyncOverrides((k) => r.secret(k));
    if (!loaded.unreadable) facts.overrides = loaded.overrides;
  } catch {
    // Nothing more to say: the Health list is unchanged.
  }
  if (failed.length > 0) facts.failed = failed;
  return facts;
}

/** All three checks over one ledger read. `reached` is false when not even
 *  the account mapping could be read: Wealthfolio is unreachable. */
export async function runAudit(r: AuditReaders, now: Date, cubeNotBefore?: Date): Promise<AuditResults & { reached: boolean }> {
  const ledger = readAuditLedger(r);
  const mapping = await readMapping(r);
  const balanceFacts = await gatherBalanceFacts(r, ledger, mapping);
  const headlineFacts = await gatherHeadlineFacts(r, now, mapping, cubeNotBefore);
  const healthFacts = await gatherHealthFacts(r, ledger, mapping);
  // Transactions already marked "not a transfer" (read-only; an unreadable
  // document or a failed read means none, as in the daily findings).
  const overrides = await loadSyncOverrides((k) => r.secret(k)).catch(() => null);
  const marked = new Set(
    overrides ? Object.keys(overrides.overrides.tx).filter((k) => hasTxOverride(overrides.overrides, k, 'notTransfer')) : [],
  );
  const held = heldFromLedger(
    ledger,
    balanceFacts.mapping ? { mapping: balanceFacts.mapping, balances: balanceFacts.balances ?? {}, names: balanceFacts.names ?? {} } : undefined,
    now,
    marked,
  );
  return {
    balances: explainBalances(balanceFacts),
    headline: explainHeadline(headlineFacts),
    health: healthIssues(healthFacts),
    ...(held ? { held } : {}),
    reached: !balanceFacts.failed?.includes('mapping'),
  };
}

export type AuditPublishClient = AuditClient & Pick<WealthfolioClient, 'setAddonSecret'>;

/**
 * Runs the checks and writes the snapshot (shared/audit-snapshot.ts). Writes
 * nothing when Wealthfolio could not be reached, so the previous snapshot
 * stays; rejects WITHOUT writing when the snapshot is over budget even fully
 * trimmed (the previous one stays); rejects when the write fails. The sync's
 * caller catches and logs either way — a publish never fails or changes a
 * sync.
 */
export async function publishAuditSnapshot(
  client: AuditPublishClient,
  dbPath: string,
  now: Date,
  readers: AuditReaders = companionAuditReaders(client, dbPath),
  /** The start of the sync run: only a cube published since then is compared (M-2). */
  cubeNotBefore?: Date,
): Promise<boolean> {
  const { reached, ...results } = await runAudit(readers, now, cubeNotBefore);
  if (!reached) return false;
  const snapshot = buildAuditSnapshot(results, now);
  // Over budget even fully trimmed: never write "null" over the previous one.
  if (!snapshot) throw new Error('audit snapshot over budget after trimming; keeping the previous one');
  await client.setAddonSecret(ADDON_ID, AUDIT_SNAPSHOT_SECRET_KEY, JSON.stringify(snapshot));
  return true;
}
