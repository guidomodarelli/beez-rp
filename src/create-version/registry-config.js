/**
 * Validates provider-specific publication options while keeping legacy npm configuration intact.
 *
 * @module create-version/registry-config
 */

import path from "node:path";
import { CHANGELOG_FILE } from "../constants/changelog.js";

import {
  BROWSER_AUTHENTICATION,
  JSR_CLIENTS,
  JSR_REGISTRY_PROVIDER,
  NPM_REGISTRY_PROVIDER,
  REGISTRY_ACCESS_MODES,
  REGISTRY_AUTHENTICATION_MODES,
  REGISTRY_DIST_TAG_PATTERN,
  REGISTRY_PROVIDERS,
  REGISTRY_TOKEN_VARIABLE_PATTERN,
  REGISTRY_TOKEN_VARIABLES,
  TOKEN_AUTHENTICATION,
} from "../constants/registry.js";
import { NPM_DIST_TAG } from "../constants/create-version.js";

/**
 * @typedef {"npm" | "github" | "gitlab" | "jsr"} RegistryProvider
 * @typedef {"token" | "oidc" | "browser"} RegistryAuthentication
 * @typedef {{ registryUrl?: string, packageName?: string, authentication?: RegistryAuthentication, tokenEnv?: string, access?: "public" | "restricted", tag?: string, configFile?: string, jsrClient?: "npx" | "deno" }} PublicationOptions
 * @typedef {{ registryUrl: string | null, packageName: string | null, authentication: RegistryAuthentication, tokenEnv: string, access: "public" | "restricted" | null, tag: string | null, configFile: string | null, jsrClient: "npx" | "deno" }} ResolvedPublicationOptions
 */

/**
 * Identifies one of the four built-in publishers.
 *
 * @param {unknown} value - Configured publisher or registry.
 * @returns {value is RegistryProvider} Whether it is a provider name.
 */
export function isRegistryProvider(value) {
  return typeof value === "string" && /** @type {readonly string[]} */ (REGISTRY_PROVIDERS).includes(value);
}

/**
 * Resolves publication options for a single selected provider; arrays are deliberately unsupported.
 *
 * @param {unknown} value - Raw `publication` configuration.
 * @param {RegistryProvider} [provider] - Selected publisher or monitored registry.
 * @returns {ResolvedPublicationOptions} Validated options and provider defaults.
 * @throws {Error} When a field is invalid or unsupported by the selected provider.
 */
export function resolvePublicationOptions(value, provider = NPM_REGISTRY_PROVIDER) {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("beez-rp create-version: publication must be an object for a single registry");
  }
  const options = /** @type {PublicationOptions} */ (value ?? {});
  const authentication = options.authentication ?? (provider === JSR_REGISTRY_PROVIDER ? BROWSER_AUTHENTICATION : TOKEN_AUTHENTICATION);
  if (!(/** @type {readonly string[]} */ (REGISTRY_AUTHENTICATION_MODES)).includes(authentication)) {
    throw new Error("beez-rp create-version: publication.authentication must be token, oidc or browser");
  }
  if (authentication !== TOKEN_AUTHENTICATION && provider !== NPM_REGISTRY_PROVIDER && provider !== JSR_REGISTRY_PROVIDER) {
    throw new Error(`beez-rp create-version: ${provider} only supports token authentication`);
  }
  if (authentication === BROWSER_AUTHENTICATION && provider !== JSR_REGISTRY_PROVIDER) {
    throw new Error("beez-rp create-version: browser authentication is supported only by JSR");
  }
  const tokenEnv = options.tokenEnv ?? REGISTRY_TOKEN_VARIABLES[provider];
  if (typeof tokenEnv !== "string" || !REGISTRY_TOKEN_VARIABLE_PATTERN.test(tokenEnv)) {
    throw new Error("beez-rp create-version: publication.tokenEnv must be an environment variable name");
  }
  for (const field of ["registryUrl", "packageName", "configFile"]) {
    const candidate = options[/** @type {"registryUrl" | "packageName" | "configFile"} */ (field)];
    if (candidate !== undefined && (typeof candidate !== "string" || candidate.trim() === "")) {
      throw new Error(`beez-rp create-version: publication.${field} must be a non-empty string`);
    }
  }
  if (options.registryUrl !== undefined) {
    const url = new URL(options.registryUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("beez-rp create-version: publication.registryUrl must be an http(s) URL without credentials, query or fragment");
    }
  }
  if (options.access !== undefined && !(/** @type {readonly string[]} */ (REGISTRY_ACCESS_MODES)).includes(options.access)) {
    throw new Error("beez-rp create-version: publication.access must be public or restricted");
  }
  if (options.tag !== undefined && (typeof options.tag !== "string" || !REGISTRY_DIST_TAG_PATTERN.test(options.tag))) {
    throw new Error("beez-rp create-version: publication.tag must be a distribution tag without shell characters");
  }
  if (provider === JSR_REGISTRY_PROVIDER && (options.access === "restricted" || options.tag !== undefined)) {
    throw new Error("beez-rp create-version: JSR supports public packages and does not support npm distribution tags");
  }
  if (provider !== JSR_REGISTRY_PROVIDER && (options.configFile !== undefined || options.jsrClient !== undefined)) {
    throw new Error("beez-rp create-version: publication.configFile and publication.jsrClient require publish: jsr");
  }
  const jsrClient = options.jsrClient ?? "npx";
  if (!(/** @type {readonly string[]} */ (JSR_CLIENTS)).includes(jsrClient)) {
    throw new Error("beez-rp create-version: publication.jsrClient must be npx or deno");
  }
  if (options.configFile !== undefined && (path.win32.parse(options.configFile).root !== "" || options.configFile.split(/[\\/]/u).includes("..") || /[%!"\r\n]/u.test(options.configFile) || path.win32.basename(options.configFile).toLowerCase() === CHANGELOG_FILE.toLowerCase())) {
    throw new Error("beez-rp create-version: publication.configFile must be a safe path inside the package root");
  }
  return {
    registryUrl: options.registryUrl ?? null,
    packageName: options.packageName ?? null,
    authentication,
    tokenEnv,
    access: options.access ?? (provider === NPM_REGISTRY_PROVIDER ? "public" : null),
    tag: provider === JSR_REGISTRY_PROVIDER ? null : options.tag ?? NPM_DIST_TAG,
    configFile: options.configFile?.replaceAll("\\", "/") ?? null,
    jsrClient,
  };
}
