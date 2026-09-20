/**
 * companion/tools/audit-month.mjs — "why does the digest say I'm over?"
 *
 * Read-only, same delivery as the other audit tools (pipe it into the
 * container, from a COMMIT-PINNED raw URL — the CDN serves stale copies of
 * `main`). Answers the three questions a suspicious daily digest raises:
 *
 *  1. WHICH HALF IS STALE when the digest reports a version skew. The addon
 *     publishes its version only when its bundle LOADS in a browser, so the
 *     `addon_version` secret means "the newest build that has ever run", not
 *     "the build that is installed". The installed zip is on disk in the same
 *     data directory the companion already mounts, so its manifest settles it:
 *     an old manifest means the zip was never uploaded; a current manifest next
 *     to an old secret means a Wealthfolio tab is still running the bundle it
 *     loaded days ago and only needs a hard refresh.
 *
 *  2. WHAT THE MONTH'S FIGURES ARE MADE OF. Per budget category: the budget,
 *     the net spend exactly as the digest computes it (same sign table, same
 *     bookkeeping-row exclusions), and every row behind it — so an overage can
 *     be read down to the purchase that caused it rather than argued with.
 *
 *  3. WHAT IS *NOT* COUNTING THAT SHOULD, which is where a budget quietly goes
 *     wrong. A reimbursement only reduces spending when it is a CREDIT with a
 *     refund-family subtype filed under a SPENDING category; the same money
 *     booked as a DEPOSIT, or filed under an income category that happens to be
 *     called "Reimbursements", reduces nothing. Every inflow is listed with the
 *     taxonomy its category belongs to, which is the only way to tell those
 *     apart. Rows the sync is holding as in-flight transfers are listed too,
 *     because Wealthfolio's own spending page counts an unlinked cash
 *     TRANSFER_OUT as spending while this project's reports exclude it.
 *
 * Writes nothing.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const { WealthfolioClient } = await import('/app/dist/companion/src/wealthfolio.js');
const DB_PATH = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
const ADDON_ID = 'simplefin-sync';
const MONTH = process.env.AUDIT_MONTH || new Date().toISOString().slice(0, 7);
const START = `${MONTH}-01`;
const END = (() => {
  const [y, m] = MONTH.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
})();

function openReadOnly() {
  for (const uri of [`file:${DB_PATH}?mode=ro`, `file:${DB_PATH}?mode=ro&readonly_shm=1`, `file:${DB_PATH}?immutable=1`]) {
    try {
      const h = new DatabaseSync(uri);
      h.prepare('SELECT 1').get();
      return h;
    } catch {
      /* next */
    }
  }
  throw new Error(`could not open ${DB_PATH} read-only`);
}
const db = openReadOnly();
const money = (n) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? '—'
    : (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n)).toFixed(2);

const client = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) client.token = process.env.WEALTHFOLIO_API_KEY;
else await client.login(process.env.WEALTHFOLIO_PASSWORD);
const secretText = async (key) => {
  try {
    return await client.getAddonSecret(ADDON_ID, key);
  } catch {
    return null;
  }
};

// ── 1. versions ────────────────────────────────────────────────────────────
console.log(`\n=== versions: which half is stale? ===`);
let installed = null;
const addonsDir = join(dirname(DB_PATH), 'addons');
if (existsSync(addonsDir)) {
  for (const entry of readdirSync(addonsDir)) {
    const manifestPath = join(addonsDir, entry, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.id === ADDON_ID) installed = { version: manifest.version, dir: entry };
    } catch {
      /* an unreadable manifest is simply not this addon */
    }
  }
}
const running = await secretText('addon_version');
const companion = await secretText('companion_version');
console.log(`   companion (this container)        v${companion ?? '?'}`);
console.log(`   addon INSTALLED on disk           ${installed ? `v${installed.version}  (addons/${installed.dir})` : `not found under ${addonsDir}`}`);
console.log(`   addon that last RAN in a browser  v${running ?? '?'}`);
if (installed && companion && installed.version !== companion) {
  console.log(`   → the zip was never uploaded: install simplefin-sync-${companion}.zip in Wealthfolio's addon settings.`);
} else if (installed && running && installed.version !== running) {
  console.log(`   → the right zip IS installed; a Wealthfolio tab is still running the old bundle. Hard-refresh it (Cmd+Shift+R).`);
} else if (installed && running && companion && installed.version === companion && running === companion) {
  console.log(`   → all three agree.`);
}

