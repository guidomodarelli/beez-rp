import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it(
    "should look up published versions on the registry the working-tree package.json publishes to",
    async () => {
      const { repositoryRoot } = createReleasedRepository();
      const scopedManifest = { name: "@team/fixture-app", version: "0.1.0", publishConfig: { "@team:registry": "https://npm.example.test/team/" } };
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify(scopedManifest, null, 2)}\n`);
      /** @type {unknown[][]} */
      const lookups = [];

      const state = await collectReleaseState({
        repositoryRoot,
        trackNpm: true,
        lookupNpm: async (...lookupArguments) => {
          lookups.push(lookupArguments);
          return { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["0.1.0"], reason: null };
        },
      });

      expect(lookups).toEqual([["@team/fixture-app", repositoryRoot, "https://npm.example.test/team/"]]);
      expect(state.npm?.publishedVersions).toEqual(["0.1.0"]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should report a failed npm lookup instead of querying npmjs when the declared registry is invalid",
    async () => {
      const { repositoryRoot } = createReleasedRepository();
      const invalidRegistryManifest = { name: "fixture-app", version: "0.1.0", publishConfig: { registry: "ftp://npm.example.test/" } };
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify(invalidRegistryManifest, null, 2)}\n`);
      let lookupCount = 0;

      const state = await collectReleaseState({
        repositoryRoot,
        trackNpm: true,
        lookupNpm: async () => {
          lookupCount += 1;
          return { status: NPM_LOOKUP_STATUS.ok, publishedVersions: [], reason: null };
        },
      });

      expect(lookupCount).toBe(0);
      expect(state.npm).toEqual({ status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: expect.stringContaining("http(s)") });
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

  /**
   * Configures `publish: "npm"` with an `artifact` that `prepare` packs with the real `npm pack`.
   *
   * @param {string} repositoryRoot - Checkout.
   * @param {string} [extraPrepare] - Statement run after packing, with `repositoryRoot` in scope.
   * @param {{ ignoreReleases?: boolean }} [options] - Whether `.gitignore` excludes `releases/` (and so npm skips it too).
   */
  function configureNpmPackArtifact(repositoryRoot, extraPrepare = "", { ignoreReleases = true } = {}) {
    if (ignoreReleases) writeFileSync(path.join(repositoryRoot, ".gitignore"), "releases/\n");
    writeFileSync(
      path.join(repositoryRoot, "beez-rp.config.js"),
      [
        'import { execSync } from "node:child_process";',
        'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        "export default {",
        '  changelog: { audience: "equipo" },',
        '  publish: "npm",',
        "  registry: null,",
        '  artifact: "releases/{name}-{version}.tgz",',
        "  prepare: ({ repositoryRoot }) => {",
        '    mkdirSync(path.join(repositoryRoot, "releases"), { recursive: true });',
        '    execSync("npm pack --pack-destination releases --ignore-scripts", { cwd: repositoryRoot, stdio: "ignore" });',
        `    ${extraPrepare}`,
        "  },",
        "};",
        "",
      ].join("\n")
    );
    runGit(["add", "-A"], repositoryRoot);
    runGit(["commit", "--quiet", "-m", "chore: configure releases"], repositoryRoot);
    runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
  }

  /**
   * Runs a release that stops right after verifying the artifact: without NPM_TOKEN npm never publishes.
   *
   * @param {string} repositoryRoot - Checkout.
   * @returns {string} Combined output.
   */
  function runReleaseWithoutToken(repositoryRoot) {
    /** @type {NodeJS.ProcessEnv} */
    const environment = { ...cleanEnvironment(), NO_COLOR: "1" };
    delete environment.NPM_TOKEN;
    const result = spawnSync(process.execPath, [CLI_PATH, "create-version", "--bump", "minor"], { cwd: repositoryRoot, encoding: "utf8", env: environment });
    return `${result.stdout}${result.stderr}`;
  }

  it(
    "should verify the npm-packed artifact against the npm pack --dry-run integrity, with the package name brought by syncing main",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      configureNpmPackArtifact(repositoryRoot);
      const renamedManifest = { name: "fixture-app-renamed", version: "0.1.0" };
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify(renamedManifest, null, 2)}\n`);
      runGit(["commit", "--quiet", "-am", "chore: rename package"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
      runGit(["reset", "--quiet", "--hard", "HEAD~1"], repositoryRoot);

      const output = runReleaseWithoutToken(repositoryRoot);

      expect(output).toContain("releases/fixture-app-renamed-0.2.0.tgz verificado (integrity de npm pack)");
      expect(output).not.toContain("No hay un artefacto preparado");
      expect(output).toContain("Falta NPM_TOKEN para publicar 0.2.0.");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  /**
   * Commits and pushes a configuration, so a later commit on `origin/main` can replace it.
   *
   * @param {string} repositoryRoot - Checkout.
   * @param {string[]} configLines - Lines of `beez-rp.config.js`.
   */
  function pushConfiguration(repositoryRoot, configLines) {
    writeFileSync(path.join(repositoryRoot, "beez-rp.config.js"), [...configLines, ""].join("\n"));
    runGit(["add", "-A"], repositoryRoot);
    runGit(["commit", "--quiet", "-m", "chore: configure releases"], repositoryRoot);
    runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
  }

  it(
    "should verify the artifact that origin/main configures when local main was behind with a configuration without artifact",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      pushConfiguration(repositoryRoot, [
        "export default {",
        '  changelog: { audience: "equipo" },',
        '  publish: "npm",',
        "  registry: null,",
        "  prepare: () => {},",
        "};",
      ]);
      configureNpmPackArtifact(repositoryRoot);
      runGit(["reset", "--quiet", "--hard", "HEAD~1"], repositoryRoot);

      const output = runReleaseWithoutToken(repositoryRoot);

      expect(output).toContain("releases/fixture-app-0.2.0.tgz verificado (integrity de npm pack)");
      expect(output).toContain("Falta NPM_TOKEN para publicar 0.2.0.");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before touching the version when the configuration brought by syncing main changes the plan",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "};"]);
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', '  checks: ["node --version"],', "};"]);
      runGit(["reset", "--quiet", "--hard", "HEAD~1"], repositoryRoot);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(1);
      expect(release.output).toContain("origin/main cambió beez-rp.config.js");
      expect(release.output).toContain("Volvé a correr pnpm create-version");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version).toBe("0.1.0");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should verify an artifact that npm would otherwise pack into itself, and keep it at its path",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      configureNpmPackArtifact(repositoryRoot, "", { ignoreReleases: false });

      const output = runReleaseWithoutToken(repositoryRoot);

      expect(output).toContain("releases/fixture-app-0.2.0.tgz verificado (integrity de npm pack)");
      expect(output).toContain("Falta NPM_TOKEN para publicar 0.2.0.");
      expect(existsSync(path.join(repositoryRoot, "releases", "fixture-app-0.2.0.tgz"))).toBe(true);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before publishing when prepare modifies a tracked file such as package.json",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      configureNpmPackArtifact(
        repositoryRoot,
        'const manifestPath = path.join(repositoryRoot, "package.json"); writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version: "9.9.9" }));'
      );

      const output = runReleaseWithoutToken(repositoryRoot);

      // The failure box wraps long lines, so only the start of the reason is matched.
      expect(output).toContain("El paso de preparación modificó archivos");
      expect(output).toContain("package.json");
      expect(output).not.toContain("Falta NPM_TOKEN");
      expect(JSON.parse(runGit(["show", "v0.2.0:package.json"], remoteRoot)).version).toBe("0.2.0");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
  it(
    "should stop before publishing when the prepared archive is not what npm packs from the release commit",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      configureNpmPackArtifact(
        repositoryRoot,
        'writeFileSync(path.join(repositoryRoot, "releases", "fixture-app-0.2.0.tgz"), "not an npm archive");'
      );

      const output = runReleaseWithoutToken(repositoryRoot);

      expect(output).toContain("El artefacto releases/fixture-app-0.2.0.tgz no se puede");
      expect(output).not.toContain("Falta NPM_TOKEN");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before publishing when the package relies on pnpm rewriting workspace dependencies",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      configureNpmPackArtifact(repositoryRoot);
      // `version` stays the last field so its line is unchanged and the commit is not taken as a release.
      const workspaceManifest = { name: "fixture-app", dependencies: { "fixture-lib": "workspace:^" }, version: "0.1.0" };
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify(workspaceManifest, null, 2)}
`);
      runGit(["commit", "--quiet", "-am", "feat: depend on workspace library"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const output = runReleaseWithoutToken(repositoryRoot);

      expect(output).toContain("Este paquete depende de reescrituras de pnpm");
      expect(output).not.toContain("Falta NPM_TOKEN");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
});
