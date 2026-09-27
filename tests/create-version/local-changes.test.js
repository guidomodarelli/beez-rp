import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { restoreLocalChanges, setAsideLocalChanges } from "../../src/create-version/local-changes.js";
import { createGitReader } from "../../src/create-version/process.js";

/** Real Git repositories can exceed the default timeout on Windows. */
const GIT_FIXTURE_TEST_TIMEOUT_MS = 60_000;

/** Git variables exported by hooks that would redirect fixture commands. */
const GIT_HOOK_ENVIRONMENT_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"];

/** @type {string[]} */
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {string[]} gitArguments - Git arguments.
 * @param {string} repositoryRoot - Repository.
 * @returns {string} Stdout without the trailing newline.
 */
function runGit(gitArguments, repositoryRoot) {
  const environment = { ...process.env };
  for (const variableName of GIT_HOOK_ENVIRONMENT_VARIABLES) delete environment[variableName];
  const result = spawnSync("git", gitArguments, { cwd: repositoryRoot, encoding: "utf8", env: environment });

  if (result.status !== 0) {
    throw new Error(`git ${gitArguments.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout.trimEnd();
}

/**
 * @param {string} repositoryRoot - Repository.
 * @param {Record<string, string>} files - Relative paths and contents.
 */
function writeFiles(repositoryRoot, files) {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(repositoryRoot, file), content);
  }
}

/** @returns {string} Repository with a released `package.json`, `CHANGELOG.md` and two source files. */
function createRepository() {
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-local-changes-test-"));
  temporaryDirectories.push(repositoryRoot);
  runGit(["init", "--quiet", "--initial-branch=main"], repositoryRoot);
  runGit(["config", "user.email", "release@example.test"], repositoryRoot);
  runGit(["config", "user.name", "Release Fixture"], repositoryRoot);
  runGit(["config", "commit.gpgsign", "false"], repositoryRoot);
  writeFiles(repositoryRoot, {
    "package.json": '{\n  "name": "fixture-app",\n  "version": "0.1.0"\n}\n',
    "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n",
    "app.js": "export const first = 1;\n\nexport const second = 2;\n",
    "legacy.js": "export const legacy = true;\n",
  });
  runGit(["add", "-A"], repositoryRoot);
  runGit(["commit", "--quiet", "-m", "0.1.0"], repositoryRoot);
  return repositoryRoot;
}

/**
 * Leaves staged and unstaged changes on the same file, a staged new file, a staged deletion and an
 * untracked file.
 *
 * @param {string} repositoryRoot - Repository.
 */
function makeMixedChanges(repositoryRoot) {
  writeFiles(repositoryRoot, { "app.js": "export const first = 10;\n\nexport const second = 2;\n", "added.js": "export const added = true;\n" });
  runGit(["add", "app.js", "added.js"], repositoryRoot);
  runGit(["rm", "--quiet", "legacy.js"], repositoryRoot);
  writeFiles(repositoryRoot, { "app.js": "export const first = 10;\n\nexport const second = 20;\n", "notes.txt": "draft\n" });
}

/**
 * @param {string} repositoryRoot - Repository.
 * @param {string[]} [pathspec] - Paths compared; everything by default.
 * @returns {{ status: string, staged: string, unstaged: string }} What is staged, unstaged and untracked.
 */
function snapshotLocalChanges(repositoryRoot, pathspec = ["."]) {
  return {
    status: runGit(["status", "--porcelain", "--", ...pathspec], repositoryRoot),
    staged: runGit(["diff", "--cached", "--", ...pathspec], repositoryRoot),
    unstaged: runGit(["diff", "--", ...pathspec], repositoryRoot),
  };
}

/** Everything except `CHANGELOG.md`, which a new release commits instead of setting aside. */
const WITHOUT_CHANGELOG = [".", ":(exclude)CHANGELOG.md"];

/**
 * Creates the release commit the way the bump does: new version plus the released changelog.
 *
 * @param {string} repositoryRoot - Repository.
 */
function commitRelease(repositoryRoot) {
  writeFiles(repositoryRoot, {
    "package.json": '{\n  "name": "fixture-app",\n  "version": "0.2.0"\n}\n',
    "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-09-27\n\n### Added\n\n- Algo nuevo.\n",
  });
  runGit(["add", "package.json", "CHANGELOG.md"], repositoryRoot);
  runGit(["commit", "--quiet", "-m", "0.2.0"], repositoryRoot);
}

describe("create-version local changes", () => {
  it(
    "should restore staged changes staged, unstaged changes unstaged and untracked files untracked after a release commit",
    async () => {
      const repositoryRoot = createRepository();
      makeMixedChanges(repositoryRoot);
      writeFiles(repositoryRoot, { "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Algo nuevo.\n" });
      const reader = createGitReader(repositoryRoot);
      const before = snapshotLocalChanges(repositoryRoot, WITHOUT_CHANGELOG);

      const setAside = await setAsideLocalChanges(reader, { keepChangelog: true });
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe(" M CHANGELOG.md");

      commitRelease(repositoryRoot);

      await expect(restoreLocalChanges(reader, repositoryRoot, setAside)).resolves.toEqual({ restored: true });
      expect(snapshotLocalChanges(repositoryRoot)).toEqual(before);
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should restore a dirty CHANGELOG.md too when it was set aside to resume an existing release",
    async () => {
      const repositoryRoot = createRepository();
      makeMixedChanges(repositoryRoot);
      writeFiles(repositoryRoot, { "CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n- Borrador.\n" });
      runGit(["add", "CHANGELOG.md"], repositoryRoot);
      const reader = createGitReader(repositoryRoot);
      const before = snapshotLocalChanges(repositoryRoot);

      const setAside = await setAsideLocalChanges(reader, { keepChangelog: false });
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");

      await expect(restoreLocalChanges(reader, repositoryRoot, setAside)).resolves.toEqual({ restored: true });
      expect(snapshotLocalChanges(repositoryRoot)).toEqual(before);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should touch nothing and keep the stash entry when a staged change collides with the release commit",
    async () => {
      const repositoryRoot = createRepository();
      writeFiles(repositoryRoot, { "package.json": '{\n  "name": "fixture-app",\n  "version": "0.1.5"\n}\n', "notes.txt": "draft\n" });
      runGit(["add", "package.json"], repositoryRoot);
      const reader = createGitReader(repositoryRoot);

      const setAside = await setAsideLocalChanges(reader, { keepChangelog: true });
      commitRelease(repositoryRoot);

      const restore = await restoreLocalChanges(reader, repositoryRoot, setAside);
      expect(restore).toEqual({ restored: false, reason: expect.stringContaining("stash@{0}") });
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");
      expect(runGit(["stash", "list", "--format=%H"], repositoryRoot)).toBe(setAside.sha);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
});
