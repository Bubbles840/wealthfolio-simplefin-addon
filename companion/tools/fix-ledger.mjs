/**
 * companion/tools/fix-ledger.mjs — applies the corrections the audit found.
 *
 *   DRY RUN (default):  … | docker exec -i simplefin-sync node --input-type=module
 *   APPLY:              … | docker exec -i -e APPLY=1 simplefin-sync node --input-type=module
 *
 * Unlike the audit tools this one WRITES, so it is built to be un-scary:
 *
 *  - Every fix names the row by description, amount and date, and is applied
 *    only when that matches EXACTLY ONE activity. Zero matches or several, and
 *    that fix is skipped and reported — never guessed at. A fix already applied
 *    therefore becomes a no-op on a second run (its match no longer looks the
 *    old way), which makes the script safe to re-run.
 *  - The dry run prints the same plan the apply executes, resolved against the
 *    live database, so what you approve is what runs.
 *  - Nothing is deleted. Retypes and category moves are reversible in the UI,
 *    the transfer link can be unlinked, and the one created row is a labelled
 *    starting balance.
 *
 * WHY each fix, since a year from now the diff will not say:
 *
 *  Retypes. A DEPOSIT on a cash account is INCOME to Wealthfolio's classifier.
 *  Money arriving from the user's own other account is not income, and neither
 *  is a friend paying them back. The neutral shape for the first is a bare
 *  CREDIT (classified `Ignored` — neither spending nor income); for the second
 *  it is a CREDIT carrying a REIMBURSEMENT subtype, which reduces the spending
 *  category it is filed against. Retyping to TRANSFER_IN would NOT help: an
 *  unlinked cash TRANSFER_IN classifies as Income exactly like a DEPOSIT.
 *
 *  The Citi starting balance. Wealthfolio's `/valuations/latest` returns rows
 *  for cash accounts only, and the sync's starting-balance logic needs that
 *  figure to compute the opening gap — so a credit card never gets one, and its
 *  ledger silently begins at zero on whatever the first synced transaction was.
 *  Citi's ledger came out $235.40 more owed than SimpleFin reports, which is
 *  that missing opening balance. It is booked as TRANSFER_IN because on a card
 *  that is `Ignored` by the classifier (a CREDIT would read as an expense
 *  refund, and a DEPOSIT is rejected outright), and because since Wealthfolio
 *  3.8 `amount` is the final cash, so a TRANSFER_IN's amount is what moves.
 */
import { DatabaseSync } from 'node:sqlite';

const { WealthfolioClient } = await import('/app/dist/companion/src/wealthfolio.js');
const APPLY = process.env.APPLY === '1';
const DB_PATH = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
const ADDON_ID = 'simplefin-sync';
const TAXONOMY = 'spending_categories';

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

const client = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) client.token = process.env.WEALTHFOLIO_API_KEY;
else await client.login(process.env.WEALTHFOLIO_PASSWORD);

// ── category ids, resolved by name ─────────────────────────────────────────
const cats = db
  .prepare(
    `SELECT tc.id, tc.name, COALESCE(p.name,'') parent
     FROM taxonomy_categories tc LEFT JOIN taxonomy_categories p ON tc.parent_id = p.id
     WHERE tc.taxonomy_id = ?`,
  )
  .all(TAXONOMY);
const catId = (name) => cats.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? null;

