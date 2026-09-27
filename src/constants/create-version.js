/**
 * Git, npm, configuration and display values of the shared `beez-rp create-version` command.
 *
 * @module constants/create-version
 */

/** Branch that receives releases. */
export const MAIN_BRANCH = "main";

/** Remote that receives releases. */
export const RELEASE_REMOTE = "origin";

/** Remote-tracking ref of the release branch. */
export const REMOTE_MAIN_REF = `${RELEASE_REMOTE}/${MAIN_BRANCH}`;

/** Configuration module read from the repository root. */
export const CREATE_VERSION_CONFIG_FILE = "beez-rp.config.js";

/**
 * Configuration candidates in lookup order: `.mjs` is always ESM, so projects
 * without `"type": "module"` load it without Node warnings.
 */
export const CREATE_VERSION_CONFIG_FILES = Object.freeze(["beez-rp.config.mjs", CREATE_VERSION_CONFIG_FILE]);

/** Manifest whose `version` is released; shared with the build gate. */
export { PACKAGE_MANIFEST_FILE } from "./build-gate.js";

/** Pinned Node.js version compared with the running one when present; a full version or only its major. */
export const PINNED_NODE_VERSION_FILE = ".nvmrc";

/** Environment file that may hold `NPM_TOKEN` locally; ignored by Git. */
export const LOCAL_ENVIRONMENT_FILE = ".env";

/** Stable identifiers of every step the command knows how to run, in execution order. */
export const RELEASE_STEP = Object.freeze({
  syncMain: "sync-main",
  applyMigrations: "apply-migrations",
  generateChangelog: "generate-changelog",
  runChecks: "run-checks",
  bumpVersion: "bump-version",
  prepareRelease: "prepare-release",
  pushRelease: "push-release",
  publishRelease: "publish-release",
});

/** What the command does with the current state. */
export const RELEASE_MODE = Object.freeze({
  newRelease: "new-release",
  resume: "resume",
  upToDate: "up-to-date",
  blocked: "blocked",
});

/** Result of a project migrations adapter. */
export const MIGRATION_STATUS = Object.freeze({
  upToDate: "up-to-date",
  pending: "pending",
  unknown: "unknown",
});

/** Pull request states reported by `gh pr view --json state`. */
export const PULL_REQUEST_STATE = Object.freeze({
  open: "OPEN",
  merged: "MERGED",
  closed: "CLOSED",
});

/** Fields requested from `gh pr view`. */
export const PULL_REQUEST_JSON_FIELDS = "number,url,title,state,isDraft,headRefOid";

/** Message `gh pr view` prints when the branch has no pull request. */
export const NO_PULL_REQUEST_MESSAGE_PATTERN = /no pull requests found/iu;

/** Registries whose published versions drive resumes and the banner. */
export const RELEASE_REGISTRY = Object.freeze({
  npm: "npm",
});

/** Built-in publisher selected with `publish: "npm"`. */
export const NPM_PUBLISHER = "npm";

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

/** Languages the Codex changelog prompt can request. */
export const CHANGELOG_LANGUAGE = Object.freeze({
  spanish: "es",
  english: "en",
});

/** Command-line flags of `beez-rp create-version`. */
export const CREATE_VERSION_FLAG = Object.freeze({
  bump: "bump",
  setVersion: "set-version",
  dryRun: "dry-run",
  help: "help",
  helpShort: "h",
  endOfOptions: "--",
});

/** Optional `v` prefix accepted in hand-typed versions. */
export const VERSION_PREFIX_PATTERN = /^v/u;

