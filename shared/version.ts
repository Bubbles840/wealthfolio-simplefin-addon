/**
 * shared/version.ts
 *
 * The one version number that describes a build of BOTH halves.
 *
 * Why this exists rather than reading a package.json: the companion's
 * `companion/package.json` is the container's dependency manifest and has read
 * `1.0.1` since the project started. On 2026-08-06 that number was mistaken for
 * the product version while diagnosing a live problem, and the only honest way
 * to identify the running build turned out to be grepping compiled JavaScript
 * for a feature-specific string. A browser bundle also cannot read a file at
 * runtime, so a literal that both halves import is the only shape that works
 * for the addon AND the daemon.
 *
 * `shared/version.test.ts` pins this against `manifest.json` and `package.json`,
 * so a release that bumps those and forgets this one fails the suite instead of
 * shipping a lie.
 */
export const SIMPLEFIN_SYNC_VERSION = '1.64.0';

/** Addon secret the companion writes its version to, so the Sync page can show
 *  which daemon build is actually running against this instance — the two are
 *  deployed separately and can legitimately differ. */
export const COMPANION_VERSION_SECRET_KEY = 'companion_version';

/** The mirror of the above: the addon writes ITS version here, so the
 *  companion's self-check can notice a half-finished update (image pulled,
 *  zip not — or the reverse) and say so in the daily report. */
export const ADDON_VERSION_SECRET_KEY = 'addon_version';

/**
 * True when `candidate` is a strictly newer x.y.z than `current`.
 *
 * Hand-rolled rather than a semver dependency because the candidate comes from
 * an external API response (GitHub's latest-release tag): anything that is not
 * a plain three-part number — a prerelease, an empty string, garbage — returns
 * false, so a malformed tag can never manufacture an "update available" line.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * The first release whose companion obeys `sync_overrides` (the change log's
 * Undo, R2). Undo of a SYNC decision only records an override and lets the
 * next sync act on it, so an older companion — which ignores the document —
 * would simply redo the decision. Until the companion publishes this version
 * or newer, the app disables those undos ("Update the companion first").
 * `shared/change-undo.test.ts` fails if a release ships below it.
 */
export const SYNC_OVERRIDES_SINCE = '1.60.0';

/** True when `companionVersion` obeys overrides. No companion at all (null)
 *  is true: nothing else is syncing that could ignore them. */
export function companionUnderstandsOverrides(companionVersion: string | null): boolean {
  if (companionVersion === null) return true;
  return companionVersion === SYNC_OVERRIDES_SINCE || isNewerVersion(companionVersion, SYNC_OVERRIDES_SINCE);
}

/**
 * The first release whose BOTH halves read `noVenmoNote`, the override a Venmo
 * note's Undo writes (ruling P3-K). The overrides reader of 1.60.0 and before is
 * strict: it reads a `sync_overrides` document holding a flag it does not know
 * as corrupt, and that half's sync then ignores EVERY override — `keepDuplicate`
 * (the duplicate prune may delete a copy you kept), `notTransfer` (re-pairs and
 * re-links), `noAmazonLabel` — until the flag is gone. So the app's Undo of a
 * Venmo note waits for a companion this new, and the companion's Telegram Undo
 * and Redo wait for an INSTALLED add-on this new (refused while it cannot tell).
 *
 * Raise to the release that ships this.
 */
export const VENMO_NOTE_SINCE = '1.61.0';

/** `version` is `min` or newer; anything not a plain x.y.z is not. */
export function isAtLeastVersion(version: string, min: string): boolean {
  return version === min || isNewerVersion(version, min);
}

/**
 * The first Wealthfolio that takes TRANSFER_OUT on a credit card (upstream
 * #1796, 3.10.0: `account_activity_validation_message`) — and whose Spending
 * page ignores an unlinked one (`classify_activity`, CREDIT_CARD `_ =>
 * Ignored`). From it on, the sync writes a card's bookkeeping outflows (an
 * opening debt, a balance plug, an in-transit placeholder) as TRANSFER_OUT,
 * neutral on Wealthfolio's own pages with no category at all (1.62.0, U4).
 */
export const CARD_TRANSFER_OUT_SINCE = '3.10.0';

/** Whether this Wealthfolio takes TRANSFER_OUT on a card. Unknown (null) is no. */
export function hostTakesCardTransferOut(wealthfolioVersion: string | null | undefined): boolean {
  return !!wealthfolioVersion && isAtLeastVersion(wealthfolioVersion.trim(), CARD_TRANSFER_OUT_SINCE);
}