// ── the fix list ───────────────────────────────────────────────────────────
/** Move one activity to a different spending category. */
const RECATEGORISE = [
  { find: 'OPENROUTER', amount: 22.37, date: '2026-07-21', to: 'Software & Services', why: 'an AI API service, not shopping' },
  { find: 'Gold Annual Subscription', amount: 50, date: '2026-09-04', to: 'Subscriptions', why: 'a subscription, not a bank fee' },
  { find: 'Staples', amount: 33, date: '2026-08-25', to: 'Shopping', why: 'office supplies, not a hobby' },
  { find: 'Amazon', amount: 14.92, date: '2026-09-02', to: 'Online Shopping', why: 'Amazon belongs in one bucket' },
  { find: 'Amazon', amount: 10.59, date: '2026-08-21', to: 'Online Shopping', why: 'Amazon belongs in one bucket' },
  { find: 'Amazon', amount: 10.17, date: '2026-08-21', to: 'Online Shopping', why: 'Amazon belongs in one bucket' },
  { find: 'AMAZON MKTPL', amount: 10.59, date: '2026-07-21', to: 'Online Shopping', why: 'Amazon belongs in one bucket' },
  { find: 'AMAZON MKTPL', amount: 120.52, date: '2026-07-19', to: 'Online Shopping', why: 'Amazon belongs in one bucket' },
  { find: 'AMAZON MKTPL', amount: 20.34, date: '2026-07-14', to: 'Online Shopping', why: 'Amazon belongs in one bucket' },
];

/** Change one activity's type (and subtype), leaving its amount and date alone. */
const RETYPE = [
  // These two arrived as DEPOSIT (income) while their savings counterparts are
  // TRANSFER_OUT, and the two are ALREADY in one source group — but a group
  // only neutralises legs the classifier reads as transfers, and a DEPOSIT is
  // not one, so the arriving half still counts as income.
  //
  // The obvious repair, retyping to TRANSFER_IN, is unsafe on exactly these
  // rows: both carry the phantom `$CASH` security created by the July 2026 bulk
  // bug, and upstream books transfer cash ONLY on the empty-asset branch — so a
  // TRANSFER_IN holding an asset moves no money and would leave the Spend
  // account $1,900 short. (Wealthfolio 3.8 can finally clear an asset by
  // passing an empty object, but proving that on a reconciled account is not
  // worth it here.)
  //
  // A bare CREDIT needs none of that. It is `Ignored` on a cash account — so
  // both views agree it is neither income nor spending, which is what the
  // grouped TRANSFER_OUT on the other side already reads as — and income types
  // book their cash regardless of a stray asset, so the balance cannot move.
  { find: 'CAPITAL ONE TRANSFER', amount: 1300, date: '2026-07-28', account: 'Spend', type: 'CREDIT', subtype: null, why: 'own money; neutral on both sides without touching the phantom asset' },
  { find: 'CAPITAL ONE TRANSFER', amount: 600, date: '2026-07-30', account: 'Spend', type: 'CREDIT', subtype: null, why: 'own money; neutral on both sides without touching the phantom asset' },
  { find: 'Transfer from Zelle', amount: 200, date: '2026-06-26', type: 'CREDIT', subtype: 'REIMBURSEMENT', why: 'a payback from a person, not income' },
  { find: 'Transfer from Zelle', amount: 117, date: '2026-06-16', type: 'CREDIT', subtype: 'REIMBURSEMENT', why: 'a payback from a person, not income' },
];

/** Link a real transfer pair whose two legs were never grouped. */
const LINK = [
  {
    inflow: { find: 'Transfer from Capital One', amount: 1300, date: '2026-06-29' },
    outflow: { find: 'ACH Withdrawal PNC', amount: 1300, date: '2026-06-26' },
    why: 'a genuine savings→spending transfer; linking makes it neutral instead of income',
  },
];

/** Wealthfolio categorisation rules, so the next charge files itself. */
const RULES = [
  { name: 'OpenRouter → Software & Services', pattern: 'OPENROUTER', category: 'Software & Services' },
  { name: 'Robinhood Gold → Subscriptions', pattern: 'Gold Annual Subscription', category: 'Subscriptions' },
  { name: 'Staples → Shopping', pattern: 'Staples', category: 'Shopping' },
  { name: 'Amazon → Online Shopping', pattern: 'Amazon', category: 'Online Shopping' },
];

/** One missing opening balance, as a labelled starting-balance row. */
const OPENING = {
  accountName: 'Citi Double Cash',
  amount: 235.4,
  // The day before the account's first synced transaction, so it never lands
  // inside a reporting window as activity.
  date: '2026-04-20',
  type: 'TRANSFER_IN',
  why: 'the opening balance a card can never receive automatically (no valuation row)',
};

