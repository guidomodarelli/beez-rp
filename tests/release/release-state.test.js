import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NPM_LOOKUP_STATUS, RELEASE_MODE } from "../../scripts/constants/release.js";
import { buildReleasePlan } from "../../scripts/release/release-plan.js";
import { collectReleaseState } from "../../scripts/release/release-state.js";

/** Real Git fixtures with a bare remote can exceed the default timeout on Windows. */
const GIT_FIXTURE_TEST_TIMEOUT_MS = 60_000;

/** Git variables exported by hooks that would redirect fixture commands. */
const GIT_HOOK_ENVIRONMENT_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"];

/** @type {string[]} */
const temporaryDirectories = [];

/**
 * @param {string[]} gitArguments - Git arguments.
 * @param {string} workingDirectory - Repository.
 */
function runGit(gitArguments, workingDirectory) {
  const environment = { ...process.env };
  for (const variableName of GIT_HOOK_ENVIRONMENT_VARIABLES) delete environment[variableName];
  const result = spawnSync("git", gitArguments, { cwd: workingDirectory, encoding: "utf8", env: environment });

  if (result.status !== 0) {
    throw new Error(`git ${gitArguments.join(" ")} failed: ${result.stderr}`);
  }
}

/**
 * @param {string} repositoryRoot - Repository.
 * @param {string} version - Manifest version.
 * @param {string} message - Commit message.
 */
function commitVersion(repositoryRoot, version, message) {
  writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "beez-rp", version }, null, 2)}\n`);
  writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Algo nuevo.\n");
  runGit(["add", "-A"], repositoryRoot);
  runGit(["commit", "--quiet", "--allow-empty", "-m", message], repositoryRoot);
}

/** @returns {string} Clone whose `main` holds a `0.1.0` release plus one feature commit, pushed to a bare `origin`. */
function createReleasedRepository() {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-release-"));
  temporaryDirectories.push(fixtureRoot);
  const remoteRoot = path.join(fixtureRoot, "origin.git");
  const repositoryRoot = path.join(fixtureRoot, "work");
  runGit(["init", "--quiet", "--bare", "--initial-branch=main", remoteRoot], fixtureRoot);
  runGit(["clone", "--quiet", remoteRoot, repositoryRoot], fixtureRoot);
  runGit(["config", "user.email", "release@example.test"], repositoryRoot);
  runGit(["config", "user.name", "Release Fixture"], repositoryRoot);
  runGit(["symbolic-ref", "HEAD", "refs/heads/main"], repositoryRoot);
  commitVersion(repositoryRoot, "0.1.0", "0.1.0");
  commitVersion(repositoryRoot, "0.1.0", "feat: add gate");
  runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
  return repositoryRoot;
}

/**
 * @param {string} repositoryRoot - Checkout.
 * @param {string[]} publishedVersions - Versions npm reports.
 */
function collect(repositoryRoot, publishedVersions) {
  return collectReleaseState({
    repositoryRoot,
    lookupNpm: async () => ({ status: NPM_LOOKUP_STATUS.ok, publishedVersions, reason: null }),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release state", () => {
  it(
    "should list the commits published after the last release commit and plan a new release",
    async () => {
      const state = await collect(createReleasedRepository(), ["0.1.0"]);

      expect(state.packageName).toBe("beez-rp");
      expect(state.currentBranch).toBe("main");
      expect(state.headVersion).toBe("0.1.0");
      expect(state.unreleasedCommits.map((commit) => commit.subject)).toEqual(["feat: add gate"]);
      expect(state.changelog.entryCount).toBe(1);
      expect(buildReleasePlan(state).mode).toBe(RELEASE_MODE.newRelease);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should resume a local release commit that never reached origin nor npm",
    async () => {
      const repositoryRoot = createReleasedRepository();
      commitVersion(repositoryRoot, "0.2.0", "0.2.0");

      const state = await collect(repositoryRoot, ["0.1.0"]);
      const plan = buildReleasePlan(state);

      expect(state.main.aheadCommits.map((commit) => commit.subject)).toEqual(["0.2.0"]);
      expect(plan.mode).toBe(RELEASE_MODE.resume);
      expect(plan.pendingVersion).toBe("0.2.0");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
});
