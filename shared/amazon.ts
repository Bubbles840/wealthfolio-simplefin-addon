/**
 * shared/amazon.ts
 *
 * Reading Amazon's order emails, and turning their category label into one of
 * Wealthfolio's own categories.
 *
 * WHY THIS IS ONLY ABOUT CATEGORIES. Until 2026-07-08 these emails carried item
 * names, quantities and unit prices, and the original goal was to split one
 * Amazon charge into a row per item. Amazon removed all of it: the body now has a
 * category label, a total, an item count and a link, in both the HTML and
 * plain-text parts. Splitting needs per-item prices, so it is not hard now — it is
 * impossible from this source. What is left is enough to categorize the charge,
 * which needs no splitting and therefore never touches reconciliation.
 *
 * Host-agnostic on purpose (no IMAP, no fetch, no Node APIs): the companion reads
 * the mailbox, but the addon shows the label→category mapping, so both import this.
 */

/** One order as an email describes it. */
export interface AmazonOrderRecord {
  /** `113-0728509-1925031`. */
  orderId: string;
  kind: 'ordered' | 'shipped' | 'delivered';
  /** Integer cents — the figure to match a bank charge against. */
  totalCents: number;
  itemCount: number;
  /** One entry, or several for a mixed order (`Home Improvement and Skincare`). */
  labels: string[];
  /**
   * True when Amazon withheld part of the category list.
   *
   * A three-plus-category order reads `6 Home Improvement, Bath, and other items`
   * — `other` is not a category, it is Amazon declining to name the rest. Without
   * this flag two known labels would look like the complete set, and a caller
   * would confidently categorize an order it can only partly see.
   */
  partial?: boolean;
}

/**
 * Amazon wraps parts of these emails in Unicode BIDI controls — U+202B before the
 * order number, U+2066/U+2069 around the item count. They are invisible in a
 * terminal and in a screenshot, so a regex written from either will mysteriously
 * fail against the real message. Stripped before anything else looks at the text.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩‎‏]/g;

const ORDER_ID = /Order\s*#\s*(\d{3}-\d{7}-\d{7})/;

/**
 * Amazon writes the category line two different ways, and they are not variations
 * on one shape — they need separate patterns.
 *
 *   SUFFIX form, one or two categories:
 *     1 Lawn & Garden item
 *     2 Home Improvement and Skincare items
 *
 *   BREAKDOWN form, three or more:
 *     6 items: 1 Home Improvement, 1 Bath, and 4 others
 *
 * The breakdown form ends with "others", not "items", so the suffix pattern misses
 * it completely and the whole order was silently dropped. It also puts the ORDER's
 * item count first and gives each category its own count — so reading the leading
 * number as the first category's count would be wrong too.
 *
 * Note the subject line is a THIRD wording ("6 Home Improvement, Bath, and other
 * items"). Only the body is parsed, so it does not matter — worth recording because
 * writing a pattern from the subject produces something that never matches.
 */
const ITEM_BREAKDOWN = /^\s*(\d+)\s+items?\s*:\s*(.+?)\s*$/im;
const ITEM_SUFFIX = /^\s*(\d+)\s+(.+?)\s+items?\s*$/im;
/** `Grand Total:\t$21.18` on a confirmation, `Total\t$10.55` on a shipment. */
const TOTAL = /(?:Grand\s+)?Total:?\s*\$\s*([\d,]+\.\d{2})/i;

function detectKind(text: string): AmazonOrderRecord['kind'] | null {
  if (/your package was shipped|has shipped|Shipped:/i.test(text)) return 'shipped';
  if (/was delivered|Delivered:/i.test(text)) return 'delivered';
  if (/thanks for your order|Ordered:|order confirmation/i.test(text)) return 'ordered';
  return null;
}

/**
 * Split a label blob into its categories.
 *
 * Amazon uses THREE forms, and only the first two were obvious from a single
 * sample:
 *   1 Lawn & Garden item
 *   2 Lawn & Garden and Nutrition & Wellness items
 *   6 Home Improvement, Bath, and other items      ← three or more
 *
 * So both "," and " and " separate. Handling only " and " turned the third form
 * into the garbage label `Home Improvement, Bath,` plus a bogus `other`.
 *
 * "&" does NOT separate. `Lawn & Garden` is one label, and splitting on the
 * ampersand would make every garden order look mixed and stop it being
 * auto-categorized — the exact failure this feature exists to avoid.
 *
 * `other` is dropped and reported: it is Amazon declining to name the remaining
 * categories, not a category called "other".
 */
