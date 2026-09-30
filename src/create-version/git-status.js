/**
 * Reading of `git status --porcelain` (v1) lines of `beez-rp create-version`, and of the index
 * entries whose local changes `git status` does not report.
 *
 * A line is `XY <path>`, or `XY <source> -> <path>` for a renamed or copied
 * entry; Git quotes a path as a C string literal when it has special
 * characters (non-ASCII bytes, quotes) and, in a rename, also when it has
 * spaces, so the separator is never ambiguous once quoted paths are read whole.
 * With `core.quotePath=false`, non-ASCII characters inside a quoted path come
 * literally instead of as octal escapes, so they are read by code point.
 *
 * @module create-version/git-status
 */

/**
 * @typedef {import("./process.js").GitReader} GitReader
 */

import {
  GIT_QUOTED_PATH_DELIMITER,
  GIT_QUOTED_PATH_ESCAPE,
  GIT_QUOTED_PATH_ESCAPES,
  GIT_QUOTED_PATH_OCTAL_BYTE_PATTERN,
  LS_FILES_SKIP_WORKTREE_TAG,
  LS_FILES_TAG_WIDTH,
  OCTAL_RADIX,
  PORCELAIN_RENAME_SEPARATOR,
  PORCELAIN_SOURCE_PATH_STATUS_CODES,
  PORCELAIN_STATUS_WIDTH,
} from "../constants/create-version.js";

/**
 * Reads a path quoted by Git from the start of `text`.
 *
 * @param {string} text - Text that starts with {@link GIT_QUOTED_PATH_DELIMITER}.
 * @returns {{ path: string, rest: string }} Decoded path, and the text after its closing delimiter.
 */
function readQuotedPath(text) {
  /** @type {number[]} */
  const bytes = [];
  let index = 1;

  while (index < text.length && text[index] !== GIT_QUOTED_PATH_DELIMITER) {
    if (text[index] !== GIT_QUOTED_PATH_ESCAPE) {
      // A whole code point: with `core.quotePath=false` Git writes non-ASCII characters literally,
      // and a character outside the BMP (an emoji) spans two UTF-16 code units.
      const character = String.fromCodePoint(text.codePointAt(index) ?? 0);
      bytes.push(...Buffer.from(character, "utf8"));
      index += character.length;
      continue;
    }

    const escaped = text.slice(index + 1);
    const octalByte = GIT_QUOTED_PATH_OCTAL_BYTE_PATTERN.exec(escaped)?.[0];

    if (octalByte) {
      bytes.push(Number.parseInt(octalByte, OCTAL_RADIX));
      index += 1 + octalByte.length;
      continue;
    }

    const escapedCharacter = escaped.charAt(0);
    bytes.push(...Buffer.from(GIT_QUOTED_PATH_ESCAPES[escapedCharacter] ?? escapedCharacter, "utf8"));
    index += 2;
  }

  return { path: Buffer.from(bytes).toString("utf8"), rest: text.slice(index + 1) };
}

/**
 * Reads the path at the start of `text`, quoted or not.
 *
 * @param {string} text - Paths field, or what follows its first path.
 * @param {boolean} endsAtRenameSeparator - Whether an unquoted path ends at {@link PORCELAIN_RENAME_SEPARATOR}
 *   (the source path of a renamed or copied entry) instead of at the end of the line.
 * @returns {{ path: string, rest: string }} Decoded path, and the text after it.
 */
function readPath(text, endsAtRenameSeparator) {
  if (text.startsWith(GIT_QUOTED_PATH_DELIMITER)) {
    return readQuotedPath(text);
  }

  const separatorIndex = endsAtRenameSeparator ? text.indexOf(PORCELAIN_RENAME_SEPARATOR) : -1;
  const pathEnd = separatorIndex === -1 ? text.length : separatorIndex;
  return { path: text.slice(0, pathEnd), rest: text.slice(pathEnd) };
}

/**
 * Lists the paths a `git status --porcelain` line reports: its path, preceded by the source path
 * when the entry was renamed or copied.
 *
 * @param {string} line - Porcelain v1 line, such as `" M src/index.js"` or `"R  old.js -> new.js"`.
 * @returns {string[]} Decoded paths, relative to the repository root; the source path first.
 */
export function listPorcelainPaths(line) {
  const statusCodes = Array.from(line.slice(0, PORCELAIN_STATUS_WIDTH - 1));
  const reportsSourcePath = statusCodes.some((statusCode) => PORCELAIN_SOURCE_PATH_STATUS_CODES.includes(statusCode));
  const firstPath = readPath(line.slice(PORCELAIN_STATUS_WIDTH), reportsSourcePath);

  if (!reportsSourcePath) {
    return [firstPath.path];
  }

  return [firstPath.path, readPath(firstPath.rest.slice(PORCELAIN_RENAME_SEPARATOR.length), false).path];
}

/**
 * Tells whether a `git ls-files -v` tag marks an entry Git does not compare with the working
 * tree: `skip-worktree` (`S`) or `assume-unchanged` (any lowercase tag).
 *
 * @param {string} tag - Tag of the entry.
 * @returns {boolean} `true` when `git status` would not report a local change of the entry.
 */
function isUncheckedIndexTag(tag) {
  return tag === LS_FILES_SKIP_WORKTREE_TAG || tag !== tag.toUpperCase();
}

/**
 * Lists the tracked files whose index entry is marked `skip-worktree` or `assume-unchanged`
 * (`git update-index`): `git status` and `git stash` do not compare them with the working tree.
 *
 * @param {GitReader} reader - Git reader of the repository root.
 * @param {string[]} [pathspecs] - Pathspecs that limit the listing; every tracked file when empty.
 * @returns {Promise<string[]>} Repository-relative paths separated with `/`.
 */
export async function listUncheckedIndexPaths(reader, pathspecs = []) {
  const pathspecArguments = pathspecs.length > 0 ? ["--", ...pathspecs] : [];
  const taggedEntries = (await reader.git(["ls-files", "-v", "-z", ...pathspecArguments])).split("\0").filter(Boolean);
  return taggedEntries.filter((entry) => isUncheckedIndexTag(entry.charAt(0))).map((entry) => entry.slice(LS_FILES_TAG_WIDTH));
}
