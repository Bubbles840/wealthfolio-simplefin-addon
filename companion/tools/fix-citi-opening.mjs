/**
 * companion/tools/fix-citi-opening.mjs — one-off: correct the Citi opening
 * balance after its missing June 26 payment was added (2026-09-23).
 *
 *   DRY RUN (default):  … | docker exec -i simplefin-sync node --input-type=module
 *   APPLY:              … | docker exec -i -e APPLY=1 simplefin-sync node --input-type=module
 *
 * The Citi feed never delivered a $700 payment that left Spend on 2026-06-26.
 * The card's opening balance, computed later as "bank minus ledger", absorbed
 * it: a card in daily use appeared to OPEN $235.40 in credit, when it opened
 * $464.60 owed. Once the missing payment is on the ledger the opening balance
 * has to say what was really owed, or the card reads $700 too low.
 *
 * Wealthfolio 3.8 accepts no neutral money-out type on a card (TRANSFER_OUT is
 * refused), so the opening debt is a WITHDRAWAL filed under an "Opening
 * balances" spending category that is excluded from spending. Each step checks
 * its own state first, so re-running is safe.
 */
import { DatabaseSync } from 'node:sqlite';
const { WealthfolioClient } = await import('/app/dist/companion/src/wealthfolio.js');
const APPLY = process.env.APPLY === '1';
const P = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
const TAX = 'spending_categories';
const CAT = 'Opening balances';
const open = () => {
  for (const q of ['mode=ro', 'mode=ro&readonly_shm=1', 'immutable=1']) {
    try { const d = new DatabaseSync(`file:${P}?${q}`); d.prepare('SELECT 1').get(); return d; } catch {}
  }
  throw new Error('could not open ' + P);
};
const db = open();
const T = `COALESCE(a.activity_type_override, a.activity_type)`;
const opening = db.prepare(`SELECT a.id, a.account_id, substr(a.activity_date,1,10) d, a.notes, a.currency, ${T} t, CAST(a.amount AS REAL) amt
  FROM activities a JOIN accounts acc ON acc.id=a.account_id
  WHERE acc.name LIKE 'Citi%' AND a.notes LIKE 'Starting balance · %'`).all();
const cat = db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id=? AND name=?`).get(TAX, CAT);
let excluded = [];
try { excluded = JSON.parse(db.prepare(`SELECT setting_value v FROM app_settings WHERE setting_key='spending.excluded_category_ids'`).get()?.v ?? '[]'); } catch {}
const assigned = opening[0] ? db.prepare(`SELECT tc.name FROM activity_taxonomy_assignments ata JOIN taxonomy_categories tc ON tc.id=ata.category_id
  WHERE ata.activity_id=? AND tc.taxonomy_id=?`).get(opening[0].id, TAX)?.name : undefined;
db.close();

console.log(APPLY ? 'APPLYING' : 'DRY RUN — nothing is written; re-run with -e APPLY=1');
console.log(`Citi opening balance rows: ${opening.length}${opening[0] ? ` (${opening[0].t} $${opening[0].amt.toFixed(2)}, category: ${assigned ?? 'none'})` : ''}`);
console.log(`"${CAT}" category: ${cat ? 'exists' : 'missing'}; excluded from spending: ${cat && excluded.includes(cat.id) ? 'yes' : 'no'}`);
if (opening.length !== 1) { console.log('Nothing done: expected exactly one Citi opening balance row.'); process.exit(0); }
const [o] = opening;
const rowDone = o.t === 'WITHDRAWAL' && Math.abs(o.amt - 464.6) < 0.01;
if (!rowDone && !(o.t === 'TRANSFER_IN' && Math.abs(o.amt - 235.4) < 0.01)) {
  console.log('Nothing done: the opening balance is neither the old +$235.40 nor the corrected -$464.60.'); process.exit(0);
}
const plan = [];
if (!cat) plan.push(`create spending category "${CAT}"`);
if (!cat || !excluded.includes(cat.id)) plan.push(`exclude "${CAT}" from spending (Wealthfolio settings)`);
if (!rowDone) plan.push(`opening balance ${o.d}: TRANSFER_IN +$235.40 → WITHDRAWAL $464.60 owed (Citi balance back to the bank's)`);
if (assigned !== CAT) plan.push(`file the opening balance under "${CAT}"`);
if (!plan.length) { console.log('Already done.'); process.exit(0); }
console.log('Plan:'); plan.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
if (!APPLY) process.exit(0);

const client = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) client.token = process.env.WEALTHFOLIO_API_KEY;
else await client.login(process.env.WEALTHFOLIO_PASSWORD);
const api = async (method, path, body) => {
  const res = await fetch(`${client.baseUrl}/api/v1${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...client.authHeaders() }, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.status === 204 ? null : res.json().catch(() => null);
};
let catId = cat?.id;
if (!catId) {
  const created = await api('POST', '/taxonomies/categories', {
    taxonomyId: TAX, parentId: null, name: CAT, key: 'opening_balances', color: '#9ca3af',
    description: 'Balances an account already had when syncing began. Not spending.', sortOrder: 999,
  });
  catId = created?.id;
  if (!catId) throw new Error('category create returned no id');
  console.log(`  ✓ created "${CAT}"`);
}
if (!excluded.includes(catId)) {
  await api('PUT', '/spending/settings', { excludedCategoryIds: [...excluded, catId] });
  console.log(`  ✓ "${CAT}" excluded from spending`);
}
if (!rowDone) {
  const res = await client.saveMany({ updates: [{
    id: o.id, accountId: o.account_id, activityType: 'WITHDRAWAL', activityDate: o.d, amount: 464.6, currency: o.currency, comment: o.notes,
  }] });
  if ((res.errors ?? []).length) throw new Error('opening balance: ' + res.errors.map((e) => e.message).join('; '));
  console.log('  ✓ opening balance is now $464.60 owed');
}
if (assigned !== CAT) {
  await client.assignActivityCategory(o.id, TAX, catId);
  console.log(`  ✓ filed under "${CAT}"`);
}
