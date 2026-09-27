/**
 * Contract of `beez-rp guard-publish`, the `prepublishOnly` guard that keeps
 * Beez packages from being published by a package manager other than npm.
 *
 * @module constants/guard-publish
 */

/**
 * Environment variable package managers set for lifecycle scripts, for
 * example `pnpm/12.6.0 npm/? node/v24.21.0 win32 x64`. npm also reads it as its
 * `user-agent` config, so an inherited value survives `npm publish`.
 */
export const PACKAGE_MANAGER_USER_AGENT_VARIABLE = "npm_config_user_agent";

/** User agent prefix of npm, the only package manager allowed to publish. */
export const ALLOWED_PUBLISH_USER_AGENT_PREFIX = "npm/";

/** Package managers whose `publish` is blocked, keyed by their user agent prefix. */
export const BLOCKED_PUBLISH_PACKAGE_MANAGERS = Object.freeze({
  "pnpm/": "pnpm",
  "yarn/": "yarn",
  "bun/": "bun",
});

/** Exit codes of `beez-rp guard-publish`. */
export const GUARD_PUBLISH_EXIT_CODE = Object.freeze({
  allowed: 0,
  blocked: 1,
});
