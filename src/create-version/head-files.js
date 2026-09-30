/**
 * Comparison of working-tree files with `HEAD`, the commit a release is built on, without going
 * through `git status`: the release loads the configuration and its modules, and uses the files it
 * versions or publishes, from the working tree, so a file that Git does not report (ignored,
 * untracked, or tracked but marked `skip-worktree` or `assume-unchanged`) must still match the
 * committed one.
 *
 * @module create-version/head-files
 */

import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";

import {
  GIT_EXECUTABLE_FILE_MODE,
  GIT_FILE_MODE_SETTING,
  GIT_METADATA_ENTRY_NAME,
  GIT_REGULAR_FILE_MODES,
  GIT_SUBMODULE_MODE,
  GIT_SYMBOLIC_LINK_MODE,
  HEAD_FILE_DIFFERENCE,
  LS_TREE_ENTRY_PATH_SEPARATOR,
  OWNER_EXECUTE_PERMISSION_BIT,
  UNFILTERED_FILE_PATHSPECS,
} from "../constants/create-version.js";
import { GIT_LITERAL_PATHSPEC_PREFIX } from "../constants/version-files.js";
import { listUncheckedIndexPaths } from "./git-status.js";
import { createGitReader, readGitBlob } from "./process.js";

/**
 * @typedef {import("./process.js").GitReader} GitReader
 * @typedef {"notCommitted" | "typeChanged" | "contentChanged" | "executableBitChanged" | "outsideRepository" | "filtered" | "implicitPath" | "missingFromWorkingTree"} HeadFileDifferenceKind
 * @typedef {{ file: string, difference: HeadFileDifferenceKind }} HeadFileDifference
 *   `file` is relative to the repository root and separated with `/`, or absolute for
 *   `outsideRepository`.
 * @typedef {{ mode: string, object: string }} HeadEntry
 */

/**
 * Reads the `HEAD` entries of the given files.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {string[]} files - Repository-relative paths.
 * @returns {Promise<Map<string, HeadEntry>>} Entry of each file `HEAD` has (a directory too, so a
 *   directory replaced by a symbolic link is another kind of file); empty without `HEAD`.
 */
async function readHeadEntries(reader, files) {
  const listing = await reader.tryGit(["ls-tree", "-r", "-t", "-z", "HEAD", "--", ...files.map((file) => `${GIT_LITERAL_PATHSPEC_PREFIX}${file}`)]);
  // An entry is `<mode> <type> <object>\t<path>`.
  return new Map(
    (listing ?? "")
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf(LS_TREE_ENTRY_PATH_SEPARATOR);
        const [mode, , object] = entry.slice(0, separatorIndex).split(" ");
        return [entry.slice(separatorIndex + 1), { mode, object }];
      })
  );
}

/**
 * Tells whether a working-tree symbolic link points where the committed one does, comparing both
 * targets byte for byte (a target may end in whitespace).
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} absolutePath - Link in the working tree.
 * @param {string} object - Blob of the committed link, which holds its target.
 * @returns {Promise<boolean>} `true` when both targets are the same.
 */
async function hasCommittedLinkTarget(repositoryRoot, absolutePath, object) {
  const committedTarget = await readGitBlob(repositoryRoot, object);
  return committedTarget !== null && committedTarget.equals(readlinkSync(absolutePath, { encoding: "buffer" }));
}

/**
 * Tells whether Git keeps the executable bit of working-tree files (`core.fileMode`, `true` unless
 * the repository sets it to `false`, as Git does where the file system cannot keep it).
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @returns {Promise<boolean>} Whether the executable bit is part of the comparison with `HEAD`.
 */
async function tracksExecutableBit(reader) {
  return (await reader.tryGit(["config", "--bool", GIT_FILE_MODE_SETTING]))?.trim() !== "false";
}

/**
 * Tells whether a working-tree submodule directory matches its committed gitlink: an initialized
 * submodule must have the recorded commit checked out with a clean working tree of its own (no
 * modified, staged or untracked files, as `git status --porcelain` of the submodule reports), and
 * one never initialized is an empty directory, as Git leaves it. Git reads the submodule itself
 * only when its root has a `.git` entry; otherwise `git -C` would answer for the superproject.
 *
 * @param {string} absolutePath - Submodule directory in the working tree.
 * @param {string} object - Commit the gitlink records.
 * @returns {Promise<boolean>} `true` when the submodule is the committed one, clean, or was never initialized.
 */
async function hasCommittedSubmoduleCommit(absolutePath, object) {
  const entries = readdirSync(absolutePath);

  if (!entries.includes(GIT_METADATA_ENTRY_NAME)) {
    return entries.length === 0;
  }

  const submoduleReader = createGitReader(absolutePath);
  const checkedOutCommit = await submoduleReader.tryGit(["rev-parse", "--verify", "HEAD"]);

  if (checkedOutCommit?.trim() !== object) {
    return false;
  }

  // At the recorded commit, its own working tree must be clean too: checks and publication use it.
  return (await submoduleReader.tryGit(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]))?.trim() === "";
}

