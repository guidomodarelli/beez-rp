/**
 * Release version rules: only stable `X.Y.Z` versions exist, and after a
 * version only its next patch, minor or major is allowed (from `1.2.3`:
 * `1.2.4`, `1.3.0` or `2.0.0`). No version can be skipped, repeated or
 * lowered, and prereleases or build metadata are never released.
 *
 * @module versions
 */

import {
  BREAKING_CHANGE_FOOTER_PATTERN,
  CONVENTIONAL_HEADER_PATTERN,
  FEATURE_COMMIT_TYPE,
  LEGACY_FEATURE_SUBJECT_PATTERN,
  RELEASE_TAG_PREFIX,
  RELEASE_TYPE,
  RELEASE_TYPE_ORDER,
  RELEASE_VERSION_PATTERN,
  SEMVER_PATTERN,
} from "./constants/versions.js";

/**
 * @typedef {"patch" | "minor" | "major"} ReleaseType
 * @typedef {{ releaseType: ReleaseType, version: string }} NextVersion
 */

/**
 * Returns whether a value is a stable `X.Y.Z` release version.
 *
 * @param {unknown} version - Candidate version.
 * @returns {boolean} `true` only for plain `X.Y.Z` without prerelease, metadata, prefix or leading zeros.
 */
export function isStableReleaseVersion(version) {
  return typeof version === "string" && RELEASE_VERSION_PATTERN.test(version);
}

/**
 * Parses a stable `X.Y.Z` version.
 *
 * @param {string} version - Version such as `0.93.0`.
 * @returns {[number, number, number]} Major, minor and patch numbers.
 * @throws {Error} When the version is not a stable release version.
 */
export function parseReleaseVersion(version) {
  const match = RELEASE_VERSION_PATTERN.exec(String(version));

  if (!match) {
    throw new Error(`beez-rp:parseReleaseVersion expected X.Y.Z, received "${version}"`);
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Returns the next version for a semver release type.
 *
 * @param {string} version - Current `X.Y.Z` version.
 * @param {ReleaseType} releaseType - One of {@link RELEASE_TYPE}.
 * @returns {string} Next `X.Y.Z` version.
 * @throws {Error} When the version is not stable or the release type is unknown.
 */
export function bumpReleaseVersion(version, releaseType) {
  const [major, minor, patch] = parseReleaseVersion(version);

  switch (releaseType) {
    case RELEASE_TYPE.major:
      return `${major + 1}.0.0`;
    case RELEASE_TYPE.minor:
      return `${major}.${minor + 1}.0`;
    case RELEASE_TYPE.patch:
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`beez-rp:bumpReleaseVersion unknown release type "${releaseType}"`);
  }
}

/**
 * Lists the only versions allowed after the current one: the next patch,
 * minor and major. Anything else would skip versions or go backwards.
 *
 * @param {string} currentVersion - Current `X.Y.Z` version.
 * @returns {NextVersion[]} Allowed next versions, patch first.
 */
export function listNextVersions(currentVersion) {
  return RELEASE_TYPE_ORDER.map((releaseType) => ({
    releaseType,
    version: bumpReleaseVersion(currentVersion, releaseType),
  }));
}

/**
 * Lists the versions allowed after any previous semver version. A previous
 * prerelease is also followed by its own stable release (`1.0.0-beta.1` →
 * `1.0.0`).
 *
 * @param {string} previousVersion - Previous version, stable or prerelease.
 * @returns {string[] | null} Allowed versions, or `null` when the previous version is not semver.
 */
export function listAllowedVersionsAfter(previousVersion) {
  const match = SEMVER_PATTERN.exec(String(previousVersion));

  if (!match) {
    return null;
  }

  const [, core, prerelease] = match;
  const nextVersions = listNextVersions(core).map((candidate) => candidate.version);

  return prerelease ? [core, ...nextVersions] : nextVersions;
}

/**
 * Resolves the version requested through `--bump` or `--set-version`.
 *
 * @param {string} currentVersion - Current `X.Y.Z` version.
 * @param {{ bump: ReleaseType | null, setVersion: string | null }} request - Parsed CLI options.
 * @returns {NextVersion | null} Requested version, or `null` to ask interactively.
 * @throws {Error} With a Spanish message when the request is invalid.
 */
export function resolveRequestedVersion(currentVersion, { bump, setVersion }) {
  const nextVersions = listNextVersions(currentVersion);

  if (bump) {
    return nextVersions.find((candidate) => candidate.releaseType === bump) ?? null;
  }

  if (setVersion === null || setVersion === undefined) {
    return null;
  }

  if (!isStableReleaseVersion(setVersion)) {
    throw new Error(`--set-version espera el formato X.Y.Z y recibió "${setVersion}".`);
  }

  const match = nextVersions.find((candidate) => candidate.version === setVersion);

  if (!match) {
    const allowed = nextVersions.map((candidate) => candidate.version).join(", ");
    throw new Error(
      `--set-version ${setVersion} no es válida después de ${currentVersion}: tiene que ser mayor y no saltear versiones. Opciones: ${allowed}.`
    );
  }

  return match;
}

/**
 * Builds the Git tag name of a release version.
 *
 * @param {string} version - `X.Y.Z` version.
 * @returns {string} Tag such as `v0.94.0`.
 */
export function toReleaseTag(version) {
  return `${RELEASE_TAG_PREFIX}${version}`;
}

/**
 * Returns whether a commit subject is a release bump commit (`0.93.0`).
 *
 * @param {string} subject - Commit subject.
 * @returns {boolean} `true` for version-only subjects.
 */
export function isReleaseCommitSubject(subject) {
  return isStableReleaseVersion(subject.trim());
}

/**
 * Suggests the semver release type for the commits that will ship.
 *
 * Breaking changes suggest `major`; features (conventional `feat` or legacy
 * imperative subjects such as "Add ...") suggest `minor`; a set made only of
 * conventional maintenance commits (`fix`, `chore`, `docs`, ...) suggests
 * `patch`. Unknown legacy subjects suggest `minor`.
 *
 * @param {{ subject: string, body?: string }[]} commits - Commits since the last release.
 * @returns {{ releaseType: ReleaseType, reason: string }} Suggested type and a Spanish explanation.
 */
export function suggestReleaseType(commits) {
  const shippedCommits = commits.filter((commit) => !isReleaseCommitSubject(commit.subject));
  let hasFeature = false;
  let hasUnknownSubject = false;

  for (const commit of shippedCommits) {
    const header = CONVENTIONAL_HEADER_PATTERN.exec(commit.subject);

    if (header?.groups?.breaking || BREAKING_CHANGE_FOOTER_PATTERN.test(commit.body ?? "")) {
      return { releaseType: RELEASE_TYPE.major, reason: "hay cambios incompatibles (breaking change)" };
    }

    if (header?.groups) {
      hasFeature ||= header.groups.type.toLowerCase() === FEATURE_COMMIT_TYPE;
      continue;
    }

    if (LEGACY_FEATURE_SUBJECT_PATTERN.test(commit.subject)) {
      hasFeature = true;
    } else {
      hasUnknownSubject = true;
    }
  }

  if (hasFeature) {
    return { releaseType: RELEASE_TYPE.minor, reason: "hay funcionalidades nuevas" };
  }

  if (hasUnknownSubject || shippedCommits.length === 0) {
    return { releaseType: RELEASE_TYPE.minor, reason: "criterio habitual del repositorio" };
  }

  return { releaseType: RELEASE_TYPE.patch, reason: "solo hay arreglos y mantenimiento" };
}
