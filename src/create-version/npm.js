/**
 * npm adapter of `beez-rp create-version`: resolves the registry a package is
 * published to (`publishConfig`, else npm's own config), resolves `NPM_TOKEN`
 * with a single ordered lookup (environment, repository `.env`, shared
 * `~/.config/beez-rp/.env`), checks that the token can publish the package
 * (`npm whoami` + `npm owner ls`), lists the versions published there
 * (authenticated with `NPM_TOKEN` when available), reads the integrity npm
 * would pack from the release checkout, and publishes the working tree or a
 * prepared archive with `NPM_TOKEN` bound to the publish registry.
 *
 * @module create-version/npm
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import {
  DEFAULT_NPM_REGISTRY_URL,
  LOCAL_ENVIRONMENT_FILE,
  LOCAL_PATH_PREFIX,
  NPM_CONFIG_ENVIRONMENT_PREFIX,
  NPM_CREDENTIAL_CONFIG_FIELDS,
  NPM_AUTH_DIRECTORY_PREFIX,
  NPM_AUTH_STATUS,
  NPM_AUTH_TOKEN_REFERENCE,
  NPM_CONFIG_GET_ARGUMENTS,
  NPM_DIST_TAG,
  NPM_INTEGRITY_PATTERN,
  NPM_LOOKUP_STATUS,
  NPM_NOT_FOUND_CODE,
  NPM_OWNER_LINE_PATTERN,
  NPM_OWNER_LIST_ARGUMENTS,
  NPM_PACK_DRY_RUN_ARGUMENTS,
  NPM_PACKAGE_NAME_PATTERN,
  NPM_REGISTRY_BOUND_KEY_PREFIX,
  NPM_REGISTRY_OPTION,
  NPM_REGISTRY_PROTOCOLS,
  NPM_REJECTED_CREDENTIAL_PATTERN,
  NPM_TOKEN_SOURCE,
  NPM_TOKEN_VARIABLE,
  NPM_UNSET_CONFIG_VALUE,
  NPM_USER_CONFIG_OPTION,
  NPM_WHOAMI_ARGUMENTS,
  NPMJS_PACKAGE_PAGE_URL,
  PACKAGE_SCOPE_PATTERN,
  PROJECT_NPM_CONFIG_FILE,
  PUBLISH_CONFIG_FIELD,
  PUBLISH_CONFIG_REGISTRY_KEY,
  SCOPED_REGISTRY_KEY_SUFFIX,
  SHARED_ENVIRONMENT_FILE_SEGMENTS,
  SHELL_SAFE_REGISTRY_URL_PATTERN,
  UNSAFE_QUOTED_PATH_PATTERN,
} from "../constants/create-version.js";
import { PACKAGE_MANAGER_USER_AGENT_VARIABLE } from "../constants/guard-publish.js";
import { USES_SHELL_FOR_PACKAGE_MANAGERS, runCaptured, runInherited } from "./process.js";

/**
 * @typedef {{ status: string, publishedVersions: string[], latestVersion?: string | null, reason: string | null }} NpmLookup
 *   `latestVersion` is the version the `latest` dist-tag points at, which may be a prerelease.
 * @typedef {{ name: unknown, version: unknown, integrity: string }} NpmPackDescription
 *   What `npm pack --dry-run --json` reports for the release checkout: package name, version and `sha512-<base64>` integrity.
 * @typedef {{ pack: NpmPackDescription | null, problem: string | null }} NpmPackResult
 * @typedef {{ token: string | null, source: string | null }} NpmTokenResolution
 *   `NPM_TOKEN` and the `NPM_TOKEN_SOURCE` it came from; both `null` when no source defines it.
 * @typedef {{ environment?: NodeJS.ProcessEnv, homeDirectory?: string }} NpmTokenLookup
 *   Environment and home directory {@link resolveNpmToken} reads; the current process and `os.homedir()` by default.
 * @typedef {{
 *   status: string,
 *   user: string | null,
 *   source: string | null,
 *   registryUrl: string,
 *   packageName: string,
 *   owners: string[],
 *   firstPublication: boolean,
 *   reason: string | null,
 * }} NpmAuthCheck
 *   Result of {@link checkNpmPublishAccess}: one of `NPM_AUTH_STATUS`, the user the token
 *   authenticates as, where the token came from (never the token itself), the owners npm reports
 *   and why the check did not pass.
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
 * Builds the `npm view` arguments that list the published versions and dist-tags of a package on a registry.
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
  return ["view", packageName, "versions", "dist-tags", "--json", ...buildRegistryOptions(registryUrl, userConfigPath, "npm view")];
}

/**
 * Builds the options that point an npm command at a registry and, optionally, at the temporary
 * user config of {@link withNpmAuthConfig}.
 *
 * @param {string} registryUrl - Registry resolved by {@link resolvePublishRegistry}.
 * @param {string | null} userConfigPath - Temporary npm config, or `null` for npm's usual config.
 * @param {string} commandName - npm command named in the error, such as `npm view`.
 * @returns {string[]} `--registry <url>` and, with a config, `--userconfig <path>`.
 * @throws {Error} When the registry is not a valid http(s) URL or has characters unsafe on the Windows shell.
 */
