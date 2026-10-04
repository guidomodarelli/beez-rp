import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
 * Commits a release that bumps `package.json` and writes the CI release metadata in the same commit.
 *
 * @param {string} repositoryRoot - Repository.
 * @param {string} version - Released `package.json` version.
 * @param {{ version: string, execution: string }} metadata - Contents of `.beez-rp/release.json`.
 * @param {string | null} [executionTrailer] - Value of the `Beez-Rp-Execution` trailer, or `null` to omit it.
 */
function commitRelease(repositoryRoot, version, metadata, executionTrailer = null) {
  mkdirSync(path.join(repositoryRoot, ".beez-rp"), { recursive: true });
  writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`);
  writeFileSync(path.join(repositoryRoot, ".beez-rp/release.json"), JSON.stringify(metadata));
  runGit(["add", "-A"], repositoryRoot);
  const trailerArguments = executionTrailer === null ? [] : ["--trailer", `Beez-Rp-Execution: ${executionTrailer}`];
  runGit(["commit", "--quiet", "-m", `chore(release): ${version}`, ...trailerArguments], repositoryRoot);
}

/**
 * Commits a follow-up change that keeps `package.json` and the release metadata untouched.
 *
 * @param {string} repositoryRoot - Repository.
 */
function commitFollowUpChange(repositoryRoot) {
  writeFileSync(path.join(repositoryRoot, "feature.txt"), "Follow-up change without a version bump\n");
  runGit(["add", "feature.txt"], repositoryRoot);
  runGit(["commit", "--quiet", "-m", "fix: follow-up change"], repositoryRoot);
}

/**
 * Clones the current `HEAD` of a repository with `--depth 1`, the way Vercel checks out a deployment.
 *
 * @param {string} repositoryRoot - Repository to clone.
 * @returns {string} Shallow checkout whose `HEAD` has no readable parent.
 */
function cloneShallow(repositoryRoot) {
  const shallowCheckout = path.join(mkdtempSync(path.join(os.tmpdir(), "beez-rp-gate-shallow-")), "checkout");
  temporaryDirectories.push(path.dirname(shallowCheckout));
  runGit(["clone", "--quiet", "--depth", "1", pathToFileURL(repositoryRoot).href, shallowCheckout], repositoryRoot);
  return shallowCheckout;
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
  it("should defer only the exact CI release while keeping ordinary local build decisions", () => {
    // Arrange, Act and Assert
    for (const { metadata, expectedDecision } of [
      { metadata: { version: "1.2.4", execution: "ci" }, expectedDecision: "SKIP" },
      { metadata: { version: "1.2.4", execution: "local" }, expectedDecision: "BUILD" },
      { metadata: { version: "1.2.3", execution: "ci" }, expectedDecision: "BUILD" },
    ]) {
      const root = createRepositoryWithVersions(["1.2.3"]);
      commitRelease(root, "1.2.4", metadata);
      expect(runCli(root).lines.at(-1)).toBe(expectedDecision);
    }
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should skip only the commit that wrote the CI release metadata and let later commits reach the version rule", () => {
    // Arrange
    const root = createRepositoryWithVersions(["1.2.3"]);
    commitRelease(root, "1.2.4", { version: "1.2.4", execution: "ci" });
    // Act
    const releaseGate = runCli(root);
    commitFollowUpChange(root);
    const laterCommitGate = runCli(root);
    // Assert
    expect(releaseGate.lines).toEqual([expect.stringContaining("delegated to CI"), "SKIP"]);
    expect(laterCommitGate.exitCode).toBe(0);
    expect(laterCommitGate.lines).toEqual(["Version did not change. Skipping build.", "SKIP"]);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should skip a CI release deployed from a shallow clone through its commit trailer and build the later commit", () => {
    // Arrange
    const root = createRepositoryWithVersions(["1.2.3"]);
    commitRelease(root, "1.2.4", { version: "1.2.4", execution: "ci" }, "ci");
    const shallowReleaseCheckout = cloneShallow(root);
    commitFollowUpChange(root);
    const shallowLaterCheckout = cloneShallow(root);
    // Act
    const releaseGate = runCli(shallowReleaseCheckout);
    const laterCommitGate = runCli(shallowLaterCheckout);
    // Assert
    expect(releaseGate.exitCode).toBe(0);
    expect(releaseGate.lines).toEqual([expect.stringContaining("delegated to CI"), "SKIP"]);
    expect(laterCommitGate.exitCode).toBe(0);
    expect(laterCommitGate.lines).toEqual(["Previous package version could not be compared. Building stable 1.2.4.", "BUILD"]);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    ["no execution trailer", null],
    ["a local execution trailer", "local"],
  ])("should let the version rule decide a shallow release commit with %s", (_trailerCase, executionTrailer) => {
    // Arrange
    const root = createRepositoryWithVersions(["1.2.3"]);
    commitRelease(root, "1.2.4", { version: "1.2.4", execution: "ci" }, executionTrailer);
    const shallowCheckout = cloneShallow(root);
    // Act
    const { exitCode, lines } = runCli(shallowCheckout);
    // Assert
    expect(exitCode).toBe(0);
    expect(lines).toEqual(["Previous package version could not be compared. Building stable 1.2.4.", "BUILD"]);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

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
