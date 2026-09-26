/**
 * Constants of the `pnpm create-version` tooling that publishes beez-rp itself.
 *
 * @module scripts/constants/release
 */

/** Branch that receives releases. */
export const MAIN_BRANCH = "main";

/** Remote that receives releases. */
export const RELEASE_REMOTE = "origin";

/** Remote-tracking ref of the release branch. */
export const REMOTE_MAIN_REF = `${RELEASE_REMOTE}/${MAIN_BRANCH}`;

/** Width of the `git status --porcelain` state columns before each path. */
export const PORCELAIN_STATUS_WIDTH = 3;

/** Separates fields inside one `git log --format` record. */
export const FIELD_SEPARATOR = "\x1f";

/** Separates records in `git log --format` output. */
export const RECORD_SEPARATOR = "\x1e";

/** Stable identifiers of every step the release command knows how to run. */
export const RELEASE_STEP = Object.freeze({
  syncMain: "sync-main",
  runChecks: "run-checks",
  generateChangelog: "generate-changelog",
  bumpVersion: "bump-version",
  pushRelease: "push-release",
  publishPackage: "publish-package",
});

/** What the release command does with the current state. */
export const RELEASE_MODE = Object.freeze({
  newRelease: "new-release",
  resume: "resume",
  upToDate: "up-to-date",
  blocked: "blocked",
});

/** Result of asking npm which versions of the package exist. */
export const NPM_LOOKUP_STATUS = Object.freeze({
  ok: "ok",
  failed: "failed",
});

/** Valid npm package name (optionally scoped), checked before it reaches a shell command line. */
export const NPM_PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

/** npm error code of a package that was never published. */
export const NPM_NOT_FOUND_CODE = "E404";

/** Environment variable that holds the npm token; the repository `.npmrc` references it as `${NPM_TOKEN}`. */
export const NPM_TOKEN_VARIABLE = "NPM_TOKEN";

/** npm dist-tag every stable release is published under. */
export const NPM_DIST_TAG = "latest";

/** Command that validates the package before a release. */
export const CHECK_COMMAND = "pnpm check";

/** Environment file that may hold `NPM_TOKEN` locally; ignored by Git. */
export const LOCAL_ENVIRONMENT_FILE = ".env";

/** Readers of the changelog, as written in the Codex prompt. */
export const CHANGELOG_AUDIENCE = "quien consume el paquete beez-rp";

/** Maximum commits listed in a box. */
export const MAX_LISTED_COMMITS = 12;

/** Maximum uncommitted files listed in a blocker. */
export const MAX_LISTED_CHANGES = 5;

/** Exit code of a release stopped by a failed step. */
export const FAILURE_EXIT_CODE = 1;

/** `version` field of `package.json`, replaced in place to keep formatting. */
export const PACKAGE_VERSION_FIELD_PATTERN = /("version"\s*:\s*")[^"]+(")/;
