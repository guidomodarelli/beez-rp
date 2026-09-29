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

import { MARKED_VERSION_PATTERN, VERSION_BLOCK_END_MARKERS, VERSION_BLOCK_START_MARKERS, VERSION_LINE_MARKERS } from "./constants/version-files.js";

/**
 * @typedef {{ content: string, markedLines: number, replacements: number }} VersionFileUpdate
 *   `markedLines` counts the lines the markers selected; `replacements` the versions rewritten.
 */

/**
 * @param {string} line - Line of the file.
 * @param {readonly string[]} markers - Markers to look for.
 * @returns {boolean} Whether the line carries one of the markers.
 */
function hasMarker(line, markers) {
  return markers.some((marker) => line.includes(marker));
}

/**
 * Rewrites the versions of the marked lines of a file, keeping everything else (line endings
 * included) byte for byte.
 *
 * @param {string} content - File content.
 * @param {string} version - Version to write.
 * @returns {VersionFileUpdate} New content and what the markers selected.
 */
export function updateVersionMarkers(content, version) {
  let insideBlock = false;
  let markedLines = 0;
  let replacements = 0;

  const lines = content.split(/(?<=\n)/u).map((line) => {
    if (hasMarker(line, VERSION_BLOCK_START_MARKERS)) {
      insideBlock = true;
      return line;
    }
    if (hasMarker(line, VERSION_BLOCK_END_MARKERS)) {
      insideBlock = false;
      return line;
    }
    if (!insideBlock && !hasMarker(line, VERSION_LINE_MARKERS)) {
      return line;
    }
    markedLines += 1;
    return line.replace(MARKED_VERSION_PATTERN, () => {
      replacements += 1;
      return version;
    });
  });

  return { content: lines.join(""), markedLines, replacements };
}
