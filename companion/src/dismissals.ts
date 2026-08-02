/**
 * companion/src/dismissals.ts
 *
 * The "Dismiss" button behind the import notice's needs-a-category list.
 *
 * The notice carries an inline keyboard (`d:<activityId>` per row — activity id
 * because Telegram caps callback_data at 64 bytes, which two uuids exceed).
 * Pressing a button parks a `callback_query` on Telegram's servers; nothing
 * reaches the companion until it polls. This module is that poll: called once
 * per sync run, so a press takes effect on the NEXT notice, not instantly —
 * accepted in the design (2026-07-30) over running a webhook or a long-poll
 * loop for what is a rarely-used escape hatch.
 *
 * Dismissals live in the `uncategorized_dismissals` addon secret as
 * `{ [activityId]: dismissedAtIso }`, pruned past 60 days — a dismissed row
 * ages out of the 30-day sweep window long before then, so entries only need
 * to outlive the window, not the account.
 */

export interface DismissalLedger {
  [activityId: string]: string;
}

const DISMISSAL_MAX_AGE_DAYS = 60;

/** Drop ledger entries old enough to be inert (their row left the sweep window
 *  weeks ago), so the secret cannot grow forever. */
export function pruneDismissals(ledger: DismissalLedger, now: Date): DismissalLedger {
  const cutoff = now.getTime() - DISMISSAL_MAX_AGE_DAYS * 86400_000;
  const pruned: DismissalLedger = {};
  for (const [id, at] of Object.entries(ledger)) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) pruned[id] = at;
  }
  return pruned;
}

/**
 * Fetch pending button presses. Never throws: a dead network returns no ids
 * and the offset UNCHANGED, so nothing is skipped — Telegram re-serves
 * un-acknowledged updates on the next poll.
 *
 * The offset always advances past non-dismiss updates too (someone typing at
 * the bot), or those updates would be re-fetched on every poll forever.
 */
export async function pollTelegramDismissals(opts: {
  botToken: string;
  offset: number | null;
  fetchImpl?: typeof fetch;
}): Promise<{ dismissedActivityIds: string[]; nextOffset: number | null }> {
  const { botToken, offset } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const base = `https://api.telegram.org/bot${botToken}`;
  try {
    const params = new URLSearchParams({ timeout: '0', allowed_updates: '["callback_query","message"]' });
    if (offset !== null) params.set('offset', String(offset));
    const res = await doFetch(`${base}/getUpdates?${params}`);
    const json: any = await res.json();
    if (!json?.ok || !Array.isArray(json.result)) {
      return { dismissedActivityIds: [], nextOffset: offset };
    }

    const ids: string[] = [];
    let maxUpdateId: number | null = null;
    for (const u of json.result) {
      if (typeof u?.update_id === 'number') {
        maxUpdateId = maxUpdateId === null ? u.update_id : Math.max(maxUpdateId, u.update_id);
      }
      const cq = u?.callback_query;
      if (!cq || typeof cq.data !== 'string' || !cq.data.startsWith('d:')) continue;
      ids.push(cq.data.slice(2));
      // Answer so the user's button stops showing Telegram's loading spinner.
      // Best-effort: an unanswered callback only means a spinner that times out.
      try {
        await doFetch(`${base}/answerCallbackQuery?${new URLSearchParams({
          callback_query_id: String(cq.id),
          text: 'Dismissed — dropped from future notices',
        })}`);
      } catch {
        /* answered or not, the dismissal itself is recorded */
      }
    }
    return {
      dismissedActivityIds: ids,
      nextOffset: maxUpdateId === null ? offset : maxUpdateId + 1,
    };
  } catch {
    return { dismissedActivityIds: [], nextOffset: offset };
  }
}
