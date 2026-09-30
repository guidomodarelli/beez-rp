/**
 * Entry point of the process started by `listConfigModules`: registers module hooks that record
 * every `file:` module Node loads (and every symbolic link inside the repository it follows to reach
 * one, the module itself or any directory on its way), imports the `create-version` configuration of the repository
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

import { lstatSync, realpathSync } from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * @typedef {{ moduleUrls?: string[], symbolicLinkUrls?: string[], reason?: string }} ConfigModulesMessage
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
 * Resolves a specifier to the `file:` URL it names before Node follows symbolic links.
 *
 * @param {string} specifier - Specifier as written in the `import` or `require`.
 * @param {string | undefined} parentUrl - URL of the importing module.
 * @returns {URL | null} Requested URL, or `null` when the specifier is not a file path (a package,
 *   a built-in).
 */
function toRequestedUrl(specifier, parentUrl) {
  try {
    if (specifier.startsWith("file:")) {
      return new URL(specifier);
    }
    if (path.isAbsolute(specifier)) {
      return pathToFileURL(specifier);
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && parentUrl?.startsWith("file:")) {
      return new URL(specifier, parentUrl);
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Lists the symbolic links (or Windows junctions) along a requested module path inside the
 * repository, from its first segment below the root to the module itself. Node loads the module
 * from its real path, so without this a link (the module itself, or any directory on its way, even
 * one pointing outside the repository) would never show up in the graph.
 *
 * @param {string} specifier - Specifier as written in the `import` or `require`.
 * @param {string | undefined} parentUrl - URL of the importing module.
 * @param {string[]} repositoryRoots - Spellings of the repository root (as given and real).
 * @returns {string[]} `file:` URLs of the links, empty when the specifier is not a file path inside
 *   the repository or no segment is a link.
 */
function listSymbolicLinkUrls(specifier, parentUrl, repositoryRoots) {
  const requestedUrl = toRequestedUrl(specifier, parentUrl);

  if (!requestedUrl) {
    return [];
  }

  const requestedPath = fileURLToPath(requestedUrl);
  const repositoryRoot = repositoryRoots.find((root) => {
    const relativePath = path.relative(root, requestedPath);
    return relativePath !== "" && relativePath.split(path.sep)[0] !== ".." && !path.isAbsolute(relativePath);
  });

  if (!repositoryRoot) {
    return [];
  }

  const symbolicLinkUrls = [];
  let currentPath = repositoryRoot;

  for (const segment of path.relative(repositoryRoot, requestedPath).split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatSync(currentPath, { throwIfNoEntry: false });

    if (!stats) {
      break;
    }
    if (stats.isSymbolicLink()) {
      symbolicLinkUrls.push(pathToFileURL(currentPath).href);
    }
  }

  return symbolicLinkUrls;
}

/**
 * Imports the configuration while recording the `file:` URL of every module Node loads for it,
 * through ESM `import` and CommonJS `require` alike (at their real path, where Node loads them),
 * plus the symbolic links inside the repository followed to reach them.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {Promise<ConfigModulesMessage>} Loaded module and symbolic link URLs, or why they could not be listed.
 */
async function recordConfigModules(repositoryRoot) {
  /** @type {Set<string>} */
  const moduleUrls = new Set();
  /** @type {Set<string>} */
  const symbolicLinkUrls = new Set();
  const repositoryRoots = [...new Set([path.resolve(repositoryRoot), realpathSync.native(repositoryRoot)])];
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      for (const symbolicLinkUrl of listSymbolicLinkUrls(specifier, context.parentURL, repositoryRoots)) {
        symbolicLinkUrls.add(symbolicLinkUrl);
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
    return { moduleUrls: [...moduleUrls], symbolicLinkUrls: [...symbolicLinkUrls] };
  } catch (error) {
    return { reason: describeLoadFailure(error) };
  }
}

const [repositoryRoot] = process.argv.slice(2);
process.send?.(/** @type {ConfigModulesMessage} */ (await recordConfigModules(repositoryRoot)));
