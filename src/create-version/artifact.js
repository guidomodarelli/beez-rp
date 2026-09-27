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
 * Projects pack with `npm pack --ignore-scripts`, which is reproducible: the same
 * checkout always yields the same bytes. So the archive is verified by comparing
 * its SHA-512 integrity with the one `npm pack --dry-run` reports for the release
 * checkout, and the manifest must not rely on rewrites only pnpm applies when packing.
 * The archive is moved out of the package root during that dry run, so npm never
 * counts it as part of the package it describes.
 *
 * @module create-version/artifact
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ARTIFACT_HOLDING_DIRECTORY_PREFIX,
  ARTIFACT_NAME_PLACEHOLDER,
  ARTIFACT_SEGMENT_WILDCARD,
  ARTIFACT_SHA256_PLACEHOLDER,
  ARTIFACT_VERSION_PLACEHOLDER,
  CROSS_DEVICE_RENAME_ERROR_CODE,
  NPM_INTEGRITY_ALGORITHM,
  PACKAGE_SCOPE_PATTERN,
  PACKED_SCOPE_REPLACEMENT,
  PNPM_HOISTED_PUBLISH_CONFIG_KEYS,
  PNPM_PACK_REWRITTEN_SPECIFIER_PATTERN,
  PUBLISH_CONFIG_FIELD,
  PUBLISHED_DEPENDENCY_FIELDS,
  SAFE_ARTIFACT_PATH_PATTERN,
  SHA256_HEX_PATTERN_SOURCE,
} from "../constants/create-version.js";

/**
 * @typedef {{ path: string, expectedSha256: string | null }} PreparedArtifact
 * @typedef {Record<string, unknown>} PackageManifest
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
    .toSorted((left, right) => right.modifiedAt - left.modifiedAt)[0];

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
 * Computes the npm integrity of a file: the same `sha512-<base64>` string that
 * `npm pack --json` reports for the archive it writes.
 *
 * @param {string} filePath - Absolute path.
 * @returns {string} Subresource-integrity string.
 */
export function computeNpmIntegrity(filePath) {
  return `${NPM_INTEGRITY_ALGORITHM}-${createHash(NPM_INTEGRITY_ALGORITHM).update(readFileSync(filePath)).digest("base64")}`;
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
 * Lists what a manifest needs from `pnpm pack` and npm would publish as it is: `workspace:`,
 * `catalog:` or `jsr:` specifiers in published dependency maps, and `publishConfig` keys pnpm hoists onto the
 * manifest (such as `exports`, `main` or `bin`; npm only reads `publishConfig` as configuration).
 * Every other `publishConfig` key is npm configuration and is accepted.
 *
 * @param {PackageManifest} manifest - `package.json` of the release checkout.
 * @returns {string[]} Problems in Spanish; empty when npm packs the package as pnpm would.
 */
export function findPnpmPackRewrites(manifest) {
  /** @type {string[]} */
  const problems = [];

  for (const field of PUBLISHED_DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (!isRecord(dependencies)) continue;
    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === "string" && PNPM_PACK_REWRITTEN_SPECIFIER_PATTERN.test(specifier)) {
        problems.push(`${field}.${dependencyName} usa "${specifier}", que solo pnpm reescribe al empaquetar`);
      }
    }
  }

  const publishConfig = manifest[PUBLISH_CONFIG_FIELD];
  if (isRecord(publishConfig)) {
    for (const key of Object.keys(publishConfig)) {
      if (PNPM_HOISTED_PUBLISH_CONFIG_KEYS.includes(key)) {
        problems.push(`${PUBLISH_CONFIG_FIELD}.${key} no es configuración de npm (solo pnpm lo aplica al empaquetar)`);
      }
    }
  }

  return problems;
}

/**
 * Moves a file, falling back to copy and delete when the destination is on another file system
 * (`rename` fails with `EXDEV`, for example when the OS temp directory is another drive).
 *
 * @param {string} sourcePath - Absolute path of the file to move.
 * @param {string} destinationPath - Absolute destination path.
 * @returns {void}
 */