// ── resolve ────────────────────────────────────────────────────────────────
function findOne(find, amount, date, account = '') {
  const rows = db
    .prepare(
      `SELECT a.id, a.account_id, a.activity_type, a.subtype, a.currency,
              COALESCE(a.asset_id,'') asset_id,
              substr(a.activity_date,1,10) d, a.activity_date raw_date,
              ROUND(ABS(CAST(a.amount AS REAL)),2) amt, COALESCE(a.notes,'') notes,
              acc.name acct
       FROM activities a JOIN accounts acc ON a.account_id = acc.id
       WHERE COALESCE(a.notes,'') LIKE ?
         AND ROUND(ABS(CAST(a.amount AS REAL)),2) = ?
         AND substr(a.activity_date,1,10) = ?
         AND (? = '' OR acc.name LIKE ?)`,
    )
    .all(`%${find}%`, amount, date, account, account ? `%${account}%` : '');
  return rows;
}
/** An ambiguous match is a finding, not just a refusal: print the candidates so
 *  the fix can be narrowed (or the extra row explained). */
function describeCandidates(rows) {
  return rows
    .map(
      (r) =>
        `\n        ${r.d}  ${String(r.acct).slice(0, 24).padEnd(25)} ${String(r.activity_type).padEnd(13)} ${money(r.amt)}  id=${r.id}  ${String(r.notes).slice(0, 44)}`,
    )
    .join('');
}

const catOf = (activityId) =>
  db
    .prepare(
      `SELECT tc.name FROM activity_taxonomy_assignments ata
       JOIN taxonomy_categories tc ON ata.category_id = tc.id
       WHERE ata.activity_id = ? AND tc.taxonomy_id = ?`,
    )
    .all(activityId, TAXONOMY)
    .map((r) => r.name)
    .join(', ') || '(none)';

console.log(`\n=== ${APPLY ? 'APPLYING' : 'DRY RUN — set APPLY=1 to execute'} ===\n`);
const actions = [];
const skipped = [];

console.log('── recategorise');
for (const fix of RECATEGORISE) {
  const rows = findOne(fix.find, fix.amount, fix.date);
  const target = catId(fix.to);
  if (rows.length !== 1) {
    skipped.push(`${fix.find} ${money(fix.amount)} ${fix.date}: matched ${rows.length} rows${describeCandidates(rows)}`);
    continue;
  }
  if (!target) {
    skipped.push(`${fix.find} ${money(fix.amount)}: no category named "${fix.to}"`);
    continue;
  }
  const row = rows[0];
  const from = catOf(row.id);
  if (from === fix.to) {
    console.log(`   – ${fix.find} ${money(fix.amount)} already in ${fix.to}`);
    continue;
  }
  console.log(`   ${row.d}  ${money(row.amt).padStart(10)}  ${fix.find.padEnd(26)} ${from} → ${fix.to}   (${fix.why})`);
  actions.push({ kind: 'recategorise', id: row.id, categoryId: target, label: `${fix.find} → ${fix.to}` });
}

