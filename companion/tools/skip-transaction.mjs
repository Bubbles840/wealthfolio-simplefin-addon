/**
 * companion/tools/skip-transaction.mjs — remove a transaction the bank feed
 * reported twice, for good.
 *
 *   DRY RUN (default):  … | docker exec -i -e TX=TRN-… simplefin-sync node --input-type=module
 *   APPLY:              … | docker exec -i -e TX=TRN-… -e APPLY=1 simplefin-sync node --input-type=module
 *   optional:           -e NOTE="PNC sent it twice"
 *                       -e ACCOUNT_NAME=Spend   (when the id is stored in two accounts)
 *
 * Deleting the extra row by hand does not stick: the next sync sees a bank
 * transaction id with no stored row and imports it again, for as long as the
 * bank keeps reporting it. This adds the id to the skip list the sync honours
 * from 1.58.0 (shared/skipped-transactions.ts), then deletes the stored row.
 *
 * The dry run shows the row and what the account's balance becomes against the
 * bank's, so the choice is checked before anything is written. APPLY refuses on
 * a companion older than 1.58.0, which would simply import the row again.
 */
import { DatabaseSync } from 'node:sqlite';

const DIST = process.env.APP_DIST || '/app/dist';
const { WealthfolioClient } = await import(`${DIST}/companion/src/wealthfolio.js`);
const { SIMPLEFIN_SYNC_VERSION } = await import(`${DIST}/shared/version.js`);
const APPLY = process.env.APPLY === '1';
const TX = (process.env.TX || '').trim();
const NOTE = process.env.NOTE || 'reported twice by the bank feed';
const DB_PATH = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
const ADDON_ID = 'simplefin-sync';
const SKIP_KEY = 'skipped_transactions';
const MIN_VERSION = [1, 58, 0];

if (!TX) {
  console.log('Set TX to the full SimpleFin transaction id, e.g. -e TX=TRN-596ed039-…');
  process.exit(1);
}

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
const money = (n) => (n < 0 ? '−' : '') + '$' + Math.abs(Number(n) || 0).toFixed(2);

