/**
 * Secret keys shared between the two syncers for UI status data.
 *
 * Named in shared/ because the companion WRITES these and the addon READS them —
 * a typo on either side looks like "the tile silently never appears", the hardest
 * kind of bug to notice (same reasoning as AMAZON_LEDGER_SECRET_KEY).
 */
export const UNCATEGORIZED_STATUS_SECRET_KEY = 'uncategorized_status';
