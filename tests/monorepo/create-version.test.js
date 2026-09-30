import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  GIT_FIXTURE_TEST_TIMEOUT_MS,
  OWNER_TOKEN,
  OWNER_USER,
  cleanupTemporaryDirectories,
  createTemporaryDirectory,
  flattenOutput,
  runCliAsync,
  runGit,
} from "../create-version/support/cli-harness.js";
import { startFixtureNpmRegistry } from "../create-version/support/fixture-npm-registry.js";

/** @type {{ close: () => Promise<void> }[]} */
const openRegistries = [];

afterEach(async () => {
  for (const registry of openRegistries.splice(0)) {
    await registry.close();
  }
  cleanupTemporaryDirectories();
});

/**
 * @param {string} root - Repository.
 * @param {string} relativePath - File path.
 * @param {unknown} content - JSON content.
 */
function writeJson(root, relativePath, content) {
  mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  writeFileSync(path.join(root, relativePath), `${JSON.stringify(content, null, 2)}\n`);
}

/**
 * @param {string} root - Repository.
 * @param {string} message - Commit message.
 */
function commitAll(root, message) {
  runGit(["add", "-A"], root);
  runGit(["commit", "--quiet", "-m", message], root);
}

/**
 * A monorepo released as `@acme/widget@1.0.0` and `@acme/adapter@0.3.0` (tags widget-v1.0.0 and
 * adapter-v0.3.0 on origin). The widget bundles the private `@acme/core`; the adapter installs the widget.
 *
 * @returns {{ repositoryRoot: string, remoteRoot: string }} Clone and bare `origin`.
 */
