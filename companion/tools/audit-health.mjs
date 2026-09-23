/**
 * companion/tools/audit-health.mjs — why Wealthfolio's Data Health page and
 * Spending page disagree with the addon.
 *
 * Read-only. Pipe it into the container from a COMMIT-PINNED raw URL.
 *
 * Wealthfolio has its own classifier and its own health checks, and they see
 * rows this project's reports deliberately exclude. This prints the ledger the
 * way WEALTHFOLIO reads it, so a warning on its Health page or a bar on its
 * Spending page can be traced to the exact rows behind it:
 *
 *  1. Transfer legs Wealthfolio considers incomplete: no group, or a group
 *     whose other leg is not a transfer (a group only neutralises TRANSFER_IN
 *     and TRANSFER_OUT legs). With each leg's asset, since a leg carrying the
 *     phantom `$CASH` security books no cash when retyped to a transfer.
 *  2. Starting balances dated AFTER the account's earliest row, which is what
 *     makes an account's early history go negative.
 *  3. Rows still pointing at the phantom `$CASH` security, which is what keeps
 *     the "Sync issues for $CASH" warning alive (no provider can price it).
 *  4. Month by month, spending as Wealthfolio classifies it — categorised vs
 *     uncategorised ("Other"), with the largest uncategorised rows.
 *  5. Each cash account's ledger balance against the bank and the drift the
 *     sync last measured.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const { WealthfolioClient } = await import('/app/dist/companion/src/wealthfolio.js');
const DB_PATH = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
const ADDON_ID = 'simplefin-sync';

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
const desc = (notes) => String(notes ?? '').replace('↔️ In-transit transfer · ', '⇄ ').split(' · ')[0].slice(0, 40);

const client = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) client.token = process.env.WEALTHFOLIO_API_KEY;
else await client.login(process.env.WEALTHFOLIO_PASSWORD);
const secret = async (key) => {
  try {
    const raw = await client.getAddonSecret(ADDON_ID, key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const assets = new Map(
  db.prepare(`SELECT id, COALESCE(display_code, instrument_symbol, name, id) code FROM assets`).all().map((a) => [a.id, a.code]),
);

// ── 0. which addon code is actually installed ──────────────────────────────
// The Sync page footer prints the version compiled INTO addon.js; the manifest
// is just a label. A zip packed without rebuilding carries an old bundle under a
// new manifest, so read both.
console.log('\n=== 0. installed addon ===');
try {
  const addonsDir = join(dirname(DB_PATH), 'addons');
  for (const entry of readdirSync(addonsDir)) {
    const dir = join(addonsDir, entry);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    } catch {
      continue;
    }
    if (manifest.id !== ADDON_ID) continue;
    let compiled = 'unreadable';
    try {
      const js = readFileSync(join(dir, manifest.main || 'dist/addon.js'), 'utf8');
      // The footer renders `"addon v", <ident>` and the constant is declared as
      // `<ident> = "x.y.z"`. Resolved through the identifier, because a bare
      // version-like search also finds bundled libraries' own versions.
      const ident = js.match(/"addon v",\s*([A-Za-z_$][\w$]*)/)?.[1];
      const literal = js.match(/"addon v",\s*"([0-9]+\.[0-9]+\.[0-9]+)"/)?.[1];
      const esc = ident?.replace(/\$/g, '\\$');
      const declared = esc ? js.match(new RegExp(`\\b${esc}\\s*=\\s*"([0-9]+\\.[0-9]+\\.[0-9]+)"`))?.[1] : undefined;
      compiled = literal ?? declared ?? 'not found';
    } catch {
      /* stays unreadable */
    }
    console.log(`   manifest ${manifest.version} · compiled into addon.js: ${compiled}  (${entry})`);
  }
} catch (e) {
  console.log(`   could not read the addons folder: ${e.message}`);
}

