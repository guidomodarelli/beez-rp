/**
 * npm adapter of `beez-rp create-version`: lists the published versions of a
 * package and publishes the working tree or a prepared archive with `NPM_TOKEN`.
 *
 * @module create-version/npm
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LOCAL_ENVIRONMENT_FILE,
  NPM_AUTH_CONFIG_LINE,
  NPM_AUTH_DIRECTORY_PREFIX,
  NPM_DIST_TAG,
  NPM_LOOKUP_STATUS,
  NPM_NOT_FOUND_CODE,
  NPM_PACKAGE_NAME_PATTERN,
  NPM_TOKEN_VARIABLE,
  UNSAFE_QUOTED_PATH_PATTERN,
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
 * Runs an operation with a temporary npm user config outside the repository
 * that only references `${NPM_TOKEN}`: npm expands it from the environment, so
 * the token never reaches the disk or a command line, and no repository needs
 * an `.npmrc` (which pnpm refuses to expand and warns about). The config is
 * always removed afterwards.
 *
 * @template T
 * @param {(userConfigPath: string) => Promise<T>} operation - Receives the path for `npm --userconfig`.
 * @param {string} [parentDirectory] - Where the temporary directory is created; defaults to the OS temp directory.
 * @returns {Promise<T>} The operation result.
 */
export async function withNpmAuthConfig(operation, parentDirectory = tmpdir()) {
  const directory = mkdtempSync(path.join(parentDirectory, NPM_AUTH_DIRECTORY_PREFIX));
  const userConfigPath = path.join(directory, "npmrc");

  try {
    writeFileSync(userConfigPath, NPM_AUTH_CONFIG_LINE, { mode: 0o600 });
    return await operation(userConfigPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Publishes the working tree, or a prepared archive, to npm. `NPM_TOKEN` comes
 * from the environment or the ignored `.env` and only reaches npm through the
 * environment and a temporary user config. npm inherits the terminal, so its
 * interactive browser or one-time-password (2FA) confirmation works.
 *
 * @param {string} repositoryRoot - Package root.
 * @param {string | null} [artifactPath] - Archive relative to the root, already checked with `isSafeArtifactPath`; `null` publishes the working tree.
 * @returns {Promise<{ exitCode: number, missingToken: boolean }>} npm exit code, or a missing-token result without running npm.
 * @throws {Error} When the temporary config path could break out of its shell quotes.
 */
export async function publishToNpm(repositoryRoot, artifactPath = null) {
  const environmentFilePath = path.join(repositoryRoot, LOCAL_ENVIRONMENT_FILE);

  if (!process.env[NPM_TOKEN_VARIABLE] && existsSync(environmentFilePath)) {
    process.loadEnvFile(environmentFilePath);
  }

  if (!process.env[NPM_TOKEN_VARIABLE]) {
    return { exitCode: 1, missingToken: true };
  }

  const exitCode = await withNpmAuthConfig(async (userConfigPath) => {
    if (UNSAFE_QUOTED_PATH_PATTERN.test(userConfigPath)) {
      throw new Error(`beez-rp create-version: unsafe temporary npm config path ${userConfigPath}`);
    }

    // The command line is constant apart from validated paths; the token only travels through the environment.
    const publishArguments = ["publish", ...(artifactPath ? [artifactPath] : []), "--access", "public", "--tag", NPM_DIST_TAG];
    return USES_SHELL_FOR_PACKAGE_MANAGERS
      ? runInherited(`npm ${publishArguments.join(" ")} --userconfig "${userConfigPath}"`, [], { cwd: repositoryRoot, shell: true })
      : runInherited("npm", [...publishArguments, "--userconfig", userConfigPath], { cwd: repositoryRoot });
  });

  return { exitCode, missingToken: false };
}