/**
 * Lists the given working-tree files that differ from `HEAD`: missing from `HEAD`, of another kind
 * (a symbolic link or a directory where `HEAD` has a regular file), with other content or, where
 * Git keeps the executable bit (`core.fileMode`), executable where `HEAD` has a plain file or the
 * other way around. A submodule (gitlink) differs when its checkout is at another commit, or when
 * it was never initialized but its directory is not empty. Git hashes
 * each regular file through its clean filters (line endings, `.gitattributes`), like `git add`, so
 * a checkout with converted line endings is not a change. Index flags (`skip-worktree`,
 * `assume-unchanged`) are ignored: only the working tree and `HEAD` are compared.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {string} repositoryRoot - Repository root.
 * @param {string[]} files - Repository-relative paths, separated with `/`, that exist in the working tree.
 * @returns {Promise<HeadFileDifference[]>} Differences, in the order of `files`.
 */
export async function listFilesDifferentFromHead(reader, repositoryRoot, files) {
  if (files.length === 0) {
    return [];
  }

  const headEntries = await readHeadEntries(reader, files);
  /** @type {Map<string, HeadFileDifferenceKind>} */
  const differenceByFile = new Map();
  /** @type {{ file: string, object: string }[]} */
  const regularFiles = [];
  const comparesExecutableBit = await tracksExecutableBit(reader);

  for (const file of files) {
    const headEntry = headEntries.get(file);
    const absolutePath = path.join(repositoryRoot, file);
    const stats = lstatSync(absolutePath, { throwIfNoEntry: false });

    if (!headEntry) {
      differenceByFile.set(file, HEAD_FILE_DIFFERENCE.notCommitted);
    } else if (GIT_REGULAR_FILE_MODES.includes(headEntry.mode) && stats?.isFile()) {
      // Git records a file as executable only from its owner execute bit.
      const isExecutable = (stats.mode & OWNER_EXECUTE_PERMISSION_BIT) !== 0;
      if (comparesExecutableBit && isExecutable !== (headEntry.mode === GIT_EXECUTABLE_FILE_MODE)) {
        differenceByFile.set(file, HEAD_FILE_DIFFERENCE.executableBitChanged);
      }
      regularFiles.push({ file, object: headEntry.object });
    } else if (headEntry.mode === GIT_SYMBOLIC_LINK_MODE && stats?.isSymbolicLink()) {
      if (!(await hasCommittedLinkTarget(repositoryRoot, absolutePath, headEntry.object))) {
        differenceByFile.set(file, HEAD_FILE_DIFFERENCE.contentChanged);
      }
    } else if (headEntry.mode === GIT_SUBMODULE_MODE && stats?.isDirectory()) {
      if (!(await hasCommittedSubmoduleCommit(absolutePath, headEntry.object))) {
        differenceByFile.set(file, HEAD_FILE_DIFFERENCE.contentChanged);
      }
    } else {
      differenceByFile.set(file, HEAD_FILE_DIFFERENCE.typeChanged);
    }
  }

  if (regularFiles.length > 0) {
    const workingObjects = (await reader.git(["hash-object", "--", ...regularFiles.map(({ file }) => file)])).split("\n");
    regularFiles.forEach(({ file, object }, index) => {
      if (workingObjects[index] !== object) {
        differenceByFile.set(file, HEAD_FILE_DIFFERENCE.contentChanged);
      }
    });
  }

  return files.filter((file) => differenceByFile.has(file)).map((file) => ({ file, difference: /** @type {HeadFileDifferenceKind} */ (differenceByFile.get(file)) }));
}

/**
 * Lists the tracked paths whose working-tree content differs from `HEAD` (`git diff HEAD`, staged
 * or not). Git skips the entries marked `skip-worktree` or `assume-unchanged`, and compares the
 * filtered ones through their clean filter.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @returns {Promise<string[]>} Repository-relative paths separated with `/`.
 */
export async function listPathsDifferentFromHead(reader) {
  return (await reader.git(["diff", "--name-only", "-z", "HEAD"])).split("\0").filter(Boolean);
}

/**
 * Lists the tracked files whose working-tree bytes are exactly the committed ones, as far as Git
 * can prove it: identical to `HEAD` (`git diff HEAD`), without a `filter` attribute (whose clean
 * filter can map a local edit back to the committed blob) and without the `skip-worktree` or
 * `assume-unchanged` flag (whose changes `git diff` does not see). These are the only repository
 * modules a release step may load for the first time.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @returns {Promise<string[]>} Repository-relative paths separated with `/`.
 */
export async function listCleanTrackedPaths(reader) {
  const unfilteredPaths = (await reader.git(["ls-files", "-z", "--", ...UNFILTERED_FILE_PATHSPECS])).split("\0").filter(Boolean);
  const uncleanPaths = new Set([...(await listPathsDifferentFromHead(reader)), ...(await listUncheckedIndexPaths(reader))]);
  return unfilteredPaths.filter((filePath) => !uncleanPaths.has(filePath));
}

/**
 * Finds the first symbolic link (or Windows junction) along a working-tree path: Git would only
 * track the link, while reading or writing through it reaches its target (maybe outside the
 * repository).
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} filePath - Path relative to the root.
 * @returns {string | null} The linked part of the path, or `null` when no segment is a link.
 */
export function findSymbolicLinkSegment(repositoryRoot, filePath) {
  const segments = path.normalize(filePath).split(path.sep).filter((segment) => segment !== "" && segment !== ".");
  let currentPath = repositoryRoot;

  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatSync(currentPath, { throwIfNoEntry: false });

    if (!stats) {
      return null;
    }
    if (stats.isSymbolicLink()) {
      return segments.slice(0, index + 1).join("/");
    }
  }

  return null;
}
