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

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ARTIFACT_VERSION_PLACEHOLDER,
  CHANGELOG_LANGUAGE,
  CREATE_VERSION_CONFIG_FILE,
  CREATE_VERSION_CONFIG_FILES,
  NPM_PUBLISHER,
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
 *   checks?: string[],
 *   migrations?: MigrationsAdapter | null,
 *   prepare?: string[] | ReleaseHook | null,
 *   publish?: "npm" | ReleaseHook | null,
 *   artifact?: string | null,
 *   summary?: string[],
 * }} CreateVersionConfig
 *   `summary` lines replace `{version}` with the released version.
 * @typedef {{
 *   projectName: string | null,
 *   changelog: { audience: string, language: "es" | "en" },
 *   releaseTypeDescriptions: Record<ReleaseType, string>,
 *   registry: "npm" | null,
 *   publishedLabel: string,
 *   checks: string[],
 *   migrations: MigrationsAdapter | null,
 *   prepare: string[] | ReleaseHook | null,
 *   publish: "npm" | ReleaseHook | null,
 *   artifact: string | null,
 *   summary: string[],
 * }} ResolvedCreateVersionConfig
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
 * Validates a raw configuration and fills its defaults.
 *
 * @param {unknown} rawConfig - Default export of `beez-rp.config.js`.
 * @returns {ResolvedCreateVersionConfig} Configuration ready for the command.
 * @throws {Error} When a field has an unsupported type or value.
 */
export function resolveCreateVersionConfig(rawConfig) {
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

  const checks = config.checks ?? [];
  if (!isStringList(checks)) {
    throw invalidField("checks", "a list of command lines");
  }

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

  return resolveCreateVersionConfig(module.default);
}
