/**
 * src/utils/write-lock.ts
 *
 * ONE write lock for everything in the add-on that rewrites transfers: a sync
 * run (Sync now, the scheduler and the startup catch-up all go through
 * `runSync`) and a Link from the Checks card. Link deletes both rows before it
 * re-creates them, so a sync reading the ledger in between would see two
 * half-transfers; a sync that landed in Link's window could undo it.
 *
 * - Link refuses while a sync holds the lock (it never waits: a person is
 *   watching the button).
 * - A sync that starts while Link holds it waits for Link to finish.
 */
export const LINK_SYNC_RUNNING = 'A sync is running — try Link again when it finishes.';

let syncs = 0;
let linking: Promise<void> | null = null;
let endLink: (() => void) | null = null;

/** Link takes the lock; null while a sync (or another Link) holds it. */
export function beginLink(): (() => void) | null {
  if (syncs > 0 || linking) return null;
  const mine = new Promise<void>((resolve) => { endLink = resolve; });
  const resolveMine = endLink!;
  linking = mine;
  // A release clears the lock only while it is still this holder's.
  return () => {
    if (linking === mine) {
      linking = null;
      endLink = null;
    }
    resolveMine();
  };
}

/** A sync takes the lock: counted at once (so Link refuses), then waits for a running Link. */
export async function beginSync(): Promise<() => void> {
  syncs += 1;
  let released = false;
  const end = () => {
    if (!released) { released = true; syncs -= 1; }
  };
  try {
    while (linking) await linking;
  } catch (err) {
    end();
    throw err;
  }
  return end;
}
