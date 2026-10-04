/**
 * Reads files from the commit at HEAD: the content a CI worker checks out from the pushed release
 * commit, unlike the working tree, which may hold untracked, ignored or set-aside files.
 * @module create-version/committed-tree
 */

import { GIT_REGULAR_FILE_MODES } from "../constants/ci-release.js";
import { ReleaseStepError } from "./errors.js";
import { runCaptured } from "./process.js";

/**
 * Entry of the HEAD tree as listed by `git ls-tree`.
 * @typedef {object} CommittedTreeEntry
 * @property {string} mode - Git tree mode, such as `100644` or `120000`.
 * @property {string} type - Git object type, such as `blob` or `tree`.
 * @property {string} objectId - Object id of the entry.
 * @property {string} filePath - Path relative to the repository root.
 */

/** Hint shown when Git cannot list or read HEAD while preparing a CI release. */
const UNREADABLE_HEAD_HINT = "Revisá el repositorio Git antes de configurar CI; no se creó la versión ni el tag.";

/**
 * Lists which of the given root-relative paths HEAD contains.
 * @param {string} repositoryRoot - Project root.
 * @param {string[]} filePaths - Root-relative paths to look up.
 * @returns {Promise<CommittedTreeEntry[]>} Entries found at HEAD; absent paths are omitted.
 * @throws {ReleaseStepError} When `git ls-tree` fails, for example without a commit at HEAD.
 */
export async function listCommittedTreeEntries(repositoryRoot, filePaths) {
  const listed = await runCaptured("git", ["ls-tree", "-z", "HEAD", "--", ...filePaths], { cwd: repositoryRoot });
  if (listed.status !== 0) throw new ReleaseStepError(`No se pudo comprobar si HEAD contiene ${filePaths.join(" o ")} para el workflow de CI (git ls-tree terminó con status ${listed.status}).`, UNREADABLE_HEAD_HINT);
  return listed.stdout.split("\0").filter(Boolean).map((record) => {
    const separatorIndex = record.indexOf("\t");
    const [mode, type, objectId] = record.slice(0, separatorIndex).split(" ");
    return { mode, type, objectId, filePath: record.slice(separatorIndex + 1) };
  });
}

/**
 * Reads a file committed at HEAD only when it is a regular file, which the worker checks out as is;
 * a symlink, submodule or directory at that path counts as absent.
 * @param {string} repositoryRoot - Project root.
 * @param {string} filePath - Root-relative path.
 * @returns {Promise<string | null>} Committed content, or `null` when HEAD has no regular file there.
 * @throws {ReleaseStepError} When Git cannot list HEAD or read the committed object.
 */
export async function readCommittedRegularFile(repositoryRoot, filePath) {
  const [entry] = await listCommittedTreeEntries(repositoryRoot, [filePath]);
  if (!entry || entry.type !== "blob" || !GIT_REGULAR_FILE_MODES.includes(entry.mode)) return null;
  const shown = await runCaptured("git", ["cat-file", "blob", entry.objectId], { cwd: repositoryRoot });
  if (shown.status !== 0) throw new ReleaseStepError(`No se pudo leer ${filePath} desde HEAD para el workflow de CI (git cat-file terminó con status ${shown.status}).`, UNREADABLE_HEAD_HINT);
  return shown.stdout;
}
