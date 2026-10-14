/**
 * shared/compose-snippet.ts
 *
 * The companion's Docker Compose service, written ONCE (project 4, G1). There
 * were three copies and they disagreed: the README's (bridge network, TZ), the
 * example file's (the same plus `user` and an external network) and the
 * Settings card's (host network, `127.0.0.1`, and no TZ — which the companion
 * warns about at startup). Now the Settings card "Background sync (Docker)"
 * renders this with the browser's timezone, and README.md and
 * docker-compose.example.yml carry its default output verbatim;
 * shared/compose-snippet.test.ts fails when either drifts.
 *
 * Never a password: the password is read from a Compose secret
 * (`WEALTHFOLIO_PASSWORD_FILE`), with an API key as the commented alternative.
 * The README's bridge style — Wealthfolio's service name resolves on the
 * shared Compose network — with host networking as a comment. The database
 * mount is the FOLDER, read-only: the live read needs the -wal/-shm files
 * beside wealthfolio.db (see companion/src/sqlite-native.ts), and a file-only
 * mount silently serves whatever was last checkpointed, observed two days
 * stale.
 */

export const COMPANION_IMAGE = 'ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest';
/** Wealthfolio's service name and default port, on a shared Compose network. */
export const DEFAULT_WEALTHFOLIO_URL = 'http://wealthfolio:8088';
/** What the snippet carries when the browser's timezone is unknown. */
export const DEFAULT_TIMEZONE = 'America/New_York';

export interface ComposeSnippetOptions {
  /** An IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
   *  Absent, or not a zone name: America/New_York, with a comment to change it. */
  timezone?: string | null;
  /** Absent, or not an http(s) URL: http://wealthfolio:8088. */
  wealthfolioUrl?: string | null;
}

/** An IANA name (`Europe/Berlin`, `America/Argentina/Buenos_Aires`, `Etc/GMT+5`,
 *  `UTC`) — nothing a YAML line could choke on. */
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const WEB_URL = /^https?:\/\/[^\s#'"]+$/;

export function composeSnippet(options: ComposeSnippetOptions = {}): string {
  const zone = (options.timezone ?? '').trim();
  const url = (options.wealthfolioUrl ?? '').trim();
  return [
    'services:',
    '  simplefin-sync:',
    `    image: ${COMPANION_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    WEB_URL.test(url)
      ? `      - WEALTHFOLIO_API_URL=${url}`
      : `      - WEALTHFOLIO_API_URL=${DEFAULT_WEALTHFOLIO_URL}   # Wealthfolio's service name and port`,
    '      - WEALTHFOLIO_PASSWORD_FILE=/run/secrets/wealthfolio_password',
    '      # Or sign in with an API key instead of the password:',
    '      # - WEALTHFOLIO_API_KEY=your_api_key',
    '      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db',
    ZONE.test(zone)
      ? `      - TZ=${zone}`
      : `      - TZ=${DEFAULT_TIMEZONE}   # change to your timezone, or every schedule runs on UTC`,
    '    secrets:',
    '      - wealthfolio_password',
    '    volumes:',
    '      # The FOLDER holding wealthfolio.db, read-only. A file-only mount hides',
    '      # the -wal/-shm files beside it, so the companion reads stale data.',
    '      - /path/to/wealthfolio:/mnt/wealthfolio:ro',
    '    # Wealthfolio on the host network instead? Uncomment the next line and',
    '    # set WEALTHFOLIO_API_URL=http://127.0.0.1:8088 above.',
    '    # network_mode: host',
    '',
    'secrets:',
    '  wealthfolio_password:',
    "    file: ./wealthfolio_password.txt   # Wealthfolio's password, on one line",
  ].join('\n');
}
