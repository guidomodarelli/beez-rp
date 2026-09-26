/**
 * Reads and releases CHANGELOG.md in the Keep a Changelog format.
 *
 * Every change adds its entries under `## [Unreleased]`, grouped by change
 * type (`### Added`, `### Changed`, `### Deprecated`, `### Removed`,
 * `### Fixed`, `### Security`). Releasing moves that block under
 * `## [X.Y.Z] - YYYY-MM-DD` and leaves an empty `## [Unreleased]` on top.
 * Headings of older releases without brackets (`## 0.6.0 - 2026-09-23`)
 * remain valid.
 *
 * @module changelog
 */

import {
  CHANGE_TYPES,
  ENTRY_LINE_PATTERN,
  LEADING_WHITESPACE_PATTERN,
  LINE_BREAK_PATTERN,
  RELEASE_HEADING_PATTERN,
  SECTION_HEADING_PATTERN,
  UNRELEASED_HEADING,
  UNRELEASED_LINE_PATTERN,
} from "./constants/changelog.js";

/**
 * @typedef {{ label: string, heading: string, start: number, bodyStart: number, end: number }} ChangelogBlock
 * @typedef {{ exists: boolean, entryCount: number, unknownSections: string[], body: string }} UnreleasedState
 */

/**
 * Splits the changelog into release blocks in document order.
 *
 * @param {string} changelog - CHANGELOG.md contents.
 * @returns {ChangelogBlock[]} Blocks.
 */
function listBlocks(changelog) {
  const headings = [...changelog.matchAll(RELEASE_HEADING_PATTERN)];
  return headings.map((match, index) => {
    const start = match.index ?? 0;
    return {
      label: match[1],
      heading: match[0],
      start,
      bodyStart: start + match[0].length,
      end: headings[index + 1]?.index ?? changelog.length,
    };
  });
}

/**
 * Counts the change entries of a block body.
 *
 * @param {string} body - Block text below its heading.
 * @returns {number} Number of `- ` lines.
 */
function countEntries(body) {
  return body.split(LINE_BREAK_PATTERN).filter((line) => ENTRY_LINE_PATTERN.test(line)).length;
}

/**
 * Describes the `## [Unreleased]` block.
 *
 * @param {string} changelog - CHANGELOG.md contents.
 * @returns {UnreleasedState} Unreleased state.
 */
export function readUnreleased(changelog) {
  const block = listBlocks(changelog).find((candidate) => UNRELEASED_LINE_PATTERN.test(candidate.heading));
  if (!block) return { exists: false, entryCount: 0, unknownSections: [], body: "" };
  const body = changelog.slice(block.bodyStart, block.end);
  const unknownSections = [...body.matchAll(SECTION_HEADING_PATTERN)]
    .map((match) => match[1])
    .filter((name) => !CHANGE_TYPES.includes(name));
  return { exists: true, entryCount: countEntries(body), unknownSections, body: body.trim() };
}

/**
 * Returns the newest released block (the first one that is not `[Unreleased]`).
 *
 * @param {string} changelog - CHANGELOG.md contents.
 * @returns {{ version: string, entryCount: number } | null} Latest release entry.
 */
export function readLatestRelease(changelog) {
  const block = listBlocks(changelog).find((candidate) => !UNRELEASED_LINE_PATTERN.test(candidate.heading));
  return block ? { version: block.label, entryCount: countEntries(changelog.slice(block.bodyStart, block.end)) } : null;
}

/**
 * Moves the `[Unreleased]` changes under a new version heading and leaves an empty `[Unreleased]` block.
 *
 * @param {string} changelog - CHANGELOG.md contents.
 * @param {string} version - Version being released.
 * @param {string} releaseDate - Date in `YYYY-MM-DD` format.
 * @returns {string} Released changelog.
 * @throws {Error} When `[Unreleased]` is missing, empty or uses an unknown section.
 */
export function releaseUnreleased(changelog, version, releaseDate) {
  const unreleased = readUnreleased(changelog);
  if (!unreleased.exists) throw new Error(`create-version: CHANGELOG.md needs a "${UNRELEASED_HEADING}" block`);
  if (unreleased.unknownSections.length > 0) {
    throw new Error(
      `create-version: CHANGELOG.md [Unreleased] uses unknown sections (${unreleased.unknownSections.join(", ")}); use ${CHANGE_TYPES.join(", ")}`
    );
  }
  if (unreleased.entryCount === 0) throw new Error("create-version: CHANGELOG.md [Unreleased] has no changes to release");
  const block = listBlocks(changelog).find((candidate) => UNRELEASED_LINE_PATTERN.test(candidate.heading));
  if (!block) throw new Error(`create-version: CHANGELOG.md needs a "${UNRELEASED_HEADING}" block`);
  const released = `${UNRELEASED_HEADING}\n\n## [${version}] - ${releaseDate}\n\n${unreleased.body}\n\n`;
  return `${changelog.slice(0, block.start)}${released}${changelog.slice(block.end).replace(LEADING_WHITESPACE_PATTERN, "")}`;
}