/** The companion writes the Wealthfolio version it syncs against here (`GET
 *  /app/info`): the add-on's SDK has no way to ask, and its own sync shapes
 *  card bookkeeping by it. */
export const WEALTHFOLIO_VERSION_SECRET_KEY = 'wealthfolio_version';

/** The app's half: a companion that reads `noVenmoNote`. No companion at all
 *  (null) is true, as for `companionUnderstandsOverrides`. */
export function companionUnderstandsVenmoNotes(companionVersion: string | null): boolean {
  if (companionVersion === null) return true;
  return isAtLeastVersion(companionVersion, VENMO_NOTE_SINCE);
}

/** The companion's half: an installed add-on that reads `noVenmoNote`. Unknown
 *  (null — the companion cannot see the addons directory) is false. */
export function addonUnderstandsVenmoNotes(installedAddonVersion: string | null): boolean {
  return installedAddonVersion !== null && isAtLeastVersion(installedAddonVersion.trim(), VENMO_NOTE_SINCE);
}

/**
 * The first release whose BOTH halves read `asReimbursement`, the override a
 * payback sets (1.62.0, W6–W8). A reader of 1.61.0 keeps a flag it does not
 * know (it is not corruption, P3-B) but ignores it, so its sync would turn a
 * payback back into a deposit. So Telegram's payback, its Undo and its Redo —
 * and "Make every … deposit a payback" — wait for an INSTALLED add-on this
 * new (refused while the companion cannot tell), and the app's paybacks and
 * their Undo wait for a companion this new. The same pattern as
 * `VENMO_NOTE_SINCE`.
 *
 * Raise to the release that ships this.
 */
export const PAYBACK_SINCE = '1.62.0';

/** The app's half: a companion that reads `asReimbursement`. No companion at
 *  all (null) is true: nothing else is syncing that could ignore it. */
export function companionUnderstandsPaybacks(companionVersion: string | null): boolean {
  if (companionVersion === null) return true;
  return isAtLeastVersion(companionVersion.trim(), PAYBACK_SINCE);
}

/** The companion's half: an installed add-on that reads `asReimbursement`.
 *  Unknown (null — the companion cannot see the addons directory) is false. */
export function addonUnderstandsPaybacks(installedAddonVersion: string | null): boolean {
  return installedAddonVersion !== null && isAtLeastVersion(installedAddonVersion.trim(), PAYBACK_SINCE);
}

/** The companion writes the version in the INSTALLED addon's manifest here
 *  (read off disk), so a browser tab can tell "I am an old bundle — reload me"
 *  apart from "the old zip is still installed — upload the new one". */
export const INSTALLED_ADDON_VERSION_SECRET_KEY = 'installed_addon_version';

/**
 * What a browser tab running build `thisBuild` should say about itself, or
 * null when it is current.
 *
 * Shown by the stale tab ITSELF (from 1.57.0), which replaced a line in the
 * morning report: the report could not tell an open stale tab from no tab at
 * all, and nagged about a tab nobody had open. The tab is the one place a
 * stale tab can always be seen — and the one place it can be refreshed.
 *
 * `installed` is null when the companion cannot see the addons directory; the
 * advice then names both remedies, reload first because it is free.
 */
export function versionMismatchNotice(
  thisBuild: string,
  companion: string | null,
  installed: string | null,
): { tone: 'reload' | 'upload' | 'companion'; text: string } | null {
  if (!companion || companion === thisBuild) return null;
  if (isNewerVersion(thisBuild, companion)) {
    // This bundle is ahead: the image was not pulled.
    return {
      tone: 'companion',
      text: `This addon is v${thisBuild} but the companion is still v${companion} — pull the new companion image and restart it.`,
    };
  }
  if (!isNewerVersion(companion, thisBuild)) return null;
  if (installed === companion) {
    return {
      tone: 'reload',
      text: `This tab is running v${thisBuild}, but v${companion} is installed. Reload it (Cmd/Ctrl+Shift+R) — an old tab syncs with the old build's logic.`,
    };
  }
  if (installed && installed !== companion) {
    return {
      tone: 'upload',
      text: `The companion is v${companion} but the installed addon is v${installed}. Upload simplefin-sync-${companion}.zip in Wealthfolio's addon settings, then reload.`,
    };
  }
  return {
    tone: 'reload',
    text: `This tab is running v${thisBuild} and the companion is v${companion}. Reload this tab (Cmd/Ctrl+Shift+R); if this stays, upload simplefin-sync-${companion}.zip in Wealthfolio's addon settings.`,
  };
}
