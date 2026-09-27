import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  computeSha256,
  expandArtifactPattern,
  findPreparedArtifact,
  isSafeArtifactPath,
  readTarballEntries,
  verifyPreparedArtifact,
} from "../../src/create-version/artifact.js";
import { withNpmAuthConfig } from "../../src/create-version/npm.js";

/** Layout used by checksum-addressed release preparation. */
const CHECKSUM_ARCHIVE_PATTERN = "releases/{version}-{sha256}/{name}-{version}.tgz";

/** Manifest of the fixture package. */
const MANIFEST = { name: "fixture-pkg", version: "1.2.0", files: ["dist"], exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } };

/** @type {string[]} */
const temporaryDirectories = [];

/** @returns {string} Empty repository root. */
function createRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "beez-rp-artifact-"));
  temporaryDirectories.push(root);
  return root;
}

/**
 * Packs files into `package/` exactly like npm, using relative paths so any tar works on Windows.
 *
 * @param {string} root - Repository root.
 * @param {Record<string, string>} files - Paths relative to `package/` and their contents.
 * @param {string} archiveName - Archive file name, written in the root.
 * @returns {string} Archive path relative to the root.
 */
function packArchive(root, files, archiveName = "archive.tgz") {
  const staging = mkdtempSync(path.join(root, "stage-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(staging, "package", relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  const result = spawnSync("tar", ["-czf", archiveName, "package"], { cwd: staging, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
  renameSync(path.join(staging, archiveName), path.join(root, archiveName));
  rmSync(staging, { recursive: true, force: true });
  return archiveName;
}

/**
 * Stores an archive under `releases/<version>-<sha256>/` like release preparation does.
 *
 * @param {string} root - Repository root.
 * @param {string} archive - Archive path relative to the root.
 * @param {string} version - Version in the directory name.
 * @returns {string} Stored path relative to the root.
 */
function storeWithChecksum(root, archive, version = MANIFEST.version) {
  const digest = computeSha256(path.join(root, archive));
  const relativeDirectory = `releases/${version}-${digest}`;
  mkdirSync(path.join(root, relativeDirectory), { recursive: true });
  const stored = `${relativeDirectory}/${MANIFEST.name}-${version}.tgz`;
  renameSync(path.join(root, archive), path.join(root, stored));
  return stored;
}

/** @returns {Record<string, string>} A publishable package. */
function validPackage() {
  return {
    "package.json": JSON.stringify(MANIFEST),
    "README.md": "# fixture",
    "dist/index.js": "export {};",
    "dist/index.d.ts": "export {};",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("prepared artifact lookup", () => {
  const release = { version: "1.9.0", packageName: "eslint-plugin-no-magic" };

  it("should expand the version and package name placeholders and keep {sha256}", () => {
    expect(expandArtifactPattern(CHECKSUM_ARCHIVE_PATTERN, release)).toBe("releases/1.9.0-{sha256}/eslint-plugin-no-magic-1.9.0.tgz");
  });

  it("should pick the newest archive of the released version and capture its declared checksum", () => {
    const root = createRoot();
    const older = "a".repeat(64);
    const newer = "b".repeat(64);
    /** @type {[string, number][]} */
    const prepared = [[`1.9.0-${older}`, 1_000], [`1.9.0-${newer}`, 2_000], [`1.10.0-${"c".repeat(64)}`, 3_000], ["1.9.0-not-a-digest", 4_000]];
    for (const [directory, seconds] of prepared) {
      const archive = path.join(root, "releases", directory, `eslint-plugin-no-magic-${directory.split("-")[0]}.tgz`);
      mkdirSync(path.dirname(archive), { recursive: true });
      writeFileSync(archive, "archive");
      utimesSync(archive, seconds, seconds);
    }

    expect(findPreparedArtifact(root, CHECKSUM_ARCHIVE_PATTERN, release)).toEqual({
      path: `releases/1.9.0-${newer}/eslint-plugin-no-magic-1.9.0.tgz`,
      expectedSha256: newer,
    });
    expect(findPreparedArtifact(root, "releases/{version}-*/{name}-{version}.tgz", release)?.expectedSha256).toBeNull();
    expect(findPreparedArtifact(root, "missing/{version}.tgz", release)).toBeNull();
  });

  it("should expand {name} of a scoped package to the tarball base name npm pack produces", () => {
    const scopedRelease = { version: "1.2.3", packageName: "@scope/pkg" };

    expect(expandArtifactPattern(CHECKSUM_ARCHIVE_PATTERN, scopedRelease)).toBe("releases/1.2.3-{sha256}/scope-pkg-1.2.3.tgz");
    expect(expandArtifactPattern("{name}.tgz", release)).toBe("eslint-plugin-no-magic.tgz");
  });

  it("should find the archive npm pack wrote for a scoped package", () => {
    const root = createRoot();
    const digest = "d".repeat(64);
    const archive = path.join(root, "releases", `1.2.3-${digest}`, "scope-pkg-1.2.3.tgz");
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(archive, "archive");

    expect(findPreparedArtifact(root, CHECKSUM_ARCHIVE_PATTERN, { version: "1.2.3", packageName: "@scope/pkg" })).toEqual({
      path: `releases/1.2.3-${digest}/scope-pkg-1.2.3.tgz`,
      expectedSha256: digest,
    });
  });

  it("should only accept archive paths that are safe on a shell command line", () => {
    expect(isSafeArtifactPath("releases/1.9.0-abc/@scope+pkg_1.9.0.tgz")).toBe(true);
    expect(isSafeArtifactPath("releases/1.9.0 abc/pkg.tgz")).toBe(false);
    expect(isSafeArtifactPath("releases/../pkg.tgz")).toBe(false);
    expect(isSafeArtifactPath("releases/pkg.tgz;rm")).toBe(false);
  });
});

describe("prepared artifact verification", () => {
  /**
   * @param {Record<string, string>} files - Packed files.
   * @param {Record<string, unknown>} [manifest] - Repository manifest.
   * @returns {string[]} Verification problems.
   */
  function verify(files, manifest = MANIFEST) {
    const root = createRoot();
    const stored = storeWithChecksum(root, packArchive(root, files));
    const artifact = findPreparedArtifact(root, CHECKSUM_ARCHIVE_PATTERN, { version: MANIFEST.version, packageName: MANIFEST.name });
    expect(artifact?.path).toBe(stored);
    return verifyPreparedArtifact(root, /** @type {import("../../src/create-version/artifact.js").PreparedArtifact} */ (artifact), manifest);
  }

  it("should accept a package whose checksum, name, version, files and entrypoints match", () => {
    expect(verify(validPackage())).toEqual([]);
  });

  it("should read long file names written as GNU or PAX tar headers", () => {
    const root = createRoot();
    const longPath = `dist/${"nested/".repeat(20)}index.js`;
    const archive = packArchive(root, { ...validPackage(), [longPath]: "export {};" });

    expect(readTarballEntries(readFileSync(path.join(root, archive))).map((entry) => entry.name)).toContain(`package/${longPath}`);
  });

  it("should reject an archive whose checksum differs from its directory", () => {
    const root = createRoot();
    const stored = storeWithChecksum(root, packArchive(root, validPackage()));
    writeFileSync(path.join(root, stored), readFileSync(path.join(root, stored)).subarray(0, 40));
    const artifact = /** @type {import("../../src/create-version/artifact.js").PreparedArtifact} */ (
      findPreparedArtifact(root, CHECKSUM_ARCHIVE_PATTERN, { version: MANIFEST.version, packageName: MANIFEST.name })
    );

    expect(verifyPreparedArtifact(root, artifact, MANIFEST)).toEqual([expect.stringContaining("no coincide")]);
  });

  it("should reject private files, undeclared files, missing entrypoints and a different package", () => {
    const { "dist/index.d.ts": _removed, ...withoutTypes } = validPackage();

    expect(verify({ ...validPackage(), ".env": "NPM_TOKEN=secret" })).toEqual([expect.stringContaining("archivo privado")]);
    expect(verify({ ...validPackage(), "src/index.ts": "export {};" })).toEqual([expect.stringContaining('fuera de "files"')]);
    expect(verify(withoutTypes)).toEqual([expect.stringContaining("dist/index.d.ts")]);
    expect(verify({ ...validPackage(), "package.json": JSON.stringify({ ...MANIFEST, version: "1.1.0" }) })).toEqual([expect.stringContaining("fixture-pkg@1.1.0")]);
  });

  it("should accept files matched by npm globs and directory entries, and reject files no entry covers", () => {
    const globManifest = { ...MANIFEST, files: ["./dist/**/*.js", "dist/*.d.ts", "docs/", "!dist/internal"] };
    const globPackage = {
      ...validPackage(),
      "package.json": JSON.stringify(globManifest),
      "dist/nested/deep/util.js": "export {};",
      "docs/rules/guide.md": "# guide",
    };

    expect(verify(globPackage, globManifest)).toEqual([]);
    expect(verify({ ...globPackage, "dist/notes.md": "notes" }, globManifest)).toEqual([expect.stringContaining('fuera de "files" en el tarball: dist/notes.md')]);
    expect(verify({ ...globPackage, "dist/internal/secret.js": "export {};" }, globManifest)).toEqual([
      expect.stringContaining('fuera de "files" en el tarball: dist/internal/secret.js'),
    ]);
  });

  it("should accept main and bin files outside files, as npm always packs them", () => {
    const binObjectManifest = { ...MANIFEST, main: "./lib/main.js", bin: { "fixture-cli": "./bin/cli.js" } };
    const binStringManifest = { ...MANIFEST, bin: "bin/cli.js" };
    const withEntryFiles = { ...validPackage(), "lib/main.js": "export {};", "bin/cli.js": "#!/usr/bin/env node" };

    expect(verify({ ...withEntryFiles, "package.json": JSON.stringify(binObjectManifest) }, binObjectManifest)).toEqual([]);
    expect(verify({ ...validPackage(), "bin/cli.js": "#!/usr/bin/env node", "package.json": JSON.stringify(binStringManifest) }, binStringManifest)).toEqual([]);
  });

  it("should reject a packed manifest whose dependencies or install scripts differ from the repository", () => {
    const repositoryManifest = { ...MANIFEST, dependencies: { "left-pad": "^1.3.0" } };
    const withDependencies = { ...validPackage(), "package.json": JSON.stringify(repositoryManifest) };

    expect(verify(withDependencies, repositoryManifest)).toEqual([]);
    expect(verify({ ...withDependencies, "package.json": JSON.stringify({ ...repositoryManifest, dependencies: { "left-pad": "^2.0.0" } }) }, repositoryManifest)).toEqual([
      expect.stringContaining('"dependencies"'),
    ]);
    expect(
      verify({ ...withDependencies, "package.json": JSON.stringify({ ...repositoryManifest, scripts: { postinstall: "node steal.js" } }) }, repositoryManifest)
    ).toEqual([expect.stringContaining('script "postinstall"')]);
    expect(verify({ ...withDependencies, "package.json": JSON.stringify({ ...repositoryManifest, exports: "./dist/index.js" }) }, repositoryManifest)).toEqual([
      expect.stringContaining('"exports"'),
    ]);
  });

  it("should accept the fields pnpm pack rewrites: publishConfig overrides and workspace or catalog dependencies", () => {
    const repositoryManifest = {
      ...MANIFEST,
      dependencies: { "shared-utils": "workspace:^", "shared-theme": "catalog:" },
      publishConfig: { access: "public", types: "./dist/index.d.ts" },
    };
    const packedManifest = { ...repositoryManifest, dependencies: { "shared-utils": "^1.4.0", "shared-theme": "^2.0.0" }, types: "./dist/index.d.ts" };

    expect(verify({ ...validPackage(), "package.json": JSON.stringify(packedManifest) }, repositoryManifest)).toEqual([]);
    expect(
      verify({ ...validPackage(), "package.json": JSON.stringify({ ...packedManifest, dependencies: { "shared-utils": "^1.4.0" } }) }, repositoryManifest)
    ).toEqual([expect.stringContaining('"dependencies"')]);
  });

  it("should check the entrypoints of the packed manifest, the one npm publishes", () => {
    const repositoryManifest = { ...MANIFEST, publishConfig: { main: "./dist/published.js" } };
    const packedManifest = { ...MANIFEST, main: "./dist/published.js" };

    expect(verify({ ...validPackage(), "package.json": JSON.stringify(packedManifest) }, repositoryManifest)).toEqual([
      expect.stringContaining("falta el entrypoint público dist/published.js"),
    ]);
    expect(verify({ ...validPackage(), "dist/published.js": "export {};", "package.json": JSON.stringify(packedManifest) }, repositoryManifest)).toEqual([]);
  });
});

describe("repeated checksum placeholders", () => {
  const release = { version: "1.2.0", packageName: "fixture-pkg" };
  const matchingDigest = "a".repeat(64);
  const otherDigest = "b".repeat(64);

  /**
   * @param {string} root - Repository root.
   * @param {string} relativePath - Archive path relative to the root.
   * @param {number} seconds - Modification time.
   */
  function writeArchive(root, relativePath, seconds) {
    const archive = path.join(root, relativePath);
    mkdirSync(path.dirname(archive), { recursive: true });
    writeFileSync(archive, "archive");
    utimesSync(archive, seconds, seconds);
  }

  it("should match {sha256} repeated in one segment only when every occurrence is the same digest", () => {
    const root = createRoot();
    writeArchive(root, `releases/1.2.0-${matchingDigest}-${matchingDigest}.tgz`, 1_000);
    writeArchive(root, `releases/1.2.0-${matchingDigest}-${otherDigest}.tgz`, 2_000);

    expect(findPreparedArtifact(root, "releases/{version}-{sha256}-{sha256}.tgz", release)).toEqual({
      path: `releases/1.2.0-${matchingDigest}-${matchingDigest}.tgz`,
      expectedSha256: matchingDigest,
    });
  });

  it("should match {sha256} repeated across segments only when every segment declares the same digest", () => {
    const root = createRoot();
    writeArchive(root, `releases/${matchingDigest}/fixture-pkg-${matchingDigest}.tgz`, 1_000);
    writeArchive(root, `releases/${otherDigest}/fixture-pkg-${matchingDigest}.tgz`, 2_000);

    expect(findPreparedArtifact(root, "releases/{sha256}/{name}-{sha256}.tgz", release)).toEqual({
      path: `releases/${matchingDigest}/fixture-pkg-${matchingDigest}.tgz`,
      expectedSha256: matchingDigest,
    });
  });
});

describe("npm authentication config", () => {
  it("should expose only the NPM_TOKEN reference and remove the config afterwards, even on failure", async () => {
    const parent = createRoot();
    /** @type {string[]} */
    const seenPaths = [];

    const content = await withNpmAuthConfig(async (userConfigPath) => {
      seenPaths.push(userConfigPath);
      return readFileSync(userConfigPath, "utf8");
    }, parent);

    expect(content).toBe("//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");

    await expect(
      withNpmAuthConfig(async (userConfigPath) => {
        seenPaths.push(userConfigPath);
        throw new Error("npm failed");
      }, parent)
    ).rejects.toThrow("npm failed");
    expect(seenPaths).toHaveLength(2);
    expect(seenPaths.some((userConfigPath) => existsSync(userConfigPath))).toBe(false);
  });
});
