import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  computeSha256,
  expandArtifactPattern,
  findPackedFileSetProblems,
  findPreparedArtifact,
  findReleaseManifestProblems,
  isRewrittenDependencySpecifier,
  isSafeArtifactPath,
  readTarballEntries,
  verifyPreparedArtifact,
} from "../../src/create-version/artifact.js";
import { listNpmPackFiles, parseNpmPackDryRunOutput, withNpmAuthConfig } from "../../src/create-version/npm.js";

/** Layout used by checksum-addressed release preparation. */
const CHECKSUM_ARCHIVE_PATTERN = "releases/{version}-{sha256}/{name}-{version}.tgz";

/** Running the real npm CLI (through the Windows shell) can exceed the default timeout. */
const NPM_COMMAND_TEST_TIMEOUT_MS = 60_000;

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
   * Builds the `npm pack --dry-run` listing of a package.
   *
   * @param {Record<string, string>} files - Packed files.
   * @param {Record<string, unknown>} [manifest] - Release manifest.
   * @returns {import("../../src/create-version/artifact.js").NpmPackListing} Listing with exactly those files.
   */
  function npmListingOf(files, manifest = MANIFEST) {
    return { name: manifest.name, version: manifest.version, files: Object.keys(files) };
  }

  /**
   * @param {Record<string, string>} files - Packed files.
   * @param {Record<string, unknown>} [manifest] - Release manifest.
   * @param {string[]} [npmFiles] - Files npm reports; defaults to the packed ones.
   * @returns {string[]} Verification problems.
   */
  function verify(files, manifest = MANIFEST, npmFiles = Object.keys(files)) {
    const root = createRoot();
    const stored = storeWithChecksum(root, packArchive(root, files));
    const artifact = findPreparedArtifact(root, CHECKSUM_ARCHIVE_PATTERN, { version: MANIFEST.version, packageName: MANIFEST.name });
    expect(artifact?.path).toBe(stored);
    return verifyPreparedArtifact(root, /** @type {import("../../src/create-version/artifact.js").PreparedArtifact} */ (artifact), {
      manifest,
      npmPack: { ...npmListingOf(files, manifest), files: npmFiles },
    });
  }

  /**
   * @param {Buffer} archive - Gzipped tar written by {@link writeTarFixture}.
   * @param {Record<string, unknown>} [manifest] - Release manifest.
   * @param {string[]} [npmFiles] - Files npm reports; defaults to the valid package.
   * @returns {string[]} Verification problems.
   */
  function verifyArchive(archive, manifest = MANIFEST, npmFiles = Object.keys(validPackage())) {
    const root = createRoot();
    writeFileSync(path.join(root, "archive.tgz"), archive);
    storeWithChecksum(root, "archive.tgz");
    const artifact = findPreparedArtifact(root, CHECKSUM_ARCHIVE_PATTERN, { version: MANIFEST.version, packageName: MANIFEST.name });
    return verifyPreparedArtifact(root, /** @type {import("../../src/create-version/artifact.js").PreparedArtifact} */ (artifact), {
      manifest,
      npmPack: { name: manifest.name, version: manifest.version, files: npmFiles },
    });
  }

  /**
   * @param {Record<string, unknown>} packedManifest - `package.json` inside the archive.
   * @param {Record<string, unknown>} releaseManifest - `package.json` of the release commit.
   * @returns {string[]} Verification problems.
   */
  function verifyPackedManifest(packedManifest, releaseManifest) {
    return verify({ ...validPackage(), "package.json": JSON.stringify(packedManifest) }, releaseManifest);
  }

  it("should accept an exact tar archive of the valid package, so the fixture writer is sound", () => {
    expect(verifyArchive(writeTarFixture([{ name: "package/", type: "5" }, ...validTarEntries()]))).toEqual([]);
  });

  it("should accept a package whose checksum, name, version, files and entrypoints match", () => {
    expect(verify(validPackage())).toEqual([]);
  });

  it("should require exactly the files npm packs, reporting missing and unexpected ones", () => {
    const withSecret = { ...validPackage(), ".env": "NPM_TOKEN=secret", "src/index.ts": "export {};" };

    expect(verify(withSecret, MANIFEST, Object.keys(validPackage()))).toEqual([
      "archivo que npm no empaqueta en el tarball: .env",
      "archivo que npm no empaqueta en el tarball: src/index.ts",
    ]);
    expect(verify(validPackage(), MANIFEST, [...Object.keys(validPackage()), "LICENSE", "dist/extra.js"])).toEqual([
      "falta en el tarball un archivo que npm empaqueta: LICENSE",
      "falta en el tarball un archivo que npm empaqueta: dist/extra.js",
    ]);
  });

  it("should accept whatever npm reports, such as COPYING, browser files, dotfiles or bundled dependencies", () => {
    const npmDecidedPackage = {
      ...validPackage(),
      COPYING: "license",
      "browser/index.js": "export {};",
      ".eslintrc.json": "{}",
      "node_modules/bundled/index.js": "module.exports = {};",
    };

    expect(verify(npmDecidedPackage)).toEqual([]);
  });

  it("should compare file sets independently of order and report each difference once", () => {
    expect(findPackedFileSetProblems(["b.js", "a.js", "a.js"], ["a.js", "b.js"])).toEqual([]);
    expect(findPackedFileSetProblems(["a.js", "c.js"], ["b.js", "a.js"])).toEqual([
      "falta en el tarball un archivo que npm empaqueta: c.js",
      "archivo que npm no empaqueta en el tarball: b.js",
    ]);
  });

  it("should reject an npm listing of another package or version", () => {
    const root = createRoot();
    storeWithChecksum(root, packArchive(root, validPackage()));
    const artifact = /** @type {import("../../src/create-version/artifact.js").PreparedArtifact} */ (
      findPreparedArtifact(root, CHECKSUM_ARCHIVE_PATTERN, { version: MANIFEST.version, packageName: MANIFEST.name })
    );

    expect(
      verifyPreparedArtifact(root, artifact, { manifest: MANIFEST, npmPack: { name: MANIFEST.name, version: "9.9.9", files: Object.keys(validPackage()) } })
    ).toEqual([expect.stringContaining("npm pack --dry-run describe fixture-pkg@9.9.9")]);
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

  it("should honor a PAX size override, so an entry hidden behind a larger ustar size is still found", () => {
    const readme = Buffer.from("# fixture", "utf8");
    const hiddenSecret = Buffer.from("NPM_TOKEN=secret", "utf8");
    // The ustar size covers the next header and its data; the PAX size (the one tar readers honor) only covers the README.
    const hidingReadme = [
      tarHeader({ name: "PaxHeader/README.md", type: "x", size: Buffer.byteLength(paxRecord("size", String(readme.length))) }),
      padToBlock(Buffer.from(paxRecord("size", String(readme.length)), "utf8")),
      tarHeader({ name: "package/README.md", type: "0", size: 1024 }),
      padToBlock(readme),
      tarHeader({ name: "package/.env", type: "0", size: hiddenSecret.length }),
      padToBlock(hiddenSecret),
    ];
    const otherEntries = validTarEntries().filter((entry) => entry.name !== "package/README.md");
    const archive = gzipSync(
      Buffer.concat([
        ...hidingReadme,
        ...otherEntries.flatMap(({ name, content = "" }) => [tarHeader({ name, type: "0", size: Buffer.byteLength(content) }), padToBlock(Buffer.from(content))]),
        Buffer.alloc(1024),
      ])
    );

    const entries = readTarballEntries(archive);
    expect(entries.find((entry) => entry.name === "package/README.md")?.content.toString("utf8")).toBe("# fixture");
    expect(entries.map((entry) => entry.name)).toContain("package/.env");
    expect(verifyArchive(archive)).toEqual(["archivo que npm no empaqueta en el tarball: .env"]);
  });

  it("should reject PAX global size overrides, invalid PAX sizes and truncated entries", () => {
    const globalSize = { name: "pax_global_header", type: "g", content: paxRecord("size", "0") };
    const invalidSize = [{ name: "PaxHeader/README.md", type: "x", content: paxRecord("size", "-1") }, ...validTarEntries()];
    const truncated = gzipSync(Buffer.concat([tarHeader({ name: "package/README.md", type: "0", size: 4096 }), padToBlock(Buffer.from("# fixture"))]));

    expect(verifyArchive(writeTarFixture([globalSize, ...validTarEntries()]))).toEqual([expect.stringContaining("pax_global_header")]);
    expect(readTarballEntries(writeTarFixture([globalSize])).map(({ name, kind }) => ({ name, kind }))).toEqual([{ name: "pax_global_header", kind: "unsupported" }]);
    expect(verifyArchive(writeTarFixture(invalidSize))).toEqual([expect.stringContaining('no se pudo leer el tarball (size PAX inválido ("-1"))')]);
    expect(verifyArchive(truncated)).toEqual([expect.stringContaining("no se pudo leer el tarball (la entrada package/README.md declara 4096 bytes")]);
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

  it("should require the module entrypoint of the packed manifest", () => {
    const moduleManifest = { ...MANIFEST, module: "./dist/index.mjs" };
    const modulePackage = { ...validPackage(), "package.json": JSON.stringify(moduleManifest) };

    expect(verify(modulePackage, moduleManifest)).toEqual([expect.stringContaining("falta el entrypoint público dist/index.mjs")]);
    expect(verify({ ...modulePackage, "dist/index.mjs": "export {};" }, moduleManifest)).toEqual([]);
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

    expect(verifyPreparedArtifact(root, artifact, { manifest: MANIFEST, npmPack: npmListingOf(validPackage()) })).toEqual([expect.stringContaining("no coincide")]);
  });

  it("should reject missing entrypoints and a different package", () => {
    const { "dist/index.d.ts": _removed, ...withoutTypes } = validPackage();

    expect(verify(withoutTypes)).toEqual([expect.stringContaining("dist/index.d.ts")]);
    expect(verify({ ...validPackage(), "package.json": JSON.stringify({ ...MANIFEST, version: "1.1.0" }) })).toEqual([expect.stringContaining("fixture-pkg@1.1.0")]);
  });

  it("should reject a packed manifest whose dependencies, install scripts or exports differ from the release commit", () => {
    const releaseManifest = { ...MANIFEST, dependencies: { "left-pad": "^1.3.0" } };

    expect(verifyPackedManifest(releaseManifest, releaseManifest)).toEqual([]);
    expect(verifyPackedManifest({ ...releaseManifest, dependencies: { "left-pad": "^2.0.0" } }, releaseManifest)).toEqual([expect.stringContaining('"dependencies"')]);
    expect(verifyPackedManifest({ ...releaseManifest, scripts: { postinstall: "node steal.js" } }, releaseManifest)).toEqual([
      expect.stringContaining('script "postinstall"'),
    ]);
    expect(verifyPackedManifest({ ...releaseManifest, exports: "./dist/index.js" }, releaseManifest)).toEqual([expect.stringContaining('"exports"')]);
  });

  it("should reject a packed publishConfig that differs from the release commit, since npm applies it when publishing", () => {
    const releaseManifest = { ...MANIFEST, publishConfig: { access: "public", provenance: true } };

    expect(verifyPackedManifest(releaseManifest, releaseManifest)).toEqual([]);
    expect(verifyPackedManifest({ ...releaseManifest, publishConfig: { access: "public", provenance: true, registry: "https://evil.example/" } }, releaseManifest)).toEqual([
      expect.stringContaining('"publishConfig" del package.json del tarball'),
    ]);
    expect(verifyPackedManifest({ ...releaseManifest, publishConfig: { access: "public" } }, releaseManifest)).toEqual([expect.stringContaining('"publishConfig"')]);
    expect(verifyPackedManifest({ ...MANIFEST, publishConfig: { tag: "next" } }, MANIFEST)).toEqual([expect.stringContaining('"publishConfig"')]);
  });

  it("should accept the fields pnpm pack rewrites: hoisted publishConfig overrides and workspace or catalog dependencies", () => {
    const releaseManifest = {
      ...MANIFEST,
      dependencies: { "shared-utils": "workspace:^", "shared-theme": "catalog:", "shared-alias": "workspace:*" },
      publishConfig: { access: "public", types: "./dist/index.d.ts" },
    };
    const rewrittenDependencies = { "shared-utils": "^1.4.0", "shared-theme": ">=2.0.0 <3.0.0 || 3.x", "shared-alias": "npm:@scope/real-alias@1.0.0" };
    const packedByPnpm = { ...MANIFEST, dependencies: rewrittenDependencies, types: "./dist/index.d.ts", publishConfig: { access: "public" } };

    expect(verifyPackedManifest(packedByPnpm, releaseManifest)).toEqual([]);
    expect(verifyPackedManifest({ ...packedByPnpm, publishConfig: releaseManifest.publishConfig }, releaseManifest)).toEqual([]);
    expect(verifyPackedManifest({ ...packedByPnpm, dependencies: { "shared-utils": "^1.4.0" } }, releaseManifest)).toEqual([
      expect.stringContaining('"dependencies"'),
    ]);
  });

  it("should reject workspace or catalog dependencies rewritten to URLs, Git, local paths or other protocols", () => {
    const releaseManifest = { ...MANIFEST, dependencies: { "shared-utils": "workspace:^" } };
    const invalidRewrites = [
      "https://evil.example/shared-utils-1.4.0.tgz",
      "git+https://github.com/evil/shared-utils.git",
      "github:evil/shared-utils",
      "file:../shared-utils",
      "link:../shared-utils",
      "workspace:^",
      "npm:shared-utils@https://evil.example/x.tgz",
      "latest",
      "",
    ];

    for (const specifier of invalidRewrites) {
      expect(isRewrittenDependencySpecifier(specifier), specifier).toBe(false);
      expect(verifyPackedManifest({ ...MANIFEST, dependencies: { "shared-utils": specifier } }, releaseManifest), specifier).toEqual([
        expect.stringContaining('"dependencies"'),
      ]);
    }
    for (const specifier of ["1.4.0", "^1.4.0", "~1.4", "1.0.0 - 2.0.0", "npm:shared-utils@^1.4.0"]) {
      expect(isRewrittenDependencySpecifier(specifier), specifier).toBe(true);
    }
  });

  it("should check the entrypoints of the packed manifest, the one npm publishes", () => {
    const releaseManifest = { ...MANIFEST, publishConfig: { main: "./dist/published.js" } };
    const packedManifest = { ...MANIFEST, main: "./dist/published.js" };

    expect(verifyPackedManifest(packedManifest, releaseManifest)).toEqual([expect.stringContaining("falta el entrypoint público dist/published.js")]);
    expect(verify({ ...validPackage(), "dist/published.js": "export {};", "package.json": JSON.stringify(packedManifest) }, releaseManifest)).toEqual([]);
  });
});

describe("release manifest identity", () => {
  it("should accept a working tree that still describes the release commit being published", () => {
    expect(findReleaseManifestProblems({ releaseManifest: MANIFEST, workingManifest: { ...MANIFEST }, version: MANIFEST.version })).toEqual([]);
  });

  it("should reject an unreadable release manifest or one that declares another version", () => {
    expect(findReleaseManifestProblems({ releaseManifest: null, workingManifest: MANIFEST, version: MANIFEST.version })).toEqual([
      "no se pudo leer el package.json del commit de release",
    ]);
    expect(findReleaseManifestProblems({ releaseManifest: MANIFEST, workingManifest: MANIFEST, version: "1.3.0" })).toEqual([
      "el package.json del commit de release es fixture-pkg@1.2.0 y se está publicando 1.3.0",
    ]);
  });

  it("should reject a working tree whose identity or packing fields prepare rewrote", () => {
    const rewrittenByPrepare = { ...MANIFEST, version: "9.9.9", files: ["dist", ".env"], scripts: { postinstall: "node steal.js" } };

    expect(findReleaseManifestProblems({ releaseManifest: MANIFEST, workingManifest: rewrittenByPrepare, version: MANIFEST.version })).toEqual([
      '"version" del package.json del working tree no coincide con el del commit de release',
      '"files" del package.json del working tree no coincide con el del commit de release',
      'el script "postinstall" del package.json del working tree no coincide con el del commit de release',
    ]);
  });
});

describe("npm pack file listing", () => {
  it("should parse the file list of npm pack --dry-run --json and reject unusable output", () => {
    const output = JSON.stringify([{ name: "fixture-pkg", version: "1.2.0", files: [{ path: "package.json" }, { path: "dist/index.js" }] }]);

    expect(parseNpmPackDryRunOutput(output)).toEqual({ listing: { name: "fixture-pkg", version: "1.2.0", files: ["package.json", "dist/index.js"] }, problem: null });
    expect(parseNpmPackDryRunOutput("npm notice")).toEqual({ listing: null, problem: expect.stringContaining("no es JSON válido") });
    expect(parseNpmPackDryRunOutput("[]")).toEqual({ listing: null, problem: expect.stringContaining("único paquete") });
    expect(parseNpmPackDryRunOutput(JSON.stringify([{ files: [{ size: 1 }] }]))).toEqual({ listing: null, problem: expect.stringContaining("único paquete") });
  });

  it(
    "should list exactly what the real npm would pack from a checkout, without running scripts",
    async () => {
      const root = createRoot();
      const manifest = { ...MANIFEST, files: ["dist", "!dist/internal"], scripts: { prepack: "node -e \"require('fs').writeFileSync('dist/prepack.js', '')\"" } };
      writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
      mkdirSync(path.join(root, "dist", "internal"), { recursive: true });
      mkdirSync(path.join(root, "src"), { recursive: true });
      for (const [relativePath, content] of Object.entries({
        "README.md": "# fixture",
        COPYING: "license",
        "CHANGELOG.md": "# changes",
        ".env": "NPM_TOKEN=secret",
        "dist/index.js": "export {};",
        "dist/index.d.ts": "export {};",
        "dist/internal/secret.js": "export {};",
        "src/index.ts": "export {};",
      })) {
        writeFileSync(path.join(root, relativePath), content);
      }

      const { listing, problem } = await listNpmPackFiles(root);

      expect(problem).toBeNull();
      expect(listing?.name).toBe(MANIFEST.name);
      expect(listing?.version).toBe(MANIFEST.version);
      expect([...(listing?.files ?? [])].sort()).toEqual(["COPYING", "README.md", "dist/index.d.ts", "dist/index.js", "package.json"]);
    },
    NPM_COMMAND_TEST_TIMEOUT_MS
  );

  it(
    "should report npm failures instead of an empty listing",
    async () => {
      const root = createRoot();
      writeFileSync(path.join(root, "package.json"), "{ not json");

      const { listing, problem } = await listNpmPackFiles(root);

      expect(listing).toBeNull();
      expect(problem).toMatch(/npm pack --dry-run/u);
    },
    NPM_COMMAND_TEST_TIMEOUT_MS
  );
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
