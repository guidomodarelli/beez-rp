import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildMonorepoReleaseSubject, parseMonorepoReleaseSubject } from "../../src/monorepo/release-commit.js";
import {
  discoverWorkspacePackages,
  expandWorkspacePatterns,
  formatPackageTag,
  resolveReleaseUnits,
  sortByPublicationOrder,
} from "../../src/monorepo/workspaces.js";

/** @type {string[]} */
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {Record<string, Record<string, unknown>>} manifests - Directory → package.json content.
 * @param {Record<string, unknown>} [rootManifest] - Root package.json.
 * @returns {string} Repository root.
 */
function createMonorepo(manifests, rootManifest = { name: "root", private: true, workspaces: ["packages/*"] }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "beez-rp-workspaces-"));
  temporaryDirectories.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify(rootManifest));
  for (const [directory, manifest] of Object.entries(manifests)) {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, "package.json"), JSON.stringify(manifest));
  }
  return root;
}

describe("discoverWorkspacePackages", () => {
  it("reads the root workspaces (list or { packages }) and explicit patterns with exclusions", () => {
    const root = createMonorepo({
      "packages/widget": { name: "@acme/widget", version: "1.0.0" },
      "packages/core": { name: "@acme/core", private: true },
      "packages/internal": { name: "@acme/internal", version: "0.1.0" },
      "apps/demo": { name: "demo", private: true },
    });

    expect(discoverWorkspacePackages(root, "workspaces").map((workspacePackage) => workspacePackage.directory)).toEqual([
      "packages/core",
      "packages/internal",
      "packages/widget",
    ]);
    expect(discoverWorkspacePackages(root, ["packages/*", "!packages/internal", "apps/demo"]).map(({ name }) => name)).toEqual([
      "demo",
      "@acme/core",
      "@acme/widget",
    ]);

    const yarnStyle = createMonorepo({ "packages/a": { name: "a", version: "1.0.0" } }, { name: "root", workspaces: { packages: ["packages/*"] } });
    expect(discoverWorkspacePackages(yarnStyle, "workspaces").map(({ name }) => name)).toEqual(["a"]);
  });

  it("rejects unsupported globs, missing packages and duplicated names", () => {
    const root = createMonorepo({ "packages/a": { name: "a", version: "1.0.0" }, "packages/b": { name: "a", version: "1.0.0" } });

    expect(() => expandWorkspacePatterns(root, ["packages/**"])).toThrow(/not supported/);
    for (const escapingPattern of ["../shared", "packages/../../shared", "!../shared", "/abs/packages/*", "C:\\repo\\packages"]) {
      expect(() => expandWorkspacePatterns(root, [escapingPattern])).toThrow(/sale del repositorio/);
    }
    expect(() => discoverWorkspacePackages(root, ["nothing/*"])).toThrow(/no workspace package found/);
    expect(() => discoverWorkspacePackages(root, "workspaces")).toThrow(/declared in both packages\/a and packages\/b/);
  });

  it("reports a malformed manifest of a matched workspace with its path", () => {
    const root = createMonorepo({ "packages/a": { name: "a", version: "1.0.0" }, "packages/broken": {} });
    writeFileSync(path.join(root, "packages/broken/package.json"), "{ \"name\": ");

    expect(() => discoverWorkspacePackages(root, "workspaces")).toThrow(/no se pudo leer packages\/broken\/package\.json: .+/);
    writeFileSync(path.join(root, "packages/broken/package.json"), "[]");
    expect(() => discoverWorkspacePackages(root, "workspaces")).toThrow(/packages\/broken\/package\.json no es un objeto JSON/);
  });

  it("skips private workspaces without a name and rejects the non-private ones", () => {
    const root = createMonorepo({ "packages/a": { name: "a", version: "1.0.0" }, "packages/tooling": { private: true } });
    expect(discoverWorkspacePackages(root, "workspaces").map(({ name }) => name)).toEqual(["a"]);

    writeFileSync(path.join(root, "packages/tooling/package.json"), JSON.stringify({ version: "1.0.0" }));
    expect(() => discoverWorkspacePackages(root, "workspaces")).toThrow(/packages\/tooling\/package\.json no tiene "name"; agregale un "name"/);
  });

  it("rejects public workspaces without a stable X.Y.Z version and accepts private ones without it", () => {
    const root = createMonorepo({ "packages/a": { name: "a", version: "1.0.0" }, "packages/internal": { name: "internal", private: true, version: "0.0.0-dev" } });
    expect(discoverWorkspacePackages(root, "workspaces").map(({ name }) => name)).toEqual(["a", "internal"]);

    writeFileSync(path.join(root, "packages/a/package.json"), JSON.stringify({ name: "a" }));
    expect(() => discoverWorkspacePackages(root, "workspaces")).toThrow(/packages\/a\/package\.json no tiene "version"; un paquete publicado necesita una versión estable X\.Y\.Z/);

    writeFileSync(path.join(root, "packages/a/package.json"), JSON.stringify({ name: "a", version: "1.1.0-beta.1" }));
    expect(() => discoverWorkspacePackages(root, "workspaces")).toThrow(/packages\/a\/package\.json tiene "version": "1\.1\.0-beta\.1"; un paquete publicado necesita una versión estable X\.Y\.Z/);
  });
});

