/**
 * Module graph of the `create-version` configuration: the files of the repository that
 * `beez-rp.config.(m)js` loads, directly or through the modules it imports.
 *
 * The run imports the configuration once, from the working tree, before `--ignore-local-changes`
 * sets the uncommitted changes aside, and Node keeps every imported module in its cache. A local
 * change in any file of this graph therefore reaches the release (its `versionFiles`, checks,
 * migrations and hooks, including the values they capture) even after it is set aside, so the plan
 * blocks it like a change in the configuration file itself.
 *
 * The graph is read in a new Node process with a module hook, so it lists what the configuration
 * really loads (ESM `import`, CommonJS `require` and JSON modules) instead of guessing from its
 * source, including ignored or untracked files and a module imported through a symbolic link (the
 * link itself is listed, besides its target when that is inside the repository). Files the
 * configuration reads with `fs` instead of importing them are not modules and are not listed.
 *
 * @module create-version/config-modules
 */

import { fork } from "node:child_process";
import { realpathSync } from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODULE_HOOKS_MINIMUM_NODE_VERSION, NODE_MODULES_DIRECTORY } from "../constants/create-version.js";

/**
 * @typedef {{ loaded: true, files: string[] } | { loaded: false, reason: string }} ConfigModuleGraph
 *   `files` are relative to the repository root, separated with `/` like `git status` paths, and
 *   only include files inside the repository, outside `node_modules`.
 * @typedef {import("./config-modules-process.js").ConfigModulesMessage} ConfigModulesMessage
 */

/** Script run by the new process: loads the configuration and sends the modules it loaded back. */
const CONFIG_MODULES_PROCESS_SCRIPT = fileURLToPath(new URL("./config-modules-process.js", import.meta.url));

/**
 * Resolves the directory of a path through symbolic links and, on Windows, to its real casing,
 * keeping the last segment as it is: the module URLs and the repository root then compare equal
 * whatever spelling each one used, and a module that is itself a symbolic link keeps its own path
 * (so it can be reported as a symbolic link instead of disappearing behind its target).
 *
 * @param {string} filePath - Path whose directory exists.
 * @returns {string} Path with a canonical directory, or the same path when it cannot be resolved.
 */
function toCanonicalPath(filePath) {
  try {
    return path.join(realpathSync.native(path.dirname(filePath)), path.basename(filePath));
  } catch {
    return filePath;
  }
}

/**
 * Turns the loaded module URLs into repository-relative paths, dropping modules outside the
 * repository and installed dependencies (anything inside a `node_modules` directory): Node
 * built-ins never reach here.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string[]} moduleUrls - `file:` URLs of the loaded modules.
 * @returns {string[]} Sorted repository-relative paths separated with `/`.
 */
function toRepositoryFiles(repositoryRoot, moduleUrls) {
  const canonicalRoot = realpathSync.native(repositoryRoot);
  const files = new Set();

  for (const moduleUrl of moduleUrls) {
    const relativePath = path.relative(canonicalRoot, toCanonicalPath(fileURLToPath(moduleUrl)));
    const segments = relativePath.split(path.sep);

    if (relativePath && segments[0] !== ".." && !path.isAbsolute(relativePath) && !segments.includes(NODE_MODULES_DIRECTORY)) {
      files.add(segments.join("/"));
    }
  }

  return [...files].toSorted();
}

/**
 * Loads the configuration of a repository in a new Node process and lists the repository files it
 * loaded as modules. The process is stopped as soon as it answers, so a configuration that leaves
 * handles open (a database pool, a timer) does not keep the diagnosis waiting.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {Promise<ConfigModuleGraph>} Files of the module graph, or why the configuration could not be loaded; never rejects.
 */
export function listConfigModules(repositoryRoot) {
  // The new process runs on this same Node binary, so it lacks the hooks exactly when this one does.
  if (typeof module.registerHooks !== "function") {
    return Promise.resolve({
      loaded: false,
      reason: `Node ${process.versions.node} no permite registrar hooks de módulos síncronos (module.registerHooks); hace falta Node ${MODULE_HOOKS_MINIMUM_NODE_VERSION} o posterior`,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const graphProcess = fork(CONFIG_MODULES_PROCESS_SCRIPT, [repositoryRoot], { cwd: repositoryRoot, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errorOutput = "";

    /** @param {ConfigModuleGraph} outcome */
    const settle = (outcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    graphProcess.stderr?.setEncoding("utf8").on("data", (chunk) => (errorOutput += chunk));
    graphProcess.on("message", (/** @type {ConfigModulesMessage} */ message) => {
      settle(
        message.moduleUrls
          ? { loaded: true, files: toRepositoryFiles(repositoryRoot, message.moduleUrls) }
          : { loaded: false, reason: message.reason ?? "motivo desconocido" }
      );
      graphProcess.kill();
    });
    graphProcess.on("error", (error) => settle({ loaded: false, reason: error.message }));
    // `close` comes after the IPC channel is drained, so a message sent right before exiting is never lost.
    graphProcess.on("close", (exitCode) =>
      settle({ loaded: false, reason: errorOutput.trim() || `el proceso terminó con código ${exitCode ?? "desconocido"} sin responder` })
    );
  });
}
