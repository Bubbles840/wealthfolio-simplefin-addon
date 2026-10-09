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
import { formatDollars } from './telegram.js';

/** How long a sync can go missing before it is worth saying so. Comfortably
 *  past the 4-hour default schedule, so an ordinary skipped run — a container
 *  restart, a laptop asleep — never cries wolf. */
export const SYNC_STALE_HOURS = 12;

/** How long an account's own SimpleFin balance can sit unchanged before the
 *  feed is treated as stale. Banks legitimately go quiet over a weekend or a
 *  holiday; two weeks is past any of that and means the connection itself has
 *  stopped delivering, which SimpleFin does not report as an error. */
export const FEED_STALE_DAYS = 14;

/** How long a balance difference can be the bank's feed catching up. The same
 *  ten days after which the sync's own drift alert escalated, and after which
 *  the one-click baseline fix is offered. */
export const DRIFT_AGED_DAYS = 10;

export type SelfCheckSeverity = 'problem' | 'warning';

export interface SelfCheckFinding {
  /** Stable identifier for the KIND of problem, so a caller can suppress or
   *  count them without matching on prose. */
  kind:
    | 'sync-failing'
    | 'sync-stale'
    | 'unmapped-accounts'
    | 'feed-stale'
    | 'signals-unreadable'
    | 'version-skew'
    /** A non-card account whose balance differs from the bank's (cards have
     *  the ledger audit's own `card-balance` check). */
    | 'balance-drift'
    /** A finding from `shared/ledger-checks.ts`: the row-level audit. */
    | 'ledger';
  severity: SelfCheckSeverity;
  /** One line, already user-facing. No Markdown: the caller escapes and
   *  decorates, because the same finding is rendered in two places. */
  message: string;
  /**
   * Which condition this is, stable across days — kind plus subject. It is
   * what a snooze remembers and what a tapped button finds the finding by
   * again, so it must not contain anything that changes while the condition
   * stays the same (an age in days, say). Absent = cannot be snoozed.
   */
  key?: string;
  /** A short name for a button, under ~40 characters. Falls back to the
   *  message when absent. */
  label?: string;
  /** A repair the Telegram menu can offer for this finding, when one exists. */
  fix?: FindingFix;
}

/**
 * The repairs a tap can make. Each hands off to a flow that already exists and
 * already previews before it writes — no finding gets a one-tap write of its
 * own, because the findings are judged from a read-only database snapshot and a
 * write built on a stale snapshot is how a fix becomes a second problem.
 */
