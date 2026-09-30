/**
 * Entry point of the process started by `listConfigModules`: registers module hooks that record
 * every `file:` module Node loads (and every symbolic link it follows to reach one), imports the `create-version` configuration of the repository
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

import { lstatSync } from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * Returns the `file:` URL a specifier names before Node follows symbolic links, when that is a
 * symbolic link: Node loads the module from its real path, so without this the link would never
 * show up in the graph.
 *
 * @param {string} specifier - Specifier as written in the `import` or `require`.
 * @param {string | undefined} parentUrl - URL of the importing module.
 * @returns {string | null} URL of the symbolic link, or `null` when the specifier is not a file
 *   path (a package, a built-in) or does not name a symbolic link.
 */
function findSymbolicLinkUrl(specifier, parentUrl) {
  let requestedUrl;

  try {
    if (specifier.startsWith("file:")) {
      requestedUrl = new URL(specifier);
    } else if (path.isAbsolute(specifier)) {
      requestedUrl = pathToFileURL(specifier);
    } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && parentUrl?.startsWith("file:")) {
      requestedUrl = new URL(specifier, parentUrl);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  return lstatSync(fileURLToPath(requestedUrl), { throwIfNoEntry: false })?.isSymbolicLink() ? requestedUrl.href : null;
}

/**
 * Imports the configuration while recording the `file:` URL of every module Node loads for it,
 * through ESM `import` and CommonJS `require` alike, plus the symbolic links followed to reach them.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {Promise<ConfigModulesMessage>} Loaded module URLs, or why they could not be listed.
 */
async function recordConfigModules(repositoryRoot) {
  /** @type {Set<string>} */
  const moduleUrls = new Set();
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const symbolicLinkUrl = findSymbolicLinkUrl(specifier, context.parentURL);

      if (symbolicLinkUrl) {
        moduleUrls.add(symbolicLinkUrl);
      }

      return nextResolve(specifier, context);
    },
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