function moveFile(sourcePath, destinationPath) {
  try {
    renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (!(error instanceof Error) || /** @type {NodeJS.ErrnoException} */ (error).code !== CROSS_DEVICE_RENAME_ERROR_CODE) {
      throw error;
    }
    copyFileSync(sourcePath, destinationPath);
    unlinkSync(sourcePath);
  }
}

/**
 * Runs an operation with the prepared archive moved out of the package root, and always puts it
 * back afterwards, also when the operation fails.
 *
 * `npm pack --dry-run` describes every file npm would pack now. When the package has no `files`
 * allowlist and neither `.npmignore` nor `.gitignore` excludes the archive directory, the archive
 * written by `prepare` (for example `releases/pkg-1.0.0.tgz`) would be packed into the package it
 * is compared with, changing the integrity and rejecting a valid artifact. Hiding it reproduces the
 * package root `prepare` packed: a directory left empty is ignored by npm, as it was then.
 *
 * @template T
 * @param {string} repositoryRoot - Package root.
 * @param {string} artifactPath - Archive relative to the root, found by {@link findPreparedArtifact}.
 * @param {() => Promise<T>} operation - Runs while the archive is outside the package root.
 * @param {string} [parentDirectory] - Where the holding directory is created; defaults to the OS temp directory.
 * @returns {Promise<T>} The operation result.
 */
export async function withArtifactOutsidePackageRoot(repositoryRoot, artifactPath, operation, parentDirectory = tmpdir()) {
  const archivePath = path.join(repositoryRoot, artifactPath);
  const holdingDirectory = mkdtempSync(path.join(parentDirectory, ARTIFACT_HOLDING_DIRECTORY_PREFIX));
  const heldArchivePath = path.join(holdingDirectory, path.basename(archivePath));

  try {
    moveFile(archivePath, heldArchivePath);
  } catch (error) {
    rmSync(holdingDirectory, { recursive: true, force: true });
    throw new Error(`beez-rp create-version: no se pudo apartar ${artifactPath} para verificarlo`, { cause: error });
  }

  /** @type {{ value: T } | { error: unknown }} */
  let outcome;
  try {
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  }

  // Putting the archive back takes precedence over the operation's own result or failure.
  try {
    moveFile(heldArchivePath, archivePath);
  } catch (error) {
    // The holding directory is kept so the archive is never lost.
    throw new Error(`beez-rp create-version: no se pudo devolver ${artifactPath} a su lugar; quedó en ${heldArchivePath}`, { cause: error });
  }
  rmSync(holdingDirectory, { recursive: true, force: true });

  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

/**
 * Verifies a prepared archive before publishing it: the SHA-256 its path declares (when the
 * pattern uses `{sha256}`) and the SHA-512 integrity `npm pack --dry-run` reports for the release
 * checkout, so the archive is byte for byte what npm packs from that commit.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {PreparedArtifact} artifact - Archive found by {@link findPreparedArtifact}.
 * @param {string} expectedIntegrity - `integrity` of `npm pack --dry-run --json --ignore-scripts`.
 * @returns {string[]} Problems in Spanish; empty when the archive can be published.
 */
export function verifyPreparedArtifact(repositoryRoot, artifact, expectedIntegrity) {
  const archivePath = path.join(repositoryRoot, artifact.path);

  if (artifact.expectedSha256) {
    const actualSha256 = computeSha256(archivePath);
    if (actualSha256 !== artifact.expectedSha256) {
      return [`el SHA-256 del tarball (${actualSha256}) no coincide con el de su ruta (${artifact.expectedSha256})`];
    }
  }

  const actualIntegrity = computeNpmIntegrity(archivePath);
  if (actualIntegrity !== expectedIntegrity) {
    return [
      `el tarball no es lo que npm empaquetaría de este commit (integrity ${actualIntegrity}; npm pack --dry-run informa ${expectedIntegrity})`,
    ];
  }

  return [];
}
