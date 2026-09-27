/**
 * Locates and verifies the package archive prepared for a release, so
 * `publish: "npm"` publishes exactly the artifact the project verified
 * instead of repacking the working tree.
 *
 * Patterns are relative to the repository root, use `/` separators and
 * replace `{version}` and `{name}` (the tarball base name `npm pack` uses, so
 * `@scope/pkg` becomes `scope-pkg`). Inside a single path segment, `*` matches
 * anything and `{sha256}` matches a SHA-256 digest that must equal the
 * archive checksum (for example `releases/{version}-{sha256}/{name}-{version}.tgz`).
 * `{sha256}` may repeat, in one segment or several: every occurrence must
 * declare the same digest.
 *
 * Before publishing, the archive is read without external tools: every entry
 * must stay under `package/` and appear once, only regular files and directories
 * are accepted (links and other entry types are rejected), private paths
 * (dotfiles, `node_modules` except declared bundled dependencies) are rejected,
 * files outside the manifest `files` globs are rejected (except the files npm
 * always packs, such as `main` and `bin`), the packed `package.json` must keep
 * the repository name, version and publish-critical fields, and every public
 * entrypoint of the packed manifest (including `module`) must be present.
 *
 * @module create-version/artifact
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  ALWAYS_PACKED_FILE_PATTERN,
  ARCHIVE_ENTRY_KIND,
  ARTIFACT_NAME_PLACEHOLDER,
  ARTIFACT_SEGMENT_WILDCARD,
  ARTIFACT_SHA256_PLACEHOLDER,
  ARTIFACT_VERSION_PLACEHOLDER,
  BUNDLED_DEPENDENCIES_DIRECTORY,
  BUNDLED_DEPENDENCIES_FIELDS,
  DOTFILE_SEGMENT_PATTERN,
  FILES_ANY_CHARACTERS_WILDCARD,
  FILES_BRACE_END,
  FILES_BRACE_SEPARATOR,
  FILES_BRACE_START,
  FILES_CHARACTER_CLASS_END,
  FILES_CHARACTER_CLASS_NEGATIONS,
  FILES_CHARACTER_CLASS_START,
  FILES_DIRECTORY_CONTENTS_SUFFIX,
  FILES_GLOBSTAR,
  FILES_NEGATION_PREFIX,
  FILES_SINGLE_CHARACTER_WILDCARD,
  INSTALL_LIFECYCLE_SCRIPTS,
  PACK_REWRITTEN_DEPENDENCY_SPECIFIER_PATTERN,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_ROOT_PREFIX_PATTERN,
  PACKAGE_SCOPE_PATTERN,
  PACKED_ROOT_DIRECTORY,
  PACKAGE_SCOPE_PREFIX,
  PACKED_SCOPE_REPLACEMENT,
  PAX_LENGTH_SEPARATOR,
  PAX_LINK_PATH_KEY,
  PAX_PATH_KEY,
  PAX_RECORD_TERMINATOR_PATTERN,
  PRIVATE_PACKED_SEGMENT_PATTERN,
  PUBLISH_CRITICAL_DEPENDENCY_FIELDS,
  PUBLISH_CRITICAL_MANIFEST_FIELDS,
  SAFE_ARTIFACT_PATH_PATTERN,
  SHA256_HEX_PATTERN_SOURCE,
  TAR_BLOCK_SIZE,
  TAR_ENTRY_TYPE,
  TAR_HEADER_FIELD,
  TRAILING_NUL_PATTERN,
  TRAILING_SLASH_PATTERN,
  UNSAFE_PACKED_SEGMENTS,
} from "../constants/create-version.js";

/**
 * @typedef {{ path: string, expectedSha256: string | null }} PreparedArtifact
 * @typedef {{ name: string, kind: string, type: string, linkTarget: string | null, content: Buffer }} ArchiveEntry
 *   Archive entry: `kind` is one of `ARCHIVE_ENTRY_KIND`, `type` the raw tar type flag, `linkTarget`
 *   the target of a link entry and `content` the data of a regular file (empty otherwise).
 * @typedef {Record<string, unknown>} PackageManifest
 * @typedef {{ negated: boolean, matcher: RegExp }} FilesRule
 */

