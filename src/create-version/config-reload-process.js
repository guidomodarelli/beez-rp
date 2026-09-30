/**
 * Entry point of the process started by `reloadReleaseInstructions`: imports the
 * `create-version` configuration of the repository given as first argument, with an empty module
 * cache, and sends its release instructions (or why it could not load it) to the parent process.
 *
 * @module create-version/config-reload-process
 */

import { loadCreateVersionConfig } from "./config.js";
import { describeReleaseInstructions } from "./config-reload.js";

/**
 * Describes a load failure with the messages of its whole `cause` chain, so the parent can show
 * which module failed.
 *
 * @param {unknown} error - Load failure.
 * @returns {string} Messages joined with `: `.
 */
function describeLoadFailure(error) {
  const messages = [];
  /** @type {unknown} */
  let currentError = error;

  while (currentError !== undefined && currentError !== null) {
    messages.push(currentError instanceof Error ? currentError.message : String(currentError));
    currentError = currentError instanceof Error ? currentError.cause : undefined;
  }

  return messages.join(": ");
}

const [repositoryRoot] = process.argv.slice(2);

try {
  const config = await loadCreateVersionConfig(repositoryRoot);
  process.send?.({ instructions: describeReleaseInstructions(config) });
} catch (error) {
  process.send?.({ reason: describeLoadFailure(error) });
}
