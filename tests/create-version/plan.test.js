import { describe, expect, it } from "vitest";

import { MIGRATION_STATUS, NPM_AUTH_STATUS, NPM_LOOKUP_STATUS, NPM_TOKEN_SOURCE, PULL_REQUEST_STATE, RELEASE_MODE, RELEASE_STEP } from "../../src/constants/create-version.js";
import { buildReleasePlan, parseReleaseArguments } from "../../src/create-version/plan.js";
import { resolveRequestedVersion } from "../../src/versions.js";
import { ALLOWED_NEXT_VERSIONS, CURRENT_STABLE_VERSION, REJECTED_VERSION_BUMP_CASES } from "../../src/testing.js";

/**
 * @typedef {import("../../src/create-version/plan.js").ReleaseState} ReleaseState
 * @typedef {import("../../src/create-version/plan.js").ReleaseCapabilities} ReleaseCapabilities
 */

/** Hand-typed `--set-version v1.2.4` means `1.2.4`, so the flag accepts the v-prefixed variant on purpose. */
const V_PREFIXED_NEXT_VERSION = "v1.2.4";

/** Every optional step configured, publishing to npm. */
const NPM_PACKAGE = { checks: true, prepare: true, publish: true, publishTitle: "Publicar en npm" };

/** A deployed app: no checks, preparation or publication. */
const DEPLOYED_APP = { checks: false, prepare: false, publish: false, publishTitle: "Publicar el release" };

/**
 * @param {Partial<ReleaseState>} [overrides] - State changes.
 * @returns {ReleaseState} State on a clean, synced `main` with one unreleased feature.
 */
function createMainState(overrides = {}) {
  return {
    currentBranch: "main",
    workingTreeChanges: [],
    branch: null,
    pullRequest: null,
    githubError: null,
    main: { aheadCommits: [], behindCount: 0 },
    headVersion: "0.1.0",
    headSubject: "feat: add gate",
    unreleasedCommits: [{ subject: "feat: add gate" }],
    npm: null,
    migrations: null,
    changelog: { exists: true, entryCount: 1, unknownSections: [] },
    ...overrides,
  };
}

/**
 * @param {ReleaseState} state - State.
 * @param {ReleaseCapabilities} [capabilities] - Configured steps.
 * @returns {string[]} Planned step ids.
 */
function stepIds(state, capabilities = DEPLOYED_APP) {
  return buildReleasePlan(state, capabilities).steps.map((planStep) => planStep.id);
}

/**
 * @param {string} version - Version typed through `--set-version=<version>`.
 * @returns {ReturnType<typeof resolveRequestedVersion>} Resolved release.
 */
function requestVersionThroughFlag(version) {
  const { bump, setVersion } = parseReleaseArguments([`--set-version=${version}`]);
  return resolveRequestedVersion(CURRENT_STABLE_VERSION, { bump, setVersion });
}

describe("create-version arguments", () => {
  it.each(ALLOWED_NEXT_VERSIONS)(`should accept --set-version ${CURRENT_STABLE_VERSION} -> %s`, (version) => {
    expect(requestVersionThroughFlag(version)?.version).toBe(version);
  });

  it("should accept a v-prefixed --set-version for the next version", () => {
    expect(requestVersionThroughFlag(V_PREFIXED_NEXT_VERSION)?.version).toBe("1.2.4");
  });

  it.each(REJECTED_VERSION_BUMP_CASES.filter(([, version]) => version !== V_PREFIXED_NEXT_VERSION))(
    "should reject --set-version when the bump is %s (%j)",
    (_reason, version) => {
      expect(() => requestVersionThroughFlag(version)).toThrow(/--set-version/);
    }
  );

  it("should parse spaced and inline flags and reject invalid combinations", () => {
    expect(parseReleaseArguments(["--bump", "minor", "--dry-run", "--"])).toEqual({ bump: "minor", setVersion: null, dryRun: true, skipUnpublished: false, help: false });
    expect(parseReleaseArguments(["--skip-unpublished"]).skipUnpublished).toBe(true);
    expect(parseReleaseArguments(["-h"]).help).toBe(true);
    expect(() => parseReleaseArguments(["--bump", "huge"])).toThrow(/--bump espera/);
    expect(() => parseReleaseArguments(["--bump", "patch", "--set-version", "0.1.1"])).toThrow(/no los dos a la vez/);
    expect(() => parseReleaseArguments(["--force"])).toThrow(/Opción inválida/);
  });
});

