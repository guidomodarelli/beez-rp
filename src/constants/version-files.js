/**
 * Markers of `versionFiles`: lines and blocks whose version `create-version`
 * rewrites in the release commit, besides `package.json`.
 *
 * @module constants/version-files
 */

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
 * A semantic version inside a marked line (`1.2.3`, `1.2.3-beta.1`, `1.2.3+build`), not glued to
 * other version-like digits. Global: every version of a marked line is rewritten.
 */
export const MARKED_VERSION_PATTERN = /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\d.])/gu;
