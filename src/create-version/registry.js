/**
 * Coordinates one selected registry through a shared lookup/authentication/publication contract.
 *
 * @module create-version/registry
 */

import {
  DEFAULT_NPM_REGISTRY_URL, NPM_AUTH_STATUS, NPM_LOOKUP_STATUS, NPM_PACKAGE_NAME_PATTERN,
} from "../constants/create-version.js";
import {
  BROWSER_AUTHENTICATION, GITHUB_PACKAGES_REGISTRY_URL, GITHUB_REGISTRY_PROVIDER, GITLAB_PROJECT_REGISTRY_PATTERN,
  GITLAB_REGISTRY_PROVIDER, JSR_REGISTRY_PROVIDER, JSR_REGISTRY_URL, JSR_SHELL_SAFE_TOKEN_PATTERN,
  NPM_OIDC_MINIMUM_NODE_VERSION, NPM_OIDC_MINIMUM_VERSION, NPM_REGISTRY_PROVIDER, OIDC_AUTHENTICATION, REGISTRY_LABELS,
} from "../constants/registry.js";
import { compareReleaseVersions, isStableReleaseVersion } from "../versions.js";
import { buildNpmAuthConfigLine, checkNpmPublishAccess, findProjectNpmCredentialKey, lookupPublishedVersions, publishToNpm, resolveNpmToken, resolvePublishRegistry } from "./npm.js";
import { publishToJsr, readJsrManifest } from "./jsr.js";
import { isRegistryProvider, resolvePublicationOptions } from "./registry-config.js";
import { lookupHttpRegistry } from "./registry-http.js";
import { runCaptured, USES_SHELL_FOR_PACKAGE_MANAGERS } from "./process.js";

/**
 * @typedef {{ provider: import("./registry-config.js").RegistryProvider, options: import("./registry-config.js").ResolvedPublicationOptions }} RegistrySelection
 * @typedef {RegistrySelection & { registryUrl: string, packageName: string, label: string, tag: string | null }} SelectedRegistry
 */

/**
 * Selects the configured provider without changing legacy npm hooks or disabled tracking.
 *
 * @param {import("./config.js").ResolvedCreateVersionConfig} config - Project configuration.
 * @returns {RegistrySelection} Selected provider and options.
 */
export function selectProjectRegistry(config) {
  const provider = isRegistryProvider(config.publish) ? config.publish : config.registry ?? NPM_REGISTRY_PROVIDER;
  return { provider, options: config.publication ?? resolvePublicationOptions(undefined, provider) };
}

/**
 * Resolves package identity and endpoint once for the operation; known npm endpoints use their provider policy.
 *
 * @param {RegistrySelection} selection - Project selection.
 * @param {Record<string, unknown>} manifest - Node package manifest.
 * @param {string} repositoryRoot - Root where registry routing and credentials are read.
 * @param {string} [packageRoot] - Workspace or checkout directory.
 * @returns {Promise<SelectedRegistry>} Registry descriptor without secret values.
 * @throws {Error} When the endpoint or package identity is invalid for its provider.
 */
