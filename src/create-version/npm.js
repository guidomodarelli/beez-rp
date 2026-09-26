/**
 * npm adapter of `beez-rp create-version`: lists the published versions of a
 * package and publishes the working tree with the token referenced by `.npmrc`.
 *
 * @module create-version/npm
 */

import { existsSync } from "node:fs";
import path from "node:path";

import {
  LOCAL_ENVIRONMENT_FILE,
  NPM_DIST_TAG,
  NPM_LOOKUP_STATUS,
  NPM_NOT_FOUND_CODE,
  NPM_PACKAGE_NAME_PATTERN,
  NPM_TOKEN_VARIABLE,
} from "../constants/create-version.js";
import { USES_SHELL_FOR_PACKAGE_MANAGERS, runCaptured, runInherited } from "./process.js";

/**
 * @typedef {{ status: string, publishedVersions: string[], reason: string | null }} NpmLookup
 */

/**
 * Lists the versions of a package published on npm.
 *
 * @param {string} packageName - npm package name.
 * @param {string} repositoryRoot - Directory whose `.npmrc` npm reads.
 * @returns {Promise<NpmLookup>} Published versions; a never-published package has none.
 */
export async function lookupPublishedVersions(packageName, repositoryRoot) {
  if (!NPM_PACKAGE_NAME_PATTERN.test(packageName)) {
    return { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: `nombre de paquete inválido: ${packageName}` };
  }

  // The name is validated above, so the command line built for the Windows shell keeps a fixed shape.
  const result = USES_SHELL_FOR_PACKAGE_MANAGERS
    ? await runCaptured(`npm view ${packageName} versions --json`, [], { cwd: repositoryRoot, shell: true })
    : await runCaptured("npm", ["view", packageName, "versions", "--json"], { cwd: repositoryRoot });

  if (result.status !== 0) {
    return `${result.stdout}\n${result.stderr}`.includes(NPM_NOT_FOUND_CODE)
      ? { status: NPM_LOOKUP_STATUS.ok, publishedVersions: [], reason: null }
      : { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: result.stderr.split("\n")[0] || `npm view salió con código ${result.status}` };
  }

  try {
    const versions = JSON.parse(result.stdout);
    return { status: NPM_LOOKUP_STATUS.ok, publishedVersions: Array.isArray(versions) ? versions : [versions], reason: null };
  } catch (error) {
    return {
      status: NPM_LOOKUP_STATUS.failed,
      publishedVersions: [],
      reason: `respuesta inválida de npm view (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

/**
 * Publishes the working tree to npm. `NPM_TOKEN` comes from the environment or
 * the ignored `.env`, and only reaches npm through the environment and `.npmrc`.
 *
 * @param {string} repositoryRoot - Package root.
 * @returns {Promise<{ exitCode: number, missingToken: boolean }>} npm exit code, or a missing-token result without running npm.
 */
export async function publishToNpm(repositoryRoot) {
  const environmentFilePath = path.join(repositoryRoot, LOCAL_ENVIRONMENT_FILE);

  if (!process.env[NPM_TOKEN_VARIABLE] && existsSync(environmentFilePath)) {
    process.loadEnvFile(environmentFilePath);
  }

  if (!process.env[NPM_TOKEN_VARIABLE]) {
    return { exitCode: 1, missingToken: true };
  }

  // The command line is constant; the token only travels through the environment and `.npmrc`.
  const publishArguments = ["publish", "--access", "public", "--tag", NPM_DIST_TAG];
  const exitCode = USES_SHELL_FOR_PACKAGE_MANAGERS
    ? await runInherited(`npm ${publishArguments.join(" ")}`, [], { cwd: repositoryRoot, shell: true })
    : await runInherited("npm", publishArguments, { cwd: repositoryRoot });

  return { exitCode, missingToken: false };
}
