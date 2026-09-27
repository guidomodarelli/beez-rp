import { describe, expect, it } from "vitest";

import { ALLOWED_NEXT_VERSIONS, CURRENT_STABLE_VERSION, REJECTED_VERSION_BUMP_CASES } from "../src/testing.js";
import {
  bumpReleaseVersion,
  compareReleaseVersions,
  findHighestStableVersion,
  isReleaseCommitSubject,
  isStableReleaseVersion,
  listAllowedVersionsAfter,
  listNextVersions,
  parseReleaseVersion,
  resolveRequestedVersion,
  suggestReleaseType,
  toReleaseTag,
} from "../src/versions.js";

describe("stable release versions", () => {
  it("should accept only plain X.Y.Z versions", () => {
    expect(isStableReleaseVersion("0.0.0")).toBe(true);
    expect(isStableReleaseVersion("10.20.30")).toBe(true);
    expect(isStableReleaseVersion(undefined)).toBe(false);
    expect(isStableReleaseVersion(123)).toBe(false);
    expect(parseReleaseVersion("0.93.4")).toEqual([0, 93, 4]);
    expect(() => parseReleaseVersion("0.93.4-beta.1")).toThrow(/expected X\.Y\.Z/);
  });

  it("should bump each semver part and reset the lower ones", () => {
    expect(bumpReleaseVersion("0.93.4", "patch")).toBe("0.93.5");
    expect(bumpReleaseVersion("0.93.4", "minor")).toBe("0.94.0");
    expect(bumpReleaseVersion("0.93.4", "major")).toBe("1.0.0");
    // @ts-expect-error unknown release type on purpose
    expect(() => bumpReleaseVersion("0.93.4", "huge")).toThrow(/unknown release type/);
  });

  it("should offer exactly the next patch, minor and major versions, patch first", () => {
    expect(listNextVersions(CURRENT_STABLE_VERSION)).toEqual([
      { releaseType: "patch", version: ALLOWED_NEXT_VERSIONS[0] },
      { releaseType: "minor", version: ALLOWED_NEXT_VERSIONS[1] },
      { releaseType: "major", version: ALLOWED_NEXT_VERSIONS[2] },
    ]);
  });

  it("should refuse to compute next versions from a current version that is not stable", () => {
    for (const currentVersion of ["1.2.3-beta.1", "1.2.3+build.5", "v1.2.3", " 1.2.3"]) {
      expect(() => listNextVersions(currentVersion)).toThrow(/expected X\.Y\.Z/);
    }
  });

  it("should let a prerelease be followed by its own stable release or the next versions of its core", () => {
    expect(listAllowedVersionsAfter("1.0.0-beta.1")).toEqual(["1.0.0", "1.0.1", "1.1.0", "2.0.0"]);
    expect(listAllowedVersionsAfter("not-a-version")).toBeNull();
  });
});

describe("requested versions (--bump and --set-version)", () => {
  it.each(ALLOWED_NEXT_VERSIONS)(`should accept --set-version ${CURRENT_STABLE_VERSION} -> %s`, (version) => {
    expect(resolveRequestedVersion(CURRENT_STABLE_VERSION, { bump: null, setVersion: version })?.version).toBe(version);
  });

  it.each(REJECTED_VERSION_BUMP_CASES)("should reject --set-version when the bump is %s (%j)", (_reason, version) => {
    expect(() => resolveRequestedVersion(CURRENT_STABLE_VERSION, { bump: null, setVersion: version })).toThrow(/--set-version/);
  });

  it("should explain which versions are allowed when one is skipped", () => {
    expect(() => resolveRequestedVersion("0.93.0", { bump: null, setVersion: "0.95.0" })).toThrow(
      "Opciones: 0.93.1, 0.94.0, 1.0.0"
    );
  });

  it("should resolve --bump and ask interactively when nothing is requested", () => {
    expect(resolveRequestedVersion("0.93.0", { bump: "patch", setVersion: null })?.version).toBe("0.93.1");
    expect(resolveRequestedVersion("0.93.0", { bump: null, setVersion: null })).toBeNull();
  });
});

describe("release commits and tags", () => {
  it("should recognize release commit subjects and build tags", () => {
    expect(isReleaseCommitSubject("0.94.0")).toBe(true);
    expect(isReleaseCommitSubject(" 0.94.0 ")).toBe(true);
    expect(isReleaseCommitSubject("0.94.0-beta.1")).toBe(false);
    expect(isReleaseCommitSubject("fix: 0.94.0")).toBe(false);
    expect(toReleaseTag("0.94.0")).toBe("v0.94.0");
  });

  it("should suggest the release type from the shipped commits", () => {
    expect(suggestReleaseType([{ subject: "fix: handle empty feed" }, { subject: "chore: bump deps" }]).releaseType).toBe("patch");
    expect(suggestReleaseType([{ subject: "fix: typo" }, { subject: "feat(events): waitlist" }]).releaseType).toBe("minor");
    expect(suggestReleaseType([{ subject: "Add personal webcal feed (#74)" }]).releaseType).toBe("minor");
    expect(suggestReleaseType([{ subject: "refactor!: drop legacy routes" }]).releaseType).toBe("major");
    expect(suggestReleaseType([{ subject: "feat: new auth", body: "BREAKING CHANGE: sessions reset" }]).releaseType).toBe("major");
    expect(suggestReleaseType([{ subject: "0.94.0" }]).releaseType).toBe("minor");
  });
});

describe("release version ordering", () => {
  it("should compare stable versions numerically, not as text", () => {
    expect(compareReleaseVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.9.0", "1.9.1")).toBeLessThan(0);
    expect(compareReleaseVersions("2.0.0", "2.0.0")).toBe(0);
    expect(() => compareReleaseVersions("1.0.0-beta.1", "1.0.0")).toThrow("X.Y.Z");
  });

  it("should find the highest stable version, ignoring prereleases and invalid entries", () => {
    expect(findHighestStableVersion(["1.8.0", "1.10.0-beta.1", "1.9.0", "latest", 3])).toBe("1.9.0");
    expect(findHighestStableVersion([])).toBeNull();
  });
});