describe("create-version plan", () => {
  it("should bump and push a deployed app without optional steps", () => {
    expect(buildReleasePlan(createMainState(), DEPLOYED_APP).mode).toBe(RELEASE_MODE.newRelease);
    expect(stepIds(createMainState())).toEqual([RELEASE_STEP.bumpVersion, RELEASE_STEP.pushRelease]);
  });

  it("should run every configured step of an npm package in order", () => {
    const state = createMainState({
      changelog: { exists: true, entryCount: 0, unknownSections: [] },
      npm: { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["0.1.0"], reason: null },
    });

    expect(stepIds(state, NPM_PACKAGE)).toEqual([
      RELEASE_STEP.generateChangelog,
      RELEASE_STEP.runChecks,
      RELEASE_STEP.bumpVersion,
      RELEASE_STEP.prepareRelease,
      RELEASE_STEP.pushRelease,
      RELEASE_STEP.publishRelease,
    ]);
  });

  it("should only sync main when it is behind origin, because the next run diagnoses the updated code", () => {
    const state = createMainState({
      main: { aheadCommits: [], behindCount: 2 },
      changelog: { exists: true, entryCount: 0, unknownSections: [] },
      migrations: { status: MIGRATION_STATUS.pending, pending: ["0001_init"], target: "db.example.test", reason: null },
    });
    const plan = buildReleasePlan(state, NPM_PACKAGE);

    expect(plan.mode).toBe(RELEASE_MODE.newRelease);
    expect(plan.steps.map((planStep) => planStep.id)).toEqual([RELEASE_STEP.syncMain]);
    expect(plan.steps[0].detail).toContain("volver a correr pnpm create-version");
  });

  it("should apply pending migrations before the version and warn when they cannot be verified", () => {
    const pending = createMainState({ migrations: { status: MIGRATION_STATUS.pending, pending: ["0001_init"], target: "db.example.test", reason: null } });
    expect(stepIds(pending)).toEqual([RELEASE_STEP.applyMigrations, RELEASE_STEP.bumpVersion, RELEASE_STEP.pushRelease]);

    const unknown = buildReleasePlan(createMainState({ migrations: { status: MIGRATION_STATUS.unknown, pending: [], target: null, reason: "sin red" } }), DEPLOYED_APP);
    expect(unknown.blockers).toEqual([]);
    expect(unknown.warnings).toEqual([expect.stringContaining("sin red")]);
  });

  it("should resume only the push of a local release commit of a deployed app", () => {
    const state = createMainState({ headVersion: "0.2.0", headSubject: "0.2.0", main: { aheadCommits: [{ subject: "0.2.0" }], behindCount: 0 } });
    const plan = buildReleasePlan(state, DEPLOYED_APP);

    expect(plan.mode).toBe(RELEASE_MODE.resume);
    expect(plan.pendingVersion).toBe("0.2.0");
    expect(stepIds(state)).toEqual([RELEASE_STEP.pushRelease]);
  });

  it("should resume the preparation, push and publication of a package release that never reached npm", () => {
    const npm = { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["0.1.0"], reason: null };
    const local = createMainState({ headVersion: "0.2.0", headSubject: "0.2.0", npm, main: { aheadCommits: [{ subject: "0.2.0" }], behindCount: 0 } });
    expect(stepIds(local, NPM_PACKAGE)).toEqual([RELEASE_STEP.prepareRelease, RELEASE_STEP.pushRelease, RELEASE_STEP.publishRelease]);

    const pushed = createMainState({ headVersion: "0.2.0", headSubject: "0.2.0", npm });
    expect(stepIds(pushed, NPM_PACKAGE)).toEqual([RELEASE_STEP.prepareRelease, RELEASE_STEP.publishRelease]);
  });

  it("should consider a pushed and published release commit up to date", () => {
    const state = createMainState({
      headVersion: "0.2.0",
      headSubject: "0.2.0",
      unreleasedCommits: [],
      npm: { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["0.2.0"], reason: null },
    });

    expect(buildReleasePlan(state, NPM_PACKAGE).mode).toBe(RELEASE_MODE.upToDate);
  });

  it("should accept an uncommitted CHANGELOG.md but block other changes and foreign commits on main", () => {
    expect(stepIds(createMainState({ workingTreeChanges: [" M CHANGELOG.md"] }))).toEqual([RELEASE_STEP.bumpVersion, RELEASE_STEP.pushRelease]);

    const plan = buildReleasePlan(createMainState({ workingTreeChanges: [" M package.json"], main: { aheadCommits: [{ subject: "fix: local hack" }], behindCount: 0 } }), DEPLOYED_APP);
    expect(plan.mode).toBe(RELEASE_MODE.blocked);
    expect(plan.blockers.map((blocker) => blocker.title)).toEqual([expect.stringContaining("sin commitear")]);

    const foreign = buildReleasePlan(createMainState({ main: { aheadCommits: [{ subject: "fix: local hack" }], behindCount: 0 } }), DEPLOYED_APP);
    expect(foreign.blockers[0].title).toContain("no están en origin");
  });

  it("should block unknown [Unreleased] sections and an unreachable npm", () => {
    expect(buildReleasePlan(createMainState({ changelog: { exists: true, entryCount: 1, unknownSections: ["Mejoras"] } }), DEPLOYED_APP).blockers[0].title).toContain("Mejoras");
    expect(buildReleasePlan(createMainState({ npm: { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: "offline" } }), NPM_PACKAGE).blockers[0].title).toContain("npm");
  });

  it("should block a detached HEAD and a feature branch with its next actions", () => {
    expect(buildReleasePlan(createMainState({ currentBranch: null }), DEPLOYED_APP).blockers[0].title).toContain("desacoplado");

    const plan = buildReleasePlan(
      createMainState({
        currentBranch: "feature/waitlist",
        branch: { name: "feature/waitlist", headSha: "abc", hasUpstream: true, unpushedCount: 2, aheadOfMainCount: 3 },
        pullRequest: { number: 81, url: "https://github.com/acme/app/pull/81", state: PULL_REQUEST_STATE.open, isDraft: true, headRefOid: "old" },
      }),
      DEPLOYED_APP
    );
    expect(plan.blockers[0].details).toEqual([
      "2 commit(s) sin subir: git push.",
      "Falta mergear el PR #81 (está en borrador): https://github.com/acme/app/pull/81",
      "Después hacé git switch main y corré pnpm create-version.",
    ]);

    const merged = buildReleasePlan(
      createMainState({
        currentBranch: "feature/waitlist",
        branch: { name: "feature/waitlist", headSha: "abc", hasUpstream: false, unpushedCount: 0, aheadOfMainCount: 1 },
        pullRequest: { number: 81, url: "https://github.com/acme/app/pull/81", state: PULL_REQUEST_STATE.merged, isDraft: false, headRefOid: "abc" },
      }),
      DEPLOYED_APP
    );
    expect(merged.blockers[0].details).toEqual(["El PR #81 ya está mergeado: hacé git switch main."]);
  });

  it("should plan nothing when everything is already released", () => {
    expect(buildReleasePlan(createMainState({ unreleasedCommits: [] }), DEPLOYED_APP).mode).toBe(RELEASE_MODE.upToDate);
  });
});

