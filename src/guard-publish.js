/**
 * `prepublishOnly` guard of the Beez packages: they are published with npm by
 * `create-version` (run through the project's package manager), which verifies the tarball against
 * `npm pack --dry-run`, so a `pnpm publish` (or yarn/bun) is blocked.
 *
 * The guard only blocks package managers it recognizes. Without a user agent,
 * or with an unknown one, the publisher cannot be determined and it allows the
 * publication. It can be bypassed on purpose with `--ignore-scripts`.
 *
 * @module guard-publish
 */

import {
  ALLOWED_PUBLISH_USER_AGENT_PREFIX,
  BLOCKED_PUBLISH_PACKAGE_MANAGERS,
  GUARD_PUBLISH_EXIT_CODE,
  PACKAGE_MANAGER_USER_AGENT_VARIABLE,
} from "./constants/guard-publish.js";
import { describeProjectCommands } from "./package-manager.js";

/**
 * @typedef {{ allowed: boolean, packageManager: string | null, message: string | null, exitCode: number }} PublishGuardDecision
 */

/**
 * Finds the blocked package manager that runs the publication.
 *
 * @param {string | undefined} userAgent - Value of `npm_config_user_agent`.
 * @returns {string | null} Blocked package manager name, or `null` for npm, unknown or missing user agents.
 */
export function findBlockedPublishPackageManager(userAgent) {
  if (!userAgent || userAgent.startsWith(ALLOWED_PUBLISH_USER_AGENT_PREFIX)) {
    return null;
  }

  const blockedEntry = Object.entries(BLOCKED_PUBLISH_PACKAGE_MANAGERS).find(([userAgentPrefix]) => userAgent.startsWith(userAgentPrefix));
  return blockedEntry ? blockedEntry[1] : null;
}

/**
 * Builds the explanation printed when a publication is blocked.
 *
 * @param {string} packageManager - Blocked package manager name (pnpm, yarn or bun), which is also
 *   the one the project uses: the message names its own create-version command.
 * @returns {string} Message in Spanish with what to run instead.
 */
export function buildBlockedPublishMessage(packageManager) {
  const { createVersion } = describeProjectCommands(/** @type {import("./package-manager.js").PackageManagerName} */ (packageManager));
  return (
    `beez-rp guard-publish: no publiques con ${packageManager}. Los paquetes Beez se publican con \`${createVersion}\`, ` +
    "que publica con npm y verifica el tarball contra `npm pack --dry-run`."
  );
}

/**
 * Decides whether the publication may continue.
 *
 * @param {string | undefined} userAgent - Value of `npm_config_user_agent`.
 * @returns {PublishGuardDecision} Decision, message to print on stderr and exit code.
 */
export function decidePublishGuard(userAgent) {
  const packageManager = findBlockedPublishPackageManager(userAgent);

  return packageManager === null
    ? { allowed: true, packageManager: null, message: null, exitCode: GUARD_PUBLISH_EXIT_CODE.allowed }
    : { allowed: false, packageManager, message: buildBlockedPublishMessage(packageManager), exitCode: GUARD_PUBLISH_EXIT_CODE.blocked };
}

/**
 * Decides with the user agent of an environment (the current process by default).
 *
 * @param {NodeJS.ProcessEnv} [environment] - Environment of the lifecycle script.
 * @returns {PublishGuardDecision} Decision for its `npm_config_user_agent`.
 */
export function decidePublishGuardForEnvironment(environment = process.env) {
  return decidePublishGuard(environment[PACKAGE_MANAGER_USER_AGENT_VARIABLE]);
}