export async function resolveRegistry(selection, manifest, repositoryRoot, packageRoot = repositoryRoot) {
  let { provider } = selection;
  const { options } = selection;
  let registryUrl;
  let packageName = String(manifest.name);
  if (provider === JSR_REGISTRY_PROVIDER) {
    registryUrl = options.registryUrl ?? JSR_REGISTRY_URL;
    packageName = readJsrManifest(packageRoot, options.configFile).packageName;
  } else {
    registryUrl = options.registryUrl ?? (provider === GITHUB_REGISTRY_PROVIDER ? GITHUB_PACKAGES_REGISTRY_URL : await resolvePublishRegistry(manifest, repositoryRoot));
    const url = new URL(registryUrl);
    if (provider === NPM_REGISTRY_PROVIDER && url.hostname === new URL(GITHUB_PACKAGES_REGISTRY_URL).hostname) provider = GITHUB_REGISTRY_PROVIDER;
    else if (provider === NPM_REGISTRY_PROVIDER && GITLAB_PROJECT_REGISTRY_PATTERN.test(url.pathname)) provider = GITLAB_REGISTRY_PROVIDER;
    if (!NPM_PACKAGE_NAME_PATTERN.test(packageName)) throw new Error(`Nombre de paquete inválido para ${REGISTRY_LABELS[provider]}`);
    if (provider === GITHUB_REGISTRY_PROVIDER && !packageName.startsWith("@")) throw new Error("GitHub Packages requiere name con scope (@owner/package) en package.json");
    if (provider === GITLAB_REGISTRY_PROVIDER && !GITLAB_PROJECT_REGISTRY_PATTERN.test(url.pathname)) throw new Error("GitLab requiere el endpoint /api/v4/projects/<id>/packages/npm/ para publicar");
    if (url.hostname === "npm.jsr.io") throw new Error("npm.jsr.io permite instalar, pero publicar requiere publish: jsr");
  }
  const url = new URL(registryUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("El registry debe ser una URL http(s) sin credenciales, query ni fragmento");
  if (options.packageName !== null && options.packageName !== packageName) throw new Error("publication.packageName debe coincidir con el name del manifest que se publica");
  return { provider, options, registryUrl: url.href, packageName, label: REGISTRY_LABELS[provider], tag: options.tag };
}

/**
 * Reads the selected registry through the common version contract, preserving injected legacy npm adapters.
 *
 * @param {RegistrySelection} selection - Selected provider.
 * @param {Record<string, unknown>} manifest - Source manifest.
 * @param {string} repositoryRoot - Repository containing credentials and routing.
 * @param {string} [packageRoot] - Workspace package root.
 * @param {typeof lookupPublishedVersions} [lookupNpm] - Legacy npm boundary.
 * @returns {Promise<import("./npm.js").NpmLookup>} Published-version state.
 */
export async function lookupRegistryVersions(selection, manifest, repositoryRoot, packageRoot = repositoryRoot, lookupNpm = lookupPublishedVersions) {
  try {
    const registry = await resolveRegistry(selection, manifest, repositoryRoot, packageRoot);
    if (registry.provider === JSR_REGISTRY_PROVIDER || registry.provider === GITLAB_REGISTRY_PROVIDER) {
      const { token } = resolveNpmToken(repositoryRoot, { tokenVariable: registry.options.tokenEnv });
      return lookupHttpRegistry(registry, token);
    }
    const lookup = await lookupNpm(registry.packageName, repositoryRoot, registry.registryUrl, { tokenVariable: registry.options.tokenEnv, tag: registry.tag ?? "latest", pinScope: true });
    return registry.provider === NPM_REGISTRY_PROVIDER && registry.tag === "latest" ? lookup : { ...lookup, registryLabel: registry.label, tag: registry.tag };
  } catch (error) {
    return { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: error instanceof Error ? error.message : "No se pudo resolver el registry", registryLabel: REGISTRY_LABELS[selection.provider] };
  }
}

/**
 * Checks the destination of an npm-protocol OIDC publication: npm trusted publishing only exists on
 * the public npm registry, so GitHub Packages, GitLab and any other endpoint can never accept it.
 * Shared by the worker and by CI preparation, which must reject it before the release tag exists.
 *
 * @param {SelectedRegistry} registry - Resolved descriptor of a non-JSR provider.
 * @returns {string | null} Blocking reason, or `null` when the destination is the public npm registry.
 */
export function findNpmOidcRegistryProblem(registry) {
  return registry.provider !== NPM_REGISTRY_PROVIDER || new URL(registry.registryUrl).href !== DEFAULT_NPM_REGISTRY_URL ? "OIDC de npm requiere el registry público de npm" : null;
}

/**
 * Checks a configured OIDC runtime without making a token mandatory or claiming provider write access.
 *
 * @param {SelectedRegistry} registry - Resolved descriptor.
 * @returns {Promise<string | null>} Blocking reason, or `null` when the supported environment is available.
 */
async function oidcEnvironmentProblem(registry) {
  const github = Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  const gitlab = Boolean(process.env.GITLAB_CI && process.env.NPM_ID_TOKEN);
  if (registry.provider === JSR_REGISTRY_PROVIDER) return github ? null : "JSR con OIDC requiere GitHub Actions con id-token: write y el paquete vinculado al repositorio";
  const registryProblem = findNpmOidcRegistryProblem(registry);
  if (registryProblem !== null) return registryProblem;
  if (!github && !gitlab) return "npm con OIDC requiere GitHub Actions o GitLab CI con sus credenciales OIDC configuradas";
  if (!isStableReleaseVersion(process.versions.node) || compareReleaseVersions(process.versions.node, NPM_OIDC_MINIMUM_NODE_VERSION) < 0) return `OIDC requiere Node >= ${NPM_OIDC_MINIMUM_NODE_VERSION}`;
  const result = USES_SHELL_FOR_PACKAGE_MANAGERS ? await runCaptured("npm --version", [], { shell: true }) : await runCaptured("npm", ["--version"]);
  return result.status === 0 && isStableReleaseVersion(result.stdout) && compareReleaseVersions(result.stdout, NPM_OIDC_MINIMUM_VERSION) >= 0 ? null : `OIDC requiere npm >= ${NPM_OIDC_MINIMUM_VERSION}`;
}

/**
 * Checks only capabilities the selected provider exposes; unsupported permission checks remain unknown.
 *
 * @param {RegistrySelection} selection - Project selection.
 * @param {Record<string, unknown>} manifest - Node package manifest.
 * @param {string} repositoryRoot - Credential root.
 * @param {string} [packageRoot] - Package checkout.
 * @param {typeof checkNpmPublishAccess} [checkNpmAccess] - Legacy npm check boundary.
 * @returns {Promise<import("./npm.js").NpmAuthCheck>} Safe credential diagnostic.
 */
export async function checkRegistryAccess(selection, manifest, repositoryRoot, packageRoot = repositoryRoot, checkNpmAccess = checkNpmPublishAccess) {
  const check = { status: NPM_AUTH_STATUS.unknown, user: null, source: null, registryUrl: "", packageName: String(manifest.name), owners: [], firstPublication: false, reason: null, tokenVariable: selection.options.tokenEnv, registryLabel: REGISTRY_LABELS[selection.provider] };
  /** @type {import("./npm.js").NpmAuthCheck} */
  let diagnostic = check;
  try {
    const registry = await resolveRegistry(selection, manifest, repositoryRoot, packageRoot);
    diagnostic = { ...diagnostic, registryUrl: registry.registryUrl, packageName: registry.packageName, registryLabel: registry.label };
    const projectCredentialKey = registry.provider === JSR_REGISTRY_PROVIDER ? null : findProjectNpmCredentialKey(repositoryRoot, registry.registryUrl);
    if (projectCredentialKey) return { ...diagnostic, status: NPM_AUTH_STATUS.projectCredentials, reason: `.npmrc define ${projectCredentialKey}` };
    if (registry.options.authentication === OIDC_AUTHENTICATION) {
      const reason = await oidcEnvironmentProblem(registry);
      return { ...diagnostic, status: reason ? NPM_AUTH_STATUS.unsupportedAuth : NPM_AUTH_STATUS.unknown, source: "OIDC", reason: reason ?? `${registry.label}: OIDC configurado; permiso de publicación no verificable sin publicar` };
    }
    if (registry.options.authentication === BROWSER_AUTHENTICATION) {
      const ci = process.env.CI === "true";
      return { ...diagnostic, status: ci ? NPM_AUTH_STATUS.unsupportedAuth : NPM_AUTH_STATUS.unknown, source: "navegador", reason: ci ? "JSR en CI requiere token u OIDC; no puede autorizarse desde el navegador" : "JSR autoriza la publicación desde el navegador; no se verifican permisos de escritura antes" };
    }
    const resolution = resolveNpmToken(repositoryRoot, { tokenVariable: registry.options.tokenEnv });
    diagnostic = { ...diagnostic, source: resolution.source };
    if (!resolution.token) return { ...diagnostic, status: NPM_AUTH_STATUS.missingToken };
    if (registry.provider === JSR_REGISTRY_PROVIDER && !JSR_SHELL_SAFE_TOKEN_PATTERN.test(resolution.token)) return { ...diagnostic, status: NPM_AUTH_STATUS.unsupportedAuth, reason: "El token JSR no se puede pasar de forma segura al cliente oficial" };
    if (registry.provider !== NPM_REGISTRY_PROVIDER) return { ...diagnostic, reason: `${registry.label}: permiso de escritura no verificable; no se ejecutan npm whoami ni npm owner ls` };
    const npmAuth = await checkNpmAccess(registry.packageName, repositoryRoot, registry.registryUrl, { tokenVariable: registry.options.tokenEnv, pinScope: true });
    return { ...npmAuth, tokenVariable: registry.options.tokenEnv, registryLabel: registry.label };
  } catch (error) {
    return { ...diagnostic, reason: error instanceof Error ? error.message : "No se pudo verificar la autenticación" };
  }
}

/**
 * Publishes with the chosen protocol and reconciles a failed client before declaring an unpublished version.
 *
 * @param {RegistrySelection} selection - One configured provider.
 * @param {Record<string, unknown>} manifest - Release manifest.
 * @param {string} repositoryRoot - Routing and credential root.
 * @param {string} packageRoot - Actual release checkout.
 * @param {string} version - Stable release version.
 * @param {string | null} [artifactPath] - Verified npm archive; unused by native JSR.
 * @returns {Promise<{ registry: SelectedRegistry, exitCode: number, missingToken: boolean, confirmed: boolean }>} Publication and reconciliation result.
 */
export async function publishRegistryRelease(selection, manifest, repositoryRoot, packageRoot, version, artifactPath = null) {
  const registry = await resolveRegistry(selection, manifest, repositoryRoot, packageRoot);
  const token = registry.options.authentication === "token" ? resolveNpmToken(repositoryRoot, { tokenVariable: registry.options.tokenEnv }).token : null;
  if (registry.options.authentication === "token" && !token) return { registry, exitCode: 1, missingToken: true, confirmed: false };
  if (registry.provider === JSR_REGISTRY_PROVIDER) {
    const native = readJsrManifest(packageRoot, registry.options.configFile);
    if (native.manifest.version !== version) throw new Error(`JSR: ${native.filePath} no declara la versión del release ${version}`);
  }
  const result = registry.provider === JSR_REGISTRY_PROVIDER
    ? { exitCode: await publishToJsr(packageRoot, registry, token), missingToken: false }
    : await publishToNpm(repositoryRoot, {
      authConfigLine: token ? buildNpmAuthConfigLine(registry.registryUrl) : "", artifactPath, packageRoot, registryUrl: registry.registryUrl,
      tokenVariable: registry.options.tokenEnv, authentication: registry.options.authentication === OIDC_AUTHENTICATION ? "oidc" : "token", access: registry.options.access, tag: registry.options.tag, packageName: registry.packageName,
    });
  if (result.exitCode === 0 && registry.provider !== JSR_REGISTRY_PROVIDER) return { registry, ...result, confirmed: true };
  const lookup = await lookupRegistryVersions(selection, manifest, repositoryRoot, packageRoot);
  const confirmed = lookup.status === NPM_LOOKUP_STATUS.ok && lookup.publishedVersions.includes(version);
  return { registry, ...result, confirmed };
}