// ── 1. transfers Wealthfolio calls incomplete ──────────────────────────────
// Mirrors `invalid_transfer_groups_from_activities` (health/service.rs) and
// `TransferPairResolution` (activities/transfer_pairs.rs), Wealthfolio 3.8:
//  - only TRANSFER_IN/TRANSFER_OUT legs (effective type) take part in a group;
//  - a group is a valid pair only with exactly one IN and one OUT, in two
//    different accounts, neither carrying a non-cash asset;
//  - every posted leg of an invalid group, and every posted UNGROUPED leg, is
//    reported — unless the leg's metadata says `flow.is_external: true`.
console.log('\n=== 1. transfer legs Wealthfolio reports as incomplete ===');
const isTransfer = (t) => t === 'TRANSFER_IN' || t === 'TRANSFER_OUT';
const isExternal = (meta) => {
  try {
    return JSON.parse(meta || 'null')?.flow?.is_external === true;
  } catch {
    return false;
  }
};
const allActs = db
  .prepare(
    `SELECT a.id, a.account_id, substr(a.activity_date,1,10) d, acc.name acct, UPPER(acc.account_type) at,
            UPPER(COALESCE(a.activity_type_override, a.activity_type)) t, UPPER(COALESCE(a.subtype,'')) st,
            UPPER(COALESCE(a.status,'POSTED')) status, ABS(CAST(COALESCE(a.amount,'0') AS REAL)) amt,
            COALESCE(a.source_group_id,'') g, COALESCE(a.asset_id,'') asset, COALESCE(a.notes,'') notes,
            COALESCE(a.metadata,'') meta
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     ORDER BY a.activity_date`,
  )
  .all();
const nonCashAsset = (a) => a.asset && !a.asset.toUpperCase().startsWith('$CASH');
const groups = new Map();
for (const a of allActs) {
  if (!isTransfer(a.t) || !a.g.trim()) continue;
  if (!groups.has(a.g)) groups.set(a.g, []);
  groups.get(a.g).push(a);
}
const groupProblem = (legs) => {
  if (legs.length !== 2) return `${legs.length} transfer leg(s) in its group`;
  const ins = legs.filter((l) => l.t === 'TRANSFER_IN');
  if (ins.length !== 1) return `group is ${legs.map((l) => l.t).join('+')}`;
  if (legs[0].account_id === legs[1].account_id) return 'both legs in one account';
  if (legs.some(nonCashAsset)) return 'a leg carries a security';
  return null;
};
// What else shares the group (a CREDIT partner does not count as a leg).
const groupMates = new Map();
for (const a of allActs) {
  if (!a.g) continue;
  if (!groupMates.has(a.g)) groupMates.set(a.g, []);
  groupMates.get(a.g).push(a);
}
let incomplete = 0;
for (const a of allActs) {
  if (!isTransfer(a.t) || a.status !== 'POSTED') continue;
  let why = null;
  if (!a.g.trim()) why = 'not linked';
  else {
    const problem = groupProblem(groups.get(a.g));
    if (problem) {
      const others = groupMates.get(a.g).filter((m) => m.id !== a.id && !isTransfer(m.t));
      why = problem + (others.length ? ` (grouped with a ${others.map((o) => `${o.t} in ${o.acct}`).join(', ')})` : '');
    }
  }
  if (!why) continue;
  const external = isExternal(a.meta);
  if (external) continue;
  incomplete++;
  const assetNote = a.asset ? ` asset=${assets.get(a.asset) ?? a.asset}` : '';
  console.log(`   ${a.d}  ${a.t.padEnd(12)} ${money(a.amt).padStart(10)}  ${String(a.acct).slice(0, 22).padEnd(23)} ${desc(a.notes).padEnd(34)} ${why}${assetNote}`);
}
console.log(`   → ${incomplete} leg(s)`);

// ── 2. baselines dated after the account's earliest row ────────────────────
console.log('\n=== 2. starting balances dated after the account\'s earliest transaction ===');
let late = 0;
for (const r of db
  .prepare(
    `SELECT acc.name acct, a.id, substr(a.activity_date,1,10) d, UPPER(a.activity_type) t,
            ABS(CAST(a.amount AS REAL)) amt,
            (SELECT MIN(substr(b.activity_date,1,10)) FROM activities b
              WHERE b.account_id = a.account_id AND COALESCE(b.notes,'') NOT LIKE 'Starting balance · %') earliest
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE COALESCE(a.notes,'') LIKE 'Starting balance · %'`,
  )
  .all()) {
  if (r.earliest && r.d >= r.earliest) {
    late++;
    console.log(`   ${String(r.acct).slice(0, 30).padEnd(31)} baseline ${r.d} ${r.t} ${money(r.amt)} — earliest row ${r.earliest}  id=${r.id}`);
  }
}
if (!late) console.log('   none');

