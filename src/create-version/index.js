/**
 * `beez-rp/create-version`: shared release command of the Beez projects.
 *
 * Projects run it as `beez-rp create-version` and describe their differences
 * in `beez-rp.config.js` (checks, migrations,
 * preparation, publication). The pure planner and the state reader are
 * exported for project tests and custom tooling.
 *
 * @module create-version
 */

/**
 * @typedef {import("./config.js").CreateVersionConfig} CreateVersionConfig
 * @typedef {import("./ci-config.js").CiReleaseConfig} CiReleaseConfig
 */

export {
  computeNpmIntegrity,
  computeSha256,
  expandArtifactPattern,
  findPnpmPackRewrites,
  findPreparedArtifact,
  isSafeArtifactPath,
  verifyPreparedArtifact,
  withArtifactOutsidePackageRoot,
} from "./artifact.js";
export { defineCreateVersionConfig, loadCreateVersionConfig, resolveCreateVersionConfig } from "./config.js";
export { CiReleaseError, ReleaseStepError } from "./errors.js";
export { resolveCiReleaseConfig } from "./ci-config.js";
export {
  buildNpmAuthConfigLine,
  buildNpmOwnerListArguments,
  buildNpmPublishArguments,
  buildNpmPublishEnvironment,
  buildNpmTokenEnvironment,
  buildNpmViewArguments,
  buildNpmWhoamiArguments,
  checkNpmPublishAccess,
  lookupPublishedVersions,
  parseNpmOwnerList,
  parseNpmPackDryRunOutput,
  publishToNpm,
  readNpmPackIntegrity,
  resolveNpmToken,
  resolvePublishRegistry,
  withNpmAuthConfig,
} from "./npm.js";
export { describeNpmAuthProblem, describeNpmPublishFailure, describeNpmTokenSource } from "./npm-auth.js";
export { DEFAULT_CAPABILITIES, RELEASE_USAGE, buildReleasePlan, describeFeatureBranchGaps, parseReleaseArguments } from "./plan.js";
export { createGitReader, listCommits, parseCommitLog, readPackageManifestAt, readPackageVersionAt, runCaptured, runCommandLine, runInherited } from "./process.js";
export { createHookContext, runCreateVersion } from "./run.js";
export { collectReleaseState, findLastRelease, readChangelogState } from "./state.js";
export { isRegistryProvider, resolvePublicationOptions } from "./registry-config.js";
export { checkRegistryAccess, lookupRegistryVersions, resolveRegistry, selectProjectRegistry } from "./registry.js";
