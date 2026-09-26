import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideBuild } from "../src/build-gate.js";
import {
  ALLOWED_NEXT_VERSIONS,
  CURRENT_STABLE_VERSION,
  REJECTED_VERSION_BUMPS,
  REJECTED_VERSION_BUMP_CASES,
} from "../src/testing.js";

/** Real Git fixtures can exceed the default timeout on Windows. */
const GIT_FIXTURE_TEST_TIMEOUT_MS = 60_000;

/** CLI exercised by the Vercel `ignoreCommand` wrappers. */
const CLI_PATH = fileURLToPath(new URL("../bin/beez-rp.js", import.meta.url));

/** Git variables exported by hooks that would redirect fixture commands. */
const GIT_HOOK_ENVIRONMENT_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"];

/** @type {string[]} */
const temporaryDirectories = [];

/** @returns {NodeJS.ProcessEnv} Environment without hook variables. */
function createFixtureEnvironment() {
  const environment = { ...process.env };

  for (const variableName of GIT_HOOK_ENVIRONMENT_VARIABLES) {
    delete environment[variableName];
  }

  return environment;
}

/**
 * @param {string[]} gitArguments - Git arguments.
 * @param {string} workingDirectory - Repository.
 */
function runGit(gitArguments, workingDirectory) {
  const result = spawnSync("git", gitArguments, { cwd: workingDirectory, encoding: "utf8", env: createFixtureEnvironment() });

  if (result.status !== 0) {
    throw new Error(`git ${gitArguments.join(" ")} failed: ${result.stderr}`);
  }
}

/**
 * Creates a repository with one commit per `package.json` version.
 *
 * @param {(string | null)[]} versions - Versions in commit order; `null` commits a manifest without version.
 * @returns {string} Repository root.
 */
function createRepositoryWithVersions(versions) {
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-gate-"));
  temporaryDirectories.push(repositoryRoot);
  runGit(["init", "--quiet"], repositoryRoot);
  runGit(["config", "user.email", "release@example.test"], repositoryRoot);
  runGit(["config", "user.name", "Release Fixture"], repositoryRoot);

  for (const version of versions) {
    const manifest = version === null ? { name: "fixture" } : { name: "fixture", version };
    writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    runGit(["add", "-A"], repositoryRoot);
    runGit(["commit", "--quiet", "--allow-empty", "-m", String(version)], repositoryRoot);
  }

  return repositoryRoot;
}

/**
 * Runs `beez-rp ignore-build` in a checkout.
 *
 * @param {string} repositoryRoot - Checkout being deployed.
 * @param {string[]} [cliArguments] - CLI arguments.
 * @returns {{ exitCode: number | null, lines: string[] }} Exit code and stdout lines.
 */
function runCli(repositoryRoot, cliArguments = ["ignore-build"]) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...cliArguments], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: createFixtureEnvironment(),
  });
  return { exitCode: result.status, lines: result.stdout.trim().split(/\r?\n/u) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("build decision", () => {
  it.each(ALLOWED_NEXT_VERSIONS)(`should build the next version ${CURRENT_STABLE_VERSION} -> %s`, (version) => {
    expect(decideBuild(CURRENT_STABLE_VERSION, version)).toEqual({ shouldBuild: true, reason: expect.stringContaining("Building") });
  });

  it.each(REJECTED_VERSION_BUMP_CASES)("should skip the build when the bump is %s (%j)", (_reason, version) => {
    expect(decideBuild(CURRENT_STABLE_VERSION, version)).toEqual({ shouldBuild: false, reason: expect.stringContaining("Skipping build") });
  });

  it("should never build prerelease or build-metadata versions, even without a previous version", () => {
    for (const unstableVersion of [...REJECTED_VERSION_BUMPS.prerelease, ...REJECTED_VERSION_BUMPS["build metadata"]]) {
      expect(decideBuild(null, unstableVersion)).toEqual({ shouldBuild: false, reason: expect.stringContaining("not a stable") });
    }
  });

  it("should let a previous prerelease be followed by its own stable release", () => {
    expect(decideBuild("1.0.0-beta.1", "1.0.0").shouldBuild).toBe(true);
    expect(decideBuild("1.0.1-beta.1", "1.0.0").shouldBuild).toBe(false);
  });

  it("should build a stable version when the previous one cannot be compared", () => {
    expect(decideBuild(null, "0.1.0").shouldBuild).toBe(true);
    expect(decideBuild("not-a-version", "0.1.0").shouldBuild).toBe(true);
  });

  it("should skip the build when the current version cannot be read", () => {
    expect(decideBuild("0.1.0", null).shouldBuild).toBe(false);
  });
});

describe("beez-rp ignore-build", () => {
  it(
    "should print BUILD as the last line when the commit bumps to the next version",
    () => {
      const { exitCode, lines } = runCli(createRepositoryWithVersions(["0.1.0", "0.2.0"]));

      expect(exitCode).toBe(0);
      expect(lines).toEqual(["Version changed: 0.1.0 -> 0.2.0. Building.", "BUILD"]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should print SKIP for commits that keep, lower, skip or prerelease the version",
    () => {
      for (const versions of [["0.2.0", "0.2.0"], ["0.2.0", "0.1.9"], ["1.0.0", "3.0.0"], ["0.2.0", "0.3.0-beta.1"], ["0.2.0", null]]) {
        const { exitCode, lines } = runCli(createRepositoryWithVersions(versions));

        expect(exitCode).toBe(0);
        expect(lines.at(-1)).toBe("SKIP");
      }
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should build the first commit of a stable version because there is no previous one",
    () => {
      expect(runCli(createRepositoryWithVersions(["0.1.0"])).lines.at(-1)).toBe("BUILD");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it("should fail without a decision on an unknown command", () => {
    const { exitCode, lines } = runCli(os.tmpdir(), ["deploy"]);

    expect(exitCode).toBe(2);
    expect(lines).not.toContain("BUILD");
  });
});
