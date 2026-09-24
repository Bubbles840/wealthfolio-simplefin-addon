/**
 * companion/tools/amazon-unread.mjs — show the Amazon emails the parser could
 * not read. Read-only: nothing is marked read, moved or written.
 *
 *   … | docker exec -i simplefin-sync node --input-type=module
 *
 * The Amazon card says "N recent emails could not be read" and leaves them
 * unread in the mailbox, which is the right thing for the ledger and useless
 * for a diagnosis: the text that failed to parse never leaves the companion.
 * This prints it, as the parser sees it (subject, plain text and HTML text
 * merged by `buildAmazonMailText`), so a new wording can be turned into a test.
 *
 * Addresses and names in the body are the user's own; the output goes to their
 * terminal only.
 */
const { WealthfolioClient } = await import('/app/dist/companion/src/wealthfolio.js');
const { createImapSource } = await import('/app/dist/companion/src/amazon-mail.js');
const { classifyAmazonEmail } = await import('/app/dist/shared/amazon.js');

const client = new WealthfolioClient(process.env.WEALTHFOLIO_API_URL);
if (process.env.WEALTHFOLIO_API_KEY) client.token = process.env.WEALTHFOLIO_API_KEY;
else await client.login(process.env.WEALTHFOLIO_PASSWORD);

const raw = await client.getAddonSecret('simplefin-sync', 'amazon_config');
const cfg = raw ? JSON.parse(raw) : null;
if (!cfg?.host || !cfg?.user || !cfg?.password) {
  console.log('Amazon mail is not configured.');
  process.exit(0);
}

const source = await createImapSource(cfg);
const messages = await source.fetch();
let shown = 0;
for (const msg of messages) {
  const { status } = classifyAmazonEmail(msg.text);
  if (status !== 'unrecognised') continue;
  shown++;
  console.log(`\n══════ ${msg.date} · from ${msg.from ?? 'unknown'} · ${msg.mailbox} ══════`);
  const lines = msg.text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  for (const line of lines.slice(0, 60)) console.log(`  ${line.slice(0, 160)}`);
  if (lines.length > 60) console.log(`  … ${lines.length - 60} more line(s)`);
}
console.log(`\n${messages.length} unread Amazon email(s); ${shown} the parser could not read.`);
process.exit(0);
