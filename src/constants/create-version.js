/**
 * Git, npm, configuration and display values of the shared `beez-rp create-version` command.
 *
 * @module constants/create-version
 */

import { DEFAULT_CREATE_VERSION_COMMAND } from "./package-manager.js";

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

/** Environment variable that holds the npm token; the temporary npm config references it as `${NPM_TOKEN}`. */
export const NPM_TOKEN_VARIABLE = "NPM_TOKEN";

/**
 * Path segments, relative to the user home directory (`os.homedir()`), of the environment file
 * shared by every project: one `NPM_TOKEN` for all the repositories that release with beez-rp.
 */
export const SHARED_ENVIRONMENT_FILE_SEGMENTS = Object.freeze([".config", "beez-rp", LOCAL_ENVIRONMENT_FILE]);

/** How the shared environment file is shown to the user, independent of the platform. */
export const SHARED_ENVIRONMENT_FILE_LABEL = `~/${SHARED_ENVIRONMENT_FILE_SEGMENTS.join("/")}`;

/** Where `NPM_TOKEN` was found, in lookup order: environment, repository `.env`, shared file. */
export const NPM_TOKEN_SOURCE = Object.freeze({
  environment: "environment",
  repository: "repository",
  shared: "shared",
});

/** How each {@link NPM_TOKEN_SOURCE} is named in the diagnosis and the error messages; never the token. */
export const NPM_TOKEN_SOURCE_LABEL = Object.freeze({
  [NPM_TOKEN_SOURCE.environment]: "variable de entorno",
  [NPM_TOKEN_SOURCE.repository]: `${LOCAL_ENVIRONMENT_FILE} del repo`,
  [NPM_TOKEN_SOURCE.shared]: SHARED_ENVIRONMENT_FILE_LABEL,
});

/**
 * Result of checking the npm credentials before publishing:
 * - `ok`: the token authenticates and its user owns the package (or it was never published); npm
 *   cannot tell beforehand whether the token itself can write (read-only or granular tokens);
 * - `missingToken`: no source defines `NPM_TOKEN`;
 * - `invalidToken`: the registry rejects the token (`npm whoami` answers 401/403);
 * - `notOwner`: the token authenticates as a user that is not an owner of the package;
 * - `projectCredentials`: the project `.npmrc` defines credentials for the publish registry, which
 *   npm prefers over the temporary config that binds `NPM_TOKEN`;
 * - `unknown`: the check could not finish (network, a registry without `npm owner ls`, an
 *   organization package whose access may come from a team); it warns but does not block.
 */
export const NPM_AUTH_STATUS = Object.freeze({
  ok: "ok",
  missingToken: "missing-token",
  invalidToken: "invalid-token",
  notOwner: "not-owner",
  projectCredentials: "project-credentials",
  unknown: "unknown",
});

/** npm error codes of a rejected credential: `npm whoami` fails with them for an invalid or expired token. */
export const NPM_REJECTED_CREDENTIAL_PATTERN = /\bE40[13]\b/u;

/** Where `NPM_TOKEN` can be defined, in lookup order, as the credential messages explain it. */
export const NPM_TOKEN_LOCATIONS = `la variable de entorno ${NPM_TOKEN_VARIABLE}, el ${LOCAL_ENVIRONMENT_FILE} del repo (ignorado por Git) o ${SHARED_ENVIRONMENT_FILE_LABEL} (un solo token para todos tus proyectos)`;

/** Why npm answers 404 to a publication the token cannot make. */
export const NPM_PUT_NOT_FOUND_NOTE = "Un 404 Not Found de npm en el PUT suele significar falta de permisos sobre el paquete (npm responde 404 en vez de 403).";

/** Diagnosis note of an owner token: npm exposes no side-effect-free way to check its write permission. */
export const NPM_WRITE_ACCESS_UNVERIFIED_NOTE = "permiso de escritura del token no verificable antes de publicar";

/** Why a failed publication can still be the token when its user owns the package. */
export const NPM_READ_ONLY_TOKEN_NOTE =
  "El token puede ser read-only o granular sin permiso de escritura sobre el paquete (npm no permite verificarlo antes de publicar): revisalo en npm → Access Tokens.";

/**
 * Next action after fixing the npm credentials reported by the diagnosis.
 *
 * @param {string} createVersionCommand - How the project runs create-version (`pnpm create-version`, `bun run create-version`…).
 * @returns {string} Spanish next action.
 */
export const buildNpmAuthRerunAction = (createVersionCommand) => `volvé a correr ${createVersionCommand}`;

/**
 * Next action after fixing the npm credentials once `npm publish` failed.
 *
 * @param {string} createVersionCommand - How the project runs create-version.
 * @returns {string} Spanish next action.
 */
export const buildNpmPublishRetryAction = (createVersionCommand) => `corré ${createVersionCommand} para reintentar solo la publicación`;

/** {@link buildNpmAuthRerunAction} of a pnpm project. */
export const NPM_AUTH_RERUN_ACTION = buildNpmAuthRerunAction(DEFAULT_CREATE_VERSION_COMMAND);