export type FindingFix =
  /** Write a mapping rule through the transfer-learning confirm step. A bare
   *  retype would not stick: the sync rewrites any row whose stored type
   *  differs from what the feed resolves to. */
  | { kind: 'make-transfer'; activityId: string; description: string; amount: number; activityType: string }
  /** Open the category picker on exactly this transaction. */
  | { kind: 'pick-category'; activityId: string };

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
   *  SimpleFin reports it; null = SimpleFin gave no date for this account.
   *  `drift` is bank − Wealthfolio in dollars, set by the sync only past the
   *  alert threshold; `driftSince` is when that difference was first seen. */
  accounts?: ReadonlyArray<{
    /** The SimpleFin account id — what tells two same-named accounts apart. */
    id?: string;
    name: string;
    balanceDate: number | null;
    drift?: number | null;
    driftSince?: string | null;
  }>;
  /** The two halves' versions, as each publishes them. The addon's is absent
   *  on zips older than 1.34.0 (they never wrote it), and absence must stay
   *  quiet — flagging it would alarm every companion-first updater forever. */
  addonVersion?: string | null;
  companionVersion?: string | null;
  /**
   * The version in the INSTALLED addon's manifest, read off disk by the
   * companion. Distinct from `addonVersion`, and the distinction is the point:
   * that one is written when the bundle LOADS in a browser, so it means "the
   * newest build that has ever run", which a tab pinned open for a week keeps
   * stale however many zips are uploaded underneath it. Absent when the addons
   * directory is not mounted, in which case the two remedies cannot be told
   * apart and the warning says both.
   */
  installedAddonVersion?: string | null;
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

  // Two accounts can share a display name (two "CHECKING"s at two banks). A
  // finding's key is what a snooze and a button find it by, so those get the
  // id in the key and a short id in the text; a unique name keeps the plain
  // key, so a snooze taken before 1.57.1 still holds.
  const nameCounts = new Map<string, number>();
  for (const a of input.accounts ?? []) nameCounts.set(a.name, (nameCounts.get(a.name) ?? 0) + 1);
  const shared = (a: { id?: string; name: string }) => (nameCounts.get(a.name) ?? 0) > 1 && !!a.id;
  const keyName = (a: { id?: string; name: string }) => (shared(a) ? `${a.name}#${a.id}` : a.name);
  const shownName = (a: { id?: string; name: string }) => (shared(a) ? `${a.name} (…${a.id!.slice(-4)})` : a.name);

  for (const account of input.accounts ?? []) {
    // No date is not a stale date. SimpleFin omits it for some accounts, and
    // treating "unknown" as "old" would flag them forever with no way to fix it.
    if (typeof account.balanceDate !== 'number' || !Number.isFinite(account.balanceDate)) continue;
    const days = (now.getTime() - account.balanceDate * 1000) / DAY_MS;
    if (days < FEED_STALE_DAYS) continue;
    // One finding PER ACCOUNT, not one naming them all: each is snoozed on its
    // own, and a snooze of "Discover is dead, I know" must not also silence a
    // second feed that dies next week.
    findings.push({
      kind: 'feed-stale',
      severity: 'warning',
      key: `feed-stale:${keyName(account)}`,
      label: `${shownName(account)}: no new data`,
      // The remedy, not just the symptom: a dead feed also holds any transfer
      // that names it open indefinitely (see expiryHoldAccount in sync-core).
      message: `${shownName(account)} has sent no new data in over ${FEED_STALE_DAYS} days — reconnect it in SimpleFin, or unmap it here if the account is closed`,
    });
  }

  for (const account of input.accounts ?? []) {
    const drift = account.drift;
    if (typeof drift !== 'number' || !Number.isFinite(drift) || drift === 0) continue;
    // Only an OPEN alert episode dates a drift, and one opens only past the
    // user's alert threshold (never when alerts are off). `drift` alone is
    // recorded from $1, for the balance chips — far too small to nag about.
    const since = account.driftSince ? Date.parse(account.driftSince) : NaN;
    if (!Number.isFinite(since)) continue;
    const aged = now.getTime() - since >= DRIFT_AGED_DAYS * DAY_MS;
    const lead = `${shownName(account)} is ${formatDollars(Math.abs(drift), 2)} ${drift > 0 ? 'below' : 'above'} the bank's balance`;
    findings.push({
      kind: 'balance-drift',
      // A warning either way, so it folds into the 🧹 count and can be
      // snoozed: the separate aged alert it replaces was said once, and a
      // problem prints in full every morning. Young, it is usually the bank's
      // balance running ahead of its own transaction list, so it asks for
      // nothing until it has outlived that.
      severity: 'warning',
      key: `balance-drift:${keyName(account)}`,
      label: `${shownName(account)}: balance differs`,
      message: aged
        ? `${lead} — for over ${DRIFT_AGED_DAYS} days, so it is more than feed lag. Open SimpleFin Sync to line them up`
        : `${lead} — usually the bank's feed catching up; it clears on its own`,
    });
  }

  // Only when BOTH are known and disagree: the image and the zip deploy
  // separately, and a half-finished update is silent everywhere except the
  // Sync page footer nobody re-visits after updating.
  const { addonVersion: running, installedAddonVersion: installed, companionVersion: companion } = input;
  if (companion && installed && installed !== companion) {
    // The manifest on disk is old: nothing the browser does can fix that, so
    // the reload hint would only send the user the wrong way.
    findings.push({
      kind: 'version-skew',
      severity: 'warning',
      key: `version-skew:installed:${installed}:${companion}`,
      label: `Upload the v${companion} addon zip`,
      message: `the installed addon is v${installed} but the companion is v${companion}`
        + ` — upload simplefin-sync-${companion}.zip in Wealthfolio's addon settings`,
    });
  } else if (companion && installed && installed === companion) {
    // The right zip IS installed. A tab still running an older bundle is no
    // longer reported here: `running` is the most recent build to LOAD, so it
    // also reads stale for someone who simply has not opened Wealthfolio since
    // updating — the morning report then nagged about a tab that did not exist
    // (2026-10). From 1.57.0 the stale tab says so itself, in a banner, which
    // is the one place a stale tab can actually be seen and refreshed.
  } else if (!installed && running && companion && running !== companion) {
    // No manifest to consult (the addons directory is not mounted), so the two
    // causes cannot be told apart and the message has to offer both. The
    // reload hint is load-bearing: a tab pinned open for days keeps reporting
    // the build it loaded — a correct warning that read as a false one
    // (2026-09-06).
    findings.push({
      kind: 'version-skew',
      severity: 'warning',
      key: `version-skew:running:${running}:${companion}`,
      label: 'Addon and companion versions differ',
      message: `addon v${running} and companion v${companion} are different builds`
        + ' — finish the update (pull the image AND upload the matching zip), or reload the Wealthfolio tab if you already have',
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
  const lines = findings.map((f) => `${f.severity === 'problem' ? '🚨' : '⚠️'} ${escapeFindingText(f.message)}`);
  return `*Needs attention*\n${lines.join('\n')}`;
}

/** Legacy-Markdown specials in a finding's text. The messages carry bank
 *  descriptors and account names verbatim, and one stray underscore in a
 *  payee is enough for Telegram to reject the whole report with a 400. Local
 *  rather than imported from ./telegram.ts so this module stays dependency-free
 *  (the addon bundle imports it too). */
export function escapeFindingText(text: string): string {
  return text.replace(/([_*`[])/g, '\\$1');
}

/**
 * Whether a finding prints in full in the morning report, or is folded into
 * the "things to fix" count behind a button.
 *
 * Problems are the reason the block exists — a sync that is failing, an
 * account syncing nothing — and folding one into a count would bury exactly the
 * thing the self-check was built to shout. An unreadable health signal rides
 * with them: it is not a chore, it is "nothing below can be trusted".
 */
export function printsInFull(f: SelfCheckFinding): boolean {
  return f.severity === 'problem' || f.kind === 'signals-unreadable';
}

/**
 * The morning report's version of the block: problems in full, everything else
 * as ONE line counting it, with the list behind a button the caller attaches.
 *
 * Chosen 2026-10 after the block grew to seven lines on an ordinary day and
 * became most of the message. The chores are still announced every morning —
 * the count never hides that they exist — but reading them is a tap, not a
 * scroll past them to reach the day's spending.
 */
export function formatFindingsSummary(findings: readonly SelfCheckFinding[]): string {
  const full = findings.filter(printsInFull);
  const folded = findings.length - full.length;
  const lines = full.map((f) => `${f.severity === 'problem' ? '🚨' : '⚠️'} ${escapeFindingText(f.message)}`);
  const count = folded > 0 ? `🧹 *${folded} ${folded === 1 ? 'thing' : 'things'} to fix*` : '';
  if (lines.length === 0) return count;
  return `*Needs attention*\n${lines.join('\n')}${count ? `\n${count}` : ''}`;
}
