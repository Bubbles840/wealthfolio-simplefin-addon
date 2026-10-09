/**
 * companion/tools/audit-headline.mjs — "why is the report's '$X left' different
 * from Wealthfolio's?"
 *
 * Read-only, database only (no login), same delivery as the other audit tools:
 * pipe it into the container from a COMMIT-PINNED raw URL.
 *
 * The daily report's headline and Wealthfolio's budget card have disagreed by a
 * few tens of dollars for months. Reading both sides' source (2026-10-09) showed
 * Wealthfolio's "left" is NOT prorated — it is `max(0, plan − spent)`, the same
 * shape as the report — so the gap is in WHAT each side counts. This prints the
 * size of every known difference, so the one that matches the gap names the
 * cause instead of a theory:
 *
 *  1. Rows dated the 1st at midnight UTC. The sync writes date-only dates, which
 *     Wealthfolio stores as `YYYY-MM-01T00:00:00+00:00`. With an app timezone west
 *     of UTC, Wealthfolio's month starts hours later, so those rows land in LAST
 *     month there and in THIS month in the report. A fixed gap all month long.
 *  2. Rows dated after today. The report counts the whole month; Wealthfolio
 *     stops at today.
 *  3. The sync's bookkeeping rows (in-transit placeholders, balance
 *     adjustments). The report excludes them; Wealthfolio counts any of them that
 *     classify as spending. Moves as transfers settle.
 *  4. Categories excluded from spending in Wealthfolio's settings. Wealthfolio
 *     drops their spend and budget; the report reads neither setting.
 *  5. Rows filed under two spending categories: the report counts them twice.
 *  6. Refunds with no category: Wealthfolio nets them; the report ignores them.
 *
 * Usage, on the server:
 *   docker exec -i simplefin-sync node --input-type=module < audit-headline.mjs
 *   AUDIT_MONTH=2026-09 … to audit another month.
 *
 * Writes nothing.
 */
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const MONTH = process.env.AUDIT_MONTH || TODAY.slice(0, 7);
const START = `${MONTH}-01`;
const END = (() => {
  const [y, m] = MONTH.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
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
const all = (sql, ...params) => db.prepare(sql).all(...params);
const money = (n) => (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toFixed(2);

/** The report's own spending sign (sqlite-native.ts SPENDING_SIGN). */
const SIGN = `
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
    ELSE 0 END`;
const BOOKKEEPING = `(COALESCE(a.notes,'') LIKE 'Starting balance · %'
  OR COALESCE(a.notes,'') LIKE 'Balance adjustment · %'
  OR COALESCE(a.notes,'') LIKE '↔️ In-transit transfer · %')`;
const AMOUNT = 'ABS(CAST(a.amount AS REAL))';

const rows = (where, ...params) => all(
  `SELECT a.id, a.activity_date d, UPPER(a.activity_type) t, acc.name account,
          (${SIGN}) * ${AMOUNT} spend, substr(COALESCE(a.notes,''), 1, 60) note
   FROM activities a JOIN accounts acc ON a.account_id = acc.id
   WHERE ${where}`, ...params,
).filter((r) => Number(r.spend) !== 0);
const total = (list) => list.reduce((s, r) => s + Number(r.spend), 0);
const show = (list, limit = 12) => {
  for (const r of list.slice(0, limit)) {
    console.log(`   ${String(r.d).slice(0, 25).padEnd(26)} ${money(r.spend).padStart(10)}  ${String(r.t).padEnd(12)} ${r.account} · ${r.note}`);
  }
  if (list.length > limit) console.log(`   …and ${list.length - limit} more`);
};

console.log(`\n=== headline audit for ${MONTH} (today ${TODAY}) ===`);

const settings = all(
  `SELECT setting_key k, setting_value v FROM app_settings
   WHERE setting_key LIKE '%timezone%' OR setting_key LIKE 'spending.%'`,
);
console.log('\nWealthfolio settings that change what it counts:');
for (const s of settings) console.log(`   ${s.k} = ${String(s.v).slice(0, 120)}`);
if (settings.length === 0) console.log('   (none set)');
const tz = settings.find((s) => /timezone/i.test(s.k))?.v ?? '';

const findings = [];

// 1. midnight-UTC rows on the 1st
const firstAtMidnight = rows(
  `a.activity_date LIKE ? AND NOT ${BOOKKEEPING}`, `${START}T00:00:00%`,
);
findings.push(['Rows dated the 1st at 00:00 UTC (in last month for Wealthfolio when its timezone is west of UTC)', firstAtMidnight]);

// 2. rows dated after today
const future = MONTH === TODAY.slice(0, 7)
  ? rows(`substr(a.activity_date,1,10) > ? AND a.activity_date < ? AND NOT ${BOOKKEEPING}`, TODAY, END)
  : [];
findings.push(['Rows dated after today (the report counts them; Wealthfolio stops at today)', future]);

// 3. bookkeeping rows
const bookkeeping = rows(`a.activity_date >= ? AND a.activity_date < ? AND ${BOOKKEEPING}`, START, END);
findings.push(["The sync's bookkeeping rows (the report excludes them; Wealthfolio may count them)", bookkeeping]);

// 4. excluded categories
let excludedIds = [];
try {
  excludedIds = JSON.parse(settings.find((s) => s.k === 'spending.excluded_category_ids')?.v ?? '[]');
} catch { /* none */ }
const excluded = excludedIds.length === 0 ? [] : rows(
  `a.activity_date >= ? AND a.activity_date < ? AND NOT ${BOOKKEEPING}
   AND a.id IN (SELECT activity_id FROM activity_taxonomy_assignments
                WHERE category_id IN (${excludedIds.map(() => '?').join(',')}))`,
  START, END, ...excludedIds,
);
findings.push(['Spend in categories Wealthfolio excludes from spending (it drops these; the report does not)', excluded]);

// 5. double-filed rows
const doubleFiled = rows(
  `a.activity_date >= ? AND a.activity_date < ? AND NOT ${BOOKKEEPING}
   AND (SELECT COUNT(*) FROM activity_taxonomy_assignments ata
        JOIN taxonomy_categories tc ON ata.category_id = tc.id
        WHERE ata.activity_id = a.id AND tc.taxonomy_id = 'spending_categories') > 1`,
  START, END,
);
findings.push(['Rows filed under two spending categories (the report counts each twice)', doubleFiled]);

// 6. uncategorized refunds
const uncategorizedRefunds = rows(
  `a.activity_date >= ? AND a.activity_date < ? AND NOT ${BOOKKEEPING}
   AND (${SIGN}) < 0
   AND NOT EXISTS (SELECT 1 FROM activity_taxonomy_assignments ata WHERE ata.activity_id = a.id)`,
  START, END,
);
findings.push(['Refunds with no category (Wealthfolio nets them; the report ignores them)', uncategorizedRefunds]);

for (const [title, list] of findings) {
  console.log(`\n── ${title}`);
  if (list.length === 0) {
    console.log('   none');
    continue;
  }
  console.log(`   net spend ${money(total(list))} across ${list.length} row${list.length === 1 ? '' : 's'}`);
  show(list);
}

console.log('\n=== summary ===');
for (const [title, list] of findings) {
  if (list.length > 0) console.log(`   ${money(total(list)).padStart(10)}  ${title.split(' (')[0]}`);
}
console.log(`
Compare these against the gap between the report's "$X left this month" and
Wealthfolio's budget card. The one whose size matches is the cause.
${tz ? `Wealthfolio's timezone is ${tz}.` : 'No timezone is set in Wealthfolio, so #1 depends on its server default.'}
#1 only applies when that timezone is behind UTC (any US zone is).`);
