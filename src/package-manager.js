/**
 * Detects the package manager of a project and builds the commands beez-rp
 * prints or runs for it, so a bun, npm or yarn project is told to run its own
 * commands instead of pnpm ones.
 *
 * @module package-manager
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CREATE_VERSION_SCRIPT,
  DEFAULT_PACKAGE_MANAGER,
  LOCKFILE_PACKAGE_MANAGERS,
  PACKAGE_MANAGER_FIELD,
  PACKAGE_MANAGER_FIELD_PATTERN,
  SCRIPT_RUNNER,
} from "./constants/package-manager.js";
import { PACKAGE_MANIFEST_FILE } from "./constants/create-version.js";

/**
 * @typedef {"pnpm" | "npm" | "yarn" | "bun"} PackageManagerName
 * @typedef {{
 *   packageManager: PackageManagerName,
 *   runScript: (script: string) => string,
 *   createVersion: string,
 * }} ProjectCommands
 *   `runScript("ci")` is the command line that runs a `package.json` script; `createVersion` is how
 *   the project runs `beez-rp create-version` through its script.
 */

/**
 * Reads the package manager a `packageManager` value declares.
 *
 * @param {unknown} value - `packageManager` field of `package.json`.
 * @returns {PackageManagerName | null} Package manager, or `null` when the value is missing or unknown.
 */
export function parsePackageManagerField(value) {
  const match = typeof value === "string" ? PACKAGE_MANAGER_FIELD_PATTERN.exec(value) : null;
  return match ? /** @type {PackageManagerName} */ (match[1]) : null;
}

/**
 * Detects the package manager of a project: the `packageManager` field of its `package.json`,
 * else its lockfile, else pnpm (the historical default of the Beez projects).
 *
 * @param {string} repositoryRoot - Project root.
 * @param {Record<string, unknown>} [manifest] - Its `package.json`, when already read.
 * @returns {PackageManagerName} Package manager.
 */
export function detectPackageManager(repositoryRoot, manifest) {
  const declared = parsePackageManagerField((manifest ?? readManifest(repositoryRoot))?.[PACKAGE_MANAGER_FIELD]);

  if (declared) {
    return declared;
  }

  const lockfile = LOCKFILE_PACKAGE_MANAGERS.find(([fileName]) => existsSync(path.join(repositoryRoot, fileName)));
  return /** @type {PackageManagerName} */ (lockfile?.[1] ?? DEFAULT_PACKAGE_MANAGER);
}

/**
 * Builds the commands printed or run for a package manager.
 *
 * @param {PackageManagerName} packageManager - Package manager.
 * @returns {ProjectCommands} Commands.
 */
export function describeProjectCommands(packageManager) {
  const scriptRunner = SCRIPT_RUNNER[packageManager];
  return {
    packageManager,
    runScript: (script) => `${packageManager} run ${script}`,
    createVersion: `${scriptRunner} ${CREATE_VERSION_SCRIPT}`,
  };
}

/** Commands of a pnpm project: the default when a project cannot be inspected. */
export const DEFAULT_PROJECT_COMMANDS = Object.freeze(describeProjectCommands(DEFAULT_PACKAGE_MANAGER));

/**
 * Reads `package.json` without throwing.
 *
 * @param {string} repositoryRoot - Project root.
 * @returns {Record<string, unknown> | null} Manifest, or `null` when it is missing or invalid.
 */
function readManifest(repositoryRoot) {
  try {
    return JSON.parse(readFileSync(path.join(repositoryRoot, PACKAGE_MANIFEST_FILE), "utf8"));
  } catch {
    return null;
  }
}