/**
 * @param {Partial<import("../../src/create-version/npm.js").NpmAuthCheck>} [overrides] - Check changes.
 * @returns {import("../../src/create-version/npm.js").NpmAuthCheck} Passing check of `fixture-app`.
 */
function createNpmAuth(overrides = {}) {
  return {
    status: NPM_AUTH_STATUS.ok,
    user: "fixture-owner",
    source: NPM_TOKEN_SOURCE.repository,
    registryUrl: "https://registry.npmjs.org/",
    packageName: "fixture-app",
    owners: ["fixture-owner"],
    firstPublication: false,
    reason: null,
    ...overrides,
  };
}

/** npm lookup that only has `0.1.0`. */
const NPM_WITH_FIRST_RELEASE = { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["0.1.0"], reason: null };

describe("create-version plan with npm credentials", () => {
  it("should block a plan that publishes when the token is missing, invalid or cannot publish the package", () => {
    const missing = buildReleasePlan(createMainState({ npm: NPM_WITH_FIRST_RELEASE, npmAuth: createNpmAuth({ status: NPM_AUTH_STATUS.missingToken, user: null, source: null }) }), NPM_PACKAGE);
    expect(missing.mode).toBe(RELEASE_MODE.blocked);
    expect(missing.blockers[0].title).toBe("Falta NPM_TOKEN para publicar fixture-app");

    const invalid = buildReleasePlan(createMainState({ npm: NPM_WITH_FIRST_RELEASE, npmAuth: createNpmAuth({ status: NPM_AUTH_STATUS.invalidToken, user: null }) }), NPM_PACKAGE);
    expect(invalid.blockers[0].title).toBe("El NPM_TOKEN (.env del repo) es inválido o venció");

    const notOwner = buildReleasePlan(createMainState({ npm: NPM_WITH_FIRST_RELEASE, npmAuth: createNpmAuth({ status: NPM_AUTH_STATUS.notOwner, user: "fixture-stranger" }) }), NPM_PACKAGE);
    expect(notOwner.blockers[0].title).toBe("El token autentica como fixture-stranger, que no puede publicar fixture-app (dueños: fixture-owner)");
  });

  it("should ignore the credentials when the plan would not publish", () => {
    const invalidAuth = createNpmAuth({ status: NPM_AUTH_STATUS.invalidToken, user: null });

    expect(buildReleasePlan(createMainState({ npmAuth: invalidAuth }), DEPLOYED_APP).mode).toBe(RELEASE_MODE.newRelease);
    expect(buildReleasePlan(createMainState({ npmAuth: invalidAuth, unreleasedCommits: [] }), NPM_PACKAGE).mode).toBe(RELEASE_MODE.upToDate);
    expect(stepIds(createMainState({ npmAuth: invalidAuth, main: { aheadCommits: [], behindCount: 1 } }), NPM_PACKAGE)).toEqual([RELEASE_STEP.syncMain]);
  });

  it("should block the resume of a publication too and only warn when the check could not decide", () => {
    const resumed = createMainState({ headVersion: "0.2.0", headSubject: "0.2.0", npm: NPM_WITH_FIRST_RELEASE, npmAuth: createNpmAuth({ status: NPM_AUTH_STATUS.invalidToken }) });
    expect(buildReleasePlan(resumed, NPM_PACKAGE).mode).toBe(RELEASE_MODE.blocked);

    const unknown = buildReleasePlan(createMainState({ npmAuth: createNpmAuth({ status: NPM_AUTH_STATUS.unknown, reason: "sin red" }) }), NPM_PACKAGE);
    expect(unknown.mode).toBe(RELEASE_MODE.newRelease);
    expect(unknown.warnings).toEqual([expect.stringContaining("sin red")]);
  });
});

