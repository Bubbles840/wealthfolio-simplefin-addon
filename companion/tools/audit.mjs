/**
 * companion/tools/audit.mjs — a read-only "is the sync actually right?" report.
 *
 * Run it by piping it into the running container, which is where the
 * Wealthfolio credentials and the DB mount already live:
 *
 *   curl -fsSL https://raw.githubusercontent.com/Bubbles840/\
 *   wealthfolio-simplefin-addon/main/companion/tools/audit.mjs \
 *     | docker exec -i simplefin-sync node --input-type=module
 *
 * Why a piped script rather than a companion command: an audit is read-only,
 * occasional, and its output is meant for a human reading a terminal — none of
 * which justifies a Telegram command, a cron slot, or surface area inside the
 * daemon. Kept in the repo (not pasted ad hoc) so the queries can be fixed when
 * the schema moves, and so two runs a month apart are comparable.
 *
 * Deliberately NOT in the image: piping means a fix reaches a deployed
 * container without a release, which is the whole point when the thing being
 * diagnosed is the deployed container.
 *
 * It writes nothing. Every DB handle is opened read-only and every API call is
 * a GET, so it is safe to run against a live instance mid-sync.
 */
import { DatabaseSync } from 'node:sqlite';

const { WealthfolioClient } = await import('/app/dist/companion/src/wealthfolio.js');

// Deliberately NOT importing the companion's index.js: it starts the daemon on
// import. The DB path and the read-only URI ladder are copied from
// `queryNativeDb` instead — mode=ro attaches the write-ahead log, which an
// immutable read would skip (and Wealthfolio checkpoints rarely).
const DB_PATH = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
function openReadOnly() {
  const uris = [
    `file:${DB_PATH}?mode=ro`,
    `file:${DB_PATH}?mode=ro&readonly_shm=1`,
    `file:${DB_PATH}?immutable=1`,
  ];
  for (const uri of uris) {
    try {
      const handle = new DatabaseSync(uri);
      handle.prepare('SELECT 1').get();
      return handle;
    } catch {
      /* try the next form */
    }
  }
  throw new Error(`could not open ${DB_PATH} read-only`);
}

const ADDON_ID = 'simplefin-sync';
const money = (n) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? '—'
    : (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n)).toFixed(2);

// ── connect ────────────────────────────────────────────────────────────────
const client = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) {
  client.token = process.env.WEALTHFOLIO_API_KEY;
} else {
  const fromFile = process.env.WEALTHFOLIO_PASSWORD_FILE
    ? (await import('node:fs')).readFileSync(process.env.WEALTHFOLIO_PASSWORD_FILE, 'utf8').trim()
    : null;
  await client.login(fromFile || process.env.WEALTHFOLIO_PASSWORD);
}

