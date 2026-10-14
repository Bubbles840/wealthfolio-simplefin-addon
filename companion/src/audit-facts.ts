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
 *  - Wealthfolio's figures: `/valuations/latest` and `/spending/insight`;
 *  - the rows and two settings: the read-only database (sqlite-audit.ts).
 *
 * `/audit` re-runs these on every tap; the publish runs them after each sync.
 */
import { explainBalances, type BalanceFacts, type BalanceRead } from '../../shared/audit-balance.js';
import { explainHeadline, zonedMonthBounds, type HeadlineDbRow, type HeadlineFacts, type HeadlineRead } from '../../shared/audit-headline.js';
import { healthIssues, type HealthFacts, type HealthRead } from '../../shared/audit-health.js';
import type { AuditLedger } from '../../shared/audit-ledger.js';
import { AUDIT_SNAPSHOT_SECRET_KEY, buildAuditSnapshot, type AuditResults } from '../../shared/audit-snapshot.js';
import { monthlySpendTotals, parseReportCube, REPORT_CUBE_SECRET_KEY } from '../../shared/report-cube.js';
import { getNativeAuditLedger, getNativeAuditSettings, getNativeHeadlineRows } from './sqlite-audit.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** Everything the checks read, so a test can fake each in its real shape. */
export interface AuditReaders {
  /** One add-on secret; rejects when Wealthfolio cannot be reached. */
  secret(key: string): Promise<string | null>;
  valuations(): Promise<Array<{ accountId: string; totalValue: string | number }>>;
  /** Throws when the database cannot be read. */
  ledger(): AuditLedger;
  /** Throws when the database cannot be read. */
  headlineRows(startInclusive: string, endExclusive: string): HeadlineDbRow[];
  /** Throws when the database cannot be read. */
  settings(): { timezone: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null> };
  /** Wealthfolio's Spending page `headline.spent`, in dollars. */
  spendingSpent(startIso: string, endIso: string): Promise<number>;
}

export type AuditClient = Pick<WealthfolioClient, 'getAddonSecret' | 'getLatestValuations' | 'getSpendingInsightSpent'>;

export function companionAuditReaders(client: AuditClient, dbPath: string): AuditReaders {
  return {
    secret: (key) => client.getAddonSecret(ADDON_ID, key),
    valuations: () => client.getLatestValuations(),
    ledger: () => getNativeAuditLedger(dbPath),
    headlineRows: (start, endEx) => getNativeHeadlineRows(dbPath, start, endEx),
    settings: () => getNativeAuditSettings(dbPath),
    spendingSpent: (start, end) => client.getSpendingInsightSpent(start, end),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The companion's own day, as audit-headline.mjs's TODAY. */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

/** The ledger, read once and shared by the balance and Health checks;
 *  undefined when the database could not be read. */
export function readAuditLedger(r: AuditReaders): AuditLedger | undefined {
  try {
    return r.ledger();
  } catch {
    return undefined;
  }
}

export async function gatherBalanceFacts(r: AuditReaders, ledger: AuditLedger | undefined): Promise<BalanceFacts> {
  const facts: BalanceFacts = {};
  const failed: BalanceRead[] = [];
  const mapping = await readJson<Record<string, string>>(r, 'account_mapping');
  if (mapping.ok) facts.mapping = mapping.value ?? {};
  else failed.push('mapping');
  const balances = await readJson<NonNullable<BalanceFacts['balances']>>(r, 'account_balances');
  if (balances.ok) facts.balances = balances.value ?? {};
  else failed.push('balances');
  const names = await readJson<Record<string, string>>(r, 'account_names');
  if (names.ok) facts.names = names.value ?? {};
  else failed.push('names');
  try {
    // An account whose type the ledger does not give (no ledger, a blank type,
    // an account it does not list) is left uncompared: the shared check would
    // otherwise compare a card's debt against a cash-style valuation.
    const knownType = new Set((ledger?.accounts ?? []).filter((a) => a.type !== '').map((a) => a.id));
    const valuations: Record<string, number> = {};
    let unreadable = false;
    for (const v of await r.valuations()) {
      const dollars = typeof v.totalValue === 'number' ? v.totalValue : parseFloat(String(v.totalValue));
      if (!Number.isFinite(dollars)) unreadable = true;
      else if (knownType.has(v.accountId)) valuations[v.accountId] = Math.round(dollars * 100);
    }
    facts.valuations = valuations;
    if (unreadable) failed.push('valuations');
  } catch {
    failed.push('valuations');
  }
  if (ledger) facts.ledger = ledger;
  else failed.push('ledger');
  if (failed.length > 0) facts.failed = failed;
  return facts;
}

export async function gatherHeadlineFacts(r: AuditReaders, now: Date): Promise<HeadlineFacts> {
  const today = localDay(now);
  const month = today.slice(0, 7);
  const facts: HeadlineFacts = { month, today };
  const failed: HeadlineRead[] = [];
  try {
    // The report's "Spent this month": the cube's newest month, which must be this one.
    const cube = parseReportCube(await r.secret(REPORT_CUBE_SECRET_KEY));
    if (cube && cube.months.at(-1) === month) facts.reportCents = Math.round(monthlySpendTotals(cube).at(-1) ?? 0);
    else failed.push('report');
  } catch {
    failed.push('report');
  }
  let timezone: string | null = null;
  try {
    const settings = r.settings();
    timezone = settings.timezone;
    facts.excludedCategoryIds = settings.excludedCategoryIds;
    facts.categoryParents = settings.categoryParents;
  } catch {
    failed.push('settings');
  }
  try {
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

export async function gatherHealthFacts(r: AuditReaders, ledger: AuditLedger | undefined): Promise<HealthFacts> {
  const facts: HealthFacts = {};
  const failed: HealthRead[] = [];
  if (ledger) facts.ledger = ledger;
  else failed.push('ledger');
  const mapping = await readJson<Record<string, string>>(r, 'account_mapping');
  if (mapping.ok) facts.mapping = mapping.value ?? {};
  else failed.push('mapping');
  if (failed.length > 0) facts.failed = failed;
  return facts;
}

/** All three checks over one ledger read. `reached` is false when not even
 *  the account mapping could be read: Wealthfolio is unreachable. */
export async function runAudit(r: AuditReaders, now: Date): Promise<AuditResults & { reached: boolean }> {
  const ledger = readAuditLedger(r);
  const balanceFacts = await gatherBalanceFacts(r, ledger);
  const headlineFacts = await gatherHeadlineFacts(r, now);
  const healthFacts = await gatherHealthFacts(r, ledger);
  return {
    balances: explainBalances(balanceFacts),
    headline: explainHeadline(headlineFacts),
    health: healthIssues(healthFacts),
    reached: !balanceFacts.failed?.includes('mapping'),
  };
}

export type AuditPublishClient = AuditClient & Pick<WealthfolioClient, 'setAddonSecret'>;

/**
 * Runs the checks and writes the snapshot (shared/audit-snapshot.ts). Writes
 * nothing when Wealthfolio could not be reached, so the previous snapshot
 * stays; rejects when the write fails. The sync's caller catches and logs
 * either way — a publish never fails or changes a sync.
 */
export async function publishAuditSnapshot(
  client: AuditPublishClient,
  dbPath: string,
  now: Date,
  readers: AuditReaders = companionAuditReaders(client, dbPath),
): Promise<boolean> {
  const { reached, ...results } = await runAudit(readers, now);
  if (!reached) return false;
  await client.setAddonSecret(ADDON_ID, AUDIT_SNAPSHOT_SECRET_KEY, JSON.stringify(buildAuditSnapshot(results, now)));
  return true;
}