function splitLabels(raw: string, stripCounts = false): { labels: string[]; partial: boolean } {
  const parts = raw
    .split(/\s*,\s*|\s+and\s+/i)
    // Amazon writes an Oxford comma — `1 Home Improvement, 1 Bath, and 4 others` —
    // so the comma consumes the separator and the final entry keeps its leading
    // "and". Without stripping it the last category of every 3+ order is mis-read
    // ("and 4 others", "and Skincare").
    .map((s) => s.trim().replace(/^and\s+/i, '').trim())
    // In the breakdown form each entry is prefixed with its own item count
    // ("1 Home Improvement"). Dropped rather than kept: per-category counts cannot
    // apportion the total — a 1-item camera and a 4-item pack of batteries tell you
    // nothing about which held the money — so recording them would invite exactly
    // the guess this module refuses to make.
    .map((s) => (stripCounts ? s.replace(/^\d+\s+/, '').trim() : s))
    .filter(Boolean);
  const labels = parts.filter((p) => !/^others?$/i.test(p));
  return { labels, partial: labels.length !== parts.length };
}

/**
 * True when this is a recognisable Amazon notice whose TYPE never carries a total.
 *
 * A delivery notice names the categories but restates no price — Amazon already
 * billed on shipment — so it can never be matched to a charge. That is a fact about
 * the message, not a parse failure, and the difference matters operationally:
 * anything treated as "unrecognised" is deliberately left unread so a real format
 * change stays visible. Delivery notices arrive for every order, so classing them
 * as failures would leave the mailbox filling with permanently-unread mail, re-read
 * on every sync, and would bury the one signal that says the parser broke.
 *
 * Deliberately narrow, on BOTH conditions.
 *
 * The wording list excludes "arriving" even though delivery notices say it, because
 * ORDER CONFIRMATIONS say it too — the live sample reads "Arriving Monday" a few
 * lines above its Grand Total. Matching on that would mean a confirmation whose
 * total stopped parsing got quietly filed as an ignorable notice, which is the one
 * outcome this module must never produce: a real format change made invisible.
 *
 * And the absence of a total is required, not assumed. An email that starts carrying
 * one again stops being ignorable, which is the safe direction if Amazon changes its
 * mind about what a delivery notice contains.
 */
export function isAmazonNoticeWithoutTotal(body: string): boolean {
  const text = (body ?? '').replace(BIDI_CONTROLS, '');
  if (!/was delivered|Delivered:|out for delivery/i.test(text)) return false;
  return !TOTAL.test(text);
}

/**
 * Every order an email describes.
 *
 * Returns an ARRAY because one message legitimately covers several orders — the
 * live sample carried two, each with its own order number, label and grand total.
 *
 * Unrecognised text yields `[]` rather than a partial guess. Amazon changed this
 * format five weeks ago and may again; a wrong category on real money is invisible
 * (it looks exactly like a right one) whereas a missing one is merely absent, so
 * absent is the only acceptable failure direction.
 */
export function parseAmazonEmail(body: string): AmazonOrderRecord[] {
  const text = (body ?? '').replace(BIDI_CONTROLS, '');
  const kind = detectKind(text);
  if (!kind) return [];

  // One message can hold several orders, each introduced by its own `Order #`.
  // Slicing on that marker keeps each order's label and total with the right id;
  // a single global regex pass would happily pair order A's id with order B's
  // total.
  const parts: string[] = [];
  const marker = /Order\s*#/g;
  const starts: number[] = [];
  for (let m = marker.exec(text); m; m = marker.exec(text)) starts.push(m.index);
  if (starts.length === 0) return [];
  for (let i = 0; i < starts.length; i++) {
    parts.push(text.slice(starts[i], starts[i + 1] ?? text.length));
  }

  const records: AmazonOrderRecord[] = [];
  for (const part of parts) {
    const id = ORDER_ID.exec(part)?.[1];
    // Breakdown FIRST. `6 items: 1 Home Improvement, …` also satisfies nothing in
    // the suffix pattern, but checking the more specific shape first keeps the two
    // from ever competing as Amazon's wording drifts again.
    const breakdown = ITEM_BREAKDOWN.exec(part);
    const item = breakdown ?? ITEM_SUFFIX.exec(part);
    const total = TOTAL.exec(part)?.[1];
    // All three or nothing: an order with no total cannot be matched to a charge,
    // and half a record would sit in the ledger forever pretending to be usable.
    if (!id || !item || !total) continue;
    const { labels, partial } = splitLabels(item[2], !!breakdown);
    if (labels.length === 0) continue;
    records.push({
      orderId: id,
      kind,
      totalCents: Math.round(parseFloat(total.replace(/,/g, '')) * 100),
      itemCount: Number(item[1]) || 1,
      labels,
      ...(partial ? { partial: true } : {}),
    });
  }
  return records;
}

