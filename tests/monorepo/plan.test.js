import { describe, expect, it } from "vitest";

import { MIGRATION_STATUS, NPM_AUTH_STATUS, NPM_LOOKUP_STATUS, RELEASE_MODE, RELEASE_STEP } from "../../src/constants/create-version.js";
import { MONOREPO_RELEASE_STEP } from "../../src/constants/monorepo.js";
import { buildMonorepoPlan, listMonorepoChangesToSetAside, listPackagesToAuthenticate } from "../../src/monorepo/plan.js";

/**
 * @typedef {import("../../src/monorepo/state.js").MonorepoSnapshot} MonorepoSnapshot
 * @typedef {import("../../src/monorepo/state.js").PackageSnapshot} PackageSnapshot
 */

const TAG_FORMAT = "{component}-v{version}";
const NPM_PACKAGE = { checks: true, prepare: true, publish: true, publishTitle: "Publicar en npm" };

/**
 * @param {string} component - Directory name under packages/.
 * @param {Partial<PackageSnapshot>} [overrides] - Snapshot changes.
 * @returns {PackageSnapshot} Package released as `<component>@1.0.0`, tagged and published, without changes.
 */
function packageSnapshot(component, overrides = {}) {
  const name = `@acme/${component}`;
  return {
    unit: {
      name,
      directory: `packages/${component}`,
      component,
      manifestPath: `packages/${component}/package.json`,
      changelogPath: `packages/${component}/CHANGELOG.md`,
      version: "1.0.0",
      changePaths: [`packages/${component}`],
      publishedDependencies: [],
    },
    manifest: { name, version: "1.0.0" },
    releasedVersion: "1.0.0",
    lastRelease: { sha: `sha-${component}`, version: "1.0.0", subject: `release: ${name}@1.0.0`, tag: `${component}-v1.0.0`, tagged: true, tagOnOrigin: true },
    unreleasedCommits: [],
    changelog: { exists: true, entryCount: 0, unknownSections: [], updated: true, reason: null },
    npm: { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["1.0.0"], latestVersion: "1.0.0", reason: null },
    npmAuth: null,
    ...overrides,
  };
}

/**
 * @param {Partial<MonorepoSnapshot>} [overrides] - Snapshot changes.
 * @returns {MonorepoSnapshot} Clean, synced `main` with a widget that changed and a cli that did not.
 */
function monorepoState(overrides = {}) {
  return {
    currentBranch: "main",
    workingTreeChanges: [],
    branch: null,
    pullRequest: null,
    githubError: null,
    main: { aheadCommits: [], behindCount: 0 },
    remoteMainExists: true,
    headSha: "head",
    headSubject: "feat(widget): new option",
    migrations: null,
    packages: [packageSnapshot("widget", { unreleasedCommits: [{ sha: "c1", subject: "feat(widget): new option", body: "" }] }), packageSnapshot("cli")],
    ...overrides,
  };
}

/** @param {import("../../src/monorepo/plan.js").MonorepoPlan} plan @returns {string[]} Step ids. */
const stepIds = (plan) => plan.steps.map((planStep) => planStep.id);

