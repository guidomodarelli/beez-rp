import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandArtifactPattern, findPreparedArtifact, isSafeArtifactPath } from "../../src/create-version/artifact.js";

/** Layout used by checksum-addressed release preparation. */
const RELEASE_ARCHIVE_PATTERN = "releases/{version}-*/{name}-{version}.tgz";

/** @type {string[]} */
const temporaryDirectories = [];

/** @returns {string} Empty repository root. */
function createRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "beez-rp-artifact-"));
  temporaryDirectories.push(root);
  return root;
}

/**
 * @param {string} root - Repository root.
 * @param {string} relativePath - Archive path.
 * @param {number} modifiedAtSeconds - Modification time.
 */
function writeArchive(root, relativePath, modifiedAtSeconds) {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, "archive");
  utimesSync(absolutePath, modifiedAtSeconds, modifiedAtSeconds);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("prepared artifact", () => {
  const release = { version: "1.9.0", packageName: "eslint-plugin-no-magic" };

  it("should expand the version and package name placeholders", () => {
    expect(expandArtifactPattern(RELEASE_ARCHIVE_PATTERN, release)).toBe("releases/1.9.0-*/eslint-plugin-no-magic-1.9.0.tgz");
  });

  it("should pick the newest archive of the released version only", () => {
    const root = createRoot();
    writeArchive(root, "releases/1.9.0-aaa/eslint-plugin-no-magic-1.9.0.tgz", 1_000);
    writeArchive(root, "releases/1.9.0-bbb/eslint-plugin-no-magic-1.9.0.tgz", 2_000);
    writeArchive(root, "releases/1.10.0-ccc/eslint-plugin-no-magic-1.10.0.tgz", 3_000);
    writeArchive(root, "releases/1.9.0-ddd/other-1.9.0.tgz", 4_000);

    expect(findPreparedArtifact(root, RELEASE_ARCHIVE_PATTERN, release)).toBe("releases/1.9.0-bbb/eslint-plugin-no-magic-1.9.0.tgz");
  });

  it("should treat dots literally and return null when nothing was prepared", () => {
    const root = createRoot();
    writeArchive(root, "releases/1x9x0-aaa/eslint-plugin-no-magic-1x9x0.tgz", 1_000);

    expect(findPreparedArtifact(root, RELEASE_ARCHIVE_PATTERN, release)).toBeNull();
    expect(findPreparedArtifact(root, "missing/{version}.tgz", release)).toBeNull();
  });

  it("should only accept archive paths that are safe on a shell command line", () => {
    expect(isSafeArtifactPath("releases/1.9.0-abc/@scope+pkg_1.9.0.tgz")).toBe(true);
    expect(isSafeArtifactPath("releases/1.9.0 abc/pkg.tgz")).toBe(false);
    expect(isSafeArtifactPath("releases/../pkg.tgz")).toBe(false);
    expect(isSafeArtifactPath("releases/pkg.tgz;rm")).toBe(false);
  });
});
