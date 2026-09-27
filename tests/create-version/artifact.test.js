import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  computeNpmIntegrity,
  computeSha256,
  expandArtifactPattern,
  findPnpmPackRewrites,
  findPreparedArtifact,
  isSafeArtifactPath,
  verifyPreparedArtifact,
  withArtifactOutsidePackageRoot,
} from "../../src/create-version/artifact.js";
import { parseNpmPackDryRunOutput, readNpmPackIntegrity } from "../../src/create-version/npm.js";

/** Layout used by checksum-addressed release preparation. */
const CHECKSUM_ARCHIVE_PATTERN = "releases/{version}-{sha256}/{name}-{version}.tgz";

/** Running the real npm CLI (through the Windows shell) can exceed the default timeout. */
const NPM_COMMAND_TEST_TIMEOUT_MS = 60_000;

/** Windows resolves `npm.cmd` only through a shell. */
const USES_SHELL_FOR_NPM = process.platform === "win32";

/** Manifest of the fixture package. */
const MANIFEST = { name: "fixture-pkg", version: "1.2.0", files: ["dist"], exports: { ".": { default: "./dist/index.js" } } };

/** Integrity of a byte string that is not what npm packs. */
const FOREIGN_INTEGRITY = `sha512-${"A".repeat(86)}==`;

/** @type {string[]} */
const temporaryDirectories = [];

/** @returns {string} Empty repository root. */
function createRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "beez-rp-artifact-"));
  temporaryDirectories.push(root);
  return root;
}

/**
 * Writes a publishable package checkout: manifest, built output and a README.
 *
 * @param {Record<string, unknown>} [manifest] - `package.json` contents.
 * @returns {string} Package root.
 */
function createPackageCheckout(manifest = MANIFEST) {
  const root = createRoot();
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(root, "README.md"), "# fixture\n");
  writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return root;
}

/**
 * Packs the checkout with the real `npm pack --ignore-scripts`, as release preparation does,
 * and stores the archive under `releases/<version>-<sha256>/`.
 *
 * @param {string} root - Package root.
 * @returns {string} Stored archive path relative to the root.
 */
function packWithNpm(root) {
  const destination = path.join(root, "releases", `${MANIFEST.version}-tmp`);
  mkdirSync(destination, { recursive: true });
  const result = USES_SHELL_FOR_NPM
    ? spawnSync("npm pack --ignore-scripts --pack-destination releases/1.2.0-tmp", { cwd: root, encoding: "utf8", shell: true })
    : spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", "releases/1.2.0-tmp"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`);

  const [archiveName] = readdirSync(destination);
  const digest = computeSha256(path.join(destination, archiveName));
  const storedDirectory = `releases/${MANIFEST.version}-${digest}`;
  renameSync(destination, path.join(root, storedDirectory));
  return `${storedDirectory}/${archiveName}`;
}

/**
 * Packs the same files with `tar -czf` instead of npm: same contents, different bytes.
 *
 * @param {string} root - Package root.
 * @returns {string} Archive path relative to the root.
 */
function packWithTar(root) {
  const staging = mkdtempSync(path.join(root, "stage-"));
  for (const relativePath of ["package.json", "README.md", "dist/index.js"]) {
    const target = path.join(staging, "package", relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, relativePath === "package.json" ? `${JSON.stringify(MANIFEST, null, 2)}\n` : relativePath === "README.md" ? "# fixture\n" : "export {};\n");
  }
  const result = spawnSync("tar", ["-czf", "archive.tgz", "package"], { cwd: staging, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
  mkdirSync(path.join(root, "releases"), { recursive: true });
  renameSync(path.join(staging, "archive.tgz"), path.join(root, "releases", "fixture-pkg-1.2.0.tgz"));
  rmSync(staging, { recursive: true, force: true });
  return "releases/fixture-pkg-1.2.0.tgz";
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
    expect(isSafeArtifactPath("releases/1.9.0-abc/pkg~beta-1.9.0.tgz")).toBe(true);
    expect(isSafeArtifactPath("releases/1.9.0 abc/pkg.tgz")).toBe(false);
    expect(isSafeArtifactPath("releases/../pkg.tgz")).toBe(false);
    expect(isSafeArtifactPath("releases/pkg.tgz;rm")).toBe(false);
  });
});

