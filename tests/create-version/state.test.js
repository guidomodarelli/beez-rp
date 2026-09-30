import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NPM_LOOKUP_STATUS, RELEASE_MODE, RELEASE_STEP } from "../../src/constants/create-version.js";
import { buildReleasePlan } from "../../src/create-version/plan.js";
import { collectReleaseState } from "../../src/create-version/state.js";
import {
  GIT_FIXTURE_TEST_TIMEOUT_MS,
  OWNER_TOKEN,
  OWNER_USER,
  cleanupTemporaryDirectories,
  flattenOutput,
  runCli,
  runCliAsync,
  runGit,
  temporaryDirectories,
} from "./support/cli-harness.js";
import { startFixtureNpmRegistry } from "./support/fixture-npm-registry.js";

/** @type {{ close: () => Promise<void> }[]} */
const openRegistries = [];

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
  // Keep the bytes the tests write: a global core.autocrlf would convert line endings on checkout.
  runGit(["config", "core.autocrlf", "false"], repositoryRoot);
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
  cleanupTemporaryDirectories();
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
    "should release the version the commits suggest with --accept-suggested, without a terminal",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      writeFileSync(path.join(repositoryRoot, "beez-rp.config.js"), ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", "};", ""].join("\n"));
      runGit(["add", "-A"], repositoryRoot);
      runGit(["commit", "--quiet", "-m", "chore: configure releases"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const release = runCli(repositoryRoot, ["--accept-suggested"]);

      expect(release.status, release.output).toBe(0);
      // "feat: add gate" suggests a minor release.
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("0.2.0");
      expect(flattenOutput(release.output)).toContain("Versión sugerida aceptada: 0.2.0 (minor: hay funcionalidades nuevas)");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should suggest one level less on 0.x with preMajorShift",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", "  preMajorShift: true,", "};"]);

      const release = runCli(repositoryRoot, ["--accept-suggested"]);

      expect(release.status, release.output).toBe(0);
      // "feat: add gate" suggests a minor release, a patch before 1.0.0.
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("0.1.1");
      expect(flattenOutput(release.output)).toContain("Versión sugerida aceptada: 0.1.1 (patch: hay funcionalidades nuevas; antes de 1.0.0 baja un nivel)");
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
    "should stop before bumping when a versionFiles block is never closed, naming the file, the line and the marker",
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
    "should stop before writing anything when a versionFiles entry is ignored by Git",
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
      expect(readFileSync(generatedPath, "utf8")).toBe(generatedContent);
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before writing anything when a versionFiles entry is a symlink, instead of rewriting the file it points to",
    (testContext) => {
      const { repositoryRoot } = createReleasedRepository();
      const targetPath = path.join(repositoryRoot, "target.js");
      const targetContent = 'program.version("0.1.0"); // beez-rp-version\n';
      writeFileSync(targetPath, targetContent);
      try {
        symlinkSync("target.js", path.join(repositoryRoot, "linked.js"), "file");
      } catch {
        // Windows only creates file symlinks with Developer Mode or elevated privileges.
        testContext.skip();
      }
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["linked.js"],', "};"]);

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("linked.js (versionFiles) no es un archivo regular");
      expect(readFileSync(targetPath, "utf8")).toBe(targetContent);
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stop before bumping when a check modifies a versionFiles entry, instead of shipping that change in the release commit",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      const cliContent = 'program.version("0.1.0"); // beez-rp-version\n';
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, cliContent);
      // Stands in for a formatter run with --fix: the check succeeds but rewrites a versionFiles entry.
      writeFileSync(path.join(repositoryRoot, "format.mjs"), 'import { appendFileSync } from "node:fs";\nappendFileSync("src/cli.js", "// formatted\\n");\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', '  checks: ["node format.mjs"],', '  versionFiles: ["src/cli.js"],', "};"]);

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("Un paso anterior (por ejemplo, un check) modificó src/cli.js");
      expect(readFileSync(cliPath, "utf8")).toBe(`${cliContent}// formatted\n`);
      expect(JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version).toBe("0.1.0");
      expect(runGit(["log", "-1", "--format=%s"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should read a versionFiles entry written with backslashes and ./ as the same file on every platform, and name it with slashes",
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
    "should stop before bumping when a versionFiles entry is not valid UTF-8, and keep every other byte of a UTF-8 file with a byte order mark and CRLF",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      const legacyPath = path.join(repositoryRoot, "docs", "legacy.txt");
      const latin1Content = Buffer.from("Versión 0.1.0 <!-- beez-rp-version -->\r\nÚltima línea\r\n", "latin1");
      mkdirSync(path.dirname(legacyPath));
      writeFileSync(legacyPath, latin1Content);
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["docs/legacy.txt"],', "};"]);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"));

      const blocked = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(blocked.status, blocked.output).toBe(1);
      expect(flattenOutput(blocked.output)).toContain("docs/legacy.txt (versionFiles) no es texto UTF-8 válido");
      expect(readFileSync(legacyPath).equals(latin1Content)).toBe(true);
      expect(readFileSync(path.join(repositoryRoot, "package.json")).equals(manifest)).toBe(true);
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");

      const byteOrderMark = Buffer.from([0xef, 0xbb, 0xbf]);
      writeFileSync(legacyPath, Buffer.concat([byteOrderMark, Buffer.from("Versión 0.1.0 <!-- beez-rp-version -->\r\nÚltima línea\r\n", "utf8")]));
      runGit(["commit", "--quiet", "-am", "chore: convert to UTF-8"], repositoryRoot);
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const release = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(release.status, release.output).toBe(0);
      expect(readFileSync(legacyPath).equals(Buffer.concat([byteOrderMark, Buffer.from("Versión 0.2.0 <!-- beez-rp-version -->\r\nÚltima línea\r\n", "utf8")]))).toBe(true);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  // Root ignores the read-only mode, so the fixture could not make the write fail.
  it.skipIf(process.getuid?.() === 0)(
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
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should stage versionFiles names literally and restore the release files and their staging when the release commit fails",
    () => {
      const { repositoryRoot } = createReleasedRepository();
      // Names a shell or Git would interpret: spaces, `%VAR%`, `$var`, a glob and, where the file system allows it, pathspec magic.
      const versionFiles = ["docs/my version %PATH% $HOME.txt", "docs/v[1].txt", ...(process.platform === "win32" ? [] : [":version"])];
      mkdirSync(path.join(repositoryRoot, "docs"));
      for (const versionFile of versionFiles) writeFileSync(path.join(repositoryRoot, versionFile), "0.1.0 <!-- beez-rp-version -->\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", `  versionFiles: ${JSON.stringify(versionFiles)},`, "};"]);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"), "utf8");
      const stagedChangelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Algo nuevo.\n- Algo más.\n";
      writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), stagedChangelog);
      runGit(["add", "CHANGELOG.md"], repositoryRoot);
      const hookPath = path.join(repositoryRoot, ".git", "hooks", "pre-commit");
      // The hook records what was staged, then rejects the commit.
      writeFileSync(hookPath, "#!/bin/sh\ngit diff --cached --name-only > ../staged.log\nexit 1\n", { mode: 0o755 });

      const failed = runCli(repositoryRoot, ["--bump", "minor"]);

      expect(failed.status, failed.output).toBe(1);
      expect(flattenOutput(failed.output)).toContain("El commit de versión falló");
      expect(flattenOutput(failed.output)).toContain("se restauraron package.json, CHANGELOG.md y versionFiles (contenido y staging)");
      expect(readFileSync(path.join(path.dirname(repositoryRoot), "staged.log"), "utf8").trim().split("\n").toSorted()).toEqual(["CHANGELOG.md", ...versionFiles, "package.json"].toSorted());
      expect(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).toBe(manifest);
      expect(readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8")).toBe(stagedChangelog);
      for (const versionFile of versionFiles) expect(readFileSync(path.join(repositoryRoot, versionFile), "utf8")).toBe("0.1.0 <!-- beez-rp-version -->\n");
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("M  CHANGELOG.md");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["tag", "--list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should undo the release commit without tagging nor pushing it when a commit hook stages another change",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      writeFileSync(path.join(repositoryRoot, "VERSION.txt"), "0.1.0 <!-- beez-rp-version -->\n");
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["VERSION.txt"],', "};"]);
      const manifest = readFileSync(path.join(repositoryRoot, "package.json"), "utf8");
      const changelog = readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
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

  /**
   * Commits `0.2.0` by hand (package.json and CHANGELOG.md), leaving `src/cli.js` with `cliVersion`.
   *
   * @param {string} repositoryRoot - Checkout configured with `versionFiles: ["src/cli.js"]`.
   */
  function commitReleaseByHand(repositoryRoot) {
    writeFileSync(path.join(repositoryRoot, "package.json"), `${JSON.stringify({ name: "fixture-app", version: "0.2.0" }, null, 2)}\n`);
    writeFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-01-01\n\n### Added\n\n- Algo nuevo.\n");
    runGit(["add", "-A"], repositoryRoot);
    runGit(["commit", "--quiet", "-m", "0.2.0"], repositoryRoot);
  }

  it(
    "should not push a resumed release commit while a versionFiles entry in HEAD carries another version, also in --dry-run",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const cliPath = path.join(repositoryRoot, "src", "cli.js");
      mkdirSync(path.dirname(cliPath));
      writeFileSync(cliPath, 'program.version("0.1.0"); // beez-rp-version\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js"],', "};"]);
      commitReleaseByHand(repositoryRoot);

      for (const flags of [["--dry-run"], []]) {
        const blocked = runCli(repositoryRoot, flags);

        expect(blocked.status, blocked.output).toBe(1);
        expect(flattenOutput(blocked.output)).toContain("src/cli.js (versionFiles) tiene en el commit de release (HEAD) una versión marcada distinta de 0.2.0.");
      }
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
    "should not resume a release commit with --ignore-local-changes while the configuration has uncommitted changes",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const configPath = path.join(repositoryRoot, "beez-rp.config.js");
      mkdirSync(path.join(repositoryRoot, "src"));
      writeFileSync(path.join(repositoryRoot, "src", "cli.js"), 'program.version("0.1.0"); // beez-rp-version\n');
      pushConfiguration(repositoryRoot, ["export default {", '  changelog: { audience: "equipo" },', "  checks: false,", '  versionFiles: ["src/cli.js"],', "};"]);
      commitReleaseByHand(repositoryRoot);
      // A local edit that drops the stale entry would otherwise skip its check.
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
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "should not set aside a module change with --ignore-local-changes, also in --dry-run, since the configuration may already depend on it",
    () => {
      const { repositoryRoot, remoteRoot } = createReleasedRepository();
      const helperPath = path.join(repositoryRoot, "release-helper.mjs");
      writeFileSync(helperPath, "export const audience = \"equipo\";\n");
      pushConfiguration(repositoryRoot, ['import { audience } from "./release-helper.mjs";', "export default {", "  changelog: { audience },", "  checks: false,", "};"]);
      writeFileSync(helperPath, "export const audience = \"otro\";\n");
      mkdirSync(path.join(repositoryRoot, "lib"));
      writeFileSync(path.join(repositoryRoot, "lib", "draft.json"), "{}\n");

      for (const flags of [["--bump", "minor", "--ignore-local-changes", "--dry-run"], ["--bump", "minor", "--ignore-local-changes"]]) {
        const blocked = runCli(repositoryRoot, flags);

        expect(blocked.status, blocked.output).toBe(0);
        expect(flattenOutput(blocked.output)).toContain("--ignore-local-changes no aparta cambios de código ni de datos");
        expect(flattenOutput(blocked.output)).toContain("M release-helper.mjs");
        expect(flattenOutput(blocked.output)).toContain("?? lib/draft.json");
      }

      expect(runGit(["tag", "--list"], remoteRoot)).toBe("");
      expect(runGit(["log", "-1", "--format=%s", "main"], repositoryRoot)).toBe("chore: configure releases");
      expect(runGit(["stash", "list"], repositoryRoot)).toBe("");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

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
});
