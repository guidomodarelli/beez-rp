/**
 * Gathers the snapshot consumed by `plan.js`: current branch, uncommitted
 * changes, `main` compared with `origin/main`, the version and subject of
 * `HEAD`, the last release, the commits waiting to be released, the pull
 * request of a feature branch, the published versions and pending migrations.
 *
 * Every reader is read-only; the only network operations are `git fetch`,
 * `gh pr view`, `npm view` and whatever the project migrations adapter reads.
 *
 * @module create-version/state
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { readUnreleased } from "../changelog.js";
import { CHANGELOG_FILE } from "../constants/changelog.js";
import {
  MAIN_BRANCH,
  MIGRATION_STATUS,
  NPM_LOOKUP_STATUS,
  NO_PULL_REQUEST_MESSAGE_PATTERN,
  PACKAGE_MANIFEST_FILE,
  PULL_REQUEST_JSON_FIELDS,
  RELEASE_REMOTE,
  REMOTE_MAIN_REF,
  VERSION_FIELD_CHANGE_PATTERN,
} from "../constants/create-version.js";
import { lookupPublishedVersions, resolvePublishRegistry } from "./npm.js";
import { createGitReader, listCommits, readPackageVersionAt, runCaptured } from "./process.js";

/**
 * @typedef {import("./process.js").GitReader} GitReader
 * @typedef {import("./plan.js").ReleaseState} ReleaseState
 * @typedef {import("./plan.js").PullRequestSnapshot} PullRequestSnapshot
 * @typedef {import("./config.js").MigrationCheck} MigrationCheck
 * @typedef {ReleaseState & { packageName: string, releasedVersion: string | null, lastRelease: { sha: string, version: string | null } | null }} ReleaseSnapshot
 */

/**
 * Finds the last release on a revision: the newest commit that changed the
 * top-level `version` of `package.json`. It covers `X.Y.Z` release commits,
 * other release subjects and projects that bumped versions by hand.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} revision - Revision such as `origin/main`.
 * @returns {Promise<{ sha: string, version: string | null } | null>} Last release, or `null` without history.
 */
export async function findLastRelease(reader, revision) {
  const sha = await reader.tryGit(["log", "-1", "--format=%H", `-G${VERSION_FIELD_CHANGE_PATTERN}`, revision, "--", PACKAGE_MANIFEST_FILE]);

  return sha ? { sha, version: await readPackageVersionAt(reader, sha) } : null;
}

/**
 * Looks up the pull request of a branch with the GitHub CLI.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} branchName - Head branch.
 * @returns {Promise<{ pullRequest: PullRequestSnapshot | null, githubError: string | null }>} Pull request or error.
 */
async function lookupPullRequest(repositoryRoot, branchName) {
  const result = await runCaptured("gh", ["pr", "view", branchName, "--json", PULL_REQUEST_JSON_FIELDS], { cwd: repositoryRoot });

  if (result.status === 0) {
    try {
      return { pullRequest: JSON.parse(result.stdout), githubError: null };
    } catch (error) {
      return { pullRequest: null, githubError: `respuesta inválida de gh (${error instanceof Error ? error.message : String(error)})` };
    }
  }

  if (NO_PULL_REQUEST_MESSAGE_PATTERN.test(result.stderr)) {
    return { pullRequest: null, githubError: null };
  }

  return { pullRequest: null, githubError: result.stderr.split("\n")[0] || "gh no respondió" };
}

/**
 * Reads the feature branch snapshot (upstream, unpushed and unmerged commits).
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} branchName - Current branch.
 * @returns {Promise<import("./plan.js").FeatureBranchSnapshot>} Snapshot.
 */
async function readFeatureBranch(reader, branchName) {
  const headSha = await reader.git(["rev-parse", "HEAD"]);
  const aheadOfMainCount = Number((await reader.tryGit(["rev-list", "--count", `${REMOTE_MAIN_REF}..HEAD`])) ?? 0);
  const upstreamUnpushed = await reader.tryGit(["rev-list", "--count", "@{upstream}..HEAD"]);

  return {
    name: branchName,
    headSha,
    hasUpstream: upstreamUnpushed !== null,
    unpushedCount: upstreamUnpushed === null ? aheadOfMainCount : Number(upstreamUnpushed),
    aheadOfMainCount,
  };
}

/**
 * Reads the `[Unreleased]` block of the working-tree CHANGELOG.md.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {{ exists: boolean, entryCount: number, unknownSections: string[] }} Unreleased state.
 */
export function readChangelogState(repositoryRoot) {
  const changelogPath = path.join(repositoryRoot, CHANGELOG_FILE);

  if (!existsSync(changelogPath)) {
    return { exists: false, entryCount: 0, unknownSections: [] };
  }

  const { exists, entryCount, unknownSections } = readUnreleased(readFileSync(changelogPath, "utf8"));
  return { exists, entryCount, unknownSections };
}

