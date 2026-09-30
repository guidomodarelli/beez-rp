/**
 * Gathers the snapshot consumed by `plan.js`: current branch, uncommitted
 * changes, `main` compared with `origin/main`, the version and subject of
 * `HEAD`, the commit of a detached release tag on `origin`, the last release,
 * the commits waiting to be released, the pull request of a feature branch,
 * the published versions, the npm credentials (when the plan would publish to
 * npm) and pending migrations.
 *
 * Every reader is read-only; the only network operations are `git fetch`,
 * `git ls-remote`, `gh pr view`, `npm view`, `npm whoami`, `npm owner ls` and
 * whatever the project migrations adapter reads.
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
  NPM_AUTH_STATUS,
  NPM_LOOKUP_STATUS,
  NPM_NOT_FOUND_CODE,
  NO_PULL_REQUEST_MESSAGE_PATTERN,
  PACKAGE_MANIFEST_FILE,
  PULL_REQUEST_JSON_FIELDS,
  RELEASE_REMOTE,
  REMOTE_MAIN_REF,
  VERSION_FIELD_CHANGE_PATTERN,
} from "../constants/create-version.js";
import { toReleaseTag } from "../versions.js";
import { checkNpmPublishAccess, lookupPublishedVersions, resolvePublishRegistry } from "./npm.js";
import { createGitReader, listCommits, readPackageVersionAt, runCaptured } from "./process.js";

/**
 * @typedef {import("./process.js").GitReader} GitReader
 * @typedef {import("./plan.js").ReleaseState} ReleaseState
 * @typedef {import("./plan.js").PullRequestSnapshot} PullRequestSnapshot
 * @typedef {import("./config.js").MigrationCheck} MigrationCheck
 * @typedef {import("./plan.js").LastReleaseSnapshot} LastReleaseSnapshot
 * @typedef {ReleaseState & { packageName: string, releasedVersion: string | null, lastRelease: LastReleaseSnapshot | null }} ReleaseSnapshot
 */

/**
 * Returns the release tag of a version when it points exactly at a commit.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string | null} version - Version whose `vX.Y.Z` tag is looked up.
 * @param {string} sha - Commit the tag must point at.
 * @returns {Promise<string | null>} Tag name, or `null` when it is missing or points elsewhere.
 */
