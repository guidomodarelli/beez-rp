/**
 * Markers of `versionFiles`: lines and blocks whose version `create-version`
 * rewrites in the release commit, besides `package.json`.
 *
 * @module constants/version-files
 */

import { PACKAGE_MANIFEST_FILE } from "./build-gate.js";
import { CHANGELOG_FILE } from "./changelog.js";

/**
 * Comment marking a single line whose version is rewritten. The release-please marker is also
 * accepted, so a project moving from release-please keeps its files untouched.
 */
export const VERSION_LINE_MARKERS = Object.freeze(["beez-rp-version", "x-release-please-version"]);

/** Comments opening a block whose every version is rewritten, paired by index with {@link VERSION_BLOCK_END_MARKERS}. */
export const VERSION_BLOCK_START_MARKERS = Object.freeze(["beez-rp-start-version", "x-release-please-start-version"]);

/** Comments closing a version block, paired by index with {@link VERSION_BLOCK_START_MARKERS}. */
export const VERSION_BLOCK_END_MARKERS = Object.freeze(["beez-rp-end", "x-release-please-end"]);

/**
 * Ways a file can pair its version block markers wrongly. Any of them stops the rewrite, since
 * guessing where a block ends could rewrite versions outside the intended section.
 *
 * - `unterminated`: a start marker without its end marker before the end of the file.
 * - `unopened`: an end marker outside any block.
 * - `nested`: a start marker inside a block that is still open.
 * - `mismatched`: an end marker of the other tool (`x-release-please-end` closing `beez-rp-start-version`, or the reverse).
 */
export const VERSION_BLOCK_PROBLEM = Object.freeze({
  unterminated: "unterminated",
  unopened: "unopened",
  nested: "nested",
  mismatched: "mismatched",
});

/**
 * A semantic version inside a marked line (`1.2.3`, `1.2.3-beta.1`, `1.2.3+build`), not glued to
 * other version-like digits. Global: every version of a marked line is rewritten.
 */
export const MARKED_VERSION_PATTERN = /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\d.])/gu;

/**
 * Files the release commit already writes on its own (the bumped `package.json` and the released
 * CHANGELOG): `versionFiles` cannot list them, since rewriting them from a snapshot taken before
 * the bump would undo it.
 */
export const RELEASE_COMMIT_BUILT_IN_FILES = Object.freeze([PACKAGE_MANIFEST_FILE, CHANGELOG_FILE]);

/**
 * Git pathspec magic that matches a configured path literally, so names starting with `:` or
 * holding `*`/`?` are never read as pathspec syntax.
 */
export const GIT_LITERAL_PATHSPEC_PREFIX = ":(literal)";
