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
  DEFAULT_RELEASE_TYPE_DESCRIPTIONS,
  NPM_PUBLISHER,
  PACKAGE_MANIFEST_FILE,
  PRE_MAJOR_SHIFTED_RELEASE_TYPE_DESCRIPTIONS,
  RELEASE_REGISTRY,
} from "../constants/create-version.js";
import { DEFAULT_MONOREPO_TAG_FORMAT, TAG_FORMAT_PLACEHOLDER, WORKSPACES_PACKAGES } from "../constants/monorepo.js";
import { RELEASE_COMMIT_BUILT_IN_FILES } from "../constants/version-files.js";
import { RELEASE_TYPE, RELEASE_TYPE_ORDER } from "../constants/versions.js";
import { DEFAULT_PROJECT_COMMANDS, describeProjectCommands, detectPackageManager } from "../package-manager.js";
import { isPreMajorShiftActive } from "../versions.js";

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
 *   releases?: { name: string, version: string, directory: string }[],
 * }} HookContext
 *   In monorepo mode `version` is `null` for the steps that cover several packages (`prepare`) and
 *   `releases` lists them; `publish` hooks run once per package with its `version` and `releases`
 *   holding only that package.
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
 *   preMajorShift?: boolean,
 *   registry?: "npm" | null,
 *   publishedLabel?: string,
 *   checks?: string[] | false,
 *   migrations?: MigrationsAdapter | null,
 *   prepare?: string[] | ReleaseHook | null,
 *   publish?: "npm" | ReleaseHook | null,
 *   artifact?: string | null,
 *   summary?: string[],
 *   versionFiles?: string[],
 *   packages?: "workspaces" | string[],
 *   tagFormat?: string,
 * }} CreateVersionConfig
 *   `summary` lines replace `{version}` with the released version (in monorepo mode, a line with
 *   `{version}` or `{name}` is printed once per released package). Without `checks`, the release
 *   runs `<package manager> run ci` (pnpm, bun, npm or yarn, detected from `packageManager` or the
 *   lockfile) when `package.json` declares a `ci` script; `false` skips the checks on purpose.
 *   `versionFiles` lists files (relative to the root) whose marked lines get the new version in the
 *   release commit: `beez-rp-version` / `x-release-please-version` lines and
 *   `beez-rp-start-version`…`beez-rp-end` blocks. Entries may use `/` or `\` and are resolved to the
 *   `/`-separated form (`.\src\cli.js` → `src/cli.js`); each must be a file tracked by Git.
 *   `packages` turns on the monorepo mode: every non-private workspace package (`"workspaces"`: the
 *   ones the root `package.json` declares; or explicit patterns such as `["packages/*"]`) gets its
 *   own version, CHANGELOG and tag, formatted with `tagFormat` (`{component}-v{version}` by default).
 *   `preMajorShift` lowers the suggested release type one level while a version is `0.x`
 *   (breaking → minor, features → patch).
 * @typedef {{
 *   projectName: string | null,
 *   changelog: { audience: string, language: "es" | "en" },
 *   releaseTypeDescriptions: Record<ReleaseType, string>,
 *   preMajorShift: boolean,
 *   registry: "npm" | null,
 *   publishedLabel: string,
 *   checks: string[] | null,
 *   migrations: MigrationsAdapter | null,
 *   prepare: string[] | ReleaseHook | null,
 *   publish: "npm" | ReleaseHook | null,
 *   artifact: string | null,
 *   summary: string[],
 *   versionFiles: string[],
 *   packages: "workspaces" | string[] | null,
 *   tagFormat: string | null,
 *   commands: ProjectCommands,
 * }} ResolvedCreateVersionConfig
 *   `checks` is empty when they are skipped on purpose and `null` when none are configured nor
 *   found, which blocks a new release. `commands` are the project's package manager commands, used
 *   by the default checks and by every "run it again" hint.
 * @typedef {{ packageScripts?: Record<string, unknown>, commands?: ProjectCommands }} ConfigResolutionContext
 */

/** Banner suffix of the version on `origin/main` when a project does not name its environment. */
const DEFAULT_PUBLISHED_LABEL = "publicada";

/**
 * Describes the release types offered after `currentVersion`. While `preMajorShift` applies (the
 * same `0.x` rule as the suggestion), the default descriptions move one level down with the
 * suggestion: a patch carries features and a minor breaking changes. Descriptions the project
 * defined are kept as they are.
 *
 * @param {Pick<ResolvedCreateVersionConfig, "releaseTypeDescriptions" | "preMajorShift">} config - Resolved configuration.
 * @param {string} currentVersion - Current `X.Y.Z` version.
 * @returns {Record<ReleaseType, string>} Description of each release type.
 */
export function describeReleaseTypes({ releaseTypeDescriptions, preMajorShift }, currentVersion) {
  if (!isPreMajorShiftActive(currentVersion, { preMajorShift })) {
    return releaseTypeDescriptions;
  }

  /**
   * @param {ReleaseType} releaseType - Release type to describe.
   * @returns {string} The project's description, or the shifted default.
   */
  const describe = (releaseType) => {
    const description = releaseTypeDescriptions[releaseType];
    return description === DEFAULT_RELEASE_TYPE_DESCRIPTIONS[releaseType] ? PRE_MAJOR_SHIFTED_RELEASE_TYPE_DESCRIPTIONS[releaseType] : description;
  };

  return {
    [RELEASE_TYPE.patch]: describe(RELEASE_TYPE.patch),
    [RELEASE_TYPE.minor]: describe(RELEASE_TYPE.minor),
    [RELEASE_TYPE.major]: describe(RELEASE_TYPE.major),
  };
}

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
  // Array.from turns holes into undefined, which every() would otherwise skip.
  return Array.isArray(value) && Array.from(value).every((item) => typeof item === "string" && item.trim().length > 0);
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

  const preMajorShift = config.preMajorShift ?? false;
  if (typeof preMajorShift !== "boolean") {
    throw invalidField("preMajorShift", "a boolean");
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

  const packages = config.packages ?? null;
  if (packages !== null && packages !== WORKSPACES_PACKAGES && (!isStringList(packages) || packages.length === 0)) {
    throw invalidField("packages", `"${WORKSPACES_PACKAGES}" or a non-empty list of workspace patterns such as packages/*`);
  }

  const tagFormat = config.tagFormat ?? (packages === null ? null : DEFAULT_MONOREPO_TAG_FORMAT);
  if (tagFormat !== null) {
    if (packages === null) {
      throw invalidField("tagFormat", "used only with packages (the single-package mode tags vX.Y.Z)");
    }
    if (typeof tagFormat !== "string" || !tagFormat.includes(TAG_FORMAT_PLACEHOLDER.version)) {
      throw invalidField("tagFormat", `a string containing ${TAG_FORMAT_PLACEHOLDER.version}, such as ${DEFAULT_MONOREPO_TAG_FORMAT}`);
    }
  }

  const configuredVersionFiles = config.versionFiles ?? [];
  if (!isStringList(configuredVersionFiles) || configuredVersionFiles.some((filePath) => !isPathInsideRoot(filePath))) {
    throw invalidField("versionFiles", "a list of file paths relative to the project root, inside it");
  }
  const versionFiles = configuredVersionFiles.map(toSlashSeparatedPath);
  const builtInVersionFile = versionFiles.find((filePath) => RELEASE_COMMIT_BUILT_IN_FILES.includes(filePath));
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
    preMajorShift,
    registry: /** @type {"npm" | null} */ (registry),
    publishedLabel: /** @type {string | undefined} */ (config.publishedLabel) ?? DEFAULT_PUBLISHED_LABEL,
    checks,
    migrations,
    prepare: /** @type {string[] | ReleaseHook | null} */ (prepare),
    publish: /** @type {"npm" | ReleaseHook | null} */ (publish),
    artifact: /** @type {string | null} */ (artifact),
    summary,
    versionFiles,
    packages: /** @type {"workspaces" | string[] | null} */ (packages),
    tagFormat: /** @type {string | null} */ (tagFormat),
    commands,
  };
}

