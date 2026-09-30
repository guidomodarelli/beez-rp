/**
 * Loads and validates `beez-rp.config.js`, the per-project part of
 * `beez-rp create-version`: changelog audience and language, version
 * descriptions, registry, checks, migrations, preparation and publication.
 *
 * The configuration never needs to import `beez-rp`: hooks receive every
 * helper through their context, so a project can type it with
 * `@type {import("beez-rp/create-version").CreateVersionConfig}` only.
 *
 * @module create-version/config
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ARTIFACT_VERSION_PLACEHOLDER,
  CHANGELOG_LANGUAGE,
  CREATE_VERSION_CONFIG_FILE,
  CREATE_VERSION_CONFIG_FILES,
  DEFAULT_CHECKS_SCRIPT,
  NPM_PUBLISHER,
  PACKAGE_MANIFEST_FILE,
  RELEASE_REGISTRY,
} from "../constants/create-version.js";
import { RELEASE_COMMIT_BUILT_IN_FILES } from "../constants/version-files.js";
import { RELEASE_TYPE_ORDER } from "../constants/versions.js";
import { DEFAULT_PROJECT_COMMANDS, describeProjectCommands, detectPackageManager } from "../package-manager.js";

/**
 * @typedef {import("./process.js").GitReader} GitReader
 * @typedef {import("../package-manager.js").ProjectCommands} ProjectCommands
 * @typedef {"patch" | "minor" | "major"} ReleaseType
 * @typedef {{ status: "up-to-date" | "pending" | "unknown", pending: string[], target: string | null, reason: string | null }} MigrationCheck
 * @typedef {{
 *   repositoryRoot: string,
 *   version: string | null,
 *   git: GitReader,
 *   run: (commandLine: string) => Promise<number>,
 *   print: (text?: string) => void,
 *   fail: (message: string, hint: string) => never,
 * }} HookContext
 * @typedef {(context: HookContext) => Promise<void> | void} ReleaseHook
 * @typedef {{
 *   check: (context: HookContext) => Promise<MigrationCheck> | MigrationCheck,
 *   apply: (context: HookContext) => Promise<void> | void,
 *   targetHint?: string,
 * }} MigrationsAdapter
 * @typedef {{
 *   projectName?: string,
 *   changelog: { audience: string, language?: "es" | "en" },
 *   releaseTypeDescriptions?: Partial<Record<ReleaseType, string>>,
 *   registry?: "npm" | null,
 *   publishedLabel?: string,
 *   checks?: string[] | false,
 *   migrations?: MigrationsAdapter | null,
 *   prepare?: string[] | ReleaseHook | null,
 *   publish?: "npm" | ReleaseHook | null,
 *   artifact?: string | null,
 *   summary?: string[],
 *   versionFiles?: string[],
 * }} CreateVersionConfig
 *   `summary` lines replace `{version}` with the released version. Without `checks`, the release
 *   runs `<package manager> run ci` (pnpm, bun, npm or yarn, detected from `packageManager` or the
 *   lockfile) when `package.json` declares a `ci` script; `false` skips the checks on purpose.
 *   `versionFiles` lists files (relative to the root) whose marked lines get the new version in the
 *   release commit: `beez-rp-version` / `x-release-please-version` lines and
 *   `beez-rp-start-version`…`beez-rp-end` blocks. Each entry must be a file tracked by Git, written
 *   with `/` or `\` separators.
 * @typedef {{
 *   projectName: string | null,
 *   changelog: { audience: string, language: "es" | "en" },
 *   releaseTypeDescriptions: Record<ReleaseType, string>,
 *   registry: "npm" | null,
 *   publishedLabel: string,
 *   checks: string[] | null,
 *   migrations: MigrationsAdapter | null,
 *   prepare: string[] | ReleaseHook | null,
 *   publish: "npm" | ReleaseHook | null,
 *   artifact: string | null,
 *   summary: string[],
 *   versionFiles: string[],
 *   commands: ProjectCommands,
 * }} ResolvedCreateVersionConfig
 *   `checks` is empty when they are skipped on purpose and `null` when none are configured nor
 *   found, which blocks a new release. `commands` are the project's package manager commands, used
 *   by the default checks and by every "run it again" hint. `versionFiles` holds every entry in
 *   `/`-separated form without `./` segments (`.\src\cli.js` → `src/cli.js`), the form the file
 *   system, Git and the messages use.
 * @typedef {{ packageScripts?: Record<string, unknown>, commands?: ProjectCommands }} ConfigResolutionContext
 */

