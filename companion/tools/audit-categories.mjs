/**
 * companion/tools/audit-categories.mjs — "is my spending filed correctly?"
 *
 * Read-only, same delivery as audit.mjs (pipe it into the container). Two jobs:
 *
 *  1. Reconcile every account's balance from the LEDGER, which is the only way
 *     to check a credit card. Wealthfolio's `/valuations/latest` returns rows for
 *     cash accounts only (verified live: 6 accounts, 2 rows, both CASH), so the
 *     sync's drift measurement has nothing to compare a card against and reports
 *     it as unmeasured forever. Summing the signed cash effect of the account's
 *     activities reproduces the figure the account page shows, and can be
 *     compared against what SimpleFin last reported.
 *
 *     The sign table is transcribed from Wealthfolio 3.8's
 *     `type_directed_cash_effect`, including the one account-dependent
 *     exception: INTEREST is income on an investment account and a charge on a
 *     credit card. Since 3.8, `amount` is the final cash and `fee` is
 *     informational, so `fee` is deliberately absent from the arithmetic.
 *
 *  2. Print every categorised purchase grouped by category, so a human (or
 *     Claude) can read down the list and spot a merchant filed under the wrong
 *     heading. Deliberately a dump rather than a heuristic: the question "is
 *     this the right category?" is a judgement about intent, and the failure
 *     mode of a clever rule here is confidently hiding the one row that matters.
 *
 * Writes nothing.
 */
import { DatabaseSync } from 'node:sqlite';

const { WealthfolioClient } = await import('/app/dist/companion/src/wealthfolio.js');
const DB_PATH = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
const DAYS = Number(process.env.AUDIT_DAYS || 60);

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

// Wealthfolio 3.8 `type_directed_cash_effect`, plus the credit-card INTEREST
// exception from `resolve_cash_with_account_context`.
const CASH_EFFECT = `
  CASE
    WHEN UPPER(acc.account_type) = 'CREDIT_CARD' AND UPPER(a.activity_type) = 'INTEREST' THEN -1
    WHEN UPPER(a.activity_type) IN ('DEPOSIT','CREDIT','TRANSFER_IN','DIVIDEND','INTEREST','SELL') THEN 1
    WHEN UPPER(a.activity_type) IN ('WITHDRAWAL','TRANSFER_OUT','FEE','TAX','BUY') THEN -1
    ELSE 0
  END`;

const client = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) client.token = process.env.WEALTHFOLIO_API_KEY;
else await client.login(process.env.WEALTHFOLIO_PASSWORD);
let sfBalances = {};
try {
  const raw = await client.getAddonSecret('simplefin-sync', 'account_balances');
  sfBalances = raw ? JSON.parse(raw) : {};
} catch {
  /* the ledger half still works without it */
}
const byWfId = {};
try {
  const raw = await client.getAddonSecret('simplefin-sync', 'account_mapping');
  for (const [sfinId, wfId] of Object.entries(raw ? JSON.parse(raw) : {})) byWfId[wfId] = sfinId;
} catch {
  /* ditto */
}

console.log(`\n=== balance reconciliation from the ledger (every account, cards included) ===`);
console.log(`    account                          ledger     simplefin        diff`);
for (const r of db
  .prepare(
    `SELECT acc.id, acc.name, acc.account_type,
            ROUND(SUM((${CASH_EFFECT}) * ABS(CAST(a.amount AS REAL))), 2) ledger,
            COUNT(*) n
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     GROUP BY acc.id ORDER BY acc.account_type, acc.name`,
  )
  .all()) {
  const sfin = sfBalances[byWfId[r.id]]?.balance;
  const diff = sfin === null || sfin === undefined ? null : Number(r.ledger) - Number(sfin);
  const verdict = diff === null ? '' : Math.abs(diff) < 0.01 ? '  ✓ matches' : `  ✗ OFF BY ${money(diff)}`;
  console.log(
    `    ${String(r.name).slice(0, 30).padEnd(30)} ${money(r.ledger).padStart(11)} ${money(sfin).padStart(12)} ${money(diff).padStart(11)}${verdict}`,
  );
}

