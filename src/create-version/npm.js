/**
 * npm adapter of `beez-rp create-version`: resolves the registry a package is
 * published to (`publishConfig`, else npm's own config), lists the versions
 * published there (authenticated with `NPM_TOKEN` when available), reads the integrity npm
 * would pack from the release checkout, and publishes the working tree or a
 * prepared archive with `NPM_TOKEN` bound to the publish registry.
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
  NPM_CONFIG_GET_ARGUMENTS,
  NPM_DIST_TAG,
  NPM_INTEGRITY_PATTERN,
  NPM_LOOKUP_STATUS,
  NPM_NOT_FOUND_CODE,
  NPM_PACK_DRY_RUN_ARGUMENTS,
  NPM_PACKAGE_NAME_PATTERN,
  NPM_REGISTRY_OPTION,
  NPM_REGISTRY_PROTOCOLS,
  NPM_TOKEN_VARIABLE,
  NPM_UNSET_CONFIG_VALUE,
  NPM_USER_CONFIG_OPTION,
  NPMJS_PACKAGE_PAGE_URL,
  PACKAGE_SCOPE_PATTERN,
  PUBLISH_CONFIG_FIELD,
  PUBLISH_CONFIG_REGISTRY_KEY,
  SCOPED_REGISTRY_KEY_SUFFIX,
  SHELL_SAFE_REGISTRY_URL_PATTERN,
  UNSAFE_QUOTED_PATH_PATTERN,
} from "../constants/create-version.js";
import { PACKAGE_MANAGER_USER_AGENT_VARIABLE } from "../constants/guard-publish.js";
import { USES_SHELL_FOR_PACKAGE_MANAGERS, runCaptured, runInherited } from "./process.js";

/**
 * @typedef {{ status: string, publishedVersions: string[], reason: string | null }} NpmLookup
 * @typedef {{ name: unknown, version: unknown, integrity: string }} NpmPackDescription
 *   What `npm pack --dry-run --json` reports for the release checkout: package name, version and `sha512-<base64>` integrity.
 * @typedef {{ pack: NpmPackDescription | null, problem: string | null }} NpmPackResult
 */

/**
 * Runs npm with captured output. On Windows npm only resolves through the shell, so every argument
 * is double-quoted there; callers pass validated names, registries and temporary paths only.
 *
 * @param {string[]} npmArguments - Arguments that follow `npm`.
 * @param {string} repositoryRoot - Working directory, whose `.npmrc` npm reads.
 * @param {NodeJS.ProcessEnv} [environment] - Environment of npm; the current process by default.
 * @returns {ReturnType<typeof runCaptured>} Exit status and output.
 * @throws {Error} When an argument could break out of its quotes on the Windows shell.
 */
function runNpmCaptured(npmArguments, repositoryRoot, environment = process.env) {
  const unsafeArgument = npmArguments.find((npmArgument) => UNSAFE_QUOTED_PATH_PATTERN.test(npmArgument));
  if (unsafeArgument !== undefined) {
    throw new Error(`beez-rp create-version: argumento de npm no permitido en la línea de comandos: ${unsafeArgument}`);
  }

  return USES_SHELL_FOR_PACKAGE_MANAGERS
    ? runCaptured(`npm ${npmArguments.map((npmArgument) => `"${npmArgument}"`).join(" ")}`, [], { cwd: repositoryRoot, shell: true, env: environment })
    : runCaptured("npm", npmArguments, { cwd: repositoryRoot, env: environment });
}

/**
 * Builds the `npm view` arguments that list the published versions of a package on a registry.
 * `npm view` ignores the manifest `publishConfig`, so the registry is always passed explicitly.
 *
 * @param {string} packageName - npm package name, already checked with `NPM_PACKAGE_NAME_PATTERN`.
 * @param {string} registryUrl - Registry resolved by {@link resolvePublishRegistry}.
 * @param {string | null} [userConfigPath] - Temporary npm config from {@link withNpmAuthConfig} that
 *   authenticates the query; `null` queries with npm's usual config.
 * @returns {string[]} Arguments that follow `npm`.
 * @throws {Error} When the registry is not a valid http(s) URL or has characters unsafe on the Windows shell.
 */
export function buildNpmViewArguments(packageName, registryUrl, userConfigPath = null) {
  const { href } = parseRegistryUrl(registryUrl);
  if (!SHELL_SAFE_REGISTRY_URL_PATTERN.test(href)) {
    throw new Error(`beez-rp create-version: el registry "${registryUrl}" tiene caracteres no permitidos en la línea de comandos de npm view`);
  }
  const userConfig = userConfigPath ? [NPM_USER_CONFIG_OPTION, userConfigPath] : [];
  return ["view", packageName, "versions", "--json", NPM_REGISTRY_OPTION, href, ...userConfig];
}