// ── shared SQL: the digest's own sign table and exclusions ────────────────
const SPENDING_SIGN = `
  CASE UPPER(acc.account_type)
    WHEN 'CREDIT_CARD' THEN CASE
      WHEN UPPER(a.activity_type) IN ('WITHDRAWAL','FEE','INTEREST') THEN 1
      WHEN UPPER(a.activity_type) = 'CREDIT' THEN -1
      ELSE 0 END
    WHEN 'CASH' THEN CASE
      WHEN UPPER(a.activity_type) IN ('WITHDRAWAL','TRANSFER_OUT','FEE','TAX') THEN 1
      WHEN UPPER(a.activity_type) = 'CREDIT'
           AND UPPER(COALESCE(a.subtype,'')) IN ('REFUND','REBATE','REIMBURSEMENT') THEN -1
      ELSE 0 END
    ELSE 0
  END`;
const NOT_BOOKKEEPING = `
  COALESCE(a.notes,'') NOT LIKE 'Starting balance · %'
  AND COALESCE(a.notes,'') NOT LIKE 'Balance adjustment · %'
  AND COALESCE(a.notes,'') NOT LIKE '↔️ In-transit transfer · %'`;

// ── 2. the month, category by category ─────────────────────────────────────
console.log(`\n=== ${MONTH}: budget vs. net spend, with every row behind it ===`);
const budgets = new Map(
  db
    .prepare(
      `WITH ranked AS (
         SELECT category_id, CAST(amount AS REAL) amount,
                ROW_NUMBER() OVER (PARTITION BY category_id
                                   ORDER BY (period_key = ?) DESC, updated_at DESC) rn
         FROM budget_targets WHERE period_key = ? OR period_key = 'default')
       SELECT COALESCE(p.name, tc.name) cat, ROUND(SUM(r.amount),2) budget
       FROM ranked r JOIN taxonomy_categories tc ON r.category_id = tc.id
       LEFT JOIN taxonomy_categories p ON tc.parent_id = p.id
       WHERE r.rn = 1 GROUP BY COALESCE(p.name, tc.name)`,
    )
    .all(MONTH, MONTH)
    .map((r) => [r.cat, Number(r.budget)]),
);
const rows = db
  .prepare(
    `SELECT COALESCE(p.name, tc.name) cat, tc.name subcat,
            substr(a.activity_date,1,10) d, acc.name acct, a.activity_type t,
            COALESCE(a.subtype,'') st,
            (${SPENDING_SIGN}) * ABS(CAST(a.amount AS REAL)) signed,
            COALESCE(a.notes,'') notes
     FROM activities a
     JOIN accounts acc ON a.account_id = acc.id
     JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
     JOIN taxonomy_categories tc ON ata.category_id = tc.id
     LEFT JOIN taxonomy_categories p ON tc.parent_id = p.id
     WHERE tc.taxonomy_id = 'spending_categories'
       AND a.activity_date >= ? AND a.activity_date < ?
       AND (${SPENDING_SIGN}) <> 0
       AND ${NOT_BOOKKEEPING}
     ORDER BY cat, d`,
  )
  .all(START, END);
