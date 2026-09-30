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
 * source. Files the configuration reads with `fs` instead of importing them are not modules and are
 * not listed.
 *
 * @module create-version/config-modules
 */

import { fork } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @typedef {{ loaded: true, files: string[] } | { loaded: false, reason: string }} ConfigModuleGraph
 *   `files` are relative to the repository root, separated with `/` like `git status` paths, and
 *   only include files inside the repository.
 * @typedef {import("./config-modules-process.js").ConfigModulesMessage} ConfigModulesMessage
 */

/** Script run by the new process: loads the configuration and sends the modules it loaded back. */
const CONFIG_MODULES_PROCESS_SCRIPT = fileURLToPath(new URL("./config-modules-process.js", import.meta.url));

/**
 * Resolves a path through symbolic links and, on Windows, to its real casing, so a module URL and
 * the repository root compare equal whatever spelling each one used.
 *
 * @param {string} filePath - Existing path.
 * @returns {string} Canonical path, or the same path when it cannot be resolved.
 */
function toCanonicalPath(filePath) {
  try {
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

/**
 * Turns the loaded module URLs into repository-relative paths, dropping modules outside the
 * repository (Node built-ins never reach here; dependencies installed elsewhere do).
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string[]} moduleUrls - `file:` URLs of the loaded modules.
 * @returns {string[]} Sorted repository-relative paths separated with `/`.
 */
function toRepositoryFiles(repositoryRoot, moduleUrls) {
  const canonicalRoot = toCanonicalPath(repositoryRoot);
  const files = new Set();

  for (const moduleUrl of moduleUrls) {
    const relativePath = path.relative(canonicalRoot, toCanonicalPath(fileURLToPath(moduleUrl)));

    if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath)) {
      files.add(relativePath.split(path.sep).join("/"));
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
