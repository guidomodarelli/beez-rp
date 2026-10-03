/**
 * Snapshot of a monorepo release: the repository part shared with the
 * single-package mode (branch, working tree, `main` versus `origin/main`,
 * pull request) plus, for every released package, its last release, the
 * commits waiting to be released under its paths, its changelog and its
 * published versions.
 *
 * Every reader is read-only; the network operations are `git fetch`,
 * `git ls-remote`, `gh pr view` and the npm lookups.
 *
 * @module monorepo/state
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { RELEASE_REMOTE, REMOTE_MAIN_REF } from "../constants/create-version.js";
import { UNRELEASED_PLACEHOLDER_VERSION } from "../constants/versions.js";
import { checkNpmPublishAccess, lookupPublishedVersions } from "../create-version/npm.js";
import { readChangelogUpdateState } from "../create-version/changelog.js";
import { checkRegistryAccess, lookupRegistryVersions } from "../create-version/registry.js";
import { createGitReader, findVersionChangeCommit, listCommits, readPackageVersionAt } from "../create-version/process.js";
import {
  checkNpmAuthOnPublishRegistry,
  confirmFirstPublication,
  lookupNpmOnPublishRegistry,
  lookupPullRequest,
  readChangelogState,
  readMigrations,
  readRepositorySnapshot,
} from "../create-version/state.js";
import { parseMonorepoReleaseSubject } from "./release-commit.js";
import { formatPackageTag } from "./workspaces.js";

/**
 * @typedef {import("./workspaces.js").ReleaseUnit} ReleaseUnit
 * @typedef {import("../create-version/process.js").GitReader} GitReader
 * @typedef {import("../create-version/process.js").CommitRecord} CommitRecord
 * @typedef {import("../create-version/npm.js").NpmLookup} NpmLookup
 * @typedef {import("../create-version/npm.js").NpmAuthCheck} NpmAuthCheck
 * @typedef {import("../create-version/config.js").MigrationCheck} MigrationCheck
 * @typedef {{
 *   sha: string,
 *   version: string | null,
 *   subject: string | null,
 *   tag: string | null,
 *   tagged: boolean,
 *   tagOnOrigin: boolean,
 * }} PackageLastRelease
 *   Newest commit of `origin/main` that changed the package `version`; `tagged` when its tag points
 *   at that commit locally, `tagOnOrigin` when `origin` has the tag.
 * @typedef {{
 *   unit: ReleaseUnit,
 *   manifest: Record<string, unknown>,
 *   releasedVersion: string | null,
 *   lastRelease: PackageLastRelease | null,
 *   unreleasedCommits: CommitRecord[],
 *   changelog: { exists: boolean, entryCount: number, unknownSections: string[], updated: boolean, reason: string | null },
 *   npm: NpmLookup | null,
 *   npmAuth: NpmAuthCheck | null,
 * }} PackageSnapshot
 * @typedef {import("../create-version/state.js").RepositorySnapshot & {
 *   headSha: string | null,
 *   headSubject: string | null,
 *   packages: PackageSnapshot[],
 *   migrations: MigrationCheck | null,
 * }} MonorepoSnapshot
 */

/**
 * Lists the tags `origin` has, so pending publications only resume releases whose tag reached it.
 *
 * @param {GitReader} reader - Git reader.
 * @returns {Promise<Set<string>>} Tag names.
 * @throws {Error} When `origin` cannot be read: an empty set would hide tags that already reached it.
 */
async function readRemoteTags(reader) {
  const output = await reader.tryGit(["ls-remote", "--tags", "--refs", RELEASE_REMOTE]);
  if (output === null) {
    throw new Error(
      `No se pudieron listar los tags de ${RELEASE_REMOTE} (git ls-remote --tags ${RELEASE_REMOTE} falló): sin ellos no se sabe qué releases llegaron a ${RELEASE_REMOTE}. Revisá la conexión y el acceso a ${RELEASE_REMOTE} y volvé a correr el comando.`
    );
  }
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim().split(/\s+/u)[1] ?? "")
      .filter((ref) => ref.startsWith("refs/tags/"))
      .map((ref) => ref.slice("refs/tags/".length))
  );
}

/**
 * Finds the last release of a package on a revision: the newest commit that changed its `version`,
 * unless that version is an untagged `0.0.0` placeholder of a package that was never released.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} revision - Revision such as `origin/main`.
 * @param {ReleaseUnit} unit - Released package.
 * @param {string} tagFormat - Tag format.
 * @param {ReadonlySet<string>} remoteTags - Tags on `origin`.
 * @returns {Promise<PackageLastRelease | null>} Last release, or `null` without history or when the
 *   newest version change is the untagged commit that added the package or leaves it at `0.0.0`
 *   (neither pointed at by the package's own tag nor listed in a `release: …` commit).
 */
