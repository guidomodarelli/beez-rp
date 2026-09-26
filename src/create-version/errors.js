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
