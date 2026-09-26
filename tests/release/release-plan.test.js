import { describe, expect, it } from "vitest";

import { NPM_LOOKUP_STATUS, RELEASE_MODE, RELEASE_STEP } from "../../scripts/constants/release.js";
import { buildReleasePlan, parseReleaseArguments } from "../../scripts/release/release-plan.js";

/**
 * @param {Partial<import("../../scripts/release/release-plan.js").ReleaseState>} [overrides] - State changes.
 * @returns {import("../../scripts/release/release-plan.js").ReleaseState} State on a clean, synced `main`.
 */
function createMainState(overrides = {}) {
  return {
    currentBranch: "main",
    workingTreeChanges: [],
    main: { aheadCommits: [], behindCount: 0 },
    headVersion: "0.1.0",
    headSubject: "feat: add gate",
    npm: { status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["0.1.0"], reason: null },
    unreleasedCommits: [{ subject: "feat: add gate" }],
    changelog: { exists: true, entryCount: 1, unknownSections: [] },
    ...overrides,
  };
}

/**
 * @param {import("../../scripts/release/release-plan.js").ReleaseState} state - State.
 * @returns {string[]} Planned step ids.
 */
function stepIds(state) {
  return buildReleasePlan(state).steps.map((planStep) => planStep.id);
}

describe("release plan", () => {
  it("should validate, bump, push and publish a new release from a clean main", () => {
    expect(buildReleasePlan(createMainState()).mode).toBe(RELEASE_MODE.newRelease);
    expect(stepIds(createMainState())).toEqual([RELEASE_STEP.runChecks, RELEASE_STEP.bumpVersion, RELEASE_STEP.pushRelease, RELEASE_STEP.publishPackage]);
  });

  it("should publish the first release of a package that is not on npm yet", () => {
    const state = createMainState({ headVersion: "0.0.0", headSubject: "add beez-rp", npm: { status: NPM_LOOKUP_STATUS.ok, publishedVersions: [], reason: null } });

    expect(buildReleasePlan(state).mode).toBe(RELEASE_MODE.newRelease);
  });

  it("should sync main and ask Codex for an empty [Unreleased] before validating", () => {
    const state = createMainState({ main: { aheadCommits: [], behindCount: 2 }, changelog: { exists: true, entryCount: 0, unknownSections: [] } });

    expect(stepIds(state)).toEqual([
      RELEASE_STEP.syncMain,
      RELEASE_STEP.generateChangelog,
      RELEASE_STEP.runChecks,
      RELEASE_STEP.bumpVersion,
      RELEASE_STEP.pushRelease,
      RELEASE_STEP.publishPackage,
    ]);
  });

  it("should only push and publish a release commit that never reached npm", () => {
    const state = createMainState({
      headVersion: "0.2.0",
      headSubject: "0.2.0",
      main: { aheadCommits: [{ subject: "0.2.0" }], behindCount: 0 },
    });
    const plan = buildReleasePlan(state);

    expect(plan.mode).toBe(RELEASE_MODE.resume);
    expect(plan.pendingVersion).toBe("0.2.0");
    expect(stepIds(state)).toEqual([RELEASE_STEP.pushRelease, RELEASE_STEP.publishPackage]);
  });

  it("should only publish a release commit that was pushed but not published", () => {
    const state = createMainState({ headVersion: "0.2.0", headSubject: "0.2.0" });

    expect(stepIds(state)).toEqual([RELEASE_STEP.publishPackage]);
  });

  it("should report nothing to do when everything is published", () => {
    expect(buildReleasePlan(createMainState({ unreleasedCommits: [] })).mode).toBe(RELEASE_MODE.upToDate);
  });

  it("should block a feature branch, uncommitted files, foreign local commits and an unreachable npm", () => {
    expect(buildReleasePlan(createMainState({ currentBranch: "feature/x" })).blockers[0].title).toContain("feature/x");
    expect(buildReleasePlan(createMainState({ currentBranch: null })).blockers[0].title).toContain("desacoplado");
    expect(buildReleasePlan(createMainState({ workingTreeChanges: [" M src/versions.js"] })).blockers[0].title).toContain("sin commitear");
    expect(buildReleasePlan(createMainState({ main: { aheadCommits: [{ subject: "fix: local" }], behindCount: 0 } })).blockers[0].title).toContain("no están en origin");
    expect(buildReleasePlan(createMainState({ npm: { status: NPM_LOOKUP_STATUS.failed, publishedVersions: [], reason: "ENOTFOUND" } })).blockers[0].details[0]).toContain("ENOTFOUND");
  });

  it("should accept an uncommitted CHANGELOG.md, since it travels in the release commit", () => {
    expect(buildReleasePlan(createMainState({ workingTreeChanges: [" M CHANGELOG.md"] })).blockers).toEqual([]);
  });

  it("should block [Unreleased] sections outside Keep a Changelog", () => {
    const plan = buildReleasePlan(createMainState({ changelog: { exists: true, entryCount: 1, unknownSections: ["Mejoras"] } }));

    expect(plan.steps).toEqual([]);
    expect(plan.blockers[0].title).toContain("Mejoras");
  });
});

describe("release arguments", () => {
  it("should parse the flags and accept a v-prefixed --set-version", () => {
    expect(parseReleaseArguments(["--bump", "minor", "--dry-run"])).toEqual({ bump: "minor", setVersion: null, dryRun: true, help: false });
    expect(parseReleaseArguments(["--set-version=v1.0.0"]).setVersion).toBe("1.0.0");
    expect(parseReleaseArguments(["--", "--help"]).help).toBe(true);
  });

  it("should reject unknown flags, invalid bumps and both version flags at once", () => {
    expect(() => parseReleaseArguments(["--bump", "huge"])).toThrow(/--bump espera/);
    expect(() => parseReleaseArguments(["--bump", "patch", "--set-version", "0.1.1"])).toThrow(/no los dos a la vez/);
    expect(() => parseReleaseArguments(["--force"])).toThrow(/Opción inválida/);
  });
});