const secret = async (key) => {
  try {
    const raw = await client.getAddonSecret(ADDON_ID, key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const mapping = (await secret('account_mapping')) ?? {};
const balances = (await secret('account_balances')) ?? {};
const names = (await secret('account_names')) ?? {};
const driftAlerts = (await secret('drift_alerts')) ?? {};
const linkFailures = (await secret('transfer_link_failures')) ?? {};
const lastSync = await client.getAddonSecret(ADDON_ID, 'last_sync_at').catch(() => null);

const wfAccounts = await client.getAccounts();
const valuations = await client.getLatestValuations().catch(() => []);
const valueByAccount = new Map(valuations.map((v) => [v.accountId, Number(v.totalValue)]));
const acctById = new Map(wfAccounts.map((a) => [a.id, a]));

// ── ledger ─────────────────────────────────────────────────────────────────
const db = openReadOnly();
const q = (sql, ...args) => {
  try {
    return db.prepare(sql).all(...args);
  } catch (e) {
    return [{ __error: String(e.message ?? e) }];
  }
};
const one = (sql, ...args) => q(sql, ...args)[0] ?? {};
const hasCol = (table, col) =>
  q(`PRAGMA table_info(${table})`).some((r) => String(r.name) === col);

const NEEDS_REVIEW = hasCol('activities', 'needs_review');
const since = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
const monthStart = new Date().toISOString().slice(0, 8) + '01';

const dbNames = new Map(
  q(`SELECT id, name, account_type FROM accounts`).map((r) => [r.id, r]),
);

console.log(`\n=== SimpleFin Sync audit — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ===`);
console.log(`last sync: ${lastSync ?? 'never recorded'}`);
console.log(`mapped accounts: ${Object.keys(mapping).length}   wealthfolio accounts: ${wfAccounts.length}\n`);

const flags = [];

for (const [sfinId, wfId] of Object.entries(mapping)) {
  const acct = dbNames.get(wfId);
  const type = acct?.account_type ?? acctById.get(wfId)?.accountType ?? '?';
  const label = acct?.name ?? names[sfinId] ?? wfId;
  const snap = balances[sfinId] ?? {};
  const wfValue = valueByAccount.get(wfId);

  const rows = one(
    `SELECT COUNT(*) n, MAX(substr(activity_date,1,10)) newest, MIN(substr(activity_date,1,10)) oldest
     FROM activities WHERE account_id = ?`,
    wfId,
  );
  const synced = one(
    `SELECT COUNT(*) n FROM activities WHERE account_id = ? AND COALESCE(notes,'') LIKE '% · %'`,
    wfId,
  );
  const byType = q(
    `SELECT activity_type t, COUNT(*) n, ROUND(SUM(ABS(CAST(amount AS REAL))),2) sum
     FROM activities WHERE account_id = ? AND substr(activity_date,1,10) >= ?
     GROUP BY activity_type ORDER BY n DESC`,
    wfId,
    since,
  );
  const thisMonth = one(
    `SELECT COUNT(*) n, ROUND(SUM(ABS(CAST(amount AS REAL))),2) sum
     FROM activities WHERE account_id = ? AND substr(activity_date,1,10) >= ?`,
    wfId,
    monthStart,
  );

  console.log(`── ${label}  [${type}]`);
  console.log(`   simplefin: ${money(snap.balance)}   wealthfolio: ${money(wfValue)}   drift: ${snap.drift === null || snap.drift === undefined ? 'in sync' : money(snap.drift)}${snap.measured === false ? ' (unmeasured)' : ''}`);
  console.log(`   rows: ${rows.n ?? 0} total, ${synced.n ?? 0} from the sync, ${rows.oldest ?? '—'} → ${rows.newest ?? '—'}`);
  console.log(`   this month: ${thisMonth.n ?? 0} rows, ${money(thisMonth.sum)} moved`);
  console.log(`   last 90d by type: ${byType.map((r) => `${r.t} ${r.n} (${money(r.sum)})`).join(', ') || 'none'}`);

  // Per-account integrity checks.
  const placeholders = q(
    `SELECT id, substr(activity_date,1,10) d, amount, activity_type t, notes
     FROM activities WHERE account_id = ? AND COALESCE(notes,'') LIKE '↔️ In-transit transfer · %'`,
    wfId,
  );
  const plugs = q(
    `SELECT id, substr(activity_date,1,10) d, amount, activity_type t
     FROM activities WHERE account_id = ? AND COALESCE(notes,'') LIKE 'Balance adjustment · %'`,
    wfId,
  );
  const feeSide = q(
    `SELECT id, substr(activity_date,1,10) d, activity_type t, amount, fee
     FROM activities WHERE account_id = ?
       AND CAST(COALESCE(amount,'0') AS REAL) = 0 AND CAST(COALESCE(fee,'0') AS REAL) > 0`,
    wfId,
  );
  const lonelyLegs = q(
    `SELECT id, substr(activity_date,1,10) d, activity_type t, amount, notes
     FROM activities WHERE account_id = ?
       AND activity_type IN ('TRANSFER_IN','TRANSFER_OUT')
       AND COALESCE(source_group_id,'') = ''
       AND COALESCE(notes,'') NOT LIKE '↔️ In-transit transfer · %'
       AND substr(activity_date,1,10) >= ?`,
    wfId,
    since,
  );
  const dupes = q(
    `SELECT notes, COUNT(*) n FROM activities
     WHERE account_id = ? AND COALESCE(notes,'') LIKE '% · %'
     GROUP BY notes HAVING COUNT(*) > 1`,
    wfId,
  );
  const review = NEEDS_REVIEW
    ? q(
        `SELECT id, substr(activity_date,1,10) d, activity_type t, amount, notes
         FROM activities WHERE account_id = ? AND needs_review = 1`,
        wfId,
      )
    : [];

  if (placeholders.length) console.log(`   ⚠ ${placeholders.length} in-transit placeholder(s) still open: ${placeholders.map((p) => `${p.d} ${money(p.amount)} ${p.t}`).join('; ')}`);
  if (plugs.length) console.log(`   • ${plugs.length} balance plug(s): ${plugs.map((p) => `${p.d} ${money(p.amount)}`).join('; ')}`);
  if (feeSide.length) { console.log(`   ✗ ${feeSide.length} legacy fee-side row(s) NOT rewritten: ${feeSide.map((r) => `${r.id} ${r.d} fee ${money(r.fee)}`).join('; ')}`); flags.push(`${label}: ${feeSide.length} legacy fee-side row(s) survived the v1.49 rewrite`); }
  if (lonelyLegs.length) { console.log(`   ⚠ ${lonelyLegs.length} unlinked transfer leg(s) in 90d: ${lonelyLegs.map((r) => `${r.d} ${r.t} ${money(r.amount)}`).join('; ')}`); flags.push(`${label}: ${lonelyLegs.length} unlinked transfer leg(s)`); }
  if (dupes.length) { console.log(`   ✗ ${dupes.length} duplicated row group(s)`); flags.push(`${label}: ${dupes.length} duplicate row group(s)`); }
  if (review.length) { console.log(`   ⚠ ${review.length} row(s) flagged Needs review: ${review.map((r) => `${r.d} ${r.t} ${money(r.amount)}`).join('; ')}`); flags.push(`${label}: ${review.length} row(s) flagged Needs review`); }
  if (snap.drift !== null && snap.drift !== undefined && Math.abs(Number(snap.drift)) >= 1) flags.push(`${label}: drift ${money(snap.drift)}`);
  if (driftAlerts[sfinId]) flags.push(`${label}: open drift episode since ${driftAlerts[sfinId].firstDetectedAt}`);
  console.log('');
}

// ── reimbursements and categorisation, across all accounts ─────────────────
console.log('── reimbursements and refunds (last 90 days)');
const refunds = q(
  `SELECT a.activity_type t, COALESCE(a.subtype,'(none)') st, acc.account_type at,
          COUNT(*) n, ROUND(SUM(ABS(CAST(a.amount AS REAL))),2) sum
   FROM activities a JOIN accounts acc ON a.account_id = acc.id
   WHERE substr(a.activity_date,1,10) >= ?
     AND (a.activity_type = 'CREDIT' OR UPPER(COALESCE(a.subtype,'')) IN ('REFUND','REBATE','REIMBURSEMENT','BONUS'))
   GROUP BY a.activity_type, a.subtype, acc.account_type ORDER BY n DESC`,
  since,
);
for (const r of refunds) {
  const counts = r.at === 'CASH'
    ? ['REFUND', 'REBATE', 'REIMBURSEMENT'].includes(String(r.st).toUpperCase())
      ? 'reduces spending'
      : String(r.st).toUpperCase() === 'BONUS' ? 'counts as income' : 'ignored (neither spending nor income)'
    : r.at === 'CREDIT_CARD' ? 'reduces spending' : 'ignored';
  console.log(`   ${r.at} ${r.t} subtype ${r.st}: ${r.n} row(s), ${money(r.sum)} — ${counts}`);
}
if (!refunds.length) console.log('   none');

console.log('\n── uncategorised spending (this month, spending accounts only)');
const uncat = q(
  `SELECT acc.name, COUNT(*) n, ROUND(SUM(ABS(CAST(a.amount AS REAL))),2) sum
   FROM activities a
   JOIN accounts acc ON a.account_id = acc.id
   LEFT JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
   WHERE substr(a.activity_date,1,10) >= ?
     AND ata.activity_id IS NULL
     AND COALESCE(a.source_group_id,'') = ''
     AND COALESCE(a.notes,'') NOT LIKE 'Starting balance · %'
     AND COALESCE(a.notes,'') NOT LIKE 'Balance adjustment · %'
     AND COALESCE(a.notes,'') NOT LIKE '↔️ In-transit transfer · %'
     AND ((UPPER(acc.account_type) = 'CASH' AND UPPER(a.activity_type) IN ('WITHDRAWAL','TRANSFER_OUT','FEE','TAX'))
       OR (UPPER(acc.account_type) = 'CREDIT_CARD' AND UPPER(a.activity_type) IN ('WITHDRAWAL','FEE','INTEREST')))
   GROUP BY acc.name ORDER BY sum DESC`,
  monthStart,
);
for (const r of uncat) console.log(`   ${r.name}: ${r.n} row(s), ${money(r.sum)}`);
if (!uncat.length) console.log('   none — everything this month is filed');

console.log('\n── transfer link failures');
const lf = Object.entries(linkFailures);
console.log(lf.length ? lf.map(([tx, e]) => `   ${tx}: ${e.count} failure(s) since ${e.firstFailedAt}`).join('\n') : '   none');

console.log('\n=== FLAGS ===');
console.log(flags.length ? flags.map((f) => `  ✗ ${f}`).join('\n') : '  none — nothing needs attention');
console.log('');
db.close();
