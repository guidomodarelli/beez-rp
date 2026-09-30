/**
 * Reload of the `create-version` configuration in a new Node process, so a run can tell whether the
 * configuration it already imported depends on files it later set aside.
 *
 * Node caches every imported module for the life of the process: importing
 * `beez-rp.config.(m)js` again would reuse the helpers it imported the first time. A new process
 * imports the configuration, and every module it depends on, as the working tree holds them now.
 *
 * @module create-version/config-reload
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import { RELEASE_INSTRUCTION_FIELDS } from "../constants/create-version.js";

/**
 * @typedef {import("./config.js").ResolvedCreateVersionConfig} ResolvedCreateVersionConfig
 * @typedef {Record<string, unknown>} ReleaseInstructions
 *   The {@link RELEASE_INSTRUCTION_FIELDS} of a resolved configuration, as plain JSON values.
 * @typedef {{ loaded: true, instructions: ReleaseInstructions } | { loaded: false, reason: string }} ReleaseInstructionsReload
 * @typedef {{ instructions?: ReleaseInstructions, reason?: string }} ReloadProcessMessage
 */

/** Script run by the new process: loads the configuration and sends its release instructions back. */
const RELOAD_PROCESS_SCRIPT = fileURLToPath(new URL("./config-reload-process.js", import.meta.url));

/**
 * Describes a configuration value as plain JSON: a hook becomes its source code, so two processes
 * that load the same code describe it the same way.
 *
 * @param {unknown} value - Value of a configuration field.
 * @returns {unknown} JSON value.
 */
function describeInstructionValue(value) {
  return typeof value === "function" ? `function: ${value.toString()}` : (value ?? null);
}

/**
 * Takes the fields of a resolved configuration that decide what the release commits, validates and
 * publishes ({@link RELEASE_INSTRUCTION_FIELDS}).
 *
 * @param {ResolvedCreateVersionConfig} config - Resolved configuration.
 * @returns {ReleaseInstructions} Release instructions, as plain JSON values.
 */
export function describeReleaseInstructions(config) {
  const configFields = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (config));
  return Object.fromEntries(RELEASE_INSTRUCTION_FIELDS.map((field) => [field, describeInstructionValue(configFields[field])]));
}

/**
 * Lists the release instructions that differ between two descriptions of the configuration.
 *
 * @param {ReleaseInstructions} loaded - Instructions of the configuration the run uses.
 * @param {ReleaseInstructions} reloaded - Instructions of the configuration loaded again.
 * @returns {string[]} Names of the fields that differ, in {@link RELEASE_INSTRUCTION_FIELDS} order.
 */
export function listChangedReleaseInstructions(loaded, reloaded) {
  return RELEASE_INSTRUCTION_FIELDS.filter((field) => JSON.stringify(loaded[field]) !== JSON.stringify(reloaded[field]));
}

/**
 * Loads the configuration of a repository in a new Node process and returns its release
 * instructions. The process is stopped as soon as it answers, so a configuration that leaves
 * handles open (a database pool, a timer) does not keep the release waiting.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {Promise<ReleaseInstructionsReload>} Instructions, or why the configuration could not be loaded; never rejects.
 */
export function reloadReleaseInstructions(repositoryRoot) {
  return new Promise((resolve) => {
    let settled = false;
    const reloadProcess = fork(RELOAD_PROCESS_SCRIPT, [repositoryRoot], { cwd: repositoryRoot, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errorOutput = "";

    /** @param {ReleaseInstructionsReload} outcome */
    const settle = (outcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    reloadProcess.stderr?.setEncoding("utf8").on("data", (chunk) => (errorOutput += chunk));
    reloadProcess.on("message", (/** @type {ReloadProcessMessage} */ message) => {
      settle(message.instructions ? { loaded: true, instructions: message.instructions } : { loaded: false, reason: message.reason ?? "motivo desconocido" });
      reloadProcess.kill();
    });
    reloadProcess.on("error", (error) => settle({ loaded: false, reason: error.message }));
    // `close` comes after the IPC channel is drained, so a message sent right before exiting is never lost.
    reloadProcess.on("close", (exitCode) => settle({ loaded: false, reason: errorOutput.trim() || `el proceso terminó con código ${exitCode ?? "desconocido"} sin responder` }));
  });
}
