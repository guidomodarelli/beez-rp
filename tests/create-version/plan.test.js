import { describe, expect, it } from "vitest";

import { MIGRATION_STATUS, NPM_LOOKUP_STATUS, PULL_REQUEST_STATE, RELEASE_MODE, RELEASE_STEP } from "../../src/constants/create-version.js";
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
    expect(parseReleaseArguments(["--bump", "minor", "--dry-run", "--"])).toEqual({ bump: "minor", setVersion: null, dryRun: true, help: false });
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
      main: { aheadCommits: [], behindCount: 2 },
      changelog: { exists: true, entryCount: 0, unknownSections: [] },
      npm: { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["0.1.0"], reason: null },
    });

    expect(stepIds(state, NPM_PACKAGE)).toEqual([
      RELEASE_STEP.syncMain,
      RELEASE_STEP.generateChangelog,
      RELEASE_STEP.runChecks,
      RELEASE_STEP.bumpVersion,
      RELEASE_STEP.prepareRelease,
      RELEASE_STEP.pushRelease,
      RELEASE_STEP.publishRelease,
    ]);
  });

  it("should apply pending migrations after syncing and warn when they cannot be verified", () => {
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
