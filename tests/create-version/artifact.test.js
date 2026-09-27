import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

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

/**
 * @typedef {{ name: string, type?: string, content?: string, linkTarget?: string }} TarFixtureEntry
 */

/**
 * Builds one 512-byte ustar header with a valid checksum.
 *
 * @param {{ name: string, type: string, size: number, linkTarget?: string }} header - Header fields.
 * @returns {Buffer} Header block.
 */
function tarHeader({ name, type, size, linkTarget = "" }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write("00000000000\0", 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write(linkTarget, 157, 100, "utf8");
  block.write("ustar\0" + "00", 257, "ascii");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/**
 * Pads data to whole tar blocks.
 *
 * @param {Buffer} data - Entry data.
 * @returns {Buffer} Data followed by NUL padding.
 */
function padToBlock(data) {
  return Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

/**
 * Writes a gzipped tar with exact entries. `tar -czf` cannot produce repeated paths or links to
 * arbitrary targets portably (Windows has no symlinks without privileges), so the tests that need
 * them write the ustar format directly: 512-byte headers, data padded to 512 bytes and two empty
 * blocks at the end, compressed with `node:zlib`.
 *
 * @param {TarFixtureEntry[]} entries - Entries in archive order; `type` defaults to a regular file.
 * @returns {Buffer} Gzipped tar archive.
 */
function writeTarFixture(entries) {
  const blocks = entries.flatMap(({ name, type = "0", content = "", linkTarget }) => {
    const data = Buffer.from(content, "utf8");
    return [tarHeader({ name, type, size: data.length, linkTarget }), padToBlock(data)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/**
 * Builds a PAX extended-header record (`<length> <key>=<value>\n`, length in bytes including itself).
 *
 * @param {string} key - Record key.
 * @param {string} value - Record value.
 * @returns {string} Record text.
 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length++;
  return `${length}${body}`;
}

/** @returns {TarFixtureEntry[]} The publishable package as exact tar entries. */
function validTarEntries() {
  return Object.entries(validPackage()).map(([relativePath, content]) => ({ name: `package/${relativePath}`, content }));
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

  /**
   * @param {Buffer} archive - Gzipped tar written by {@link writeTarFixture}.
   * @param {Record<string, unknown>} [manifest] - Repository manifest.
   * @returns {string[]} Verification problems.
   */
  function verifyArchive(archive, manifest = MANIFEST) {
    const root = createRoot();
    writeFileSync(path.join(root, "archive.tgz"), archive);
    storeWithChecksum(root, "archive.tgz");
    const artifact = findPreparedArtifact(root, CHECKSUM_ARCHIVE_PATTERN, { version: MANIFEST.version, packageName: MANIFEST.name });
    return verifyPreparedArtifact(root, /** @type {import("../../src/create-version/artifact.js").PreparedArtifact} */ (artifact), manifest);
  }

  it("should accept an exact tar archive of the valid package, so the fixture writer is sound", () => {
    expect(verifyArchive(writeTarFixture([{ name: "package/", type: "5" }, ...validTarEntries()]))).toEqual([]);
  });

  it("should reject repeated archive paths, including a second package.json that npm would publish", () => {
    const evilManifest = JSON.stringify({ ...MANIFEST, name: "evil-fixture", version: "9.9.9" });
    const withSecondManifest = writeTarFixture([...validTarEntries(), { name: "package/package.json", content: evilManifest }]);
    const withRepeatedFile = writeTarFixture([...validTarEntries(), { name: "package/dist/index.js", content: "steal();" }]);

    expect(verifyArchive(withSecondManifest)).toEqual(
      expect.arrayContaining([expect.stringContaining("ruta repetida en el tarball: package/package.json"), expect.stringContaining("evil-fixture@9.9.9")])
    );
    expect(verifyArchive(withRepeatedFile)).toEqual([expect.stringContaining("ruta repetida en el tarball: package/dist/index.js")]);
  });

  it("should reject hard links, symbolic links and other non-file entries instead of skipping them", () => {
    const hardLink = { name: "package/secret.js", type: "1", linkTarget: "package/dist/index.js" };
    const symbolicLink = { name: "package/dist/escape.js", type: "2", linkTarget: "../../../../etc/passwd" };
    const fifo = { name: "package/dist/pipe", type: "6" };

    expect(verifyArchive(writeTarFixture([...validTarEntries(), hardLink]))).toEqual([
      expect.stringContaining("entrada no soportada en el tarball (hard-link"),
    ]);
    expect(verifyArchive(writeTarFixture([...validTarEntries(), symbolicLink]))).toEqual([
      expect.stringContaining("package/dist/escape.js -> ../../../../etc/passwd"),
    ]);
    expect(verifyArchive(writeTarFixture([...validTarEntries(), fifo]))).toEqual([expect.stringContaining("entrada no soportada en el tarball (unsupported")]);
    expect(readTarballEntries(writeTarFixture([hardLink])).map(({ name, kind, linkTarget }) => ({ name, kind, linkTarget }))).toEqual([
      { name: "package/secret.js", kind: "hard-link", linkTarget: "package/dist/index.js" },
    ]);
  });

  it("should apply PAX and GNU long names and link targets to link entries, and reject renaming PAX global headers", () => {
    const longName = `package/${"nested/".repeat(20)}link.js`;
    const longTarget = `package/${"target/".repeat(20)}index.js`;
    const paxLink = [
      { name: "PaxHeader/link", type: "x", content: paxRecord("path", longName) + paxRecord("linkpath", longTarget) },
      { name: "package/short", type: "2", linkTarget: "short" },
    ];
    const gnuLink = [
      { name: "././@LongLink", type: "L", content: `${longName}\0` },
      { name: "././@LongLink", type: "K", content: `${longTarget}\0` },
      { name: "package/short", type: "1", linkTarget: "short" },
    ];
    const renamingGlobalHeader = { name: "pax_global_header", type: "g", content: paxRecord("path", "package/renamed.js") };

    for (const linkEntries of [paxLink, gnuLink]) {
      expect(readTarballEntries(writeTarFixture(linkEntries)).map(({ name, linkTarget }) => ({ name, linkTarget }))).toEqual([{ name: longName, linkTarget: longTarget }]);
      expect(verifyArchive(writeTarFixture([...validTarEntries(), ...linkEntries]))).toEqual([expect.stringContaining(`${longName} -> ${longTarget}`)]);
    }
    expect(verifyArchive(writeTarFixture([renamingGlobalHeader, ...validTarEntries()]))).toEqual([
      expect.stringContaining("entrada no soportada en el tarball (unsupported"),
    ]);
  });

  it("should ignore directory entries but reject unsafe directory names", () => {
    const withDirectories = [{ name: "package/", type: "5" }, { name: "package/dist/", type: "5" }, ...validTarEntries()];

    expect(verifyArchive(writeTarFixture(withDirectories))).toEqual([]);
    expect(verifyArchive(writeTarFixture([...withDirectories, { name: "package/../outside/", type: "5" }]))).toEqual([
      expect.stringContaining("ruta inválida en el tarball: package/../outside/"),
    ]);
    expect(verifyArchive(writeTarFixture([...validTarEntries(), { name: "package/./dist/index.js", content: "steal();" }]))).toEqual([
      expect.stringContaining("ruta inválida en el tarball: package/./dist/index.js"),
    ]);
  });

  it("should match files globs with character classes, negated classes, ranges and brace alternations like npm", () => {
    const globManifest = { ...MANIFEST, files: ["dist/[ab].js", "dist/index.*", "lib/[!xv]*.js", "lib/v[0-9].js", "types/*.{d.ts,d.mts}", "extra/[^.]*"] };
    const globPackage = {
      ...validPackage(),
      "package.json": JSON.stringify(globManifest),
      "dist/a.js": "export {};",
      "dist/b.js": "export {};",
      "lib/main.js": "export {};",
      "lib/v2.js": "export {};",
      "types/index.d.ts": "export {};",
      "types/index.d.mts": "export {};",
      "extra/notes.txt": "notes",
    };

    expect(verify(globPackage, globManifest)).toEqual([]);
    expect(verify({ ...globPackage, "dist/c.js": "export {};" }, globManifest)).toEqual([expect.stringContaining('fuera de "files" en el tarball: dist/c.js')]);
    expect(verify({ ...globPackage, "lib/x-internal.js": "export {};" }, globManifest)).toEqual([expect.stringContaining("lib/x-internal.js")]);
    expect(verify({ ...globPackage, "lib/va.js": "export {};" }, globManifest)).toEqual([expect.stringContaining("lib/va.js")]);
    expect(verify({ ...globPackage, "types/index.d.cts": "export {};" }, globManifest)).toEqual([expect.stringContaining("types/index.d.cts")]);
  });

  it("should require the module entrypoint of the packed manifest", () => {
    const moduleManifest = { ...MANIFEST, module: "./dist/index.mjs" };
    const modulePackage = { ...validPackage(), "package.json": JSON.stringify(moduleManifest) };

    expect(verify(modulePackage, moduleManifest)).toEqual([expect.stringContaining("falta el entrypoint público dist/index.mjs")]);
    expect(verify({ ...modulePackage, "dist/index.mjs": "export {};" }, moduleManifest)).toEqual([]);
  });

  it("should accept declared bundled dependencies under node_modules and reject any other node_modules file", () => {
    const bundledManifest = { ...MANIFEST, dependencies: { foo: "^1.0.0", "@scope/bar": "^2.0.0" }, bundleDependencies: ["foo", "@scope/bar"] };
    const bundledPackage = {
      ...validPackage(),
      "package.json": JSON.stringify(bundledManifest),
      "node_modules/foo/index.js": "module.exports = {};",
      "node_modules/foo/node_modules/nested/index.js": "module.exports = {};",
      "node_modules/@scope/bar/index.js": "module.exports = {};",
    };
    const allBundledManifest = { ...MANIFEST, dependencies: { foo: "^1.0.0" }, bundledDependencies: true };

    expect(verify(bundledPackage, bundledManifest)).toEqual([]);
    expect(verify({ ...bundledPackage, "node_modules/other/index.js": "steal();" }, bundledManifest)).toEqual([
      expect.stringContaining("archivo privado en el tarball: node_modules/other/index.js"),
    ]);
    expect(verify({ ...bundledPackage, "node_modules/foo/.env": "NPM_TOKEN=secret" }, bundledManifest)).toEqual([
      expect.stringContaining("archivo privado en el tarball: node_modules/foo/.env"),
    ]);
    expect(
      verify({ ...validPackage(), "package.json": JSON.stringify(allBundledManifest), "node_modules/foo/index.js": "module.exports = {};" }, allBundledManifest)
    ).toEqual([]);
    expect(verify({ ...validPackage(), "node_modules/foo/index.js": "module.exports = {};" })).toEqual([expect.stringContaining("archivo privado")]);
  });

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
