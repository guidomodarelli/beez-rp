/**
 * Local changes of `beez-rp create-version --ignore-local-changes`: the
 * uncommitted changes (staged, unstaged and untracked) are set aside in a
 * `git stash` entry while the release runs, so checks, preparation and
 * publication only see the release commit, and are restored at the end.
 *
 * The restore is exact or nothing: staged changes go back to the index only,
 * unstaged changes to the working tree only and untracked files stay
 * untracked. Every layer is checked before anything is written; when one does
 * not apply cleanly on top of the release, nothing is touched and the stash
 * entry is kept.
 *
 * @module create-version/local-changes
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CHANGELOG_FILE } from "../constants/changelog.js";
import { LOCAL_CHANGES_STASH_MESSAGE } from "../constants/create-version.js";
import { DEFAULT_PROJECT_COMMANDS } from "../package-manager.js";
import { ReleaseStepError } from "./errors.js";

/**
 * @typedef {import("./process.js").GitReader} GitReader
 * @typedef {{ sha: string, keepChangelog: boolean }} SetAsideChanges
 *   Stash entry holding the changes, identified by its commit so a later stash does not shift it;
 *   `keepChangelog` when `CHANGELOG.md` stayed in the working tree (the release commits it).
 * @typedef {{ restored: true } | { restored: false, reason: string }} LocalChangesRestore
 */

/** Stash references are `stash@{<index>}`; the index shifts when other entries are pushed. */
const STASH_REFERENCE_PREFIX = "stash@";

/** Prefix of the temporary directory holding the patches of a restore. */
const RESTORE_DIRECTORY_PREFIX = "beez-rp-local-changes-";

/**
 * Builds the pathspec of the set-aside changes: `CHANGELOG.md` is left out when it stayed in the
 * working tree, because a stash made with a pathspec still records it in its index and tree.
 *
 * @param {boolean} keepChangelog - Whether `CHANGELOG.md` stayed in the working tree.
 * @returns {string[]} Pathspec arguments, after `--`.
 */
function buildPathspec(keepChangelog) {
  return keepChangelog ? [".", `:(exclude)${CHANGELOG_FILE}`] : ["."];
}

/**
 * Sets the uncommitted changes aside in a new stash entry.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {{ keepChangelog: boolean, createVersionCommand?: string }} options - Whether `CHANGELOG.md` stays in the
 *   working tree (a new release commits it), and how the project runs create-version (for the hints).
 * @returns {Promise<SetAsideChanges>} Stash entry holding the changes.
 * @throws {ReleaseStepError} When Git cannot create the stash entry; nothing was changed then.
 */
export async function setAsideLocalChanges(reader, { keepChangelog, createVersionCommand = DEFAULT_PROJECT_COMMANDS.createVersion }) {
  if ((await reader.tryGit(["stash", "push", "--include-untracked", "--message", LOCAL_CHANGES_STASH_MESSAGE, "--", ...buildPathspec(keepChangelog)])) === null) {
    throw new ReleaseStepError("No se pudieron apartar los cambios sin commitear (git stash push falló).", `No se tocó nada: revisá git status y volvé a correr ${createVersionCommand}.`);
  }

  const sha = await reader.tryGit(["rev-parse", "--verify", "--quiet", `${STASH_REFERENCE_PREFIX}{0}`]);

  if (!sha) {
    throw new ReleaseStepError("Se apartaron los cambios pero no se encontró la entrada de git stash.", `Buscalos con git stash list y recuperalos con git stash pop --index antes de volver a correr ${createVersionCommand}.`);
  }

  return { sha, keepChangelog };
}

/**
 * Writes the diff between two revisions of the set-aside paths to a patch file.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {string} from - Revision the patch starts from.
 * @param {string} to - Revision the patch leads to.
 * @param {string[]} pathspec - Paths included in the patch.
 * @param {string} patchPath - File the patch is written to.
 * @returns {Promise<boolean | null>} `true` with changes, `false` when empty, `null` when Git failed.
 */
async function writePatch(reader, from, to, pathspec, patchPath) {
  // `--output` keeps the exact bytes of the patch; `--no-ext-diff` and `--no-textconv` keep it appliable.
  if ((await reader.tryGit(["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-color", `--output=${patchPath}`, from, to, "--", ...pathspec])) === null) {
    return null;
  }

  return existsSync(patchPath) && statSync(patchPath).size > 0;
}