function buildRegistryOptions(registryUrl, userConfigPath, commandName) {
  const { href } = parseRegistryUrl(registryUrl);
  if (!SHELL_SAFE_REGISTRY_URL_PATTERN.test(href)) {
    throw new Error(`beez-rp create-version: el registry "${registryUrl}" tiene caracteres no permitidos en la línea de comandos de ${commandName}`);
  }
  const userConfig = userConfigPath ? [NPM_USER_CONFIG_OPTION, userConfigPath] : [];
  return [NPM_REGISTRY_OPTION, href, ...userConfig];
}

/**
 * Builds the `npm whoami` arguments that ask a registry which user the temporary config authenticates as.
 *
 * @param {string} registryUrl - Registry the package is published to.
 * @param {string} userConfigPath - Temporary npm config from {@link withNpmAuthConfig}.
 * @returns {string[]} Arguments that follow `npm`.
 * @throws {Error} When the registry is invalid or unsafe on the Windows shell.
 */
export function buildNpmWhoamiArguments(registryUrl, userConfigPath) {
  return [...NPM_WHOAMI_ARGUMENTS, ...buildRegistryOptions(registryUrl, userConfigPath, "npm whoami")];
}

/**
 * Builds the `npm owner ls` arguments that list the owners of a package on a registry.
 *
 * @param {string} packageName - npm package name, already checked with `NPM_PACKAGE_NAME_PATTERN`.
 * @param {string} registryUrl - Registry the package is published to.
 * @param {string} userConfigPath - Temporary npm config from {@link withNpmAuthConfig}.
 * @returns {string[]} Arguments that follow `npm`.
 * @throws {Error} When the registry is invalid or unsafe on the Windows shell.
 */
export function buildNpmOwnerListArguments(packageName, registryUrl, userConfigPath) {
  return [...NPM_OWNER_LIST_ARGUMENTS, packageName, ...buildRegistryOptions(registryUrl, userConfigPath, "npm owner ls")];
}

/**
 * Reads a text file that npm credentials are looked up in, naming the file (never its content)
 * when it exists but cannot be read, such as a directory or a file without read permission.
 *
 * @param {string} filePath - File to read.
 * @param {string} purpose - What the file is read for, as the error explains it.
 * @returns {string | null} Content, or `null` when the file does not exist.
 * @throws {Error} When the file exists but cannot be read; the original error is its `cause`.
 */
function readCredentialFile(filePath, purpose) {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`beez-rp create-version: no se pudo leer ${filePath} para ${purpose}`, { cause: error });
  }
}

/**
 * Reads `NPM_TOKEN` from an environment file without loading anything into the process.
 *
 * @param {string} environmentFilePath - `.env` file.
 * @returns {string | null} Non-empty token, or `null` when the file is missing or does not define it.
 * @throws {Error} When the file exists but cannot be read.
 */