/** Characters with regular-expression meaning, escaped in literal segment text. */
const REGEXP_SPECIAL_CHARACTERS_PATTERN = /[.+?^${}()|[\]\\]/gu;

/** Characters escaped inside a compiled character class, so the class body keeps only literals and ranges. */
const CHARACTER_CLASS_SPECIAL_CHARACTERS_PATTERN = /[\\[\]^]/gu;

/** Expression source of any run of characters inside one path segment. */
const SEGMENT_CHARACTERS_SOURCE = "[^/]*";

/** Expression source of exactly one character inside one path segment. */
const SEGMENT_CHARACTER_SOURCE = "[^/]";

/** Expression source of a `**` segment followed by more segments: zero or more directories. */
const DIRECTORIES_SOURCE = "(?:[^/]+/)*";

/** Expression source of a trailing `**` segment: everything below the directory. */
const DIRECTORY_CONTENTS_SOURCE = ".+";

/** Expression source of the first `{sha256}` of a segment: captures the declared digest. */
const SHA256_CAPTURE_SOURCE = `(?<sha256>${SHA256_HEX_PATTERN_SOURCE})`;

/** Expression source of a repeated `{sha256}` in the same segment: must equal the captured digest. */
const SHA256_BACKREFERENCE_SOURCE = "\\k<sha256>";

/**
 * Converts an npm package name into the tarball base name `npm pack` and `pnpm pack` use.
 *
 * @param {string} packageName - npm package name, optionally scoped.
 * @returns {string} Name without `@` and with the scope joined by `-` (`@scope/pkg` → `scope-pkg`); unscoped names are unchanged.
 */
function toPackedName(packageName) {
  return packageName.replace(PACKAGE_SCOPE_PATTERN, PACKED_SCOPE_REPLACEMENT);
}

/**
 * Replaces the `{version}` and `{name}` placeholders of an artifact pattern; `{sha256}` stays.
 * `{name}` becomes the tarball base name, so scoped packages never add a path separator.
 *
 * @param {string} pattern - Configured pattern.
 * @param {{ version: string, packageName: string }} release - Version and npm package name.
 * @returns {string} Pattern with placeholders replaced.
 */
export function expandArtifactPattern(pattern, { version, packageName }) {
  return pattern.replaceAll(ARTIFACT_VERSION_PLACEHOLDER, version).replaceAll(ARTIFACT_NAME_PLACEHOLDER, toPackedName(packageName));
}

/**
 * Compiles one path segment: `*` matches anything but `/`, `{sha256}` captures a digest.
 * A repeated `{sha256}` becomes a backreference, so every occurrence must be the same digest.
 *
 * @param {string} segment - Segment of an expanded pattern.
 * @returns {RegExp} Anchored expression; the digest, when present, is the `sha256` group.
 */
function compileSegment(segment) {
  const [firstPart, ...partsAfterDigests] = segment
    .split(ARTIFACT_SHA256_PLACEHOLDER)
    .map((part) =>
      part
        .split(ARTIFACT_SEGMENT_WILDCARD)
        .map((literal) => literal.replace(REGEXP_SPECIAL_CHARACTERS_PATTERN, "\\$&"))
        .join(SEGMENT_CHARACTERS_SOURCE)
    );
  const source = partsAfterDigests.reduce(
    (compiled, part, index) => `${compiled}${index === 0 ? SHA256_CAPTURE_SOURCE : SHA256_BACKREFERENCE_SOURCE}${part}`,
    firstPart
  );
  return new RegExp(`^${source}$`, "u");
}

/**
 * Finds the newest file that matches an artifact pattern.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} pattern - Configured pattern with `{version}` and optional `{name}`, `*` and `{sha256}`.
 * @param {{ version: string, packageName: string }} release - Version and npm package name.
 * @returns {PreparedArtifact | null} Path relative to the root with `/` separators and the digest its path declares, or `null`.
 *   Paths whose segments declare different digests never match.
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
        if (!match || !(isLast ? entry.isFile() : entry.isDirectory())) continue;

        const declaredSha256 = match.groups?.sha256 ?? null;
        if (declaredSha256 && candidate.expectedSha256 && declaredSha256 !== candidate.expectedSha256) continue;

        next.push({
          path: candidate.path ? `${candidate.path}/${entry.name}` : entry.name,
          expectedSha256: declaredSha256 ?? candidate.expectedSha256,
        });
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
 * Parses the records of a PAX extended header.
 *
 * @param {Buffer} content - PAX header data (`<length> <key>=<value>\n` records, lengths in bytes).
 * @returns {Map<string, string>} Record values by key; a later record overrides an earlier one.
 */
