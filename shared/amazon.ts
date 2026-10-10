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
const ORDER_ID_ALL = new RegExp(ORDER_ID.source, 'g');

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
/**
 * `Grand Total:\t$21.18` on a confirmation, `Total\t$10.55` on a shipment — the
 * `$` form used until ~Aug 2026. Since then Amazon also writes the amount with no
 * dollar sign and a `USD` suffix instead, on the NEXT line: `Grand Total:` then
 * `4.23 USD`. The `\s*` already spans the newline, so only the currency marker
 * needed widening. One of `$` or `USD` is required either way — a bare number
 * must never be read as a total, or `Total items shipped: 4` would misparse.
 *
 * Any number of decimals, rounded to cents: since Sep 2026 the plain-text copy
 * prints an unrounded binary float (`10.799999999999999 USD` for $10.80). And
 * `Total` must be a whole word, so `Item Subtotal:` is never read as the total.
 * Group 1 is `Grand ` when present (see `copyTotal`), 2 the `$` amount, 3 the
 * `USD` amount.
 */
const TOTAL = /\b(Grand\s+)?Total\b:?\s*(?:\$\s*([\d,]+\.\d+)|([\d,]+\.\d+)\s*USD\b)/i;

/** Integer cents from a `TOTAL` match. Rounded, not truncated — see `TOTAL`. */
function toCents(m: RegExpMatchArray): number {
  return Math.round(parseFloat((m[2] ?? m[3] ?? '').replace(/,/g, '')) * 100);
}

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
 * categories, not a category called "other". `more` is the subject line's
 * version of the same thing (`Shipped 4 items: A, B, and more`).
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
  const labels = parts.filter((p) => !/^(?:others?|more)$/i.test(p));
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
 *
 * 2026-08 lesson: every Amazon email — including order CONFIRMATIONS — started
 * carrying a shipping progress tracker as four bare lines, `Ordered` / `Shipped` /
 * `Out for delivery` / `Delivered`, with no colon and no surrounding sentence.
 * The wording list used to include the bare substring "out for delivery", which
 * the tracker satisfies on every single message. Combined with the same change
 * dropping the `$` from the total (making it briefly unparseable until that was
 * fixed too), a fresh order confirmation — tracker line present, total not yet
 * recognised — matched both conditions and was filed as an ignorable notice: the
 * exact "format change made invisible" failure this function exists to prevent.
 * So the wording list only matches phrasing a real notice actually uses — a full
 * sentence (`was delivered`, `is out for delivery`) or subject-style wording WITH
 * its colon (`Delivered: …`, `Out for delivery: …`) — never the bare tracker label.
 */
export function isAmazonNoticeWithoutTotal(body: string): boolean {
  const text = (body ?? '').replace(BIDI_CONTROLS, '');
  if (!/was delivered|Delivered:|Out for delivery:|is out for delivery/i.test(text)) return false;
  return !TOTAL.test(text);
}

/**
 * One message's three copies, each already plain text (the companion reduces
 * the HTML part with `htmlToText` before it gets here).
 *
 * KEPT APART, not joined. Until Oct 2026 the companion glued all three into
 * one document, and that broke the moment the copies stopped agreeing on
 * layout: Amazon's plain-text copy grew its own `Order #` with no category
 * line, so slicing the joined text at every `Order #` left the category in one
 * chunk and the only readable total in the next. Each copy is now read on its
 * own and the results are combined by order number.
 */
export interface AmazonMailParts {
  subject?: string | null;
  plain?: string | null;
  html?: string | null;
}

/** A bare string is one copy — how every caller worked before the copies were
 *  kept apart, and how a hand-pasted body still arrives. */
function toParts(input: string | AmazonMailParts): AmazonMailParts {
  return typeof input === 'string' ? { plain: input } : input;
}

function joinParts(parts: AmazonMailParts): string {
  return [parts.subject, parts.plain, parts.html].filter((s): s is string => !!s).join('\n');
}

const stripMarks = (s: string | null | undefined): string => (s ?? '').replace(BIDI_CONTROLS, '');

/** `Shipped 1 item: Hair Care` — the subject's first word names the email type. */
const SUBJECT_KIND = /^\s*(Ordered|Shipped|Delivered)\b/i;
/**
 * The category list in a SUBJECT, in its two observed shapes:
 *   Shipped 4 items: Electronics, Irons & Steamers, and more   (Sep 2026 on)
 *   Ordered: 1 Essentials item                                 (Aug 2026)
 * A backup only: subjects get cut short (`Item cancelled successfully:
 * "Amazon Basics USB-C to..."`), so a body line wins whenever one exists.
 */
const SUBJECT_ITEMS_COLON = /^\s*(?:Ordered|Shipped|Delivered)\s+(\d+)\s+items?\s*:\s*(.+?)\s*$/i;
const SUBJECT_ITEMS_SUFFIX = /^\s*(?:Ordered|Shipped|Delivered)\s*:\s*(\d+)\s+(.+?)\s+items?\s*$/i;

