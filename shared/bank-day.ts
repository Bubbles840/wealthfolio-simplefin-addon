/**
 * shared/bank-day.ts
 *
 * The instant a row dated by the bank is written at (1.62, ruling W1): noon
 * UTC on the bank's date, never a bare date.
 *
 * Why. Wealthfolio 3.8 and 3.9 store a bare `YYYY-MM-DD` at 00:00 UTC
 * (storage-sqlite activities/model.rs, `From<NewActivity>`/`From<ActivityUpdate>`).
 * West of UTC that instant is the previous evening, so Wealthfolio's Spending
 * page — which places a row by its LOCAL date — counted a row dated the 1st in
 * the month before (−$48.55 on 2026-10-14). Noon UTC falls on the bank's date
 * in every zone from UTC−11 to UTC+11.
 *
 * Every Wealthfolio version keeps a timestamp as sent: 3.8 and 3.9's
 * `validate_and_normalize_activity_date` and 3.10's `validate_activity_timestamp`
 * return the string unchanged once its own date is supported, and storage
 * normalizes it to `YYYY-MM-DDT12:00:00+00:00`. Wealthfolio's dedupe key hashes
 * the UTC calendar date only (`compute_idempotency_key`, "ignore time component
 * for matching", 3.8–3.10), so a noon write and a row already stored at 00:00
 * UTC on the same date share one key.
 *
 * Every reader in the add-on takes the row's UTC date (`toIsoDate`, `isoDay`,
 * `substr(activity_date, 1, 10)`, SQLite `date()`), which is the bank's date
 * for both instants, so no comparison changes.
 *
 * A write replayed from what the change log RECORDED keeps a recorded
 * timestamp as it was; a recorded bare day is written at noon UTC through
 * `bankDayInstant`, like any other bank day.
 */

/** The hour, UTC, a bank-dated row is written at. */
export const BANK_DAY_HOUR_UTC = 12;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `2026-10-01` → `2026-10-01T12:00:00Z`. Anything that is not a bare date —
 *  a timestamp already, or text that is not a date — comes back unchanged. */
export function bankDayInstant(day: string): string {
  return DAY.test(day) ? `${day}T${String(BANK_DAY_HOUR_UTC).padStart(2, '0')}:00:00Z` : day;
}
