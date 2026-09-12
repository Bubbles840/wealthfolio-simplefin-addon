/**
 * companion/tools/audit-pairs.mjs — why a card balance disagrees, and which
 * inflows have an unlinked counterpart sitting in another account.
 *
 * Read-only, same delivery as the other audit tools.
 *
 * Two questions, both raised by audit-categories:
 *
 *  1. A card's ledger balance can differ from SimpleFin's for an innocent
 *     reason: SimpleFin reports the POSTED balance, while the sync also imports
 *     pending rows (it asks for them: `pending=1`). Splitting the ledger sum into
 *     posted and pending says whether a difference is timing or a real error. The
 *     sync marks a pending row by ending its note ' · pending'.
 *
 *  2. Changing a DEPOSIT to TRANSFER_IN does NOT stop it counting as income.
 *     Wealthfolio's classifier reads an UNLINKED cash TRANSFER_IN as Income
 *     exactly like a DEPOSIT; only a linked pair (a shared source_group_id)
 *     becomes a neutral internal transfer. So the fix for "this deposit is
 *     really my own money" is to find its counterpart outflow and link them —
 *     which first requires knowing the counterpart exists. This lists every
 *     unlinked inflow next to same-amount unlinked outflows in other accounts
 *     within a 7-day window.
 */
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
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
const money = (n) => (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toFixed(2);

const CASH_EFFECT = `
  CASE
    WHEN UPPER(acc.account_type) = 'CREDIT_CARD' AND UPPER(a.activity_type) = 'INTEREST' THEN -1
    WHEN UPPER(a.activity_type) IN ('DEPOSIT','CREDIT','TRANSFER_IN','DIVIDEND','INTEREST','SELL') THEN 1
    WHEN UPPER(a.activity_type) IN ('WITHDRAWAL','TRANSFER_OUT','FEE','TAX','BUY') THEN -1
    ELSE 0
  END`;

console.log('\n=== card ledger split into posted and pending ===');
console.log('    a pending total that equals the gap means the balances agree and the');
console.log('    difference is only SimpleFin reporting the posted balance.\n');
for (const r of db
  .prepare(
    `SELECT acc.name,
            ROUND(SUM(CASE WHEN COALESCE(a.notes,'') LIKE '% · pending' THEN 0
                           ELSE (${CASH_EFFECT}) * ABS(CAST(a.amount AS REAL)) END), 2) posted,
            ROUND(SUM(CASE WHEN COALESCE(a.notes,'') LIKE '% · pending'
                           THEN (${CASH_EFFECT}) * ABS(CAST(a.amount AS REAL)) ELSE 0 END), 2) pending,
            SUM(CASE WHEN COALESCE(a.notes,'') LIKE '% · pending' THEN 1 ELSE 0 END) n_pending,
            COUNT(*) n
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
     GROUP BY acc.id ORDER BY acc.name`,
  )
  .all()) {
  console.log(`    ${String(r.name).slice(0, 32).padEnd(33)} posted ${money(r.posted).padStart(11)}   pending ${money(r.pending).padStart(10)} (${r.n_pending} of ${r.n} rows)`);
}

console.log('\n=== each card\'s earliest rows (is there a starting balance at all?) ===');
for (const r of db
  .prepare(
    `SELECT acc.name, substr(a.activity_date,1,10) d, a.activity_type t,
            a.amount, COALESCE(a.notes,'') notes
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
       AND substr(a.activity_date,1,10) <= (
         SELECT MIN(substr(a2.activity_date,1,10)) FROM activities a2 WHERE a2.account_id = a.account_id
       )
     ORDER BY acc.name, d`,
  )
  .all()) {
  console.log(`    ${String(r.name).slice(0, 30).padEnd(31)} ${r.d}  ${String(r.t).padEnd(13)} ${money(r.amount).padStart(11)}  ${String(r.notes).slice(0, 40)}`);
}

console.log('\n=== unlinked inflows with a matching unlinked outflow elsewhere (7-day window) ===');
console.log('    these are the pairs that could be linked, which is what makes an inflow');
console.log('    stop counting as income.\n');
const inflows = db
  .prepare(
    `SELECT a.id, acc.name acct, substr(a.activity_date,1,10) d, a.activity_type t,
            ROUND(ABS(CAST(a.amount AS REAL)), 2) amt, COALESCE(a.notes,'') notes
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE (${CASH_EFFECT}) > 0
       AND COALESCE(a.source_group_id,'') = ''
       AND a.activity_type IN ('DEPOSIT','TRANSFER_IN')
       AND substr(a.activity_date,1,10) >= date('now','-120 day')
       AND COALESCE(a.notes,'') NOT LIKE 'Starting balance · %'
     ORDER BY amt DESC`,
  )
  .all();
const outflows = db
  .prepare(
    `SELECT a.id, acc.name acct, substr(a.activity_date,1,10) d, a.activity_type t,
            ROUND(ABS(CAST(a.amount AS REAL)), 2) amt, COALESCE(a.notes,'') notes, a.account_id
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE (${CASH_EFFECT}) < 0
       AND COALESCE(a.source_group_id,'') = ''
       AND substr(a.activity_date,1,10) >= date('now','-120 day')
       AND COALESCE(a.notes,'') NOT LIKE 'Starting balance · %'`,
  )
  .all();
const days = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86400000);
let found = 0;
for (const i of inflows) {
  const matches = outflows.filter((o) => o.amt === i.amt && o.acct !== i.acct && days(o.d, i.d) <= 7);
  if (!matches.length) continue;
  found++;
  console.log(`    IN   ${i.d}  ${money(i.amt).padStart(11)}  ${String(i.acct).slice(0, 22).padEnd(23)} ${i.t.padEnd(12)} ${String(i.notes).split(' · ')[0].slice(0, 34)}`);
  for (const m of matches) {
    console.log(`      ↳ OUT ${m.d}  ${money(m.amt).padStart(11)}  ${String(m.acct).slice(0, 22).padEnd(23)} ${m.t.padEnd(12)} ${String(m.notes).split(' · ')[0].slice(0, 34)}`);
  }
  console.log(`         inflow id=${i.id}`);
  for (const m of matches) console.log(`         outflow id=${m.id}`);
}
if (!found) console.log('    none — every inflow with a plausible counterpart is already linked');
db.close();
console.log('');
