/**
 * Subject of the single release commit of a monorepo release:
 * `release: @scope/a@1.2.0, @scope/b@0.3.1`. It records which packages the
 * commit released, so a run can resume a local release commit that never
 * reached `origin`.
 *
 * @module monorepo/release-commit
 */

import { MONOREPO_RELEASE_ENTRY_PATTERN, MONOREPO_RELEASE_ENTRY_SEPARATOR, MONOREPO_RELEASE_SUBJECT_PREFIX } from "../constants/monorepo.js";

/**
 * @typedef {{ name: string, version: string }} PackageRelease
 */

/**
 * Builds the subject of a release commit.
 *
 * @param {readonly PackageRelease[]} releases - Released packages, in publication order.
 * @returns {string} Subject.
 */
export function buildMonorepoReleaseSubject(releases) {
  return `${MONOREPO_RELEASE_SUBJECT_PREFIX}${releases.map(({ name, version }) => `${name}@${version}`).join(MONOREPO_RELEASE_ENTRY_SEPARATOR)}`;
}

/**
 * Reads the packages a release commit subject lists.
 *
 * @param {string | null | undefined} subject - Commit subject.
 * @returns {PackageRelease[] | null} Released packages, or `null` when the subject is not a release commit.
 */
export function parseMonorepoReleaseSubject(subject) {
  const trimmed = subject?.trim() ?? "";
  if (!trimmed.startsWith(MONOREPO_RELEASE_SUBJECT_PREFIX)) {
    return null;
  }

  const entries = trimmed.slice(MONOREPO_RELEASE_SUBJECT_PREFIX.length).split(MONOREPO_RELEASE_ENTRY_SEPARATOR);
  const releases = entries.map((entry) => MONOREPO_RELEASE_ENTRY_PATTERN.exec(entry.trim())?.groups);

  if (releases.length === 0 || releases.some((groups) => !groups)) {
    return null;
  }

  return releases.map((groups) => ({ name: /** @type {Record<string, string>} */ (groups).name, version: /** @type {Record<string, string>} */ (groups).version }));
}