function createReleasedMonorepo() {
  const fixtureRoot = createTemporaryDirectory("beez-rp-monorepo-");
  const remoteRoot = path.join(fixtureRoot, "origin.git");
  const repositoryRoot = path.join(fixtureRoot, "work");
  runGit(["init", "--quiet", "--bare", "--initial-branch=main", remoteRoot], fixtureRoot);
  runGit(["clone", "--quiet", remoteRoot, repositoryRoot], fixtureRoot);
  for (const [key, value] of [["user.email", "release@example.test"], ["user.name", "Release Fixture"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) {
    runGit(["config", key, value], repositoryRoot);
  }
  runGit(["symbolic-ref", "HEAD", "refs/heads/main"], repositoryRoot);

  writeJson(repositoryRoot, "package.json", { name: "acme-monorepo", private: true, type: "module", workspaces: ["packages/*"] });
  writeJson(repositoryRoot, "packages/core/package.json", { name: "@acme/core", private: true, version: "0.0.0" });
  writeJson(repositoryRoot, "packages/widget/package.json", { name: "@acme/widget", version: "1.0.0", devDependencies: { "@acme/core": "workspace:*" } });
  writeJson(repositoryRoot, "packages/adapter/package.json", { name: "@acme/adapter", version: "0.3.0", dependencies: { "@acme/widget": "^1.0.0" } });
  for (const component of ["widget", "adapter"]) {
    writeFileSync(path.join(repositoryRoot, "packages", component, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
  }
  writeFileSync(
    path.join(repositoryRoot, "beez-rp.config.js"),
    ['export default {', '  changelog: { audience: "quien usa {name}" },', '  packages: "workspaces",', "  checks: false,", '  publish: "npm",', '  summary: ["Deploy de {name} {version}.", "Revisá el deploy."],', "};", ""].join("\n")
  );
  commitAll(repositoryRoot, "release: @acme/widget@1.0.0, @acme/adapter@0.3.0");
  runGit(["tag", "-a", "widget-v1.0.0", "-m", "@acme/widget@1.0.0"], repositoryRoot);
  runGit(["tag", "-a", "adapter-v0.3.0", "-m", "@acme/adapter@0.3.0"], repositoryRoot);
  runGit(["push", "--quiet", "--atomic", "origin", "main", "--tags"], repositoryRoot);
  return { repositoryRoot, remoteRoot };
}

/**
 * Commits a change in the private core (so only the widget, which bundles it, changes) with the
 * widget's changelog entry, and pushes it.
 *
 * @param {string} repositoryRoot - Clone.
 */
function pushCoreFeature(repositoryRoot) {
  writeFileSync(path.join(repositoryRoot, "packages/core/index.js"), "export const answer = 42;\n");
  writeFileSync(path.join(repositoryRoot, "packages/widget/CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Respuesta nueva.\n");
  commitAll(repositoryRoot, "feat(core): add the answer");
  runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
}

/**
 * @param {{ rejectPublications?: boolean, packages?: Record<string, { maintainers: string[], versions: string[] }> }} [options] - Rejection and extra (or replaced) packages.
 * @returns {Promise<Awaited<ReturnType<typeof startFixtureNpmRegistry>>>} Registry with both packages released.
 */
async function startRegistry({ rejectPublications = false, packages = {} } = {}) {
  const registry = await startFixtureNpmRegistry({
    users: { [OWNER_TOKEN]: OWNER_USER },
    packages: {
      "@acme/widget": { maintainers: [OWNER_USER], versions: ["1.0.0"] },
      "@acme/adapter": { maintainers: [OWNER_USER], versions: ["0.3.0"] },
      ...packages,
    },
    rejectPublications,
  });
  openRegistries.push(registry);
  return registry;
}

/** @param {string} registryUrl - Fixture registry. @returns {NodeJS.ProcessEnv} Token and registry of the command. */
const npmEnvironment = (registryUrl) => ({ NPM_TOKEN: OWNER_TOKEN, npm_config_registry: registryUrl, "npm_config_@acme:registry": registryUrl });

describe("create-version in monorepo mode", () => {
  it(
    "releases only the package whose paths changed (a private bundled dependency included), with its own tag, changelog and publication",
    async () => {
      const { repositoryRoot, remoteRoot } = createReleasedMonorepo();
      pushCoreFeature(repositoryRoot);
      const registry = await startRegistry();

      const preview = await runCliAsync(repositoryRoot, ["--dry-run"], npmEnvironment(registry.registryUrl));
      expect(preview.status, preview.output).toBe(0);
      expect(flattenOutput(preview.output)).toContain("Elegir la versión de cada paquete con cambios (1) @acme/widget");

      const release = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment(registry.registryUrl));

      expect(release.status, release.output).toBe(0);
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("release: @acme/widget@1.1.0");
      expect(runGit(["tag", "--list", "--points-at", "main"], remoteRoot)).toBe("widget-v1.1.0");
      expect(JSON.parse(runGit(["show", "main:packages/widget/package.json"], remoteRoot)).version).toBe("1.1.0");
      expect(JSON.parse(runGit(["show", "main:packages/adapter/package.json"], remoteRoot)).version).toBe("0.3.0");
      expect(runGit(["show", "main:packages/widget/CHANGELOG.md"], remoteRoot)).toMatch(/## \[Unreleased\]\n\n## \[1\.1\.0\] - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- Respuesta nueva\./u);
      expect(registry.publications).toEqual([{ packageName: "@acme/widget", version: "1.1.0", user: OWNER_USER }]);
      const releaseOutput = flattenOutput(release.output);
      expect(releaseOutput).toContain("Deploy de @acme/widget 1.1.0.");
      expect(releaseOutput).not.toContain("{version}");
      expect(releaseOutput.split("Revisá el deploy.")).toHaveLength(2);

      const again = await runCliAsync(repositoryRoot, ["--dry-run"], npmEnvironment(registry.registryUrl));
      expect(again.output).toContain("Todo al día");
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "publishes, from its release commit, a tagged release npm never received, before releasing the packages that changed since",
    async () => {
      const { repositoryRoot, remoteRoot } = createReleasedMonorepo();
      pushCoreFeature(repositoryRoot);

      const failed = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment((await startRegistry({ rejectPublications: true })).registryUrl));
      expect(failed.status, failed.output).toBe(1);
      expect(runGit(["tag", "--list", "widget-v1.1.0"], remoteRoot)).toBe("widget-v1.1.0");

      // The adapter changes after the release: HEAD is no longer the widget's release commit.
      writeFileSync(path.join(repositoryRoot, "packages/adapter/index.js"), "export {};\n");
      writeFileSync(path.join(repositoryRoot, "packages/adapter/CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Arreglo.\n");
      commitAll(repositoryRoot, "fix(adapter): patch");
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const registry = await startRegistry();
      const resume = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment(registry.registryUrl));

      expect(resume.status, resume.output).toBe(0);
      expect(flattenOutput(resume.output)).toContain("retomar el release pendiente");
      expect(registry.publications).toEqual([{ packageName: "@acme/widget", version: "1.1.0", user: OWNER_USER }]);
      expect(runGit(["worktree", "list"], repositoryRoot).split("\n")).toHaveLength(1);

      const next = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment(registry.registryUrl));

      expect(next.status, next.output).toBe(0);
      expect(runGit(["log", "-1", "--format=%s", "main"], remoteRoot)).toBe("release: @acme/adapter@0.3.1");
      expect(registry.publications.at(-1)).toEqual({ packageName: "@acme/adapter", version: "0.3.1", user: OWNER_USER });
      expect(readFileSync(path.join(repositoryRoot, "packages/adapter/package.json"), "utf8")).toContain('"version": "0.3.1"');
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS * 2
  );

  it(
    "does not write the release when a chosen version is already on npm",
    async () => {
      const { repositoryRoot, remoteRoot } = createReleasedMonorepo();
      pushCoreFeature(repositoryRoot);
      const featureSha = runGit(["rev-parse", "HEAD"], repositoryRoot);
      const registry = await startRegistry({ packages: { "@acme/widget": { maintainers: [OWNER_USER], versions: ["1.0.0", "1.1.0"] } } });

      const release = await runCliAsync(repositoryRoot, ["--bump", "minor"], npmEnvironment(registry.registryUrl));

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain("@acme/widget@1.1.0 ya está publicada en npm.");
      expect(runGit(["rev-parse", "HEAD"], repositoryRoot)).toBe(featureSha);
      expect(runGit(["status", "--porcelain"], repositoryRoot)).toBe("");
      expect(runGit(["tag", "--list", "widget-v1.1.0"], repositoryRoot)).toBe("");
      expect(runGit(["rev-parse", "main"], remoteRoot)).toBe(featureSha);
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "does not write the release when two chosen packages would get the same tag",
    async () => {
      const { repositoryRoot, remoteRoot } = createReleasedMonorepo();
      writeJson(repositoryRoot, "package.json", { name: "acme-monorepo", private: true, type: "module", workspaces: ["packages/*", "apps/*"] });
      writeJson(repositoryRoot, "apps/widget/package.json", { name: "@acme/widget-app", version: "1.0.0" });
      commitAll(repositoryRoot, "chore(app): add the widget app at 1.0.0");
      writeFileSync(path.join(repositoryRoot, "apps/widget/index.js"), "export {};\n");
      writeFileSync(path.join(repositoryRoot, "apps/widget/CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- App nueva.\n");
      commitAll(repositoryRoot, "feat(app): add the entry point");
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
      pushCoreFeature(repositoryRoot);
      const featureSha = runGit(["rev-parse", "HEAD"], repositoryRoot);
      const registry = await startRegistry({ packages: { "@acme/widget-app": { maintainers: [OWNER_USER], versions: ["1.0.0"] } } });

      const release = await runCliAsync(repositoryRoot, ["--bump", "minor"], npmEnvironment(registry.registryUrl));

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain("Dos paquetes del release generan el mismo tag widget-v1.1.0");
      expect(runGit(["rev-parse", "HEAD"], repositoryRoot)).toBe(featureSha);
      expect(runGit(["tag", "--list", "widget-v1.1.0"], repositoryRoot)).toBe("");
      expect(runGit(["rev-parse", "main"], remoteRoot)).toBe(featureSha);
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "does not publish a pending release whose package was renamed since its release commit",
    async () => {
      const { repositoryRoot } = createReleasedMonorepo();
      pushCoreFeature(repositoryRoot);

      const failed = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment((await startRegistry({ rejectPublications: true })).registryUrl));
      expect(failed.status, failed.output).toBe(1);

      writeJson(repositoryRoot, "packages/widget/package.json", { name: "@acme/gadget", version: "1.1.0", devDependencies: { "@acme/core": "workspace:*" } });
      commitAll(repositoryRoot, "chore(widget): rename to gadget");
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
      const registry = await startRegistry({ packages: { "@acme/gadget": { maintainers: [OWNER_USER], versions: ["1.0.0"] } } });

      const resume = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment(registry.registryUrl));

      expect(resume.status, resume.output).toBe(1);
      expect(flattenOutput(resume.output)).toContain("El commit de release widget-v1.1.0 publica @acme/widget desde packages/widget/package.json, pero el paquete ahora se llama @acme/gadget.");
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS * 2
  );

  it(
    "does not create the release commit while a package left out of the release has a staged or uncommitted changelog",
    async () => {
      const { repositoryRoot, remoteRoot } = createReleasedMonorepo();
      pushCoreFeature(repositoryRoot);
      const releasedSha = runGit(["rev-parse", "HEAD"], repositoryRoot);
      writeFileSync(path.join(repositoryRoot, "packages/adapter/CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Todavía no sale.\n");
      runGit(["add", "packages/adapter/CHANGELOG.md"], repositoryRoot);
      const registry = await startRegistry();

      const staged = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment(registry.registryUrl));

      expect(staged.status, staged.output).toBe(1);
      expect(flattenOutput(staged.output)).toContain("Hay cambios staged que no son del release y entrarían en su commit: packages/adapter/CHANGELOG.md.");
      expect(runGit(["rev-parse", "HEAD"], repositoryRoot)).toBe(releasedSha);
      expect(runGit(["tag", "--list", "widget-v1.1.0"], repositoryRoot)).toBe("");

      runGit(["restore", "--staged", "packages/adapter/CHANGELOG.md"], repositoryRoot);
      const unstaged = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment(registry.registryUrl));

      expect(unstaged.status, unstaged.output).toBe(1);
      expect(flattenOutput(unstaged.output)).toContain("Hay cambios sin commitear en el CHANGELOG de paquetes que no salen en este release: packages/adapter/CHANGELOG.md.");
      expect(runGit(["rev-parse", "main"], remoteRoot)).toBe(releasedSha);
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "does not publish when prepare modified a tracked file of the release commit",
    async () => {
      const { repositoryRoot } = createReleasedMonorepo();
      writeFileSync(
        path.join(repositoryRoot, "beez-rp.config.js"),
        [
          'import { appendFileSync } from "node:fs";',
          'import path from "node:path";',
          "export default {",
          '  changelog: { audience: "quien usa {name}" },',
          '  packages: "workspaces",',
          "  checks: false,",
          '  prepare: ({ repositoryRoot }) => appendFileSync(path.join(repositoryRoot, "packages/core/index.js"), "// prepared\\n"),',
          '  publish: "npm",',
          "};",
          "",
        ].join("\n")
      );
      commitAll(repositoryRoot, "chore: prepare the release");
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
      pushCoreFeature(repositoryRoot);
      const registry = await startRegistry();

      const release = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment(registry.registryUrl));

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toMatch(/El paso de preparación modificó archivos versionados: +M packages\/core\/index\.js/u);
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "does not publish, without artifact, a manifest whose published dependencies only pnpm rewrites",
    async () => {
      const { repositoryRoot } = createReleasedMonorepo();
      writeJson(repositoryRoot, "packages/adapter/package.json", { name: "@acme/adapter", version: "0.3.0", dependencies: { "@acme/widget": "workspace:^" } });
      writeFileSync(path.join(repositoryRoot, "packages/adapter/CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- Usa el widget del workspace.\n");
      commitAll(repositoryRoot, "fix(adapter): use the workspace widget");
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
      const registry = await startRegistry();

      const release = await runCliAsync(repositoryRoot, ["--accept-suggested"], npmEnvironment(registry.registryUrl));

      expect(release.status, release.output).toBe(1);
      expect(flattenOutput(release.output)).toContain('@acme/adapter depende de reescrituras del package manager al empaquetar: dependencies.@acme/widget usa "workspace:^"');
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "does not push a resumed release whose existing local tag points at another commit",
    async () => {
      const { repositoryRoot, remoteRoot } = createReleasedMonorepo();
      pushCoreFeature(repositoryRoot);
      const featureSha = runGit(["rev-parse", "HEAD"], repositoryRoot);
      writeJson(repositoryRoot, "packages/widget/package.json", { name: "@acme/widget", version: "1.1.0", devDependencies: { "@acme/core": "workspace:*" } });
      commitAll(repositoryRoot, "release: @acme/widget@1.1.0");
      runGit(["tag", "-a", "widget-v1.1.0", "-m", "@acme/widget@1.1.0", featureSha], repositoryRoot);
      const registry = await startRegistry();

      const resume = await runCliAsync(repositoryRoot, [], npmEnvironment(registry.registryUrl));

      expect(resume.status, resume.output).toBe(1);
      expect(flattenOutput(resume.output)).toContain(`El tag local widget-v1.1.0 apunta a ${featureSha.slice(0, 7)}`);
      expect(runGit(["rev-parse", "main"], remoteRoot)).toBe(featureSha);
      expect(runGit(["tag", "--list", "widget-v1.1.0"], remoteRoot)).toBe("");
      expect(registry.publications).toEqual([]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS
  );

  it(
    "publishes a pending release from its release commit to the registry the untracked project .npmrc selects",
    async () => {
      const { repositoryRoot } = createReleasedMonorepo();
      writeFileSync(path.join(repositoryRoot, ".gitignore"), ".npmrc\n");
      commitAll(repositoryRoot, "chore: ignore the project npm config");
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);
      pushCoreFeature(repositoryRoot);
      // Any registry npm reads outside the project .npmrc is unreachable.
      const globalConfigPath = path.join(createTemporaryDirectory("beez-rp-npm-global-"), "npmrc");
      writeFileSync(globalConfigPath, "registry=http://127.0.0.1:9/\n");
      /** @param {string} registryUrl - Registry of the project .npmrc. @returns {NodeJS.ProcessEnv} Command environment. */
      const projectNpmrcEnvironment = (registryUrl) => {
        writeFileSync(path.join(repositoryRoot, ".npmrc"), `registry=${registryUrl}\n`);
        return { NPM_TOKEN: OWNER_TOKEN, npm_config_globalconfig: globalConfigPath };
      };

      const failed = await runCliAsync(repositoryRoot, ["--accept-suggested"], projectNpmrcEnvironment((await startRegistry({ rejectPublications: true })).registryUrl));
      expect(failed.status, failed.output).toBe(1);

      // HEAD moves past the release commit, so the resume publishes from a temporary checkout.
      writeFileSync(path.join(repositoryRoot, "packages/adapter/index.js"), "export {};\n");
      commitAll(repositoryRoot, "chore(adapter): entry point");
      runGit(["push", "--quiet", "origin", "main"], repositoryRoot);

      const registry = await startRegistry();
      const resume = await runCliAsync(repositoryRoot, ["--accept-suggested"], projectNpmrcEnvironment(registry.registryUrl));

      expect(resume.status, resume.output).toBe(0);
      expect(registry.publications).toEqual([{ packageName: "@acme/widget", version: "1.1.0", user: OWNER_USER }]);
    },
    GIT_FIXTURE_TEST_TIMEOUT_MS * 2
  );
});
