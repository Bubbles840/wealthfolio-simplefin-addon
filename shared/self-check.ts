/**
 * shared/self-check.ts
 *
 * The scheduled half of `/status`.
 *
 * Every signal here was already published and already readable — but only by
 * PULLING, and a pull only happens when the reader already suspects something.
 * The failures this project keeps hitting are the ones nobody thought to check
 * for: a report that never arrived, an account that silently stopped syncing,
 * a feed that went stale weeks before the balance looked wrong. Their single
 * shared property is that absence is the only symptom, and absence is
 * invisible to someone busy.
 *
 * So the checks run on their own and speak up in the daily report — the one
 * message already being read. Not a new notification channel: a second stream
 * of alerts is a stream that gets muted, and a muted channel is worse than no
 * channel because it looks like coverage.
 *
 * Everything here is pure. The companion gathers the inputs (it already does,
 * for `/status`) and renders the result; deciding what counts as wrong is
 * separated from both so it can be tested as a table of cases rather than
 * through a Telegram send.
 */

/** How long a sync can go missing before it is worth saying so. Comfortably
 *  past the 4-hour default schedule, so an ordinary skipped run — a container
 *  restart, a laptop asleep — never cries wolf. */
export const SYNC_STALE_HOURS = 12;

/** How long an account's own SimpleFin balance can sit unchanged before the
 *  feed is treated as stale. Banks legitimately go quiet over a weekend or a
 *  holiday; two weeks is past any of that and means the connection itself has
 *  stopped delivering, which SimpleFin does not report as an error. */
export const FEED_STALE_DAYS = 14;

export type SelfCheckSeverity = 'problem' | 'warning';

export interface SelfCheckFinding {
  /** Stable identifier for the KIND of problem, so a caller can suppress or
   *  count them without matching on prose. */
  kind:
    | 'sync-failing'
    | 'sync-stale'
    | 'unmapped-accounts'
    | 'feed-stale'
    | 'signals-unreadable';
  severity: SelfCheckSeverity;
  /** One line, already user-facing. No Markdown: the caller escapes and
   *  decorates, because the same finding is rendered in two places. */
  message: string;
}

export interface SelfCheckInput {
  /** ISO timestamp of the last SUCCESSFUL sync; null = never synced. */
  lastSuccessAt: string | null;
  /** ISO timestamp the current failure streak began; absent = not failing. */
  firstFailedAt?: string | null;
  lastError?: string | null;
  /** True when the health record could not be read at all — which is NOT the
   *  same as "never synced", and must not be reported as one. */
  healthUnreadable?: boolean;
  /** SimpleFin accounts with no Wealthfolio mapping, already filtered of the
   *  ones the user chose to ignore. */
  unmappedAccountNames?: readonly string[];
  /** Per-account feed freshness. `balanceDate` is a Unix SECONDS timestamp, as
   *  SimpleFin reports it; null = SimpleFin gave no date for this account. */
  accounts?: ReadonlyArray<{ name: string; balanceDate: number | null }>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Decides what, if anything, is wrong. Returns findings most severe first.
 *
 * An empty array means every check ran and passed — deliberately distinct from
 * a `signals-unreadable` finding, which means the checks could not run. The
 * daily report renders those two very differently, because "all clear" is a
 * claim and an unreadable signal does not support one. This is the same
 * distinction `/status` already draws between "Last sync: never" and "could
 * not read", and getting it wrong is how a dead connection reads as healthy.
 */
export function evaluateSelfCheck(input: SelfCheckInput, now: Date): SelfCheckFinding[] {
  const findings: SelfCheckFinding[] = [];

  if (input.healthUnreadable) {
    findings.push({
      kind: 'signals-unreadable',
      severity: 'warning',
      message: 'could not read sync status — health unknown, not confirmed healthy',
    });
  } else if (input.firstFailedAt) {
    const hours = Math.round((now.getTime() - Date.parse(input.firstFailedAt)) / HOUR_MS);
    const detail = input.lastError ? ` — ${input.lastError}` : '';
    findings.push({
      kind: 'sync-failing',
      severity: 'problem',
      message: `sync has been failing for ${hours}h${detail}`,
    });
  } else if (input.lastSuccessAt) {
    const hours = (now.getTime() - Date.parse(input.lastSuccessAt)) / HOUR_MS;
    // A future timestamp means a clock disagreement, not a stale sync. Reading
    // it as "-3h stale" would be a false alarm about the wrong thing.
    if (hours >= SYNC_STALE_HOURS) {
      findings.push({
        kind: 'sync-stale',
        severity: 'problem',
        message: `no successful sync in ${Math.round(hours)}h`,
      });
    }
  }

  const unmapped = input.unmappedAccountNames ?? [];
  if (unmapped.length > 0) {
    // Named, not counted: "1 account is not syncing" prompts a hunt through the
    // addon, and the name is the entire answer.
    findings.push({
      kind: 'unmapped-accounts',
      severity: 'problem',
      message: unmapped.length === 1
        ? `${unmapped[0]} is not mapped, so nothing from it is syncing`
        : `${unmapped.length} accounts are not mapped, so nothing from them is syncing: ${unmapped.join(', ')}`,
    });
  }

  const stale: string[] = [];
  for (const account of input.accounts ?? []) {
    // No date is not a stale date. SimpleFin omits it for some accounts, and
    // treating "unknown" as "old" would flag them forever with no way to fix it.
    if (typeof account.balanceDate !== 'number' || !Number.isFinite(account.balanceDate)) continue;
    const days = (now.getTime() - account.balanceDate * 1000) / DAY_MS;
    if (days >= FEED_STALE_DAYS) stale.push(account.name);
  }
  if (stale.length > 0) {
    findings.push({
      kind: 'feed-stale',
      severity: 'warning',
      message: stale.length === 1
        ? `${stale[0]} has sent no new data in over ${FEED_STALE_DAYS} days`
        : `${stale.length} accounts have sent no new data in over ${FEED_STALE_DAYS} days: ${stale.join(', ')}`,
    });
  }

  const rank: Record<SelfCheckSeverity, number> = { problem: 0, warning: 1 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Renders the findings as a block for the daily report, or '' when there is
 * nothing to say.
 *
 * Silence on success is deliberate. The report already carries a `✅ synced Nh
 * ago` footer, so an extra "all systems normal" block would be a second line
 * saying the same thing — and a reassurance printed every single day stops
 * being read long before the day it is wrong.
 */
export function formatSelfCheckBlock(findings: readonly SelfCheckFinding[]): string {
  if (findings.length === 0) return '';
  const lines = findings.map((f) => `${f.severity === 'problem' ? '🚨' : '⚠️'} ${f.message}`);
  return `*Needs attention*\n${lines.join('\n')}`;
}