function readTokenFromEnvironmentFile(environmentFilePath) {
  const content = readCredentialFile(environmentFilePath, `buscar ${NPM_TOKEN_VARIABLE}`);
  return content === null ? null : parseEnv(content)[NPM_TOKEN_VARIABLE] || null;
}

/**
 * Resolves `NPM_TOKEN` with the single lookup shared by the diagnosis, `npm view` and the
 * publication: the `NPM_TOKEN` environment variable, else the repository `.env` (ignored by Git),
 * else the file shared by every project, `~/.config/beez-rp/.env`. The token is only returned:
 * it is never written to disk nor loaded into `process.env`.
 *
 * @param {string} repositoryRoot - Repository root holding the optional `.env`.
 * @param {NpmTokenLookup} [lookup] - Environment and home directory to read.
 * @returns {NpmTokenResolution} Token and its source.
 * @throws {Error} When a `.env` that has to be read exists but cannot be read.
 */
export function resolveNpmToken(repositoryRoot, { environment = process.env, homeDirectory = homedir() } = {}) {
  const candidates = [
    { source: NPM_TOKEN_SOURCE.environment, read: () => environment[NPM_TOKEN_VARIABLE] || null },
    { source: NPM_TOKEN_SOURCE.repository, read: () => readTokenFromEnvironmentFile(path.join(repositoryRoot, LOCAL_ENVIRONMENT_FILE)) },
    { source: NPM_TOKEN_SOURCE.shared, read: () => readTokenFromEnvironmentFile(path.join(homeDirectory, ...SHARED_ENVIRONMENT_FILE_SEGMENTS)) },
  ];

  for (const candidate of candidates) {
    const token = candidate.read();
    if (token) {
      return { token, source: candidate.source };
    }
  }

  return { token: null, source: null };
}

/**
 * Tells whether an environment variable is an npm config credential (`npm_config_//host/:_authToken`,
 * `NPM_CONFIG__AUTH`, ...): npm reads its config variables in any casing and ranks them above every
 * npmrc file, so an inherited one would authenticate instead of the temporary config.
 *
 * @param {string} variableName - Environment variable name.
 * @returns {boolean} Whether the variable sets one of {@link NPM_CREDENTIAL_CONFIG_FIELDS}.
 */
function isNpmCredentialEnvironmentVariable(variableName) {
  const normalizedName = variableName.toLowerCase();
  if (!normalizedName.startsWith(NPM_CONFIG_ENVIRONMENT_PREFIX)) {
    return false;
  }

  const configKey = normalizedName.slice(NPM_CONFIG_ENVIRONMENT_PREFIX.length);
  const configField = configKey.startsWith(NPM_REGISTRY_BOUND_KEY_PREFIX) ? configKey.slice(configKey.lastIndexOf(":") + 1) : configKey;
  return NPM_CREDENTIAL_CONFIG_FIELDS.some((credentialField) => credentialField.toLowerCase() === configField);
}

/**
 * Builds the environment of an npm command that authenticates with the temporary config: the
 * publish environment ({@link buildNpmPublishEnvironment}) without inherited npm credential
 * variables, plus `NPM_TOKEN`, which npm expands from `${NPM_TOKEN}` in that config. Only the child
 * process receives the token, and it is the only credential npm can use.
 *
 * @param {string} token - Token from {@link resolveNpmToken}.
 * @param {NodeJS.ProcessEnv} [environment] - Environment to copy; the current process by default.
 * @returns {NodeJS.ProcessEnv} Environment for npm.
 */
export function buildNpmTokenEnvironment(token, environment = process.env) {
  const publishVariables = Object.entries(buildNpmPublishEnvironment(environment)).filter(
    ([variableName]) => !isNpmCredentialEnvironmentVariable(variableName),
  );
  return { ...Object.fromEntries(publishVariables), [NPM_TOKEN_VARIABLE]: token };
}

/**
 * Parses the output of `npm owner ls`: one `<user> <<email>>` line per owner.
 *
 * @param {string} output - Standard output of npm.
 * @returns {string[]} npm user names.
 */
export function parseNpmOwnerList(output) {
  return output
    .split("\n")
    .map((line) => NPM_OWNER_LINE_PATTERN.exec(line.trim())?.groups?.user)
    .filter((owner) => typeof owner === "string");
}

