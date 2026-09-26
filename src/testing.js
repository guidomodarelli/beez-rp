/**
 * Version bump fixtures for the test suites of every repository that uses
 * `beez-rp`, so `create-version`, the Vercel build gate and any custom release
 * command are checked against the same rule: from a stable version only the
 * next patch, minor or major is allowed.
 *
 * @module testing
 */

/** Stable version every fixture bumps from. */
export const CURRENT_STABLE_VERSION = "1.2.3";

/** The only versions allowed after {@link CURRENT_STABLE_VERSION}: next patch, minor and major. */
export const ALLOWED_NEXT_VERSIONS = Object.freeze(["1.2.4", "1.3.0", "2.0.0"]);

/** Every rejected kind of bump from {@link CURRENT_STABLE_VERSION}, grouped by why it is rejected. */
export const REJECTED_VERSION_BUMPS = Object.freeze({
  unchanged: Object.freeze(["1.2.3"]),
  lower: Object.freeze(["1.2.2", "1.1.9", "0.9.9", "1.2.0", "0.0.1"]),
  "skips patches": Object.freeze(["1.2.5", "1.2.10"]),
  "skips minors": Object.freeze(["1.4.0", "1.10.0"]),
  "skips majors": Object.freeze(["3.0.0", "10.0.0"]),
  "minor bump without resetting the patch": Object.freeze(["1.3.3", "1.3.1"]),
  "major bump without resetting minor and patch": Object.freeze(["2.2.3", "2.0.3", "2.3.0", "2.0.1"]),
  prerelease: Object.freeze([
    "1.2.4-alpha",
    "1.2.4-alpha.1",
    "1.3.0-beta.2",
    "2.0.0-rc.1",
    "1.2.4-canary.0",
    "1.2.4-next.3",
    "1.2.4-dev",
    "1.2.4-snapshot",
    "1.2.4-0",
    "1.2.4-alpha.beta.1",
    "1.2.4-SNAPSHOT-20260926",
  ]),
  "build metadata": Object.freeze(["1.2.4+build.5", "1.3.0+sha.8fc0245", "2.0.0-beta.1+exp"]),
  "not a plain X.Y.Z": Object.freeze([
    "1.3",
    "2",
    "1.2.4.0",
    "01.2.4",
    "1.02.4",
    "1.3.00",
    "x.y.z",
    "1.2.x",
    "latest",
    "",
    " 1.2.4",
    "1.2.4 ",
    "v1.2.4",
    "V1.2.4",
    "^1.2.4",
    "~1.3.0",
    ">=2.0.0",
    "1.2.4 || 1.3.0",
  ]),
});

/**
 * All rejected bumps as `[reason, version]` pairs for table-driven tests.
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const REJECTED_VERSION_BUMP_CASES = Object.freeze(
  Object.entries(REJECTED_VERSION_BUMPS).flatMap(([reason, versions]) =>
    versions.map((version) => /** @type {const} */ ([reason, version]))
  )
);