function readPaxRecords(content) {
  /** @type {Map<string, string>} */
  const records = new Map();
  for (let offset = 0; offset < content.length; ) {
    const lengthSeparator = content.indexOf(PAX_LENGTH_SEPARATOR, offset);
    const recordLength = Number.parseInt(content.subarray(offset, lengthSeparator).toString("utf8"), 10);
    if (lengthSeparator === -1 || !Number.isInteger(recordLength) || recordLength <= 0) break;

    const record = content.subarray(lengthSeparator + 1, offset + recordLength).toString("utf8").replace(PAX_RECORD_TERMINATOR_PATTERN, "");
    const keySeparator = record.indexOf("=");
    if (keySeparator !== -1) records.set(record.slice(0, keySeparator), record.slice(keySeparator + 1));
    offset += recordLength;
  }
  return records;
}

/**
 * Classifies a tar entry type; only regular files and directories can be published.
 *
 * @param {string} type - Tar type flag.
 * @returns {string} One of {@link ARCHIVE_ENTRY_KIND}.
 */
function toArchiveEntryKind(type) {
  if (type === TAR_ENTRY_TYPE.file || type === TAR_ENTRY_TYPE.legacyFile || type === TAR_ENTRY_TYPE.contiguousFile) return ARCHIVE_ENTRY_KIND.file;
  if (type === TAR_ENTRY_TYPE.directory) return ARCHIVE_ENTRY_KIND.directory;
  if (type === TAR_ENTRY_TYPE.hardLink) return ARCHIVE_ENTRY_KIND.hardLink;
  if (type === TAR_ENTRY_TYPE.symbolicLink) return ARCHIVE_ENTRY_KIND.symbolicLink;
  return ARCHIVE_ENTRY_KIND.unsupported;
}

/**
 * Lists every entry of a `.tgz` archive, without external tools: regular files with their
 * contents, and directories, links and any other entry type with their names (and link
 * targets), so the verifier can reject what npm would publish but the checks could not see.
 * PAX and GNU long names and link targets are applied to the entry they precede; a PAX global
 * header that renames entries is reported as an unsupported entry.
 *
 * @param {Buffer} archive - Gzipped tar archive.
 * @returns {ArchiveEntry[]} Entries in archive order; only files carry content.
 * @throws {Error} When the archive is not a readable gzip tar.
 */