describe("prepared artifact verification against npm pack", () => {
  /**
   * Reads the integrity the real npm reports for the checkout.
   *
   * @param {string} root - Package root.
   * @returns {Promise<string>} `sha512-<base64>` integrity.
   */
  async function readExpectedIntegrity(root) {
    const { pack, problem } = await readNpmPackIntegrity(root);
    expect(problem).toBeNull();
    return pack?.integrity ?? "";
  }

  it(
    "should accept an archive packed with npm pack --ignore-scripts from the same checkout",
    async () => {
      const root = createPackageCheckout();
      const stored = packWithNpm(root);
      const prepared = findPreparedArtifact(root, CHECKSUM_ARCHIVE_PATTERN, { version: MANIFEST.version, packageName: MANIFEST.name });

      const { pack } = await readNpmPackIntegrity(root);

      expect(prepared?.path).toBe(stored);
      expect(pack).toEqual({ name: MANIFEST.name, version: MANIFEST.version, integrity: computeNpmIntegrity(path.join(root, stored)) });
      expect(verifyPreparedArtifact(root, /** @type {import("../../src/create-version/artifact.js").PreparedArtifact} */ (prepared), pack?.integrity ?? "")).toEqual([]);
    },
    NPM_COMMAND_TEST_TIMEOUT_MS
  );

  it(
    "should reject an archive with the same files packed by another tool, because its bytes differ",
    async () => {
      const root = createPackageCheckout();
      const archive = packWithTar(root);

      const problems = verifyPreparedArtifact(root, { path: archive, expectedSha256: null }, await readExpectedIntegrity(root));

      expect(problems).toEqual([expect.stringContaining("el tarball no es lo que npm empaquetaría de este commit")]);
    },
    NPM_COMMAND_TEST_TIMEOUT_MS
  );

  it(
    "should reject an npm archive built from other contents than the checkout npm packs now",
    async () => {
      const root = createPackageCheckout();
      writeFileSync(path.join(root, "dist", "index.js"), "export const stale = true;\n");
      const stored = packWithNpm(root);
      writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");

      const problems = verifyPreparedArtifact(root, { path: stored, expectedSha256: null }, await readExpectedIntegrity(root));

      expect(problems).toEqual([expect.stringContaining("integrity")]);
    },
    NPM_COMMAND_TEST_TIMEOUT_MS
  );

  it("should reject an archive whose SHA-256 differs from the one its path declares, before hashing it for npm", () => {
    const root = createRoot();
    const declared = "a".repeat(64);
    const archive = `releases/1.2.0-${declared}/fixture-pkg-1.2.0.tgz`;
    mkdirSync(path.join(root, path.dirname(archive)), { recursive: true });
    writeFileSync(path.join(root, archive), "not the declared archive");

    expect(verifyPreparedArtifact(root, { path: archive, expectedSha256: declared }, FOREIGN_INTEGRITY)).toEqual([
      expect.stringContaining("no coincide con el de su ruta"),
    ]);
  });

  it(
    "should report npm failures instead of an integrity",
    async () => {
      const root = createRoot();
      writeFileSync(path.join(root, "package.json"), "{ not json");

      const { pack, problem } = await readNpmPackIntegrity(root);

      expect(pack).toBeNull();
      expect(problem).toMatch(/npm pack --dry-run/u);
    },
    NPM_COMMAND_TEST_TIMEOUT_MS
  );

  it("should parse the integrity of npm pack --dry-run --json and reject unusable output", () => {
    const integrity = `sha512-${"b".repeat(86)}==`;

    expect(parseNpmPackDryRunOutput(JSON.stringify([{ name: "fixture-pkg", version: "1.2.0", integrity, files: [] }]))).toEqual({
      pack: { name: "fixture-pkg", version: "1.2.0", integrity },
      problem: null,
    });
    expect(parseNpmPackDryRunOutput("npm notice")).toEqual({ pack: null, problem: expect.stringContaining("no es JSON válido") });
    expect(parseNpmPackDryRunOutput("[]")).toEqual({ pack: null, problem: expect.stringContaining("único paquete") });
    expect(parseNpmPackDryRunOutput(JSON.stringify([{ integrity: "sha1-abc" }]))).toEqual({ pack: null, problem: expect.stringContaining("sha512") });
  });
});

