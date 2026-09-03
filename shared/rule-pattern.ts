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
 * Unlike the transfer flow's `rulePatternFor` (companion/src/
 * transfer-learning.ts), this MUST return a verbatim substring of the
 * description: Wealthfolio's categorization rules are a `contains` match
 * against the RAW text, so stripping punctuation ("Amazon.com" → "Amazon
 * com") would build a rule that never matches anything, including the very
 * charge it was made from.
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
  const end = Math.min(last, MAX_TOKENS - 1);
  return description.slice(tokens[0].start, tokens[end].end);
}
