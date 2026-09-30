import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { listFilesDifferentFromHead } from "../../src/create-version/head-files.js";
import { createGitReader } from "../../src/create-version/process.js";

/** Real Git repositories can exceed the default timeout on Windows. */
const GIT_FIXTURE_TEST_TIMEOUT_MS = 60_000;

/** Git variables exported by hooks that would redirect fixture commands. */
const GIT_HOOK_ENVIRONMENT_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"];

/** Whether the file system keeps POSIX permission bits (Windows only keeps the read-only flag). */
const KEEPS_PERMISSION_BITS = process.platform !== "win32";

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

/** @returns {string} Empty Git repository that keeps symbolic links and the executable bit. */
function createRepository() {
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-head-files-test-"));
  temporaryDirectories.push(repositoryRoot);
  runGit(["init", "--quiet", "--initial-branch=main"], repositoryRoot);
  runGit(["config", "user.email", "release@example.test"], repositoryRoot);
  runGit(["config", "user.name", "Release Fixture"], repositoryRoot);
  runGit(["config", "commit.gpgsign", "false"], repositoryRoot);
  runGit(["config", "core.autocrlf", "false"], repositoryRoot);
  runGit(["config", "core.symlinks", "true"], repositoryRoot);
  runGit(["config", "core.fileMode", "true"], repositoryRoot);
  return repositoryRoot;
}

/**
 * Tells whether this system lets the tests create symbolic links to files: Windows refuses them
 * without Developer Mode or elevated rights.
 *
 * @returns {boolean} `true` when a file symbolic link can be created.
 */
function canCreateFileSymbolicLinks() {
  const probeRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-symlink-probe-"));

  try {
    writeFileSync(path.join(probeRoot, "target.txt"), "");
    symlinkSync("target.txt", path.join(probeRoot, "link.txt"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

describe("create-version files compared with HEAD", () => {
  it.skipIf(!canCreateFileSymbolicLinks())(
    "should not report a committed symbolic link whose target ends in whitespace, and report it once the target changes",
    async () => {
      const repositoryRoot = createRepository();
      writeFileSync(path.join(repositoryRoot, "settings.js "), "export default {};\n");
      symlinkSync("settings.js ", path.join(repositoryRoot, "settings-link.js"), "file");
      runGit(["add", "--all"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "link"], repositoryRoot);
      const reader = createGitReader(repositoryRoot);

      await expect(listFilesDifferentFromHead(reader, repositoryRoot, ["settings-link.js"])).resolves.toEqual([]);

      rmSync(path.join(repositoryRoot, "settings-link.js"));
      symlinkSync("settings.js", path.join(repositoryRoot, "settings-link.js"), "file");

      await expect(listFilesDifferentFromHead(reader, repositoryRoot, ["settings-link.js"])).resolves.toEqual([{ file: "settings-link.js", difference: "contentChanged" }]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should report a submodule with an untracked file even when the submodule hides untracked files from git status",
    async () => {
      const repositoryRoot = createRepository();
      const submoduleRoot = path.join(repositoryRoot, "vendor", "lib");
      mkdirSync(submoduleRoot, { recursive: true });
      runGit(["init", "--quiet", "--initial-branch=main"], submoduleRoot);
      writeFileSync(path.join(submoduleRoot, "index.js"), "export const value = 1;\n");
      runGit(["add", "index.js"], submoduleRoot);
      runGit(["-c", "user.email=lib@example.test", "-c", "user.name=Lib Fixture", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "lib"], submoduleRoot);
      runGit(["-c", "advice.addEmbeddedRepo=false", "add", "vendor/lib"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "gitlink"], repositoryRoot);
      const reader = createGitReader(repositoryRoot);

      await expect(listFilesDifferentFromHead(reader, repositoryRoot, ["vendor/lib"])).resolves.toEqual([]);

      runGit(["config", "status.showUntrackedFiles", "no"], submoduleRoot);
      writeFileSync(path.join(submoduleRoot, "local.js"), "export const local = true;\n");

      await expect(listFilesDifferentFromHead(reader, repositoryRoot, ["vendor/lib"])).resolves.toEqual([{ file: "vendor/lib", difference: "contentChanged" }]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it.skipIf(!KEEPS_PERMISSION_BITS)(
    "should compare only the owner execute bit, the one Git records, with HEAD",
    async () => {
      const repositoryRoot = createRepository();
      const scriptPath = path.join(repositoryRoot, "release.sh");
      writeFileSync(scriptPath, "#!/bin/sh\necho release\n");
      chmodSync(scriptPath, 0o644);
      runGit(["add", "release.sh"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "script"], repositoryRoot);
      const reader = createGitReader(repositoryRoot);

      // Group and others may execute it, but Git still records a plain file (100644).
      chmodSync(scriptPath, 0o654);
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");
      await expect(listFilesDifferentFromHead(reader, repositoryRoot, ["release.sh"])).resolves.toEqual([]);

      chmodSync(scriptPath, 0o744);
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe(" M release.sh");
      await expect(listFilesDifferentFromHead(reader, repositoryRoot, ["release.sh"])).resolves.toEqual([{ file: "release.sh", difference: "executableBitChanged" }]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
});