/**
 * Returns the first line of a failed npm command, for messages that never include the token.
 *
 * @param {{ status: number, stdout: string, stderr: string }} result - Captured npm result.
 * @param {string} commandName - npm command, such as `npm whoami`.
 * @returns {string} First meaningful output line, or the exit code.
 */
function describeNpmFailure(result, commandName) {
  const firstLine = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? `${commandName}: ${firstLine}` : `${commandName} salió con código ${result.status}`;
}

/**
 * Checks, before anything is touched, the credential `npm publish` will use: resolves the token
 * ({@link resolveNpmToken}), asks the registry who it authenticates as (`npm whoami`) and whether
 * that user owns the package (`npm owner ls`). A package the registry does not show (E404) passes as
 * `firstPublication`; registries also hide private packages from users without access, so the
 * snapshot confirms it against the versions `npm view` lists (see `state.js`). Both commands use the same temporary config and registry as
 * `npm publish`. A passing check proves that the token authenticates as an owner, not that it can
 * write: a read-only or granular token without write permission passes too, and npm offers no
 * side-effect-free way to tell before publishing.
 *
 * @param {string} packageName - npm package name.
 * @param {string} repositoryRoot - Repository root, where npm reads its project config.
 * @param {string} registryUrl - Registry from {@link resolvePublishRegistry}.
 * A project `.npmrc` with credentials for the registry blocks as `projectCredentials` without
 * querying it, because npm would authenticate with them instead of `NPM_TOKEN`; an unreadable
 * `.env` or `.npmrc` leaves the check `unknown` with the file it could not read.
 *
 * @param {NpmTokenLookup} [lookup] - Token lookup of {@link resolveNpmToken}.
 * @returns {Promise<NpmAuthCheck>} Check result; never rejects.
 */