/**
 * Runs the project migrations check, turning any failure into an `unknown` result.
 *
 * @param {(() => Promise<MigrationCheck> | MigrationCheck) | null} checkMigrations - Adapter bound to its hook context.
 * @returns {Promise<MigrationCheck | null>} Migration state, or `null` for projects without migrations.
 */
async function readMigrations(checkMigrations) {
  if (!checkMigrations) {
    return null;
  }

  try {
    return await checkMigrations();
  } catch (error) {
    return { status: MIGRATION_STATUS.unknown, pending: [], target: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Lists the published versions on the registry the working-tree manifest publishes to, so the
 * diagnosis sees the same versions `npm publish` would conflict with.
 *
 * @param {typeof lookupPublishedVersions} lookupNpm - npm lookup adapter.
 * @param {Record<string, unknown>} manifest - Working-tree `package.json`.
 * @param {string} repositoryRoot - Repository root.
 * @returns {Promise<import("./npm.js").NpmLookup>} Published versions, or a failed lookup when the registry is invalid.
 */
async function lookupNpmOnPublishRegistry(lookupNpm, manifest, repositoryRoot) {
  /** @type {string} */
  let registryUrl;
  try {
    registryUrl = resolvePublishRegistry(manifest);
  } catch (error) {
    return { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: error instanceof Error ? error.message : String(error) };
  }

  return lookupNpm(String(manifest.name), repositoryRoot, registryUrl);
}

/**
 * Gathers the complete release snapshot.
 *
 * @param {{
 *   repositoryRoot: string,
 *   trackNpm?: boolean,
 *   checkMigrations?: (() => Promise<MigrationCheck> | MigrationCheck) | null,
 *   onProgress?: (label: string) => void,
 *   lookupNpm?: typeof lookupPublishedVersions,
 *   lookupPullRequestFor?: typeof lookupPullRequest,
 * }} options - Repository, adapters and progress callback.
 * @returns {Promise<ReleaseSnapshot>} Snapshot accepted by `buildReleasePlan`.
 */
export async function collectReleaseState({
  repositoryRoot,
  trackNpm = false,
  checkMigrations = null,
  onProgress = () => {},
  lookupNpm = lookupPublishedVersions,
  lookupPullRequestFor = lookupPullRequest,
}) {
  const reader = createGitReader(repositoryRoot);

  onProgress("Sincronizando con origin (fetch)");
  await reader.git(["fetch", RELEASE_REMOTE, "--prune", "--tags", "--quiet"]);

  onProgress("Leyendo el estado de Git");
  const currentBranch = await reader.tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const statusOutput = await reader.git(["status", "--porcelain"]);
  const workingTreeChanges = statusOutput.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const localMainExists = (await reader.tryGit(["rev-parse", "--verify", "--quiet", MAIN_BRANCH])) !== null;
  const remoteMainExists = (await reader.tryGit(["rev-parse", "--verify", "--quiet", REMOTE_MAIN_REF])) !== null;
  const aheadCommits = localMainExists && remoteMainExists ? await listCommits(reader, `${REMOTE_MAIN_REF}..${MAIN_BRANCH}`) : [];
  const behindCount =
    localMainExists && remoteMainExists ? Number((await reader.tryGit(["rev-list", "--count", `${MAIN_BRANCH}..${REMOTE_MAIN_REF}`])) ?? 0) : 0;
  const headVersion = await readPackageVersionAt(reader, "HEAD");
  const headSubject = await reader.tryGit(["log", "-1", "--format=%s", "HEAD"]);
  const releasedVersion = remoteMainExists ? await readPackageVersionAt(reader, REMOTE_MAIN_REF) : null;
  const lastRelease = remoteMainExists ? await findLastRelease(reader, REMOTE_MAIN_REF) : null;
  const unreleasedCommits = remoteMainExists ? await listCommits(reader, lastRelease ? `${lastRelease.sha}..${REMOTE_MAIN_REF}` : REMOTE_MAIN_REF) : [];

  let branch = null;
  let pullRequest = null;
  let githubError = null;

  if (currentBranch && currentBranch !== MAIN_BRANCH) {
    onProgress(`Revisando la rama ${currentBranch} y su PR`);
    branch = await readFeatureBranch(reader, currentBranch);
    ({ pullRequest, githubError } = await lookupPullRequestFor(repositoryRoot, currentBranch));
  }

  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, PACKAGE_MANIFEST_FILE), "utf8"));
  let npm = null;

  if (trackNpm) {
    onProgress("Consultando npm");
    npm = await lookupNpmOnPublishRegistry(lookupNpm, manifest, repositoryRoot);
  }

  if (checkMigrations) {
    onProgress("Consultando migraciones pendientes");
  }
  const migrations = await readMigrations(checkMigrations);

  return {
    packageName: manifest.name,
    currentBranch,
    workingTreeChanges,
    branch,
    pullRequest,
    githubError,
    main: { aheadCommits, behindCount },
    headVersion,
    headSubject,
    releasedVersion,
    lastRelease,
    unreleasedCommits,
    npm,
    migrations,
    changelog: readChangelogState(repositoryRoot),
  };
}
