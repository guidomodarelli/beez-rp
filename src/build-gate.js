/**
 * Decides whether Vercel builds a commit (`vercel.json` → `ignoreCommand`).
 *
 * Only a stable `X.Y.Z` version that is the next patch, minor or major of the
 * previous commit's version ships, the same rule `create-version` applies. An
 * unchanged, lower or skipped version (`1.0.0` → `3.0.0`) and any prerelease
 * or build-metadata version skip the build. When the previous version cannot
 * be read there is nothing to compare, so a stable version builds.
 *
 * A release delegated to CI is skipped only on the commit that changes
 * `.beez-rp/release.json` against its first parent, the same commit scoping the
 * generated `.beez-rp/vercel-ignore-build.mjs` applies (that template stays
 * dependency-free, so it inlines the check). Later commits keep the metadata
 * untouched and fall through to the version rule; without a readable parent
 * (shallow clone) the release commit cannot be told apart, so the version rule
 * decides as well.
 *
 * @module build-gate
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CURRENT_REVISION, GIT_DIFF_CHANGED_STATUS, PACKAGE_MANIFEST_FILE, PREVIOUS_REVISION } from "./constants/build-gate.js";
import { isStableReleaseVersion, listAllowedVersionsAfter } from "./versions.js";
import { CI_RELEASE_METADATA_FILE, RELEASE_EXECUTION } from "./constants/ci-release.js";

/**
 * @typedef {{ shouldBuild: boolean, reason: string }} BuildDecision
 */

/**
 * Decides whether a commit is built.
 *
 * @param {string | null} previousVersion - Version of the previous commit, or `null` when unreadable.
 * @param {string | null} currentVersion - Version of the commit being deployed, or `null` when unreadable.
 * @returns {BuildDecision} Decision and a log line.
 */
export function decideBuild(previousVersion, currentVersion) {
  if (currentVersion === null) {
    return { shouldBuild: false, reason: "Current package version could not be read. Skipping build." };
  }

  if (!isStableReleaseVersion(currentVersion)) {
    return { shouldBuild: false, reason: `Version ${currentVersion} is not a stable X.Y.Z release. Skipping build.` };
  }

  const allowedVersions = previousVersion === null ? null : listAllowedVersionsAfter(previousVersion);

  if (allowedVersions === null) {
    return { shouldBuild: true, reason: `Previous package version could not be compared. Building stable ${currentVersion}.` };
  }

  if (currentVersion === previousVersion) {
    return { shouldBuild: false, reason: "Version did not change. Skipping build." };
  }

  if (!allowedVersions.includes(currentVersion)) {
    return {
      shouldBuild: false,
      reason: `Version ${previousVersion} -> ${currentVersion} is not the next patch, minor or major (${allowedVersions.join(", ")}). Skipping build.`,
    };
  }

  return { shouldBuild: true, reason: `Version changed: ${previousVersion} -> ${currentVersion}. Building.` };
}

/**
 * Reads the `version` field of a `package.json` text.
 *
 * @param {() => string} readManifest - Returns the manifest contents.
 * @returns {string | null} Version, or `null` when unreadable.
 */
function readVersion(readManifest) {
  try {
    const version = JSON.parse(readManifest()).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/**
 * Tells whether the deployed commit is the one that wrote the CI release
 * metadata, comparing it against its first parent. A missing parent (first
 * commit or shallow clone) or any Git failure counts as "not the release
 * commit", so the caller falls back to the version rule.
 *
 * @param {string} repositoryRoot - Checkout whose `HEAD` is being deployed.
 * @returns {boolean} Whether `HEAD` changed the release metadata.
 */
function isReleaseMetadataCommit(repositoryRoot) {
  const metadataDiff = spawnSync("git", ["diff", "--quiet", PREVIOUS_REVISION, CURRENT_REVISION, "--", CI_RELEASE_METADATA_FILE], {
    cwd: repositoryRoot,
    stdio: "ignore",
    windowsHide: true,
  });
  return metadataDiff.status === GIT_DIFF_CHANGED_STATUS;
}

/**
 * Reads the previous and the current `package.json` versions of a Git
 * checkout and decides whether it is built.
 *
 * @param {string} repositoryRoot - Checkout whose `HEAD` is being deployed.
 * @returns {BuildDecision} Decision and a log line.
 */
export function decideBuildForCheckout(repositoryRoot) {
  const previousVersion = readVersion(() =>
    execFileSync("git", ["show", `${PREVIOUS_REVISION}:${PACKAGE_MANIFEST_FILE}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  );
  const currentVersion = readVersion(() => readFileSync(path.join(repositoryRoot, PACKAGE_MANIFEST_FILE), "utf8"));
  const metadataPath = path.join(repositoryRoot, CI_RELEASE_METADATA_FILE);
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      const isDelegatedRelease = metadata.version === currentVersion && metadata.execution === RELEASE_EXECUTION.ci;
      if (isDelegatedRelease && isReleaseMetadataCommit(repositoryRoot)) return { shouldBuild: false, reason: `Release ${currentVersion} is delegated to CI. Production deployment waits for its checks. Skipping build.` };
    } catch {
      return { shouldBuild: false, reason: "CI release metadata could not be read. Skipping build." };
    }
  }

  return decideBuild(previousVersion, currentVersion);
}