/** What each release type means when a project does not describe it. */
const DEFAULT_RELEASE_TYPE_DESCRIPTIONS = Object.freeze({
  patch: "Solo arreglos o cambios internos; nada nuevo para quien lo usa.",
  minor: "Funcionalidades nuevas compatibles; lo existente sigue funcionando igual.",
  major: "Cambio incompatible: quien lo usa tiene que adaptarse.",
});

/** Banner suffix of the version on `origin/main` when a project does not name its environment. */
const DEFAULT_PUBLISHED_LABEL = "publicada";

/**
 * Types a configuration in editors; returns it unchanged.
 *
 * @param {CreateVersionConfig} config - Project configuration.
 * @returns {CreateVersionConfig} The same configuration.
 */
export function defineCreateVersionConfig(config) {
  return config;
}

/**
 * Builds a configuration error that names the file and the invalid field.
 *
 * @param {string} field - Offending field path.
 * @param {string} expectation - What the field must be.
 * @returns {Error} Error to throw.
 */
function invalidField(field, expectation) {
  return new Error(`beez-rp create-version: ${CREATE_VERSION_CONFIG_FILE}: ${field} must be ${expectation}`);
}

/**
 * Checks that a value is an array of non-empty strings.
 *
 * @param {unknown} value - Candidate.
 * @returns {value is string[]} Whether it is a string list.
 */
function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

/**
 * Resolves the release checks: the configured commands, none when `false` skips them on purpose,
 * or `<package manager> run ci` when the configuration leaves them out and `package.json` declares `ci`.
 *
 * @param {unknown} checks - Raw `checks` field.
 * @param {Record<string, unknown>} packageScripts - `scripts` of the project `package.json`.
 * @param {ProjectCommands} commands - Commands of the project package manager.
 * @returns {string[] | null} Commands to run, or `null` when there is nothing to run.
 * @throws {Error} When `checks` is neither a non-empty list of command lines nor `false`.
 */
function resolveChecks(checks, packageScripts, commands) {
  if (checks === undefined) {
    return Object.hasOwn(packageScripts, DEFAULT_CHECKS_SCRIPT) ? [commands.runScript(DEFAULT_CHECKS_SCRIPT)] : null;
  }

  if (checks === false) {
    return [];
  }

  if (!isStringList(checks) || checks.length === 0) {
    throw invalidField("checks", "a non-empty list of command lines, or false to skip them on purpose");
  }

  return checks;
}

/**
 * Validates a raw configuration and fills its defaults.
 *
 * @param {unknown} rawConfig - Default export of `beez-rp.config.js`.
 * @param {ConfigResolutionContext} [resolutionContext] - Project data the defaults depend on.
 * @returns {ResolvedCreateVersionConfig} Configuration ready for the command.
 * @throws {Error} When a field has an unsupported type or value.
 */
