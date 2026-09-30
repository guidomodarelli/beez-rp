import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** Root of this beez-rp checkout, whose `bin` and `src` a fixture copies to play beez-rp releasing itself. */
const BEEZ_RP_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** @type {string[]} */
const temporaryDirectories = [];

/**
 * Tells whether this system lets the tests create symbolic links to files: Windows refuses them
 * without Developer Mode or elevated rights (directory junctions still work there).
 *
 * @returns {boolean} `true` when a file symbolic link can be created.
 */
function canCreateFileSymbolicLinks() {
  const probeRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-symlink-probe-"));

  try {
    writeFileSync(path.join(probeRoot, "target.txt"), "");
    symlinkSync(path.join(probeRoot, "target.txt"), path.join(probeRoot, "link.txt"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

/** Whether the tests that replace a module by a file symbolic link can run on this system. */
const FILE_SYMBOLIC_LINKS_SUPPORTED = canCreateFileSymbolicLinks();

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
  // FORCE_COLOR wins over NO_COLOR, and the ANSI codes it adds split the messages the tests match.
  delete environment.FORCE_COLOR;
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
 * @param {{ publishedVersions?: string[], rejectPublications?: boolean, rejectUnknownTokenReads?: boolean }} [options] - Versions
 *   already published (none means the package does not exist yet), whether every publication fails with 404
 *   and whether reads authenticated with an unknown token fail with 401.
 * @returns {ReturnType<typeof startFixtureNpmRegistry>} Running registry.
 */
async function startOwnedRegistry({ publishedVersions = [], rejectPublications = false, rejectUnknownTokenReads = false } = {}) {
  const registry = await startFixtureNpmRegistry({
    users: { [OWNER_TOKEN]: OWNER_USER },
    packages: publishedVersions.length > 0 ? { "fixture-app": { maintainers: [OWNER_USER], versions: publishedVersions } } : {},
    rejectPublications,
    rejectUnknownTokenReads,
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
    "should not resume a newer local release commit while the last release of origin is missing from npm",
    async () => {
      const { repositoryRoot } = createReleasedRepository();
      commitVersion(repositoryRoot, "0.2.0", "0.2.0");
      runGit(["tag", "-a", "v0.2.0", "-m", "0.2.0"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main", "refs/tags/v0.2.0"], repositoryRoot);
      commitVersion(repositoryRoot, "0.3.0", "0.3.0");
      runGit(["tag", "-a", "v0.3.0", "-m", "0.3.0"], repositoryRoot);
      const npmPackage = { checks: false, prepare: false, publish: true, publishTitle: "Publicar en npm" };

      const state = await collect(repositoryRoot, ["0.1.0"]);
      const blocked = buildReleasePlan(state, npmPackage);
      const skipped = buildReleasePlan(state, npmPackage, { skipUnpublished: true });

      expect(state.main.aheadCommits.map((commit) => commit.subject)).toEqual(["0.3.0"]);
      expect(blocked.mode).toBe(RELEASE_MODE.blocked);
      expect(blocked.blockers[0].title).toBe("La versión 0.2.0 (último release, tag v0.2.0) no está en npm");
      expect(skipped.mode).toBe(RELEASE_MODE.resume);
      expect(skipped.pendingVersion).toBe("0.3.0");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should read the commit a detached release tag points at on origin, and nothing while it is only local",
    async () => {
      const { repositoryRoot } = createReleasedRepository();
      commitVersion(repositoryRoot, "0.2.0", "0.2.0");
      runGit(["tag", "-a", "v0.2.0", "-m", "0.2.0"], repositoryRoot);
      runGit(["switch", "--quiet", "--detach", "v0.2.0"], repositoryRoot);
      const releaseSha = runGit(["rev-parse", "HEAD"], repositoryRoot);

      const localOnly = await collect(repositoryRoot, ["0.1.0"]);

      expect(localOnly.headReleaseTag).toBe("v0.2.0");
      expect(localOnly.remoteReleaseTagSha).toBeNull();
      expect(buildReleasePlan(localOnly, { checks: false, prepare: false, publish: true, publishTitle: "Publicar en npm" }).blockers[0].title).toContain(
        "v0.2.0 no está en origin"
      );

      runGit(["push", "--quiet", "origin", "refs/tags/v0.2.0"], repositoryRoot);
      const pushed = await collect(repositoryRoot, ["0.1.0"]);

      expect(pushed.headSha).toBe(releaseSha);
      expect(pushed.remoteReleaseTagSha).toBe(releaseSha);
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

      writeFileSync(path.join(repositoryRoot, "beez-rp.config.js"), 'export default { changelog: { audience: "equipo" }, checks: false };\n');
      runGit(["add", "beez-rp.config.js"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "chore: configure releases"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const preview = runCli(repositoryRoot, ["--dry-run"]);
      expect(preview.status).toBe(0);
      expect(preview.output).toContain("Plan");
      expect(preview.output).not.toContain("Validar el proyecto");
      expect(preview.output).toContain("--dry-run: no se cambió nada");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should block a new release without checks nor a ci script, and run pnpm run ci when the project declares it",
    () => {
      const unchecked = createReleasedRepository();
      pushConfiguration(unchecked.repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "};"]);

      const blocked = runCli(unchecked.repositoryRoot, ["--dry-run"]);
      expect(blocked.output).toContain("No se puede publicar todavía");
      expect(blocked.output).toContain("El proyecto no valida nada antes de publicar");
      expect(blocked.output).toContain("checks: false");

      const checked = createReleasedRepository("0.1.0", { scripts: { ci: "node --version" } });
      pushConfiguration(checked.repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "};"]);

      const preview = runCli(checked.repositoryRoot, ["--dry-run"]);
      expect(preview.status, preview.output).toBe(0);
      expect(preview.output).toContain("Validar el proyecto");
      expect(preview.output).not.toContain("El proyecto no valida nada antes de publicar");
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

  it(
    "should write the new version into the marked versionFiles within the release commit, and stop before bumping when a file has no marker",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      mkdirSync(path.join(repositoryRoot, "src"));
      writeFileSync(path.join(repositoryRoot, "src", "cli.js"), 'program.version("0.1.0"); // x-release-please-version\nconst untouched = "0.1.0";\n');
      writeFileSync(path.join(repositoryRoot, "src", "plain.js"), 'export const VERSION = "0.1.0";\n');
      writeFileSync(
        path.join(repositoryRoot, "beez-rp.config.js"),
        ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js", "src/plain.js"],', "};", ""].join("\n")
      );
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "chore: configure releases"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);
      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("src/plain.js (versionFiles) no tiene ninguna versión marcada para actualizar.");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version).toBe("0.1.0");

      writeFileSync(path.join(repositoryRoot, "src", "plain.js"), 'export const VERSION = "0.1.0"; // beez-rp-version\n');
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "chore: mark the version"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(runGit(["show", "--name-only", "--format=", "main"], remoteRoot).split("\n").toSorted()).toEqual(["CHANGELOG.md", "package.json", "src/cli.js", "src/plain.js"]);
      expect(runGit(["show", "main:src/cli.js"], remoteRoot)).toBe('program.version("0.2.0"); // x-release-please-version\nconst untouched = "0.1.0";');
      expect(runGit(["show", "main:src/plain.js"], remoteRoot)).toBe('export const VERSION = "0.2.0"; // beez-rp-version');
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before bumping when a versionFiles block is never closed, instead of rewriting every later version",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const installPath = path.join(repositoryRoot, "INSTALL.md");
      const installContent = "<!-- beez-rp-start-version -->\nnpm i fixture-app@0.1.0\n<!-- beez-rp-finish -->\nRequires other-tool@0.1.0.\n";
      writeFileSync(installPath, installContent);
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["INSTALL.md"],', "};"]);

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("INSTALL.md (versionFiles) abre un bloque de versión con beez-rp-start-version en la línea 1 y nunca lo cierra.");
      expect(flattenOutput(blocked.output)).toContain("Cerralo con beez-rp-end");
      expect(readFileSync(installPath, "utf8")).toBe(installContent);
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version).toBe("0.1.0");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not push a release commit whose versionFiles entry closes a block with the other tool's end marker",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      writeFileSync(path.join(repositoryRoot, "INSTALL.md"), "# x-release-please-start-version\nnpm i fixture-app@0.2.0\n# beez-rp-end\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["INSTALL.md"],', "};"]);
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-app", version: "0.2.0" }, null, 2)}\n`);
      writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-01-01\n\n### Added\n\n- Algo nuevo.\n");
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "0.2.0"], repositoryRoot);

      const blocked = runCli(repositoryRoot, []);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain(
        "INSTALL.md (versionFiles) cierra con beez-rp-end en la línea 3 el bloque que abrió x-release-please-start-version en la línea 1."
      );
      expect(flattenOutput(blocked.output)).toContain("Cambiá beez-rp-end por x-release-please-end");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("chore: configure releases");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stage a versionFiles entry whose name starts with a dash as a file, not as a Git option",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      writeFileSync(path.join(repositoryRoot, "-version.txt"), "0.1.0 # beez-rp-version\n");
      writeFileSync(
        path.join(repositoryRoot, "beez-rp.config.js"),
        ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["-version.txt"],', "};", ""].join("\n")
      );
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "chore: configure releases"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(runGit(["show", "--name-only", "--format=", "main"], remoteRoot).split("\n").toSorted()).toEqual(["-version.txt", "CHANGELOG.md", "package.json"]);
      expect(runGit(["show", "main:-version.txt"], remoteRoot)).toBe("0.2.0 # beez-rp-version");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before bumping when a versionFiles entry goes through a symbolic link, leaving the linked target untouched",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const externalRoot = path.join(path.dirname(repositoryRoot), "external");
      const externalFile = path.join(externalRoot, "cli.js");
      mkdirSync(externalRoot);
      writeFileSync(externalFile, 'export const VERSION = "0.1.0"; // beez-rp-version\n');
      // A junction on Windows: it needs no symlink privilege and Node reports it as a symbolic link too.
      symlinkSync(externalRoot, path.join(repositoryRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
      appendFileSync(path.join(repositoryRoot, ".git", "info", "exclude"), "linked\n");
      writeFileSync(
        path.join(repositoryRoot, "beez-rp.config.js"),
        ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["linked/cli.js"],', "};", ""].join("\n")
      );
      runGit(["add", "beez-rp.config.js"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "chore: configure releases"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("linked/cli.js (versionFiles) pasa por el enlace simbólico linked");
      expect(readFileSync(externalFile, "utf8")).toBe('export const VERSION = "0.1.0"; // beez-rp-version\n');
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version).toBe("0.1.0");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not push a release commit created by hand while a versionFiles entry still carries the previous version",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      mkdirSync(path.join(repositoryRoot, "src"));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js"],', "};"]);
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-app", version: "0.2.0" }, null, 2)}\n`);
      writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-01-01\n\n### Added\n\n- Algo nuevo.\n");
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "0.2.0"], repositoryRoot);

      const blocked = runCli(repositoryRoot, []);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("src/cli.js (versionFiles) tiene en el commit de release (HEAD) una versión marcada distinta de 0.2.0.");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("chore: configure releases");

      writeFileSync(cliPath, 'program.version("0.2.0"); // beez-rp-version\n');
      runGit(["commit", "--quiet", "--amend", "--no-edit", "-a"], repositoryRoot);

      const resumed = runCli(repositoryRoot, []);

      expect(resumed.status, resumed.output).toBe(0);
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("v0.2.0");
      expect(runGit(["show", "main:src/cli.js"], remoteRoot)).toBe('program.version("0.2.0"); // beez-rp-version');
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before writing anything when a versionFiles entry is ignored by Git, instead of failing at git add with the files rewritten",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const generatedPath = path.join(repositoryRoot, "dist", "cli.js");
      const generatedContent = 'program.version("0.1.0"); // beez-rp-version\n';
      writeFileSync(path.join(repositoryRoot, ".gitignore"), "dist/\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["dist/cli.js"],', "};"]);
      mkdirSync(path.dirname(generatedPath));
      writeFileSync(generatedPath, generatedContent);

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("dist/cli.js (versionFiles) no está trackeado en Git");
      expect(flattenOutput(blocked.output)).toContain("git add -f");
      expect(readFileSync(generatedPath, "utf8")).toBe(generatedContent);
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should read a versionFiles entry written with backslashes as the same file on every platform, and name it with slashes",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, 'program.version("0.1.0");\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", `  versionFiles: [${JSON.stringify(".\\src\\cli.js")}],`, "};"]);

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("src/cli.js (versionFiles) no tiene ninguna versión marcada para actualizar.");

      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      runGit(["commit", "--quiet", "-am", "chore: mark the version"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(runGit(["show", "main:src/cli.js"], remoteRoot)).toBe('program.version("0.2.0"); // beez-rp-version');
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not resume a release commit with --ignore-local-changes while a versionFiles directory was replaced locally by a symbolic link, touching nothing",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const sourceRoot = path.join(repositoryRoot, "src");
      const externalRoot = path.join(path.dirname(repositoryRoot), "external");
      mkdirSync(sourceRoot);
      writeFileSync(path.join(sourceRoot, "cli.js"), 'program.version("0.1.0"); // beez-rp-version\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js"],', "};"]);
      writeFileSync(path.join(sourceRoot, "cli.js"), 'program.version("0.2.0"); // beez-rp-version\n');
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-app", version: "0.2.0" }, null, 2)}\n`);
      writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-01-01\n\n### Added\n\n- Algo nuevo.\n");
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "0.2.0"], repositoryRoot);
      // The tracked directory becomes a link to an outside copy (a junction on Windows: no symlink privilege needed).
      mkdirSync(externalRoot);
      writeFileSync(path.join(externalRoot, "cli.js"), 'program.version("9.9.9"); // beez-rp-version\n');
      rmSync(sourceRoot, { recursive: true });
      symlinkSync(externalRoot, sourceRoot, process.platform === "win32" ? "junction" : "dir");

      const blocked = runCli(repositoryRoot, ["--ignore-local-changes"]);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("--ignore-local-changes no aparta cambios con enlaces simbólicos: src.");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
      expect(readFileSync(path.join(sourceRoot, "cli.js"), "utf8")).toBe('program.version("9.9.9"); // beez-rp-version\n');
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not resume a release commit with --ignore-local-changes while a local edit of the configuration drops a stale versionFiles entry",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const configPath = path.join(repositoryRoot, "beez-rp.config.js");
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js"],', "};"]);
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-app", version: "0.2.0" }, null, 2)}\n`);
      writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-01-01\n\n### Added\n\n- Algo nuevo.\n");
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "0.2.0"], repositoryRoot);
      const localConfig = ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", "};", ""].join("\n");
      writeFileSync(configPath, localConfig);

      for (const flags of [["--ignore-local-changes", "--dry-run"], ["--ignore-local-changes"]]) {
        const blocked = runCli(repositoryRoot, flags);

        expect(blocked.status, blocked.output).toBe(0);
        expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear y el release 0.2.0 ya está commiteado");
      }

      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("chore: configure releases");
      expect(readFileSync(configPath, "utf8")).toBe(localConfig);

      runGit(["restore", "beez-rp.config.js"], repositoryRoot);
      const resumed = runCli(repositoryRoot, ["--ignore-local-changes"]);

      expect(resumed.status, resumed.output).toBe(1);
      expect(flattenOutput(resumed.output)).toContain("src/cli.js (versionFiles) tiene en el commit de release (HEAD) una versión marcada distinta de 0.2.0.");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not resume a release commit with --ignore-local-changes while the configuration is renamed from .js to .mjs without committing",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js"],', "};"]);
      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-app", version: "0.2.0" }, null, 2)}\n`);
      writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-01-01\n\n### Added\n\n- Algo nuevo.\n");
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "0.2.0"], repositoryRoot);
      runGit(["mv", "beez-rp.config.js", "beez-rp.config.mjs"], repositoryRoot);

      const blocked = runCli(repositoryRoot, ["--ignore-local-changes"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear y el release 0.2.0 ya está commiteado");
      expect(flattenOutput(blocked.output)).toContain("R beez-rp.config.js -> beez-rp.config.mjs");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("chore: configure releases");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not start nor resume a release while an ignored beez-rp.config.mjs shadows the committed beez-rp.config.js",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      writeFileSync(path.join(repositoryRoot, ".gitignore"), "beez-rp.config.mjs\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js"],', "};"]);
      writeFileSync(path.join(repositoryRoot, "beez-rp.config.mjs"), ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", "};", ""].join("\n"));

      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");

      const newRelease = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(newRelease.status, newRelease.output).toBe(0);
      expect(flattenOutput(newRelease.output)).toContain("beez-rp.config.mjs (no está commiteado: Git lo ignora, nunca se agregó o solo está en staging)");
      expect(flattenOutput(newRelease.output)).toContain("beez-rp.config.mjs no está commiteado");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");

      writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-app", version: "0.2.0" }, null, 2)}\n`);
      writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-01-01\n\n### Added\n\n- Algo nuevo.\n");
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "0.2.0"], repositoryRoot);

      const resumed = runCli(repositoryRoot, []);

      expect(resumed.status, resumed.output).toBe(0);
      expect(flattenOutput(resumed.output)).toContain("La configuración tiene cambios sin commitear y el release 0.2.0 ya está commiteado");
      expect(flattenOutput(resumed.output)).toContain("beez-rp.config.mjs (no está commiteado: Git lo ignora, nunca se agregó o solo está en staging)");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("chore: configure releases");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before writing the version when a versionFiles entry has a .gitattributes clean filter, leaving the release files untouched",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const filterScriptPath = path.join(repositoryRoot, ".git", "pin-version-filter.cjs");
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js"],', "};"]);
      // A clean filter that stores every version as 0.1.0, whatever the working tree says.
      writeFileSync(
        filterScriptPath,
        'let input = ""; process.stdin.setEncoding("utf8").on("data", (chunk) => (input += chunk)).on("end", () => process.stdout.write(input.replace(/\\d+\\.\\d+\\.\\d+/gu, "0.1.0")));\n'
      );
      runGit(["config", "filter.pin-version.clean", `"${process.execPath.replaceAll("\\", "/")}" "${filterScriptPath.replaceAll("\\", "/")}"`], repositoryRoot);
      writeFileSync(path.join(repositoryRoot, ".git", "info", "attributes"), "src/cli.js filter=pin-version\n");

      const manifest = readFileSync(path.join(repositoryRoot, "package.json"), "utf8");

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain("src/cli.js tiene un atributo filter en .gitattributes");
      expect(readFileSync(cliPath, "utf8")).toBe('program.version("0.1.0"); // beez-rp-version\n');
      expect(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).toBe(manifest);
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("chore: configure releases");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should restore package.json, CHANGELOG.md and earlier versionFiles when a later versionFiles entry cannot be written",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const lockedPath = path.join(repositoryRoot, "src", "locked.js");
      const markedContent = 'program.version("0.1.0"); // beez-rp-version\n';
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, markedContent);
      writeFileSync(lockedPath, markedContent);
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js", "src/locked.js"],', "};"]);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"), "utf8");
      const changelog = readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
      // Read-only: a mode on POSIX and the read-only attribute on Windows, both reject the write.
      chmodSync(lockedPath, 0o444);

      try {
        const release = runCli(repositoryRoot, ["--bump", "minor"]);

        expect(release.status, release.output).toBe(1);
        expect(flattenOutput(release.output)).toContain("No se pudo escribir src/locked.js para el release");
        expect(flattenOutput(release.output)).toContain("se restauraron package.json, CHANGELOG.md y versionFiles");
      } finally {
        chmodSync(lockedPath, 0o644);
      }

      expect(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).toBe(manifest);
      expect(readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8")).toBe(changelog);
      expect(readFileSync(cliPath, "utf8")).toBe(markedContent);
      expect(readFileSync(lockedPath, "utf8")).toBe(markedContent);
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should restore the release files and the staging when the release commit fails, whatever the versionFiles names hold",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      // Names a shell or Git would interpret: spaces, cmd.exe `%VAR%`, PowerShell `$var` and, where the file system allows it, pathspec magic.
      const versionFiles = ["docs/my version %PATH% $HOME.txt", ...(process.platform === "win32" ? [] : [":version"])];
      mkdirSync(path.join(repositoryRoot, "docs"));
      for (const versionFile of versionFiles) writeFileSync(path.join(repositoryRoot, versionFile), "0.1.0 <!-- beez-rp-version -->\n");
      writeFileSync(path.join(repositoryRoot, "notes.txt"), "notas\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", `  versionFiles: ${JSON.stringify(versionFiles)},`, "};"]);
      // An index flag outside the release files, which the rollback must keep.
      runGit(["update-index", "--skip-worktree", "--", "notes.txt"], repositoryRoot);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"), "utf8");
      const stagedChangelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Algo nuevo.\n- Algo más.\n";
      writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), stagedChangelog);
      runGit(["add", "CHANGELOG.md"], repositoryRoot);
      writeFileSync(path.join(repositoryRoot, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain("El commit de versión falló");
      expect(flattenOutput(release.output)).toContain("se restauraron package.json, CHANGELOG.md y versionFiles (contenido y staging)");
      expect(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).toBe(manifest);
      expect(readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8")).toBe(stagedChangelog);
      for (const versionFile of versionFiles) expect(readFileSync(path.join(repositoryRoot, versionFile), "utf8")).toBe("0.1.0 <!-- beez-rp-version -->\n");
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("M  CHANGELOG.md");
      expect(runGit(["ls-files", "-v", "--", "notes.txt"], repositoryRoot)).toBe("S notes.txt");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should undo the release commit without tagging it when a commit hook stages another change, and leave that change staged",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      writeFileSync(path.join(repositoryRoot, "VERSION.txt"), "0.1.0 <!-- beez-rp-version -->\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["VERSION.txt"],', "};"]);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"), "utf8");
      const changelog = readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
      // The hook edits the configuration and stages it, so a plain `git commit` would take it along.
      writeFileSync(path.join(repositoryRoot, ".git", "hooks", "pre-commit"), '#!/bin/sh\necho "// added by a hook" >> beez-rp.config.js\ngit add beez-rp.config.js\n', { mode: 0o755 });

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain("El commit de versión 0.2.0 incluía cambios que beez-rp no preparó: beez-rp.config.js");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("M  beez-rp.config.js");
      expect(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).toBe(manifest);
      expect(readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8")).toBe(changelog);
      expect(readFileSync(path.join(repositoryRoot, "VERSION.txt"), "utf8")).toBe("0.1.0 <!-- beez-rp-version -->\n");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should undo the release commit without tagging it when a commit hook rewrites and re-stages a versionFiles entry",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      writeFileSync(path.join(repositoryRoot, "VERSION.txt"), "0.1.0 <!-- beez-rp-version -->\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["VERSION.txt"],', "};"]);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"), "utf8");
      const changelog = readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
      // A formatter-like hook: it keeps the marked version but adds a line outside it and re-stages the file.
      writeFileSync(path.join(repositoryRoot, ".git", "hooks", "pre-commit"), '#!/bin/sh\necho "formatted" >> VERSION.txt\ngit add VERSION.txt\n', { mode: 0o755 });

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain("El commit de versión 0.2.0 incluía cambios que beez-rp no preparó: VERSION.txt");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");
      expect(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).toBe(manifest);
      expect(readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8")).toBe(changelog);
      expect(readFileSync(path.join(repositoryRoot, "VERSION.txt"), "utf8")).toBe("0.1.0 <!-- beez-rp-version -->\n");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release nor plan it in --dry-run while skip-worktree or assume-unchanged hides a local edit of the configuration or a module it imports",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const helperPath = path.join(repositoryRoot, "release", "version-files.js");
      mkdirSync(path.dirname(cliPath));
      mkdirSync(path.dirname(helperPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      writeFileSync(helperPath, 'export const versionFiles = ["src/cli.js"];\n');
      pushConfiguration(repositoryRoot, [
        'import { versionFiles } from "./release/version-files.js";',
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        "  versionFiles,",
        "};",
      ]);
      const hiddenEdits = [
        { hiddenFile: "release/version-files.js", indexFlag: "--skip-worktree", localEdit: () => writeFileSync(helperPath, "export const versionFiles = [];\n") },
        { hiddenFile: "beez-rp.config.js", indexFlag: "--assume-unchanged", localEdit: () => appendFileSync(path.join(repositoryRoot, "beez-rp.config.js"), "// local\n") },
      ];

      for (const { hiddenFile, indexFlag, localEdit } of hiddenEdits) {
        runGit(["update-index", indexFlag, "--", hiddenFile], repositoryRoot);
        localEdit();
        expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");

        for (const commandArguments of [["--dry-run"], ["--bump", "minor", "--ignore-local-changes"]]) {
          const blocked = runCli(repositoryRoot, commandArguments);

          expect(blocked.status, blocked.output).toBe(0);
          expect(flattenOutput(blocked.output)).toContain("Hay 1 archivo(s) con cambios locales que git status no muestra");
          expect(flattenOutput(blocked.output)).toContain(hiddenFile);
        }

        runGit(["update-index", indexFlag.replace("--", "--no-"), "--", hiddenFile], repositoryRoot);
        runGit(["restore", "--", hiddenFile], repositoryRoot);
      }

      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release nor plan it in --dry-run while skip-worktree hides that a tracked file was replaced by a symbolic link",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const guidePath = path.join(repositoryRoot, "docs", "guide");
      const externalRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-external-"));
      temporaryDirectories.push(externalRoot);
      mkdirSync(path.dirname(guidePath));
      writeFileSync(guidePath, "guía commiteada\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", "};"]);
      runGit(["update-index", "--skip-worktree", "--", "docs/guide"], repositoryRoot);
      rmSync(guidePath);
      // A directory link works on every system (a junction on Windows); for Git it replaces a regular file all the same.
      symlinkSync(externalRoot, guidePath, process.platform === "win32" ? "junction" : "dir");

      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");

      for (const commandArguments of [["--dry-run"], ["--bump", "minor", "--ignore-local-changes"]]) {
        const blocked = runCli(repositoryRoot, commandArguments);

        expect(blocked.status, blocked.output).toBe(0);
        expect(flattenOutput(blocked.output)).toContain("Hay 1 archivo(s) con cambios locales que git status no muestra");
        expect(flattenOutput(blocked.output)).toContain("docs/guide (no es el mismo tipo de archivo que en HEAD, por ejemplo un enlace simbólico)");
      }

      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it.skipIf(!FILE_SYMBOLIC_LINKS_SUPPORTED)(
    "should not release with --ignore-local-changes while a module the configuration imports was replaced by a symbolic link to a file outside the repository",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const helperPath = path.join(repositoryRoot, "release", "version-files.js");
      const externalRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-external-"));
      const externalHelperPath = path.join(externalRoot, "version-files.js");
      temporaryDirectories.push(externalRoot);
      mkdirSync(path.dirname(cliPath));
      mkdirSync(path.dirname(helperPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      writeFileSync(helperPath, 'export const versionFiles = ["src/cli.js"];\n');
      pushConfiguration(repositoryRoot, [
        'import { versionFiles } from "./release/version-files.js";',
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        "  versionFiles,",
        "};",
      ]);
      writeFileSync(externalHelperPath, "export const versionFiles = [];\n");
      rmSync(helperPath);
      symlinkSync(externalHelperPath, helperPath, "file");

      const blocked = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear");
      expect(flattenOutput(blocked.output)).toContain("release/version-files.js (no es el mismo tipo de archivo que en HEAD, por ejemplo un enlace simbólico)");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release with --ignore-local-changes while a directory holding a module the configuration imports was replaced by a link to a directory outside the repository",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const releaseDirectory = path.join(repositoryRoot, "release");
      const externalRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-external-"));
      temporaryDirectories.push(externalRoot);
      mkdirSync(path.dirname(cliPath));
      mkdirSync(releaseDirectory);
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      writeFileSync(path.join(releaseDirectory, "version-files.js"), 'export const versionFiles = ["src/cli.js"];\n');
      pushConfiguration(repositoryRoot, [
        'import { versionFiles } from "./release/version-files.js";',
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        "  versionFiles,",
        "};",
      ]);
      // Only the directory is a link: the module path itself resolves to a regular file outside the repository.
      writeFileSync(path.join(externalRoot, "version-files.js"), "export const versionFiles = [];\n");
      rmSync(releaseDirectory, { recursive: true });
      symlinkSync(externalRoot, releaseDirectory, process.platform === "win32" ? "junction" : "dir");

      const blocked = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear");
      expect(flattenOutput(blocked.output)).toContain("release (no es el mismo tipo de archivo que en HEAD, por ejemplo un enlace simbólico)");
      expect(flattenOutput(blocked.output)).toContain("está fuera del repositorio, por ejemplo detrás de un enlace simbólico, y HEAD no lo respalda");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before writing the version when a release file matching HEAD is marked skip-worktree or assume-unchanged, keeping its mark even if the release commit would fail",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      writeFileSync(path.join(repositoryRoot, "VERSION.txt"), "0.1.0 <!-- beez-rp-version -->\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["VERSION.txt"],', "};"]);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"), "utf8");
      // A failing commit would make the rollback reset these index entries.
      const preCommitHookPath = path.join(repositoryRoot, ".git", "hooks", "pre-commit");
      writeFileSync(preCommitHookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      for (const { releaseFile, indexFlag, listedTag } of [
        { releaseFile: "VERSION.txt", indexFlag: "--skip-worktree", listedTag: "S" },
        { releaseFile: "package.json", indexFlag: "--assume-unchanged", listedTag: "h" },
      ]) {
        runGit(["update-index", indexFlag, "--", releaseFile], repositoryRoot);

        const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

        expect(blocked.status, blocked.output).toBe(1);
        expect(flattenOutput(blocked.output)).toContain(`${releaseFile} tiene la marca skip-worktree o assume-unchanged en el índice`);
        expect(flattenOutput(blocked.output)).toContain(`git update-index --no-skip-worktree -- ${releaseFile} y git update-index --no-assume-unchanged -- ${releaseFile}`);
        expect(runGit(["ls-files", "-v", "--", releaseFile], repositoryRoot)).toBe(`${listedTag} ${releaseFile}`);
        expect(readFileSync(path.join(repositoryRoot, "VERSION.txt"), "utf8")).toBe("0.1.0 <!-- beez-rp-version -->\n");
        expect(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).toBe(manifest);

        // The commands the hint gives: Git applies a single flag option per update-index call.
        runGit(["update-index", "--no-skip-worktree", "--", releaseFile], repositoryRoot);
        runGit(["update-index", "--no-assume-unchanged", "--", releaseFile], repositoryRoot);
      }

      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");

      rmSync(preCommitHookPath);
      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(runGit(["show", "main:VERSION.txt"], remoteRoot)).toBe("0.2.0 <!-- beez-rp-version -->");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release nor plan it in --dry-run while the committed configuration imports an ignored local override that git status does not list",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const overridePath = path.join(repositoryRoot, "release", "local-overrides.js");
      mkdirSync(path.dirname(cliPath));
      mkdirSync(path.dirname(overridePath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      writeFileSync(path.join(repositoryRoot, ".gitignore"), "release/local-overrides.js\n");
      pushConfiguration(repositoryRoot, [
        'import { existsSync } from "node:fs";',
        'const overrideUrl = new URL("./release/local-overrides.js", import.meta.url);',
        "const overrides = existsSync(overrideUrl) ? (await import(overrideUrl.href)).default : {};",
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        '  versionFiles: ["src/cli.js"],',
        "  ...overrides,",
        "};",
      ]);
      writeFileSync(overridePath, "export default { versionFiles: [] };\n");

      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");

      for (const commandArguments of [["--dry-run"], ["--bump", "minor"]]) {
        const blocked = runCli(repositoryRoot, commandArguments);

        expect(blocked.status, blocked.output).toBe(0);
        expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear");
        expect(flattenOutput(blocked.output)).toContain("release/local-overrides.js (no está commiteado: Git lo ignora, nunca se agregó o solo está en staging)");
      }

      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");

      rmSync(overridePath);
      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(runGit(["show", "main:src/cli.js"], remoteRoot)).toBe('program.version("0.2.0"); // beez-rp-version');
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before bumping when a versionFiles entry is not valid UTF-8, and keep every byte but the version of a UTF-8 file with a byte order mark",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const legacyPath = path.join(repositoryRoot, "docs", "legacy.txt");
      const latin1Content = Buffer.from("Versión 0.1.0 <!-- beez-rp-version -->\r\nÚltima línea\r\n", "latin1");
      mkdirSync(path.dirname(legacyPath));
      writeFileSync(legacyPath, latin1Content);
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["docs/legacy.txt"],', "};"]);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"));

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("docs/legacy.txt (versionFiles) no es texto UTF-8 válido (línea 1)");
      expect(readFileSync(legacyPath).equals(latin1Content)).toBe(true);
      expect(readFileSync(path.join(repositoryRoot, "package.json")).equals(manifest)).toBe(true);
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");

      const byteOrderMark = Buffer.from([0xef, 0xbb, 0xbf]);
      writeFileSync(legacyPath, Buffer.concat([byteOrderMark, Buffer.from("Versión 0.1.0 <!-- beez-rp-version -->\r\nÚltima línea\r\n", "utf8")]));
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "chore: convert to UTF-8"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(runGit(["show", "main:docs/legacy.txt"], remoteRoot)).toContain("Versión 0.2.0 <!-- beez-rp-version -->");
      expect(readFileSync(legacyPath).equals(Buffer.concat([byteOrderMark, Buffer.from("Versión 0.2.0 <!-- beez-rp-version -->\r\nÚltima línea\r\n", "utf8")]))).toBe(true);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before bumping when a check changed a versionFiles entry beyond its version, instead of committing that change in the release",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const markedContent = 'program.version("0.1.0"); // beez-rp-version\n';
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, markedContent);
      // Stands in for `lint --fix`: the check rewrites a line of the version file that is not the version.
      writeFileSync(path.join(repositoryRoot, "lint-fix.mjs"), 'import { appendFileSync } from "node:fs";\nappendFileSync("src/cli.js", "// fixed by lint\\n");\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', '  checks: ["node lint-fix.mjs"],', '  versionFiles: ["src/cli.js"],', "};"]);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain("src/cli.js cambió respecto de HEAD antes de escribir la versión");
      expect(readFileSync(cliPath, "utf8")).toBe(`${markedContent}// fixed by lint\n`);
      expect(JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version).toBe("0.1.0");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before bumping when a versionFiles entry is a hard link to package.json, instead of undoing the bumped version",
    () => {
      const { repositoryRoot } = createReleasedRepository("0.1.0", { description: "Versión 0.1.0 // beez-rp-version" });
      linkSync(path.join(repositoryRoot, "package.json"), path.join(repositoryRoot, "manifest-copy.json"));
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["manifest-copy.json"],', "};"]);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"));

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain("package.json tiene otro enlace duro (2 enlaces al mismo archivo)");
      expect(readFileSync(path.join(repositoryRoot, "package.json")).equals(manifest)).toBe(true);
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before bumping when a versionFiles entry is a hard link to a file outside the repository, instead of writing through it",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const markedContent = "0.1.0 <!-- beez-rp-version -->\n";
      const outsidePath = path.join(path.dirname(repositoryRoot), "outside-version.txt");
      writeFileSync(path.join(repositoryRoot, "VERSION.txt"), markedContent);
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["VERSION.txt"],', "};"]);
      linkSync(path.join(repositoryRoot, "VERSION.txt"), outsidePath);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain("VERSION.txt (versionFiles) tiene otro enlace duro (2 enlaces al mismo archivo)");
      expect(readFileSync(outsidePath, "utf8")).toBe(markedContent);
      expect(JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version).toBe("0.1.0");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release with --ignore-local-changes, nor plan it in --dry-run, while a local edit of a module the configuration imports drops a versionFiles entry",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const helperPath = path.join(repositoryRoot, "release", "version-files.js");
      mkdirSync(path.dirname(cliPath));
      mkdirSync(path.dirname(helperPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      writeFileSync(helperPath, 'export const versionFiles = ["src/cli.js"];\n');
      pushConfiguration(repositoryRoot, [
        'import { versionFiles } from "./release/version-files.js";',
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        "  versionFiles,",
        "};",
      ]);
      const localHelper = "export const versionFiles = [];\n";
      writeFileSync(helperPath, localHelper);

      for (const commandArguments of [["--dry-run", "--ignore-local-changes"], ["--bump", "minor", "--ignore-local-changes"]]) {
        const blocked = runCli(repositoryRoot, commandArguments);

        expect(blocked.status, blocked.output).toBe(0);
        expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear");
        expect(flattenOutput(blocked.output)).toContain("release/version-files.js (su contenido es distinto del de HEAD)");
      }

      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(readFileSync(helperPath, "utf8")).toBe(localHelper);
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");

      runGit(["restore", "release/version-files.js"], repositoryRoot);
      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(runGit(["show", "main:src/cli.js"], remoteRoot)).toBe('program.version("0.2.0"); // beez-rp-version');
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not apply migrations with --ignore-local-changes while a local edit of the module that defines them is uncommitted",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const migrationsLog = path.join(path.dirname(repositoryRoot), "migrations.log");
      const helperPath = path.join(repositoryRoot, "release", "migrations.js");
      const describeMigrations = (/** @type {string} */ status, /** @type {string} */ appliedMarker) =>
        [
          'import { appendFileSync } from "node:fs";',
          "export const migrations = {",
          `  check: () => ({ status: "${status}", pending: ${status === "pending" ? '["001-local"]' : "[]"}, target: "fixture-db", reason: null }),`,
          `  apply: () => appendFileSync(${JSON.stringify(migrationsLog)}, "${appliedMarker}\\n"),`,
          "};",
          "",
        ].join("\n");
      mkdirSync(path.dirname(helperPath));
      writeFileSync(helperPath, describeMigrations("up-to-date", "committed"));
      pushConfiguration(repositoryRoot, [
        'import { migrations } from "./release/migrations.js";',
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        "  migrations,",
        "};",
      ]);
      writeFileSync(helperPath, describeMigrations("pending", "uncommitted"));

      const blocked = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("release/migrations.js (su contenido es distinto del de HEAD)");
      expect(existsSync(migrationsLog)).toBe(false);
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not apply migrations with --ignore-local-changes while migrations.check lazily imports a module with an uncommitted edit",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const migrationsLog = path.join(path.dirname(repositoryRoot), "migrations.log");
      const helperPath = path.join(repositoryRoot, "release", "migration-runner.js");
      const describeRunner = (/** @type {string} */ appliedMarker) =>
        [
          'import { appendFileSync } from "node:fs";',
          'export const readStatus = () => ({ status: "pending", pending: ["001-local"], target: "fixture-db", reason: null });',
          `export const apply = () => appendFileSync(${JSON.stringify(migrationsLog)}, "${appliedMarker}\\n");`,
          "",
        ].join("\n");
      mkdirSync(path.dirname(helperPath));
      writeFileSync(helperPath, describeRunner("committed"));
      // The configuration never imports the runner: only migrations.check does, when the diagnosis calls it.
      pushConfiguration(repositoryRoot, [
        "const loadRunner = () => import(\"./release/migration-runner.js\");",
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        "  migrations: {",
        "    check: async () => (await loadRunner()).readStatus(),",
        "    apply: async () => (await loadRunner()).apply(),",
        "  },",
        "};",
      ]);
      writeFileSync(helperPath, describeRunner("uncommitted"));

      const blocked = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear");
      expect(flattenOutput(blocked.output)).toContain("release/migration-runner.js (su contenido es distinto del de HEAD)");
      expect(existsSync(migrationsLog)).toBe(false);
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release with --ignore-local-changes while the configuration imports, only for the arguments of the running command, a module with an uncommitted edit",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const helperPath = path.join(repositoryRoot, "release", "bump-settings.js");
      mkdirSync(path.dirname(cliPath));
      mkdirSync(path.dirname(helperPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      writeFileSync(helperPath, 'export default { versionFiles: ["src/cli.js"] };\n');
      // Depends on the process that loads it, like a configuration that checks process.stdin.isTTY.
      pushConfiguration(repositoryRoot, [
        'const bumpSettings = process.argv.includes("--bump") ? (await import("./release/bump-settings.js")).default : {};',
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        "  ...bumpSettings,",
        "};",
      ]);
      writeFileSync(helperPath, "export default { versionFiles: [] };\n");

      const blocked = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear");
      expect(flattenOutput(blocked.output)).toContain("release/bump-settings.js (su contenido es distinto del de HEAD)");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release beez-rp from its own checkout with --ignore-local-changes while a beez-rp module the configuration imports has an uncommitted edit",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      for (const directory of ["bin", "src"]) {
        cpSync(path.join(BEEZ_RP_ROOT, directory), path.join(repositoryRoot, directory), { recursive: true });
        writeFileSync(path.join(repositoryRoot, directory, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
      }
      const constantsPath = path.join(repositoryRoot, "src", "constants", "create-version.js");
      // beez-rp.config.js of beez-rp itself imports its own sources, already loaded by the running command.
      pushConfiguration(repositoryRoot, [
        'import { MAIN_BRANCH } from "./src/constants/create-version.js";',
        "export default {",
        "  changelog: { audience: `equipo de ${MAIN_BRANCH}` },",
        "  checks: false,",
        "};",
      ]);
      appendFileSync(constantsPath, "// local\n");

      const result = spawnSync(process.execPath, [path.join(repositoryRoot, "bin", "beez-rp.js"), "create-version", "--bump", "minor", "--ignore-local-changes"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: commandEnvironment(),
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(flattenOutput(output)).toContain("La configuración tiene cambios sin commitear");
      expect(flattenOutput(output)).toContain("src/constants/create-version.js (su contenido es distinto del de HEAD)");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release beez-rp from its own checkout with --ignore-local-changes while a module that the command loaded before reading the configuration, two imports away from it, has an uncommitted edit",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      for (const directory of ["bin", "src"]) {
        cpSync(path.join(BEEZ_RP_ROOT, directory), path.join(repositoryRoot, directory), { recursive: true });
        writeFileSync(path.join(repositoryRoot, directory, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
      }
      // src/constants/create-version.js imports src/constants/package-manager.js, and both load when the command starts.
      pushConfiguration(repositoryRoot, [
        'import { MAIN_BRANCH } from "./src/constants/create-version.js";',
        "export default {",
        "  changelog: { audience: `equipo de ${MAIN_BRANCH}` },",
        "  checks: false,",
        "};",
      ]);
      appendFileSync(path.join(repositoryRoot, "src", "constants", "package-manager.js"), "// local\n");

      const result = spawnSync(process.execPath, [path.join(repositoryRoot, "bin", "beez-rp.js"), "create-version", "--bump", "minor", "--ignore-local-changes"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: commandEnvironment(),
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(0);
      expect(flattenOutput(output)).toContain("La configuración tiene cambios sin commitear");
      expect(flattenOutput(output)).toContain("src/constants/package-manager.js (su contenido es distinto del de HEAD)");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release with --ignore-local-changes while a module the configuration reaches through a data: module has an uncommitted edit",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const helperPath = path.join(repositoryRoot, "release", "version-files.js");
      mkdirSync(path.dirname(cliPath));
      mkdirSync(path.dirname(helperPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      writeFileSync(helperPath, 'export const versionFiles = ["src/cli.js"];\n');
      pushConfiguration(repositoryRoot, [
        'const helperUrl = new URL("./release/version-files.js", import.meta.url).href;',
        "const { versionFiles } = await import(`data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(helperUrl)};`)}`);",
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        "  versionFiles,",
        "};",
      ]);
      writeFileSync(helperPath, "export const versionFiles = [];\n");

      const blocked = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear");
      expect(flattenOutput(blocked.output)).toContain("release/version-files.js (su contenido es distinto del de HEAD)");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release while the configuration requires a repository module without its full path, and name the path to complete",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const settingsPath = path.join(repositoryRoot, "release", "settings.json");
      mkdirSync(path.dirname(settingsPath));
      writeFileSync(settingsPath, '{ "audience": "equipo" }\n');
      // Node picks settings.json here, but an ignored settings.js (or a link named so) would take precedence.
      pushConfiguration(repositoryRoot, [
        'import { createRequire } from "node:module";',
        'const { audience } = createRequire(import.meta.url)("./release/settings");',
        "export default {",
        "  changelog: { audience },",
        "  checks: false,",
        "};",
      ]);

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear");
      expect(flattenOutput(blocked.output)).toContain("release/settings (se importa sin la ruta completa del archivo");
      expect(flattenOutput(blocked.output)).not.toContain("release/settings.json (");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not run a hook with --ignore-local-changes while a module it reads a value from through require has an uncommitted edit that keeps the hook source identical",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const hookLog = path.join(path.dirname(repositoryRoot), "prepare.log");
      const settingsPath = path.join(repositoryRoot, "release", "settings.cjs");
      mkdirSync(path.dirname(settingsPath));
      writeFileSync(settingsPath, 'module.exports = { channel: "committed" };\n');
      pushConfiguration(repositoryRoot, [
        'import { appendFileSync } from "node:fs";',
        'import { createRequire } from "node:module";',
        'const { channel } = createRequire(import.meta.url)("./release/settings.cjs");',
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        `  prepare: () => appendFileSync(${JSON.stringify(hookLog)}, channel),`,
        "};",
      ]);
      writeFileSync(settingsPath, 'module.exports = { channel: "uncommitted" };\n');

      const blocked = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("release/settings.cjs (su contenido es distinto del de HEAD)");
      expect(existsSync(hookLog)).toBe(false);
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");

      runGit(["restore", "release/settings.cjs"], repositoryRoot);
      writeFileSync(path.join(repositoryRoot, "notes.txt"), "borrador local\n");
      const release = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(release.status, release.output).toBe(0);
      expect(readFileSync(hookLog, "utf8")).toBe("committed");
      // The restore goes through Git, which may convert line endings (core.autocrlf): the content is what matters.
      expect(readFileSync(path.join(repositoryRoot, "notes.txt"), "utf8").replaceAll("\r\n", "\n")).toBe("borrador local\n");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not start a new release with --ignore-local-changes while a local edit of the configuration drops a versionFiles entry, and say it cannot be set aside",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const configPath = path.join(repositoryRoot, "beez-rp.config.js");
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js"],', "};"]);
      const localConfig = ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", "};", ""].join("\n");
      writeFileSync(configPath, localConfig);

      const withoutFlag = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(withoutFlag.status, withoutFlag.output).toBe(0);
      expect(flattenOutput(withoutFlag.output)).toContain("beez-rp.config.mjs o beez-rp.config.js no se puede apartar con --ignore-local-changes");

      for (const flags of [["--bump", "minor", "--ignore-local-changes", "--dry-run"], ["--bump", "minor", "--ignore-local-changes"]]) {
        const blocked = runCli(repositoryRoot, flags);

        expect(blocked.status, blocked.output).toBe(0);
        expect(flattenOutput(blocked.output)).toContain("La configuración tiene cambios sin commitear");
        expect(flattenOutput(blocked.output)).not.toContain("ya está commiteado");
      }

      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("chore: configure releases");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(readFileSync(cliPath, "utf8")).toBe('program.version("0.1.0"); // beez-rp-version\n');
      expect(readFileSync(configPath, "utf8")).toBe(localConfig);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should require --bump or --set-version without an interactive terminal, since the version prompt has no default",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const checkLog = path.join(path.dirname(repositoryRoot), "checks.log");
      writeFileSync(path.join(repositoryRoot, "check.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(checkLog)}, "checked");\n`);
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', '  checks: ["node check.mjs"],', "};"]);

      const release = runCli(repositoryRoot, []);

      expect(release.status).toBe(1);
      expect(flattenOutput(release.output)).toContain("Sin terminal interactiva no se puede elegir la versión");
      expect(existsSync(checkLog)).toBe(false);
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runCli(repositoryRoot, ["--dry-run"]).status).toBe(0);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should release with --ignore-local-changes without shipping them, and restore them afterwards",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const checkLog = path.join(path.dirname(repositoryRoot), "checks.log");
      // The check records whether it saw the untracked file: set-aside changes must not reach it.
      writeFileSync(
        path.join(repositoryRoot, "check-notes.mjs"),
        `import { appendFileSync, existsSync } from "node:fs";\nappendFileSync(${JSON.stringify(checkLog)}, String(existsSync("notes.txt")));\n`
      );
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', '  checks: ["node check-notes.mjs"],', "};"]);
      writeFileSync(path.join(repositoryRoot, "staged.txt"), "staged\n");
      runGit(["add", "staged.txt"], repositoryRoot);
      writeFileSync(path.join(repositoryRoot, "notes.txt"), "untracked\n");
      writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Algo nuevo.\n- Algo más.\n");

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);
      expect(flattenOutput(blocked.output)).toContain("--ignore-local-changes");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");

      const release = runCli(repositoryRoot, ["--bump", "minor", "--ignore-local-changes"]);

      expect(release.status, release.output).toBe(0);
      expect(readFileSync(checkLog, "utf8")).toBe("false");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("v0.2.0");
      expect(runGit(["show", "--name-only", "--format=", "main"], remoteRoot).split("\n").toSorted()).toEqual(["CHANGELOG.md", "package.json"]);
      expect(runGit(["show", "main:CHANGELOG.md"], remoteRoot)).toContain("- Algo más.");
      expect(runGit(["status", "--porcelain"], repositoryRoot).split("\n").toSorted()).toEqual(["?? notes.txt", "A  staged.txt"]);
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
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
        "  checks: false,",
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
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", "};"]);
      pushConfiguration(repositoryRoot, [
        'import { appendFileSync } from "node:fs";',
        `const log = ${JSON.stringify(hookLog)};`,
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
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
      "  checks: false,",
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
    "should diagnose an invalid NPM_TOKEN, not the connection, when the registry rejects the authenticated npm lookup",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"], rejectUnknownTokenReads: true });
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(hookLog));

      const rejected = await runCliAsync(repositoryRoot, ["--bump", "minor"], { NPM_TOKEN: "expired-fixture-token" });
      const output = flattenOutput(rejected.output);

      expect(rejected.status, rejected.output).toBe(0);
      expect(output).toContain("npm auth token inválido o vencido (variable de entorno)");
      expect(output).toContain("El NPM_TOKEN (variable de entorno) es inválido o venció");
      expect(output).not.toContain("No se pudo consultar npm");
      expect(output).not.toContain("Revisá la conexión");
      expect(output).not.toContain("expired-fixture-token");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(existsSync(hookLog)).toBe(false);
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should report the npm blocker, instead of aborting the diagnosis, when the repository .env cannot be read",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", publishTo(registry.registryUrl));
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(hookLog));
      mkdirSync(path.join(repositoryRoot, ".env"));

      const release = await runCliAsync(repositoryRoot, ["--bump", "minor"]);
      const output = flattenOutput(release.output);

      expect(release.status, release.output).toBe(0);
      expect(output).toContain("No se pudo consultar npm");
      expect(output).toMatch(/no se pudo leer .*\.env para buscar NPM_TOKEN/u);
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(existsSync(hookLog)).toBe(false);
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should say that only the tag is on origin when a resumed release fails before pushing main",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const manifestFields = publishTo(registry.registryUrl);
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", manifestFields);
      pushConfiguration(repositoryRoot, [
        "export default {",
        '  changelog: { audience: "equipo" },',
        "  checks: false,",
        '  registry: "npm",',
        '  publish: "npm",',
        '  prepare: () => { throw new Error("prepare fixture failure"); },',
        "};",
      ]);
      const remoteMainSha = runGit(["rev-parse", "main"], remoteRoot);
      commitVersion(repositoryRoot, "0.2.0", "0.2.0", manifestFields);
      runGit(["tag", "-a", "v0.2.0", "-m", "0.2.0"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "refs/tags/v0.2.0"], repositoryRoot);

      const resumed = await runCliAsync(repositoryRoot, [], { NPM_TOKEN: OWNER_TOKEN });
      const output = flattenOutput(resumed.output);

      expect(resumed.status, resumed.output).toBe(1);
      expect(output).toContain("prepare fixture failure");
      expect(output).toContain(
        "v0.2.0 ya está en origin solo como tag: main de origin todavía no tiene el commit del release; faltan subir main y publicar en npm. Corré pnpm create-version para retomar desde el push."
      );
      expect(output).not.toContain("(main + tag)");
      expect(runGit(["rev-parse", "main"], remoteRoot)).toBe(remoteMainSha);
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
      expect(output).toContain(`npm auth ${OWNER_USER} (~/.config/beez-rp/.env), dueño de fixture-app; permiso de escritura del token no verificable antes de publicar`);
      expect(output).toContain("npm publish terminó con código");
      expect(output).toContain(`autentican como ${OWNER_USER}, dueño de fixture-app`);
      expect(output).toContain("El token puede ser read-only o granular sin permiso de escritura sobre el paquete");
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

  it(
    "should not publish from a detached release tag that never reached origin",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const manifestFields = publishTo(registry.registryUrl);
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", manifestFields);
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(hookLog));
      commitVersion(repositoryRoot, "0.2.0", "0.2.0", manifestFields);
      runGit(["tag", "-a", "v0.2.0", "-m", "0.2.0"], repositoryRoot);
      runGit(["switch", "--quiet", "--detach", "v0.2.0"], repositoryRoot);

      const detached = await runCliAsync(repositoryRoot, [], { NPM_TOKEN: OWNER_TOKEN });
      const output = flattenOutput(detached.output);

      expect(detached.status, detached.output).toBe(0);
      expect(output).toContain("v0.2.0 no está en origin");
      expect(output).toContain("git switch main y corré pnpm create-version, que retoma el push de main y v0.2.0 antes de publicar");
      expect(existsSync(hookLog)).toBe(false);
      expect(registry.publications).toEqual([]);
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should push only a local release tag whose commit origin/main already has, and publish it from the detached HEAD",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0"] });
      const manifestFields = publishTo(registry.registryUrl);
      const { repositoryRoot, remoteRoot } = createReleasedRepository("0.1.0", manifestFields);
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(hookLog));
      commitVersion(repositoryRoot, "0.2.0", "0.2.0", manifestFields);
      runGit(["tag", "-a", "v0.2.0", "-m", "0.2.0"], repositoryRoot);
      const releaseSha = runGit(["rev-parse", "HEAD"], repositoryRoot);
      commitVersion(repositoryRoot, "0.2.0", "Merge pull request #3 from fixture/feature", manifestFields);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
      const remoteMainSha = runGit(["rev-parse", "main"], remoteRoot);
      const ownerToken = { NPM_TOKEN: OWNER_TOKEN };

      runGit(["switch", "--quiet", "--detach", "v0.2.0"], repositoryRoot);
      const resumed = await runCliAsync(repositoryRoot, [], ownerToken);
      const resumedOutput = flattenOutput(resumed.output);

      expect(resumed.status, resumed.output).toBe(0);
      expect(resumedOutput).not.toContain("v0.2.0 no está en origin");
      expect(resumedOutput).toContain("v0.2.0 publicado");
      expect(runGit(["rev-parse", "refs/tags/v0.2.0^{commit}"], remoteRoot)).toBe(releaseSha);
      expect(runGit(["rev-parse", "main"], remoteRoot)).toBe(remoteMainSha);
      expect(readFileSync(hookLog, "utf8")).toBe("prepare 0.2.0\n");
      expect(registry.publications).toEqual([{ packageName: "fixture-app", version: "0.2.0", user: OWNER_USER }]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not publish from a detached release tag below the prerelease the latest dist-tag points at",
    async () => {
      const registry = await startOwnedRegistry({ publishedVersions: ["0.1.0", "0.3.0-beta.1"] });
      const manifestFields = publishTo(registry.registryUrl);
      const { repositoryRoot } = createReleasedRepository("0.1.0", manifestFields);
      const hookLog = path.join(path.dirname(repositoryRoot), "hooks.log");
      pushConfiguration(repositoryRoot, npmReleaseConfiguration(hookLog));
      commitVersion(repositoryRoot, "0.2.0", "0.2.0", manifestFields);
      runGit(["tag", "-a", "v0.2.0", "-m", "0.2.0"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main", "refs/tags/v0.2.0"], repositoryRoot);
      runGit(["switch", "--quiet", "--detach", "v0.2.0"], repositoryRoot);

      const detached = await runCliAsync(repositoryRoot, [], { NPM_TOKEN: OWNER_TOKEN });
      const output = flattenOutput(detached.output);

      expect(detached.status, detached.output).toBe(0);
      expect(output).toContain("0.2.0 no es mayor que 0.3.0-beta.1, la versión del dist-tag latest en npm");
      expect(existsSync(hookLog)).toBe(false);
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
  it(
    "should not release while a module the configuration imports has a filter attribute, even when it matches HEAD",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      mkdirSync(path.join(repositoryRoot, "release"));
      writeFileSync(path.join(repositoryRoot, "release", "checks.js"), "export const checks = false;\n");
      writeFileSync(path.join(repositoryRoot, ".gitattributes"), "release/checks.js filter=release-rewrite\n");
      pushConfiguration(repositoryRoot, ['import { checks } from "./release/checks.js";', "export default {", '  changelog: { audience: "equipo" },', "  checks,", "};"]);

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("release/checks.js (tiene un atributo filter en .gitattributes, así que no se puede comprobar que lo que cargó Node sea lo commiteado)");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should keep the configuration modules of each repository apart when one process loads the configuration of two repositories",
    () => {
      const repositories = [createReleasedRepository().repositoryRoot, createReleasedRepository().repositoryRoot];
      for (const repositoryRoot of repositories) {
        mkdirSync(path.join(repositoryRoot, "release"));
        writeFileSync(path.join(repositoryRoot, "release", "checks.js"), "export const checks = false;\n");
        pushConfiguration(repositoryRoot, ['import { checks } from "./release/checks.js";', "export default {", '  changelog: { audience: "equipo" },', "  checks,", "};"]);
      }
      // A real Node process, like a project script that releases several packages programmatically.
      const script = [
        `import { collectReleaseState, loadCreateVersionConfig } from ${JSON.stringify(pathToFileURL(path.join(BEEZ_RP_ROOT, "src", "create-version", "index.js")).href)};`,
        `const repositories = ${JSON.stringify(repositories)};`,
        "const graphs = [];",
        "for (const repositoryRoot of repositories) {",
        "  await loadCreateVersionConfig(repositoryRoot);",
        "  graphs.push((await collectReleaseState({ repositoryRoot })).configModules);",
        "}",
        "console.log(JSON.stringify(graphs));",
      ].join("\n");

      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: repositories[1], encoding: "utf8", env: commandEnvironment() });

      expect(result.status, result.stderr).toBe(0);
      const expectedGraph = { loaded: true, files: ["beez-rp.config.js", "release/checks.js"], externalFiles: [], implicitPaths: [], startedExplicitly: false };
      expect(JSON.parse(result.stdout)).toEqual([expectedGraph, expectedGraph]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not set local changes aside when custom tooling imported repository code before the module trace started, unless it starts the trace first",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const helperPath = path.join(repositoryRoot, "release", "version-files.js");
      mkdirSync(path.dirname(cliPath));
      mkdirSync(path.dirname(helperPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      writeFileSync(helperPath, 'export const versionFiles = ["src/cli.js"];\n');
      writeFileSync(path.join(repositoryRoot, "release", "index.js"), 'export { versionFiles } from "./version-files.js";\n');
      pushConfiguration(repositoryRoot, ['import { versionFiles } from "./release/index.js";', "export default {", '  changelog: { audience: "equipo" },', "  checks: false,", "  versionFiles,", "};"]);
      // A tracked local edit that drops the versionFiles entry, two imports away from the configuration.
      writeFileSync(helperPath, "export const versionFiles = [];\n");
      /**
       * A real Node process, like a project script that imports a repository helper and then releases.
       *
       * @param {boolean} startsTraceFirst - Whether the script calls startTracingConfigModules before anything else.
       */
      const runScript = (startsTraceFirst) => {
        const script = [
          `import { runCreateVersion, startTracingConfigModules } from ${JSON.stringify(pathToFileURL(path.join(BEEZ_RP_ROOT, "src", "create-version", "index.js")).href)};`,
          startsTraceFirst ? "startTracingConfigModules();" : "",
          `await import(${JSON.stringify(pathToFileURL(path.join(repositoryRoot, "release", "index.js")).href)});`,
          `process.exitCode = await runCreateVersion({ repositoryRoot: ${JSON.stringify(repositoryRoot)}, argv: ["--bump", "minor", "--ignore-local-changes"] });`,
        ].join("\n");
        const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd: repositoryRoot, encoding: "utf8", env: commandEnvironment() });
        return { status: result.status, output: flattenOutput(`${result.stdout}${result.stderr}`) };
      };

      const lateTrace = runScript(false);

      expect(lateTrace.status, lateTrace.output).toBe(0);
      expect(lateTrace.output).toContain("No se pueden apartar los cambios locales: el registro de módulos empezó tarde");
      expect(lateTrace.output).toContain("startTracingConfigModules()");

      const earlyTrace = runScript(true);

      expect(earlyTrace.status, earlyTrace.output).toBe(0);
      expect(earlyTrace.output).toContain("release/version-files.js (su contenido es distinto del de HEAD)");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
      expect(readFileSync(helperPath, "utf8")).toBe("export const versionFiles = [];\n");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not release while skip-worktree hides a changed executable bit, where core.fileMode keeps it, and ignore that bit where it does not",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const scriptPath = path.join(repositoryRoot, "release.sh");
      writeFileSync(scriptPath, "#!/bin/sh\necho release\n");
      chmodSync(scriptPath, 0o644);
      runGit(["add", "release.sh"], repositoryRoot);
      // HEAD keeps it executable while the working file is not (a file system without the bit, such as Windows, gets the same).
      runGit(["update-index", "--chmod=+x", "--", "release.sh"], repositoryRoot);
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", "};"]);
      runGit(["update-index", "--skip-worktree", "--", "release.sh"], repositoryRoot);

      runGit(["config", "core.fileMode", "true"], repositoryRoot);
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");
      const blocked = runCli(repositoryRoot, ["--dry-run"]);

      expect(blocked.status, blocked.output).toBe(0);
      expect(flattenOutput(blocked.output)).toContain("Hay 1 archivo(s) con cambios locales que git status no muestra");
      expect(flattenOutput(blocked.output)).toContain("release.sh (su permiso de ejecución es distinto del de HEAD)");

      runGit(["config", "core.fileMode", "false"], repositoryRoot);
      const ignored = runCli(repositoryRoot, ["--dry-run"]);

      expect(ignored.status, ignored.output).toBe(0);
      expect(flattenOutput(ignored.output)).not.toContain("release.sh");
      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );
});