const byCat = new Map();
for (const r of rows) {
  if (!byCat.has(r.cat)) byCat.set(r.cat, []);
  byCat.get(r.cat).push(r);
}
let totalSpent = 0;
let totalBudget = 0;
for (const cat of [...new Set([...budgets.keys(), ...byCat.keys()])].sort()) {
  const list = byCat.get(cat) ?? [];
  const spent = list.reduce((s, r) => s + Number(r.signed), 0);
  const budget = budgets.get(cat);
  totalSpent += spent;
  if (budget !== undefined) totalBudget += budget;
  const verdict = budget === undefined ? 'no budget' : spent > budget ? `OVER by ${money(spent - budget)}` : `${money(budget - spent)} left`;
  console.log(`\n  ── ${cat}: spent ${money(spent)} of ${budget === undefined ? '—' : money(budget)}  (${verdict})`);
  for (const r of list) {
    const pending = r.notes.endsWith(' · pending') ? ' [pending]' : '';
    const flag = r.st ? ` {${r.st}}` : '';
    console.log(`     ${r.d}  ${money(r.signed).padStart(10)}  ${r.notes.split(' · ')[0].slice(0, 42).padEnd(43)} ${String(r.acct).slice(0, 16).padEnd(17)}${r.subcat !== cat ? `[${r.subcat}]` : ''}${flag}${pending}`);
  }
}
console.log(`\n  TOTAL spent ${money(totalSpent)} against ${money(totalBudget)} budgeted`);

// ── 3. what is not counting ───────────────────────────────────────────────
console.log(`\n=== ${MONTH}: every inflow, its category's taxonomy, and whether it offsets spending ===`);
for (const r of db
  .prepare(
    `SELECT substr(a.activity_date,1,10) d, acc.name acct, acc.account_type at, a.activity_type t,
            COALESCE(a.subtype,'') st, ABS(CAST(a.amount AS REAL)) amt, COALESCE(a.notes,'') notes,
            COALESCE(a.source_group_id,'') grp,
            (SELECT GROUP_CONCAT(tc.name || ' <' || tc.taxonomy_id || '>', ', ')
               FROM activity_taxonomy_assignments ata JOIN taxonomy_categories tc ON ata.category_id = tc.id
              WHERE ata.activity_id = a.id) cats
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE a.activity_date >= ? AND a.activity_date < ?
       AND UPPER(a.activity_type) IN ('DEPOSIT','CREDIT','TRANSFER_IN','INTEREST','DIVIDEND')
       AND COALESCE(a.notes,'') NOT LIKE 'Starting balance · %'
     ORDER BY a.activity_date`,
  )
  .all(START, END)) {
  const sub = r.st.toUpperCase();
  const offsets =
    r.t === 'CREDIT' && (r.at === 'CREDIT_CARD' || ['REFUND', 'REBATE', 'REIMBURSEMENT'].includes(sub));
  const inSpendingCat = (r.cats ?? '').includes('<spending_categories>');
  const effect =
    r.t === 'TRANSFER_IN'
      ? r.grp ? 'linked transfer — neutral' : r.at === 'CASH' ? 'UNLINKED — counts as INCOME upstream' : 'unlinked on a card — neutral'
      : offsets
        ? inSpendingCat ? 'REDUCES spending' : 'would reduce spending, but has NO spending category — reduces nothing'
        : r.t === 'CREDIT' ? 'neutral (bare credit)' : 'INCOME — does not reduce spending';
  console.log(`   ${r.d}  ${money(r.amt).padStart(10)}  ${r.notes.split(' · ')[0].replace('↔️ In-transit transfer', '⇄').slice(0, 36).padEnd(37)} ${String(r.t).padEnd(11)} ${(r.st || '-').padEnd(13)} ${(r.cats ?? 'uncategorised').slice(0, 40).padEnd(41)} → ${effect}`);
}

console.log(`\n=== transfers the sync is holding as in-flight (any date) ===`);
console.log(`    Wealthfolio's own spending page counts an unlinked cash TRANSFER_OUT as`);
console.log(`    spending until its other half arrives; this project's reports exclude it.\n`);
const held = db
  .prepare(
    `SELECT substr(a.activity_date,1,10) d, acc.name acct, acc.account_type at, a.activity_type t,
            ABS(CAST(a.amount AS REAL)) amt, COALESCE(a.notes,'') notes,
            CAST(julianday('now') - julianday(substr(a.activity_date,1,10)) AS INTEGER) age
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE COALESCE(a.notes,'') LIKE '↔️ In-transit transfer · %'
     ORDER BY a.activity_date`,
  )
  .all();