describe("resolveReleaseUnits", () => {
  it("releases public packages only, counting the changes of the private packages they bundle", () => {
    const root = createMonorepo({
      "packages/core": { name: "@acme/core", private: true, dependencies: { "@acme/shared": "workspace:*" } },
      "packages/shared": { name: "@acme/shared", private: true },
      "packages/widget": { name: "@acme/widget", version: "1.0.0", devDependencies: { "@acme/core": "workspace:*" } },
      "packages/adapter": { name: "@acme/adapter", version: "0.3.0", dependencies: { "@acme/widget": "^1.0.0", lodash: "^4" } },
    });

    const units = resolveReleaseUnits(discoverWorkspacePackages(root, "workspaces"));

    expect(units.map(({ name, component, changePaths, publishedDependencies }) => ({ name, component, changePaths, publishedDependencies }))).toEqual([
      { name: "@acme/adapter", component: "adapter", changePaths: ["packages/adapter"], publishedDependencies: ["@acme/widget"] },
      { name: "@acme/widget", component: "widget", changePaths: ["packages/widget", "packages/core", "packages/shared"], publishedDependencies: [] },
    ]);
    expect(units[1]).toMatchObject({ manifestPath: "packages/widget/package.json", changelogPath: "packages/widget/CHANGELOG.md" });
  });
});

describe("sortByPublicationOrder", () => {
  it("publishes dependencies first and keeps independent packages in order, even with cycles", () => {
    const ordered = sortByPublicationOrder([
      { name: "adapter", publishedDependencies: ["widget"] },
      { name: "cli", publishedDependencies: [] },
      { name: "widget", publishedDependencies: ["core-public"] },
      { name: "core-public", publishedDependencies: ["widget"] },
    ]);

    expect(ordered.map(({ name }) => name)).toEqual(["core-public", "widget", "adapter", "cli"]);
  });
});

describe("tags and release commit subjects", () => {
  it("formats the package tag with its component, name and version", () => {
    const unit = { name: "@acme/widget", component: "widget" };

    expect(formatPackageTag("{component}-v{version}", unit, "1.2.0")).toBe("widget-v1.2.0");
    expect(formatPackageTag("{name}@{version}", unit, "1.2.0")).toBe("@acme/widget@1.2.0");
  });

  it("round-trips the release commit subject and rejects anything else", () => {
    const releases = [
      { name: "@acme/widget", version: "1.2.0" },
      { name: "cli", version: "0.10.0" },
    ];
    const subject = buildMonorepoReleaseSubject(releases);

    expect(subject).toBe("release: @acme/widget@1.2.0, cli@0.10.0");
    expect(parseMonorepoReleaseSubject(subject)).toEqual(releases);
    for (const other of ["1.2.0", "release: widget", "release: widget@1.2", "feat: release: widget@1.2.0", "release: @acme/widget@1.2.0-beta.1"]) {
      expect(parseMonorepoReleaseSubject(other)).toBeNull();
    }
  });
});
