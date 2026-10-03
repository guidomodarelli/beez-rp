/**
 * Validates repository-owned CI release settings.
 * @module create-version/ci-config
 */

import { CI_ENVIRONMENT_NAME_PATTERN, CI_RESERVED_ENVIRONMENT_NAMES, CI_VERCEL_DEPLOYMENT, CI_WORKFLOW_DIRECTORY, CI_WORKFLOW_NAME_PATTERN } from "../constants/ci-release.js";

/**
 * @typedef {{ workflow: string, secrets?: string[], variables?: string[], deployment?: "vercel" | null }} CiReleaseConfig
 * @typedef {{ workflow: string, secrets: string[], variables: string[], deployment: "vercel" | null }} ResolvedCiReleaseConfig
 */

/**
 * Resolves a workflow basename and explicit environment bindings.
 * @param {unknown} raw - Repository-owned configuration, or null to disable CI releases.
 * @returns {ResolvedCiReleaseConfig | null} Validated configuration.
 * @throws {Error} When the workflow path or environment names are invalid.
 */
export function resolveCiReleaseConfig(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("beez-rp create-version: ci debe ser un objeto con workflow.");
  const config = /** @type {Record<string, unknown>} */ (raw);
  const workflow = typeof config.workflow === "string" ? config.workflow.replace(`${CI_WORKFLOW_DIRECTORY}/`, "") : "";
  if (!CI_WORKFLOW_NAME_PATTERN.test(workflow)) throw new Error("beez-rp create-version: ci.workflow debe ser un nombre de archivo .yml o .yaml dentro de .github/workflows.");
  const secrets = resolveEnvironmentNames(config.secrets, "secrets");
  const variables = resolveEnvironmentNames(config.variables, "variables");
  if (secrets.some((name) => variables.includes(name))) throw new Error("beez-rp create-version: ci.secrets y ci.variables no pueden definir la misma variable.");
  if (config.deployment !== undefined && config.deployment !== null && config.deployment !== CI_VERCEL_DEPLOYMENT) throw new Error("beez-rp create-version: ci.deployment debe ser vercel o null.");
  return { workflow, secrets, variables, deployment: config.deployment === CI_VERCEL_DEPLOYMENT ? CI_VERCEL_DEPLOYMENT : null };
}

/**
 * Validates names before they become YAML environment bindings.
 * @param {unknown} value - Explicit secret or variable names.
 * @param {string} field - Configuration field for the diagnostic.
 * @returns {string[]} Unique environment names.
 * @throws {Error} When a list contains an unsafe or repeated name.
 */
function resolveEnvironmentNames(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || Array.from(value).some((name) => typeof name !== "string" || !CI_ENVIRONMENT_NAME_PATTERN.test(name) || CI_RESERVED_ENVIRONMENT_NAMES.includes(name)) || new Set(value).size !== value.length) {
    throw new Error(`beez-rp create-version: ci.${field} debe ser una lista de nombres de variables únicos (por ejemplo DATABASE_MIGRATION_URL).`);
  }
  return /** @type {string[]} */ (value);
}
