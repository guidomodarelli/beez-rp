/**
 * Defines providers, authentication modes and transport defaults for one-registry releases.
 *
 * @module constants/registry
 */

/** npm package registry provider. */
export const NPM_REGISTRY_PROVIDER = "npm";
/** GitHub Packages provider. */
export const GITHUB_REGISTRY_PROVIDER = "github";
/** GitLab package registry provider. */
export const GITLAB_REGISTRY_PROVIDER = "gitlab";
/** Native JSR provider. */
export const JSR_REGISTRY_PROVIDER = "jsr";
/** Providers that can publish without a project-defined hook. */
export const REGISTRY_PROVIDERS = Object.freeze([NPM_REGISTRY_PROVIDER, GITHUB_REGISTRY_PROVIDER, GITLAB_REGISTRY_PROVIDER, JSR_REGISTRY_PROVIDER]);

/** Token-based authentication mode. */
export const TOKEN_AUTHENTICATION = "token";
/** Tokenless CI authentication mode. */
export const OIDC_AUTHENTICATION = "oidc";
/** Interactive JSR browser authentication mode. */
export const BROWSER_AUTHENTICATION = "browser";
/** Authentication modes accepted in project configuration. */
export const REGISTRY_AUTHENTICATION_MODES = Object.freeze([TOKEN_AUTHENTICATION, OIDC_AUTHENTICATION, BROWSER_AUTHENTICATION]);

/** Provider names used in terminal feedback. */
export const REGISTRY_LABELS = Object.freeze({ npm: "npm", github: "GitHub Packages", gitlab: "GitLab", jsr: "JSR" });
/** Public GitHub Packages npm endpoint. */
export const GITHUB_PACKAGES_REGISTRY_URL = "https://npm.pkg.github.com/";
/** Public native JSR endpoint. */
export const JSR_REGISTRY_URL = "https://jsr.io/";
/** Default credential variable for each provider. */
export const NPM_REGISTRY_TOKEN_VARIABLE = "NPM_TOKEN";
/** GitHub Actions token or a classic PAT stored under this variable. */
export const GITHUB_REGISTRY_TOKEN_VARIABLE = "GITHUB_TOKEN";
/** GitLab access token; a project may configure CI_JOB_TOKEN instead. */
export const GITLAB_REGISTRY_TOKEN_VARIABLE = "GITLAB_TOKEN";
/** Personal JSR publishing token. */
export const JSR_REGISTRY_TOKEN_VARIABLE = "JSR_TOKEN";
/** Default token variables indexed by the selected provider. */
export const REGISTRY_TOKEN_VARIABLES = Object.freeze({ npm: NPM_REGISTRY_TOKEN_VARIABLE, github: GITHUB_REGISTRY_TOKEN_VARIABLE, gitlab: GITLAB_REGISTRY_TOKEN_VARIABLE, jsr: JSR_REGISTRY_TOKEN_VARIABLE });
/** Variable names safe to reference from npm configuration and child-process environments. */
export const REGISTRY_TOKEN_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** Distribution tags safe to pass as one npm CLI operand. */
export const REGISTRY_DIST_TAG_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/u;
/** npm access modes supported by registry publishers. */
export const REGISTRY_ACCESS_MODES = Object.freeze(["public", "restricted"]);
/** HTTP timeout for direct metadata lookups, in milliseconds. */
export const REGISTRY_LOOKUP_TIMEOUT_MS = 15_000;
/** GitLab publishing uses a project endpoint, including on self-managed instances. */
export const GITLAB_PROJECT_REGISTRY_PATTERN = /\/api\/v4\/projects\/[^/]+\/packages\/npm\/?$/u;
/** JSR configuration filenames, in preferred lookup order. */
export const JSR_CONFIG_FILES = Object.freeze(["jsr.json", "jsr.jsonc", "deno.json", "deno.jsonc"]);
/** Scoped JSR names with command-line-safe scope and package components. */
export const JSR_PACKAGE_NAME_PATTERN = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
/** Pinned official npm client used when JSR does not use an installed Deno client. */
export const JSR_NPM_CLIENT_SPEC = "jsr@0.14.3";
/** JSR client choices. */
export const JSR_CLIENTS = Object.freeze(["npx", "deno"]);
/** Child-only JSR token variable expanded by the command shell, never logged by beez-rp. */
export const JSR_CHILD_TOKEN_VARIABLE = "BEEZ_RP_JSR_TOKEN";
/** Opaque JSR tokens safe to substitute as one shell-quoted operand. */
export const JSR_SHELL_SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/u;
/** Minimum npm CLI version that implements trusted publishing. */
export const NPM_OIDC_MINIMUM_VERSION = "11.5.1";
/** Minimum Node version needed by npm trusted publishing. */
export const NPM_OIDC_MINIMUM_NODE_VERSION = "22.14.0";