export function resolveCreateVersionConfig(rawConfig, { packageScripts = {}, commands = DEFAULT_PROJECT_COMMANDS } = {}) {
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw invalidField("the default export", "an object");
  }

  const config = /** @type {Record<string, unknown>} */ (rawConfig);
  const changelog = /** @type {Record<string, unknown> | undefined} */ (config.changelog);

  if (!changelog || typeof changelog.audience !== "string" || changelog.audience.trim() === "") {
    throw invalidField("changelog.audience", "a non-empty string describing who reads the changelog");
  }

  const language = changelog.language ?? CHANGELOG_LANGUAGE.spanish;
  if (!(/** @type {readonly unknown[]} */ (Object.values(CHANGELOG_LANGUAGE))).includes(language)) {
    throw invalidField("changelog.language", `one of ${Object.values(CHANGELOG_LANGUAGE).join(", ")}`);
  }

  if (config.projectName !== undefined && (typeof config.projectName !== "string" || config.projectName.trim() === "")) {
    throw invalidField("projectName", "a non-empty string");
  }

  const descriptions = config.releaseTypeDescriptions ?? {};
  if (typeof descriptions !== "object" || descriptions === null || Array.isArray(descriptions)) {
    throw invalidField("releaseTypeDescriptions", "an object keyed by patch, minor and major");
  }
  for (const [releaseType, description] of Object.entries(descriptions)) {
    if (!(/** @type {readonly string[]} */ (RELEASE_TYPE_ORDER)).includes(releaseType) || typeof description !== "string") {
      throw invalidField(`releaseTypeDescriptions.${releaseType}`, "a string for patch, minor or major");
    }
  }

  const publish = config.publish ?? null;
  if (publish !== null && publish !== NPM_PUBLISHER && typeof publish !== "function") {
    throw invalidField("publish", `"${NPM_PUBLISHER}", a function or null`);
  }

  const registry = config.registry ?? (publish === NPM_PUBLISHER ? RELEASE_REGISTRY.npm : null);
  if (registry !== null && !(/** @type {readonly unknown[]} */ (Object.values(RELEASE_REGISTRY))).includes(registry)) {
    throw invalidField("registry", `one of ${Object.values(RELEASE_REGISTRY).join(", ")} or null`);
  }

  const checks = resolveChecks(config.checks, packageScripts, commands);

  const prepare = config.prepare ?? null;
  if (prepare !== null && typeof prepare !== "function" && !isStringList(prepare)) {
    throw invalidField("prepare", "a list of command lines, a function or null");
  }

  const migrations = /** @type {MigrationsAdapter | null} */ (config.migrations ?? null);
  if (migrations !== null && (typeof migrations.check !== "function" || typeof migrations.apply !== "function")) {
    throw invalidField("migrations", "an object with check and apply functions, or null");
  }
  if (migrations?.targetHint !== undefined && typeof migrations.targetHint !== "string") {
    throw invalidField("migrations.targetHint", "a string");
  }

  const artifact = config.artifact ?? null;
  if (artifact !== null) {
    if (typeof artifact !== "string" || !artifact.includes(ARTIFACT_VERSION_PLACEHOLDER)) {
      throw invalidField("artifact", `a path pattern containing ${ARTIFACT_VERSION_PLACEHOLDER}, such as releases/{version}-*/{name}-{version}.tgz`);
    }
    if (publish !== NPM_PUBLISHER) {
      throw invalidField("artifact", `used only with publish: "${NPM_PUBLISHER}"`);
    }
  }

  const summary = config.summary ?? [];
  if (!isStringList(summary)) {
    throw invalidField("summary", "a list of lines");
  }

  if (config.publishedLabel !== undefined && typeof config.publishedLabel !== "string") {
    throw invalidField("publishedLabel", "a string");
  }

  const configuredVersionFiles = config.versionFiles ?? [];
  if (!isStringList(configuredVersionFiles) || configuredVersionFiles.some((filePath) => !isPathInsideRoot(filePath))) {
    throw invalidField("versionFiles", "a list of file paths relative to the project root, inside it");
  }
  const builtInVersionFile = configuredVersionFiles.find(isReleaseCommitBuiltInFile);
  if (builtInVersionFile !== undefined) {
    throw invalidField(
      "versionFiles",
      `a list without ${RELEASE_COMMIT_BUILT_IN_FILES.join(" nor ")}, which the release commit already updates (found ${JSON.stringify(builtInVersionFile)})`
    );
  }

  return {
    projectName: /** @type {string | undefined} */ (config.projectName) ?? null,
    changelog: { audience: changelog.audience, language: /** @type {"es" | "en"} */ (language) },
    releaseTypeDescriptions: { ...DEFAULT_RELEASE_TYPE_DESCRIPTIONS, .../** @type {Partial<Record<ReleaseType, string>>} */ (descriptions) },
    registry: /** @type {"npm" | null} */ (registry),
    publishedLabel: /** @type {string | undefined} */ (config.publishedLabel) ?? DEFAULT_PUBLISHED_LABEL,
    checks,
    migrations,
    prepare: /** @type {string[] | ReleaseHook | null} */ (prepare),
    publish: /** @type {"npm" | ReleaseHook | null} */ (publish),
    artifact: /** @type {string | null} */ (artifact),
    summary,
    versionFiles: configuredVersionFiles.map(toSlashSeparatedPath),
    commands,
  };
}

