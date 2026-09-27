/**
 * Locates and verifies the package archive prepared for a release, so
 * `publish: "npm"` publishes exactly the artifact the project verified
 * instead of repacking the working tree.
 *
 * Patterns are relative to the repository root, use `/` separators and
 * replace `{version}` and `{name}`. Inside a single path segment, `*` matches
 * anything and `{sha256}` matches a SHA-256 digest that must equal the
 * archive checksum (for example `releases/{version}-{sha256}/{name}-{version}.tgz`).
 *
 * Before publishing, the archive is read without external tools: every entry
 * must stay under `package/`, private paths (dotfiles, `node_modules`) are
 * rejected, files outside the manifest `files` are rejected, every public
 * entrypoint must be present and the packed name and version must match.
 *
 * @module create-version/artifact
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  ALWAYS_PACKED_FILE_PATTERN,
  ARTIFACT_NAME_PLACEHOLDER,
  ARTIFACT_SEGMENT_WILDCARD,
  ARTIFACT_SHA256_PLACEHOLDER,
  ARTIFACT_VERSION_PLACEHOLDER,
  PACKAGE_MANIFEST_FILE,
  PACKED_ROOT_DIRECTORY,
  PAX_PATH_KEY,
  PRIVATE_PACKED_SEGMENT_PATTERN,
  SAFE_ARTIFACT_PATH_PATTERN,
  SHA256_HEX_PATTERN_SOURCE,
  TAR_BLOCK_SIZE,
  TAR_ENTRY_TYPE,
  TAR_HEADER_FIELD,
  TRAILING_NUL_PATTERN,
} from "../constants/create-version.js";

/**
 * @typedef {{ path: string, expectedSha256: string | null }} PreparedArtifact
 * @typedef {{ name: string, content: Buffer }} ArchiveEntry
 * @typedef {{ name?: unknown, version?: unknown, files?: unknown, exports?: unknown, main?: unknown, types?: unknown, typings?: unknown, bin?: unknown }} PackageManifest
 */

/** Characters with regular-expression meaning, escaped in literal segment text. */
const REGEXP_SPECIAL_CHARACTERS_PATTERN = /[.+?^${}()|[\]\\]/gu;

/** Leading `./` of manifest paths. */
const RELATIVE_PREFIX_PATTERN = /^\.\//u;

/** Trailing `/` of directory entries and `files` patterns. */
const TRAILING_SLASH_PATTERN = /\/+$/u;

/**
 * Replaces the `{version}` and `{name}` placeholders of an artifact pattern; `{sha256}` stays.
 *
 * @param {string} pattern - Configured pattern.
 * @param {{ version: string, packageName: string }} release - Version and npm package name.
 * @returns {string} Pattern with placeholders replaced.
 */
export function expandArtifactPattern(pattern, { version, packageName }) {
  return pattern.replaceAll(ARTIFACT_VERSION_PLACEHOLDER, version).replaceAll(ARTIFACT_NAME_PLACEHOLDER, packageName);
}

/**
 * Compiles one path segment: `*` matches anything but `/`, `{sha256}` captures a digest.
 *
 * @param {string} segment - Segment of an expanded pattern.
 * @returns {RegExp} Anchored expression; the digest, when present, is the `sha256` group.
 */
function compileSegment(segment) {
  const source = segment
    .split(ARTIFACT_SHA256_PLACEHOLDER)
    .map((part) =>
      part
        .split(ARTIFACT_SEGMENT_WILDCARD)
        .map((literal) => literal.replace(REGEXP_SPECIAL_CHARACTERS_PATTERN, "\\$&"))
        .join("[^/]*")
    )
    .join(`(?<sha256>${SHA256_HEX_PATTERN_SOURCE})`);
  return new RegExp(`^${source}$`, "u");
}

/**
 * Finds the newest file that matches an artifact pattern.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} pattern - Configured pattern with `{version}` and optional `{name}`, `*` and `{sha256}`.
 * @param {{ version: string, packageName: string }} release - Version and npm package name.
 * @returns {PreparedArtifact | null} Path relative to the root with `/` separators and the digest its path declares, or `null`.
 */