/**
 * Lists the untracked files the stash entry holds (its third parent), if any.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {string} sha - Stash commit.
 * @returns {Promise<string[] | null>} Paths relative to the root, or `null` when Git failed.
 */
async function listStashedUntrackedFiles(reader, sha) {
  if ((await reader.tryGit(["rev-parse", "--verify", "--quiet", `${sha}^3`])) === null) {
    return [];
  }

  const output = await reader.tryGit(["ls-tree", "-r", "-z", "--name-only", `${sha}^3`]);
  return output === null ? null : output.split("\0").filter(Boolean);
}

/**
 * Restores the changes set aside by {@link setAsideLocalChanges} exactly as they were: staged
 * changes staged, unstaged changes unstaged and untracked files untracked. Nothing is written
 * unless every layer applies cleanly; the stash entry is dropped only after a full restore.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {string} repositoryRoot - Repository root.
 * @param {SetAsideChanges} setAside - Stash entry returned by {@link setAsideLocalChanges}.
 * @returns {Promise<LocalChangesRestore>} Whether the changes are back, and why not otherwise.
 */
export async function restoreLocalChanges(reader, repositoryRoot, setAside) {
  const { sha, keepChangelog } = setAside;
  const stashShas = ((await reader.tryGit(["stash", "list", "--format=%H"])) ?? "").split("\n").map((line) => line.trim());
  const stashIndex = stashShas.indexOf(sha);

  if (stashIndex === -1) {
    return { restored: false, reason: `la entrada ${sha} ya no está en git stash list` };
  }

  const stashReference = `${STASH_REFERENCE_PREFIX}{${stashIndex}}`;
  const keptReason = (/** @type {string} */ detail) => ({ restored: /** @type {const} */ (false), reason: `${detail}; no se tocó nada y siguen en ${stashReference}` });
  const pathspec = buildPathspec(keepChangelog);
  const patchDirectory = mkdtempSync(path.join(os.tmpdir(), RESTORE_DIRECTORY_PREFIX));
  const stagedPatch = path.join(patchDirectory, "staged.patch");
  const workingTreePatch = path.join(patchDirectory, "working-tree.patch");

  try {
    // Staged layer: stash base -> stash index, applied to the index only. Working tree layer:
    // stash base -> stash tree (staged plus unstaged), applied to the working tree only.
    const hasStaged = await writePatch(reader, `${sha}^1`, `${sha}^2`, pathspec, stagedPatch);
    const hasWorkingTree = await writePatch(reader, `${sha}^1`, sha, pathspec, workingTreePatch);
    const untrackedFiles = await listStashedUntrackedFiles(reader, sha);

    if (hasStaged === null || hasWorkingTree === null || untrackedFiles === null) {
      return keptReason("Git no pudo leer la entrada de stash");
    }

    if (hasStaged && (await reader.tryGit(["apply", "--check", "--cached", stagedPatch])) === null) {
      return keptReason("los cambios staged chocan con lo que cambió el release en el índice");
    }

    if (hasWorkingTree && (await reader.tryGit(["apply", "--check", workingTreePatch])) === null) {
      return keptReason("los cambios del working tree chocan con lo que cambió el release");
    }

    const occupiedFile = untrackedFiles.find((file) => existsSync(path.join(repositoryRoot, file)));
    if (occupiedFile) {
      return keptReason(`el archivo sin trackear ${occupiedFile} ya existe después del release`);
    }

    if (hasStaged && (await reader.tryGit(["apply", "--cached", stagedPatch])) === null) {
      return keptReason("git apply --cached falló después de validar");
    }

    if (hasWorkingTree && (await reader.tryGit(["apply", workingTreePatch])) === null) {
      return { restored: false, reason: `los cambios staged volvieron pero git apply del working tree falló; el resto sigue en ${stashReference}` };
    }

    if (untrackedFiles.length > 0 && (await reader.tryGit(["restore", `--source=${sha}^3`, "--worktree", "--", ...untrackedFiles.map((file) => `:(literal)${file}`)])) === null) {
      return { restored: false, reason: `volvieron los cambios trackeados pero no los archivos sin trackear; siguen en ${stashReference}` };
    }

    await reader.tryGit(["stash", "drop", "--quiet", stashReference]);
    return { restored: true };
  } finally {
    rmSync(patchDirectory, { recursive: true, force: true });
  }
}