async function findReleaseTagAt(reader, version, sha) {
  if (!version) {
    return null;
  }

  const tag = toReleaseTag(version);
  const taggedSha = await reader.tryGit(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  return taggedSha === sha ? tag : null;
}

/**
 * Reads the commit a release tag points at on `origin`, so a detached publication can prove that
 * its commit and tag already reached the remote. An annotated tag is resolved through its peeled
 * `^{}` entry; a lightweight tag points at the commit directly.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} tag - Release tag such as `v1.2.0`.
 * @returns {Promise<string | null>} Commit of the tag on `origin`, or `null` when it is missing or
 *   `origin` cannot be read.
 */
async function readRemoteReleaseTagCommit(reader, tag) {
  const tagRef = `refs/tags/${tag}`;
  const peeledRef = `${tagRef}^{}`;
  const output = await reader.tryGit(["ls-remote", RELEASE_REMOTE, tagRef, peeledRef]);
  const shaByRef = new Map(
    (output ?? "")
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter((fields) => fields.length === 2)
      .map(([sha, ref]) => [ref, sha])
  );
  return shaByRef.get(peeledRef) ?? shaByRef.get(tagRef) ?? null;
}

/**
 * Finds the last release on a revision: the newest commit that changed the
 * top-level `version` of `package.json`. It covers `X.Y.Z` release commits,
 * other release subjects and projects that bumped versions by hand.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} revision - Revision such as `origin/main`.
 * @returns {Promise<LastReleaseSnapshot | null>} Last release with its subject and whether its
 *   `vX.Y.Z` tag points at it, or `null` without history.
 */
export async function findLastRelease(reader, revision) {
  const sha = await reader.tryGit(["log", "-1", "--format=%H", `-G${VERSION_FIELD_CHANGE_PATTERN}`, revision, "--", PACKAGE_MANIFEST_FILE]);

  if (!sha) {
    return null;
  }

  const version = await readPackageVersionAt(reader, sha);
  const subject = await reader.tryGit(["log", "-1", "--format=%s", sha]);
  return { sha, version, subject, tagged: (await findReleaseTagAt(reader, version, sha)) !== null };
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
 * @returns {Promise<import("./npm.js").NpmLookup>} Published versions, or a failed lookup when the registry is invalid
 *   or npm cannot report it.
 */
async function lookupNpmOnPublishRegistry(lookupNpm, manifest, repositoryRoot) {
  const registry = await resolveRegistrySafely(manifest, repositoryRoot);

  return registry.registryUrl === null
    ? { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: registry.reason }
    : lookupNpm(String(manifest.name), repositoryRoot, registry.registryUrl);
}

/**
 * Resolves the publish registry without throwing.
 *
 * @param {Record<string, unknown>} manifest - Working-tree `package.json`.
 * @param {string} repositoryRoot - Repository root.
 * @returns {Promise<{ registryUrl: string | null, reason: string | null }>} Registry, or why it cannot be resolved.
 */
async function resolveRegistrySafely(manifest, repositoryRoot) {
  try {
    return { registryUrl: await resolvePublishRegistry(manifest, repositoryRoot), reason: null };
  } catch (error) {
    return { registryUrl: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Checks the npm credentials on the registry the working-tree manifest publishes to.
 *
 * @param {typeof checkNpmPublishAccess} checkAccess - npm credential check adapter.
 * @param {Record<string, unknown>} manifest - Working-tree `package.json`.
 * @param {string} repositoryRoot - Repository root.
 * @returns {Promise<import("./npm.js").NpmAuthCheck>} Check result; an `unknown` one when the registry cannot be resolved.
 */
async function checkNpmAuthOnPublishRegistry(checkAccess, manifest, repositoryRoot) {
  const registry = await resolveRegistrySafely(manifest, repositoryRoot);

  return registry.registryUrl === null
    ? { status: NPM_AUTH_STATUS.unknown, user: null, source: null, registryUrl: "", packageName: String(manifest.name), owners: [], firstPublication: false, reason: registry.reason }
    : checkAccess(String(manifest.name), repositoryRoot, registry.registryUrl);
}

/**
 * Confirms a first publication (`npm owner ls` answered E404) against the versions `npm view`
 * listed with the same token. Registries hide a private package from users without access, so an
 * owner E404 only means "new package" when `npm view` does not list versions either: when it does,
 * the package exists and the token cannot manage it, which blocks like a user that is not an owner.
 *
 * @param {import("./npm.js").NpmAuthCheck} npmAuth - Credential check.
 * @param {import("./npm.js").NpmLookup | null} npm - Published versions, or `null` when npm is not tracked.
 * @returns {import("./npm.js").NpmAuthCheck} The same check, or a `notOwner` one when the package already has versions.
 */
function confirmFirstPublication(npmAuth, npm) {
  const publishedCount = npm?.publishedVersions.length ?? 0;

  if (!npmAuth.firstPublication || publishedCount === 0) {
    return npmAuth;
  }

  return {
    ...npmAuth,
    status: NPM_AUTH_STATUS.notOwner,
    firstPublication: false,
    reason: `npm view lista versiones publicadas de ${npmAuth.packageName} (${publishedCount}), pero npm owner ls respondió ${NPM_NOT_FOUND_CODE}: el token no tiene acceso al paquete.`,
  };
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
 *   checkNpmAuth?: ((snapshot: ReleaseSnapshot) => boolean) | null,
 *   checkNpmAccess?: typeof checkNpmPublishAccess,
 *   lookupPullRequestFor?: typeof lookupPullRequest,
 * }} options - Repository, adapters and progress callback. `checkNpmAuth` receives the snapshot
 *   without credentials and decides whether the npm credentials are checked (when the plan would publish to npm).
 * @returns {Promise<ReleaseSnapshot>} Snapshot accepted by `buildReleasePlan`.
 */
export async function collectReleaseState({
  repositoryRoot,
  trackNpm = false,
  checkMigrations = null,
  onProgress = () => {},
  lookupNpm = lookupPublishedVersions,
  checkNpmAuth = null,
  checkNpmAccess = checkNpmPublishAccess,
  lookupPullRequestFor = lookupPullRequest,
}) {
  const reader = createGitReader(repositoryRoot);

  onProgress("Sincronizando con origin (fetch)");
  await reader.git(["fetch", RELEASE_REMOTE, "--prune", "--tags", "--quiet"]);

  onProgress("Leyendo el estado de Git");
  const currentBranch = await reader.tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  // Every untracked file, not only its directory, so the plan sees the extension of each one.
  const statusOutput = await reader.git(["status", "--porcelain", "--untracked-files=all"]);
  const workingTreeChanges = statusOutput.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const localMainExists = (await reader.tryGit(["rev-parse", "--verify", "--quiet", MAIN_BRANCH])) !== null;
  const remoteMainExists = (await reader.tryGit(["rev-parse", "--verify", "--quiet", REMOTE_MAIN_REF])) !== null;
  const aheadCommits = localMainExists && remoteMainExists ? await listCommits(reader, `${REMOTE_MAIN_REF}..${MAIN_BRANCH}`) : [];
  const behindCount =
    localMainExists && remoteMainExists ? Number((await reader.tryGit(["rev-list", "--count", `${MAIN_BRANCH}..${REMOTE_MAIN_REF}`])) ?? 0) : 0;
  const headVersion = await readPackageVersionAt(reader, "HEAD");
  const headSubject = await reader.tryGit(["log", "-1", "--format=%s", "HEAD"]);
  const headSha = await reader.tryGit(["rev-parse", "HEAD"]);
  const headReleaseTag = headSha ? await findReleaseTagAt(reader, headVersion, headSha) : null;
  // Only a detached publication from a tag needs to prove that the tag is on origin.
  const remoteReleaseTagSha = !currentBranch && headReleaseTag ? await readRemoteReleaseTagCommit(reader, headReleaseTag) : null;
  // A tag missing from origin can still be pushed from the detached HEAD when origin/main already has its commit.
  const headOnRemoteMain =
    !currentBranch && headReleaseTag && !remoteReleaseTagSha && remoteMainExists
      ? (await reader.tryGit(["merge-base", "--is-ancestor", "HEAD", REMOTE_MAIN_REF])) !== null
      : false;
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

  /** @type {ReleaseSnapshot} */
  const snapshot = {
    packageName: manifest.name,
    currentBranch,
    workingTreeChanges,
    branch,
    pullRequest,
    githubError,
    main: { aheadCommits, behindCount },
    headVersion,
    headSubject,
    headSha,
    headReleaseTag,
    remoteReleaseTagSha,
    headOnRemoteMain,
    releasedVersion,
    lastRelease,
    unreleasedCommits,
    npm,
    npmAuth: null,
    migrations,
    changelog: readChangelogState(repositoryRoot),
  };

  if (checkNpmAuth?.(snapshot)) {
    onProgress("Verificando las credenciales de npm");
    snapshot.npmAuth = confirmFirstPublication(await checkNpmAuthOnPublishRegistry(checkNpmAccess, manifest, repositoryRoot), npm);
  }

  return snapshot;
}