/** What a message turned out to be. */
export type AmazonEmailStatus =
  /** Yielded at least one usable order. */
  | 'orders'
  /** Recognisably Amazon, but of a kind that carries no matchable total. */
  | 'ignored'
  /** Should have parsed and did not — a possible format change. */
  | 'unrecognised';

export interface AmazonEmailClassification {
  orders: AmazonOrderRecord[];
  status: AmazonEmailStatus;
}

/**
 * THE single definition of what a message is.
 *
 * Exists because the poll and the `amazon-check` diagnostic each classified
 * messages independently, and drifted the moment one of them learned about
 * delivery notices: the check reported a message as an unrecognised failure while
 * the poll would have skipped it as expected. A diagnostic whose whole purpose is
 * "tell me what the sync will do" is worse than useless when it disagrees with the
 * sync — it sends you looking for a bug that is not there.
 *
 * Anything that needs to know what a message is calls this, so there is exactly one
 * answer.
 */
export function classifyAmazonEmail(body: string): AmazonEmailClassification {
  const orders = parseAmazonEmail(body);
  if (orders.length > 0) return { orders, status: 'orders' };
  return { orders, status: isAmazonNoticeWithoutTotal(body) ? 'ignored' : 'unrecognised' };
}

/** One label→category rule. `test` is matched against the lowercased label. */
export interface AmazonLabelRule {
  test: RegExp;
  category: string;
}

/**
 * PATTERNS, not a lookup table.
 *
 * The observed labels include mid-level merchandising categories, not just
 * top-level departments — `Baking` sits under Grocery, `Skincare` under Beauty —
 * so the real set is likely hundreds long, Amazon extends it at will, and nobody
 * has published it. An exact-match table would be permanently incomplete and would
 * need an edit every time Amazon invented a word.
 *
 * The labels are plain English, so matching their TEXT generalizes: a label
 * invented next month like `Vitamins & Supplements` files itself correctly with no
 * change here. Fifteen patterns cover more ground than two hundred exact entries.
 *
 * Ordered most specific first — `pharmacy` must beat a broad `health`, and
 * `home improvement` must beat `home`.
 */
export const DEFAULT_AMAZON_LABEL_RULES: AmazonLabelRule[] = [
  { test: /nutrition|wellness|vitamin|supplement|pharmac|medic|first aid/, category: 'Health & Wellness' },
  { test: /skincare|beauty|hair|cosmetic|grooming|fragrance|makeup/, category: 'Personal Care' },
  // BEFORE groceries: `Dog Food` matches a bare `food` and pet food is not
  // groceries. Specific-before-general is load-bearing throughout this list.
  { test: /\bpet\b|pets\b|\bdog\b|\bcat\b|aquarium|litter/, category: 'Pet Care' },
  { test: /grocer|baking|snack|beverage|coffee|\btea\b|pantry|essentials|food/, category: 'Groceries' },
  { test: /lawn|garden|patio|outdoor|tool|home improvement|hardware|appliance/, category: 'Housing' },
  { test: /electronic|computer|phone|audio|camera|video game|headphone|accessor/, category: 'Electronics' },
  { test: /book|kindle|music|movie|toy|game|hobby|craft|sport/, category: 'Entertainment' },
  { test: /clothing|apparel|shoe|jewel|watch|luggage|handbag/, category: 'Shopping' },
  { test: /office|school|stationer|paper/, category: 'Bills & Utilities' },
  { test: /baby|infant|diaper|nursery/, category: 'Shopping' },
  { test: /automotive|motorcycle|car care|tire/, category: 'Transportation' },
  { test: /kitchen|furniture|bedding|bath|decor|storage|cleaning|laundry|household/, category: 'Housing' },
];

/**
 * The Wealthfolio category for an Amazon label.
 *
 * `strict` reports a miss as `null` instead of the fallback, so a caller can
 * announce a label it has never seen — the user asked never to find things sitting
 * uncategorized, which means an unmatched label must be BOTH filed somewhere and
 * visible, not one or the other.
 */
export function mapAmazonLabel(
  label: string,
  rules: AmazonLabelRule[],
  fallback: string,
  strict = false,
): string | null {
  const clean = (label ?? '').trim().toLowerCase();
  for (const rule of rules) {
    if (rule.test.test(clean)) return rule.category;
  }
  return strict ? null : fallback;
}