for (const r of held) {
  const upstream = r.at === 'CASH' && r.t === 'TRANSFER_OUT' ? 'shows as SPENDING upstream' : 'neutral upstream';
  console.log(`   ${r.d}  ${money(r.amt).padStart(10)}  ${String(r.t).padEnd(12)} ${String(r.acct).slice(0, 26).padEnd(27)} ${String(r.age).padStart(3)}d old  ${upstream}  ${r.notes.split(' · ')[1]?.slice(0, 30) ?? ''}`);
}
if (!held.length) console.log('   none');

console.log(`\n=== ${MONTH}: rows with no category (charges are the digest's "Uncategorized"; a CREDIT here is a refund reducing nothing) ===`);
const uncat = db
  .prepare(
    `SELECT substr(a.activity_date,1,10) d, acc.name acct, a.activity_type t,
            ABS(CAST(a.amount AS REAL)) amt, COALESCE(a.notes,'') notes
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     LEFT JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
     WHERE ata.activity_id IS NULL
       AND a.activity_date >= ? AND a.activity_date < ?
       AND COALESCE(a.source_group_id,'') = ''
       AND ${NOT_BOOKKEEPING}
       AND (${SPENDING_SIGN}) <> 0
     ORDER BY a.activity_date`,
  )
  .all(START, END);
for (const r of uncat) console.log(`   ${r.d}  ${money(r.amt).padStart(10)}  ${String(r.t).padEnd(11)} ${r.notes.split(' · ')[0].slice(0, 44).padEnd(45)} ${String(r.acct).slice(0, 20)}`);
if (!uncat.length) console.log('   none');

// ── balances, because a wrong baseline shows up here first ────────────────
console.log(`\n=== posted ledger balance vs. SimpleFin (accounts with a transfer in flight are timing, not error) ===`);
let sfBalances = {};
const byWfId = {};
try {
  sfBalances = JSON.parse((await secretText('account_balances')) ?? '{}');
  for (const [sfinId, wfId] of Object.entries(JSON.parse((await secretText('account_mapping')) ?? '{}'))) byWfId[wfId] = sfinId;
} catch {
  /* the ledger half still prints */
}
const inFlight = new Set(held.map((r) => r.acct));
for (const r of db
  .prepare(
    `SELECT acc.id, acc.name,
            ROUND(SUM(CASE
              WHEN UPPER(acc.account_type) = 'CREDIT_CARD' AND UPPER(a.activity_type) = 'INTEREST' THEN -1
              WHEN UPPER(a.activity_type) IN ('DEPOSIT','CREDIT','TRANSFER_IN','DIVIDEND','INTEREST','SELL') THEN 1
              WHEN UPPER(a.activity_type) IN ('WITHDRAWAL','TRANSFER_OUT','FEE','TAX','BUY') THEN -1
              ELSE 0 END * ABS(CAST(COALESCE(a.amount,'0') AS REAL))), 2) ledger
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE COALESCE(a.notes,'') NOT LIKE '% · pending'
     GROUP BY acc.id ORDER BY acc.name`,
  )
  .all()) {
  const sfin = sfBalances[byWfId[r.id]]?.balance;
  const diff = sfin === null || sfin === undefined ? null : Number(r.ledger) - Number(sfin);
  const verdict = diff === null ? '' : Math.abs(diff) < 0.01 ? '✓ matches' : inFlight.has(r.name) ? `off ${money(diff)} — transfer in flight, timing` : `✗ OFF BY ${money(diff)}`;
  console.log(`   ${String(r.name).slice(0, 34).padEnd(35)} ${money(r.ledger).padStart(11)} ${money(sfin).padStart(11)}  ${verdict}`);
}
db.close();
console.log('');
