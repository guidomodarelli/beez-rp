/**
 * Entry point of the process started by `listConfigModules`: registers a module hook that records
 * every `file:` module Node loads, imports the `create-version` configuration of the repository
 * given as first argument, and sends the recorded URLs (or why it could not load the configuration)
 * to the parent process.
 *
 * Nothing of beez-rp is imported statically: the loader (`config.js`) and everything it needs are
 * imported after the hook is registered, so a configuration that imports beez-rp modules from the
 * same files (as beez-rp itself can, releasing from its own checkout) still lists them. A module
 * loaded before the hook would stay cached and never reach it. The parent checks beforehand that
 * `module.registerHooks` exists.
 *
 * @module create-version/config-modules-process
 */

import module from "node:module";

/**
 * @typedef {{ moduleUrls?: string[], reason?: string }} ConfigModulesMessage
 */

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

/**
 * Imports the configuration while recording the `file:` URL of every module Node loads for it,
 * through ESM `import` and CommonJS `require` alike.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {Promise<ConfigModulesMessage>} Loaded module URLs, or why they could not be listed.
 */
async function recordConfigModules(repositoryRoot) {
  /** @type {Set<string>} */
  const moduleUrls = new Set();
  module.registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:")) {
        moduleUrls.add(url);
      }

      return nextLoad(url, context);
    },
  });

  try {
    const { loadCreateVersionConfig } = await import("./config.js");
    await loadCreateVersionConfig(repositoryRoot);
    return { moduleUrls: [...moduleUrls] };
  } catch (error) {
    return { reason: describeLoadFailure(error) };
  }
}

const [repositoryRoot] = process.argv.slice(2);
process.send?.(/** @type {ConfigModulesMessage} */ (await recordConfigModules(repositoryRoot)));