console.log(`\n=== categorised spending, last ${DAYS} days, grouped by category ===`);
const rows = db
  .prepare(
    `SELECT COALESCE(parent.name, tc.name) cat, tc.name subcat,
            substr(a.activity_date,1,10) d, acc.name acct, a.activity_type t,
            COALESCE(a.subtype,'') st,
            (${CASH_EFFECT}) * ABS(CAST(a.amount AS REAL)) signed,
            ABS(CAST(a.amount AS REAL)) amt, COALESCE(a.notes,'') notes
     FROM activities a
     JOIN accounts acc ON a.account_id = acc.id
     JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
     JOIN taxonomy_categories tc ON ata.category_id = tc.id
     LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
     WHERE tc.taxonomy_id = 'spending_categories'
       AND substr(a.activity_date,1,10) >= date('now', '-${DAYS} day')
     ORDER BY cat, d DESC`,
  )
  .all();

const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.cat)) groups.set(r.cat, []);
  groups.get(r.cat).push(r);
}
for (const [cat, list] of [...groups.entries()].sort(
  (a, b) => b[1].reduce((s, r) => s + Math.abs(r.amt), 0) - a[1].reduce((s, r) => s + Math.abs(r.amt), 0),
)) {
  const total = list.reduce((s, r) => s + Number(r.signed), 0);
  console.log(`\n  ── ${cat}  (${list.length} rows, net ${money(-total)})`);
  for (const r of list) {
    const desc = String(r.notes).split(' · ')[0].slice(0, 44) || '(no description)';
    const sub = r.subcat !== cat ? ` [${r.subcat}]` : '';
    const flag = r.st ? ` {${r.st}}` : '';
    console.log(`     ${r.d}  ${money(r.amt).padStart(10)}  ${desc.padEnd(45)} ${String(r.acct).slice(0, 18).padEnd(19)}${sub}${flag}`);
  }
}

console.log(`\n=== spending rows with NO category, last ${DAYS} days ===`);
const uncat = db
  .prepare(
    `SELECT substr(a.activity_date,1,10) d, acc.name acct, a.activity_type t,
            ABS(CAST(a.amount AS REAL)) amt, COALESCE(a.notes,'') notes
     FROM activities a
     JOIN accounts acc ON a.account_id = acc.id
     LEFT JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
     WHERE ata.activity_id IS NULL
       AND substr(a.activity_date,1,10) >= date('now', '-${DAYS} day')
       AND COALESCE(a.source_group_id,'') = ''
       AND COALESCE(a.notes,'') NOT LIKE 'Starting balance · %'
       AND ((UPPER(acc.account_type) = 'CASH' AND UPPER(a.activity_type) IN ('WITHDRAWAL','TRANSFER_OUT','FEE','TAX'))
         OR (UPPER(acc.account_type) = 'CREDIT_CARD' AND UPPER(a.activity_type) IN ('WITHDRAWAL','FEE','INTEREST')))
     ORDER BY amt DESC LIMIT 40`,
  )
  .all();
for (const r of uncat) {
  console.log(`     ${r.d}  ${money(r.amt).padStart(10)}  ${String(r.notes).split(' · ')[0].slice(0, 44).padEnd(45)} ${String(r.acct).slice(0, 18)}`);
}
if (!uncat.length) console.log('     none');

console.log(`\n=== every inflow and how Wealthfolio counts it, last ${DAYS} days ===`);
for (const r of db
  .prepare(
    `SELECT substr(a.activity_date,1,10) d, acc.name acct, acc.account_type at,
            a.activity_type t, COALESCE(a.subtype,'') st,
            ABS(CAST(a.amount AS REAL)) amt, COALESCE(a.notes,'') notes
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE (${CASH_EFFECT}) > 0
       AND substr(a.activity_date,1,10) >= date('now', '-${DAYS} day')
       AND COALESCE(a.notes,'') NOT LIKE 'Starting balance · %'
     ORDER BY amt DESC LIMIT 40`,
  )
  .all()) {
  const counts =
    r.t === 'TRANSFER_IN'
      ? 'internal transfer if linked, else INCOME'
      : r.t === 'DEPOSIT'
        ? 'INCOME'
        : r.t === 'CREDIT'
          ? ['REFUND', 'REBATE', 'REIMBURSEMENT'].includes(r.st.toUpperCase())
            ? 'reduces spending'
            : r.st.toUpperCase() === 'BONUS'
              ? 'INCOME'
              : r.at === 'CREDIT_CARD' ? 'reduces spending' : 'ignored'
          : r.t;
  console.log(`     ${r.d}  ${money(r.amt).padStart(11)}  ${String(r.notes).split(' · ')[0].slice(0, 40).padEnd(41)} ${String(r.t).padEnd(12)} → ${counts}`);
}
db.close();
console.log('');
