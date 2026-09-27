/**
 * Locates the package archive prepared for a release, so `publish: "npm"`
 * publishes exactly the artifact the project verified instead of repacking.
 *
 * Patterns are relative to the repository root, use `/` separators, replace
 * `{version}` and `{name}`, and accept `*` inside a single path segment
 * (for example `releases/{version}-*\/{name}-{version}.tgz`).
 *
 * @module create-version/artifact
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  ARTIFACT_NAME_PLACEHOLDER,
  ARTIFACT_SEGMENT_WILDCARD,
  ARTIFACT_VERSION_PLACEHOLDER,
  SAFE_ARTIFACT_PATH_PATTERN,
} from "../constants/create-version.js";

/** Characters with regular-expression meaning, escaped in literal segment text. */
const REGEXP_SPECIAL_CHARACTERS_PATTERN = /[.+?^${}()|[\]\\]/gu;

/**
 * Replaces the release placeholders of an artifact pattern.
 *
 * @param {string} pattern - Configured pattern.
 * @param {{ version: string, packageName: string }} release - Version and npm package name.
 * @returns {string} Pattern with placeholders replaced.
 */
export function expandArtifactPattern(pattern, { version, packageName }) {
  return pattern.replaceAll(ARTIFACT_VERSION_PLACEHOLDER, version).replaceAll(ARTIFACT_NAME_PLACEHOLDER, packageName);
}

/**
 * Compiles one path segment, where `*` matches any characters except `/`.
 *
 * @param {string} segment - Segment of an expanded pattern.
 * @returns {RegExp} Anchored expression.
 */
function compileSegment(segment) {
  const source = segment
    .split(ARTIFACT_SEGMENT_WILDCARD)
    .map((literal) => literal.replace(REGEXP_SPECIAL_CHARACTERS_PATTERN, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`, "u");
}

/**
 * Finds the newest file that matches an artifact pattern.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} pattern - Configured pattern with `{version}` and optional `{name}`.
 * @param {{ version: string, packageName: string }} release - Version and npm package name.
 * @returns {string | null} Path relative to the root with `/` separators, or `null` when nothing matches.
 */
export function findPreparedArtifact(repositoryRoot, pattern, release) {
  const segments = expandArtifactPattern(pattern, release).split("/").filter(Boolean);
  /** @type {string[]} */
  let candidates = [""];

  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    const matcher = compileSegment(segment);
    /** @type {string[]} */
    const next = [];

    for (const directory of candidates) {
      const absoluteDirectory = path.join(repositoryRoot, directory);
      if (!existsSync(absoluteDirectory) || !statSync(absoluteDirectory).isDirectory()) continue;

      for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
        if (matcher.test(entry.name) && (isLast ? entry.isFile() : entry.isDirectory())) {
          next.push(directory ? `${directory}/${entry.name}` : entry.name);
        }
      }
    }

    candidates = next;
  }

  const newest = candidates
    .map((candidate) => ({ candidate, modifiedAt: statSync(path.join(repositoryRoot, candidate)).mtimeMs }))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];

  return newest?.candidate ?? null;
}

/**
 * Checks that an artifact path can be passed to `npm publish` on a shell command line.
 *
 * @param {string} artifactPath - Relative path found by {@link findPreparedArtifact}.
 * @returns {boolean} Whether the path only uses safe characters.
 */
export function isSafeArtifactPath(artifactPath) {
  return SAFE_ARTIFACT_PATH_PATTERN.test(artifactPath) && !artifactPath.split("/").includes("..");
}
