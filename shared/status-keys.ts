/**
 * Secret keys shared between the two syncers for UI status data.
 *
 * Named in shared/ because the companion WRITES these and the addon READS them —
 * a typo on either side looks like "the tile silently never appears", the hardest
 * kind of bug to notice (same reasoning as AMAZON_LEDGER_SECRET_KEY).
 */
export const UNCATEGORIZED_STATUS_SECRET_KEY = 'uncategorized_status';

/**
 * Published every sync that Amazon mail is configured AND the mailbox scan
 * actually ran — including `unparsed: 0`, so a parser fix clears the warning
 * instead of leaving it stuck once the format breaks again. Skipped entirely
 * when the scan itself failed to run (a connection error is not "0 problems").
 *
 * Payload: `{ unparsed: number; asOf: string }` — the count of messages the
 * parser did not recognise on that run, and when it ran.
 */
export const AMAZON_MAIL_STATUS_SECRET_KEY = 'amazon_mail_status';
