/**
 * Loads the `create-version` configuration stored in a release tag. `--retry-ci` dispatches the
 * workflow of the tag with `--ref <tag>` and the worker reloads its configuration from that tag, so
 * the workflow name and the Actions bindings checked before the retry must come from the tag too,
 * not from a working tree that later commits may have changed without bumping the version.
 * @module create-version/release-tag-config
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { CI_RELEASE_TAG_CONFIG_DIRECTORY_PREFIX } from "../constants/ci-release.js";
import { CREATE_VERSION_CONFIG_FILES, CREATE_VERSION_FLAG } from "../constants/create-version.js";
import { loadCreateVersionConfig } from "./config.js";
import { ReleaseStepError } from "./errors.js";
import { runCaptured } from "./process.js";

/** Name of the temporary Git index used to check out the tag without touching the project's index. */
const TEMPORARY_INDEX_FILE = "index";

/** Directory, inside the temporary one, that receives the tagged tree. */
const TAGGED_TREE_DIRECTORY = "tree";

/**
 * Runs Git in the repository and fails with a retry-specific diagnostic.
 * @param {string} repositoryRoot - Project root.
 * @param {string[]} gitArguments - Git arguments.
 * @param {string} tag - Release tag being retried, for diagnostics.
 * @param {NodeJS.ProcessEnv} [environment] - Environment of the Git process.
 * @returns {Promise<string>} Captured standard output.
 * @throws {ReleaseStepError} When Git exits with a non-zero status.
 */
async function runTagGit(repositoryRoot, gitArguments, tag, environment) {
  const result = await runCaptured("git", gitArguments, { cwd: repositoryRoot, env: environment });
  if (result.status !== 0) {
    throw new ReleaseStepError(
      `No se pudo leer la configuración guardada en ${tag} (git ${gitArguments[0]} terminó con status ${result.status}: ${result.stderr}).`,
      `Revisá el repositorio Git y volvé a correr --${CREATE_VERSION_FLAG.retryCi} ${tag}; no se envió ninguna ejecución.`
    );
  }
  return result.stdout;
}

/**
 * Checks out a release tag into a temporary directory inside the repository's Git directory and
 * loads the configuration stored there. The checkout uses its own index, so the project's index,
 * working tree and refs stay untouched, and it is removed before returning. Placing it under the
 * project lets the tagged configuration import the dependencies installed in the project root.
 * @param {string} repositoryRoot - Project root.
 * @param {string} tag - Release tag already verified against origin, such as `v1.2.4`.
 * @returns {Promise<import("./config.js").ResolvedCreateVersionConfig>} Configuration the worker loads from the tag.
 * @throws {ReleaseStepError} When the tag cannot be checked out or its configuration is missing or invalid.
 */
export async function loadReleaseTagConfig(repositoryRoot, tag) {
  const gitDirectory = await runTagGit(repositoryRoot, ["rev-parse", "--absolute-git-dir"], tag);
  const temporaryDirectory = mkdtempSync(path.join(gitDirectory, CI_RELEASE_TAG_CONFIG_DIRECTORY_PREFIX));
  try {
    const taggedTree = path.join(temporaryDirectory, TAGGED_TREE_DIRECTORY);
    mkdirSync(taggedTree);
    const environment = { ...process.env, GIT_INDEX_FILE: path.join(temporaryDirectory, TEMPORARY_INDEX_FILE) };
    await runTagGit(repositoryRoot, ["read-tree", `refs/tags/${tag}^{tree}`], tag, environment);
    // Git on Windows needs `/` separators in the prefix; the trailing `/` makes it a directory.
    await runTagGit(repositoryRoot, ["checkout-index", "--all", "--force", `--prefix=${taggedTree.replaceAll("\\", "/")}/`], tag, environment);
    try {
      return await loadCreateVersionConfig(taggedTree);
    } catch (error) {
      throw new ReleaseStepError(
        `No se pudo cargar ${CREATE_VERSION_CONFIG_FILES.join(" o ")} desde ${tag}: el worker usa la configuración del tag, no la del working tree.`,
        `Revisá la configuración commiteada en ${tag} y las dependencias que importa; no se envió ninguna ejecución.`,
        { cause: error }
      );
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