export function readTarballEntries(archive) {
  const tar = gunzipSync(archive);
  /** @type {ArchiveEntry[]} */
  const entries = [];
  /** @type {string | null} */
  let pendingLongName = null;
  /** @type {string | null} */
  let pendingLongLinkTarget = null;

  for (let offset = 0; offset + TAR_BLOCK_SIZE <= tar.length; ) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const size = Number.parseInt(readHeaderField(header, TAR_HEADER_FIELD.size).trim() || "0", 8);
    const type = readHeaderField(header, TAR_HEADER_FIELD.type) || TAR_ENTRY_TYPE.legacyFile;
    const content = tar.subarray(offset + TAR_BLOCK_SIZE, offset + TAR_BLOCK_SIZE + size);
    const prefix = readHeaderField(header, TAR_HEADER_FIELD.prefix);
    const shortName = readHeaderField(header, TAR_HEADER_FIELD.name);
    const headerName = prefix ? `${prefix}/${shortName}` : shortName;

    if (type === TAR_ENTRY_TYPE.paxHeader) {
      const records = readPaxRecords(content);
      pendingLongName = records.get(PAX_PATH_KEY) ?? pendingLongName;
      pendingLongLinkTarget = records.get(PAX_LINK_PATH_KEY) ?? pendingLongLinkTarget;
    } else if (type === TAR_ENTRY_TYPE.paxGlobalHeader) {
      const records = readPaxRecords(content);
      if (records.has(PAX_PATH_KEY) || records.has(PAX_LINK_PATH_KEY)) {
        entries.push({
          name: records.get(PAX_PATH_KEY) ?? headerName,
          kind: ARCHIVE_ENTRY_KIND.unsupported,
          type,
          linkTarget: records.get(PAX_LINK_PATH_KEY) ?? null,
          content: Buffer.alloc(0),
        });
      }
    } else if (type === TAR_ENTRY_TYPE.gnuLongName) {
      pendingLongName = content.toString("utf8").replace(TRAILING_NUL_PATTERN, "");
    } else if (type === TAR_ENTRY_TYPE.gnuLongLinkName) {
      pendingLongLinkTarget = content.toString("utf8").replace(TRAILING_NUL_PATTERN, "");
    } else {
      const kind = toArchiveEntryKind(type);
      const isLink = kind === ARCHIVE_ENTRY_KIND.hardLink || kind === ARCHIVE_ENTRY_KIND.symbolicLink;
      entries.push({
        name: pendingLongName ?? headerName,
        kind,
        type,
        linkTarget: isLink ? (pendingLongLinkTarget ?? readHeaderField(header, TAR_HEADER_FIELD.linkName)) : null,
        content: kind === ARCHIVE_ENTRY_KIND.file ? Buffer.from(content) : Buffer.alloc(0),
      });
      pendingLongName = null;
      pendingLongLinkTarget = null;
    }

    offset += TAR_BLOCK_SIZE + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  return entries;
}

/**
 * Normalizes a path declared in `package.json` to the form it has inside `package/`.
 *
 * @param {string} declaredPath - Manifest path, optionally prefixed with `./` or `/`.
 * @returns {string} Path relative to the package root.
 */
function toPackedPath(declaredPath) {
  return declaredPath.replace(PACKAGE_ROOT_PREFIX_PATTERN, "");
}

/**
 * Collects the relative file paths a manifest declares as public entrypoints.
 *
 * @param {unknown} value - `exports`, `main`, `types` or `bin` value.
 * @returns {string[]} Paths without `./`; wildcard targets are skipped.
 */
function collectEntrypoints(value) {
  if (typeof value === "string") {
    return value.includes(ARTIFACT_SEGMENT_WILDCARD) ? [] : [toPackedPath(value)];
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(collectEntrypoints) : [];
}

/**
 * Collects the files npm packs whatever `files` says: `main` and every `bin` target.
 *
 * @param {PackageManifest} manifest - Manifest being published.
 * @returns {Set<string>} Paths relative to the package root.
 */
function collectMandatoryFiles(manifest) {
  const declaredPaths = [manifest.main, ...(typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {}))];
  return new Set(declaredPaths.filter((declaredPath) => typeof declaredPath === "string").map(toPackedPath));
}

/**
 * Expands the brace alternations of a `files` glob like minimatch: `dist/*.{js,mjs}` becomes
 * `dist/*.js` and `dist/*.mjs`. Braces without a top-level `,` or without a closing brace stay literal.
 *
 * @param {string} pattern - `files` entry without its negation prefix.
 * @returns {string[]} Patterns without alternations, in expansion order.
 */
function expandFilesBraces(pattern) {
  for (let start = pattern.indexOf(FILES_BRACE_START); start !== -1; start = pattern.indexOf(FILES_BRACE_START, start + 1)) {
    let depth = 0;
    /** @type {number[]} */
    const separators = [];

    for (let index = start; index < pattern.length; index++) {
      const character = pattern[index];
      if (character === FILES_BRACE_START) depth++;
      else if (character === FILES_BRACE_SEPARATOR && depth === 1) separators.push(index);
      else if (character === FILES_BRACE_END && --depth === 0) {
        if (separators.length === 0) break;
        const boundaries = [start, ...separators, index];
        const alternatives = boundaries.slice(1).map((boundary, alternativeIndex) => pattern.slice(boundaries[alternativeIndex] + 1, boundary));
        return alternatives.flatMap((alternative) => expandFilesBraces(`${pattern.slice(0, start)}${alternative}${pattern.slice(index + 1)}`));
      }
    }
  }
  return [pattern];
}