/**
 * Tells whether a configured path stays inside the project root: relative, without `..` segments.
 *
 * @param {string} filePath - Configured path.
 * @returns {boolean} Whether it is a relative path that cannot escape the root.
 */
export function isPathInsideRoot(filePath) {
  // The win32 root covers `/x`, `\x`, `C:\x` and the drive-relative `C:x` alike, on every platform.
  return path.win32.parse(filePath).root === "" && !filePath.split(/[\\/]/u).includes("..");
}

/**
 * Converts a configured path, written with `/` or `\` separators on any platform, to the
 * `/`-separated form without `./` segments nor a trailing `/`: the form the file system, Git and
 * the messages use.
 *
 * @param {string} filePath - Configured path, already known to stay inside the root.
 * @returns {string} Path relative to the root with `/` separators, such as `src/cli.js`.
 */
function toSlashSeparatedPath(filePath) {
  return path.posix.normalize(filePath.replaceAll("\\", "/")).replace(/\/+$/u, "");
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
  const configPath = CREATE_VERSION_CONFIG_FILES.map((fileName) => path.join(repositoryRoot, fileName)).find((candidate) => existsSync(candidate));

  if (!configPath) {
    throw new Error(
      `beez-rp create-version: ${CREATE_VERSION_CONFIG_FILES.join(" or ")} not found in ${repositoryRoot}; create it with at least changelog.audience`
    );
  }

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
