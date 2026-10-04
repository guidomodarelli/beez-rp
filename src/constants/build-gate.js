/**
 * Contract between the `beez-rp ignore-build` command and the Vercel
 * `ignoreCommand` wrapper that reads its output.
 *
 * @module constants/build-gate
 */

/** Decision printed as the last output line of `beez-rp ignore-build`. */
export const BUILD_DECISION = Object.freeze({
  build: "BUILD",
  skip: "SKIP",
});

/** Git revision whose `package.json` holds the previous version. */
export const PREVIOUS_REVISION = "HEAD^";

/** Git revision being deployed. */
export const CURRENT_REVISION = "HEAD";

/** `git diff --quiet` status reporting that the compared path changed between both revisions. */
export const GIT_DIFF_CHANGED_STATUS = 1;

/** Manifest that holds the version. */
export const PACKAGE_MANIFEST_FILE = "package.json";

/** Exit code of `beez-rp ignore-build` when a decision was printed. */
export const DECISION_EXIT_CODE = 0;

/** Exit code of `beez-rp ignore-build` when it could not decide; wrappers must skip the build. */
export const GATE_FAILURE_EXIT_CODE = 2;
