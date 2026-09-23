/**
 * companion/tools/fix-transfers.mjs — link the transfer legs Wealthfolio's
 * Health page reports as "incomplete", and retire the phantom `$CASH` asset.
 *
 *   DRY RUN (default):  … | docker exec -i simplefin-sync node --input-type=module
 *   APPLY:              … | docker exec -i -e APPLY=1 simplefin-sync node --input-type=module
 *   + MARK_EXTERNAL=1   also mark legs with NO counterpart as external
 *
 * Why these rows matter beyond the warning. Wealthfolio 3.8 treats a transfer
 * as neutral only when it is one half of a valid pair — exactly one TRANSFER_IN
 * and one TRANSFER_OUT sharing a group, in two accounts, neither carrying a
 * security (activities/transfer_pairs.rs). Anything else is classified on its
 * own (crates/spending, classify_activity_for_aggregation):
 *   - an unlinked cash TRANSFER_OUT is SPENDING and an unlinked TRANSFER_IN is
 *     INCOME — a $1,300 savings→spending move inflates both by $1,300;
 *   - a cash TRANSFER_OUT whose group has no valid partner is SAVING — the July
 *     Capital One legs, grouped with a CREDIT, read as $1,900 saved.
 * Linking the real pair makes both legs neutral on every Wealthfolio page.
 *
 * What it does, per incomplete leg (the addon's own opening balances, plugs
 * and in-transit placeholders are skipped: the v1.54 sync marks those itself):
 *   1. Looks for its counterpart: another account, the opposite direction, the
 *      same amount to the cent, within 5 days — as a transfer, or as the
 *      DEPOSIT / CREDIT / WITHDRAWAL an older sync or rule wrote it as.
 *   2. Acts only on a match that is unique BOTH ways. Anything ambiguous is
 *      printed and left alone.
 *   3. Retypes a counterpart that is not transfer-typed, clearing a stored
 *      security (the phantom `$CASH`, which makes a transfer leg book no cash
 *      and fail pairing). Amount, date, note and id are unchanged.
 *   4. Links the two through Wealthfolio's own link endpoint, which updates
 *      both rows in place — ids and categories survive.
 * Then, if every row that pointed at the phantom `$CASH` asset was cleared, it
 * deletes that asset, which is what ends the "Sync issues for $CASH" warning.
 *
 * Every write is reversible in the UI (unlink, retype). Re-running is safe: a
 * linked pair is no longer incomplete, so a second run plans nothing for it.
 */
import { DatabaseSync } from 'node:sqlite';

const { WealthfolioClient } = await import('/app/dist/companion/src/wealthfolio.js');
const APPLY = process.env.APPLY === '1';
const MARK_EXTERNAL = process.env.MARK_EXTERNAL === '1';
const DB_PATH = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
const MATCH_DAYS = 5;
const PHANTOM_ID = '9231cb80-4223-4c04-98e3-dd3b1af60311';
const INTERNAL = JSON.stringify({ flow: { is_external: false } });
const EXTERNAL = JSON.stringify({ flow: { is_external: true } });
const SYNC_BOOKKEEPING = ['Starting balance · ', 'Balance adjustment · '];
const IN_TRANSIT = '↔️ In-transit transfer · ';

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
const money = (n) => '$' + Math.abs(Number(n) || 0).toFixed(2);
const desc = (notes) => String(notes ?? '').replace(IN_TRANSIT, '⇄ ').split(' · ')[0].slice(0, 36);
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);

const client = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) client.token = process.env.WEALTHFOLIO_API_KEY;
else await client.login(process.env.WEALTHFOLIO_PASSWORD);

const assetCodes = new Map(
  db.prepare(`SELECT id, COALESCE(display_code, instrument_symbol, name, id) code FROM assets`).all().map((a) => [a.id, String(a.code)]),
);
const isPhantom = (assetId) => !!assetId && (assetId === PHANTOM_ID || assetCodes.get(assetId)?.toUpperCase() === '$CASH');
// Mirrors non_cash_transfer_asset_key: a real cash asset id starts with `$CASH-`;
// anything else on a transfer leg is a security.
const carriesSecurity = (assetId) => !!assetId && !assetId.toUpperCase().startsWith('$CASH');

const acts = db
  .prepare(
    `SELECT a.id, a.account_id, acc.name acct, substr(a.activity_date,1,10) d, UPPER(a.currency) ccy,
            UPPER(COALESCE(a.activity_type_override, a.activity_type)) t, UPPER(COALESCE(a.status,'POSTED')) status,
            ABS(CAST(COALESCE(a.amount,'0') AS REAL)) amt, COALESCE(a.source_group_id,'') g,
            COALESCE(a.asset_id,'') asset, COALESCE(a.notes,'') notes, COALESCE(a.metadata,'') meta
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE COALESCE(acc.is_archived, 0) = 0`,
  )
  .all();
