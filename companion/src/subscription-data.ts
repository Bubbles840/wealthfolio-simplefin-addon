/**
 * companion/src/subscription-data.ts
 *
 * The roster as every companion surface sees it: the published cube plus the
 * stored subscription document, built for one `today`. One reader, so the
 * weekly line, the morning block, /subscriptions and its buttons cannot
 * disagree about what counts.
 */
import { parseReportCube, REPORT_CUBE_SECRET_KEY } from '../../shared/report-cube.js';
import { loadSubscriptionPrefs, type SecretGet, type SubscriptionPrefs } from '../../shared/subscription-prefs.js';
import { buildRoster, type Roster } from '../../shared/subscription-roster.js';

export interface RosterRead {
  roster: Roster;
  /** What the roster was built from — the menu's undo paths read `deleted` and `prevNames`. */
  prefs: SubscriptionPrefs;
  /** The stored document is corrupt: `prefs` is the legacy lists and writes are refused. */
  unreadable: boolean;
  today: string;
}

/** Rejects when Wealthfolio cannot be read; callers choose silence (a report)
 *  or "Couldn't reach Wealthfolio — try again." (a tap). */
export async function readSubscriptionRoster(get: SecretGet, today: string): Promise<RosterRead> {
  const [cubeRaw, loaded] = await Promise.all([get(REPORT_CUBE_SECRET_KEY), loadSubscriptionPrefs(get)]);
  const cube = parseReportCube(cubeRaw);
  const roster = buildRoster({
    detected: cube?.subscriptions ?? null,
    merchants: cube?.merchants ?? [],
    links: cube?.subscriptionLinks ?? [],
    prefs: loaded.prefs,
    today,
  });
  return { roster, prefs: loaded.prefs, unreadable: loaded.unreadable, today };
}
