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
 * delivery line, email addresses, and the query strings on links (tracking and
 * shipment codes). Order numbers stay — the parser needs them, and on their own
 * they open nothing. Host-agnostic: the companion builds samples, the addon
 * formats them.
 */
import type { AmazonMailParts } from './amazon.js';
import type { AmazonMailSample } from './status-keys.js';

export const AMAZON_SAMPLE_LIMIT = 5;
const MAX_LINES = 80;
const MAX_CHARS = 4000;

const EMAIL = /[\w.+-]+@(?:[\w-]+\.)+[\w-]+/g;
const AMAZON_ADDRESS = /@amazon\.[a-z.]+$/i;
/** `Alex - LOUISVILLE, KY` — Amazon's "ship to" line. Replaced with the
 *  stand-in every fixture already uses, so a sample pastes in unchanged. */
const DELIVERY_LINE = /^(\s*)\S[^\n]{0,60}? - [A-Z][A-Z .'-]*, [A-Z]{2}\s*$/gm;
/** Stops at `)` and `]` so a markdown link keeps its closing bracket. */
const URL_QUERY = /(https?:\/\/[^\s?#)\]]+)[?#][^\s)\]]*/g;

export function redactAmazonText(text: string): string {
  return text
    .replace(EMAIL, (addr) => (AMAZON_ADDRESS.test(addr) ? addr : '<email>'))
    .replace(DELIVERY_LINE, '$1Jordan - SPRINGFIELD, IL')
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
