/**
 * Gathers the snapshot consumed by `release-plan.js`: current branch,
 * uncommitted changes, `main` compared with `origin/main`, the version and
 * subject of `HEAD`, the versions already on npm, the commits waiting to be
 * released and the CHANGELOG `[Unreleased]` block.
 *
 * Every reader is read-only; the only network operations are `git fetch` and
 * `npm view`.
 *
 * @module scripts/release/release-state
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { readUnreleased } from "../../src/changelog.js";
import { CHANGELOG_FILE } from "../../src/constants/changelog.js";
import { RELEASE_COMMIT_SUBJECT_GREP } from "../../src/constants/versions.js";
import {
  FIELD_SEPARATOR,
  MAIN_BRANCH,
  NPM_LOOKUP_STATUS,
  NPM_NOT_FOUND_CODE,
  NPM_PACKAGE_NAME_PATTERN,
  RECORD_SEPARATOR,
  RELEASE_REMOTE,
  REMOTE_MAIN_REF,
} from "../constants/release.js";

/**
 * @typedef {{ status: number, stdout: string, stderr: string }} CapturedResult
 * @typedef {{ status: string, publishedVersions: string[], reason: string | null }} NpmLookup
 * @typedef {{ git: (gitArguments: string[]) => Promise<string>, tryGit: (gitArguments: string[]) => Promise<string | null> }} GitReader
 */

/** Windows resolves `npm.cmd` only through a shell. */
const USES_SHELL_FOR_NPM = process.platform === "win32";

/**
 * Runs a command and captures its output. Leading whitespace is kept because
 * `git status --porcelain` encodes the file state in the first columns.
 *
 * @param {string} command - Executable name, or a full command line when `shell` is set.
 * @param {string[]} commandArguments - Arguments.
 * @param {{ cwd?: string, shell?: boolean }} [options] - Spawn options.
 * @returns {Promise<CapturedResult>} Result; never rejects.
 */
export function runCaptured(command, commandArguments, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArguments, {
      cwd: options.cwd,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout: stdout.trimEnd(), stderr: stderr.trim() }));
  });
}

/**
 * Runs a command with inherited stdio so its progress stays visible.
 *
 * @param {string} command - Executable name, or a full command line when `shell` is set.
 * @param {string[]} commandArguments - Arguments.
 * @param {{ cwd?: string, shell?: boolean }} [options] - Spawn options.
 * @returns {Promise<number>} Exit code; never rejects.
 */
export function runInherited(command, commandArguments, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArguments, { cwd: options.cwd, shell: options.shell ?? false, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (status) => resolve(status ?? 1));
  });
}

/**
 * Creates a Git reader bound to a repository.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {GitReader} Readers.
 */
export function createGitReader(repositoryRoot) {
  /** @param {string[]} gitArguments */
  const tryGit = async (gitArguments) => {
    const result = await runCaptured("git", gitArguments, { cwd: repositoryRoot });
    return result.status === 0 ? result.stdout : null;
  };

  /** @param {string[]} gitArguments */
  const git = async (gitArguments) => {
    const result = await runCaptured("git", gitArguments, { cwd: repositoryRoot });

    if (result.status !== 0) {
      throw new Error(`release-state: git ${gitArguments.join(" ")} failed: ${result.stderr}`);
    }

    return result.stdout;
  };

  return { git, tryGit };
}

/**
 * Lists the commits of a revision range.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} range - Revision range such as `abc..origin/main`.
 * @returns {Promise<{ sha: string, subject: string, body: string }[]>} Commits, newest first.
 */
export async function listCommits(reader, range) {
  const output = await reader.tryGit(["log", `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`, range]);

  return (output ?? "")
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split(FIELD_SEPARATOR);
      return { sha, subject, body: body.trim() };
    });
}

/**
 * Reads the `version` field of `package.json` at a revision.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} revision - Revision such as `HEAD`.
 * @returns {Promise<string | null>} Version, or `null` when unreadable.
 */
export async function readPackageVersionAt(reader, revision) {
  const manifest = await reader.tryGit(["show", `${revision}:package.json`]);

  try {
    return manifest ? (JSON.parse(manifest).version ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Lists the versions of a package published on npm.
 *
 * @param {string} packageName - npm package name.
 * @param {string} repositoryRoot - Directory whose `.npmrc` npm reads.
 * @returns {Promise<NpmLookup>} Published versions; an unpublished package has none.
 */
export async function lookupPublishedVersions(packageName, repositoryRoot) {
  if (!NPM_PACKAGE_NAME_PATTERN.test(packageName)) {
    return { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: `nombre de paquete inválido: ${packageName}` };
  }

  // The name is validated above, so the command line built for the Windows shell stays a fixed shape.
  const result = USES_SHELL_FOR_NPM
    ? await runCaptured(`npm view ${packageName} versions --json`, [], { cwd: repositoryRoot, shell: true })
    : await runCaptured("npm", ["view", packageName, "versions", "--json"], { cwd: repositoryRoot });

  if (result.status !== 0) {
    return `${result.stdout}\n${result.stderr}`.includes(NPM_NOT_FOUND_CODE)
      ? { status: NPM_LOOKUP_STATUS.ok, publishedVersions: [], reason: null }
      : { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: result.stderr.split("\n")[0] || `npm view salió con código ${result.status}` };
  }

  try {
    const versions = JSON.parse(result.stdout);
    return { status: NPM_LOOKUP_STATUS.ok, publishedVersions: Array.isArray(versions) ? versions : [versions], reason: null };
  } catch (error) {
    return { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: `respuesta inválida de npm view (${error instanceof Error ? error.message : String(error)})` };
  }
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
 * Gathers the complete release snapshot.
 *
 * @param {{
 *   repositoryRoot: string,
 *   onProgress?: (label: string) => void,
 *   lookupNpm?: typeof lookupPublishedVersions,
 * }} options - Inputs; `lookupNpm` selects the npm adapter.
 * @returns {Promise<import("./release-plan.js").ReleaseState & { packageName: string, unreleasedCommits: { sha: string, subject: string, body: string }[] }>} Snapshot accepted by `buildReleasePlan`.
 */
export async function collectReleaseState({ repositoryRoot, onProgress = () => {}, lookupNpm = lookupPublishedVersions }) {
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

  // The last release is the last version commit (`0.1.0`) that reached origin/main.
  const lastReleaseSha = remoteMainExists
    ? await reader.tryGit(["log", "-1", "--extended-regexp", `--grep=${RELEASE_COMMIT_SUBJECT_GREP}`, "--format=%H", REMOTE_MAIN_REF])
    : null;
  const unreleasedCommits = remoteMainExists ? await listCommits(reader, lastReleaseSha ? `${lastReleaseSha}..${REMOTE_MAIN_REF}` : REMOTE_MAIN_REF) : [];

  onProgress("Consultando npm");
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const npm = await lookupNpm(manifest.name, repositoryRoot);

  return {
    packageName: manifest.name,
    currentBranch,
    workingTreeChanges,
    main: { aheadCommits, behindCount },
    headVersion,
    headSubject,
    npm,
    unreleasedCommits,
    changelog: readChangelogState(repositoryRoot),
  };
}
