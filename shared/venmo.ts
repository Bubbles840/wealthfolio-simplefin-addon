/**
 * shared/venmo.ts
 *
 * Reading Venmo's payment emails (project 3, "Less filing"): which way the
 * money went, how much, the other person and the note — so a bank row that
 * says only `VENMO PAYMENT 1023` can carry what the payment was for.
 *
 * UNVERIFIED FORMATS. No real Venmo email has been seen by this code. The
 * patterns are built from the wording Venmo documents for its notifications —
 * "You paid <name> $X", "<name> paid you $X", a completed charge request, and a
 * transfer to your bank — and each fixture in ./venmo.test.ts says so. Anything
 * that looks like a payment and does not read is left unread and kept as a
 * sample, like Amazon's, so the first real email that breaks a pattern is
 * visible rather than silently noteless.
 *
 * Host-agnostic, like ./amazon.ts: the companion reads the mailbox, both
 * syncers read the ledger (./venmo-ledger.ts). Bank and user text stays RAW.
 */
import type { AmazonMailParts } from './amazon.js';
import { redactAmazonText } from './amazon-sample.js';
import type { AmazonMailSample } from './status-keys.js';

/** `out`: you paid. `in`: you were paid, or moved money to your bank. */
export type VenmoDirection = 'out' | 'in';
export type VenmoKind = 'payment' | 'request' | 'bank-transfer';

/** One payment as an email describes it. */
export interface VenmoRecord {
  direction: VenmoDirection;
  kind: VenmoKind;
  /** Integer cents — the figure a bank row must equal exactly. */
  amountCents: number;
  /** The other person, raw; null for a transfer to your bank. */
  counterparty: string | null;
  /** What the bank row gets: the payment's note, or `VENMO_BANK_TRANSFER_NOTE`.
   *  Newlines are spaces and it is at most `VENMO_NOTE_MAX` characters. Raw. */
  note: string;
  /** Venmo's own payment id, when the email shows one. */
  paymentId?: string;
}

/** What a message turned out to be. */
export type VenmoEmailStatus =
  /** Read: `record` is set. */
  | 'payment'
  /** Venmo, but not money that moved (a security code, a request, marketing). */
  | 'ignored'
  /** Looks like a payment and did not read — a possible format change. */
  | 'unrecognised';

export interface VenmoEmailClassification {
  status: VenmoEmailStatus;
  record?: VenmoRecord;
}

export const VENMO_NOTE_MAX = 60;
/** The note a transfer to your bank carries: it has no note of its own. */
export const VENMO_BANK_TRANSFER_NOTE = 'Transfer to your bank';

/** Whether a message came from Venmo — by sender, or by the `From:` line of a
 *  message forwarded by hand (Gmail does not forward old mail; see
 *  `isAmazonMessage`). ADDRESS CONTRACT: `from` is a BARE address
 *  (`venmo@venmo.com`, never `Venmo <venmo@venmo.com>`); the caller (the mail
 *  adapter) extracts it. In a forwarded body the Venmo address must be the one
 *  in the angle brackets, or the only address on the `From:` line, and must end
 *  there (`venmo.com.evil.com` is not Venmo). */