/** {@link buildNpmPublishRetryAction} of a pnpm project. */
export const NPM_PUBLISH_RETRY_ACTION = buildNpmPublishRetryAction(DEFAULT_CREATE_VERSION_COMMAND);

/**
 * Option that keeps the plain text output of `npm whoami` and `npm owner ls` even when the project
 * config or the environment enables npm's global JSON output (`json=true`, `npm_config_json=true`).
 */
export const NPM_PLAIN_OUTPUT_OPTION = "--json=false";

/** Arguments of the npm command that prints the user a token authenticates as. */
export const NPM_WHOAMI_ARGUMENTS = Object.freeze(["whoami", NPM_PLAIN_OUTPUT_OPTION]);

/** Arguments of the npm command that lists the owners of a package, followed by the package name. */
export const NPM_OWNER_LIST_ARGUMENTS = Object.freeze(["owner", "ls", NPM_PLAIN_OUTPUT_OPTION]);

/** Project npm config, read from the repository root; npm prefers it over the temporary `--userconfig`. */
export const PROJECT_NPM_CONFIG_FILE = ".npmrc";

/**
 * npm config fields that select the HTTP credential of a registry, either bound to it
 * (`//host/path/:_authToken`) or unbound (`_authToken`); any of them in the project `.npmrc` or in an
 * inherited `npm_config_*` variable overrides `NPM_TOKEN`. TLS client options such as `keyfile` or
 * `certfile` are not listed: they do not replace the token.
 */
export const NPM_CREDENTIAL_CONFIG_FIELDS = Object.freeze(["_authToken", "_auth", "_password", "username"]);

/** Prefix of the environment variables npm reads as config, in any casing (`npm_config_`, `NPM_CONFIG_`). */
export const NPM_CONFIG_ENVIRONMENT_PREFIX = "npm_config_";

/** Prefix of an npm config key bound to a registry: `//host[:port]/path/:field`. */
export const NPM_REGISTRY_BOUND_KEY_PREFIX = "//";

/** One line of `npm owner ls`: `<user> <<email>>`; the `user` group keeps the npm user name. */
export const NPM_OWNER_LINE_PATTERN = /^(?<user>[^\s<]+)(?:\s+<[^>]*>)?$/u;

/** Stable identifiers of every step the command knows how to run, in execution order. */
export const RELEASE_STEP = Object.freeze({
  syncMain: "sync-main",
  applyMigrations: "apply-migrations",
  generateChangelog: "generate-changelog",
  runChecks: "run-checks",
  bumpVersion: "bump-version",
  prepareRelease: "prepare-release",
  pushRelease: "push-release",
  pushReleaseTag: "push-release-tag",
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

/** `package.json` script run as the release checks when the configuration does not set `checks`. */
export const DEFAULT_CHECKS_SCRIPT = "ci";

/** Command line of the default release checks in a pnpm project (other package managers run `<pm> run ci`). */
export const DEFAULT_CHECKS_COMMAND = `pnpm run ${DEFAULT_CHECKS_SCRIPT}`;

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
  skipUnpublished: "skip-unpublished",
  ignoreLocalChanges: "ignore-local-changes",
  help: "help",
  helpShort: "h",
  endOfOptions: "--",
});

/** Message of the `git stash` entry holding the changes `--ignore-local-changes` sets aside. */
export const LOCAL_CHANGES_STASH_MESSAGE = "beez-rp create-version: cambios locales apartados durante el release";

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

/** `git status --porcelain` state codes of an entry that also reports its source path (`R` renamed, `C` copied). */
export const PORCELAIN_SOURCE_PATH_STATUS_CODES = Object.freeze(["R", "C"]);

/** Separates the source path from the new path of a renamed or copied `git status --porcelain` entry. */
export const PORCELAIN_RENAME_SEPARATOR = " -> ";

/** State columns `git status --porcelain --ignored` writes before an ignored path. */
export const IGNORED_PORCELAIN_PREFIX = "!! ";

/** Delimiter of a path that Git quotes as a C string literal (special characters, or spaces in a rename). */
export const GIT_QUOTED_PATH_DELIMITER = '"';

/** Escape character inside a path quoted by Git. */
export const GIT_QUOTED_PATH_ESCAPE = "\\";

/**
 * Characters Git writes after {@link GIT_QUOTED_PATH_ESCAPE}, with the character each one stands for.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const GIT_QUOTED_PATH_ESCAPES = Object.freeze({ a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" });

/** Octal byte escape (`\303`) Git writes inside a quoted path for every non-ASCII byte. */
export const GIT_QUOTED_PATH_OCTAL_BYTE_PATTERN = /^[0-7]{3}/u;

/** Radix of {@link GIT_QUOTED_PATH_OCTAL_BYTE_PATTERN}. */
export const OCTAL_RADIX = 8;

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