console.log('\n── retype');
for (const fix of RETYPE) {
  const rows = findOne(fix.find, fix.amount, fix.date, fix.account ?? '');
  if (rows.length !== 1) {
    skipped.push(`${fix.find} ${money(fix.amount)} ${fix.date}: matched ${rows.length} rows${describeCandidates(rows)}`);
    continue;
  }
  const row = rows[0];
  if (row.activity_type === fix.type && (row.subtype ?? null) === fix.subtype) {
    console.log(`   – ${fix.find} ${money(fix.amount)} already ${fix.type}${fix.subtype ? `/${fix.subtype}` : ''}`);
    continue;
  }
  // A transfer leg that carries an asset books NO cash: upstream's
  // handle_transfer_out/in move cash only on the `asset_id.is_empty()` branch.
  // Retyping an asset-backed row into a transfer would silently stop it moving
  // the balance, so refuse rather than break a reconciled account.
  if ((fix.type === 'TRANSFER_IN' || fix.type === 'TRANSFER_OUT') && row.asset_id !== '') {
    skipped.push(`${fix.find} ${money(fix.amount)}: carries asset ${row.asset_id}; a transfer leg with an asset books no cash`);
    continue;
  }
  console.log(
    `   ${row.d}  ${money(row.amt).padStart(10)}  ${fix.find.padEnd(26)} ${row.activity_type} → ${fix.type}${fix.subtype ? `/${fix.subtype}` : ' (no subtype)'}   (${fix.why})`,
  );
  actions.push({
    kind: 'retype',
    label: `${fix.find} → ${fix.type}`,
    update: {
      id: row.id,
      accountId: row.account_id,
      activityType: fix.type,
      activityDate: row.raw_date,
      amount: row.amt,
      fee: 0,
      currency: row.currency || 'USD',
      comment: row.notes,
      ...(fix.subtype ? { subtype: fix.subtype } : {}),
      // The sync authored these rows and this correction is deliberate, so it
      // attests the amount rather than leaving 3.8's writer to flag it.
      needsReview: false,
    },
  });
}

console.log('\n── link transfer pairs');
for (const pair of LINK) {
  const ins = findOne(pair.inflow.find, pair.inflow.amount, pair.inflow.date, pair.inflow.account ?? '');
  const outs = findOne(pair.outflow.find, pair.outflow.amount, pair.outflow.date, pair.outflow.account ?? '');
  if (ins.length !== 1 || outs.length !== 1) {
    skipped.push(`link ${money(pair.inflow.amount)}: matched ${ins.length} inflows and ${outs.length} outflows`);
    continue;
  }
  // Idempotency: a linked pair shares a source_group_id. Without this check a
  // second apply re-links rows that are already a group, which on this host
  // means delete-and-recreate — new activity ids for no reason.
  const groups = db
    .prepare(`SELECT COALESCE(source_group_id,'') g FROM activities WHERE id IN (?, ?)`)
    .all(ins[0].id, outs[0].id)
    .map((r) => r.g);
  if (groups.every((g) => g !== '') && groups[0] === groups[1]) {
    console.log(`   – ${money(pair.inflow.amount)} ${ins[0].d} is already linked`);
    continue;
  }
  console.log(`   ${ins[0].d} ${ins[0].acct} ← → ${outs[0].d} ${outs[0].acct}  ${money(pair.inflow.amount)}   (${pair.why})`);
  actions.push({ kind: 'link', a: ins[0].id, b: outs[0].id, label: `link ${money(pair.inflow.amount)}` });
}

console.log('\n── categorisation rules for next time');
// Wealthfolio's own rules live in this table; reading it is how a second apply
// avoids stacking a duplicate rule for the same pattern (the create endpoint
// does not dedupe, and nothing downstream would notice two identical rules
// beyond the clutter).
const existingRules = db
  .prepare(`SELECT LOWER(COALESCE(pattern,'')) p FROM spending_categorization_rules`)
  .all()
  .map((r) => r.p);
for (const rule of RULES) {
  const target = catId(rule.category);
  if (!target) {
    skipped.push(`rule "${rule.name}": no category named "${rule.category}"`);
    continue;
  }
  if (existingRules.includes(rule.pattern.toLowerCase())) {
    console.log(`   – a rule for "${rule.pattern}" already exists`);
    continue;
  }
  console.log(`   "${rule.pattern}" → ${rule.category}`);
  actions.push({ kind: 'rule', rule: { name: rule.name, pattern: rule.pattern, categoryId: target, taxonomyId: TAXONOMY, priority: 50 }, label: rule.name });
}