/**
 * Tells whether a configured path stays inside the project root: relative, without `..` segments.
 *
 * @param {string} filePath - Configured path.
 * @returns {boolean} Whether it is a relative path that cannot escape the root.
 */
function isPathInsideRoot(filePath) {
  // The win32 root covers `/x`, `\x`, `C:\x` and the drive-relative `C:x` alike, on every platform.
  return path.win32.parse(filePath).root === "" && !filePath.split(/[\\/]/u).includes("..");
}

/**
 * Converts a configured path, written with `/` or `\` separators on any platform, to the
 * `/`-separated form without `./` segments, so the file system (where POSIX would read a `\` as part
 * of the name), Git and the messages all name the same file.
 *
 * @param {string} filePath - Configured path, already known to stay inside the root.
 * @returns {string} Path relative to the root with `/` separators, such as `src/cli.js`.
 */
function toSlashSeparatedPath(filePath) {
  return path.posix.normalize(filePath.replaceAll("\\", "/"));
}

/**
 * Tells whether a configured path names, under any spelling (`./CHANGELOG.md`, `.\package.json`,
 * other letter case for case-insensitive file systems), a file the release commit already writes.
 *
 * @param {string} filePath - Configured path, already known to stay inside the root.
 * @returns {boolean} Whether it is `package.json` or `CHANGELOG.md` at the root.
 */
function isReleaseCommitBuiltInFile(filePath) {
  const normalizedPath = toSlashSeparatedPath(filePath).replace(/\/+$/u, "").toLowerCase();
  return RELEASE_COMMIT_BUILT_IN_FILES.some((builtInFile) => builtInFile.toLowerCase() === normalizedPath);
}

/**
 * Finds the configuration file `create-version` loads: the first of
 * {@link CREATE_VERSION_CONFIG_FILES} present in the working tree, whether Git tracks it or not.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {string | null} File name relative to the root, or `null` when none exists.
 */
export function findCreateVersionConfigFile(repositoryRoot) {
  return CREATE_VERSION_CONFIG_FILES.find((fileName) => existsSync(path.join(repositoryRoot, fileName))) ?? null;
}

/**
 * Imports `beez-rp.config.mjs` or `beez-rp.config.js` from the repository root and validates it.
 * It is imported once per process: after syncing `main` the command stops and asks to run it
 * again, so a new process imports the updated file and everything it imports.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {Promise<ResolvedCreateVersionConfig>} Resolved configuration.
 * @throws {Error} When the file is missing, fails to load or is invalid.
 */
export async function loadCreateVersionConfig(repositoryRoot) {
  const configFile = findCreateVersionConfigFile(repositoryRoot);

  if (!configFile) {
    throw new Error(
      `beez-rp create-version: ${CREATE_VERSION_CONFIG_FILES.join(" or ")} not found in ${repositoryRoot}; create it with at least changelog.audience`
    );
  }

  const configPath = path.join(repositoryRoot, configFile);
  let module;
  try {
    module = await import(pathToFileURL(configPath).href);
  } catch (error) {
    throw new Error(`beez-rp create-version: could not load ${configPath}`, { cause: error });
  }

  const manifest = readProjectManifest(repositoryRoot);
  const scripts = manifest?.scripts;
  return resolveCreateVersionConfig(module.default, {
    packageScripts: scripts && typeof scripts === "object" && !Array.isArray(scripts) ? /** @type {Record<string, unknown>} */ (scripts) : {},
    commands: describeProjectCommands(detectPackageManager(repositoryRoot, manifest ?? undefined)),
  });
}

/**
 * Reads the project `package.json`, whose scripts decide the default release checks and whose
 * `packageManager` decides the commands beez-rp runs and prints.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {Record<string, unknown> | null} Manifest, or `null` without one.
 * @throws {Error} When `package.json` exists but cannot be parsed.
 */
function readProjectManifest(repositoryRoot) {
  const manifestPath = path.join(repositoryRoot, PACKAGE_MANIFEST_FILE);

  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`beez-rp create-version: could not read the scripts of ${manifestPath}`, { cause: error });
  }
}
