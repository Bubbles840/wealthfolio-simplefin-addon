#!/usr/bin/env node
/**
 * amazon-rules.mjs — teach Wealthfolio to categorize Amazon charges by their label.
 *
 * The sync writes each Amazon charge's comment as
 *   AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · TRN-…
 * and this inserts one Wealthfolio categorization rule per label so Wealthfolio's
 * OWN engine does the filing. Nothing in the recurring sync path touches the
 * database; this is the single one-time write, and it is why the feature needs no
 * read-write mount.
 *
 * WHY IT INTROSPECTS INSTEAD OF HARD-CODING THE INSERT. This writes to a live
 * financial database that another program owns, and `spending_categorization_rules`
 * is Wealthfolio's private schema — not an API with any compatibility promise. A
 * hard-coded column list would break silently on a Wealthfolio upgrade, or worse,
 * write a row that looks fine and matches nothing. So the script reads the real
 * columns with PRAGMA, copies an EXISTING rule row as its template, and changes
 * only the fields it understands. If it cannot find a template it stops rather
 * than guessing a shape.
 *
 * Dry run by default: prints the SQL and exits. Nothing is written without
 * --apply, and --apply refuses to run while Wealthfolio is up.
 *
 * Re-runnable. A label whose mapping the user CHANGED on the Sync page gets its rule
 * re-pointed, because otherwise that dropdown would be a lie once rules exist: the
 * card, the catalog and the reports would all show the new category while the rule
 * doing the actual filing still pointed at the old one. A pattern that is NOT one of
 * ours is never touched — the user wrote it, and repurposing it silently would be
 * worse than doing nothing.
 *
 * Usage:
 *   node amazon-rules.mjs --db /path/to/app.db --labels labels.json  # show the plan
 *   node amazon-rules.mjs --db /path/to/app.db --labels … --apply    # write it
 *
 * ON A SERVER WITH NO NODE INSTALLED — which is the normal case, since the companion
 * ships Node inside its image — use a throwaway container. NOT `docker exec` into the
 * companion: its database mount is read-only by design, so `--apply` cannot work
 * there, and discovering that only at the write step is worse than not offering it.
 *
 *   # dry run (:ro mount, cannot modify anything)
 *   docker run --rm \
 *     -v /path/to/wealthfolio-dir:/db:ro \
 *     -v ~/wealthfolio-simplefin-addon/companion/scripts:/s:ro \
 *     -v /tmp/labels.json:/labels.json:ro \
 *     node:22-alpine node /s/amazon-rules.mjs --db /db/wealthfolio.db --labels /labels.json
 *
 *   # apply — WEALTHFOLIO MUST BE STOPPED, and note :ro is gone from the db mount
 *   docker run --rm \
 *     -v /path/to/wealthfolio-dir:/db \
 *     -v ~/wealthfolio-simplefin-addon/companion/scripts:/s:ro \
 *     -v /tmp/labels.json:/labels.json:ro \
 *     node:22-alpine node /s/amazon-rules.mjs --db /db/wealthfolio.db --labels /labels.json --apply
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes(`--${name}`);

const dbPath = flag('db');
const apply = has('apply');
const inspect = has('inspect');
const labelsPath = flag('labels');
const priorityArg = flag('priority');

if (!dbPath) {
  console.error('Missing --db /path/to/app.db');
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`No such database: ${dbPath}`);
  process.exit(1);
}

const RULES_TABLE = 'spending_categorization_rules';

/**
 * The labels to write rules for.
 *
 * Normally the companion's discovered set — the labels this household has actually
 * received, which is the only list that matters. Amazon's full vocabulary is
 * unpublished and probably hundreds long; writing rules for labels nobody will ever
 * see is noise in the user's own rule list.
 */
function loadLabels() {
  if (labelsPath) {
    const raw = JSON.parse(readFileSync(labelsPath, 'utf8'));
    // Accepts either the raw `amazon_labels` secret ({label: {category}}) or a
    // plain {label: category} map, because both are things a human might hand it.
    return Object.entries(raw).map(([label, v]) => ({
      label,
      category: typeof v === 'string' ? v : v?.category,
    })).filter((r) => r.category);
  }
  console.error(
    'No --labels file given. Export the addon secret first:\n' +
    "  curl -s -H 'Authorization: Bearer $KEY' \\\n" +
    "    $WF/api/v1/addons/simplefin-sync/secrets/amazon_labels > labels.json",
  );
  process.exit(1);
}

const labels = inspect ? [] : loadLabels();
if (!inspect && labels.length === 0) {
  console.log('No labels to map — nothing to do.');
  process.exit(0);
}

