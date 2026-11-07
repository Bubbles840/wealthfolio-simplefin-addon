/**
 * shared/amazon-config.ts
 *
 * Amazon categorization settings, and the one place a label is turned into a
 * Wealthfolio category.
 *
 * Separate from `companion/src/amazon-mail.ts` because BOTH hosts need this and
 * only the companion can have the IMAP client: the addon runs in a browser iframe,
 * where an `import('imapflow')` — even a dynamic one — is something the bundler
 * tries to resolve. So the settings shape and the label→category decision live
 * here, host-agnostic, and the mailbox adapter stays on the Node side.
 *
 * It also matters that `resolveAmazonCategory` has exactly one definition: the
 * companion applies it when a label first arrives, and the addon card renders what
 * it decided. Two copies would drift, and the symptom would be a card that
 * confidently displays the wrong category.
 */

import { mapAmazonLabel, DEFAULT_AMAZON_LABEL_RULES } from './amazon.js';

export const AMAZON_CONFIG_SECRET_KEY = 'amazon_config';
export const AMAZON_LABELS_SECRET_KEY = 'amazon_labels';

export const DEFAULT_AMAZON_CATEGORY = 'Shopping';

/** The senders Amazon uses for order confirmations and shipment notices. */
export const AMAZON_SENDERS = [
  'auto-confirm@amazon.com',
  'shipment-tracking@amazon.com',
  'order-update@amazon.com',
];

export interface AmazonMailConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** Wealthfolio category for a label no pattern matches. */
  defaultCategory?: string;
  /** User overrides, label → Wealthfolio category, set on the Sync page. A
   *  value is a category path (`findAmazonCategory`): `Parent / Child` for a
   *  subcategory, the bare name for a top-level one. Older builds stored bare
   *  names only, and those are still read. */
  labelOverrides?: Record<string, string>;
}

/** Labels the user has ever received, and the category each resolved to. */
export type AmazonLabelCatalog = Record<string, { category: string; matched: boolean }>;

/**
 * Resolve a label: the user's override first, then the patterns, then the default.
 *
 * `matched` is what makes an unmatched label BOTH filed and visible. Nothing is
 * ever left uncategorized, but a label that only landed in the default is reported
 * once so it is one rule away from correct rather than silently wrong.
 */
export function resolveAmazonCategory(
  label: string,
  cfg: AmazonMailConfig,
): { category: string; matched: boolean } {
  const override = cfg.labelOverrides?.[label];
  if (override) return { category: override, matched: true };
  const fallback = cfg.defaultCategory || DEFAULT_AMAZON_CATEGORY;
  const strict = mapAmazonLabel(label, DEFAULT_AMAZON_LABEL_RULES, fallback, true);
  return strict ? { category: strict, matched: true } : { category: fallback, matched: false };
}

/** A category as both hosts know it: its name and its parent's name. */
export interface AmazonCategoryEntry {
  name: string;
  /** The parent's NAME, null for a top-level category. */
  parent: string | null;
}

/** Between a parent and its subcategory in a stored value. */
export const AMAZON_CATEGORY_SEPARATOR = ' / ';

/** What a picker stores for a category: `Parent / Child`, or the bare name of
 *  a top-level one (which is also what every older build stored for it). */
export function amazonCategoryValue(c: AmazonCategoryEntry): string {
  return c.parent ? `${c.parent}${AMAZON_CATEGORY_SEPARATOR}${c.name}` : c.name;
}

export type AmazonCategoryLookup<T> =
  | { kind: 'found'; entry: T }
  /** More than one category fits. `entry` is the one builds before 1.74.0
   *  filed under: the LAST fit in the list as given (their by-name map let
   *  later entries win), so a value stored back then keeps filing where it
   *  always did until the person picks again. Callers report it. */
  | { kind: 'ambiguous'; entry: T; candidates: T[] }
  | { kind: 'unknown' };

/**
 * The category a stored value names. Case-insensitive, since older values were
 * typed by hand.
 *
 * 1. The full path: `Parent / Child`, or a top-level category's own name.
 * 2. Otherwise a bare subcategory name, as stored before subcategories could be
 *    picked: found when exactly one subcategory has it.
 *
 * A top-level category wins over a subcategory of the same name in step 1. Both
 * pickers only ever offered top-level categories, so a bare name they stored
 * meant that one.
 */
export function findAmazonCategory<T extends AmazonCategoryEntry>(
  value: string,
  categories: readonly T[],
): AmazonCategoryLookup<T> {
  const wanted = value.trim().toLowerCase();
  if (!wanted) return { kind: 'unknown' };
  const pick = (fits: T[]): AmazonCategoryLookup<T> => (
    fits.length === 1
      ? { kind: 'found', entry: fits[0] }
      : { kind: 'ambiguous', entry: fits[fits.length - 1], candidates: fits }
  );
  const byPath = categories.filter((c) => amazonCategoryValue(c).trim().toLowerCase() === wanted);
  if (byPath.length > 0) return pick(byPath);
  const byName = categories.filter((c) => c.name.trim().toLowerCase() === wanted);
  return byName.length > 0 ? pick(byName) : { kind: 'unknown' };
}

/**
 * Whether a message came from Amazon — by envelope sender, or by the header of a
 * message a human forwarded by hand.
 *
 * The second half is not a nicety. Gmail's "also apply to matching conversations"
 * does NOT forward existing mail — only newly arriving mail is forwarded — so the
 * only way to seed the mailbox with past orders, or to test the setup at all
 * without waiting days for a purchase, is to forward a few by hand. And a hand
 * forward rewrites `From:` to the person forwarding, so an envelope-only check
 * skips exactly the messages someone is using to verify the thing works.
 *
 * Still a real check, not a rubber stamp: the parser must independently find an
 * order id, a category label and a total, so a forwarded message that merely
 * mentions Amazon yields nothing.
 */
export function isAmazonMessage(from: string | undefined, body: string): boolean {
  if (from && (AMAZON_SENDERS.includes(from) || from.endsWith('@amazon.com'))) return true;
  // `From: "Amazon.com" <auto-confirm@amazon.com>` inside a forwarded block.
  return /^\s*From:.*@amazon\.[a-z.]+/im.test(body);
}

/** Whether the user has supplied enough for the companion to poll a mailbox. */
export function amazonMailConfigured(cfg: AmazonMailConfig | null | undefined): boolean {
  return !!(cfg && cfg.enabled !== false && cfg.host && cfg.user && cfg.password);
}

/**
 * Google shows an app password as four groups of four letters, and a pasted
 * copy keeps the spaces — which IMAP rejects as a wrong password, with nothing
 * to say why (live, 2026-08-07). Only that exact shape is changed: any other
 * password is used exactly as typed, since a space can be a real character.
 */
export function normalizeAppPassword(password: string): string {
  const trimmed = password.trim();
  return /^[a-z]{4}(\s+[a-z]{4}){3}$/i.test(trimmed) ? trimmed.replace(/\s+/g, '') : password;
}
