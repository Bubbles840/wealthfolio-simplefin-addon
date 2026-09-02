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
export const SIMPLEFIN_SYNC_VERSION = '1.33.0';

/** Addon secret the companion writes its version to, so the Sync page can show
 *  which daemon build is actually running against this instance — the two are
 *  deployed separately and can legitimately differ. */
export const COMPANION_VERSION_SECRET_KEY = 'companion_version';