// Read-only for inspection, so a dry run cannot possibly modify anything.
const db = new DatabaseSync(apply ? dbPath : `file:${dbPath}?mode=ro`);

let columns;
try {
  columns = db.prepare(`PRAGMA table_info(${RULES_TABLE})`).all();
} catch (err) {
  console.error(`Could not read ${RULES_TABLE}: ${err.message}`);
  process.exit(1);
}
if (columns.length === 0) {
  console.error(
    `Table ${RULES_TABLE} not found. This Wealthfolio version may store rules ` +
    'elsewhere; stopping rather than writing a table this script does not understand.',
  );
  process.exit(1);
}

console.log(`${RULES_TABLE} columns: ${columns.map((c) => c.name).join(', ')}`);

const template = db.prepare(`SELECT * FROM ${RULES_TABLE} LIMIT 1`).get();
if (!template) {
  console.error(
    `No existing rule in ${RULES_TABLE} to use as a template.\n` +
    'Create ONE rule by hand in Wealthfolio (Spending → any category → add a rule),\n' +
    'then re-run. Copying a real row is what keeps this correct across Wealthfolio\n' +
    'versions instead of guessing at column meanings.',
  );
  process.exit(1);
}

// Locate the fields by role rather than by an assumed name, and say so when a
// role cannot be filled — a rule with no pattern column would insert cleanly and
// match nothing, which is the worst possible outcome here.
const names = columns.map((c) => c.name);
const pick = (...candidates) => candidates.find((c) => names.includes(c));
const idCol = pick('id');
const patternCol = pick('pattern', 'match_value', 'value', 'keyword', 'text');
const categoryCol = pick('category_id', 'taxonomy_category_id', 'category');

if (!patternCol || !categoryCol) {
  console.error(
    'Could not identify the pattern and category columns from: ' + names.join(', ') +
    '\nStopping rather than guessing.',
  );
  process.exit(1);
}
console.log(`Using pattern column "${patternCol}", category column "${categoryCol}".`);

/**
 * The pattern text to store for a label.
 *
 * Wealthfolio's built-in Amazon rules use `match_type = "regex"`, and a new rule
 * inherits that from the template — so the stored text is COMPILED, not compared
 * literally. `Amazon: Bath` happens to be a valid regex for itself, which is why
 * this looked fine; a label carrying a metacharacter would not be. Amazon has
 * merchandising categories like `Health (OTC)` and `Baby + Toddler`, and those would
 * become a different regex than intended, or an invalid one.
 *
 * So the metacharacters get escaped whenever the rule is a regex rule. Used for the
 * duplicate check as well as the insert, or a re-run would fail to recognise its own
 * previous output and write a second copy every time.
 */
const isRegexRule = String(template.match_type ?? '').toLowerCase().includes('regex');
function rulePattern(label) {
  const raw = `Amazon: ${label}`;
  return isRegexRule ? raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : raw;
}

/** Resolve a category NAME to whatever id the rules table references. */
function categoryId(name) {
  if (categoryCol === 'category') return name; // stores the name directly
  const row = db.prepare(
    'SELECT id FROM taxonomy_categories WHERE name = ? AND parent_id IS NULL LIMIT 1',
  ).get(name)
    ?? db.prepare('SELECT id FROM taxonomy_categories WHERE name = ? LIMIT 1').get(name);
  return row?.id ?? null;
}

const allPatterns = db.prepare(`SELECT ${patternCol} AS p FROM ${RULES_TABLE}`).all()
  .map((r) => String(r.p));
const existing = new Set(allPatterns);

/**
 * Rules that already mention Amazon, reported before anything is planned.
 *
 * This matters because a broad existing rule COMPETES with the specific ones this
 * script adds. Every Amazon charge in the live database was already categorized,
 * which means something already claims them — and if a blanket `Amazon` rule wins,
 * the label rules never fire and the whole feature quietly does nothing while
 * appearing installed. Wealthfolio's precedence between two matching rules is not
 * documented, so this refuses to guess and shows the conflict instead.
 */
const competing = allPatterns.filter((p) => /amazon|amzn/i.test(p) && !p.startsWith('Amazon: '));

