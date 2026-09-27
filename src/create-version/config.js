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
  DEFAULT_CHECKS_COMMAND,
  DEFAULT_CHECKS_SCRIPT,
  NPM_PUBLISHER,
  PACKAGE_MANIFEST_FILE,
  RELEASE_REGISTRY,
} from "../constants/create-version.js";
import { RELEASE_TYPE_ORDER } from "../constants/versions.js";

/**
 * @typedef {import("./process.js").GitReader} GitReader
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
 * }} CreateVersionConfig
 *   `summary` lines replace `{version}` with the released version. Without `checks`, the release
 *   runs `pnpm run ci` when `package.json` declares a `ci` script; `false` skips the checks on purpose.
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
 * }} ResolvedCreateVersionConfig
 *   `checks` is empty when they are skipped on purpose and `null` when none are configured nor
 *   found, which blocks a new release.
 * @typedef {{ packageScripts?: Record<string, unknown> }} ConfigResolutionContext
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
 * or `pnpm run ci` when the configuration leaves them out and `package.json` declares `ci`.
 *
 * @param {unknown} checks - Raw `checks` field.
 * @param {Record<string, unknown>} packageScripts - `scripts` of the project `package.json`.
 * @returns {string[] | null} Commands to run, or `null` when there is nothing to run.
 * @throws {Error} When `checks` is neither a non-empty list of command lines nor `false`.
 */
function resolveChecks(checks, packageScripts) {
  if (checks === undefined) {
    return Object.hasOwn(packageScripts, DEFAULT_CHECKS_SCRIPT) ? [DEFAULT_CHECKS_COMMAND] : null;
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
export function resolveCreateVersionConfig(rawConfig, { packageScripts = {} } = {}) {
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

  const checks = resolveChecks(config.checks, packageScripts);

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
  };
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

  return resolveCreateVersionConfig(module.default, { packageScripts: readPackageScripts(repositoryRoot) });
}

/**
 * Reads the `scripts` of the project `package.json`, which decide the default release checks.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {Record<string, unknown>} Declared scripts; empty without a manifest or scripts.
 * @throws {Error} When `package.json` exists but cannot be parsed.
 */
function readPackageScripts(repositoryRoot) {
  const manifestPath = path.join(repositoryRoot, PACKAGE_MANIFEST_FILE);

  if (!existsSync(manifestPath)) {
    return {};
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`beez-rp create-version: could not read the scripts of ${manifestPath}`, { cause: error });
  }

  const scripts = manifest?.scripts;
  return scripts && typeof scripts === "object" && !Array.isArray(scripts) ? scripts : {};
}