export function findPreparedArtifact(repositoryRoot, pattern, release) {
  const segments = expandArtifactPattern(pattern, release).split("/").filter(Boolean);
  /** @type {PreparedArtifact[]} */
  let candidates = [{ path: "", expectedSha256: null }];

  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    const matcher = compileSegment(segment);
    /** @type {PreparedArtifact[]} */
    const next = [];

    for (const candidate of candidates) {
      const absoluteDirectory = path.join(repositoryRoot, candidate.path);
      if (!existsSync(absoluteDirectory) || !statSync(absoluteDirectory).isDirectory()) continue;

      for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
        const match = matcher.exec(entry.name);
        if (match && (isLast ? entry.isFile() : entry.isDirectory())) {
          next.push({
            path: candidate.path ? `${candidate.path}/${entry.name}` : entry.name,
            expectedSha256: match.groups?.sha256 ?? candidate.expectedSha256,
          });
        }
      }
    }

    candidates = next;
  }

  const newest = candidates
    .map((candidate) => ({ candidate, modifiedAt: statSync(path.join(repositoryRoot, candidate.path)).mtimeMs }))
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

/**
 * Computes the SHA-256 of a file.
 *
 * @param {string} filePath - Absolute path.
 * @returns {string} Lowercase hexadecimal digest.
 */
export function computeSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Reads a NUL-terminated ASCII field of a tar header.
 *
 * @param {Buffer} header - 512-byte header.
 * @param {readonly number[]} range - Start and end offsets.
 * @returns {string} Field text.
 */
function readHeaderField(header, [start, end]) {
  const field = header.subarray(start, end);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString("utf8");
}

/**
 * Extracts the `path` record of a PAX extended header.
 *
 * @param {Buffer} content - PAX header data (`<length> <key>=<value>\n` records).
 * @returns {string | null} Long entry path, when declared.
 */
function readPaxPath(content) {
  for (const record of content.toString("utf8").split("\n")) {
    const separator = record.indexOf(" ");
    const [key, ...value] = record.slice(separator + 1).split("=");
    if (key === PAX_PATH_KEY) return value.join("=");
  }
  return null;
}

/**
 * Lists the regular files of a `.tgz` archive with their contents, without external tools.
 *
 * @param {Buffer} archive - Gzipped tar archive.
 * @returns {ArchiveEntry[]} Files in archive order.
 * @throws {Error} When the archive is not a readable gzip tar.
 */
export function readTarballEntries(archive) {
  const tar = gunzipSync(archive);
  /** @type {ArchiveEntry[]} */
  const entries = [];
  /** @type {string | null} */
  let pendingLongName = null;

  for (let offset = 0; offset + TAR_BLOCK_SIZE <= tar.length; ) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const size = Number.parseInt(readHeaderField(header, TAR_HEADER_FIELD.size).trim() || "0", 8);
    const type = readHeaderField(header, TAR_HEADER_FIELD.type) || TAR_ENTRY_TYPE.legacyFile;
    const content = tar.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE + size);
    const prefix = readHeaderField(header, TAR_HEADER_FIELD.prefix);
    const shortName = readHeaderField(header, TAR_HEADER_FIELD.name);

    if (type === TAR_ENTRY_TYPE.paxHeader) {
      pendingLongName = readPaxPath(content);
    } else if (type === TAR_ENTRY_TYPE.gnuLongName) {
      pendingLongName = content.toString("utf8").replace(TRAILING_NUL_PATTERN, "");
    } else {
      if (type === TAR_ENTRY_TYPE.file || type === TAR_ENTRY_TYPE.legacyFile) {
        entries.push({ name: pendingLongName ?? (prefix ? `${prefix}/${shortName}` : shortName), content: Buffer.from(content) });
      }
      pendingLongName = null;
    }

    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return entries;
}

/**
 * Collects the relative file paths a manifest declares as public entrypoints.
 *
 * @param {unknown} value - `exports`, `main`, `types` or `bin` value.
 * @returns {string[]} Paths without `./`; wildcard targets are skipped.
 */