/**
 * Prefix of the temporary directory, outside the package root, that holds the prepared archive
 * while `npm pack --dry-run` runs, so npm never packs the archive into the package it describes.
 */
export const ARTIFACT_HOLDING_DIRECTORY_PREFIX = "beez-rp-artifact-";

/** Node.js error code of a `rename` across file systems, retried as copy and delete. */
export const CROSS_DEVICE_RENAME_ERROR_CODE = "EXDEV";

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

/**
 * Dependency specifiers only `pnpm pack` rewrites and npm publishes verbatim, which npm then
 * cannot install (`EUNSUPPORTEDPROTOCOL`):
 * - `catalog:` (dereferenced to the catalog entry);
 * - `workspace:` (resolved to the linked package version), as the whole specifier or, in
 *   `peerDependencies`, as a segment of a compound range (`^1.0.0 || workspace:>=1.0.0`);
 * - `jsr:` (turned into an `npm:@jsr/<scope>__<name>` alias).
 *
 * Source: `convert_dependency_for_publish` (catalog → workspace → jsr replacers) in pnpm v12.6.0
 * `pnpm/crates/exportable-manifest/src/create.rs`, and `replace_workspace_protocol_peer_dependency`
 * in `pnpm/crates/exportable-manifest/src/replace.rs`. No other protocol is rewritten there.
 *
 * @see https://github.com/pnpm/pnpm/blob/v12.6.0/pnpm/crates/exportable-manifest/src/create.rs
 * @see https://github.com/pnpm/pnpm/blob/v12.6.0/pnpm/crates/exportable-manifest/src/replace.rs
 */
export const PNPM_PACK_REWRITTEN_SPECIFIER_PATTERN = /^(?:workspace|catalog|jsr):|\|\|\s*workspace:/u;

/** Public npm registry: npm's default, used when no config sets `@scope:registry` nor `registry`. */
export const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org/";

/** Prefix of a package page on npmjs.com, linked in the summary of a release published to {@link DEFAULT_NPM_REGISTRY_URL}. */
export const NPMJS_PACKAGE_PAGE_URL = "https://www.npmjs.com/package/";

/** `publishConfig` key of the registry for every package, used when no scope-specific registry applies. */
export const PUBLISH_CONFIG_REGISTRY_KEY = "registry";

/** Suffix of the scope-specific `publishConfig` registry key, as in `@scope:registry`. */
export const SCOPED_REGISTRY_KEY_SUFFIX = ":registry";

/**
 * Registry URL allowed on the `npm view` command line built for the Windows shell: only characters
 * without shell meaning (no `%`, `&`, `|`, `^`, quotes or spaces), after URL normalization.
 */
export const SHELL_SAFE_REGISTRY_URL_PATTERN = /^https?:\/\/[\w.~:/@+-]+$/u;

/** npm option that selects the registry `npm view` queries. */
export const NPM_REGISTRY_OPTION = "--registry";

/** npm option that replaces the user config (`~/.npmrc`) with the temporary one. */
export const NPM_USER_CONFIG_OPTION = "--userconfig";

/** npm subcommand that prints the effective value of a config key. */
export const NPM_CONFIG_GET_ARGUMENTS = Object.freeze(["config", "get"]);

/** What `npm config get` prints for a key no config source sets, such as an unused `@scope:registry`. */
export const NPM_UNSET_CONFIG_VALUE = "undefined";

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

/**
 * Shown when syncing `main` brought new commits: the run ends (exit code 0, it is not a failure)
 * so the next one loads the updated configuration and diagnoses again.
 *
 * @param {string} createVersionCommand - How the project runs create-version.
 * @returns {string} Spanish message.
 */
export const buildMainSyncedRestartMessage = (createVersionCommand) =>
  `${MAIN_BRANCH} se actualizó desde origin: volvé a correr ${createVersionCommand} para diagnosticar con el código y la configuración nuevos.`;

/** {@link buildMainSyncedRestartMessage} of a pnpm project. */
export const MAIN_SYNCED_RESTART_MESSAGE = buildMainSyncedRestartMessage(DEFAULT_CREATE_VERSION_COMMAND);

/** Exit code of a release stopped by a failed step, invalid arguments or configuration. */
export const FAILURE_EXIT_CODE = 1;

/**
 * Modes `git ls-tree` reports for a regular file (plain or executable). Any other mode of a
 * `versionFiles` entry in the release commit (`120000` symbolic link, `160000` submodule) means the
 * commit does not carry the file with the version itself.
 */
export const GIT_REGULAR_FILE_MODES = Object.freeze(["100644", "100755"]);

/**
 * Fields of the resolved configuration that decide what the release commits, validates and
 * publishes. A run that sets local changes aside compares them with the configuration loaded again,
 * in a new process, without those changes: any difference means the loaded configuration depends
 * on uncommitted files (such as a helper module that `beez-rp.config.(m)js` imports).
 */
export const RELEASE_INSTRUCTION_FIELDS = Object.freeze(["versionFiles", "checks", "prepare", "publish", "registry", "artifact"]);
