import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createGitReader } from "../../src/create-version/process.js";
import { findLastPackageRelease } from "../../src/monorepo/state.js";
import { cleanupTemporaryDirectories, createTemporaryDirectory, runGit } from "../create-version/support/cli-harness.js";

const TAG_FORMAT = "{component}-v{version}";

afterEach(() => {
  cleanupTemporaryDirectories();
});

/**
 * @param {string} component - Package directory under `packages/`.
 * @returns {import("../../src/monorepo/workspaces.js").ReleaseUnit} Minimal released unit.
 */
function releaseUnit(component) {
  return /** @type {import("../../src/monorepo/workspaces.js").ReleaseUnit} */ ({
    name: `@acme/${component}`,
    component,
    directory: `packages/${component}`,
    manifestPath: `packages/${component}/package.json`,
  });
}

/**
 * Commits two packages added together with `subject`, after an unrelated first commit.
 *
 * @param {string} subject - Subject of the commit that adds both packages.
 * @returns {string} Repository.
 */
function createRepositoryAddingTwoPackages(subject) {
  const repositoryRoot = createTemporaryDirectory("beez-rp-monorepo-state-");
  runGit(["init", "--quiet", "--initial-branch=main"], repositoryRoot);
  for (const [key, value] of [["user.email", "release@example.test"], ["user.name", "Release Fixture"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) {
    runGit(["config", key, value], repositoryRoot);
  }
  writeFileSync(path.join(repositoryRoot, "README.md"), "# acme\n");
  runGit(["add", "-A"], repositoryRoot);
  runGit(["commit", "--quiet", "-m", "chore: init"], repositoryRoot);
  for (const component of ["alpha", "beta"]) {
    mkdirSync(path.join(repositoryRoot, "packages", component), { recursive: true });
    writeFileSync(path.join(repositoryRoot, "packages", component, "package.json"), `${JSON.stringify({ name: `@acme/${component}`, version: "0.1.0" }, null, 2)}\n`);
  }
  runGit(["add", "-A"], repositoryRoot);
  runGit(["commit", "--quiet", "-m", subject], repositoryRoot);
  return repositoryRoot;
}

describe("findLastPackageRelease", () => {
  it("does not take the commit that added a package as its release because another package's tag points at it", async () => {
    const repositoryRoot = createRepositoryAddingTwoPackages("feat: add alpha and beta");
    runGit(["tag", "alpha-v0.1.0"], repositoryRoot);
    const reader = createGitReader(repositoryRoot);

    expect(await findLastPackageRelease(reader, "HEAD", releaseUnit("alpha"), TAG_FORMAT, new Set())).toMatchObject({ version: "0.1.0", tagged: true });
    expect(await findLastPackageRelease(reader, "HEAD", releaseUnit("beta"), TAG_FORMAT, new Set())).toBeNull();
  });

  it("keeps a release commit that lists the package as its release even when its tag follows another tagFormat", async () => {
    const repositoryRoot = createRepositoryAddingTwoPackages("release: @acme/alpha@0.1.0");
    runGit(["tag", "alpha-v0.1.0"], repositoryRoot);
    const reader = createGitReader(repositoryRoot);

    expect(await findLastPackageRelease(reader, "HEAD", releaseUnit("alpha"), "{component}@{version}", new Set())).toMatchObject({ version: "0.1.0", tagged: false });
    expect(await findLastPackageRelease(reader, "HEAD", releaseUnit("beta"), "{component}@{version}", new Set())).toBeNull();
  });

  it("does not take a later commit that sets a package to the 0.0.0 placeholder as its release", async () => {
    const repositoryRoot = createRepositoryAddingTwoPackages("feat: add alpha and beta");
    const manifestPath = path.join(repositoryRoot, "packages/alpha/package.json");
    writeFileSync(manifestPath, `${JSON.stringify({ name: "@acme/alpha", version: "0.0.0" }, null, 2)}\n`);
    runGit(["commit", "--quiet", "-am", "chore(alpha): use the release-please placeholder"], repositoryRoot);
    const reader = createGitReader(repositoryRoot);

    expect(await findLastPackageRelease(reader, "HEAD", releaseUnit("alpha"), TAG_FORMAT, new Set())).toBeNull();
  });
});
