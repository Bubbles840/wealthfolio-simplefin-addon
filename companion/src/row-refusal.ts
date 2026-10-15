/**
 * companion/src/row-refusal.ts
 *
 * Whether a THROWN bulk-write error is Wealthfolio refusing the row itself: a
 * 400 or a 422, which the same row gets again. Anything else — another 4xx
 * (401, 403, 404, 405, 409, 413, and 408, 423, 429), a 5xx, a network error —
 * is the host's or the moment's, and stops a one-time pass unmarked so the
 * next sync tries again. A refusal in the answer's `errors[]` is always the
 * row's. Both one-time passes (the date repair and the card bookkeeping
 * rewrite) count a row as refused only after it is refused twice, and report
 * those rows the same way (`refused` on their change-log entry).
 */
export function isRowRefusal(e: unknown): boolean {
  const m = /failed: (\d{3})/.exec(e instanceof Error ? e.message : String(e));
  return !!m && [400, 422].includes(Number(m[1]));
}