export function isVenmoMessage(from: string | undefined, body: string): boolean {
  if (from && /^[^\s<>@,"]+@venmo\.com$/i.test(from.trim())) return true;
  return /^[ \t]*From:[ \t]*(?:(?:[^<>@\r\n,"]*|"[^"<>\r\n]*"[ \t]*)<[^<>@\s,"]+@venmo\.com>|[^<>@\s,"]+@venmo\.com)[ \t]*$/im.test(body);
}

/** Whitespace to single spaces, control and format characters (NUL, zero-width,
 *  bidi overrides) removed, trimmed. */
const tidy = (raw: string) => raw.replace(/\s/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/ +/g, ' ').trim();

/** Every run of whitespace a single space, then at most `VENMO_NOTE_MAX`
 *  characters (code points, so an emoji is never cut in half), `…` marking a cut. */
export function clipVenmoNote(raw: string): string {
  const flat = tidy(raw);
  const chars = [...flat];
  return chars.length <= VENMO_NOTE_MAX ? flat : `${chars.slice(0, VENMO_NOTE_MAX - 1).join('').trimEnd()}…`;
}

const MONEY = String.raw`\$\s?([\d,]+\.\d{2})`;
const cents = (s: string) => Math.round(parseFloat(s.replace(/,/g, '')) * 100);

interface Head { re: RegExp; direction: VenmoDirection; kind: VenmoKind }

/** A head line with its amount, in the subject or the body. Requests first:
 *  "You paid Jane's $25.00 request" must not read as a payment to "Jane's". */
const HEADS: Head[] = [
  { re: new RegExp(`^You (?:paid|completed) (.+?)['’]s ${MONEY} (?:charge )?request$`, 'i'), direction: 'out', kind: 'request' },
  { re: new RegExp(`^(.+?) (?:paid|completed) your ${MONEY} (?:charge )?request$`, 'i'), direction: 'in', kind: 'request' },
  { re: new RegExp(`^You paid (.+?) ${MONEY}$`, 'i'), direction: 'out', kind: 'payment' },
  { re: new RegExp(`^(.+?) paid you ${MONEY}$`, 'i'), direction: 'in', kind: 'payment' },
];

/** A head line without its amount; the amount is the next line of the body. */
const NAME_HEADS: Head[] = [
  { re: /^You (?:paid|completed) (.+?)['’]s (?:charge )?request$/i, direction: 'out', kind: 'request' },
  { re: /^(.+?) (?:paid|completed) your (?:charge )?request$/i, direction: 'in', kind: 'request' },
  { re: /^You paid (.+)$/i, direction: 'out', kind: 'payment' },
  { re: /^(.+?) paid you$/i, direction: 'in', kind: 'payment' },
];

/** `$25.00`, `+ $25.00`, `- $1,200.00` alone on a line. */
const AMOUNT_LINE = new RegExp(`^[-+−]?\\s*${MONEY}$`);
const ANY_AMOUNT = new RegExp(MONEY);
const BANK_TRANSFER = /\btransfer(?:red)?\b.*\bto your bank\b|\bbank transfer\b/i;
/** A transfer line that carries its own amount: "transferred $X to your bank",
 *  "Your $X transfer to your bank". A figure elsewhere is never the amount. */
const TRANSFER_AMOUNT: RegExp[] = [
  new RegExp(`\\btransfer(?:red)?\\s+${MONEY}\\s+to your bank\\b`, 'i'),
  new RegExp(`${MONEY}\\s+(?:bank\\s+)?transfer\\b[^.]*?\\bto your bank\\b`, 'i'),
];
const transferCents = (line: string): number | null => {
  for (const re of TRANSFER_AMOUNT) {
    const m = re.exec(line);
    if (m) return cents(m[1]);
  }
  return null;
};
/** Failure wording that counts anywhere in a transfer message. */
const NOT_COMPLETED = /\b(?:could not|couldn't|can't|cannot|was not|were not|wasn't|not be) (?:be )?completed\b/i;
const TRANSFER_FAILED = /\b(?:fail(?:ed|s|ure)?|cancel(?:l?ed)?|declined|returned|unsuccessful|reversed|rejected|unable)\b/i;
const LOOKS_LIKE_PAYMENT = /\b(?:paid|completed|transfer(?:red)?)\b/i;
const PAYMENT_ID = /\b(?:Payment|Transaction) ID:?\s*#?\s*(\d{6,})/i;
/** `Fwd: `, `FW: `, `Re: ` — however many. */
const REPLY_PREFIX = /^(?:\s*(?:re|fwd?)\s*:\s*)+/i;

/** Lines around a payment that are never its note. */
const NOT_A_NOTE: RegExp[] = [
  AMOUNT_LINE,
  /^(?:see|view) (?:transaction|payment|details|in app)\b/i,
  /^(?:like|comment)(?:\s*[·|]\s*(?:like|comment))?$/i,
  /^(?:transfer date|payment id|transaction id|payment method|funding source|completed via|money (?:credited|debited))\b/i,
  /^(?:private|friends|public|venmo|help center)$/i,
  /^(?:from|to|date|subject|sent|cc):/i,
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}\b/i,
  /^[-–—_=·•*|\s]+$/,
  /^(?:[Hh]i|[Hh]ello|[Hh]ey|[Dd]ear)\s+[A-Z][\w'’-]*[,:]$/,
  /^thank(?:s| you) for (?:using|choosing) venmo\b/i,
  /^(?:thanks|thank you)!?$/i,
  /venmo is a service of/i,
  /^on .+ wrote:?$/i,
  /unsubscribe|^privacy\b|^terms of\b|^legal\b|^manage (?:your )?(?:notification|email)/i,
  /©|\(c\)\s*\d{4}|all rights reserved/i,
];

const isNote = (line: string) => line !== '' && !NOT_A_NOTE.some((re) => re.test(line));
const unquote = (s: string) => s.replace(/^["“”']+|["“”']+$/g, '').trim();
const linesOf = (text: string | null | undefined) => (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function matchHead(line: string, heads: Head[]): { head: Head; m: RegExpExecArray } | null {
  for (const head of heads) {
    const m = head.re.exec(line);
    if (m) return { head, m };
  }
  return null;
}

/**
 * The note: the first line after the payment's amount that is not boilerplate,
 * within a few lines of it. The anchor is a line holding exactly the amount, or
 * failing that the head line itself. No anchor, no note — a guess would put the
 * wrong words on a real transaction.
 */
function noteAfter(lines: string[], amountCents: number): string {
  let anchor = lines.findIndex((l) => {
    const m = AMOUNT_LINE.exec(l);
    return !!m && cents(m[1]) === amountCents;
  });
  if (anchor === -1) anchor = lines.findIndex((l) => matchHead(l, HEADS) !== null);
  if (anchor === -1) return '';
  const after = lines.slice(anchor + 1, anchor + 7);
  const marker = after.findIndex((l) => /^(?:see|view) (?:transaction|payment|details|in app)\b/i.test(l));
  for (const line of marker === -1 ? after : after.slice(0, marker)) {
    if (isNote(line)) return clipVenmoNote(unquote(line));
  }
  return '';
}

/** The head from the body: a line with its amount, or a name line with the
 *  amount alone on the next line. */
function headFromBody(lines: string[]): { direction: VenmoDirection; kind: VenmoKind; name: string; amountCents: number } | null {
  for (let i = 0; i < lines.length; i += 1) {
    const full = matchHead(lines[i], HEADS);
    if (full) return { ...full.head, name: tidy(full.m[1]), amountCents: cents(full.m[2]) };
    const named = matchHead(lines[i], NAME_HEADS);
    const next = named ? AMOUNT_LINE.exec(lines[i + 1] ?? '') : null;
    if (named && next) return { ...named.head, name: tidy(named.m[1]), amountCents: cents(next[1]) };
  }
  return null;
}

/**
 * THE single definition of what a Venmo message is (the poll and anything
 * diagnostic ask this, as `classifyAmazonEmail` is for Amazon).
 *
 * The subject is read first (minus `Fwd:`), then each copy of the body. A
 * payment needs its note: without one there is nothing to add to the bank row,
 * and a message that names a payment but shows no note is unrecognised, not
 * ignored, so it stays unread and becomes a sample.
 */
export function classifyVenmoEmail(parts: AmazonMailParts): VenmoEmailClassification {
  const subject = (parts.subject ?? '').replace(REPLY_PREFIX, '').trim();
  const copies = [linesOf(parts.plain), linesOf(parts.html)].filter((c) => c.length > 0);
  const all = [subject, ...copies.flat()].join('\n');
  const paymentId = PAYMENT_ID.exec(all)?.[1];
  const withId = (r: VenmoRecord): VenmoRecord => (paymentId ? { ...r, paymentId } : r);

  const fromSubject = matchHead(subject, HEADS);
  const head = fromSubject
    ? { ...fromSubject.head, name: tidy(fromSubject.m[1]), amountCents: cents(fromSubject.m[2]) }
    : null;
  const found = head ?? (BANK_TRANSFER.test(subject) ? null : copies.map(headFromBody).find((h) => h !== null) ?? null);
  if (found) {
    for (const lines of copies) {
      const note = noteAfter(lines, found.amountCents);
      if (note) {
        return {
          status: 'payment',
          record: withId({ direction: found.direction, kind: found.kind, amountCents: found.amountCents, counterparty: found.name, note }),
        };
      }
    }
    return { status: 'unrecognised' };
  }

  const hit = [subject, ...copies.flat()].map((line) => ({ line, c: transferCents(line) })).find((x) => x.c !== null);
  if (hit && hit.c !== null) {
    if (TRANSFER_FAILED.test(subject) || TRANSFER_FAILED.test(hit.line) || NOT_COMPLETED.test(all)) return { status: 'ignored' };
    return {
      status: 'payment',
      record: withId({ direction: 'in', kind: 'bank-transfer', amountCents: hit.c, counterparty: null, note: VENMO_BANK_TRANSFER_NOTE }),
    };
  }
  if (BANK_TRANSFER.test(subject)) return { status: TRANSFER_FAILED.test(subject) || NOT_COMPLETED.test(all) ? 'ignored' : 'unrecognised' };

  return LOOKS_LIKE_PAYMENT.test(subject) && ANY_AMOUNT.test(all) ? { status: 'unrecognised' } : { status: 'ignored' };
}

/** A copy of an unreadable Venmo email, safe to keep: the same redaction as
 *  Amazon's samples (addresses, greeting, card digits, link codes), keeping
 *  Venmo's own sender. Names in a payment line stay — the parser needs them. */
export function toVenmoMailSample(msg: { date: string; from?: string; parts: AmazonMailParts }): AmazonMailSample {
  const copy = (t: string | null | undefined) => redactAmazonText(t ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(0, 80).join('\n').slice(0, 4000);
  return {
    at: msg.date,
    ...(msg.from ? { from: /@venmo\.com$/i.test(msg.from) ? msg.from : '<email>' } : {}),
    subject: redactAmazonText(msg.parts.subject ?? ''),
    plain: copy(msg.parts.plain),
    html: copy(msg.parts.html),
  };
}
