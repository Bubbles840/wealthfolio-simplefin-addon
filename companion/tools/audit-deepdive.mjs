/**
 * companion/tools/audit-deepdive.mjs — the follow-up questions audit.mjs raises.
 *
 * Read-only, same delivery as audit.mjs (pipe it into the container). Answers
 * four things the summary cannot: which June transfer rows are twins of which,
 * whether an unlinked leg carries a category (and so reaches the reports at
 * all), which inflows are large enough that their subtype decides income, and
 * what `/valuations/latest` returns per account type — the figure drift
 * measurement compares against, absent for accounts it never reports.
 */
import { DatabaseSync } from 'node:sqlite';
const { WealthfolioClient } = await import('/app/dist/companion/src/wealthfolio.js');
const P = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
const db = new DatabaseSync(`file:${P}?mode=ro`);

console.log('\n=== every transfer row, June 2026, both cash accounts ===');
for (const r of db.prepare(`
  SELECT acc.name, substr(a.activity_date,1,10) d, a.activity_type t, a.amount,
         COALESCE(a.source_group_id,'(none)') grp, COALESCE(a.notes,'') notes
  FROM activities a JOIN accounts acc ON a.account_id = acc.id
  WHERE a.activity_type IN ('TRANSFER_IN','TRANSFER_OUT')
    AND substr(a.activity_date,1,10) BETWEEN '2026-06-01' AND '2026-06-30'
  ORDER BY d, acc.name`).all()) {
  console.log(`  ${r.d}  ${String(r.name).padEnd(28)} ${String(r.t).padEnd(13)} ${String(r.amount).padStart(10)}  grp=${r.grp}  ${String(r.notes).slice(0, 46)}`);
}

console.log('\n=== are those June rows categorised (would they count as spending)? ===');
for (const r of db.prepare(`
  SELECT acc.name, substr(a.activity_date,1,10) d, a.amount, tc.name cat
  FROM activities a JOIN accounts acc ON a.account_id = acc.id
  LEFT JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
  LEFT JOIN taxonomy_categories tc ON ata.category_id = tc.id
  WHERE a.activity_type = 'TRANSFER_OUT' AND COALESCE(a.source_group_id,'') = ''
    AND substr(a.activity_date,1,10) >= '2026-06-01'
  ORDER BY d`).all()) {
  console.log(`  ${r.d}  ${String(r.name).padEnd(28)} ${String(r.amount).padStart(10)}  category=${r.cat ?? 'NONE (stays out of reports)'}`);
}

console.log('\n=== biggest deposits/credits into cash accounts, last 90 days ===');
for (const r of db.prepare(`
  SELECT substr(a.activity_date,1,10) d, acc.name, a.activity_type t,
         COALESCE(a.subtype,'(none)') st, a.amount, COALESCE(a.notes,'') notes
  FROM activities a JOIN accounts acc ON a.account_id = acc.id
  WHERE UPPER(acc.account_type) = 'CASH'
    AND a.activity_type IN ('DEPOSIT','CREDIT')
    AND substr(a.activity_date,1,10) >= date('now','-90 day')
  ORDER BY CAST(a.amount AS REAL) DESC LIMIT 15`).all()) {
  console.log(`  ${r.d}  ${String(r.amount).padStart(11)}  ${String(r.t).padEnd(8)} ${String(r.st).padEnd(14)} ${String(r.notes).slice(0, 52)}`);
}
db.close();

console.log('\n=== what /valuations/latest actually returns (why cards show no figure) ===');
const c = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) c.token = process.env.WEALTHFOLIO_API_KEY;
else await c.login(process.env.WEALTHFOLIO_PASSWORD);
const accts = new Map((await c.getAccounts()).map((a) => [a.id, a]));
const vals = await c.getLatestValuations();
console.log(`  accounts: ${accts.size}   valuation rows: ${vals.length}`);
for (const v of vals) console.log(`  ${String(accts.get(v.accountId)?.accountType ?? '?').padEnd(12)} ${v.totalValue}`);
const missing = [...accts.values()].filter((a) => !vals.some((v) => v.accountId === a.id));
console.log(`  NO valuation row for: ${missing.map((a) => a.accountType).join(', ') || 'none'}`);