/**
 * Reads a character class (`[ab]`, `[a-z]`, `[!ab]` or `[^ab]`) that starts at `startIndex`.
 * A leading `]` is literal, like in minimatch; a class never matches `/`.
 *
 * @param {string} segment - Glob segment, without `/`.
 * @param {number} startIndex - Index of the opening `[`.
 * @returns {{ source: string, endIndex: number } | null} Expression source and index of the closing `]`,
 *   or `null` when the bracket does not open a valid class and must be matched literally.
 */
function readCharacterClass(segment, startIndex) {
  let bodyStart = startIndex + 1;
  const isNegated = FILES_CHARACTER_CLASS_NEGATIONS.includes(segment[bodyStart]);
  if (isNegated) bodyStart++;

  const endIndex = segment.indexOf(FILES_CHARACTER_CLASS_END, segment[bodyStart] === FILES_CHARACTER_CLASS_END ? bodyStart + 1 : bodyStart);
  if (endIndex === -1) return null;

  const body = segment.slice(bodyStart, endIndex).replace(CHARACTER_CLASS_SPECIAL_CHARACTERS_PATTERN, "\\$&");
  const source = isNegated ? `[^/${body}]` : `[${body}]`;
  try {
    new RegExp(source, "u");
  } catch {
    // An invalid range such as `[z-a]` matches nothing in minimatch; keep it literal instead of failing the whole verification.
    return null;
  }
  return { source, endIndex };
}

/**
 * Compiles one glob segment: `*` and `?` stay inside the segment and `[...]` is a character class.
 *
 * @param {string} segment - Glob segment, without `/`.
 * @returns {string} Expression source.
 */
function compileFilesSegment(segment) {
  let source = "";
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    const characterClass = character === FILES_CHARACTER_CLASS_START ? readCharacterClass(segment, index) : null;
    if (characterClass) {
      source += characterClass.source;
      index = characterClass.endIndex;
    } else if (character === FILES_ANY_CHARACTERS_WILDCARD) {
      source += SEGMENT_CHARACTERS_SOURCE;
    } else if (character === FILES_SINGLE_CHARACTER_WILDCARD) {
      source += SEGMENT_CHARACTER_SOURCE;
    } else {
      source += character.replace(REGEXP_SPECIAL_CHARACTERS_PATTERN, "\\$&");
    }
  }
  return source;
}

/**
 * Compiles one brace-free `files` glob, anchored at the package root: `**` spans directories.
 *
 * @param {string} pattern - Brace-free `files` pattern.
 * @returns {string} Expression source, without anchors.
 */
function compileFilesPatternSource(pattern) {
  let normalized = toPackedPath(pattern);
  if (normalized.endsWith(FILES_DIRECTORY_CONTENTS_SUFFIX)) normalized += ARTIFACT_SEGMENT_WILDCARD;
  const segments = normalized.replace(TRAILING_SLASH_PATTERN, "").split("/");

  return segments
    .map((segment, index) => {
      const isLast = index === segments.length - 1;
      if (segment === FILES_GLOBSTAR) return isLast ? DIRECTORY_CONTENTS_SOURCE : DIRECTORIES_SOURCE;
      const segmentSource = compileFilesSegment(segment);
      return isLast ? segmentSource : `${segmentSource}/`;
    })
    .join("");
}

/**
 * Compiles one `files` glob with the syntax npm accepts: `*`, `?`, `**`, character classes and brace alternations.
 *
 * @param {string} pattern - `files` entry without its negation prefix.
 * @returns {RegExp} Expression matched against packed paths and their parent directories.
 */
function compileFilesPattern(pattern) {
  const alternatives = expandFilesBraces(pattern).map(compileFilesPatternSource);
  return new RegExp(`^(?:${alternatives.join("|")})$`, "u");
}

/**
 * Compiles the manifest `files` list into ordered include and exclude rules.
 *
 * @param {string[]} files - Manifest `files` entries.
 * @returns {FilesRule[]} Rules in declaration order.
 */