const client = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) client.token = process.env.WEALTHFOLIO_API_KEY;
else {
  const { readFileSync } = await import('node:fs');
  const pw = process.env.WEALTHFOLIO_PASSWORD
    ?? (process.env.WEALTHFOLIO_PASSWORD_FILE ? readFileSync(process.env.WEALTHFOLIO_PASSWORD_FILE, 'utf8').trim() : undefined);
  await client.login(pw);
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
const sfinOf = Object.fromEntries(Object.entries(mapping).map(([sfin, wf]) => [wf, sfin]));
const rows = db.prepare(
  `SELECT a.id, a.account_id, acc.name acct, substr(a.activity_date,1,10) d,
          UPPER(COALESCE(a.activity_type_override, a.activity_type)) t,
          ABS(CAST(COALESCE(a.amount,'0') AS REAL)) amt, COALESCE(a.source_group_id,'') g, COALESCE(a.notes,'') notes
   FROM activities a JOIN accounts acc ON a.account_id = acc.id
   WHERE a.notes LIKE ? OR a.notes LIKE ?`,
).all(`% · ${TX}`, `% · ${TX} · pending`)
  .filter((r) => sfinOf[r.account_id])
  .filter((r) => !process.env.ACCOUNT_NAME || r.acct.toLowerCase().includes(process.env.ACCOUNT_NAME.toLowerCase()));

if (rows.length === 0) {
  console.log(`No stored row carries ${TX}${process.env.ACCOUNT_NAME ? ` in an account named like "${process.env.ACCOUNT_NAME}"` : ''}.`);
  process.exit(1);
}
if (rows.length > 1) {
  console.log(`${TX} is stored in ${rows.length} accounts. Pick one with -e ACCOUNT_NAME=…:`);
  for (const r of rows) console.log(`   ${r.acct}`);
  process.exit(1);
}
const row = rows[0];
const account = sfinOf[row.account_id];

// The account's cash the way Wealthfolio 3.8 books it (amount is final cash,
// sign by type), posted rows only, so it compares with the bank's posted balance.
const PLUS = new Set(['DEPOSIT', 'CREDIT', 'TRANSFER_IN', 'DIVIDEND', 'INTEREST', 'SELL']);
const MINUS = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX', 'BUY']);
const signed = (r) => (PLUS.has(r.t) ? r.amt : MINUS.has(r.t) ? -r.amt : 0);
const ledger = db.prepare(
  `SELECT UPPER(COALESCE(activity_type_override, activity_type)) t, ABS(CAST(COALESCE(amount,'0') AS REAL)) amt, COALESCE(notes,'') notes
   FROM activities WHERE account_id = ?`,
).all(row.account_id)
  .filter((r) => !r.notes.endsWith(' · pending'))
  .reduce((sum, r) => sum + signed(r), 0);
const bank = Number((await secret('account_balances'))?.[account]?.balance);

console.log(`\nRow carrying ${TX}:`);
console.log(`   ${row.d}  ${row.t.padEnd(12)} ${money(row.amt).padStart(10)}  ${row.acct}${row.g ? '  (linked)' : ''}`);
console.log(`   ${row.notes}`);
console.log(`\n${row.acct}:`);
console.log(`   Wealthfolio ledger now   ${money(ledger)}`);
console.log(`   after removing this row  ${money(ledger - signed(row))}`);
console.log(`   bank (last sync)         ${Number.isFinite(bank) ? money(bank) : 'unknown'}`);
if (row.g) {
  // Wealthfolio deletes BOTH halves of a valid linked transfer when either is
  // deleted (activities_service.rs, bulk_mutate_activities), so say which.
  const partners = db.prepare(
    `SELECT acc.name acct, substr(a.activity_date,1,10) d, UPPER(COALESCE(a.activity_type_override, a.activity_type)) t,
            ABS(CAST(COALESCE(a.amount,'0') AS REAL)) amt, COALESCE(a.notes,'') notes
     FROM activities a JOIN accounts acc ON a.account_id = acc.id WHERE a.source_group_id = ? AND a.id <> ?`,
  ).all(row.g, row.id);
  console.log('\n   This row is half of a linked transfer. Wealthfolio deletes both halves together, so this also removes:');
  for (const p of partners) console.log(`     ${p.d}  ${p.t.padEnd(12)} ${money(p.amt).padStart(10)}  ${p.acct}  ${p.notes}`);
  console.log('   If that bank still reports it, the next /sync imports it again under its own id and links it to the right partner.');
}

if (!APPLY) {
  console.log('\nDry run — nothing written. Add -e APPLY=1 to skip this transaction and delete the row.\n');
  process.exit(0);
}

const running = String(SIMPLEFIN_SYNC_VERSION).split('.').map(Number);
const firstDiff = MIN_VERSION.findIndex((n, i) => (running[i] ?? 0) !== n);
const tooOld = firstDiff !== -1 && (running[firstDiff] ?? 0) < MIN_VERSION[firstDiff];
if (tooOld) {
  console.log(`\nThis companion is ${SIMPLEFIN_SYNC_VERSION}; the skip list needs ${MIN_VERSION.join('.')}. Update first — an older sync would import the row again.\n`);
  process.exit(1);
}

const list = Array.isArray(await secret(SKIP_KEY)) ? await secret(SKIP_KEY) : [];
if (!list.some((e) => e?.account === account && e?.txId === TX)) {
  list.push({ account, txId: TX, note: NOTE, at: new Date().toISOString() });
  await client.setAddonSecret(ADDON_ID, SKIP_KEY, JSON.stringify(list));
}
console.log(`\n   ✓ ${TX} added to the skip list for ${row.acct}`);
const res = await client.saveMany({ deleteIds: [row.id] });
if (res.errors?.length) {
  console.log(`   ✗ delete failed: ${res.errors.map((e) => e.message ?? JSON.stringify(e)).join('; ')}`);
  process.exit(1);
}
console.log(`   ✓ deleted the stored row\n`);