describe("create-version plan with a last release missing from npm", () => {
  /** `origin/main` whose last release `0.2.0` (commit `0.2.0` with tag `v0.2.0`) never reached npm. */
  const UNPUBLISHED_RELEASE = {
    releasedVersion: "0.2.0",
    lastRelease: { sha: "release-sha", version: "0.2.0", subject: "0.2.0", tagged: true },
    headVersion: "0.2.0",
    headSubject: "Merge pull request #3",
    npm: NPM_WITH_FIRST_RELEASE,
  };

  it("should not plan a new release that would skip it, and explain how to publish it from its tag", () => {
    const plan = buildReleasePlan(createMainState(UNPUBLISHED_RELEASE), NPM_PACKAGE);

    expect(plan.mode).toBe(RELEASE_MODE.blocked);
    expect(plan.blockers[0].title).toBe("La versión 0.2.0 (último release, tag v0.2.0) no está en npm");
    expect(plan.blockers[0].details.join("\n")).toContain("git switch --detach v0.2.0 y pnpm create-version");
    expect(plan.blockers[0].details.join("\n")).toContain("--skip-unpublished");
  });

  it("should plan the new release with a warning when --skip-unpublished skips it on purpose", () => {
    const plan = buildReleasePlan(createMainState(UNPUBLISHED_RELEASE), NPM_PACKAGE, { skipUnpublished: true });

    expect(plan.mode).toBe(RELEASE_MODE.newRelease);
    expect(plan.warnings).toEqual([expect.stringContaining("Se saltea 0.2.0 (tag v0.2.0)")]);
  });

  it("should block when nothing was published yet, and ask to publish by hand a release that cannot be resumed", () => {
    const neverPublished = buildReleasePlan(createMainState({ ...UNPUBLISHED_RELEASE, npm: { ...NPM_WITH_FIRST_RELEASE, publishedVersions: [] } }), NPM_PACKAGE);
    expect(neverPublished.blockers[0].details[0]).toContain("npm no tiene ninguna versión publicada");

    const untagged = buildReleasePlan(createMainState({ ...UNPUBLISHED_RELEASE, lastRelease: { ...UNPUBLISHED_RELEASE.lastRelease, tagged: false } }), NPM_PACKAGE);
    expect(untagged.blockers[0].details.join("\n")).toContain("publicala a mano");
  });

  it("should plan the first release of a package whose initial untagged version was never published", () => {
    const initialVersion = createMainState({
      ...UNPUBLISHED_RELEASE,
      lastRelease: { sha: "init-sha", version: "0.2.0", subject: "chore: init", tagged: false },
      npm: { ...NPM_WITH_FIRST_RELEASE, publishedVersions: [] },
    });

    expect(buildReleasePlan(initialVersion, NPM_PACKAGE).mode).toBe(RELEASE_MODE.newRelease);
  });

  it("should ignore old versions below the latest published one and projects that do not track npm", () => {
    const olderThanLatest = createMainState({ ...UNPUBLISHED_RELEASE, npm: { ...NPM_WITH_FIRST_RELEASE, publishedVersions: ["0.1.0", "0.3.0"] } });
    expect(buildReleasePlan(olderThanLatest, NPM_PACKAGE).mode).toBe(RELEASE_MODE.newRelease);
    expect(buildReleasePlan(createMainState({ ...UNPUBLISHED_RELEASE, npm: null }), DEPLOYED_APP).mode).toBe(RELEASE_MODE.newRelease);
  });
});

