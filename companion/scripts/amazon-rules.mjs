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
 * Usage:
 *   node amazon-rules.mjs --db /path/to/app.db                      # show the plan
 *   node amazon-rules.mjs --db /path/to/app.db --labels labels.json # explicit labels
 *   node amazon-rules.mjs --db /path/to/app.db --apply              # write it
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
const labelsPath = flag('labels');

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

const labels = loadLabels();
if (labels.length === 0) {
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

/** Resolve a category NAME to whatever id the rules table references. */
function categoryId(name) {
  if (categoryCol === 'category') return name; // stores the name directly
  const row = db.prepare(
    'SELECT id FROM taxonomy_categories WHERE name = ? AND parent_id IS NULL LIMIT 1',
  ).get(name)
    ?? db.prepare('SELECT id FROM taxonomy_categories WHERE name = ? LIMIT 1').get(name);
  return row?.id ?? null;
}

const existing = new Set(
  db.prepare(`SELECT ${patternCol} AS p FROM ${RULES_TABLE}`).all().map((r) => String(r.p)),
);

const plan = [];
for (const { label, category } of labels) {
  // `Amazon: <label>` and not the bare label. A rule for "Lawn & Garden" alone
  // would also fire on a real garden centre; the prefix is written by the sync and
  // appears nowhere else.
  const pattern = `Amazon: ${label}`;
  if (existing.has(pattern)) continue;
  const catId = categoryId(category);
  if (!catId) {
    console.log(`SKIP  ${pattern} → "${category}" (no such category in Wealthfolio)`);
    continue;
  }
  plan.push({ pattern, category, catId });
}

if (plan.length === 0) {
  console.log('Every label already has a rule. Nothing to do.');
  process.exit(0);
}

const insertCols = names.filter((n) => n !== idCol || typeof template[idCol] === 'string');
console.log(`\n${plan.length} rule(s) to insert:\n`);
for (const p of plan) console.log(`  ${p.pattern}  →  ${p.category}`);

if (!apply) {
  console.log(
    '\nDry run. Re-run with --apply to write these.\n' +
    'STOP WEALTHFOLIO FIRST — it holds the database open, and writing underneath a\n' +
    'running instance risks losing whatever is sitting in its write-ahead log.',
  );
  process.exit(0);
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
db.exec('BEGIN');
try {
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

console.log(`\nWrote ${written} rule(s). Start Wealthfolio and re-categorize to apply them.`);
db.close();
