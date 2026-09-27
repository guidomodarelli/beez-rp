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
 * must stay under `package/` and appear once, and only regular files and
 * directories are accepted (links and other entry types are rejected). npm itself
 * decides which files the package holds: the archive must contain exactly the
 * files `npm pack --dry-run` reports for the release checkout. The packed
 * `package.json` must keep the name, version and publish-critical fields
 * (including `publishConfig`) of the release commit, and every public entrypoint
 * of the packed manifest (including `module`) must be present.
 *
 * @module create-version/artifact
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  ARCHIVE_ENTRY_KIND,
  ARTIFACT_NAME_PLACEHOLDER,
  ARTIFACT_SEGMENT_WILDCARD,
  ARTIFACT_SHA256_PLACEHOLDER,
  ARTIFACT_VERSION_PLACEHOLDER,
  INSTALL_LIFECYCLE_SCRIPTS,
  NPM_ALIAS_SPECIFIER_PATTERN,
  NPM_PACKAGE_NAME_PATTERN,
  PACK_REWRITTEN_DEPENDENCY_SPECIFIER_PATTERN,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_ROOT_PREFIX_PATTERN,
  PACKAGE_SCOPE_PATTERN,
  PACKED_ROOT_DIRECTORY,
  PACKED_SCOPE_REPLACEMENT,
  PAX_DECIMAL_SIZE_PATTERN,
  PAX_LENGTH_SEPARATOR,
  PAX_LINK_PATH_KEY,
  PAX_PATH_KEY,
  PAX_RECORD_TERMINATOR_PATTERN,
  PAX_SIZE_KEY,
  PNPM_HOISTED_PUBLISH_CONFIG_FIELDS,
  PUBLISH_CONFIG_FIELD,
  PUBLISH_CRITICAL_DEPENDENCY_FIELDS,
  PUBLISH_CRITICAL_MANIFEST_FIELDS,
  SAFE_ARTIFACT_PATH_PATTERN,
  SEMVER_RANGE_PATTERN,
  SHA256_HEX_PATTERN_SOURCE,
  TAR_BLOCK_SIZE,
  TAR_ENTRY_TYPE,
  TAR_HEADER_FIELD,
  TAR_OCTAL_SIZE_PATTERN,
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
 * @typedef {{ name: unknown, version: unknown, files: string[] }} NpmPackListing
 *   What `npm pack --dry-run --json` reports for the release checkout: package name, version and packed file paths.
 * @typedef {{ manifest: PackageManifest, npmPack: NpmPackListing }} ArchiveExpectation
 *   `package.json` of the release commit and the npm file listing the archive must match.
 */

/** Characters with regular-expression meaning, escaped in literal segment text. */
const REGEXP_SPECIAL_CHARACTERS_PATTERN = /[.+?^${}()|[\]\\]/gu;

/** Expression source of any run of characters inside one path segment. */
const SEGMENT_CHARACTERS_SOURCE = "[^/]*";

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
 * Reads the octal data size of a ustar header.
 *
 * @param {Buffer} header - 512-byte header.
 * @returns {number} Size in bytes.
 * @throws {Error} When the size is not octal (for example a base-256 size), so no entry can be skipped silently.
 */
function readHeaderSize(header) {
  const rawSize = readHeaderField(header, TAR_HEADER_FIELD.size).trim();
  if (!TAR_OCTAL_SIZE_PATTERN.test(rawSize)) throw new Error(`tamaño no soportado en un header tar (${JSON.stringify(rawSize)})`);
  return rawSize === "" ? 0 : Number.parseInt(rawSize, 8);
}

/**
 * Parses the `size` record of a PAX extended header.
 *
 * @param {string} value - Record value.
 * @returns {number} Size in bytes.
 * @throws {Error} When the value is not a safe decimal integer.
 */