describe("buildMonorepoPlan", () => {
  it("plans a new release of the packages that changed only", () => {
    const plan = buildMonorepoPlan(monorepoState(), NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    expect(plan.mode).toBe(RELEASE_MODE.newRelease);
    expect(plan.candidates).toEqual(["@acme/widget"]);
    expect(stepIds(plan)).toEqual([
      MONOREPO_RELEASE_STEP.chooseVersions,
      MONOREPO_RELEASE_STEP.verifyChangelogs,
      RELEASE_STEP.runChecks,
      MONOREPO_RELEASE_STEP.bumpPackages,
      RELEASE_STEP.prepareRelease,
      MONOREPO_RELEASE_STEP.pushPackages,
      MONOREPO_RELEASE_STEP.publishPackages,
    ]);
    expect(listPackagesToAuthenticate(plan)).toEqual(["@acme/widget"]);
  });

  it("should preserve manual changelog sections when changed packages are planned", () => {
    const state = monorepoState({
      packages: [
        packageSnapshot("widget", { unreleasedCommits: [{ sha: "c1", subject: "feat(widget): new option", body: "" }], changelog: { exists: true, entryCount: 1, unknownSections: ["Added"], updated: true, reason: null } }),
        packageSnapshot("cli", { unreleasedCommits: [{ sha: "c2", subject: "fix(cli): typo", body: "" }], changelog: { exists: true, entryCount: 1, unknownSections: ["Nope"], updated: true, reason: null } }),
      ],
    });

    const plan = buildMonorepoPlan(state, NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    expect(plan.mode).toBe(RELEASE_MODE.newRelease);
    expect(plan.blockers).toEqual([]);
    expect(plan.candidates).toEqual(["@acme/widget", "@acme/cli"]);
    expect(stepIds(plan)[0]).toBe(MONOREPO_RELEASE_STEP.chooseVersions);
    expect(plan.warnings).toEqual([]);
  });

  it("should warn about unchanged notes and verify selected changelogs before migrations", () => {
    // Arrange
    const state = monorepoState({
      packages: [packageSnapshot("widget", { unreleasedCommits: [{ sha: "c1", subject: "feat(widget): new option", body: "" }], changelog: { exists: true, entryCount: 1, unknownSections: [], updated: false, reason: null } })],
      migrations: { status: MIGRATION_STATUS.pending, pending: ["0001_init"], target: "db.example.test", reason: null },
    });

    // Act
    const plan = buildMonorepoPlan(state, NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    // Assert
    expect(plan.warnings).toEqual([expect.stringContaining("packages/widget/CHANGELOG.md no fue actualizado")]);
    expect(stepIds(plan).slice(0, 3)).toEqual([MONOREPO_RELEASE_STEP.chooseVersions, MONOREPO_RELEASE_STEP.verifyChangelogs, RELEASE_STEP.applyMigrations]);
  });

  it("should block unchanged changelogs when every candidate is selected automatically", () => {
    // Arrange
    const state = monorepoState({
      packages: [
        packageSnapshot("widget", { unreleasedCommits: [{ sha: "c1", subject: "feat(widget): new option", body: "" }] }),
        packageSnapshot("cli", { unreleasedCommits: [{ sha: "c2", subject: "fix(cli): typo", body: "" }], changelog: { exists: true, entryCount: 1, unknownSections: [], updated: false, reason: null } }),
      ],
      migrations: { status: MIGRATION_STATUS.pending, pending: ["0001_init"], target: "db.example.test", reason: null },
    });

    // Act
    const plan = buildMonorepoPlan(state, NPM_PACKAGE, { tagFormat: TAG_FORMAT, selectAllPackages: true });

    // Assert
    expect(plan.mode).toBe(RELEASE_MODE.blocked);
    expect(plan.steps).toEqual([]);
    expect(plan.blockers).toEqual([{
      code: "changelog-update-required",
      title: "packages/cli/CHANGELOG.md no fue actualizado desde el último release",
      details: [expect.stringContaining("Actualizá packages/cli/CHANGELOG.md manualmente")],
    }]);
  });

  it("should ignore unchanged changelogs of non-candidates when selecting packages automatically", () => {
    // Arrange
    const state = monorepoState({
      packages: [
        packageSnapshot("widget", { unreleasedCommits: [{ sha: "c1", subject: "feat(widget): new option", body: "" }] }),
        packageSnapshot("cli", { changelog: { exists: true, entryCount: 1, unknownSections: [], updated: false, reason: null } }),
      ],
    });

    // Act
    const plan = buildMonorepoPlan(state, NPM_PACKAGE, { tagFormat: TAG_FORMAT, selectAllPackages: true });

    // Assert
    expect(plan.mode).toBe(RELEASE_MODE.newRelease);
    expect(plan.candidates).toEqual(["@acme/widget"]);
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("is up to date when no package changed", () => {
    const plan = buildMonorepoPlan(monorepoState({ packages: [packageSnapshot("widget"), packageSnapshot("cli")] }), NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    expect(plan.mode).toBe(RELEASE_MODE.upToDate);
  });

  it("syncs main before saying up to date when origin/main has new commits", () => {
    const plan = buildMonorepoPlan(
      monorepoState({ main: { aheadCommits: [], behindCount: 2 }, packages: [packageSnapshot("widget"), packageSnapshot("cli")] }),
      NPM_PACKAGE,
      { tagFormat: TAG_FORMAT }
    );

    expect(plan.mode).toBe(RELEASE_MODE.newRelease);
    expect(stepIds(plan)).toEqual([RELEASE_STEP.syncMain]);
  });

  it("resumes a local release commit that never reached origin, publishing what npm lacks", () => {
    const state = monorepoState({
      main: { aheadCommits: [{ sha: "local-release", subject: "release: @acme/widget@1.1.0, @acme/cli@1.0.1", body: "" }], behindCount: 0 },
      packages: [packageSnapshot("widget"), packageSnapshot("cli", { npm: { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["1.0.0", "1.0.1"], latestVersion: "1.0.1", reason: null } })],
    });

    const plan = buildMonorepoPlan(state, NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    expect(plan.mode).toBe(RELEASE_MODE.resume);
    expect(stepIds(plan)).toEqual([RELEASE_STEP.prepareRelease, MONOREPO_RELEASE_STEP.pushPackages, MONOREPO_RELEASE_STEP.publishPackages]);
    expect(plan.pendingReleases).toEqual([
      { name: "@acme/widget", version: "1.1.0", tag: "widget-v1.1.0", commitSha: "local-release", publish: true },
      { name: "@acme/cli", version: "1.0.1", tag: "cli-v1.0.1", commitSha: "local-release", publish: false },
    ]);
  });

  it("blocks instead of saying up to date when origin/main does not exist", () => {
    const plan = buildMonorepoPlan(monorepoState({ remoteMainExists: false, packages: [packageSnapshot("widget"), packageSnapshot("cli")] }), NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    expect(plan.mode).toBe(RELEASE_MODE.blocked);
    expect(plan.blockers.map((blocker) => blocker.title)).toContain("No existe origin/main: no se puede saber qué cambió en cada paquete");
  });

  it("blocks local commits that are not release commits", () => {
    const plan = buildMonorepoPlan(monorepoState({ main: { aheadCommits: [{ sha: "x", subject: "fix: local work", body: "" }], behindCount: 0 } }), NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    expect(plan.mode).toBe(RELEASE_MODE.blocked);
    expect(plan.blockers[0]?.title).toContain("1 commit(s) que no están en origin");
  });

  it("publishes tagged releases of origin/main that npm lacks before any new release, from their commit", () => {
    const widget = packageSnapshot("widget", {
      unreleasedCommits: [{ sha: "c2", subject: "fix(widget): later", body: "" }],
      releasedVersion: "1.1.0",
      lastRelease: { sha: "release-commit", version: "1.1.0", subject: "release: @acme/widget@1.1.0", tag: "widget-v1.1.0", tagged: true, tagOnOrigin: true },
    });

    const plan = buildMonorepoPlan(monorepoState({ packages: [widget, packageSnapshot("cli")] }), NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    expect(plan.mode).toBe(RELEASE_MODE.resume);
    expect(stepIds(plan)).toEqual([MONOREPO_RELEASE_STEP.publishPackages]);
    expect(plan.pendingReleases).toEqual([{ name: "@acme/widget", version: "1.1.0", tag: "widget-v1.1.0", commitSha: "release-commit", publish: true }]);
  });

  it("skips the tagged releases npm lacks with --skip-unpublished and plans the new release, warning about them", () => {
    const widget = packageSnapshot("widget", {
      unreleasedCommits: [{ sha: "c2", subject: "fix(widget): later", body: "" }],
      releasedVersion: "1.1.0",
      lastRelease: { sha: "release-commit", version: "1.1.0", subject: "release: @acme/widget@1.1.0", tag: "widget-v1.1.0", tagged: true, tagOnOrigin: true },
    });

    const plan = buildMonorepoPlan(monorepoState({ packages: [widget, packageSnapshot("cli")] }), NPM_PACKAGE, { tagFormat: TAG_FORMAT, skipUnpublished: true });

    expect(plan.mode).toBe(RELEASE_MODE.newRelease);
    expect(plan.candidates).toEqual(["@acme/widget"]);
    expect(plan.pendingReleases).toEqual([]);
    expect(plan.warnings).toEqual(["Se saltea @acme/widget@1.1.0 (tag widget-v1.1.0), que no está en npm: el release nuevo sale sin publicarla (--skip-unpublished)."]);
  });

  it("does not publish a missing version below the highest one on npm, and says why", () => {
    const widget = packageSnapshot("widget", {
      releasedVersion: "1.1.0",
      lastRelease: { sha: "old", version: "1.1.0", subject: "release: @acme/widget@1.1.0", tag: "widget-v1.1.0", tagged: true, tagOnOrigin: true },
      npm: { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["1.0.0", "2.0.0"], latestVersion: "2.0.0", reason: null },
    });

    const plan = buildMonorepoPlan(monorepoState({ packages: [widget, packageSnapshot("cli")] }), NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    expect(plan.mode).toBe(RELEASE_MODE.upToDate);
    expect(plan.warnings[0]).toContain("movería latest hacia atrás");
  });

  it("lets the package changelogs stay uncommitted in a new release but blocks any other change", () => {
    const changelogOnly = monorepoState({ workingTreeChanges: [" M packages/widget/CHANGELOG.md"] });
    const withDocs = monorepoState({ workingTreeChanges: [" M packages/widget/CHANGELOG.md", " M packages/widget/README.md"] });

    expect(buildMonorepoPlan(changelogOnly, NPM_PACKAGE, { tagFormat: TAG_FORMAT }).mode).toBe(RELEASE_MODE.newRelease);
    expect(buildMonorepoPlan(withDocs, NPM_PACKAGE, { tagFormat: TAG_FORMAT }).blockers[0]?.title).toBe("Hay 1 archivo(s) sin commitear");
    expect(buildMonorepoPlan(withDocs, NPM_PACKAGE, { tagFormat: TAG_FORMAT, ignoreLocalChanges: true }).mode).toBe(RELEASE_MODE.newRelease);
    expect(listMonorepoChangesToSetAside(withDocs, RELEASE_MODE.newRelease)).toEqual([" M packages/widget/README.md"]);
  });

  it("recognizes a package changelog whose path Git quotes because it has a space", () => {
    const spaced = packageSnapshot("my widget", { unreleasedCommits: [{ sha: "c1", subject: "feat(widget): new option", body: "" }] });
    const state = monorepoState({ packages: [spaced], workingTreeChanges: [' M "packages/my widget/CHANGELOG.md"'] });

    expect(buildMonorepoPlan(state, NPM_PACKAGE, { tagFormat: TAG_FORMAT }).mode).toBe(RELEASE_MODE.newRelease);
    expect(listMonorepoChangesToSetAside(state, RELEASE_MODE.newRelease)).toEqual([]);
  });

  it("does not set aside code or data changes with --ignore-local-changes, such as a workspace manifest discovery already read", () => {
    const state = monorepoState({ workingTreeChanges: [" M packages/cli/package.json", " M packages/widget/src/index.ts", " M packages/widget/README.md"] });

    const plan = buildMonorepoPlan(state, NPM_PACKAGE, { tagFormat: TAG_FORMAT, ignoreLocalChanges: true });

    expect(plan.mode).toBe(RELEASE_MODE.blocked);
    expect(plan.blockers[0]?.title).toContain("--ignore-local-changes no aparta cambios de código ni de datos");
    expect(plan.blockers[0]?.details).toEqual(expect.arrayContaining([" M packages/cli/package.json", " M packages/widget/src/index.ts"]));
    expect(plan.blockers[0]?.details).not.toContain(" M packages/widget/README.md");
  });

  it("does not set aside a modified .npmrc with --ignore-local-changes, since the diagnosis already resolved the registry from it", () => {
    const state = monorepoState({ workingTreeChanges: [" M .npmrc", " M packages/widget/.npmrc", " M packages/widget/README.md"] });

    const plan = buildMonorepoPlan(state, NPM_PACKAGE, { tagFormat: TAG_FORMAT, ignoreLocalChanges: true });

    expect(plan.mode).toBe(RELEASE_MODE.blocked);
    expect(plan.blockers[0]?.title).toContain(".npmrc");
    expect(plan.blockers[0]?.details).toEqual(expect.arrayContaining([" M .npmrc", " M packages/widget/.npmrc"]));
    expect(plan.blockers[0]?.details).not.toContain(" M packages/widget/README.md");
  });

  it("chooses the versions before applying migrations, so skipping every package leaves the database untouched", () => {
    const state = monorepoState({ migrations: { status: MIGRATION_STATUS.pending, pending: ["001_init"], target: "db", reason: null } });

    const ids = stepIds(buildMonorepoPlan(state, NPM_PACKAGE, { tagFormat: TAG_FORMAT }));

    expect(ids.indexOf(MONOREPO_RELEASE_STEP.chooseVersions)).toBe(0);
    expect(ids.indexOf(MONOREPO_RELEASE_STEP.verifyChangelogs)).toBe(1);
    expect(ids.indexOf(RELEASE_STEP.applyMigrations)).toBe(2);
  });

  it("blocks when a package about to be published has credentials that cannot publish", () => {
    const widget = packageSnapshot("widget", {
      unreleasedCommits: [{ sha: "c1", subject: "feat: x", body: "" }],
      npmAuth: { status: NPM_AUTH_STATUS.notOwner, user: "someone", source: "environment", registryUrl: "https://registry.npmjs.org/", packageName: "@acme/widget", owners: ["owner"], firstPublication: false, reason: null },
    });

    const plan = buildMonorepoPlan(monorepoState({ packages: [widget, packageSnapshot("cli")] }), NPM_PACKAGE, { tagFormat: TAG_FORMAT });

    expect(plan.mode).toBe(RELEASE_MODE.blocked);
    expect(plan.blockers[0]?.title).toContain("someone, que no puede publicar @acme/widget");
  });

  it("releases from main only", () => {
    expect(buildMonorepoPlan(monorepoState({ currentBranch: null }), NPM_PACKAGE, { tagFormat: TAG_FORMAT }).blockers[0]?.title).toContain("desacoplado");
    expect(buildMonorepoPlan(monorepoState({ currentBranch: "feat/x" }), NPM_PACKAGE, { tagFormat: TAG_FORMAT }).blockers[0]?.title).toContain("los releases salen solo desde main");
  });
});
