/**
 * npm adapter of `beez-rp create-version`: lists the published versions of a
 * package, reads the integrity npm would pack from the release checkout, and
 * publishes the working tree or a prepared archive with `NPM_TOKEN` bound to
 * the publish registry.
 *
 * @module create-version/npm
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_NPM_REGISTRY_URL,
  LOCAL_ENVIRONMENT_FILE,
  LOCAL_PATH_PREFIX,
  NPM_AUTH_DIRECTORY_PREFIX,
  NPM_AUTH_TOKEN_REFERENCE,
  NPM_DIST_TAG,
  NPM_INTEGRITY_PATTERN,
  NPM_LOOKUP_STATUS,
  NPM_NOT_FOUND_CODE,
  NPM_PACK_DRY_RUN_ARGUMENTS,
  NPM_PACKAGE_NAME_PATTERN,
  NPM_REGISTRY_PROTOCOLS,
  NPM_TOKEN_VARIABLE,
  PUBLISH_CONFIG_FIELD,
  UNSAFE_QUOTED_PATH_PATTERN,
} from "../constants/create-version.js";
import { USES_SHELL_FOR_PACKAGE_MANAGERS, runCaptured, runInherited } from "./process.js";

/**
 * @typedef {{ status: string, publishedVersions: string[], reason: string | null }} NpmLookup
 * @typedef {{ name: unknown, version: unknown, integrity: string }} NpmPackDescription
 *   What `npm pack --dry-run --json` reports for the release checkout: package name, version and `sha512-<base64>` integrity.
 * @typedef {{ pack: NpmPackDescription | null, problem: string | null }} NpmPackResult
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
 * Parses the output of `npm pack --dry-run --json`: an array with one package and its `integrity`.
 *
 * @param {string} output - Standard output of npm.
 * @returns {NpmPackResult} Package name, version and integrity, or why the output is unusable.
 */
export function parseNpmPackDryRunOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    return { pack: null, problem: `la salida de npm pack --dry-run no es JSON válido (${error instanceof Error ? error.message : String(error)})` };
  }

  const packages = Array.isArray(parsed) ? parsed : [];
  const described = packages.length === 1 && packages[0] && typeof packages[0] === "object" ? packages[0] : null;
  if (!described || typeof described.integrity !== "string" || !NPM_INTEGRITY_PATTERN.test(described.integrity)) {
    return { pack: null, problem: "la salida de npm pack --dry-run no describe un único paquete con su integrity sha512" };
  }

  return { pack: { name: described.name, version: described.version, integrity: described.integrity }, problem: null };
}

/**
 * Asks npm for the integrity of the archive it would pack from the release checkout, without
 * writing anything nor running lifecycle scripts. The command line is constant, so it is safe
 * on the Windows shell.
 *
 * @param {string} repositoryRoot - Package root, as `prepare` left it.
 * @returns {Promise<NpmPackResult>} npm description, or why npm failed or its output is unusable.
 */
export async function readNpmPackIntegrity(repositoryRoot) {
  const result = USES_SHELL_FOR_PACKAGE_MANAGERS
    ? await runCaptured(`npm ${NPM_PACK_DRY_RUN_ARGUMENTS.join(" ")}`, [], { cwd: repositoryRoot, shell: true })
    : await runCaptured("npm", [...NPM_PACK_DRY_RUN_ARGUMENTS], { cwd: repositoryRoot });

  if (result.status !== 0) {
    return { pack: null, problem: `npm pack --dry-run salió con código ${result.status}: ${result.stderr.split("\n")[0] || "sin detalle"}` };
  }

  return parseNpmPackDryRunOutput(result.stdout);
}

/**
 * Returns the registry `npm publish` sends the package to: `publishConfig.registry`, or npm's default.
 *
 * @param {Record<string, unknown>} manifest - `package.json` being published.
 * @returns {string} Registry URL as written in the manifest.
 */
export function resolvePublishRegistry(manifest) {
  const publishConfig = manifest[PUBLISH_CONFIG_FIELD];
  const registry = publishConfig && typeof publishConfig === "object" ? /** @type {Record<string, unknown>} */ (publishConfig).registry : undefined;
  return typeof registry === "string" && registry !== "" ? registry : DEFAULT_NPM_REGISTRY_URL;
}

/**
 * Builds the npm config line that binds `${NPM_TOKEN}` to a registry, in the form npm matches
 * credentials with: `//<host>[:port]<path>/:_authToken=${NPM_TOKEN}` (no protocol, trailing `/`).
 *
 * @param {string} registryUrl - Registry `npm publish` uses.
 * @returns {string} Config line ending with a newline; the token itself is never written.
 * @throws {Error} When the registry is not a plain http(s) URL (credentials, query and fragment are rejected).
 */