/**
 * `--inspect`: dump what precedence and matching actually depend on, and stop.
 *
 * The schema turned out to carry `priority`, `match_type` and a set of `preset_*`
 * columns, none of which a template-copy can handle correctly:
 *  - `priority` is how Wealthfolio decides between two matching rules, and nothing
 *    says whether lower or higher wins.
 *  - `match_type` decides whether the pattern is a literal or a regex; the built-in
 *    Amazon rules are regexes.
 *  - `preset_*` marks a rule as one of Wealthfolio's own presets, and a rule wearing
 *    those fields can plausibly be reset or overwritten when the app updates its
 *    presets — silently undoing the whole thing.
 * Guessing at any of them means writing plausible-looking rows into a live financial
 * database, so this prints the evidence and lets a human decide instead.
 */
if (inspect) {
  const cols = ['id', 'name', 'pattern', 'match_type', 'category_id', 'taxonomy_id',
    'activity_type', 'priority', 'is_global', 'account_id', 'preset_id',
    'preset_rule_key'].filter((c) => names.includes(c));
  const rows = db.prepare(
    `SELECT ${cols.join(', ')} FROM ${RULES_TABLE} ORDER BY ${names.includes('priority') ? 'priority' : 'rowid'}`,
  ).all();
  console.log(`\nAll ${rows.length} rule(s), ordered by priority:\n`);
  for (const r of rows) {
    const amazonish = /amazon|amzn/i.test(String(r.pattern ?? ''));
    console.log(`${amazonish ? '  →' : '   '} ${cols.map((c) => `${c}=${JSON.stringify(r[c])}`).join('  ')}`);
  }
  console.log(
    '\nRows marked → already match Amazon charges. What to read off this:\n' +
    '  • the priority values those rules use, and whether low or high appears to win\n' +
    '  • the match_type value (literal vs regex) the Amazon rules use\n' +
    '  • whether they carry preset_id / preset_rule_key (Wealthfolio-owned) or null\n' +
    '    (user-owned)\n' +
    '\nNothing was read beyond this table and nothing was written.',
  );
  process.exit(0);
}

if (competing.length > 0) {
  console.log('\n⚠ Existing rules that already match Amazon charges:\n');
  for (const p of competing) console.log(`    ${p}`);
  console.log(
    '\n  These compete with the label rules below. Wealthfolio resolves that with the\n' +
    '  `priority` column, and nothing documents whether low or high wins — so this\n' +
    '  script will NOT guess. Run with --inspect to see their priorities, then pass\n' +
    '  --priority <n> explicitly.',
  );
}

/**
 * Existing `Amazon: …` rules and the category each points at, so a mapping the user
 * CHANGED can be corrected rather than skipped.
 *
 * Without this the addon card's dropdown would be a lie the moment rules exist:
 * switching "Nutrition & Wellness" from Health & Wellness to Groceries would update
 * the card, the label catalog and every future report, while the rule that actually
 * files the charge kept pointing at the old category — with nothing anywhere saying
 * so. The card has to be the authority.
 */
const ourRules = new Map();
for (const row of db.prepare(
  `SELECT ${patternCol} AS p, ${categoryCol} AS c FROM ${RULES_TABLE}`,
).all()) {
  const p = String(row.p);
  // Matches both the literal and the regex-escaped form (`Amazon\\: …` is not
  // produced, but a label's own escapes are), so a re-run recognises its own rows.
  if (p.startsWith('Amazon: ')) ourRules.set(p, row.c);
}

const plan = [];
const updates = [];
for (const { label, category } of labels) {
  // `Amazon: <label>` and not the bare label. A rule for "Lawn & Garden" alone
  // would also fire on a real garden centre; the prefix is written by the sync and
  // appears nowhere else.
  const pattern = rulePattern(label);
  const catId = categoryId(category);
  if (!catId) {
    console.log(`SKIP  ${pattern} → "${category}" (no such category in Wealthfolio)`);
    continue;
  }
  if (ourRules.has(pattern)) {
    // Already ours. Re-point it only if the user changed the mapping.
    if (String(ourRules.get(pattern)) !== String(catId)) {
      updates.push({ pattern, category, catId });
    }
    continue;
  }
  // A pattern that exists but is NOT one of ours is left completely alone — it is
  // something the user wrote, and silently repurposing it would be worse than
  // doing nothing.
  if (existing.has(pattern)) continue;
  plan.push({ pattern, category, catId });
}

if (plan.length === 0 && updates.length === 0) {
  console.log('Every label already has a rule pointing at the right category. Nothing to do.');
  process.exit(0);
}

const insertCols = names.filter((n) => n !== idCol || typeof template[idCol] === 'string');
if (plan.length > 0) {
  console.log(`\n${plan.length} rule(s) to insert:\n`);
  for (const p of plan) console.log(`  ${p.pattern}  →  ${p.category}`);
}
if (updates.length > 0) {
  console.log(`\n${updates.length} rule(s) to re-point (you changed these on the Sync page):\n`);
  for (const p of updates) console.log(`  ${p.pattern}  →  ${p.category}`);
}

