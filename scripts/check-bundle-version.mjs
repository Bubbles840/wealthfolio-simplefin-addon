/**
 * Refuse to package an addon bundle compiled from a different version.
 *
 * The zip is `manifest.json` + `dist/addon.js`, and only the manifest was ever
 * checked. A `package` run without a fresh build therefore shipped whatever
 * `dist/addon.js` was lying around under a new version number: the v1.53.0 zip
 * built on a laptop carried the v1.49.0 bundle, so the Sync page footer read
 * "addon v1.49.0" beside "companion v1.53.0" and none of the addon-side fixes
 * from v1.50 through v1.53 ever ran. `package` now builds first; this is the
 * tripwire that fails loudly if anything ever packs a stale bundle again.
 *
 * The footer renders the compiled constant as `"addon v", <ident>`, declared
 * `const <ident> = "x.y.z"` — resolved through that identifier, because a bare
 * version-looking search also matches bundled libraries' own version strings.
 */
import { readFileSync } from 'node:fs';

const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).version;
const js = readFileSync(new URL('../dist/addon.js', import.meta.url), 'utf8');

const literal = js.match(/"addon v",\s*"(\d+\.\d+\.\d+)"/)?.[1];
const ident = js.match(/"addon v",\s*([A-Za-z_$][\w$]*)/)?.[1];
const declared = ident
  ? js.match(new RegExp(`(?:^|[^\\w$])${ident.replace(/\$/g, '\\$')}\\s*=\\s*"(\\d+\\.\\d+\\.\\d+)"`))?.[1]
  : undefined;
const compiled = literal ?? declared;

const problems = [];
if (!compiled) problems.push('could not find the version compiled into dist/addon.js');
else if (compiled !== expected) problems.push(`dist/addon.js was compiled as v${compiled}, package.json is v${expected}`);
if (manifest !== expected) problems.push(`manifest.json is v${manifest}, package.json is v${expected}`);
if (problems.length) {
  console.error(`✗ refusing to package:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`✓ dist/addon.js is v${compiled}`);