function collectEntrypoints(value) {
  if (typeof value === "string") {
    return value.includes(ARTIFACT_SEGMENT_WILDCARD) ? [] : [value.replace(RELATIVE_PREFIX_PATTERN, "")];
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(collectEntrypoints) : [];
}

/**
 * Tells whether a packed path is covered by the manifest `files` list.
 *
 * @param {string} packedPath - Path relative to `package/`.
 * @param {string[]} files - Manifest `files` entries.
 * @returns {boolean} Whether npm is allowed to pack it.
 */
function isDeclaredFile(packedPath, files) {
  if (!packedPath.includes("/") && ALWAYS_PACKED_FILE_PATTERN.test(packedPath)) return true;
  return files.some((file) => {
    const root = file.replace(RELATIVE_PREFIX_PATTERN, "").replace(TRAILING_SLASH_PATTERN, "");
    return packedPath === root || packedPath.startsWith(`${root}/`);
  });
}

/**
 * Verifies a prepared archive against the manifest it must publish.
 *
 * @param {ArchiveEntry[]} entries - Archive files from {@link readTarballEntries}.
 * @param {PackageManifest} manifest - Repository `package.json`.
 * @returns {string[]} Problems in Spanish; empty when the archive is publishable.
 */
export function findArchiveProblems(entries, manifest) {
  /** @type {string[]} */
  const problems = [];
  const packedPaths = new Set();
  const files = Array.isArray(manifest.files) ? manifest.files.filter((file) => typeof file === "string") : null;

  for (const { name } of entries) {
    if (!name.startsWith(PACKED_ROOT_DIRECTORY) || name.includes("\\") || name.split("/").includes("..")) {
      problems.push(`ruta inválida en el tarball: ${name}`);
      continue;
    }

    const packedPath = name.slice(PACKED_ROOT_DIRECTORY.length);
    packedPaths.add(packedPath);

    if (packedPath.split("/").some((segment) => PRIVATE_PACKED_SEGMENT_PATTERN.test(segment))) {
      problems.push(`archivo privado en el tarball: ${packedPath}`);
    } else if (files && !isDeclaredFile(packedPath, files)) {
      problems.push(`archivo fuera de "files" en el tarball: ${packedPath}`);
    }
  }

  const packedManifestEntry = entries.find((entry) => entry.name === `${PACKED_ROOT_DIRECTORY}${PACKAGE_MANIFEST_FILE}`);
  if (!packedManifestEntry) {
    problems.push(`falta ${PACKAGE_MANIFEST_FILE} en el tarball`);
  } else {
    try {
      const packed = JSON.parse(packedManifestEntry.content.toString("utf8"));
      if (packed.name !== manifest.name || packed.version !== manifest.version) {
        problems.push(`el tarball es ${packed.name}@${packed.version} y el repositorio ${manifest.name}@${manifest.version}`);
      }
    } catch (error) {
      problems.push(`${PACKAGE_MANIFEST_FILE} del tarball no es JSON válido (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const entrypoints = [manifest.exports, manifest.main, manifest.types, manifest.typings, manifest.bin].flatMap(collectEntrypoints);
  for (const entrypoint of new Set(entrypoints)) {
    if (!packedPaths.has(entrypoint)) problems.push(`falta el entrypoint público ${entrypoint} en el tarball`);
  }

  return problems;
}

/**
 * Verifies the checksum and contents of a prepared archive before publishing it.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {PreparedArtifact} artifact - Archive found by {@link findPreparedArtifact}.
 * @param {PackageManifest} manifest - Repository `package.json`.
 * @returns {string[]} Problems in Spanish; empty when the archive can be published.
 */
export function verifyPreparedArtifact(repositoryRoot, artifact, manifest) {
  const archivePath = path.join(repositoryRoot, artifact.path);

  if (artifact.expectedSha256) {
    const actualSha256 = computeSha256(archivePath);
    if (actualSha256 !== artifact.expectedSha256) {
      return [`el SHA-256 del tarball (${actualSha256}) no coincide con el de su ruta (${artifact.expectedSha256})`];
    }
  }

  let entries;
  try {
    entries = readTarballEntries(readFileSync(archivePath));
  } catch (error) {
    return [`no se pudo leer el tarball (${error instanceof Error ? error.message : String(error)})`];
  }

  return findArchiveProblems(entries, manifest);
}