// ── 3. the phantom $CASH security ──────────────────────────────────────────
console.log('\n=== 3. rows pointing at a "$CASH" security (no provider can price it) ===');
// By code, plus the one id the July bulk-import bug is known to have minted.
const phantom = [...assets.entries()]
  .filter(([id, code]) => String(code).toUpperCase() === '$CASH' || id === '9231cb80-4223-4c04-98e3-dd3b1af60311')
  .map(([id]) => id);
console.log(`   $CASH assets: ${phantom.length ? phantom.join(', ') : 'none'}`);
for (const id of phantom) {
  for (const r of db
    .prepare(
      `SELECT a.id, substr(a.activity_date,1,10) d, acc.name acct, UPPER(a.activity_type) t,
              ABS(CAST(a.amount AS REAL)) amt, COALESCE(a.source_group_id,'') g, COALESCE(a.notes,'') notes
       FROM activities a JOIN accounts acc ON a.account_id = acc.id WHERE a.asset_id = ? ORDER BY a.activity_date`,
    )
    .all(id)) {
    console.log(`   ${r.d}  ${r.t.padEnd(12)} ${money(r.amt).padStart(10)}  ${String(r.acct).slice(0, 24).padEnd(25)} grp=${r.g ? 'yes' : 'no '} ${desc(r.notes)}  id=${r.id}`);
  }
}