describe("create-version plan from a detached release tag", () => {
  /** Detached `HEAD` on the `0.2.0` commit of tag `v0.2.0`, missing from npm. */
  const DETACHED_ON_TAG = { currentBranch: null, headVersion: "0.2.0", headSubject: "0.2.0", headReleaseTag: "v0.2.0", npm: NPM_WITH_FIRST_RELEASE };

  it("should only prepare and publish the tagged release, without syncing nor pushing main", () => {
    const plan = buildReleasePlan(createMainState({ ...DETACHED_ON_TAG, main: { aheadCommits: [], behindCount: 3 } }), NPM_PACKAGE);

    expect(plan.mode).toBe(RELEASE_MODE.resume);
    expect(plan.pendingVersion).toBe("0.2.0");
    expect(plan.steps.map((planStep) => planStep.id)).toEqual([RELEASE_STEP.prepareRelease, RELEASE_STEP.publishRelease]);
  });

  it("should block a detached HEAD that is not an unpublished tagged release", () => {
    expect(buildReleasePlan(createMainState({ ...DETACHED_ON_TAG, npm: { ...NPM_WITH_FIRST_RELEASE, publishedVersions: ["0.1.0", "0.2.0"] } }), NPM_PACKAGE).blockers[0].title).toContain(
      "desacoplado"
    );
    expect(buildReleasePlan(createMainState({ ...DETACHED_ON_TAG, headReleaseTag: null }), NPM_PACKAGE).blockers[0].title).toContain("desacoplado");
    expect(buildReleasePlan(createMainState({ ...DETACHED_ON_TAG, headSubject: "fix: hotfix" }), NPM_PACKAGE).blockers[0].title).toContain("desacoplado");
  });

  it("should still require valid npm credentials to publish from the tag", () => {
    const plan = buildReleasePlan(createMainState({ ...DETACHED_ON_TAG, npmAuth: createNpmAuth({ status: NPM_AUTH_STATUS.invalidToken }) }), NPM_PACKAGE);

    expect(plan.mode).toBe(RELEASE_MODE.blocked);
    expect(plan.blockers[0].title).toContain("inválido o venció");
  });
});