if (!apply) {
  console.log(
    '\nDry run. Re-run with --apply to write these.\n' +
    'STOP WEALTHFOLIO FIRST — it holds the database open, and writing underneath a\n' +
    'running instance risks losing whatever is sitting in its write-ahead log.',
  );
  process.exit(0);
}

// Competing rules + no explicit priority = refuse. Inserting at whatever priority a
// template happened to carry would tie with the broad rule and let an undefined
// ordering decide, which is the same as not knowing whether it worked.
if (competing.length > 0 && names.includes('priority') && priorityArg === null) {
  console.error(
    '\nRefusing to write: there are existing rules matching Amazon charges, and no\n' +
    '--priority was given. These new rules would land at an arbitrary priority and\n' +
    'might never fire.\n\n' +
    '  1. node amazon-rules.mjs --db … --inspect      (see what priorities are in use)\n' +
    '  2. node amazon-rules.mjs --db … --labels … --priority <n> --apply',
  );
  process.exit(1);
}

// A crude but effective liveness check: a hot WAL means Wealthfolio is very likely
// still running. Being wrong in the cautious direction costs one message.
if (existsSync(`${dbPath}-wal`)) {
  const walSize = readFileSync(`${dbPath}-wal`).length;
  if (walSize > 0) {
    console.error(
      `\nRefusing to write: ${dbPath}-wal is ${walSize} bytes, which usually means\n` +
      'Wealthfolio is still running. Stop it, let it checkpoint, then re-run.',
    );
    process.exit(1);
  }
}

const nowIso = new Date().toISOString();
let written = 0;
let repointed = 0;
db.exec('BEGIN');
try {
  for (const p of updates) {
    const sets = [`${categoryCol} = ?`];
    const args = [p.catId];
    if (names.includes('updated_at')) { sets.push('updated_at = ?'); args.push(nowIso); }
    db.prepare(
      `UPDATE ${RULES_TABLE} SET ${sets.join(', ')} WHERE ${patternCol} = ?`,
    ).run(...args, p.pattern);
    repointed += 1;
  }
  for (const p of plan) {
    const row = { ...template };
    if (idCol && typeof template[idCol] === 'string') {
      // A random uuid, NOT a truncated hash of the pattern. Truncating collides:
      // `Amazon: Lawn & Garden` and `Amazon: Lawn Care` share their first twelve
      // bytes, so both hashed to one id and the primary-key clash rolled back the
      // whole batch. Re-running cannot duplicate anyway — the `existing` pattern
      // check above already filters labels that have a rule.
      row[idCol] = randomUUID();
    }
    row[patternCol] = p.pattern;
    row[categoryCol] = p.catId;

    // A rule wearing Wealthfolio's preset markers is a rule Wealthfolio believes it
    // owns, and can plausibly reset or overwrite when it updates its built-in preset
    // — silently undoing all of this months later. These must be OUR rules.
    for (const c of ['preset_id', 'preset_rule_key', 'preset_version', 'preset_modified']) {
      if (names.includes(c)) row[c] = null;
    }
    // Named for a human reading the rules list, rather than inheriting whatever the
    // template rule was called.
    if (names.includes('name')) row.name = p.pattern;
    // Scoped to no single account: an Amazon charge can land on any card.
    if (names.includes('account_id')) row.account_id = null;
    // The category's OWN taxonomy, not the template's — they can differ, and a rule
    // pointing a category at the wrong taxonomy is a rule that never fires.
    if (names.includes('taxonomy_id')) {
      const tx = db.prepare('SELECT taxonomy_id FROM taxonomy_categories WHERE id = ?')
        .get(p.catId);
      if (tx?.taxonomy_id != null) row.taxonomy_id = tx.taxonomy_id;
    }
    if (priorityArg !== null && names.includes('priority')) {
      row.priority = Number(priorityArg);
    }
    for (const c of ['created_at', 'updated_at']) if (names.includes(c)) row[c] = nowIso;
    const cols = insertCols;
    db.prepare(
      `INSERT INTO ${RULES_TABLE} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...cols.map((c) => row[c] ?? null));
    written += 1;
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`\nInsert failed, nothing written: ${err.message}`);
  process.exit(1);
}

console.log(
  `\nWrote ${written} new rule(s)` +
  `${repointed ? ` and re-pointed ${repointed}` : ''}. ` +
  'Start Wealthfolio and re-categorize to apply them.',
);
db.close();
