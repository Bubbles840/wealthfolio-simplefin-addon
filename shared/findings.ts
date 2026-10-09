/**
 * shared/findings.ts
 *
 * What happens to a self-check or ledger finding AFTER it is judged: whether
 * the user has snoozed it, how it is named on a button, and how the full list
 * reads once someone taps "Show".
 *
 * Why snoozing exists. Some findings repeat every morning and have no fix the
 * addon can apply: a bank feed that has gone dead stays dead until the user
 * reconnects it in SimpleFin — or never, if the card is closed and they have
 * not got round to unmapping it. Repeated daily, the line trains the reader to
 * skip the whole block, including the day it carries something new. A snooze
 * quiets ONE condition for a while; anything that changes gets a new key (the
 * keys carry the ids and amounts involved) and is announced fresh.
 *
 * Pure and host-agnostic: the companion stores the snoozes in an addon secret
 * and the addon bundle can read the same shape.
 */
import { escapeFindingText, printsInFull, type SelfCheckFinding } from './self-check.js';

/** Addon secret holding `{ [findingKey]: untilIso }`. */
export const FINDING_SNOOZES_SECRET_KEY = 'finding_snoozes';

/** Long enough that a known-dead feed is a monthly reminder rather than a
 *  daily one; short enough that a forgotten snooze resurfaces on its own. */
export const SNOOZE_DAYS = 30;

export type FindingSnoozes = Record<string, string>;

/** Garbage in, `{}` out — a corrupted secret must cost the snoozes, never the
 *  report that reads them. */
export function parseSnoozes(raw: string | null | undefined): FindingSnoozes {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: FindingSnoozes = {};
    for (const [key, until] of Object.entries(value)) {
      if (typeof until === 'string' && !Number.isNaN(Date.parse(until))) out[key] = until;
    }
    return out;
  } catch {
    return {};
  }
}

/** The snoozes still running at `now`; expired ones are dropped so the stored
 *  secret does not grow forever. */
export function activeSnoozes(snoozes: FindingSnoozes, now: Date): FindingSnoozes {
  const out: FindingSnoozes = {};
  for (const [key, until] of Object.entries(snoozes)) {
    if (Date.parse(until) > now.getTime()) out[key] = until;
  }
  return out;
}

/** Whether a finding may be snoozed at all. Problems may not: a failing sync
 *  or an account syncing nothing is the reason the block exists, and a snooze
 *  on one would be a month of silently missing money. */
export function isSnoozable(f: SelfCheckFinding): boolean {
  return !!f.key && !printsInFull(f);
}

/** Splits findings into what is shown and what is currently snoozed. */
export function partitionSnoozed(
  findings: readonly SelfCheckFinding[],
  snoozes: FindingSnoozes,
  now: Date,
): { visible: SelfCheckFinding[]; snoozed: SelfCheckFinding[] } {
  const active = activeSnoozes(snoozes, now);
  const visible: SelfCheckFinding[] = [];
  const snoozed: SelfCheckFinding[] = [];
  for (const f of findings) {
    if (isSnoozable(f) && f.key && active[f.key]) snoozed.push(f);
    else visible.push(f);
  }
  return { visible, snoozed };
}

/** The stored snoozes with one more added. */
export function withSnooze(snoozes: FindingSnoozes, key: string, now: Date, days = SNOOZE_DAYS): FindingSnoozes {
  return {
    ...activeSnoozes(snoozes, now),
    [key]: new Date(now.getTime() + days * 86_400_000).toISOString(),
  };
}

/**
 * A short, stable handle for a finding key, for `callback_data`.
 *
 * Telegram caps callback data at 64 bytes, and a key can carry a uuid plus an
 * account name. FNV-1a over the key gives 8 hex characters; a tap resolves the
 * handle by re-judging the findings and hashing each key, so nothing has to be
 * remembered between the report going out and the tap arriving — which can be
 * hours, and a container restart, later.
 */
export function findingHandle(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The button text for a finding. */
export function findingLabel(f: SelfCheckFinding, max = 40): string {
  const text = f.label ?? f.message;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Telegram refuses a message over 4096 characters; the list stops well short
 *  of that and says how many it left off. */
const LIST_TEXT_BUDGET = 3500;

/**
 * The full list, as the Show button and the Reports tab render it. Numbered so
 * the buttons under it (one per finding, in the same order) can be matched to
 * the text without repeating it.
 */
export function formatFindingsList(
  findings: readonly SelfCheckFinding[],
  opts: { snoozedCount?: number; numbered?: boolean } = {},
): string {
  const numbered = opts.numbered ?? true;
  const snoozedNote = opts.snoozedCount
    ? `\n\n_${opts.snoozedCount} snoozed — they come back on their own after ${SNOOZE_DAYS} days._`
    : '';
  if (findings.length === 0) return `*Nothing to fix.*${snoozedNote}`;
  const head = `🧹 *${findings.length} ${findings.length === 1 ? 'thing' : 'things'} to fix*\n`;
  const lines: string[] = [];
  let used = head.length + snoozedNote.length;
  let omitted = 0;
  findings.forEach((f, i) => {
    const glyph = f.severity === 'problem' ? '🚨' : '⚠️';
    const line = `${numbered ? `${i + 1}. ` : ''}${glyph} ${escapeFindingText(f.message)}`;
    if (used + line.length + 2 > LIST_TEXT_BUDGET) {
      omitted++;
      return;
    }
    used += line.length + 2;
    lines.push(line);
  });
  const more = omitted > 0 ? `\n\n…and ${omitted} more — fix a few and tap Refresh.` : '';
  return `${head}\n${lines.join('\n\n')}${more}${snoozedNote}`;
}
