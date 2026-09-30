/**
 * `versionFiles`: files besides `package.json` that carry the version (a CLI
 * `--version`, a user agent, a constant) and are rewritten in the release
 * commit. Only marked lines change:
 *
 * - a line with `beez-rp-version` (or release-please's `x-release-please-version`);
 * - every line between `beez-rp-start-version` and `beez-rp-end` (or
 *   `x-release-please-start-version` / `x-release-please-end`).
 *
 * @module version-files
 */

import {
  LINE_TERMINATOR_BOUNDARY_PATTERN,
  MARKED_VERSION_PATTERN,
  VERSION_BLOCK_END_MARKERS,
  VERSION_BLOCK_PROBLEM,
  VERSION_BLOCK_START_MARKERS,
  VERSION_LINE_MARKERS,
} from "./constants/version-files.js";

/**
 * @typedef {{ content: string, markedLines: number, replacements: number }} VersionFileUpdate
 *   `markedLines` counts the lines the markers selected; `replacements` the versions rewritten.
 */

/**
 * @typedef {"unterminated" | "unopened" | "nested" | "mismatched"} VersionBlockProblem
 *   How the block markers are paired wrongly; see `VERSION_BLOCK_PROBLEM`.
 */

/**
 * Version block markers paired wrongly: nothing is rewritten, since guessing where the block ends
 * could change versions outside the intended section.
 */
export class VersionBlockError extends Error {
  /**
   * @param {{ problem: VersionBlockProblem, lineNumber: number, marker: string, openingLineNumber?: number, openingMarker?: string }} details
   *   `lineNumber` (1-based) and `marker` locate the offending marker; `openingLineNumber` and
   *   `openingMarker` the start marker of the block still open, when there is one.
   */
  constructor({ problem, lineNumber, marker, openingLineNumber, openingMarker }) {
    super(`beez-rp:updateVersionMarkers ${problem} version block: ${marker} at line ${lineNumber}`);
    this.name = "VersionBlockError";
    this.problem = problem;
    this.lineNumber = lineNumber;
    this.marker = marker;
    this.openingLineNumber = openingLineNumber;
    this.openingMarker = openingMarker;
  }
}

/**
 * @param {string} line - Line of the file.
 * @param {readonly string[]} markers - Markers to look for.
 * @returns {number} Index of the first marker the line carries, or `-1` when it carries none.
 */
function findMarkerIndex(line, markers) {
  return markers.findIndex((marker) => line.includes(marker));
}

/**
 * Rewrites the versions of the marked lines of a file, keeping everything else (line endings
 * included) byte for byte. `\n`, `\r\n` and a lone `\r` all end a line.
 *
 * @param {string} content - File content.
 * @param {string} version - Version to write.
 * @returns {VersionFileUpdate} New content and what the markers selected.
 * @throws {VersionBlockError} When a block is left open, closed without being opened, opened
 *   inside another block or closed with the end marker of the other tool.
 */
export function updateVersionMarkers(content, version) {
  /** @type {{ markerIndex: number, lineNumber: number } | null} */
  let openBlock = null;
  let markedLines = 0;
  let replacements = 0;

  /** @type {string[]} */
  const lines = [];

  for (const [index, line] of content.split(LINE_TERMINATOR_BOUNDARY_PATTERN).entries()) {
    const lineNumber = index + 1;
    const startMarkerIndex = findMarkerIndex(line, VERSION_BLOCK_START_MARKERS);
    const endMarkerIndex = findMarkerIndex(line, VERSION_BLOCK_END_MARKERS);

    if (startMarkerIndex !== -1) {
      if (openBlock !== null) {
        throw new VersionBlockError({
          problem: VERSION_BLOCK_PROBLEM.nested,
          lineNumber,
          marker: VERSION_BLOCK_START_MARKERS[startMarkerIndex],
          openingLineNumber: openBlock.lineNumber,
          openingMarker: VERSION_BLOCK_START_MARKERS[openBlock.markerIndex],
        });
      }
      openBlock = { markerIndex: startMarkerIndex, lineNumber };
      lines.push(line);
      continue;
    }
    if (endMarkerIndex !== -1) {
      if (openBlock === null) {
        throw new VersionBlockError({ problem: VERSION_BLOCK_PROBLEM.unopened, lineNumber, marker: VERSION_BLOCK_END_MARKERS[endMarkerIndex] });
      }
      if (endMarkerIndex !== openBlock.markerIndex) {
        throw new VersionBlockError({
          problem: VERSION_BLOCK_PROBLEM.mismatched,
          lineNumber,
          marker: VERSION_BLOCK_END_MARKERS[endMarkerIndex],
          openingLineNumber: openBlock.lineNumber,
          openingMarker: VERSION_BLOCK_START_MARKERS[openBlock.markerIndex],
        });
      }
      openBlock = null;
      lines.push(line);
      continue;
    }
    if (openBlock === null && findMarkerIndex(line, VERSION_LINE_MARKERS) === -1) {
      lines.push(line);
      continue;
    }
    markedLines += 1;
    lines.push(
      line.replace(MARKED_VERSION_PATTERN, () => {
        replacements += 1;
        return version;
      })
    );
  }

  if (openBlock !== null) {
    const openingMarker = VERSION_BLOCK_START_MARKERS[openBlock.markerIndex];
    throw new VersionBlockError({
      problem: VERSION_BLOCK_PROBLEM.unterminated,
      lineNumber: openBlock.lineNumber,
      marker: openingMarker,
      openingLineNumber: openBlock.lineNumber,
      openingMarker,
    });
  }

  return { content: lines.join(""), markedLines, replacements };
}