interface ItemFacts { count: number; labels: string[]; partial: boolean }

function kindOf(subject: string, bodies: string[]): AmazonOrderRecord['kind'] | null {
  const verb = SUBJECT_KIND.exec(subject)?.[1];
  if (verb) return verb.toLowerCase() as AmazonOrderRecord['kind'];
  return detectKind(bodies.join('\n'));
}

function orderIdsIn(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(ORDER_ID_ALL)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

function itemFacts(found: { match: RegExpExecArray; breakdown: boolean } | null): ItemFacts | null {
  if (!found) return null;
  const { labels, partial } = splitLabels(found.match[2], found.breakdown);
  return labels.length > 0 ? { count: Number(found.match[1]) || 1, labels, partial } : null;
}

function subjectItemFacts(subject: string): ItemFacts | null {
  const m = SUBJECT_ITEMS_COLON.exec(subject) ?? SUBJECT_ITEMS_SUFFIX.exec(subject);
  if (!m) return null;
  const { labels, partial } = splitLabels(m[2]);
  return labels.length > 0 ? { count: Number(m[1]) || 1, labels, partial } : null;
}

/**
 * The one total a copy states for a single-order email: cents, `null` when it
 * states none, `'conflict'` when it states two different ones.
 *
 * `Grand Total` outranks a bare `Total` — a confirmation can carry both, and
 * the grand figure is the order's. Two different figures at the same rank are
 * not resolved by guessing which one the bank will show.
 */
function copyTotal(text: string): number | null | 'conflict' {
  const all = [...text.matchAll(new RegExp(TOTAL.source, 'gi'))];
  const grand = all.filter((m) => !!m[1]);
  const cents = [...new Set((grand.length > 0 ? grand : all).map(toCents))];
  if (cents.length === 0) return null;
  return cents.length === 1 ? cents[0] : 'conflict';
}

/** Each order's total in one copy, keyed by order id — the cross-check for a
 *  multi-order email. Totals follow their `Order #` in every layout seen. */
function totalsByOrder(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const starts = [...text.matchAll(/Order\s*#/g)].map((m) => m.index ?? 0);
  starts.forEach((start, i) => {
    const chunk = text.slice(start, starts[i + 1] ?? text.length);
    const id = ORDER_ID.exec(chunk)?.[1];
    const total = TOTAL.exec(chunk);
    if (id && total && !out.has(id)) out.set(id, toCents(total));
  });
  return out;
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
 *
 * ONE ORDER NUMBER (every shipment notice seen so far): no positional logic at
 * all. The category comes from the first body copy that has a category line,
 * else the subject; every copy that states a total must state the same one.
 * SEVERAL: the positional pairing in `parseCopy`, run inside one copy at a
 * time (HTML first), with the other copies' totals as a cross-check.
 */
export function parseAmazonEmail(input: string | AmazonMailParts): AmazonOrderRecord[] {
  const parts = toParts(input);
  const subject = stripMarks(parts.subject);
  // HTML first: it is the copy that still carries the category line.
  const bodies = [stripMarks(parts.html), stripMarks(parts.plain)].filter((b) => b.trim() !== '');
  const kind = kindOf(subject, bodies);
  if (!kind) return [];
  const ids = [...new Set(bodies.flatMap(orderIdsIn))];
  if (ids.length === 0) return [];
  return ids.length === 1 ? singleOrder(ids[0], kind, subject, bodies) : severalOrders(kind, bodies);
}

function singleOrder(
  orderId: string,
  kind: AmazonOrderRecord['kind'],
  subject: string,
  bodies: string[],
): AmazonOrderRecord[] {
  const totals = bodies.map(copyTotal);
  if (totals.includes('conflict')) return [];
  const stated = [...new Set(totals.filter((t): t is number => typeof t === 'number'))];
  // All three or nothing (see `parseCopy`), and every copy that names a total
  // must name the same one.
  if (stated.length !== 1) return [];
  const item = bodies.map((b) => itemFacts(findItemLine(b, 'first'))).find((f): f is ItemFacts => f !== null)
    ?? subjectItemFacts(subject);
  if (!item) return [];
  return [{
    orderId,
    kind,
    totalCents: stated[0],
    itemCount: item.count,
    labels: item.labels,
    ...(item.partial ? { partial: true } : {}),
  }];
}

function severalOrders(kind: AmazonOrderRecord['kind'], bodies: string[]): AmazonOrderRecord[] {
  for (let i = 0; i < bodies.length; i++) {
    const records = parseCopy(bodies[i], kind);
    if (records.length === 0) continue;
    const others = bodies.filter((_, j) => j !== i).map(totalsByOrder);
    // One contradiction voids the whole message, not just that order: keeping
    // the rest would mark it read with no warning and no sample, hiding the
    // very layout change the cross-check just caught.
    const agreed = records.every((r) => others.every((t) => !t.has(r.orderId) || t.get(r.orderId) === r.totalCents));
    return agreed ? records : [];
  }
  return [];
}

/** The positional reading of ONE copy: what `parseAmazonEmail` did to the
 *  whole message before the copies were kept apart. */
function parseCopy(text: string, kind: AmazonOrderRecord['kind']): AmazonOrderRecord[] {
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

  // Two layouts. Until Sep 2026 the item line FOLLOWED "Order #"; since then
  // (live, 2026-09-14: "Ordered 1 item: Hair Care") it comes BEFORE it. In the
  // new layout an order's item line sits between the previous order number and
  // its own, so it is the LAST item line in that stretch; reading the chunk
  // after "Order #" would find the NEXT order's line, or none.
  const itemFirst = findItemLine(text.slice(0, starts[0]), 'first') !== null;

  const records: AmazonOrderRecord[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const id = ORDER_ID.exec(part)?.[1];
    const found = itemFirst
      ? findItemLine(text.slice(i === 0 ? 0 : starts[i - 1], starts[i]), 'last')
      : findItemLine(part, 'first');
    const breakdown = found?.breakdown ? found.match : null;
    const item = found?.match ?? null;
    const totalMatch = TOTAL.exec(part);
    // All three or nothing: an order with no total cannot be matched to a charge,
    // and half a record would sit in the ledger forever pretending to be usable.
    if (!id || !item || !totalMatch) continue;
    const { labels, partial } = splitLabels(item[2], !!breakdown);
    if (labels.length === 0) continue;
    records.push({
      orderId: id,
      kind,
      totalCents: toCents(totalMatch),
      itemCount: Number(item[1]) || 1,
      labels,
      ...(partial ? { partial: true } : {}),
    });
  }
  return records;
}

/**
 * The category line in `text`, and which form it is.
 *
 * `first`: breakdown form FIRST, then suffix — `6 items: 1 Home Improvement, …`
 * satisfies nothing in the suffix pattern, but checking the more specific shape
 * first keeps the two from ever competing as Amazon's wording drifts again.
 * `last`: the line nearest the end, whichever form — the new layout's order
 * owns the item line closest above its order number.
 */
function findItemLine(text: string, which: 'first' | 'last'): { match: RegExpExecArray; breakdown: boolean } | null {
  if (which === 'first') {
    const breakdown = ITEM_BREAKDOWN.exec(text);
    if (breakdown) return { match: breakdown, breakdown: true };
    const suffix = ITEM_SUFFIX.exec(text);
    return suffix ? { match: suffix, breakdown: false } : null;
  }
  let last: { match: RegExpExecArray; breakdown: boolean } | null = null;
  for (const [re, breakdown] of [[ITEM_BREAKDOWN, true], [ITEM_SUFFIX, false]] as const) {
    const global = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
    for (let m = global.exec(text); m; m = global.exec(text)) {
      if (!last || m.index > last.match.index) last = { match: m, breakdown };
    }
  }
  return last;
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
  /**
   * Present only on a cancellation notice: the order numbers it names. The
   * mail reader retires their confirmation records, so a cancelled order's
   * total cannot be matched to an unrelated charge of the same amount.
   */
  cancelledOrderIds?: string[];
}

/**
 * Amazon's cancellation notice, from the live 2026-10-06 message: subject
 * `Item cancelled successfully: "…"`, body `Your order was cancelled. You have
 * not been charged for this order.` Both spellings, since Amazon writes
 * "canceled" elsewhere.
 *
 * Judged on the SUBJECT, and only for a message stating no total. A body that
 * merely mentions cancelling — a confirmation saying "if an item has been
 * cancelled…", a shipment from a part-cancelled order — must not be skipped
 * when it fails to parse: that would mark it read with no warning, the
 * 2026-08 delivery-notice failure again (see `isAmazonNoticeWithoutTotal`).
 */
const CANCELLATION_SUBJECT = /\bcancell?ed\b/i;

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
export function classifyAmazonEmail(input: string | AmazonMailParts): AmazonEmailClassification {
  const orders = parseAmazonEmail(input);
  if (orders.length > 0) return { orders, status: 'orders' };
  const parts = toParts(input);
  const all = stripMarks(joinParts(parts));
  // Checked only once nothing parsed: a shipment that mentions a cancelled
  // item still carries its own order and must keep it.
  if (CANCELLATION_SUBJECT.test(stripMarks(parts.subject)) && !TOTAL.test(all)) {
    return { orders, status: 'ignored', cancelledOrderIds: orderIdsIn(all) };
  }
  return { orders, status: isAmazonNoticeWithoutTotal(all) ? 'ignored' : 'unrecognised' };
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