function compileFilesRules(files) {
  return files.map((file) => {
    const negated = file.startsWith(FILES_NEGATION_PREFIX);
    return { negated, matcher: compileFilesPattern(negated ? file.slice(FILES_NEGATION_PREFIX.length) : file) };
  });
}

/**
 * Tells whether a packed path is covered by the manifest `files` list, with npm's gitignore-style rules:
 * an entry that matches a directory covers everything inside it and the last matching entry wins,
 * so a later `!pattern` excludes what an earlier entry included.
 *
 * @param {string} packedPath - Path relative to `package/`.
 * @param {FilesRule[]} rules - Compiled `files` entries.
 * @param {Set<string>} mandatoryFiles - `main` and `bin` targets, always packed.
 * @returns {boolean} Whether npm is allowed to pack it.
 */
function isDeclaredFile(packedPath, rules, mandatoryFiles) {
  if (!packedPath.includes("/") && ALWAYS_PACKED_FILE_PATTERN.test(packedPath)) return true;
  if (mandatoryFiles.has(packedPath)) return true;

  const segments = packedPath.split("/");
  const pathAndParents = segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
  let isIncluded = false;
  for (const { negated, matcher } of rules) {
    if (pathAndParents.some((candidatePath) => matcher.test(candidatePath))) isIncluded = !negated;
  }
  return isIncluded;
}

/**
 * Compares two JSON values structurally; object key order is ignored and array order is not.
 *
 * @param {unknown} left - First value.
 * @param {unknown} right - Second value.
 * @returns {boolean} Whether both values are equivalent.
 */
function isStructurallyEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => isStructurallyEqual(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;

  const leftRecord = /** @type {Record<string, unknown>} */ (left);
  const rightRecord = /** @type {Record<string, unknown>} */ (right);
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  return [...keys].every((key) => isStructurallyEqual(leftRecord[key], rightRecord[key]));
}

/**
 * Lists the values a packed field may legitimately have: the repository value and, when
 * `publishConfig` overrides the field (as `pnpm pack` applies it), the override.
 *
 * @param {PackageManifest} manifest - Repository manifest.
 * @param {string} field - Manifest field.
 * @returns {unknown[]} Accepted values.
 */
function acceptedFieldValues(manifest, field) {
  const publishConfig = manifest.publishConfig;
  const hasOverride = publishConfig !== null && typeof publishConfig === "object" && Object.hasOwn(publishConfig, field);
  return hasOverride ? [/** @type {Record<string, unknown>} */ (publishConfig)[field], manifest[field]] : [manifest[field]];
}

/**
 * Compares a packed dependency map with the repository one; `workspace:` and `catalog:`
 * specifiers only require the dependency, because `pnpm pack` replaces them with a version range.
 *
 * @param {unknown} packed - Packed dependency map.
 * @param {unknown} expected - Repository (or `publishConfig`) dependency map.
 * @returns {boolean} Whether both declare the same dependencies.
 */
function isSameDependencyMap(packed, expected) {
  if (!expected || typeof expected !== "object" || !packed || typeof packed !== "object") return isStructurallyEqual(packed, expected);

  const packedRecord = /** @type {Record<string, unknown>} */ (packed);
  const expectedRecord = /** @type {Record<string, unknown>} */ (expected);
  const names = new Set([...Object.keys(packedRecord), ...Object.keys(expectedRecord)]);
  return [...names].every((dependencyName) => {
    const expectedSpecifier = expectedRecord[dependencyName];
    const packedSpecifier = packedRecord[dependencyName];
    if (typeof expectedSpecifier === "string" && PACK_REWRITTEN_DEPENDENCY_SPECIFIER_PATTERN.test(expectedSpecifier)) {
      return typeof packedSpecifier === "string" && packedSpecifier !== "";
    }
    return packedSpecifier === expectedSpecifier;
  });
}

/**
 * Reads one lifecycle script of a manifest.
 *
 * @param {PackageManifest} manifest - Manifest.
 * @param {string} scriptName - Script name.
 * @returns {unknown} Script command, or `undefined`.
 */
function readScript(manifest, scriptName) {
  const scripts = manifest.scripts;
  return scripts && typeof scripts === "object" ? /** @type {Record<string, unknown>} */ (scripts)[scriptName] : undefined;
}