function parsePaxSize(value) {
  const size = Number(value);
  if (!PAX_DECIMAL_SIZE_PATTERN.test(value) || !Number.isSafeInteger(size)) throw new Error(`size PAX inválido (${JSON.stringify(value)})`);
  return size;
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

/** Tar entry types that only carry metadata for the entry that follows them. */
/** @type {Set<string>} */
const METADATA_ENTRY_TYPES = new Set([TAR_ENTRY_TYPE.paxHeader, TAR_ENTRY_TYPE.paxGlobalHeader, TAR_ENTRY_TYPE.gnuLongName, TAR_ENTRY_TYPE.gnuLongLinkName]);

/**
 * Lists every entry of a `.tgz` archive, without external tools: regular files with their
 * contents, and directories, links and any other entry type with their names (and link
 * targets), so the verifier can reject what npm would publish but the checks could not see.
 * A PAX extended header applies its `path`, `linkpath` and `size` to the next entry, and `size`
 * also decides where the following header starts, like the tar reader npm uses; GNU long
 * names and link targets are applied too. A PAX global header that renames entries or overrides
 * their size is reported as an unsupported entry.
 *
 * @param {Buffer} archive - Gzipped tar archive.
 * @returns {ArchiveEntry[]} Entries in archive order; only files carry content.
 * @throws {Error} When the archive is not a readable gzip tar, a size is invalid or an entry is truncated.
 */
export function readTarballEntries(archive) {
  const tar = gunzipSync(archive);
  /** @type {ArchiveEntry[]} */
  const entries = [];
  /** @type {string | null} */
  let pendingLongName = null;
  /** @type {string | null} */
  let pendingLongLinkTarget = null;
  /** @type {number | null} */
  let pendingSize = null;

  for (let offset = 0; offset + TAR_BLOCK_SIZE <= tar.length; ) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const type = readHeaderField(header, TAR_HEADER_FIELD.type) || TAR_ENTRY_TYPE.legacyFile;
    const prefix = readHeaderField(header, TAR_HEADER_FIELD.prefix);
    const shortName = readHeaderField(header, TAR_HEADER_FIELD.name);
    const headerName = prefix ? `${prefix}/${shortName}` : shortName;
    const isMetadata = METADATA_ENTRY_TYPES.has(type);
    const size = !isMetadata && pendingSize !== null ? pendingSize : readHeaderSize(header);
    const dataEnd = offset + TAR_BLOCK_SIZE + size;
    if (dataEnd > tar.length) throw new Error(`la entrada ${pendingLongName ?? headerName} declara ${size} bytes y el archivo termina antes`);
    const content = tar.subarray(offset + TAR_BLOCK_SIZE, dataEnd);

    if (type === TAR_ENTRY_TYPE.paxHeader) {
      const records = readPaxRecords(content);
      pendingLongName = records.get(PAX_PATH_KEY) ?? pendingLongName;
      pendingLongLinkTarget = records.get(PAX_LINK_PATH_KEY) ?? pendingLongLinkTarget;
      const paxSize = records.get(PAX_SIZE_KEY);
      if (paxSize !== undefined) pendingSize = parsePaxSize(paxSize);
    } else if (type === TAR_ENTRY_TYPE.paxGlobalHeader) {
      const records = readPaxRecords(content);
      if (records.has(PAX_PATH_KEY) || records.has(PAX_LINK_PATH_KEY) || records.has(PAX_SIZE_KEY)) {
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
      pendingSize = null;
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
 * Tells whether a value is a plain JSON object.
 *
 * @param {unknown} value - Any value.
 * @returns {value is Record<string, unknown>} Whether it is a non-array object.
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  if (!isRecord(left) || !isRecord(right)) return false;

  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => isStructurallyEqual(left[key], right[key]));
}

/**
 * Lists the values a packed field may legitimately have: the release value and, when
 * `publishConfig` overrides the field (as `pnpm pack` applies it), the override.
 *
 * @param {PackageManifest} manifest - Release manifest.
 * @param {string} field - Manifest field.
 * @returns {unknown[]} Accepted values.
 */
function acceptedFieldValues(manifest, field) {
  const publishConfig = manifest[PUBLISH_CONFIG_FIELD];
  return isRecord(publishConfig) && Object.hasOwn(publishConfig, field) ? [publishConfig[field], manifest[field]] : [manifest[field]];
}

/**
 * Lists the `publishConfig` values the packed manifest may have: the release one, or the one
 * `pnpm pack` leaves after moving the fields it hoists (dropped when nothing remains).
 * npm applies the remaining keys (`registry`, `tag`, `access`, `provenance`...) when publishing.
 *
 * @param {PackageManifest} manifest - Release manifest.
 * @returns {unknown[]} Accepted values.
 */
function acceptedPublishConfigValues(manifest) {
  const publishConfig = manifest[PUBLISH_CONFIG_FIELD];
  if (!isRecord(publishConfig)) return [publishConfig];

  const remaining = Object.fromEntries(Object.entries(publishConfig).filter(([key]) => !PNPM_HOISTED_PUBLISH_CONFIG_FIELDS.includes(key)));
  return [publishConfig, Object.keys(remaining).length > 0 ? remaining : undefined];
}

/**
 * Tells whether a packed specifier is a valid rewrite of a `workspace:` or `catalog:` one:
 * a semver version or range, or an `npm:<name>@<range>` alias. URLs, Git, `file:`, `link:`,
 * tarballs and any other protocol are rejected, because npm would install them as they are.
 *
 * @param {unknown} specifier - Packed dependency specifier.
 * @returns {boolean} Whether `pnpm pack` could have produced it.
 */
export function isRewrittenDependencySpecifier(specifier) {
  if (typeof specifier !== "string") return false;
  if (SEMVER_RANGE_PATTERN.test(specifier)) return true;

  const alias = NPM_ALIAS_SPECIFIER_PATTERN.exec(specifier)?.groups;
  return Boolean(alias && NPM_PACKAGE_NAME_PATTERN.test(alias.name) && SEMVER_RANGE_PATTERN.test(alias.range));
}

/**
 * Compares a packed dependency map with the release one; `workspace:` and `catalog:`
 * specifiers must be rewritten to a version range, as `pnpm pack` does.
 *
 * @param {unknown} packed - Packed dependency map.
 * @param {unknown} expected - Release (or `publishConfig`) dependency map.
 * @returns {boolean} Whether both declare the same dependencies.
 */
function isSameDependencyMap(packed, expected) {
  if (!isRecord(expected) || !isRecord(packed)) return isStructurallyEqual(packed, expected);

  const names = new Set([...Object.keys(packed), ...Object.keys(expected)]);
  return [...names].every((dependencyName) => {
    const expectedSpecifier = expected[dependencyName];
    const packedSpecifier = packed[dependencyName];
    if (typeof expectedSpecifier === "string" && PACK_REWRITTEN_DEPENDENCY_SPECIFIER_PATTERN.test(expectedSpecifier)) {
      return isRewrittenDependencySpecifier(packedSpecifier);
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
  return isRecord(scripts) ? scripts[scriptName] : undefined;
}

/**
 * Compares the publish-critical fields of the packed manifest with the release manifest.
 *
 * @param {PackageManifest} packed - `package.json` inside the archive, the one npm publishes.
 * @param {PackageManifest} manifest - `package.json` of the release commit.
 * @returns {string[]} Problems in Spanish; empty when nothing drifted.
 */
function findManifestDrift(packed, manifest) {
  /** @type {string[]} */
  const problems = [];
  /** @param {string} field - Drifted field. */
  const reportField = (field) => problems.push(`"${field}" del ${PACKAGE_MANIFEST_FILE} del tarball no coincide con el del commit de release`);

  for (const field of PUBLISH_CRITICAL_MANIFEST_FIELDS) {
    if (!acceptedFieldValues(manifest, field).some((accepted) => isStructurallyEqual(packed[field], accepted))) reportField(field);
  }

  if (!acceptedPublishConfigValues(manifest).some((accepted) => isStructurallyEqual(packed[PUBLISH_CONFIG_FIELD], accepted))) {
    reportField(PUBLISH_CONFIG_FIELD);
  }

  for (const field of PUBLISH_CRITICAL_DEPENDENCY_FIELDS) {
    if (!acceptedFieldValues(manifest, field).some((accepted) => isSameDependencyMap(packed[field], accepted))) reportField(field);
  }

  for (const scriptName of INSTALL_LIFECYCLE_SCRIPTS) {
    if (readScript(packed, scriptName) !== readScript(manifest, scriptName)) {
      problems.push(`el script "${scriptName}" del ${PACKAGE_MANIFEST_FILE} del tarball no coincide con el del commit de release`);
    }
  }

  return problems;
}

/**
 * Checks the release identity before trusting any archive: the `package.json` of the release
 * commit must declare the version being published, and the working tree (which `prepare` may
 * have touched and which `npm pack --dry-run` reads) must keep its name, version and every
 * field that changes what or how npm publishes.
 *
 * @param {{ releaseManifest: PackageManifest | null, workingManifest: PackageManifest, version: string }} release -
 *   `package.json` of the release commit (`null` when unreadable), of the working tree, and the version being published.
 * @returns {string[]} Problems in Spanish; empty when both manifests describe the release.
 */
export function findReleaseManifestProblems({ releaseManifest, workingManifest, version }) {
  if (!releaseManifest) return [`no se pudo leer el ${PACKAGE_MANIFEST_FILE} del commit de release`];
  if (releaseManifest.version !== version) {
    return [`el ${PACKAGE_MANIFEST_FILE} del commit de release es ${releaseManifest.name}@${releaseManifest.version} y se está publicando ${version}`];
  }

  const comparedFields = ["name", "version", ...PUBLISH_CRITICAL_MANIFEST_FIELDS, PUBLISH_CONFIG_FIELD, ...PUBLISH_CRITICAL_DEPENDENCY_FIELDS];
  const problems = comparedFields
    .filter((field) => !isStructurallyEqual(workingManifest[field], releaseManifest[field]))
    .map((field) => `"${field}" del ${PACKAGE_MANIFEST_FILE} del working tree no coincide con el del commit de release`);
  for (const scriptName of INSTALL_LIFECYCLE_SCRIPTS) {
    if (readScript(workingManifest, scriptName) !== readScript(releaseManifest, scriptName)) {
      problems.push(`el script "${scriptName}" del ${PACKAGE_MANIFEST_FILE} del working tree no coincide con el del commit de release`);
    }
  }
  return problems;
}

/**
 * Compares the files of the archive with the files `npm pack --dry-run` reports for the release
 * checkout: npm decides what a package contains (`files`, negations, ignore files, files it always
 * packs, bundled dependencies), so the archive must contain exactly that set.
 *
 * @param {Iterable<string>} expectedFiles - Paths npm reports, relative to the package root.
 * @param {Iterable<string>} packedFiles - Regular files of the archive, relative to `package/`.
 * @returns {string[]} Problems in Spanish, missing files first; empty when both sets are equal.
 */
export function findPackedFileSetProblems(expectedFiles, packedFiles) {
  const expected = new Set(expectedFiles);
  const packed = new Set(packedFiles);
  const missing = [...expected].filter((filePath) => !packed.has(filePath)).sort();
  const unexpected = [...packed].filter((filePath) => !expected.has(filePath)).sort();

  return [
    ...missing.map((filePath) => `falta en el tarball un archivo que npm empaqueta: ${filePath}`),
    ...unexpected.map((filePath) => `archivo que npm no empaqueta en el tarball: ${filePath}`),
  ];
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
    if (isRecord(packed)) return { packed, problem: null };
    return { packed: null, problem: `${PACKAGE_MANIFEST_FILE} del tarball no es un objeto JSON` };
  } catch (error) {
    return { packed: null, problem: `${PACKAGE_MANIFEST_FILE} del tarball no es JSON válido (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * Verifies a prepared archive against the release manifest and the file list npm reports.
 *
 * @param {ArchiveEntry[]} entries - Archive entries from {@link readTarballEntries}.
 * @param {ArchiveExpectation} expectation - Release manifest and `npm pack --dry-run` result.
 * @returns {string[]} Problems in Spanish; empty when the archive is publishable.
 */
export function findArchiveProblems(entries, { manifest, npmPack }) {
  /** @type {string[]} */
  const problems = [];
  const { packed, problem: packedManifestProblem } = readPackedManifest(entries);

  if (npmPack.name !== manifest.name || npmPack.version !== manifest.version) {
    problems.push(`npm pack --dry-run describe ${npmPack.name}@${npmPack.version} y el commit de release ${manifest.name}@${manifest.version}`);
  }

  if (packedManifestProblem) {
    problems.push(packedManifestProblem);
  } else if (packed) {
    if (packed.name !== manifest.name || packed.version !== manifest.version) {
      problems.push(`el tarball es ${packed.name}@${packed.version} y el commit de release ${manifest.name}@${manifest.version}`);
    }
    problems.push(...findManifestDrift(packed, manifest));
  }

  /** @type {string[]} */
  const packedFiles = [];
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

    packedFiles.push(normalizedName.slice(PACKED_ROOT_DIRECTORY.length));
  }

  problems.push(...findPackedFileSetProblems(npmPack.files, packedFiles));

  // npm publishes the packed manifest, so its entrypoints are the ones that count.
  const publishedManifest = packed ?? manifest;
  const entrypoints = [
    publishedManifest.exports,
    publishedManifest.main,
    publishedManifest.module,
    publishedManifest.types,
    publishedManifest.typings,
    publishedManifest.bin,
  ].flatMap(collectEntrypoints);
  const packedFileSet = new Set(packedFiles);
  for (const entrypoint of new Set(entrypoints)) {
    if (!packedFileSet.has(entrypoint)) problems.push(`falta el entrypoint público ${entrypoint} en el tarball`);
  }

  return problems;
}

/**
 * Verifies the checksum and contents of a prepared archive before publishing it.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {PreparedArtifact} artifact - Archive found by {@link findPreparedArtifact}.
 * @param {ArchiveExpectation} expectation - Release manifest and `npm pack --dry-run` result.
 * @returns {string[]} Problems in Spanish; empty when the archive can be published.
 */
export function verifyPreparedArtifact(repositoryRoot, artifact, expectation) {
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

  return findArchiveProblems(entries, expectation);
}