/** `version` field of `package.json`, replaced in place to keep formatting. */
export const PACKAGE_VERSION_FIELD_PATTERN = /("version"\s*:\s*")[^"]+(")/u;

/** `git log -G` pattern of a changed top-level `version` field; the last such commit is the last release. */
export const VERSION_FIELD_CHANGE_PATTERN = `^[[:space:]]*"version"[[:space:]]*:`;

/** GitHub `owner/repo` inside an SSH or HTTPS remote URL. */
export const GITHUB_REPOSITORY_PATTERN = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/u;

/** Separates fields inside one `git log --format` record. */
export const FIELD_SEPARATOR = "\x1f";

/** Separates records in `git log --format` output. */
export const RECORD_SEPARATOR = "\x1e";

/** Width of the `git status --porcelain` state columns before each path. */
export const PORCELAIN_STATUS_WIDTH = 3;

/** Maximum commits listed in a box. */
export const MAX_LISTED_COMMITS = 12;

/** Maximum uncommitted files, foreign commits or pending migrations listed before summarizing. */
export const MAX_LISTED_ITEMS = 5;

/** Length of the abbreviated commit ids shown to the user. */
export const SHORT_SHA_LENGTH = 7;

/** Placeholders of the `artifact` pattern: the released version and the npm package name. */
export const ARTIFACT_VERSION_PLACEHOLDER = "{version}";
export const ARTIFACT_NAME_PLACEHOLDER = "{name}";

/**
 * Scope of a package name as `npm pack` and `pnpm pack` name the tarball: the
 * leading `@` is dropped and the `/` becomes `-` (`@scope/pkg` → `scope-pkg`).
 * The `scope` group keeps the scope without `@`.
 */
export const PACKAGE_SCOPE_PATTERN = /^@(?<scope>[^/]+)\//u;

/** Replacement of {@link PACKAGE_SCOPE_PATTERN} that yields the tarball base name prefix. */
export const PACKED_SCOPE_REPLACEMENT = "$<scope>-";

/** Wildcard of an `artifact` pattern segment, such as the checksum in `releases/{version}-*`. */
export const ARTIFACT_SEGMENT_WILDCARD = "*";

/**
 * Checksum placeholder: the SHA-256 of the archive, verified before publishing. It may repeat,
 * in one segment or several, and every occurrence must declare the same digest.
 */
export const ARTIFACT_SHA256_PLACEHOLDER = "{sha256}";

/** Lowercase hexadecimal SHA-256 digest matched by {@link ARTIFACT_SHA256_PLACEHOLDER}. */
export const SHA256_HEX_PATTERN_SOURCE = "[0-9a-f]{64}";

/**
 * Characters allowed in an artifact path passed to `npm publish` through the Windows shell;
 * `~` is allowed because npm package names (and so tarball names) may contain it.
 */
export const SAFE_ARTIFACT_PATH_PATTERN = /^[\w.@+~/-]+$/u;

/**
 * Prefix that makes npm read an artifact path as a local file: a bare
 * `releases/x/pkg.tgz` operand is parsed as a package spec (a GitHub shorthand).
 */
export const LOCAL_PATH_PREFIX = "./";

/**
 * Arguments of the `npm pack` run that reports the integrity npm would pack from the release
 * checkout: nothing is written and no lifecycle script runs, so it only reads what `prepare` left.
 */
export const NPM_PACK_DRY_RUN_ARGUMENTS = Object.freeze(["pack", "--dry-run", "--json", "--ignore-scripts"]);

/** Hash algorithm of the npm `integrity` string (`sha512-<base64>`). */
export const NPM_INTEGRITY_ALGORITHM = "sha512";

/** npm `integrity` string as `npm pack --json` reports it. */
export const NPM_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

/** Manifest field whose keys npm applies as configuration when it publishes. */
export const PUBLISH_CONFIG_FIELD = "publishConfig";

/**
 * `publishConfig` keys pnpm hoists onto the packed manifest root. npm treats every
 * `publishConfig` key as npm configuration and never rewrites manifest fields with it, so a
 * package that declares any of these would be published differently by npm than by `pnpm pack`.
 * Any other key (`registry`, `access`, `tag`, `provenance`, `@scope:registry`, `otp`...) is npm
 * configuration and is accepted.
 *
 * Source: `PUBLISH_CONFIG_WHITELIST` in pnpm v12.6.0
 * (`pnpm/crates/exportable-manifest/src/create.rs`; same list as
 * `releasing/exportable-manifest/src/overridePublishConfig.ts` in pnpm 11).
 *
 * @see https://github.com/pnpm/pnpm/blob/v12.6.0/pnpm/crates/exportable-manifest/src/create.rs
 * @see https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig
 */
export const PNPM_HOISTED_PUBLISH_CONFIG_KEYS = Object.freeze([
  "name",
  "bin",
  "engines",
  "type",
  "imports",
  "main",
  "module",
  "typings",
  "types",
  "exports",
  "browser",
  "esnext",
  "es2015",
  "unpkg",
  "umd:main",
  "os",
  "cpu",
  "libc",
  "typesVersions",
]);

/** Dependency maps npm publishes as they are written in `package.json`. */
export const PUBLISHED_DEPENDENCY_FIELDS = Object.freeze(["dependencies", "peerDependencies", "optionalDependencies"]);

/** Dependency specifiers only `pnpm pack` replaces with a resolved version range (`workspace:^`, `catalog:`). */
export const PNPM_PACK_REWRITTEN_SPECIFIER_PATTERN = /^(?:workspace|catalog):/u;

/** Registry `npm publish` uses when `publishConfig.registry` is not set. */
export const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org/";

/** Protocols a publish registry URL may use. */
export const NPM_REGISTRY_PROTOCOLS = Object.freeze(["http:", "https:"]);

/**
 * Value of the registry credential in the temporary npm config: npm expands `${NPM_TOKEN}` from
 * the environment, so the token never reaches the disk or a command line.
 */
export const NPM_AUTH_TOKEN_REFERENCE = `\${${NPM_TOKEN_VARIABLE}}`;

/** Prefix of the temporary directory holding the publish-only npm user config. */
export const NPM_AUTH_DIRECTORY_PREFIX = "beez-rp-npm-auth-";

/** Characters that could break out of a quoted path on the Windows shell. */
export const UNSAFE_QUOTED_PATH_PATTERN = /["%]/u;

/** Placeholder replaced by the released version in `summary` lines. */
export const SUMMARY_VERSION_PLACEHOLDER = "{version}";

/** Exit code of a release stopped by a failed step, invalid arguments or configuration. */
export const FAILURE_EXIT_CODE = 1;