export function buildNpmAuthConfigLine(registryUrl) {
  /** @type {URL} */
  let registry;
  try {
    registry = new URL(registryUrl);
  } catch (error) {
    throw new Error(`beez-rp create-version: el registry de publicación "${registryUrl}" no es una URL válida`, { cause: error });
  }

  if (!NPM_REGISTRY_PROTOCOLS.includes(registry.protocol) || registry.username || registry.password || registry.search || registry.hash) {
    throw new Error(`beez-rp create-version: el registry de publicación "${registryUrl}" tiene que ser una URL http(s) sin credenciales, query ni fragmento`);
  }

  const registryPath = registry.pathname.endsWith("/") ? registry.pathname : `${registry.pathname}/`;
  return `//${registry.host}${registryPath}:_authToken=${NPM_AUTH_TOKEN_REFERENCE}\n`;
}

/**
 * Runs an operation with a temporary npm user config outside the repository
 * that only references `${NPM_TOKEN}` for the publish registry: npm expands it
 * from the environment, so the token never reaches the disk or a command line,
 * and no repository needs an `.npmrc` (which pnpm refuses to expand and warns
 * about). The config is always removed afterwards.
 *
 * @template T
 * @param {string} authConfigLine - Line built by {@link buildNpmAuthConfigLine}.
 * @param {(userConfigPath: string) => Promise<T>} operation - Receives the path for `npm --userconfig`.
 * @param {string} [parentDirectory] - Where the temporary directory is created; defaults to the OS temp directory.
 * @returns {Promise<T>} The operation result.
 */
export async function withNpmAuthConfig(authConfigLine, operation, parentDirectory = tmpdir()) {
  const directory = mkdtempSync(path.join(parentDirectory, NPM_AUTH_DIRECTORY_PREFIX));
  const userConfigPath = path.join(directory, "npmrc");

  try {
    writeFileSync(userConfigPath, authConfigLine, { mode: 0o600 });
    return await operation(userConfigPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Builds the `npm publish` arguments, without the user config. A prepared
 * archive is prefixed with `./` because npm parses a bare relative operand
 * such as `releases/1.9.0-abc/pkg-1.9.0.tgz` as a package spec instead of a file.
 *
 * @param {string | null} [artifactPath] - Archive relative to the root, already checked with `isSafeArtifactPath`; `null` publishes the working tree.
 * @returns {string[]} Arguments that follow `npm`.
 */
export function buildNpmPublishArguments(artifactPath = null) {
  const publishTarget = artifactPath
    ? [artifactPath.startsWith(LOCAL_PATH_PREFIX) ? artifactPath : `${LOCAL_PATH_PREFIX}${artifactPath}`]
    : [];
  return ["publish", ...publishTarget, "--access", "public", "--tag", NPM_DIST_TAG];
}

/**
 * Publishes the working tree, or a prepared archive, to npm. `NPM_TOKEN` comes
 * from the environment or the ignored `.env` and only reaches npm through the
 * environment and a temporary user config. npm inherits the terminal, so its
 * interactive browser or one-time-password (2FA) confirmation works.
 *
 * @param {string} repositoryRoot - Package root.
 * @param {{ authConfigLine: string, artifactPath?: string | null }} publication - Registry credential line from
 *   {@link buildNpmAuthConfigLine}, and the archive relative to the root (already checked with `isSafeArtifactPath`);
 *   without `artifactPath` the working tree is published.
 * @returns {Promise<{ exitCode: number, missingToken: boolean }>} npm exit code, or a missing-token result without running npm.
 * @throws {Error} When the temporary config path could break out of its shell quotes.
 */
export async function publishToNpm(repositoryRoot, { authConfigLine, artifactPath = null }) {
  const environmentFilePath = path.join(repositoryRoot, LOCAL_ENVIRONMENT_FILE);

  if (!process.env[NPM_TOKEN_VARIABLE] && existsSync(environmentFilePath)) {
    process.loadEnvFile(environmentFilePath);
  }

  if (!process.env[NPM_TOKEN_VARIABLE]) {
    return { exitCode: 1, missingToken: true };
  }

  const exitCode = await withNpmAuthConfig(authConfigLine, async (userConfigPath) => {
    if (UNSAFE_QUOTED_PATH_PATTERN.test(userConfigPath)) {
      throw new Error(`beez-rp create-version: unsafe temporary npm config path ${userConfigPath}`);
    }

    // The command line is constant apart from validated paths; the token only travels through the environment.
    const publishArguments = buildNpmPublishArguments(artifactPath);
    return USES_SHELL_FOR_PACKAGE_MANAGERS
      ? runInherited(`npm ${publishArguments.join(" ")} --userconfig "${userConfigPath}"`, [], { cwd: repositoryRoot, shell: true })
      : runInherited("npm", [...publishArguments, "--userconfig", userConfigPath], { cwd: repositoryRoot });
  });

  return { exitCode, missingToken: false };
}