export async function findLastPackageRelease(reader, revision, unit, tagFormat, remoteTags) {
  const sha = await findVersionChangeCommit(reader, revision, unit.manifestPath);

  if (!sha) {
    return null;
  }

  const version = await readPackageVersionAt(reader, sha, unit.manifestPath);
  const subject = await reader.tryGit(["log", "-1", "--format=%s", sha]);
  const tag = version ? formatPackageTag(tagFormat, unit, version) : null;
  const taggedSha = tag ? await reader.tryGit(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]) : null;
  // Only the package's own tag, or a release commit that lists it (its tag may follow an older
  // tagFormat), makes the commit a release when it adds the package or leaves it at the `0.0.0` placeholder.
  const listedInReleaseCommit = parseMonorepoReleaseSubject(subject)?.some((release) => release.name === unit.name && release.version === version) ?? false;
  const releasedHere = taggedSha === sha || listedInReleaseCommit;
  if (!releasedHere && version === UNRELEASED_PLACEHOLDER_VERSION) {
    return null;
  }
  if (!releasedHere && (await reader.tryGit(["cat-file", "-e", `${sha}^:${unit.manifestPath}`])) === null) {
    return null;
  }
  return { sha, version, subject, tag, tagged: taggedSha === sha, tagOnOrigin: tag !== null && remoteTags.has(tag) };
}

/**
 * Gathers the monorepo release snapshot.
 *
 * @param {{
 *   repositoryRoot: string,
 *   units: readonly ReleaseUnit[],
 *   tagFormat: string,
 *   trackNpm?: boolean,
 *   checkMigrations?: (() => Promise<MigrationCheck> | MigrationCheck) | null,
 *   onProgress?: (label: string) => void,
 *   lookupNpm?: typeof lookupPublishedVersions,
 *   checkNpmAuthFor?: ((snapshot: MonorepoSnapshot) => string[]) | null,
 *   checkNpmAccess?: typeof checkNpmPublishAccess,
 *   lookupPullRequestFor?: typeof lookupPullRequest,
 *   registrySelection?: import("../create-version/registry.js").RegistrySelection,
 * }} options - Repository, released packages, adapters and progress callback. `checkNpmAuthFor`
 *   receives the snapshot without credentials and names the packages whose credentials are checked.
 * @returns {Promise<MonorepoSnapshot>} Snapshot accepted by `buildMonorepoPlan`.
 */
export async function collectMonorepoState({
  repositoryRoot,
  units,
  tagFormat,
  trackNpm = false,
  checkMigrations = null,
  onProgress = () => {},
  lookupNpm = lookupPublishedVersions,
  checkNpmAuthFor = null,
  checkNpmAccess = checkNpmPublishAccess,
  lookupPullRequestFor = lookupPullRequest,
  registrySelection,
}) {
  const reader = createGitReader(repositoryRoot);
  const repository = await readRepositorySnapshot({ repositoryRoot, reader, onProgress, lookupPullRequestFor });
  const headSha = await reader.tryGit(["rev-parse", "HEAD"]);
  const headSubject = await reader.tryGit(["log", "-1", "--format=%s", "HEAD"]);
  const remoteTags = repository.remoteMainExists ? await readRemoteTags(reader) : new Set();

  /** @type {PackageSnapshot[]} */
  const packages = [];

  for (const unit of units) {
    onProgress(`Revisando ${unit.name}`);
    const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, unit.manifestPath), "utf8"));
    const releasedVersion = repository.remoteMainExists ? await readPackageVersionAt(reader, REMOTE_MAIN_REF, unit.manifestPath) : null;
    const lastRelease = repository.remoteMainExists ? await findLastPackageRelease(reader, REMOTE_MAIN_REF, unit, tagFormat, remoteTags) : null;
    const range = lastRelease ? `${lastRelease.sha}..${REMOTE_MAIN_REF}` : REMOTE_MAIN_REF;
    const unreleasedCommits = repository.remoteMainExists ? await listCommits(reader, range, unit.changePaths) : [];
    const packageRoot = path.join(repositoryRoot, unit.directory);
    const npm = trackNpm ? registrySelection ? await lookupRegistryVersions(registrySelection, manifest, repositoryRoot, packageRoot, lookupNpm) : await lookupNpmOnPublishRegistry(lookupNpm, manifest, repositoryRoot) : null;

    packages.push({
      unit,
      manifest,
      releasedVersion,
      lastRelease,
      unreleasedCommits,
      changelog: {
        ...readChangelogState(path.join(repositoryRoot, unit.directory)),
        ...(await readChangelogUpdateState(reader, repositoryRoot, unit.changelogPath, lastRelease?.sha ?? null)),
      },
      npm,
      npmAuth: null,
    });
  }

  if (checkMigrations) {
    onProgress("Consultando migraciones pendientes");
  }

  /** @type {MonorepoSnapshot} */
  const snapshot = { ...repository, headSha, headSubject, packages, migrations: await readMigrations(checkMigrations) };
  const packagesToCheck = new Set(checkNpmAuthFor?.(snapshot) ?? []);

  for (const packageSnapshot of snapshot.packages) {
    if (packagesToCheck.has(packageSnapshot.unit.name)) {
      onProgress(`Verificando las credenciales de npm de ${packageSnapshot.unit.name}`);
      packageSnapshot.npmAuth = confirmFirstPublication(
        registrySelection ? await checkRegistryAccess(registrySelection, packageSnapshot.manifest, repositoryRoot, path.join(repositoryRoot, packageSnapshot.unit.directory), checkNpmAccess) : await checkNpmAuthOnPublishRegistry(checkNpmAccess, packageSnapshot.manifest, repositoryRoot),
        packageSnapshot.npm
      );
    }
  }

  return snapshot;
}
