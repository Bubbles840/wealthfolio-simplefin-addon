/**
 * shared/amazon-sample.ts
 *
 * A copy of an Amazon email the parser could not read, safe to show and paste.
 *
 * WHY THIS EXISTS. When Amazon changes its format the failing text never left
 * the companion: diagnosing the 2026-10 break took a shell on the server and a
 * pasted terminal dump. The companion now keeps these, the Amazon card shows
 * them, and its Copy button produces a test fixture
 * (`shared/__fixtures__/amazon-emails/`) directly.
 *
 * Redaction is aimed at what a receipt actually carries about a person: the
 * delivery line, email addresses and the names beside them, a greeting, card
 * digits, and the query strings on links (tracking and shipment codes). Order
 * numbers stay — the parser needs them, and on their own they open nothing.
 * Host-agnostic: the companion builds samples, the addon formats them.
 */
import type { AmazonMailParts } from './amazon.js';
import type { AmazonMailSample } from './status-keys.js';

export const AMAZON_SAMPLE_LIMIT = 5;
const MAX_LINES = 80;
const MAX_CHARS = 4000;

/** Amazon's invisible direction marks (see `BIDI_CONTROLS` in ./amazon.ts),
 *  plus U+034F from its preheaders. Stripped first: a delivery line wrapped in
 *  them would otherwise slip past every pattern below. */
const INVISIBLE_MARKS = /[‪-‮⁦-⁩‎‏͏]/g;
/** A forwarded block's `From:`/`To:` line names the forwarder — display name
 *  and all — unless it is Amazon's own, which the forwarded-mail check needs. */
const ADDRESS_LINE = /^(\s*(?:From|To|Cc|Reply-To):[ \t]*)(?![^\n]*@amazon\.)[^\n]*$/gim;
const EMAIL = /[\w.+-]+@(?:[\w-]+\.)+[\w-]+/g;
const AMAZON_ADDRESS = /@amazon\.[a-z.]+$/i;
/** `Nicholas - LOUISVILLE, KY` — Amazon's "ship to" line, in any case and with
 *  an optional ZIP. Replaced with the stand-in every fixture already uses, so
 *  a sample pastes in unchanged. */
const DELIVERY_LINE = /^(\s*)\S[^\n]{0,60}? - [^\n,]{2,40}, [A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?\s*$/gm;
/** `Hello Nicholas,` — a refund notice is expected to open with one. */
const GREETING = /^(\s*(?:Hello|Hi|Dear)\s+)[^,\n]{1,40},/gim;
/** `Visa ending in 4321`. */
const CARD_DIGITS = /\b(ending in\s+)\d{4}\b/gi;
/** Stops at `)` and `]` so a markdown link keeps its closing bracket. */
const URL_QUERY = /(https?:\/\/[^\s?#)\]]+)[?#][^\s)\]]*/g;

/**
 * What a receipt says about the person, removed. Not a guarantee — a layout
 * nobody has seen can carry something no pattern here knows — which is why the
 * card asks for a look before anything is posted publicly.
 */
export function redactAmazonText(text: string): string {
  return text
    .replace(INVISIBLE_MARKS, '')
    .replace(ADDRESS_LINE, '$1<email>')
    .replace(EMAIL, (addr) => (AMAZON_ADDRESS.test(addr) ? addr : '<email>'))
    .replace(DELIVERY_LINE, '$1Jordan - SPRINGFIELD, IL')
    .replace(GREETING, '$1Jordan,')
    .replace(CARD_DIGITS, '$10000')
    .replace(URL_QUERY, '$1');
}

function trimCopy(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(0, MAX_LINES)
    .join('\n')
    .slice(0, MAX_CHARS);
}

export function toAmazonMailSample(msg: { date: string; from?: string; parts: AmazonMailParts }): AmazonMailSample {
  const copy = (t: string | null | undefined) => trimCopy(redactAmazonText(t ?? ''));
  return {
    at: msg.date,
    ...(msg.from ? { from: AMAZON_ADDRESS.test(msg.from) ? msg.from : '<email>' } : {}),
    subject: redactAmazonText(msg.parts.subject ?? ''),
    plain: copy(msg.parts.plain),
    html: copy(msg.parts.html),
  };
}

/** The samples as test fixtures — the shape `shared/amazon-fixtures.test.ts`
 *  loads, minus the `expect` a fix adds. Copies are line arrays so a fixture
 *  diffs line by line. */
export function amazonSamplesAsFixtureText(samples: readonly AmazonMailSample[]): string {
  return JSON.stringify(samples.map((s) => ({
    note: `Captured ${s.at.slice(0, 10)} from ${s.from ?? 'an unknown sender'}`,
    subject: s.subject,
    plain: s.plain ? s.plain.split('\n') : [],
    html: s.html ? s.html.split('\n') : [],
  })), null, 2);
}