// ── 4. spending by month, Wealthfolio's way ────────────────────────────────
// Mirrors `classify_activity_for_aggregation` (crates/spending): the account set
// is `spending.account_ids`; a grouped transfer is neutral only when BOTH legs
// are in that set, and otherwise a CASH TRANSFER_OUT is "Saving"; an UNGROUPED
// cash TRANSFER_OUT is an Expense, an ungrouped cash TRANSFER_IN is Income.
console.log('\n=== 4. spending by month as WEALTHFOLIO classifies it ===');
const setting = (key) => {
  try {
    return JSON.parse(db.prepare(`SELECT setting_value v FROM app_settings WHERE setting_key = ?`).get(key)?.v ?? 'null');
  } catch {
    return null;
  }
};
const spendIds = new Set(setting('spending.account_ids') ?? []);
const excluded = new Set(setting('spending.excluded_category_ids') ?? []);
const spendActs = allActs.filter((a) => spendIds.has(a.account_id) && a.status === 'POSTED');
console.log(`   spending accounts: ${[...new Set(spendActs.map((a) => a.acct))].join(', ') || 'none configured'}`);
const legCount = new Map();
for (const a of spendActs) if (isTransfer(a.t) && a.g) legCount.set(a.g, (legCount.get(a.g) ?? 0) + 1);
const catOf = db.prepare(
  `SELECT tc.id, tc.name FROM activity_taxonomy_assignments ata JOIN taxonomy_categories tc ON ata.category_id = tc.id
   WHERE ata.activity_id = ? AND tc.taxonomy_id = 'spending_categories' LIMIT 1`,
);
const classify = (a) => {
  if (isTransfer(a.t) && a.g) {
    if ((legCount.get(a.g) ?? 0) >= 2) return 'neutral';
    return a.at === 'CASH' && a.t === 'TRANSFER_OUT' ? 'saving' : 'neutral';
  }
  if (a.at === 'CASH') {
    if (['DEPOSIT', 'TRANSFER_IN', 'INTEREST'].includes(a.t)) return 'income';
    if (['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX'].includes(a.t)) return 'expense';
    if (a.t === 'CREDIT' && a.st === 'BONUS') return 'income';
    if (a.t === 'CREDIT' && ['REFUND', 'REBATE', 'REIMBURSEMENT'].includes(a.st)) return 'refund';
    return 'neutral';
  }
  if (a.at === 'CREDIT_CARD') {
    if (['WITHDRAWAL', 'FEE', 'INTEREST'].includes(a.t)) return 'expense';
    if (a.t === 'CREDIT') return 'refund';
  }
  return 'neutral';
};
const SYNC_MARKERS = ['↔️ In-transit transfer · ', 'Starting balance · ', 'Balance adjustment · '];
const isSyncRow = (a) => SYNC_MARKERS.some((m) => a.notes.startsWith(m));
const months = new Map();
for (const a of spendActs) {
  const k = classify(a);
  if (k === 'neutral') continue;
  const cat = catOf.get(a.id);
  if (cat && excluded.has(cat.id) && (k === 'expense' || k === 'refund')) continue;
  const m = a.d.slice(0, 7);
  const v = months.get(m) ?? { spend: 0, income: 0, saving: 0, bySrc: { purchases: 0, sync: 0, transfers: 0 }, suspects: [] };
  if (k === 'income') v.income += a.amt;
  else if (k === 'saving') {
    v.saving += a.amt;
    v.suspects.push({ ...a, k });
  } else {
    const signed = k === 'expense' ? a.amt : -a.amt;
    v.spend += signed;
    const src = isSyncRow(a) ? 'sync' : isTransfer(a.t) ? 'transfers' : 'purchases';
    v.bySrc[src] += signed;
    if (src !== 'purchases' || (!cat && a.amt >= 100)) v.suspects.push({ ...a, k, cat: cat?.name });
  }
  if (k === 'income' && (isTransfer(a.t) || isSyncRow(a))) v.suspects.push({ ...a, k });
  months.set(m, v);
}
for (const [m, v] of [...months.entries()].sort()) {
  console.log(
    `   ${m}: spending ${money(v.spend).padStart(10)} (purchases ${money(v.bySrc.purchases)}, unlinked transfers ${money(v.bySrc.transfers)}, sync rows ${money(v.bySrc.sync)})  income ${money(v.income)}  saving ${money(v.saving)}`,
  );
  for (const a of v.suspects.sort((x, y) => y.amt - x.amt).slice(0, 8)) {
    console.log(`        ${a.d}  ${a.k.padEnd(7)} ${money(a.amt).padStart(10)}  ${a.t.padEnd(12)} ${String(a.acct).slice(0, 20).padEnd(21)} ${desc(a.notes)}${a.cat === undefined && a.k === 'expense' && !isTransfer(a.t) ? ' [uncategorised]' : ''}`);
  }
}

// ── 5. cash balances vs the bank ───────────────────────────────────────────
console.log('\n=== 5. cash accounts: ledger vs bank vs the drift the sync last measured ===');
const balances = (await secret('account_balances')) ?? {};
const mapping = (await secret('account_mapping')) ?? {};
const byWf = Object.fromEntries(Object.entries(mapping).map(([s, w]) => [w, s]));
for (const r of db
  .prepare(
    `SELECT acc.id, acc.name,
            ROUND(SUM(CASE
              WHEN UPPER(a.activity_type) IN ('DEPOSIT','CREDIT','TRANSFER_IN','DIVIDEND','INTEREST','SELL') THEN 1
              WHEN UPPER(a.activity_type) IN ('WITHDRAWAL','TRANSFER_OUT','FEE','TAX','BUY') THEN -1
              ELSE 0 END * ABS(CAST(COALESCE(a.amount,'0') AS REAL))), 2) ledger
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE UPPER(acc.account_type) = 'CASH' AND COALESCE(a.notes,'') NOT LIKE '% · pending'
     GROUP BY acc.id`,
  )
  .all()) {
  const snap = balances[byWf[r.id]] ?? {};
  console.log(`   ${String(r.name).slice(0, 32).padEnd(33)} ledger ${money(r.ledger).padStart(11)}  bank ${money(snap.balance).padStart(11)}  last drift ${snap.drift == null ? 'none' : money(snap.drift)}`);
}
db.close();
console.log('');