describe("prepared artifact inside a package without a files allowlist", () => {
  /** Manifest without `files`: npm packs every file of the root that no ignore rule excludes. */
  const UNFILTERED_MANIFEST = { name: "fixture-pkg", version: "1.2.0" };

  /** Where release preparation leaves the archive, inside the package root. */
  const ARCHIVE_PATH = "releases/fixture-pkg-1.2.0.tgz";

  /**
   * Packs an unfiltered checkout into `releases/` with the real `npm pack --ignore-scripts`.
   *
   * @returns {string} Package root holding the archive at {@link ARCHIVE_PATH}.
   */
  function packUnfilteredCheckout() {
    const root = createPackageCheckout(UNFILTERED_MANIFEST);
    mkdirSync(path.join(root, "releases"), { recursive: true });
    const result = USES_SHELL_FOR_NPM
      ? spawnSync("npm pack --ignore-scripts --pack-destination releases", { cwd: root, encoding: "utf8", shell: true })
      : spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", "releases"], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr}`);
    return root;
  }

  it(
    "should verify the archive with it outside the package root, and leave it where prepare wrote it",
    async () => {
      const root = packUnfilteredCheckout();
      const archiveIntegrity = computeNpmIntegrity(path.join(root, ARCHIVE_PATH));

      const packedWithArchive = await readNpmPackIntegrity(root);
      const packedWithoutArchive = await withArtifactOutsidePackageRoot(root, ARCHIVE_PATH, async () => {
        expect(existsSync(path.join(root, ARCHIVE_PATH))).toBe(false);
        return readNpmPackIntegrity(root);
      });

      // Left in place, npm counts the archive as package content and reports another integrity.
      expect(packedWithArchive.pack?.integrity).not.toBe(archiveIntegrity);
      expect(packedWithoutArchive.pack?.integrity).toBe(archiveIntegrity);
      expect(verifyPreparedArtifact(root, { path: ARCHIVE_PATH, expectedSha256: null }, packedWithoutArchive.pack?.integrity ?? "")).toEqual([]);
      expect(computeNpmIntegrity(path.join(root, ARCHIVE_PATH))).toBe(archiveIntegrity);
    },
    NPM_COMMAND_TEST_TIMEOUT_MS
  );

  it(
    "should put the archive back when the npm dry run fails or the operation throws",
    async () => {
      const root = packUnfilteredCheckout();
      const archiveIntegrity = computeNpmIntegrity(path.join(root, ARCHIVE_PATH));
      writeFileSync(path.join(root, "package.json"), "{ not json");

      const failedDryRun = await withArtifactOutsidePackageRoot(root, ARCHIVE_PATH, () => readNpmPackIntegrity(root));

      expect(failedDryRun.pack).toBeNull();
      expect(failedDryRun.problem).toMatch(/npm pack --dry-run/u);
      expect(computeNpmIntegrity(path.join(root, ARCHIVE_PATH))).toBe(archiveIntegrity);

      await expect(
        withArtifactOutsidePackageRoot(root, ARCHIVE_PATH, async () => {
          throw new Error("npm crashed");
        })
      ).rejects.toThrow("npm crashed");
      expect(computeNpmIntegrity(path.join(root, ARCHIVE_PATH))).toBe(archiveIntegrity);
    },
    NPM_COMMAND_TEST_TIMEOUT_MS
  );

  it("should fail without touching anything when the archive is missing", async () => {
    const root = createRoot();

    await expect(withArtifactOutsidePackageRoot(root, ARCHIVE_PATH, async () => "unreachable")).rejects.toThrow(`no se pudo apartar ${ARCHIVE_PATH}`);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("pnpm-only pack rewrites", () => {
  it("should accept a manifest npm packs as it is written", () => {
    expect(
      findPnpmPackRewrites({
        ...MANIFEST,
        dependencies: { lodash: "^4.17.21", alias: "npm:other@^1.0.0" },
        devDependencies: { tooling: "workspace:*" },
        publishConfig: { registry: "https://registry.example.test/", access: "public", tag: "latest", provenance: true, "@scope:registry": "https://scope.example.test/" },
      })
    ).toEqual([]);
  });

  it("should reject workspace: and catalog: specifiers in published dependency maps", () => {
    expect(
      findPnpmPackRewrites({
        ...MANIFEST,
        dependencies: { "internal-lib": "workspace:^" },
        peerDependencies: { react: "catalog:" },
        optionalDependencies: { extra: "catalog:legacy" },
      })
    ).toEqual([
      expect.stringContaining('dependencies.internal-lib usa "workspace:^"'),
      expect.stringContaining('peerDependencies.react usa "catalog:"'),
      expect.stringContaining('optionalDependencies.extra usa "catalog:legacy"'),
    ]);
  });

  it("should reject jsr: specifiers, which pnpm turns into npm: aliases and npm cannot install", () => {
    expect(
      findPnpmPackRewrites({
        ...MANIFEST,
        dependencies: { "@std/path": "jsr:^1.0.0" },
        optionalDependencies: { "@luca/cases": "jsr:@luca/cases@1" },
      })
    ).toEqual([
      expect.stringContaining('dependencies.@std/path usa "jsr:^1.0.0", que solo pnpm reescribe al empaquetar'),
      expect.stringContaining('optionalDependencies.@luca/cases usa "jsr:@luca/cases@1", que solo pnpm reescribe al empaquetar'),
    ]);
  });

  it("should reject a workspace: segment inside a compound peer range", () => {
    expect(
      findPnpmPackRewrites({
        ...MANIFEST,
        peerDependencies: { "internal-lib": "^1.0.0 || workspace:>=1.0.0" },
      })
    ).toEqual([expect.stringContaining('peerDependencies.internal-lib usa "^1.0.0 || workspace:>=1.0.0", que solo pnpm reescribe al empaquetar')]);
  });

  it("should accept registry, alias and git specifiers that only mention a protocol name", () => {
    expect(
      findPnpmPackRewrites({
        ...MANIFEST,
        dependencies: { jsr: "^1.0.0", "catalog-lib": "npm:catalog@^2.0.0", tool: "github:owner/workspace" },
      })
    ).toEqual([]);
  });

  it("should accept any npm configuration key in publishConfig", () => {
    expect(
      findPnpmPackRewrites({
        ...MANIFEST,
        publishConfig: {
          otp: "123456",
          "ignore-scripts": true,
          "@scope:registry": "https://scope.example.test/",
          "//registry.example.test/:always-auth": true,
          "dry-run": false,
          workspaces: false,
        },
      })
    ).toEqual([]);
  });

  it.each([
    "name",
    "bin",
    "engines",
    "type",
    "imports",
    "main",
    "module",
    "typings",
    "types",
    "exports",
    "browser",
    "esnext",
    "es2015",
    "unpkg",
    "umd:main",
    "os",
    "cpu",
    "libc",
    "typesVersions",
  ])("should reject publishConfig.%s because only pnpm hoists it into the packed manifest", (hoistedKey) => {
    expect(findPnpmPackRewrites({ ...MANIFEST, publishConfig: { access: "public", [hoistedKey]: "./dist/index.js" } })).toEqual([
      `publishConfig.${hoistedKey} no es configuración de npm (solo pnpm lo aplica al empaquetar)`,
    ]);
  });

  it("should list every hoisted publishConfig field and keep accepting npm configuration next to them", () => {
    expect(findPnpmPackRewrites({ ...MANIFEST, publishConfig: { tag: "next", exports: "./dist/index.js", main: "./dist/index.js" } })).toEqual([
      expect.stringContaining("publishConfig.exports no es configuración de npm"),
      expect.stringContaining("publishConfig.main no es configuración de npm"),
    ]);
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
