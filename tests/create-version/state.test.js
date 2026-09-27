import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NPM_LOOKUP_STATUS, RELEASE_MODE, RELEASE_STEP } from "../../src/constants/create-version.js";
import { buildReleasePlan } from "../../src/create-version/plan.js";
import { collectReleaseState } from "../../src/create-version/state.js";
import { startFixtureNpmRegistry } from "./support/fixture-npm-registry.js";

/** Real Git fixtures with a bare remote can exceed the default timeout on Windows. */
const GIT_FIXTURE_TEST_TIMEOUT_MS = 60_000;

/** Git variables exported by hooks that would redirect fixture commands. */
const GIT_HOOK_ENVIRONMENT_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"];

/**
 * Variables of the test runner that would change the token or the registry the command resolves:
 * the command under test only sees the ones each test sets.
 */
const ISOLATED_NPM_VARIABLE_PATTERN = /^(?:npm_config_(?:@[^:]+:)?registry|npm_token)$/iu;

/** Token the fixture registry accepts for the package owner; not a real credential. */
const OWNER_TOKEN = "fixture-owner-token";

/** npm user of {@link OWNER_TOKEN}. */
const OWNER_USER = "fixture-owner";

/** Box borders removed by {@link flattenOutput}. */
const BOX_BORDER_PATTERN = /[│╭╮╰╯─]/gu;

/** Command line entrypoint exercised end to end. */
const CLI_PATH = fileURLToPath(new URL("../../bin/beez-rp.js", import.meta.url));

/** @type {string[]} */
const temporaryDirectories = [];

/** @type {{ close: () => Promise<void> }[]} */
const openRegistries = [];

/** @returns {NodeJS.ProcessEnv} Environment without Git hook redirections. */
function cleanEnvironment() {
  const environment = { ...process.env };
  for (const variableName of GIT_HOOK_ENVIRONMENT_VARIABLES) delete environment[variableName];
  return environment;
}

/**
 * Environment of the command under test: no inherited npm token nor registry, and a temporary home
 * (`HOME`/`USERPROFILE`) so the user's real `~/.config/beez-rp/.env` never leaks in.
 *
 * @param {NodeJS.ProcessEnv} [overrides] - Variables the test sets, such as `NPM_TOKEN`.
 * @returns {NodeJS.ProcessEnv} Environment.
 */
function commandEnvironment(overrides = {}) {
  const temporaryHome = mkdtempSync(path.join(os.tmpdir(), "beez-rp-cli-home-"));
  temporaryDirectories.push(temporaryHome);
  const environment = Object.fromEntries(Object.entries(cleanEnvironment()).filter(([variableName]) => !ISOLATED_NPM_VARIABLE_PATTERN.test(variableName)));
  return { ...environment, HOME: temporaryHome, USERPROFILE: temporaryHome, NO_COLOR: "1", ...overrides };
}

/**
 * Joins the output without box borders nor line wrapping, so long messages can be matched whole.
 *
 * @param {string} output - Command output.
 * @returns {string} Output on a single line with single spaces.
 */
function flattenOutput(output) {
  return output.replace(BOX_BORDER_PATTERN, " ").replace(/\s+/gu, " ");
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
 * @param {Record<string, unknown>} [manifestFields] - Extra `package.json` fields, written before `version`.
 */
function commitVersion(repositoryRoot, version, message, manifestFields = {}) {
  writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-app", ...manifestFields, version }, null, 2)}\n`);
  writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Algo nuevo.\n");
  runGit(["add", "-A"], repositoryRoot);
  runGit(["commit", "--quiet", "--allow-empty", "-m", message], repositoryRoot);
}

/**
 * @param {string} releaseSubject - Subject of the release commit.
 * @param {Record<string, unknown>} [manifestFields] - Extra `package.json` fields, such as a `publishConfig` registry.
 * @returns {{ repositoryRoot: string, remoteRoot: string }} Clone whose `main` holds a `0.1.0` release plus one feature, pushed to a bare `origin`.
 */
function createReleasedRepository(releaseSubject = "0.1.0", manifestFields = {}) {
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
  commitVersion(repositoryRoot, "0.1.0", releaseSubject, manifestFields);
  commitVersion(repositoryRoot, "0.1.0", "feat: add gate", manifestFields);
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
    env: commandEnvironment(),
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Runs the command without blocking the event loop, so a fixture registry in this process can answer npm.
 *
 * @param {string} repositoryRoot - Checkout used as working directory.
 * @param {string[]} commandArguments - Arguments after `create-version`.
 * @param {NodeJS.ProcessEnv} [environmentOverrides] - Variables such as `NPM_TOKEN`.
 * @returns {Promise<{ status: number | null, output: string }>} Exit code and combined output.
 */
function runCliAsync(repositoryRoot, commandArguments, environmentOverrides = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, "create-version", ...commandArguments], { cwd: repositoryRoot, env: commandEnvironment(environmentOverrides) });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.on("close", (status) => resolve({ status, output }));
  });
}

