/**
 * companion/src/amazon-descriptors.ts
 *
 * "Will the matcher recognise MY bank's Amazon descriptor?" — the one assumption in
 * this feature that no fixture can test.
 *
 * The descriptor is whatever the user's own bank writes, and it varies by issuer:
 * `AMAZON.COM*MB3T81`, `AMZN Mktp US*XY7Q2`, `AMAZON MKTPLACE PMTS` and
 * `Amazon.com*RT4KL` are all real. If `isAmazonDescription` misses the form a user
 * actually gets, nothing ever matches and there is NO error — Amazon charges just
 * stay uncategorized forever, indistinguishable from never having set the feature
 * up. That silence is why this exists.
 *
 * Read-only: opens the database with `mode=ro` through the same reader the reports
 * use, and writes nothing anywhere.
 *
 *   docker exec simplefin-sync node dist/companion/src/amazon-descriptors.js
 */

import { getNativeAmazonRows } from './sqlite-native.js';
import { isAmazonDescription } from '../../shared/amazon-ledger.js';
import { descriptionFromComment } from '../../shared/sync-core.js';

const dbPath = process.env.WEALTHFOLIO_DB_PATH ?? '';
if (!dbPath) {
  console.error('Missing WEALTHFOLIO_DB_PATH. Run this inside the companion container.');
  process.exit(1);
}

const rows = getNativeAmazonRows(dbPath);
if (rows.length === 0) {
  console.log(
    'No Amazon-looking activities found.\n\n' +
    'Either there are none yet, or WEALTHFOLIO_DB_PATH points somewhere unexpected —\n' +
    `it is currently ${dbPath}. The DIRECTORY must be mounted, not the bare .db file,\n` +
    'or the reader falls back to a snapshot that can be days stale.',
  );
  process.exit(0);
}

// Group by the bank's own text, stripping the bookkeeping decorations this codebase
// adds. One descriptor per merchant terminal, so a handful of distinct forms usually
// covers years of orders.
const seen = new Map<string, { count: number; recognised: boolean; sample: string; categorized: number }>();
for (const row of rows) {
  const desc = descriptionFromComment(row.notes);
  // Compare on the bank text WITHOUT any Amazon enrichment this feature already
  // added, so a second run does not congratulate itself on its own output.
  const bank = desc.split(' · Amazon:')[0].trim();
  const key = bank || '(empty)';
  const entry = seen.get(key);
  if (entry) {
    entry.count += 1;
    if (row.categorized) entry.categorized += 1;
  } else {
    seen.set(key, {
      count: 1,
      recognised: isAmazonDescription(bank),
      sample: `${row.date}  $${(row.amountCents / 100).toFixed(2)}`,
      categorized: row.categorized ? 1 : 0,
    });
  }
}

const entries = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
const recognised = entries.filter(([, v]) => v.recognised);
const missed = entries.filter(([, v]) => !v.recognised);

console.log(`Amazon-looking descriptors in your data (${rows.length} rows, ${entries.length} distinct):\n`);
for (const [desc, v] of recognised) {
  console.log(`  ✓ ${desc}`);
  console.log(`      ${v.count} charge(s), ${v.categorized} already categorized · e.g. ${v.sample}`);
}
if (missed.length > 0) {
  console.log('');
  for (const [desc, v] of missed) {
    console.log(`  ✗ ${desc}   — NOT recognised as an Amazon retail charge`);
    console.log(`      ${v.count} charge(s) · e.g. ${v.sample}`);
  }
}

console.log('');
if (missed.length === 0) {
  console.log(
    'Every form is recognised. Amazon order emails will be matched against all of\n' +
    'these once the mailbox is configured.',
  );
} else {
  console.log(
    `${missed.length} descriptor form(s) would never match an order email.\n\n` +
    'Some of that is correct and intended: Prime, Prime Video, Kindle Unlimited and\n' +
    'AWS are excluded deliberately, because they produce no order email at all — a\n' +
    '"match" for them could only ever come from an unrelated order\'s amount\n' +
    'colliding. Handle those with an ordinary Wealthfolio merchant rule instead;\n' +
    'they are fixed recurring amounts, so a rule catches them forever.\n\n' +
    'But a RETAIL descriptor in that list is a gap worth reporting — it means real\n' +
    'purchases would stay uncategorized silently.',
  );
}
