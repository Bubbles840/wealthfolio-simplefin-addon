/**
 * companion/src/dismissals.ts
 *
 * The ledger behind the import notice's "Dismiss" buttons.
 *
 * The notice carries an inline keyboard (`d:<activityId>` per row — activity id
 * because Telegram caps callback_data at 64 bytes, which two uuids exceed).
 * Pressing a button parks a `callback_query` on Telegram's servers, and
 * `companion/src/telegram-listener.ts` is now the transport that collects it:
 * the always-on long-poll loop owns `getUpdates` and records a tap within
 * about a second. This module used to hold a once-per-sync poll of its own,
 * which meant a press only took effect on the NEXT notice (up to six hours
 * later) — and which cannot coexist with the listener, because Telegram serves
 * `getUpdates` to exactly ONE reader per bot token.
 *
 * Dismissals live in the `uncategorized_dismissals` addon secret as
 * `{ [activityId]: dismissedAtIso }`, pruned past 60 days — a dismissed row
 * ages out of the 30-day sweep window long before then, so entries only need
 * to outlive the window, not the account.
 */

import { pruneDismissals, mergeDismissals, type DismissalLedger } from '../../shared/uncategorized.js';

// Re-exported so this module stays the one import site for the Telegram half of
// dismissals, even though the ledger's shape, retention and merge now live in
// shared/ (the addon needs them too, and two copies would drift).
export { pruneDismissals, mergeDismissals };
export type { DismissalLedger };
