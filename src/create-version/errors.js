/**
 * Errors of `beez-rp create-version`.
 *
 * @module create-version/errors
 */

/** Failure of a release step or hook, with a Spanish explanation and the next action to take. */
export class ReleaseStepError extends Error {
  /**
   * @param {string} message - What failed, in Spanish.
   * @param {string} hint - What to do next, in Spanish.
   * @param {{ cause?: unknown }} [options] - Original error, when wrapping one.
   */
  constructor(message, hint, options) {
    super(message, options);
    this.name = "ReleaseStepError";
    this.hint = hint;
  }
}

/** Reports a CI boundary failure while retaining the release identity for a safe retry.
 * @extends ReleaseStepError
 */
export class CiReleaseError extends ReleaseStepError {
  /**
   * @param {"ci-preflight-failed" | "ci-run-lookup-failed" | "ci-dispatch-unconfirmed"} code - Stable failure category.
   * @param {string} message - Safe Spanish diagnostic.
   * @param {string} hint - Recovery action preserving the existing release.
   * @param {{ cause?: unknown }} [options] - Original dependency failure.
   */
  constructor(code, message, hint, options) {
    super(message, hint, options);
    this.name = "CiReleaseError";
    this.code = code;
  }
}
