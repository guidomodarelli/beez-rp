/**
 * Local changes of `beez-rp create-version --ignore-local-changes`: the
 * uncommitted changes (staged, unstaged and untracked) are set aside in a
 * `git stash` entry while the release runs, so checks, preparation and
 * publication only see the release commit, and are restored at the end.
 *
 * @module create-version/local-changes
 */

import { CHANGELOG_FILE } from "../constants/changelog.js";
import { LOCAL_CHANGES_STASH_MESSAGE } from "../constants/create-version.js";
import { ReleaseStepError } from "./errors.js";

/**
 * @typedef {import("./process.js").GitReader} GitReader
 * @typedef {{ sha: string }} SetAsideChanges
 *   Stash entry holding the changes, identified by its commit so a later stash does not shift it.
 * @typedef {{ restored: true } | { restored: false, reason: string }} LocalChangesRestore
 */

/** Stash references are `stash@{<index>}`; the index shifts when other entries are pushed. */
const STASH_REFERENCE_PREFIX = "stash@";

/**
 * Sets the uncommitted changes aside in a new stash entry.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {{ keepChangelog: boolean }} options - Whether `CHANGELOG.md` stays in the working tree (a new release commits it).
 * @returns {Promise<SetAsideChanges>} Stash entry holding the changes.
 * @throws {ReleaseStepError} When Git cannot create the stash entry; nothing was changed then.
 */
export async function setAsideLocalChanges(reader, { keepChangelog }) {
  const pathspec = keepChangelog ? ["--", ".", `:(exclude)${CHANGELOG_FILE}`] : [];

  if ((await reader.tryGit(["stash", "push", "--include-untracked", "--message", LOCAL_CHANGES_STASH_MESSAGE, ...pathspec])) === null) {
    throw new ReleaseStepError("No se pudieron apartar los cambios sin commitear (git stash push falló).", "No se tocó nada: revisá git status y volvé a correr pnpm create-version.");
  }

  const sha = await reader.tryGit(["rev-parse", "--verify", "--quiet", `${STASH_REFERENCE_PREFIX}{0}`]);

  if (!sha) {
    throw new ReleaseStepError("Se apartaron los cambios pero no se encontró la entrada de git stash.", "Buscalos con git stash list y recuperalos con git stash pop antes de volver a correr pnpm create-version.");
  }

  return { sha };
}

/**
 * Restores the changes set aside by {@link setAsideLocalChanges}, keeping what was staged staged
 * when possible. The stash entry is dropped only when the changes were applied.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {SetAsideChanges} setAside - Stash entry returned by {@link setAsideLocalChanges}.
 * @returns {Promise<LocalChangesRestore>} Whether the changes are back, and why not otherwise.
 */
export async function restoreLocalChanges(reader, setAside) {
  const stashShas = ((await reader.tryGit(["stash", "list", "--format=%H"])) ?? "").split("\n").map((line) => line.trim());
  const stashIndex = stashShas.indexOf(setAside.sha);

  if (stashIndex === -1) {
    return { restored: false, reason: `la entrada ${setAside.sha} ya no está en git stash list` };
  }

  const stashReference = `${STASH_REFERENCE_PREFIX}{${stashIndex}}`;

  // `--index` restores what was staged; it refuses (touching nothing) when the index cannot be
  // rebuilt on the release commit, and then the changes come back unstaged.
  if ((await reader.tryGit(["stash", "pop", "--quiet", "--index", stashReference])) !== null) {
    return { restored: true };
  }

  if ((await reader.tryGit(["stash", "pop", "--quiet", stashReference])) !== null) {
    return { restored: true };
  }

  return { restored: false, reason: `git stash pop ${stashReference} tuvo conflictos con el commit de versión` };
}