/**
 * Compares the publish-critical fields of the packed manifest with the repository manifest.
 *
 * @param {PackageManifest} packed - `package.json` inside the archive, the one npm publishes.
 * @param {PackageManifest} manifest - Repository `package.json`.
 * @returns {string[]} Problems in Spanish; empty when nothing drifted.
 */
function findManifestDrift(packed, manifest) {
  /** @type {string[]} */
  const problems = [];

  for (const field of PUBLISH_CRITICAL_MANIFEST_FIELDS) {
    if (!acceptedFieldValues(manifest, field).some((accepted) => isStructurallyEqual(packed[field], accepted))) {
      problems.push(`"${field}" del ${PACKAGE_MANIFEST_FILE} del tarball no coincide con el del repositorio`);
    }
  }

  for (const field of PUBLISH_CRITICAL_DEPENDENCY_FIELDS) {
    if (!acceptedFieldValues(manifest, field).some((accepted) => isSameDependencyMap(packed[field], accepted))) {
      problems.push(`"${field}" del ${PACKAGE_MANIFEST_FILE} del tarball no coincide con el del repositorio`);
    }
  }

  for (const scriptName of INSTALL_LIFECYCLE_SCRIPTS) {
    if (readScript(packed, scriptName) !== readScript(manifest, scriptName)) {
      problems.push(`el script "${scriptName}" del ${PACKAGE_MANIFEST_FILE} del tarball no coincide con el del repositorio`);
    }
  }

  return problems;
}

/**
 * Checks that an archive entry name stays under `package/` without ambiguous segments.
 *
 * @param {string} entryName - Entry name without trailing `/`.
 * @returns {boolean} Whether the name has no `\`, `..`, `.` or empty segment.
 */
function isSafePackedEntryName(entryName) {
  if (!entryName.startsWith(PACKED_ROOT_DIRECTORY) || entryName.includes("\\")) return false;
  return entryName.split("/").every((segment) => !UNSAFE_PACKED_SEGMENTS.includes(segment));
}

/**
 * Collects the dependencies a manifest declares as bundled, which `npm pack` places under `node_modules`.
 *
 * @param {PackageManifest} manifest - Manifest being published.
 * @returns {Set<string>} Bundled dependency names; `true` bundles every `dependencies` entry.
 */
function collectBundledDependencies(manifest) {
  /** @type {Set<string>} */
  const names = new Set();
  const dependencies = manifest.dependencies;

  for (const field of BUNDLED_DEPENDENCIES_FIELDS) {
    const declared = manifest[field];
    if (declared === true && dependencies && typeof dependencies === "object") {
      for (const dependencyName of Object.keys(dependencies)) names.add(dependencyName);
    } else if (Array.isArray(declared)) {
      for (const dependencyName of declared) if (typeof dependencyName === "string") names.add(dependencyName);
    }
  }
  return names;
}

/**
 * Tells whether a packed file belongs to a bundled dependency: `node_modules/<name>/...`
 * or `node_modules/@scope/<name>/...`, with `<name>` declared as bundled.
 *
 * @param {string[]} segments - Segments of the path relative to `package/`.
 * @param {Set<string>} bundledDependencies - Names from {@link collectBundledDependencies}.
 * @returns {boolean} Whether npm packs it as part of a bundled dependency.
 */
function isBundledDependencyPath(segments, bundledDependencies) {
  if (segments[0] !== BUNDLED_DEPENDENCIES_DIRECTORY) return false;
  const nameSegmentCount = segments[1]?.startsWith(PACKAGE_SCOPE_PREFIX) ? 2 : 1;
  const dependencyName = segments.slice(1, 1 + nameSegmentCount).join("/");
  return segments.length > 1 + nameSegmentCount && bundledDependencies.has(dependencyName);
}

/**
 * Parses the `package.json` packed in the archive. When the archive repeats it (rejected
 * separately), the last one is read, because it is the one npm keeps.
 *
 * @param {ArchiveEntry[]} entries - Archive entries.
 * @returns {{ packed: PackageManifest | null, problem: string | null }} Parsed manifest, or the reason it is unusable.
 */
