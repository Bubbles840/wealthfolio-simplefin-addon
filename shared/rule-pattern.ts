/**
 * shared/rule-pattern.ts
 *
 * The pattern a category rule is built from — the piece that makes "Make this
 * a rule" learn the MERCHANT instead of memorizing one charge.
 *
 * Banks repeat the payee wording verbatim between charges but append varying
 * reference tokens — dates, confirmation numbers, phone numbers. A rule built
 * from the full description matches exactly one transaction forever; the fix
 * is to trim the trailing junk and keep the stable head.
 *
 * Both pattern builders (this one and the transfer flow's `rulePatternFor` in
 * companion/src/transfer-learning.ts, built from this one since 1.63) return a
 * verbatim substring of the description: Wealthfolio's categorization rules are
 * a case-insensitive `contains` match against the RAW text, so stripping
 * punctuation ("Amazon.com" → "Amazon com") would build a rule that never
 * matches anything, including the very charge it was made from.
 */

/** A trailing token that is reference noise, not merchant identity: no letters
 *  at all (numbers, phone numbers, "#42"), a reference-label word, or a short
 *  uppercase letters-and-digits code ("8ZK1", "41XP" — per-charge references
 *  a bank mints fresh every month). A digit is required in the code form so a
 *  real word ("WA", "SUB") is never mistaken for one. */
const isJunkToken = (token: string): boolean =>
  !/[a-zA-Z]/.test(token)
  || /^(REF|REFERENCE|CONF|CONFIRMATION|ID|NO)[:#]?$/i.test(token)
  || /^(?=.*\d)[A-Z0-9]{3,8}$/.test(token);

/** Tokens kept at most — past this a descriptor is so specific the next
 *  charge would fail to contain it. Matches the transfer flow's cap. */
const MAX_TOKENS = 6;

/** A leading token that is the bank's per-charge reference, not the payee: a
 *  `*`/`#` token with a digit ("*0082", "#4471"), a run of 3+ digits ("4090"),
 *  or a 6+ character code with at least 3 digits ("RT08C248B2E7C8B", "XX9257"). */
const isLeadingReference = (token: string): boolean =>
  /^[*#]\S*\d/.test(token)
  || /^\d{3,}$/.test(token)
  || (/^[A-Za-z0-9]{6,}$/.test(token) && (token.match(/\d/g) ?? []).length >= 3);

/**
 * `text` without the bank's leading reference tokens.
 *
 * Since ~2026-09-22 PNC puts a fresh reference in front of each charge
 * (`*0062 PAYMENT CITI AUTOPAY …` in September, `*0082 …` on Oct 17), so a rule
 * built with the reference in it matched last month's payment never again.
 * Strips every reference token from the front, but never the last token that
 * has a letter: a description that is only a reference keeps it. The result is
 * a verbatim suffix of `text` (same casing, spacing and punctuation), which a
 * `contains` rule needs.
 */
export function stripLeadingReference(text: string): string {
  const tokens: Array<{ start: number; text: string }> = [];
  for (const m of text.matchAll(/\S+/g)) tokens.push({ start: m.index, text: m[0] });
  let lastLettered = -1;
  tokens.forEach((t, i) => { if (/[a-zA-Z]/.test(t.text)) lastLettered = i; });
  let first = 0;
  while (first < lastLettered && isLeadingReference(tokens[first].text)) first += 1;
  return first === 0 ? text : text.slice(tokens[first].start);
}

export function categoryRulePattern(description: string): string {
  const tokens: Array<{ start: number; end: number; text: string }> = [];
  for (const m of description.matchAll(/\S+/g)) {
    tokens.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  let last = tokens.length - 1;
  while (last >= 0 && isJunkToken(tokens[last].text)) last -= 1;
  // All junk (a bare reference number): the description itself is the only
  // possible pattern, and a one-charge rule beats no button at all.
  if (last < 0) return description;
  // The six-token cap counts a leading reference too, so a key stored before
  // references were stripped ("*8712 PAYMENT LOUISVILLE GAS & ACH") normalizes
  // to exactly the key the same charge gets today.
  let end = Math.min(last, MAX_TOKENS - 1);
  // The cap can land on a junk token ("… FIVE 1234 SEVEN"); walk back off it so
  // the pattern never ends on one, which also keeps this idempotent.
  while (end > 0 && isJunkToken(tokens[end].text)) end -= 1;
  return stripLeadingReference(description.slice(tokens[0].start, tokens[end].end));
}

/** The marks the sync appends to a bank description (a Venmo note, an Amazon label). */
const ENRICHMENT_MARKS = [' · Venmo: ', ' · Amazon: '];

/** A stored description's own bank words: before the Venmo note or the Amazon
 *  label the sync appends. Transaction rules match the bank's text, before
 *  either is added. */
export function bankWords(description: string): string {
  const cut = ENRICHMENT_MARKS.map((m) => description.indexOf(m)).filter((i) => i >= 0);
  return cut.length ? description.slice(0, Math.min(...cut)) : description;
}

/** The pattern "Make every … deposit a payback" (W10) is built from: the
 *  bank's words, without a leading reference (`stripLeadingReference`: "*1234",
 *  "4090", …) and a trailing " ON MM/DD" with whatever follows it
 *  ("REF # …"), then trimmed as a category rule's is. */
export function paybackRulePattern(description: string): string {
  const words = stripLeadingReference(bankWords(description).trim())
    .replace(/\s+ON\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s.*)?$/i, '');
  return categoryRulePattern(words);
}
