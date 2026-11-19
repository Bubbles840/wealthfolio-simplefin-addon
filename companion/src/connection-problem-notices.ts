import {
  connectionProblemClearedText,
  parseConnectionProblems,
  PROBLEM_RECORD_MAX_AGE_MS,
  shownConnectionProblems,
  connectionProblemText,
  connectionProblemTitle,
  isConnectionProblem,
  type ConnectionProblem,
} from '../../shared/connection-problems.js';
import { escapeMarkdown, type TelegramSendResult } from '../../shared/telegram.js';

/** Ledger of problem KEYS already announced on Telegram (whole problems are stored so the "updating again" text can be written after they leave the record). */
export const ANNOUNCED_PROBLEMS_SECRET_KEY = 'announced_simplefin_problems';

export interface ProblemNoticeDeps {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  /** null: Telegram is off or unconfigured. */
  telegram(): Promise<{ send(text: string): Promise<Pick<TelegramSendResult, 'ok' | 'description'>> } | null>;
  log(msg: string): void;
}

const FRESH_HEADER = '*SimpleFin connection problem*';
const MAX_MESSAGE_CHARS = 3500;

/** Groups items into messages under MAX_MESSAGE_CHARS, each starting with `prefix`. */
function batches(
  items: readonly ConnectionProblem[],
  render: (p: ConnectionProblem) => string,
  sep: string,
  prefix: string,
): Array<{ text: string; items: ConnectionProblem[] }> {
  const groups: Array<{ parts: string[]; items: ConnectionProblem[]; len: number }> = [];
  for (const p of items) {
    const part = render(p);
    let g = groups[groups.length - 1];
    if (!g || g.len + sep.length + part.length > MAX_MESSAGE_CHARS) {
      g = { parts: [], items: [], len: prefix.length };
      groups.push(g);
    }
    g.len += (g.parts.length ? sep.length : 0) + part.length;
    g.parts.push(part);
    g.items.push(p);
  }
  return groups.map((g) => ({ text: prefix + g.parts.join(sep), items: g.items }));
}

function readLedger(raw: string | null): ConnectionProblem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isConnectionProblem) : [];
  } catch {
    return [];
  }
}

/**
 * Says once when a connection problem starts being shown and once when it
 * clears. `shown` is undefined when the run read no problem record: then
 * nothing is read, written or sent, so a failed read can never look like
 * "everything cleared".
 */
export async function sendConnectionProblemNotices(
  deps: ProblemNoticeDeps,
  shown: readonly ConnectionProblem[] | undefined,
): Promise<void> {
  if (shown === undefined) return;
  try {
    const raw = await deps.getSecret(ANNOUNCED_PROBLEMS_SECRET_KEY);
    const ledger = readLedger(raw);
    const shownKeys = new Set(shown.map((p) => p.key));
    const ledgerKeys = new Set(ledger.map((p) => p.key));
    const fresh = shown.filter((p) => !ledgerKeys.has(p.key));
    const cleared = ledger.filter((p) => !shownKeys.has(p.key));
    let next = ledger.filter((p) => shownKeys.has(p.key));

    if (fresh.length > 0 || cleared.length > 0) {
      const tg = await deps.telegram();
      if (!tg) {
        deps.log('Telegram not configured, so no connection-problem notice was sent.');
      } else {
        // Only the fixed header is bold. Names and messages come from outside
        // and are escaped but never inside an entity: legacy Markdown ignores
        // backslash escapes there, so a "_" or "*" would print a stray
        // backslash or break the message.
        for (const batch of batches(fresh, (p) => `${escapeMarkdown(connectionProblemTitle(p))}\n${escapeMarkdown(connectionProblemText(p))}`, '\n\n', `${FRESH_HEADER}\n`)) {
          const res = await tg.send(batch.text);
          if (!res.ok) {
            deps.log(`Connection problem notice failed to send, will retry next sync: ${res.description ?? 'unknown error'}`);
            break;
          }
          next = [...next, ...batch.items];
        }
        let clearedFailed = false;
        for (const batch of batches(cleared, (p) => escapeMarkdown(connectionProblemClearedText(p)), '\n', '')) {
          if (!clearedFailed) {
            const res = await tg.send(batch.text);
            if (res.ok) continue;
            deps.log(`Connection problem cleared notice failed to send, will retry next sync: ${res.description ?? 'unknown error'}`);
            clearedFailed = true;
          }
          next = [...next, ...batch.items];
        }
      }
    }

    const nextRaw = JSON.stringify(next);
    if (nextRaw !== (raw ?? '[]')) await deps.setSecret(ANNOUNCED_PROBLEMS_SECRET_KEY, nextRaw);
  } catch (err) {
    deps.log(`Connection problem notice error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * What the notices should be driven by for one companion run. A run that
 * downloaded carries `connectionProblems` (or leaves it absent on purpose when
 * the record could not be read or written, and then nothing is sent). A run
 * that did NOT download (too soon, budget-limited, not configured) carries
 * none, yet the add-on may have written a fresh record since the last run, so
 * the record is read here: a failed read, an unparseable or a stale (over 48
 * hours) record yields undefined, exactly "read no record".
 */
export async function problemsForNotices(
  run: { downloaded: boolean; connectionProblems: ConnectionProblem[] | undefined },
  readRecord: () => Promise<string | null>,
  now: Date,
): Promise<ConnectionProblem[] | undefined> {
  if (run.downloaded) return run.connectionProblems;
  try {
    const record = parseConnectionProblems(await readRecord());
    if (!record || now.getTime() - Date.parse(record.checkedAt) > PROBLEM_RECORD_MAX_AGE_MS) return undefined;
    return shownConnectionProblems(record, now, { maxRecordAgeMs: PROBLEM_RECORD_MAX_AGE_MS });
  } catch {
    return undefined;
  }
}