function readPackedManifest(entries) {
  const packedManifestEntry = entries.findLast(
    (entry) => entry.kind === ARCHIVE_ENTRY_KIND.file && entry.name === `${PACKED_ROOT_DIRECTORY}${PACKAGE_MANIFEST_FILE}`
  );
  if (!packedManifestEntry) return { packed: null, problem: `falta ${PACKAGE_MANIFEST_FILE} en el tarball` };

  try {
    const packed = JSON.parse(packedManifestEntry.content.toString("utf8"));
    if (packed && typeof packed === "object" && !Array.isArray(packed)) return { packed, problem: null };
    return { packed: null, problem: `${PACKAGE_MANIFEST_FILE} del tarball no es un objeto JSON` };
  } catch (error) {
    return { packed: null, problem: `${PACKAGE_MANIFEST_FILE} del tarball no es JSON válido (${error instanceof Error ? error.message : String(error)})` };
  }
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
  const { packed, problem: packedManifestProblem } = readPackedManifest(entries);

  if (packedManifestProblem) {
    problems.push(packedManifestProblem);
  } else if (packed) {
    if (packed.name !== manifest.name || packed.version !== manifest.version) {
      problems.push(`el tarball es ${packed.name}@${packed.version} y el repositorio ${manifest.name}@${manifest.version}`);
    }
    problems.push(...findManifestDrift(packed, manifest));
  }

  // npm publishes the packed manifest, so its `files`, `main`, `bin` and entrypoints are the ones that count.
  const publishedManifest = packed ?? manifest;
  const files = Array.isArray(publishedManifest.files) ? publishedManifest.files.filter((file) => typeof file === "string") : null;
  const filesRules = files ? compileFilesRules(files) : null;
  const mandatoryFiles = collectMandatoryFiles(publishedManifest);
  const bundledDependencies = collectBundledDependencies(publishedManifest);
  const packedPaths = new Set();
  /** @type {Set<string>} */
  const seenNames = new Set();

  for (const { name, kind, type, linkTarget } of entries) {
    const normalizedName = name.replace(TRAILING_SLASH_PATTERN, "");
    // npm keeps the last entry of a repeated path, so every earlier copy would escape these checks.
    if (seenNames.has(normalizedName)) {
      problems.push(`ruta repetida en el tarball: ${name}`);
      continue;
    }
    seenNames.add(normalizedName);

    if (kind === ARCHIVE_ENTRY_KIND.directory && normalizedName === PACKED_ROOT_DIRECTORY.replace(TRAILING_SLASH_PATTERN, "")) continue;
    if (!isSafePackedEntryName(normalizedName)) {
      problems.push(`ruta inválida en el tarball: ${name}`);
      continue;
    }
    if (kind === ARCHIVE_ENTRY_KIND.directory) continue;
    if (kind !== ARCHIVE_ENTRY_KIND.file) {
      problems.push(`entrada no soportada en el tarball (${kind}, tipo ${JSON.stringify(type)}): ${name}${linkTarget === null ? "" : ` -> ${linkTarget}`}`);
      continue;
    }

    const packedPath = normalizedName.slice(PACKED_ROOT_DIRECTORY.length);
    const segments = packedPath.split("/");
    packedPaths.add(packedPath);

    if (isBundledDependencyPath(segments, bundledDependencies)) {
      // npm packs bundled dependencies whatever the root `files` says, so only their dotfiles are rejected.
      if (segments.some((segment) => DOTFILE_SEGMENT_PATTERN.test(segment))) problems.push(`archivo privado en el tarball: ${packedPath}`);
    } else if (segments.some((segment) => PRIVATE_PACKED_SEGMENT_PATTERN.test(segment))) {
      problems.push(`archivo privado en el tarball: ${packedPath}`);
    } else if (filesRules && !isDeclaredFile(packedPath, filesRules, mandatoryFiles)) {
      problems.push(`archivo fuera de "files" en el tarball: ${packedPath}`);
    }
  }

  const entrypoints = [
    publishedManifest.exports,
    publishedManifest.main,
    publishedManifest.module,
    publishedManifest.types,
    publishedManifest.typings,
    publishedManifest.bin,
  ].flatMap(collectEntrypoints);
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