/**
 * Loads `NPM_TOKEN` from the ignored `.env` when the environment does not define it.
 *
 * @param {string} repositoryRoot - Repository root holding the optional `.env`.
 * @returns {boolean} Whether `NPM_TOKEN` is available in the environment.
 */
export function loadNpmToken(repositoryRoot) {
  const environmentFilePath = path.join(repositoryRoot, LOCAL_ENVIRONMENT_FILE);

  if (!process.env[NPM_TOKEN_VARIABLE] && existsSync(environmentFilePath)) {
    process.loadEnvFile(environmentFilePath);
  }

  return Boolean(process.env[NPM_TOKEN_VARIABLE]);
}

/**
 * Lists the versions of a package published on a registry. With `NPM_TOKEN` (environment or `.env`)
 * the query authenticates through the same temporary config the publication uses, so a private
 * package can be diagnosed; without it the registry is queried with npm's usual config.
 *
 * @param {string} packageName - npm package name.
 * @param {string} repositoryRoot - Directory whose `.npmrc` npm reads.
 * @param {string} [registryUrl] - Registry the package is published to, from {@link resolvePublishRegistry};
 *   defaults to npm's default registry.
 * @returns {Promise<NpmLookup>} Published versions; a never-published package has none.
 */
export async function lookupPublishedVersions(packageName, repositoryRoot, registryUrl = DEFAULT_NPM_REGISTRY_URL) {
  if (!NPM_PACKAGE_NAME_PATTERN.test(packageName)) {
    return { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: `nombre de paquete inválido: ${packageName}` };
  }

  /** @param {string | null} userConfigPath - Temporary authenticated config, or `null`. */
  const view = (userConfigPath) => runNpmCaptured(buildNpmViewArguments(packageName, registryUrl, userConfigPath), repositoryRoot);

  let result;
  try {
    result = loadNpmToken(repositoryRoot) ? await withNpmAuthConfig(buildNpmAuthConfigLine(registryUrl), view) : await view(null);
  } catch (error) {
    return { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: error instanceof Error ? error.message : String(error) };
  }

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
 * Parses a publish registry URL, accepting only plain http(s) URLs.
 *
 * @param {string} registryUrl - Registry URL as written in the manifest.
 * @returns {URL} Parsed URL.
 * @throws {Error} When the registry is not a plain http(s) URL (credentials, query and fragment are rejected).
 */
function parseRegistryUrl(registryUrl) {
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

  return registry;
}

/**
 * Returns the scope of a package name (`team` for `@team/pkg`), or `undefined` when it has none.
 *
 * @param {unknown} packageName - `name` of the manifest.
 * @returns {string | undefined} Scope without `@`.
 */
function readPackageScope(packageName) {
  return typeof packageName === "string" ? PACKAGE_SCOPE_PATTERN.exec(packageName)?.groups?.scope : undefined;
}

/**
 * Returns the registry the manifest `publishConfig` declares: `publishConfig["@scope:registry"]`
 * for a scoped package that declares it, else `publishConfig.registry`.
 *
 * @param {Record<string, unknown>} manifest - `package.json` being published.
 * @returns {string | null} Declared registry, or `null` when `publishConfig` declares none.
 */
function readPublishConfigRegistry(manifest) {
  const publishConfig = manifest[PUBLISH_CONFIG_FIELD];
  const registries = publishConfig && typeof publishConfig === "object" ? /** @type {Record<string, unknown>} */ (publishConfig) : {};
  const scope = readPackageScope(manifest.name);
  const candidates = [scope ? registries[`@${scope}${SCOPED_REGISTRY_KEY_SUFFIX}`] : undefined, registries[PUBLISH_CONFIG_REGISTRY_KEY]];
  const declared = candidates.find((candidate) => typeof candidate === "string" && candidate !== "");
  return typeof declared === "string" ? declared : null;
}

/**
 * Asks npm for the registry it would publish the package to without `publishConfig`:
 * `@scope:registry` for a scoped package when some config sets it, else `registry`. It runs in the
 * repository root with the environment and the kind of temporary user config `npm publish` gets,
 * so it reads the project `.npmrc`, `npm_config_*` variables and the global config, like the
 * publication (which replaces `~/.npmrc` with its temporary config).
 *
 * @param {Record<string, unknown>} manifest - `package.json` being published.
 * @param {string} repositoryRoot - Package root.
 * @returns {Promise<string>} Registry URL npm resolves.
 * @throws {Error} When the package name is invalid or `npm config get` fails.
 */
async function readNpmConfigRegistry(manifest, repositoryRoot) {
  const packageName = String(manifest.name);
  if (!NPM_PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error(`beez-rp create-version: nombre de paquete inválido: ${packageName}`);
  }

  // The scope comes from a name that matches the npm name pattern, so the key keeps a fixed shape.
  const scope = readPackageScope(packageName);
  const configKeys = [...(scope ? [`@${scope}${SCOPED_REGISTRY_KEY_SUFFIX}`] : []), PUBLISH_CONFIG_REGISTRY_KEY];

  return withNpmAuthConfig("", async (userConfigPath) => {
    for (const configKey of configKeys) {
      const result = await runNpmCaptured(
        [...NPM_CONFIG_GET_ARGUMENTS, configKey, NPM_USER_CONFIG_OPTION, userConfigPath],
        repositoryRoot,
        buildNpmPublishEnvironment()
      );

      if (result.status !== 0) {
        throw new Error(`beez-rp create-version: npm config get ${configKey} salió con código ${result.status}: ${result.stderr.split("\n")[0] || "sin detalle"}`);
      }

      const value = result.stdout.trim();
      if (value !== "" && value !== NPM_UNSET_CONFIG_VALUE) {
        return value;
      }
    }

    return DEFAULT_NPM_REGISTRY_URL;
  });
}

/**
 * Returns the registry `npm publish` sends the package to: `publishConfig["@scope:registry"]` for a
 * scoped package that declares it, else `publishConfig.registry`, else the registry npm's own config
 * resolves (project `.npmrc`, environment, global config; see {@link readNpmConfigRegistry}).
 *
 * @param {Record<string, unknown>} manifest - `package.json` being published.
 * @param {string} repositoryRoot - Package root, where npm reads its project config.
 * @returns {Promise<string>} Registry URL, already checked to be a plain http(s) URL.
 * @throws {Error} When the resolved registry is not a plain http(s) URL or npm cannot report its config.
 */
export async function resolvePublishRegistry(manifest, repositoryRoot) {
  const registryUrl = readPublishConfigRegistry(manifest) ?? (await readNpmConfigRegistry(manifest, repositoryRoot));

  parseRegistryUrl(registryUrl);
  return registryUrl;
}

/**
 * Describes where a published release can be seen: its npmjs.com page when the registry is the
 * public npm registry, else the registry URL with the package and version.
 *
 * @param {{ registryUrl: string, packageName: string, version: string }} release - Published release.
 * @returns {string} Summary text.
 */
export function describePublishedRelease({ registryUrl, packageName, version }) {
  return parseRegistryUrl(registryUrl).href === DEFAULT_NPM_REGISTRY_URL
    ? `${NPMJS_PACKAGE_PAGE_URL}${packageName}/v/${version}`
    : `Registro: ${registryUrl} · ${packageName}@${version}`;
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
  const registry = parseRegistryUrl(registryUrl);
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
 * @param {string} authConfigLine - Line built by {@link buildNpmAuthConfigLine}; an empty line
 *   gives npm a user config without credentials, which only replaces `~/.npmrc`.
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
 * Builds the environment of `npm publish` without the inherited package
 * manager user agent. npm reads `npm_config_user_agent` as its `user-agent`
 * config, so under `pnpm create-version` its lifecycle scripts would report
 * pnpm and `beez-rp guard-publish` would block beez-rp's own npm publication.
 * Without it npm reports its own user agent (`npm/…`). npm reads its config
 * variables in any case (`NPM_CONFIG_USER_AGENT` too), so every casing is dropped.
 *
 * @param {NodeJS.ProcessEnv} [environment] - Environment to copy; the current process by default.
 * @returns {NodeJS.ProcessEnv} Copy without `npm_config_user_agent` in any casing.
 */
export function buildNpmPublishEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([variableName]) => variableName.toLowerCase() !== PACKAGE_MANAGER_USER_AGENT_VARIABLE),
  );
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
  if (!loadNpmToken(repositoryRoot)) {
    return { exitCode: 1, missingToken: true };
  }

  const exitCode = await withNpmAuthConfig(authConfigLine, async (userConfigPath) => {
    if (UNSAFE_QUOTED_PATH_PATTERN.test(userConfigPath)) {
      throw new Error(`beez-rp create-version: unsafe temporary npm config path ${userConfigPath}`);
    }

    // The command line is constant apart from validated paths; the token only travels through the environment.
    const publishArguments = buildNpmPublishArguments(artifactPath);
    const env = buildNpmPublishEnvironment();
    return USES_SHELL_FOR_PACKAGE_MANAGERS
      ? runInherited(`npm ${publishArguments.join(" ")} --userconfig "${userConfigPath}"`, [], { cwd: repositoryRoot, shell: true, env })
      : runInherited("npm", [...publishArguments, "--userconfig", userConfigPath], { cwd: repositoryRoot, env });
  });

  return { exitCode, missingToken: false };
}