const isTransfer = (t) => t === 'TRANSFER_IN' || t === 'TRANSFER_OUT';
const flowExternal = (meta) => {
  try {
    const v = JSON.parse(meta || 'null')?.flow?.is_external;
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
};

// Valid pairs, by Wealthfolio's rule.
const groups = new Map();
for (const a of acts) {
  if (!isTransfer(a.t) || !a.g.trim()) continue;
  if (!groups.has(a.g)) groups.set(a.g, []);
  groups.get(a.g).push(a);
}
const validGroup = (legs) =>
  legs.length === 2 &&
  legs.filter((l) => l.t === 'TRANSFER_IN').length === 1 &&
  legs[0].account_id !== legs[1].account_id &&
  !legs.some((l) => carriesSecurity(l.asset));
const inValidPair = (a) => isTransfer(a.t) && !!a.g && validGroup(groups.get(a.g) ?? []);

const isBookkeeping = (a) => SYNC_BOOKKEEPING.some((m) => a.notes.startsWith(m));
const incomplete = acts.filter(
  (a) => isTransfer(a.t) && a.status === 'POSTED' && !inValidPair(a) && flowExternal(a.meta) !== true,
);
const leftForSync = incomplete.filter((a) => isBookkeeping(a) || a.notes.startsWith(IN_TRANSIT));
const userLegs = incomplete.filter((a) => !isBookkeeping(a) && !a.notes.startsWith(IN_TRANSIT));

const INFLOW = new Set(['TRANSFER_IN', 'DEPOSIT', 'CREDIT']);
const OUTFLOW = new Set(['TRANSFER_OUT', 'WITHDRAWAL']);
const counterparts = (leg) =>
  acts.filter(
    (c) =>
      c.id !== leg.id &&
      c.account_id !== leg.account_id &&
      c.ccy === leg.ccy &&
      c.status === 'POSTED' &&
      !isBookkeeping(c) &&
      !inValidPair(c) &&
      Math.abs(c.amt - leg.amt) < 0.005 &&
      Math.abs(dayMs(c.d) - dayMs(leg.d)) <= MATCH_DAYS * 86_400_000 &&
      (leg.t === 'TRANSFER_OUT' ? INFLOW.has(c.t) : OUTFLOW.has(c.t)),
  );

// Unique both ways: the leg has one candidate, and no other leg wants it.
const claims = new Map();
const proposals = [];
const unmatched = [];
const ambiguous = [];
for (const leg of userLegs) {
  const cs = counterparts(leg);
  if (cs.length === 1) {
    proposals.push({ leg, other: cs[0] });
    claims.set(cs[0].id, (claims.get(cs[0].id) ?? 0) + 1);
  } else if (cs.length === 0) unmatched.push(leg);
  else ambiguous.push({ leg, cs });
}
// A pair of two incomplete legs is found from both ends; keep it once.
const seen = new Set();
const pairs = [];
for (const p of proposals) {
  const key = [p.leg.id, p.other.id].sort().join('|');
  if (seen.has(key)) continue;
  seen.add(key);
  // Contested: another leg wants the same counterpart, or the counterpart is an
  // incomplete leg that itself has more than one candidate.
  const contested =
    ((claims.get(p.other.id) ?? 0) > 1 && !userLegs.some((l) => l.id === p.other.id)) ||
    ambiguous.some((x) => x.leg.id === p.other.id);
  if (contested) ambiguous.push({ leg: p.leg, cs: [p.other] });
  else pairs.push(p);
}

const line = (a) => `${a.d}  ${a.t.padEnd(12)} ${money(a.amt).padStart(10)}  ${String(a.acct).slice(0, 20).padEnd(21)} ${desc(a.notes)}`;
console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN — nothing is written; re-run with -e APPLY=1'}`);
console.log(`\n── ${incomplete.length} incomplete transfer leg(s): ${userLegs.length} of yours, ${leftForSync.length} the addon's own (the v1.54 sync marks those)`);

const writes = [];
console.log(`\n── link ${pairs.length} pair(s)`);
for (const { leg, other } of pairs) {
  const out = leg.t === 'TRANSFER_OUT' ? leg : other;
  const inn = out === leg ? other : leg;
  console.log(`   OUT ${line(out)}`);
  console.log(`   IN  ${line(inn)}`);
  for (const row of [out, inn]) {
    const want = row === out ? 'TRANSFER_OUT' : 'TRANSFER_IN';
    const needsType = row.t !== want;
    const needsAsset = carriesSecurity(row.asset);
    if (!needsType && !needsAsset) continue;
    const notes = [needsType ? `${row.t} → ${want}` : null, needsAsset ? `clear asset ${assetCodes.get(row.asset) ?? row.asset}` : null].filter(Boolean);
    console.log(`       · ${row.acct}: ${notes.join(', ')}`);
    writes.push({
      kind: 'update',
      label: `${row.acct} ${row.d} ${money(row.amt)}`,
      update: {
        id: row.id,
        accountId: row.account_id,
        activityType: want,
        activityDate: row.d,
        amount: row.amt,
        currency: row.ccy,
        comment: row.notes,
        ...(needsAsset ? { asset: {} } : {}),
        metadata: INTERNAL,
      },
      row,
      clearsAsset: needsAsset ? row.asset : null,
    });
  }
  writes.push({ kind: 'link', label: `link ${money(out.amt)} ${out.acct} → ${inn.acct}`, a: out, b: inn });
}

if (ambiguous.length) {
  console.log(`\n── ${ambiguous.length} leg(s) with more than one possible counterpart — left alone, link these by hand`);
  for (const { leg, cs } of ambiguous) {
    console.log(`   ${line(leg)}`);
    for (const c of cs) console.log(`       ? ${line(c)}`);
  }
}
if (unmatched.length) {
  console.log(`\n── ${unmatched.length} leg(s) with no counterpart in any account${MARK_EXTERNAL ? ' — marking external' : ''}`);
  console.log('   (money to or from an account Wealthfolio does not track, or a transfer whose other side never synced)');
  for (const leg of unmatched) {
    console.log(`   ${line(leg)}`);
    if (MARK_EXTERNAL) {
      writes.push({
        kind: 'update',
        label: `external ${leg.acct} ${leg.d} ${money(leg.amt)}`,
        update: { id: leg.id, accountId: leg.account_id, activityType: leg.t, activityDate: leg.d, amount: leg.amt, currency: leg.ccy, comment: leg.notes, metadata: EXTERNAL },
        row: leg,
        clearsAsset: null,
      });
    }
  }
  if (!MARK_EXTERNAL) console.log('   → add -e MARK_EXTERNAL=1 to mark these external (silences the warning; spending is unchanged)');
}

// The phantom $CASH asset: deletable once nothing points at it.
const phantomRefs = acts.filter((a) => isPhantom(a.asset));
const phantomIds = [...new Set([...assetCodes.keys()].filter((id) => isPhantom(id)))];
const cleared = new Set(writes.filter((w) => w.clearsAsset && isPhantom(w.clearsAsset)).map((w) => w.row.id));
const stillReferenced = phantomRefs.filter((a) => !cleared.has(a.id));
console.log(`\n── phantom $CASH asset: ${phantomIds.length ? phantomIds.join(', ') : 'none'}`);
for (const a of phantomRefs) console.log(`   ${cleared.has(a.id) ? 'cleared by this plan' : 'STILL REFERENCED  '}  ${line(a)}`);
if (phantomIds.length && stillReferenced.length === 0) {
  for (const id of phantomIds) writes.push({ kind: 'delete-asset', label: `delete asset ${id}`, id });
  console.log('   → will be deleted (nothing points at it after this plan)');
} else if (phantomIds.length) {
  console.log('   → kept: rows above still point at it');
}

db.close();
console.log(`\n── ${writes.length} write(s) planned`);
if (!APPLY) process.exit(0);

let failed = 0;
for (const w of writes) {
  try {
    if (w.kind === 'update') {
      const res = await client.saveMany({ updates: [w.update] });
      if ((res.errors ?? []).length) throw new Error(res.errors.map((e) => e.message).join('; '));
    } else if (w.kind === 'link') {
      // A retype can already have turned an existing (invalid) group into a
      // valid pair — then the link endpoint refuses it as "already linked",
      // which is the outcome wanted. Checked by re-reading both rows' groups.
      const check = openReadOnly();
      const gs = check.prepare(`SELECT id, COALESCE(source_group_id,'') g, COALESCE(metadata,'') meta FROM activities WHERE id IN (?, ?)`).all(w.a.id, w.b.id);
      check.close();
      if (gs.length === 2 && gs[0].g && gs[0].g === gs[1].g) {
        // The link endpoint would have stamped both legs internal; Wealthfolio's
        // `is_valid_internal_transfer_pair` wants that marker on BOTH, so add it
        // to whichever leg the retype did not already cover.
        for (const [leg, type] of [[w.a, 'TRANSFER_OUT'], [w.b, 'TRANSFER_IN']]) {
          if (flowExternal(gs.find((r) => r.id === leg.id)?.meta) === false) continue;
          const res = await client.saveMany({ updates: [{
            id: leg.id, accountId: leg.account_id, activityType: type, activityDate: leg.d,
            amount: leg.amt, currency: leg.ccy, comment: leg.notes, metadata: INTERNAL,
          }] });
          if ((res.errors ?? []).length) throw new Error(res.errors.map((e) => e.message).join('; '));
        }
        console.log(`   ✓ ${w.label} (already a valid pair after the retype)`);
        continue;
      }
      await client.linkTransferActivities(w.a.id, w.b.id);
    } else if (w.kind === 'delete-asset') {
      const res = await fetch(`${client.baseUrl}/api/v1/assets/${encodeURIComponent(w.id)}`, {
        method: 'DELETE',
        headers: client.authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`);
    }
    console.log(`   ✓ ${w.label}`);
  } catch (e) {
    failed++;
    console.log(`   ✗ ${w.label}: ${e?.message ?? e}`);
  }
}
console.log(failed ? `\n${failed} write(s) failed — nothing after a failure depends on it; re-run to retry.` : '\nDone. Re-run without APPLY to confirm nothing is left.');
