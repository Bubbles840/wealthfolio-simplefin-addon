import {
  connectionProblemClearedText,
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
      if (tg) {
        if (fresh.length > 0) {
          const text = fresh
            .map((p) => `*${escapeMarkdown(connectionProblemTitle(p))}*\n${escapeMarkdown(connectionProblemText(p))}`)
            .join('\n\n');
          const res = await tg.send(text);
          if (res.ok) next = [...next, ...fresh];
          else deps.log(`Connection problem notice failed to send, will retry next sync: ${res.description ?? 'unknown error'}`);
        }
        if (cleared.length > 0) {
          const res = await tg.send(cleared.map((p) => escapeMarkdown(connectionProblemClearedText(p))).join('\n'));
          if (!res.ok) {
            deps.log(`Connection problem cleared notice failed to send, will retry next sync: ${res.description ?? 'unknown error'}`);
            next = [...next, ...cleared];
          }
        }
      }
    }

    const nextRaw = JSON.stringify(next);
    if (nextRaw !== (raw ?? '[]')) await deps.setSecret(ANNOUNCED_PROBLEMS_SECRET_KEY, nextRaw);
  } catch (err) {
    deps.log(`Connection problem notice error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