export async function checkNpmPublishAccess(packageName, repositoryRoot, registryUrl, lookup = {}) {
  /** @type {NpmAuthCheck} */
  let check = { status: NPM_AUTH_STATUS.unknown, user: null, source: null, registryUrl, packageName, owners: [], firstPublication: false, reason: null };

  try {
    const { token, source } = resolveNpmToken(repositoryRoot, lookup);
    check = { ...check, source };

    if (!token) {
      return { ...check, status: NPM_AUTH_STATUS.missingToken };
    }

    if (!NPM_PACKAGE_NAME_PATTERN.test(packageName)) {
      return { ...check, reason: `nombre de paquete inválido: ${packageName}` };
    }

    const projectCredentialKey = findProjectNpmCredentialKey(repositoryRoot, registryUrl);
    if (projectCredentialKey) {
      return { ...check, status: NPM_AUTH_STATUS.projectCredentials, reason: `${PROJECT_NPM_CONFIG_FILE} del proyecto define ${projectCredentialKey}` };
    }

    const environment = buildNpmTokenEnvironment(token, lookup.environment);

    return await withNpmAuthConfig(buildNpmAuthConfigLine(registryUrl), async (userConfigPath) => {
      const whoami = await runNpmCaptured(buildNpmWhoamiArguments(registryUrl, userConfigPath), repositoryRoot, environment);

      if (whoami.status !== 0) {
        const rejected = NPM_REJECTED_CREDENTIAL_PATTERN.test(`${whoami.stderr}\n${whoami.stdout}`);
        return { ...check, status: rejected ? NPM_AUTH_STATUS.invalidToken : NPM_AUTH_STATUS.unknown, reason: describeNpmFailure(whoami, "npm whoami") };
      }

      const user = whoami.stdout.trim();
      const ownerList = await runNpmCaptured(buildNpmOwnerListArguments(packageName, registryUrl, userConfigPath), repositoryRoot, environment);

      if (ownerList.status !== 0) {
        return `${ownerList.stdout}\n${ownerList.stderr}`.includes(NPM_NOT_FOUND_CODE)
          ? { ...check, status: NPM_AUTH_STATUS.ok, user, firstPublication: true }
          : { ...check, user, reason: describeNpmFailure(ownerList, "npm owner ls") };
      }

      const owners = parseNpmOwnerList(ownerList.stdout);

      if (owners.includes(user)) {
        return { ...check, status: NPM_AUTH_STATUS.ok, user, owners };
      }

      // An organization may grant publication through a team without listing the user as owner.
      return readPackageScope(packageName)
        ? { ...check, user, owners, reason: `${user} no figura entre los dueños de ${packageName}; puede publicar solo si tiene acceso por un equipo de la organización` }
        : { ...check, status: NPM_AUTH_STATUS.notOwner, user, owners };
    });
  } catch (error) {
    return { ...check, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Lists the versions of a package published on a registry. With `NPM_TOKEN` ({@link resolveNpmToken})
 * the query authenticates through the same temporary config the publication uses, so a private
 * package can be diagnosed; without it the registry is queried with npm's usual config.
 *
 * @param {string} packageName - npm package name.
 * @param {string} repositoryRoot - Directory whose `.npmrc` npm reads.
 * @param {string} [registryUrl] - Registry the package is published to, from {@link resolvePublishRegistry};
 *   defaults to npm's default registry.
 * @returns {Promise<NpmLookup>} Published versions; a never-published package has none. An unreadable
 *   `.env` fails the lookup with the file it could not read instead of rejecting.
 */
export async function lookupPublishedVersions(packageName, repositoryRoot, registryUrl = DEFAULT_NPM_REGISTRY_URL) {
  if (!NPM_PACKAGE_NAME_PATTERN.test(packageName)) {
    return { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: `nombre de paquete inválido: ${packageName}` };
  }

  let result;
  try {
    const { token } = resolveNpmToken(repositoryRoot);
    const environment = token ? buildNpmTokenEnvironment(token) : process.env;
    /** @param {string | null} userConfigPath - Temporary authenticated config, or `null`. */
    const view = (userConfigPath) => runNpmCaptured(buildNpmViewArguments(packageName, registryUrl, userConfigPath), repositoryRoot, environment);
    result = token ? await withNpmAuthConfig(buildNpmAuthConfigLine(registryUrl), view) : await view(null);
  } catch (error) {
    return { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: error instanceof Error ? error.message : String(error) };
  }

  if (result.status !== 0) {
    return `${result.stdout}\n${result.stderr}`.includes(NPM_NOT_FOUND_CODE)
      ? { status: NPM_LOOKUP_STATUS.ok, publishedVersions: [], reason: null }
      : { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: result.stderr.split("\n")[0] || `npm view salió con código ${result.status}` };
  }

  try {
    // With two fields `npm view --json` answers `{ versions, "dist-tags" }`; a single version comes as a string.
    const { versions = [], "dist-tags": distTags = {} } = JSON.parse(result.stdout);
    const latestVersion = typeof distTags[NPM_DIST_TAG] === "string" ? distTags[NPM_DIST_TAG] : null;
    return { status: NPM_LOOKUP_STATUS.ok, publishedVersions: Array.isArray(versions) ? versions : [versions], latestVersion, reason: null };
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
  return `${buildNpmRegistryKey(registryUrl)}:_authToken=${NPM_AUTH_TOKEN_REFERENCE}\n`;
}

/**
 * Builds the key npm binds credentials of a registry to: `//<host>[:port]<path>/`.
 *
 * @param {string} registryUrl - Registry URL.
 * @returns {string} Registry key, without protocol and with a trailing `/`.
 * @throws {Error} When the registry is not a plain http(s) URL.
 */
function buildNpmRegistryKey(registryUrl) {
  const registry = parseRegistryUrl(registryUrl);
  const registryPath = registry.pathname.endsWith("/") ? registry.pathname : `${registry.pathname}/`;
  return `${NPM_REGISTRY_BOUND_KEY_PREFIX}${registry.host}${registryPath}`;
}

/**
 * Tells whether an npm config key authenticates a registry: an unbound credential field
 * (`_authToken`) or one bound to the registry or to a parent path of it, as npm matches them
 * (`//host/:_authToken` also covers `//host/team/`).
 *
 * @param {string} configKey - Key of a `key=value` line of the project `.npmrc`.
 * @param {string} registryKey - Key from {@link buildNpmRegistryKey}.
 * @returns {boolean} Whether npm would use it to authenticate against the registry.
 */
function isNpmCredentialKeyFor(configKey, registryKey) {
  if (!configKey.startsWith(NPM_REGISTRY_BOUND_KEY_PREFIX)) {
    return NPM_CREDENTIAL_CONFIG_FIELDS.includes(configKey);
  }

  const fieldSeparatorIndex = configKey.lastIndexOf(":");
  const boundRegistry = configKey.slice(0, fieldSeparatorIndex);
  const boundRegistryKey = boundRegistry.endsWith("/") ? boundRegistry : `${boundRegistry}/`;
  return NPM_CREDENTIAL_CONFIG_FIELDS.includes(configKey.slice(fieldSeparatorIndex + 1)) && registryKey.startsWith(boundRegistryKey);
}

/**
 * Finds a credential for the registry in the project `.npmrc` (repository root). npm prefers the
 * project config over the temporary `--userconfig` that binds `NPM_TOKEN`, so such a credential
 * would authenticate every command instead of the token. Only keys are read, never values.
 *
 * @param {string} repositoryRoot - Repository root holding the optional `.npmrc`.
 * @param {string} registryUrl - Registry the package is published to.
 * @returns {string | null} First credential key for the registry, or `null` when there is none.
 * @throws {Error} When the `.npmrc` exists but cannot be read, or the registry is not a plain http(s) URL.
 */
function findProjectNpmCredentialKey(repositoryRoot, registryUrl) {
  const content = readCredentialFile(path.join(repositoryRoot, PROJECT_NPM_CONFIG_FILE), "buscar credenciales de npm");
  if (content === null) {
    return null;
  }

  const registryKey = buildNpmRegistryKey(registryUrl);
  return (
    content
      .split(/\r?\n/u)
      .map((line) => line.split("=", 1)[0].trim())
      .find((configKey) => isNpmCredentialKeyFor(configKey, registryKey)) ?? null
  );
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
 * from {@link resolveNpmToken} and only reaches npm through the child
 * environment and a temporary user config. npm inherits the terminal, so its
 * interactive browser or one-time-password (2FA) confirmation works; that is
 * also why its output cannot be parsed, and a failure is explained afterwards
 * with {@link checkNpmPublishAccess}.
 *
 * @param {string} repositoryRoot - Package root.
 * @param {{ authConfigLine: string, artifactPath?: string | null }} publication - Registry credential line from
 *   {@link buildNpmAuthConfigLine}, and the archive relative to the root (already checked with `isSafeArtifactPath`);
 *   without `artifactPath` the working tree is published.
 * @returns {Promise<{ exitCode: number, missingToken: boolean }>} npm exit code, or a missing-token result without running npm.
 * @throws {Error} When the temporary config path could break out of its shell quotes.
 */
export async function publishToNpm(repositoryRoot, { authConfigLine, artifactPath = null }) {
  const { token } = resolveNpmToken(repositoryRoot);

  if (!token) {
    return { exitCode: 1, missingToken: true };
  }

  const exitCode = await withNpmAuthConfig(authConfigLine, async (userConfigPath) => {
    if (UNSAFE_QUOTED_PATH_PATTERN.test(userConfigPath)) {
      throw new Error(`beez-rp create-version: unsafe temporary npm config path ${userConfigPath}`);
    }

    // The command line is constant apart from validated paths; the token only travels through the environment.
    const publishArguments = buildNpmPublishArguments(artifactPath);
    const env = buildNpmTokenEnvironment(token);
    return USES_SHELL_FOR_PACKAGE_MANAGERS
      ? runInherited(`npm ${publishArguments.join(" ")} --userconfig "${userConfigPath}"`, [], { cwd: repositoryRoot, shell: true, env })
      : runInherited("npm", [...publishArguments, "--userconfig", userConfigPath], { cwd: repositoryRoot, env });
  });

  return { exitCode, missingToken: false };
}
