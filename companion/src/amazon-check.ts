/**
 * companion/src/amazon-check.ts
 *
 * "Does my mailbox work, and does the parser understand MY emails?" — answered
 * without touching anything.
 *
 * This exists because the two ways Amazon categorization can silently do nothing
 * are both invisible from the outside: a mailbox that will not connect, and a
 * message shape the parser does not recognise. Both present identically to the user
 * ("it's just not labelling anything"), so there has to be a way to look.
 *
 * READ-ONLY BY CONSTRUCTION. It does not mark anything seen, does not write the
 * ledger, and does not touch Wealthfolio — so the real poll still picks up every
 * message afterwards, and running this twenty times in a row changes nothing.
 *
 *   docker exec simplefin-sync node dist/companion/src/amazon-check.js \
 *     --host imap.gmail.com --user you@gmail.com --password 'xxxx xxxx xxxx xxxx'
 *
 * With no flags it reads the same env vars the companion does.
 */

import { classifyAmazonEmail } from '../../shared/amazon.js';
import { resolveAmazonCategory } from '../../shared/amazon-config.js';
import { createImapSource } from './amazon-mail.js';
import type { AmazonMailConfig } from '../../shared/amazon-config.js';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const cfg: AmazonMailConfig = {
  host: flag('host', process.env.AMAZON_IMAP_HOST),
  port: Number(flag('port', process.env.AMAZON_IMAP_PORT ?? '993')),
  user: flag('user', process.env.AMAZON_IMAP_USER),
  password: flag('password', process.env.AMAZON_IMAP_PASSWORD),
};

if (!cfg.host || !cfg.user || !cfg.password) {
  console.error(
    'Usage: node amazon-check.js --host imap.gmail.com --user you@gmail.com --password "app password"',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`Connecting to ${cfg.host}:${cfg.port} as ${cfg.user} ...`);
  let source;
  try {
    source = await createImapSource(cfg);
  } catch (err) {
    console.error(`\n❌ Could not connect or log in: ${(err as Error).message}`);
    // imapflow reduces an IMAP rejection to "Command failed" and hangs the real
    // answer off the error object, so printing only `.message` throws away the one
    // thing that identifies the problem. Gmail is specific when asked —
    // "[AUTHENTICATIONFAILED] Invalid credentials" versus
    // "[ALERT] Application-specific password required" are different fixes — and
    // guessing between them is exactly what this tool exists to avoid.
    const e = err as Record<string, unknown>;
    for (const key of [
      'authenticationFailed', 'serverResponseCode', 'responseStatus',
      'response', 'responseText', 'code', 'command',
    ]) {
      if (e[key] !== undefined) console.error(`   ${key}: ${String(e[key])}`);
    }
    console.error(
      '\nThe usual causes, in order:\n' +
      '  1. This is your normal password, not an APP password. Gmail rejects the\n' +
      '     normal one for IMAP outright. Get one at\n' +
      '     https://myaccount.google.com/apppasswords (2-Step Verification must be\n' +
      '     on first, or that page will not offer the option).\n' +
      '  2. The app password was typed with its spaces stripped or a character\n' +
      '     wrong. Paste all 16 characters; the spaces are ignored either way.\n' +
      '  3. The host is wrong. Gmail is imap.gmail.com; GMX is imap.gmx.com.\n' +
      '\nNot a cause: IMAP being "switched off". Google removed that toggle, so IMAP\n' +
      'is always on — the Forwarding and POP/IMAP page now shows only its\n' +
      'sub-settings, with no enable option to miss.',
    );
    process.exit(1);
  }

  console.log('✅ Connected and logged in.\n');

  try {
    const messages = await source.fetch();
    if (messages.length === 0) {
      console.log(
        'No unread Amazon messages in INBOX or Spam.\n\n' +
        'If you expected some:\n' +
        '  • Check they are actually UNREAD — opening one in a webmail client marks\n' +
        '    it read, and this only looks at unread mail.\n' +
        '  • Check the forwarding filter fired at all. A Gmail filter with anything\n' +
        '    in its "To" field matches nothing, since Amazon addresses its mail to\n' +
        '    you, not to the receipts mailbox.\n' +
        '  • Gmail\'s "also apply to matching conversations" does NOT forward old\n' +
        '    mail. Only newly arriving mail is forwarded; hand-forward a few to test.',
      );
      return;
    }

    const inSpam = messages.filter((m) => /spam|junk/i.test(m.mailbox)).length;
    console.log(`Found ${messages.length} unread Amazon message(s).`);
    if (inSpam > 0) {
      // Read anyway, but say so: a spam-flagged receipts mailbox is worth one
      // "never send it to Spam" filter, and the user cannot fix what they cannot see.
      console.log(
        `  ${inSpam} of them are in Spam. They are read regardless, but add a filter\n` +
        '  on this mailbox — from:amazon.com → Never send it to Spam — so Google does\n' +
        '  not start deleting them after 30 days.',
      );
    }
    console.log('');
    let understood = 0;
    let ignored = 0;
    for (const msg of messages) {
      // Same classifier the sync uses, deliberately. This tool's only job is to say
      // what the sync will do, so a second opinion here would be a bug even when it
      // happened to agree.
      const { orders, status } = classifyAmazonEmail(msg.text);
      const date = msg.date.slice(0, 10);
      if (status === 'ignored') {
        // Expected, not a failure: a delivery notice restates no price, so it can
        // never match a charge. Every order produces one.
        ignored += 1;
        console.log(`— ${date} — delivery notice, skipped (no total to match)`);
        console.log('');
        continue;
      }
      if (status === 'unrecognised') {
        // The actionable failure. Print the sender AND enough of the body to see
        // why: a sender that is not one of Amazon's order addresses means the
        // forwarding filter is too broad, while an order address that stopped
        // parsing means Amazon changed the format. Same symptom, opposite fixes.
        console.log(`✗ ${date} — not recognised (from ${msg.from ?? 'unknown'}, in ${msg.mailbox})`);
        console.log('    First lines of the body:');
        for (const line of msg.text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8)) {
          console.log(`      ${line}`);
        }
        console.log('');
        continue;
      }
      understood += 1;
      for (const o of orders) {
        const cats = o.labels.map((l) => {
          const { category, matched } = resolveAmazonCategory(l, {});
          return `${l} → ${category}${matched ? '' : ' (no rule yet — would use the default)'}`;
        });
        console.log(
          `✓ ${date} — order ${o.orderId}, ${o.kind}, ` +
          `$${(o.totalCents / 100).toFixed(2)}, ${o.itemCount} item(s)`,
        );
        for (const c of cats) console.log(`    ${c}`);
      }
      console.log('');
    }

    console.log(
      `${understood}/${messages.length} message(s) understood` +
      `${ignored ? `, ${ignored} delivery notice(s) skipped as expected` : ''}.`,
    );
    if (understood + ignored < messages.length) {
      console.log(
        '\nUnrecognised mail is not necessarily broken. Amazon only puts a category\n' +
        'label on physical-goods order and shipment emails — Prime, Kindle, digital\n' +
        'orders, returns and marketing carry no label and cannot be categorized from\n' +
        'email at all. If the senders above are those, narrow your forwarding filter\n' +
        'so they stop arriving; noise here hides a real format change.',
      );
    }
    console.log(
      '\nNothing was changed: no message was marked read and no order was recorded.\n' +
      'The next sync will read these for real.',
    );
  } finally {
    await source.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`Failed: ${err?.message ?? err}`);
  process.exit(1);
});
