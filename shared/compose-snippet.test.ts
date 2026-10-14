import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { composeSnippet, COMPANION_IMAGE, DEFAULT_TIMEZONE, DEFAULT_WEALTHFOLIO_URL } from './compose-snippet.js';

const root = join(__dirname, '..');
const DEFAULT_TZ_LINE = `      - TZ=${DEFAULT_TIMEZONE}   # change to your timezone, or every schedule runs on UTC\n`;

describe('composeSnippet', () => {
  it("is the service the README always described: the image, a restart policy, Wealthfolio's service name", () => {
    const s = composeSnippet();
    expect(s.split('\n').slice(0, 5)).toEqual([
      'services:', '  simplefin-sync:', `    image: ${COMPANION_IMAGE}`, '    restart: unless-stopped', '    environment:',
    ]);
    expect(s).toContain(`      - WEALTHFOLIO_API_URL=${DEFAULT_WEALTHFOLIO_URL}   # Wealthfolio's service name and port\n`);
    // Host networking only as a comment: the bridge style is the default.
    expect(s).toContain('    # network_mode: host\n');
    expect(s).not.toMatch(/^\s*network_mode:/m);
  });

  it('reads the password from a Compose secret and never carries one', () => {
    const s = composeSnippet({ timezone: 'Europe/Berlin' });
    expect(s).toContain('      - WEALTHFOLIO_PASSWORD_FILE=/run/secrets/wealthfolio_password\n');
    expect(s).toContain('    secrets:\n      - wealthfolio_password\n');
    expect(s.endsWith("secrets:\n  wealthfolio_password:\n    file: ./wealthfolio_password.txt   # Wealthfolio's password, on one line")).toBe(true);
    // The API key is the commented alternative.
    expect(s).toContain('      # - WEALTHFOLIO_API_KEY=your_api_key\n');
    expect(s).not.toMatch(/^\s*- WEALTHFOLIO_API_KEY=/m);
    expect(s).not.toMatch(/WEALTHFOLIO_PASSWORD=/);
  });

  it('mounts the database FOLDER read-only, where WEALTHFOLIO_DB_PATH looks', () => {
    const s = composeSnippet();
    expect(s).toContain('      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db\n');
    expect(s).toContain('      - /path/to/wealthfolio:/mnt/wealthfolio:ro\n');
    // Never the bare .db file: a file-only mount hides the -wal/-shm files.
    expect(s).not.toMatch(/wealthfolio\.db:\/mnt/);
  });

  it('fills in a timezone it is given, and says to change the default otherwise', () => {
    expect(composeSnippet({ timezone: 'America/Argentina/Buenos_Aires' })).toContain('      - TZ=America/Argentina/Buenos_Aires\n');
    expect(composeSnippet({ timezone: 'Etc/GMT+5' })).toContain('      - TZ=Etc/GMT+5\n');
    expect(composeSnippet({ timezone: ' UTC ' })).toContain('      - TZ=UTC\n');
    for (const timezone of [undefined, null, '', '   ', 'not a zone', 'Europe/Berlin # x', 'a\nb', '/Berlin']) {
      expect(composeSnippet({ timezone })).toContain(DEFAULT_TZ_LINE);
    }
  });

  it('takes a Wealthfolio URL, keeping the default for anything that is not one', () => {
    expect(composeSnippet({ wealthfolioUrl: 'http://192.168.1.20:8088' })).toContain('      - WEALTHFOLIO_API_URL=http://192.168.1.20:8088\n');
    for (const wealthfolioUrl of [null, '', 'wealthfolio:8088', 'http://x y', 'ftp://x', 'http://x#y']) {
      expect(composeSnippet({ wealthfolioUrl })).toContain(`      - WEALTHFOLIO_API_URL=${DEFAULT_WEALTHFOLIO_URL}   #`);
    }
  });
});

describe('the committed copies (drift check)', () => {
  it('README.md shows exactly the default snippet, once', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const blocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('simplefin-sync'));
    expect(blocks).toEqual([`${composeSnippet()}\n`]);
  });

  it('docker-compose.example.yml is exactly the default snippet', () => {
    expect(readFileSync(join(root, 'docker-compose.example.yml'), 'utf8')).toBe(`${composeSnippet()}\n`);
  });
});