/**
 * Starts a fixture registry where {@link OWNER_TOKEN} owns `fixture-app`.
 *
 * @param {{ publishedVersions?: string[], rejectPublications?: boolean }} [options] - Versions already
 *   published (none means the package does not exist yet) and whether every publication fails with 404.
 * @returns {ReturnType<typeof startFixtureNpmRegistry>} Running registry.
 */
async function startOwnedRegistry({ publishedVersions = [], rejectPublications = false } = {}) {
  const registry = await startFixtureNpmRegistry({
    users: { [OWNER_TOKEN]: OWNER_USER },
    packages: publishedVersions.length > 0 ? { "fixture-app": { maintainers: [OWNER_USER], versions: publishedVersions } } : {},
    rejectPublications,
  });
  openRegistries.push(registry);
  return registry;
}

/** @param {string} registryUrl - Fixture registry. @returns {Record<string, unknown>} Manifest fields that publish there. */
function publishTo(registryUrl) {
  return { publishConfig: { registry: registryUrl } };
}

afterEach(async () => {
  for (const registry of openRegistries.splice(0)) {
    await registry.close();
  }
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
    "should look up published versions on the registry the project .npmrc selects when publishConfig declares none",
    async () => {
      const { repositoryRoot } = createReleasedRepository();
      writeFileSync(path.join(repositoryRoot, ".npmrc"), "registry=https://npm.example.test/plain/\n");
      /** @type {unknown[][]} */
      const lookups = [];

      await collectReleaseState({
        repositoryRoot,
        trackNpm: true,
        lookupNpm: async (...lookupArguments) => {
          lookups.push(lookupArguments);
          return { status: NPM_LOOKUP_STATUS.ok, publishedVersions: [], reason: null };
        },
      });

      expect(lookups).toEqual([["fixture-app", repositoryRoot, "https://npm.example.test/plain/"]]);
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
   * Runs a `--bump minor` release that publishes with the owner token to the fixture registry.
   *
   * @param {string} repositoryRoot - Checkout.
   * @returns {Promise<string>} Combined output, flattened.
   */
  async function runOwnerRelease(repositoryRoot) {
    return flattenOutput((await runCliAsync(repositoryRoot, ["--bump", "minor"], { NPM_TOKEN: OWNER_TOKEN })).output);
  }

  it(
    "should verify the npm-packed artifact against the npm pack --dry-run integrity, with the package name brought by syncing main",
    async () => {
      const registry = await startOwnedRegistry();
      const { repositoryRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      configureNpmPackArtifact(repositoryRoot);
      const renamedManifest = { name: "fixture-app-renamed", ...publishTo(registry.registryUrl), version: "0.1.0" };
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify(renamedManifest, null, 2)}\n`);
      runGit(["commit", "--quiet", "-am", "chore: rename package"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
      runGit(["reset", "--quiet", "--hard", "HEAD~1"], repositoryRoot);

      expect(await runOwnerRelease(repositoryRoot)).toContain("volvé a correr pnpm create-version");
      const output = await runOwnerRelease(repositoryRoot);

      expect(output).toContain(`npm auth ${OWNER_USER} (variable de entorno) · primera publicación`);
      expect(output).toContain("releases/fixture-app-renamed-0.2.0.tgz verificado (integrity de npm pack)");
      expect(output).not.toContain("No hay un artefacto preparado");
      expect(registry.publications).toEqual([{ packageName: "fixture-app-renamed", version: "0.2.0", user: OWNER_USER }]);
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
    "should stop right after syncing main without a new version, and release with the new configuration when run again",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "};"]);
      pushConfiguration(repositoryRoot, [
        'import { appendFileSync } from "node:fs";',
        `const log = ${JSON.stringify(hookLog)};`,
        "export default {",
        '  changelog: { audience: "equipo" },',
        '  prepare: ({ version }) => appendFileSync(log, `prepare ${version}\\n`),',
        "};",
      ]);
      const remoteMainSha = runGit(["rev-parse", "HEAD"], repositoryRoot);
      runGit(["reset", "--quiet", "--hard", "HEAD~1"], repositoryRoot);

      const synced = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(synced.status, synced.output).toBe(0);
      expect(synced.output).toContain("main se actualizó desde origin: volvé a correr pnpm create-version");
      expect(runGit(["rev-parse", "main"], repositoryRoot)).toBe(remoteMainSha);
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version).toBe("0.1.0");
      expect(existsSync(hookLog)).toBe(false);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(readFileSync(hookLog, "utf8")).toBe("prepare 0.2.0\n");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("v0.2.0");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should verify an artifact that npm would otherwise pack into itself, publish it and keep it at its path",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const { repositoryRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      configureNpmPackArtifact(repositoryRoot, "", { ignoreReleases: false });

      const output = await runOwnerRelease(repositoryRoot);

      expect(output).toContain("releases/fixture-app-0.2.0.tgz verificado (integrity de npm pack)");
      expect(output).toContain("v0.2.0 publicado");
      expect(registry.publications).toEqual([{ packageName: "fixture-app", version: "0.2.0", user: OWNER_USER }]);
      expect(existsSync(path.join(repositoryRoot, "releases", "fixture-app-0.2.0.tgz"))).toBe(true);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before publishing when prepare modifies a tracked file such as package.json",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      configureNpmPackArtifact(
        repositoryRoot,
        'const manifestPath = path.join(repositoryRoot, "package.json"); writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), version: "9.9.9" }));'
      );

      const output = await runOwnerRelease(repositoryRoot);

      expect(output).toContain("El paso de preparación modificó archivos versionados");
      expect(output).toContain("package.json");
      expect(registry.publications).toEqual([]);
      expect(JSON.parse(runGit(["show", "v0.2.0:package.json"], remoteRoot)).version).toBe("0.2.0");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
  it(
    "should stop before publishing when the prepared archive is not what npm packs from the release commit",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const { repositoryRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      configureNpmPackArtifact(
        repositoryRoot,
        'writeFileSync(path.join(repositoryRoot, "releases", "fixture-app-0.2.0.tgz"), "not an npm archive");'
      );

      const output = await runOwnerRelease(repositoryRoot);

      expect(output).toContain("El artefacto releases/fixture-app-0.2.0.tgz no se puede publicar");
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before publishing when the package relies on pnpm rewriting workspace dependencies",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const { repositoryRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      configureNpmPackArtifact(repositoryRoot);
      // `version` stays the last field so its line is unchanged and the commit is not taken as a release.
      const workspaceManifest = { name: "fixture-app", ...publishTo(registry.registryUrl), dependencies: { "fixture-lib": "workspace:^" }, version: "0.1.0" };
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify(workspaceManifest, null, 2)}
`);
      runGit(["commit", "--quiet", "-am", "feat: depend on workspace library"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const output = await runOwnerRelease(repositoryRoot);

      expect(output).toContain("Este paquete depende de reescrituras de pnpm");
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  /**
   * Lines of a configuration that tracks npm, publishes with `publish: "npm"` and logs `prepare`.
   *
   * @param {string} hookLog - File where `prepare` appends the version.
   * @returns {string[]} Lines of `beez-rp.config.js`.
   */
  function npmReleaseConfiguration(hookLog) {
    return [
      'import { appendFileSync } from "node:fs";',
      `const log = ${JSON.stringify(hookLog)};`,
      "export default {",
      '  changelog: { audience: "equipo" },',
      '  registry: "npm",',
      '  publish: "npm",',
      "  prepare: ({ version }) => appendFileSync(log, `prepare ${version}\\n`),",
      "};",
    ];
  }

  /**
   * Creates a home directory whose shared `~/.config/beez-rp/.env` holds a token.
   *
   * @param {string} token - `NPM_TOKEN` value.
   * @returns {NodeJS.ProcessEnv} `HOME` and `USERPROFILE` pointing at it.
   */
  function createHomeWithSharedToken(token) {
    const home = mkdtempSync(path.join(os.tmpdir(), "beez-rp-shared-home-"));
    temporaryDirectories.push(home);
    mkdirSync(path.join(home, ".config", "beez-rp"), { recursive: true });
    writeFileSync(path.join(home, ".config", "beez-rp", ".env"), `NPM_TOKEN=${token}\n`);
    return { HOME: home, USERPROFILE: home };
  }

  it(
    "should stop in the diagnosis, before touching the version, when NPM_TOKEN is invalid or missing",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(hookLog));

      const invalid = await runCliAsync(repositoryRoot, ["--bump", "minor"], { NPM_TOKEN: "expired-fixture-token" });
      const invalidOutput = flattenOutput(invalid.output);

      expect(invalid.status, invalid.output).toBe(0);
      expect(invalidOutput).toContain("npm auth token inválido o vencido (variable de entorno)");
      expect(invalidOutput).toContain("El NPM_TOKEN (variable de entorno) es inválido o venció");
      expect(invalidOutput).not.toContain("expired-fixture-token");

      const missing = flattenOutput((await runCliAsync(repositoryRoot, ["--bump", "minor"])).output);

      expect(missing).toContain("Falta NPM_TOKEN para publicar fixture-app");
      expect(missing).toContain("~/.config/beez-rp/.env");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(existsSync(hookLog)).toBe(false);
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should accept a package npm view and npm owner ls do not show as a first publication, warning that it may be a hidden private package",
    async () => {
      const registry = await startOwnedRegistry();
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(path.join(path.dirname(repositoryRoot), "hooks.log")));

      const preview = await runCliAsync(repositoryRoot, ["--bump", "minor", "--dry-run"], { NPM_TOKEN: OWNER_TOKEN });
      const output = flattenOutput(preview.output);

      expect(preview.status, preview.output).toBe(0);
      expect(output).toContain(`npm auth ${OWNER_USER} (variable de entorno) · primera publicación`);
      expect(output).toContain("4. Publicar en npm");
      expect(output).toContain("no muestra fixture-app (npm view y npm owner ls responden E404): se toma como primera publicación");
      expect(output).toContain("Si ya existe como paquete privado, el token (variable de entorno) no tiene acceso");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop in the diagnosis when npm view lists versions but npm owner ls answers E404 to the token",
    async () => {
      const registry = await startFixtureNpmRegistry({
        users: { [OWNER_TOKEN]: OWNER_USER },
        packages: { "fixture-app": { maintainers: ["fixture-other-owner"], versions: ["0.1.0"], hiddenFromOwnerList: true } },
      });
      openRegistries.push(registry);
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(hookLog));

      const release = await runCliAsync(repositoryRoot, ["--bump", "minor"], { NPM_TOKEN: OWNER_TOKEN });
      const output = flattenOutput(release.output);

      expect(release.status, release.output).toBe(0);
      expect(output).toContain(`npm auth ${OWNER_USER} no puede publicar fixture-app (variable de entorno)`);
      expect(output).toContain(`El token autentica como ${OWNER_USER}, que no puede publicar fixture-app`);
      expect(output).toContain("npm view lista versiones publicadas de fixture-app (1), pero npm owner ls respondió E404: el token no tiene acceso al paquete.");
      expect(output).not.toContain("primera publicación");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(existsSync(hookLog)).toBe(false);
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should say that the release is already on origin and only npm is missing when the publication fails after the push",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"], rejectPublications: true });
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(path.join(path.dirname(repositoryRoot), "hooks.log")));
      const sharedHome = createHomeWithSharedToken(OWNER_TOKEN);

      const release = await runCliAsync(repositoryRoot, ["--bump", "minor"], sharedHome);
      const output = flattenOutput(release.output);

      expect(release.status, release.output).toBe(1);
      expect(output).toContain(`npm auth ${OWNER_USER} (~/.config/beez-rp/.env)`);
      expect(output).toContain("npm publish terminó con código");
      expect(output).toContain(`autentican como ${OWNER_USER} y pueden publicar fixture-app`);
      expect(output).toContain("Un 404 Not Found de npm en el PUT suele significar falta de permisos");
      expect(output).toContain("v0.2.0 ya está en origin (main + tag); falta publicar en npm. Corré pnpm create-version para reintentar solo la publicación.");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("v0.2.0");

      const retry = flattenOutput((await runCliAsync(repositoryRoot, ["--dry-run"], sharedHome)).output);

      expect(retry).toContain("Plan · retomar el release pendiente");
      expect(retry).toContain("Publicar en npm (0.2.0)");
      expect(retry).not.toContain("Subir main");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not skip a last release missing from npm, and publish it from its tag with a detached HEAD",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const manifestFields = publishTo(registry.registryUrl);
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", manifestFields);
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(hookLog));
      commitVersion(repositoryRoot, "0.2.0", "0.2.0", manifestFields);
      runGit(["tag", "-a", "v0.2.0", "-m", "0.2.0"], repositoryRoot);
      commitVersion(repositoryRoot, "0.2.0", "Merge pull request #3 from fixture/feature", manifestFields);
      runGit(["push", "--quiet", "origin", "main", "refs/tags/v0.2.0"], repositoryRoot);
      const remoteMainSha = runGit(["rev-parse", "main"], remoteRoot);
      const ownerToken = { NPM_TOKEN: OWNER_TOKEN };

      const blocked = flattenOutput((await runCliAsync(repositoryRoot, ["--dry-run"], ownerToken)).output);

      expect(blocked).toContain("La versión 0.2.0 (último release, tag v0.2.0) no está en npm");
      expect(blocked).toContain("git switch --detach v0.2.0 y pnpm create-version, que retoma solo la preparación y la publicación desde el tag");

      const skipped = flattenOutput((await runCliAsync(repositoryRoot, ["--dry-run", "--skip-unpublished"], ownerToken)).output);

      expect(skipped).toContain("Se saltea 0.2.0 (tag v0.2.0), que no está en npm");
      expect(skipped).toContain("Elegir la nueva versión y crear commit + tag");

      runGit(["switch", "--quiet", "--detach", "v0.2.0"], repositoryRoot);
      const resumed = await runCliAsync(repositoryRoot, [], ownerToken);
      const resumedOutput = flattenOutput(resumed.output);

      expect(resumed.status, resumed.output).toBe(0);
      expect(resumedOutput).toContain("HEAD desacoplado en v0.2.0");
      expect(resumedOutput).toContain("v0.2.0 publicado");
      expect(readFileSync(hookLog, "utf8")).toBe("prepare 0.2.0\n");
      expect(registry.publications).toEqual([{ packageName: "fixture-app", version: "0.2.0", user: OWNER_USER }]);
      expect(runGit(["rev-parse", "main"], remoteRoot)).toBe(remoteMainSha);
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("v0.2.0");

      runGit(["switch", "--quiet", "main"], repositoryRoot);
      const next = flattenOutput((await runCliAsync(repositoryRoot, ["--dry-run"], ownerToken)).output);

      expect(next).toContain("Elegir la nueva versión y crear commit + tag");
      expect(next).not.toContain("no está en npm");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
});
