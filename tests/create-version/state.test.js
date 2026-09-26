import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NPM_LOOKUP_STATUS, RELEASE_MODE, RELEASE_STEP } from "../../src/constants/create-version.js";
import { buildReleasePlan } from "../../src/create-version/plan.js";
import { collectReleaseState } from "../../src/create-version/state.js";

/** Real Git fixtures with a bare remote can exceed the default timeout on Windows. */
const GIT_FIXTURE_TEST_TIMEOUT_MS = 60_000;

/** Git variables exported by hooks that would redirect fixture commands. */
const GIT_HOOK_ENVIRONMENT_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"];

/** Command line entrypoint exercised end to end. */
const CLI_PATH = fileURLToPath(new URL("../../bin/beez-rp.js", import.meta.url));

/** @type {string[]} */
const temporaryDirectories = [];

/** @returns {NodeJS.ProcessEnv} Environment without Git hook redirections. */
function cleanEnvironment() {
  const environment = { ...process.env };
  for (const variableName of GIT_HOOK_ENVIRONMENT_VARIABLES) delete environment[variableName];
  return environment;
}

/**
 * @param {string[]} gitArguments - Git arguments.
 * @param {string} workingDirectory - Repository.
 * @returns {string} Trimmed stdout.
 */
function runGit(gitArguments, workingDirectory) {
  const result = spawnSync("git", gitArguments, { cwd: workingDirectory, encoding: "utf8", env: cleanEnvironment() });

  if (result.status !== 0) {
    throw new Error(`git ${gitArguments.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/**
 * @param {string} repositoryRoot - Repository.
 * @param {string} version - Manifest version.
 * @param {string} message - Commit message.
 */
function commitVersion(repositoryRoot, version, message) {
  writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-app", version }, null, 2)}\n`);
  writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Algo nuevo.\n");
  runGit(["add", "-A"], repositoryRoot);
  runGit(["commit", "--quiet", "--allow-empty", "-m", message], repositoryRoot);
}

/**
 * @param {string} releaseSubject - Subject of the release commit.
 * @returns {{ repositoryRoot: string, remoteRoot: string }} Clone whose `main` holds a `0.1.0` release plus one feature, pushed to a bare `origin`.
 */
function createReleasedRepository(releaseSubject = "0.1.0") {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-create-version-"));
  temporaryDirectories.push(fixtureRoot);
  const remoteRoot = path.join(fixtureRoot, "origin.git");
  const repositoryRoot = path.join(fixtureRoot, "work");
  runGit(["init", "--quiet", "--bare", "--initial-branch=main", remoteRoot], fixtureRoot);
  runGit(["clone", "--quiet", remoteRoot, repositoryRoot], fixtureRoot);
  runGit(["config", "user.email", "release@example.test"], repositoryRoot);
  runGit(["config", "user.name", "Release Fixture"], repositoryRoot);
  runGit(["config", "commit.gpgsign", "false"], repositoryRoot);
  runGit(["config", "tag.gpgsign", "false"], repositoryRoot);
  runGit(["symbolic-ref", "HEAD", "refs/heads/main"], repositoryRoot);
  commitVersion(repositoryRoot, "0.1.0", releaseSubject);
  commitVersion(repositoryRoot, "0.1.0", "feat: add gate");
  runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
  return { repositoryRoot, remoteRoot };
}

/**
 * @param {string} repositoryRoot - Checkout.
 * @param {string[]} [publishedVersions] - Versions npm reports; omitted to skip npm.
 */
function collect(repositoryRoot, publishedVersions) {
  return collectReleaseState({
    repositoryRoot,
    trackNpm: publishedVersions !== undefined,
    lookupNpm: async () => ({ status: NPM_LOOKUP_STATUS.ok, publishedVersions: publishedVersions ?? [], reason: null }),
  });
}

/**
 * @param {string} repositoryRoot - Checkout used as working directory.
 * @param {string[]} commandArguments - Arguments after `create-version`.
 * @returns {{ status: number | null, output: string }} Exit code and combined output.
 */
function runCli(repositoryRoot, commandArguments) {
  const result = spawnSync(process.execPath, [CLI_PATH, "create-version", ...commandArguments], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...cleanEnvironment(), NO_COLOR: "1" },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("create-version state", () => {
  it(
    "should list the commits after the last version change and plan a new release",
    async () => {
      const state = await collect(createReleasedRepository().repositoryRoot);

      expect(state.packageName).toBe("fixture-app");
      expect(state.lastRelease?.version).toBe("0.1.0");
      expect(state.releasedVersion).toBe("0.1.0");
      expect(state.unreleasedCommits.map((commit) => commit.subject)).toEqual(["feat: add gate"]);
      expect(state.npm).toBeNull();
      expect(buildReleasePlan(state).mode).toBe(RELEASE_MODE.newRelease);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should find a release whose subject is not X.Y.Z through its version change",
    async () => {
      const state = await collect(createReleasedRepository("chore(release): prepara la versión 0.1.0").repositoryRoot);

      expect(state.lastRelease?.version).toBe("0.1.0");
      expect(state.unreleasedCommits.map((commit) => commit.subject)).toEqual(["feat: add gate"]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should resume a local release commit that never reached origin nor npm",
    async () => {
      const { repositoryRoot } = createReleasedRepository();
      commitVersion(repositoryRoot, "0.2.0", "0.2.0");

      const state = await collect(repositoryRoot, ["0.1.0"]);
      const plan = buildReleasePlan(state, { checks: true, prepare: false, publish: true, publishTitle: "Publicar en npm" });

      expect(state.main.aheadCommits.map((commit) => commit.subject)).toEqual(["0.2.0"]);
      expect(plan.mode).toBe(RELEASE_MODE.resume);
      expect(plan.steps.map((planStep) => planStep.id)).toEqual([RELEASE_STEP.pushRelease, RELEASE_STEP.publishRelease]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
});

describe("beez-rp create-version command", () => {
  it(
    "should explain a missing configuration and preview the plan with --dry-run",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const missing = runCli(repositoryRoot, ["--dry-run"]);
      expect(missing.status).toBe(1);
      expect(missing.output).toContain("beez-rp.config.mjs or beez-rp.config.js not found");

      writeFileSync(path.join(repositoryRoot, "beez-rp.config.js"), 'export default { changelog: { audience: "equipo" } };\n');
      runGit(["add", "beez-rp.config.js"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "chore: configure releases"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const preview = runCli(repositoryRoot, ["--dry-run"]);
      expect(preview.status).toBe(0);
      expect(preview.output).toContain("Plan");
      expect(preview.output).toContain("--dry-run: no se cambió nada");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should release, tag, push and run the project hooks with the chosen version",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      writeFileSync(
        path.join(repositoryRoot, "beez-rp.config.js"),
        [
          'import { appendFileSync } from "node:fs";',
          `const log = ${JSON.stringify(hookLog)};`,
          "export default {",
          '  changelog: { audience: "equipo" },',
          '  checks: ["node --version"],',
          '  prepare: ({ version }) => appendFileSync(log, `prepare ${version}\\n`),',
          '  publish: ({ version }) => appendFileSync(log, `publish ${version}\\n`),',
          "};",
          "",
        ].join("\n")
      );
      runGit(["add", "beez-rp.config.js"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "chore: configure releases"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(readFileSync(hookLog, "utf8")).toBe("prepare 0.2.0\npublish 0.2.0\n");
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("0.2.0");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("v0.2.0");
      expect(JSON.parse(runGit(["show", "main:package.json"], remoteRoot)).version).toBe("0.2.0");
      expect(runGit(["show", "main:CHANGELOG.md"], remoteRoot)).toMatch(/## \[Unreleased\]\n\n## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- Algo nuevo\./u);

      const again = runCli(repositoryRoot, ["--dry-run"]);
      expect(again.output).toContain("Todo al día");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
});