console.log('\n── mapping rule for next time (sync-side typing)');
// Zelle only. A rule matches on description alone with NO direction check, so a
// rule that says CREDIT would add cash to an OUTGOING transfer of the same
// name. "Transfer from Zelle" names the direction in the descriptor itself,
// which makes it safe; "Capital One transfer" does not, so no rule is added for
// it — those rows are corrected individually above.
const ZELLE_RULE = { pattern: 'Transfer from Zelle', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' };
let mappingRules = [];
try {
  const raw = await client.getAddonSecret(ADDON_ID, 'mapping_rules');
  mappingRules = raw ? JSON.parse(raw) : [];
} catch {
  /* treated as none */
}
const haveZelle = mappingRules.some((r) => String(r.pattern).toLowerCase() === ZELLE_RULE.pattern.toLowerCase());
if (haveZelle) console.log('   – a "Transfer from Zelle" rule already exists');
else {
  console.log(`   "${ZELLE_RULE.pattern}" → CREDIT / REIMBURSEMENT`);
  actions.push({ kind: 'mappingRule', rules: [...mappingRules, ZELLE_RULE], label: 'Zelle mapping rule' });
}

console.log('\n── missing opening balance');
const card = db
  .prepare(`SELECT id, name, currency FROM accounts WHERE name LIKE ?`)
  .all(`%${OPENING.accountName}%`);
const alreadyOpened = card.length === 1
  ? db
      .prepare(`SELECT COUNT(*) n FROM activities WHERE account_id = ? AND COALESCE(notes,'') LIKE 'Starting balance · %'`)
      .get(card[0].id).n
  : 0;
if (card.length !== 1) skipped.push(`opening balance: matched ${card.length} accounts named like "${OPENING.accountName}"`);
else if (alreadyOpened > 0) console.log('   – that card already has a starting-balance row');
else {
  console.log(`   ${OPENING.date}  ${money(OPENING.amount)}  ${OPENING.type} on ${card[0].name}   (${OPENING.why})`);
  actions.push({
    kind: 'opening',
    label: `opening balance ${money(OPENING.amount)}`,
    row: {
      accountId: card[0].id,
      sourceSystem: 'simplefin',
      activityType: OPENING.type,
      date: OPENING.date,
      // The import endpoint REJECTS a row with no symbol; the reserved cash
      // symbol lands on the real-cash branch and creates no phantom security
      // (verified live on a card, 2026-08-30).
      symbol: `$CASH-${card[0].currency || 'USD'}`,
      amount: OPENING.amount,
      currency: card[0].currency || 'USD',
      comment: 'Starting balance · citi-opening-2026-04-20',
      isValid: true,
      isDraft: false,
    },
  });
}

db.close();

console.log(`\n=== ${actions.length} action(s) planned, ${skipped.length} skipped ===`);
for (const s of skipped) console.log(`   ! ${s}`);

if (!APPLY) {
  console.log('\nNothing was written. Re-run with APPLY=1 to execute.\n');
  process.exit(0);
}

console.log('\n── applying');
let ok = 0;
for (const action of actions) {
  try {
    if (action.kind === 'recategorise') await client.assignActivityCategory(action.id, TAXONOMY, action.categoryId);
    else if (action.kind === 'retype') {
      const res = await client.saveMany({ updates: [action.update] });
      if (res.errors?.length) throw new Error(res.errors.map((e) => e.message ?? JSON.stringify(e)).join('; '));
    } else if (action.kind === 'link') await client.linkTransferActivities(action.a, action.b);
    else if (action.kind === 'rule') await client.createCategorizationRule(action.rule);
    else if (action.kind === 'mappingRule') await client.setAddonSecret(ADDON_ID, 'mapping_rules', JSON.stringify(action.rules));
    else if (action.kind === 'opening') await client.importActivities([action.row]);
    console.log(`   ✓ ${action.label}`);
    ok++;
  } catch (err) {
    console.log(`   ✗ ${action.label}: ${String(err.message ?? err)}`);
  }
}
console.log(`\n${ok} of ${actions.length} applied.`);
console.log('Re-run the audit tools to confirm, then a sync to let the reports catch up.\n');
