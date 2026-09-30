import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildChangelogPrompt } from "../../src/changelog-ai.js";
import { loadCreateVersionConfig, resolveCreateVersionConfig } from "../../src/create-version/config.js";
import { describeProjectCommands } from "../../src/package-manager.js";

/** @type {string[]} */
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("create-version config", () => {
  it("should accept versionFiles inside the project root and reject paths that escape it", () => {
    const base = { changelog: { audience: "equipo" } };

    expect(resolveCreateVersionConfig({ ...base, versionFiles: ["src/cli.ts", "docs/install.md"] }).versionFiles).toEqual(["src/cli.ts", "docs/install.md"]);
    expect(resolveCreateVersionConfig(base).versionFiles).toEqual([]);
    for (const versionFiles of [["../outside.ts"], ["src/../../outside.ts"], ["src\\..\\..\\outside.ts"], [path.resolve("absolute.ts")], ["/absolute.ts"], ["\\absolute.ts"], ["C:\\absolute.ts"], [""], "src/cli.ts"]) {
      expect(() => resolveCreateVersionConfig({ ...base, versionFiles })).toThrow(/versionFiles must be a list of file paths relative to the project root/);
    }
  });

  it("should resolve versionFiles written with backslashes or ./ segments to the same slash-separated path on every platform", () => {
    const base = { changelog: { audience: "equipo" } };

    expect(resolveCreateVersionConfig({ ...base, versionFiles: ["src\\cli.js", ".\\docs/install.md", "./lib//version.js"] }).versionFiles).toEqual([
      "src/cli.js",
      "docs/install.md",
      "lib/version.js",
    ]);
  });

  it("should reject versionFiles naming package.json or CHANGELOG.md under any separator spelling, since the release commit already writes them", () => {
    const base = { changelog: { audience: "equipo" } };

    for (const builtInFile of ["CHANGELOG.md", "./CHANGELOG.md", "package.json", ".\\package.json", "./package.json/"]) {
      expect(() => resolveCreateVersionConfig({ ...base, versionFiles: ["src/cli.ts", builtInFile] })).toThrow(
        /versionFiles must be a list without package\.json nor CHANGELOG\.md, which the release commit already updates/
      );
    }
    expect(resolveCreateVersionConfig({ ...base, versionFiles: ["docs/CHANGELOG.md", "packages/app/package.json"] }).versionFiles).toEqual([
      "docs/CHANGELOG.md",
      "packages/app/package.json",
    ]);
  });

  it("should accept versionFiles differing from package.json or CHANGELOG.md only in letter case, which are other files on a case-sensitive file system", () => {
    const base = { changelog: { audience: "equipo" } };

    expect(resolveCreateVersionConfig({ ...base, versionFiles: ["Package.json", "CHANGELOG.MD", "./changelog.md"] }).versionFiles).toEqual([
      "Package.json",
      "CHANGELOG.MD",
      "changelog.md",
    ]);
  });

  it("should run the default ci checks with the project's package manager", () => {
    const config = resolveCreateVersionConfig(
      { changelog: { audience: "quien usa la app" } },
      { packageScripts: { ci: "bun test" }, commands: describeProjectCommands("bun") }
    );

    expect(config.checks).toEqual(["bun run ci"]);
    expect(config.commands.createVersion).toBe("bun run create-version");
  });

  it("should detect bun from packageManager when loading the configuration", async () => {
    const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-config-bun-"));
    temporaryDirectories.push(repositoryRoot);
    writeFileSync(path.join(repositoryRoot, "package.json"), JSON.stringify({ name: "app", packageManager: "bun@1.3.11", scripts: { ci: "bun test" } }));
    writeFileSync(path.join(repositoryRoot, "beez-rp.config.mjs"), 'export default { changelog: { audience: "quien usa la app" } };');

    const config = await loadCreateVersionConfig(repositoryRoot);

    expect(config.checks).toEqual(["bun run ci"]);
    expect(config.commands.packageManager).toBe("bun");
  });

  it("should fill defaults and derive npm tracking from the npm publisher", () => {
    const config = resolveCreateVersionConfig({ changelog: { audience: "quien usa la app" }, publish: "npm" });

    expect(config).toMatchObject({
      projectName: null,
      changelog: { audience: "quien usa la app", language: "es" },
      registry: "npm",
      checks: null,
      prepare: null,
      publish: "npm",
      migrations: null,
      summary: [],
    });
    expect(Object.keys(config.releaseTypeDescriptions)).toEqual(["patch", "minor", "major"]);
  });

  it("should keep project descriptions, commands and hooks", () => {
    const publish = async () => {};
    const config = resolveCreateVersionConfig({
      changelog: { audience: "plugin users", language: "en" },
      releaseTypeDescriptions: { major: "Breaking rules." },
      registry: "npm",
      checks: ["pnpm check"],
      prepare: ["pnpm release:prepare"],
      publish,
    });

    expect(config.releaseTypeDescriptions.major).toBe("Breaking rules.");
    expect(config.releaseTypeDescriptions.patch).toBeTypeOf("string");
    expect(config.publish).toBe(publish);
    expect(config.changelog.language).toBe("en");
    expect(config.artifact).toBeNull();

    const tarball = resolveCreateVersionConfig({ changelog: { audience: "x" }, publish: "npm", artifact: "releases/{version}-*/{name}-{version}.tgz" });
    expect(tarball).toMatchObject({ registry: "npm", artifact: "releases/{version}-*/{name}-{version}.tgz" });
  });

  it("should default the checks to pnpm run ci only when package.json declares a ci script, and skip them with false", () => {
    const withCi = { packageScripts: { ci: "pnpm lint && pnpm test" } };

    expect(resolveCreateVersionConfig({ changelog: { audience: "x" } }, withCi).checks).toEqual(["pnpm run ci"]);
    expect(resolveCreateVersionConfig({ changelog: { audience: "x" } }, { packageScripts: { test: "vitest" } }).checks).toBeNull();
    expect(resolveCreateVersionConfig({ changelog: { audience: "x" }, checks: ["pnpm check"] }, withCi).checks).toEqual(["pnpm check"]);
    expect(resolveCreateVersionConfig({ changelog: { audience: "x" }, checks: false }, withCi).checks).toEqual([]);
  });

  it.each([
    [null, /default export/],
    [{}, /changelog.audience/],
    [{ changelog: { audience: "x", language: "fr" } }, /changelog.language/],
    [{ changelog: { audience: "x" }, publish: "yarn" }, /publish/],
    [{ changelog: { audience: "x" }, checks: "pnpm check" }, /checks/],
    [{ changelog: { audience: "x" }, checks: [] }, /checks.*false/],
    [{ changelog: { audience: "x" }, checks: true }, /checks/],
    [{ changelog: { audience: "x" }, prepare: [""] }, /prepare/],
    [{ changelog: { audience: "x" }, migrations: { check: () => {} } }, /migrations/],
    [{ changelog: { audience: "x" }, releaseTypeDescriptions: { huge: "x" } }, /releaseTypeDescriptions.huge/],
    [{ changelog: { audience: "x" }, registry: "pypi" }, /registry/],
    [{ changelog: { audience: "x" }, publish: "npm", artifact: "releases/pkg.tgz" }, /artifact/],
    [{ changelog: { audience: "x" }, artifact: "releases/{version}.tgz" }, /artifact.*publish/],
  ])("should reject %j", (rawConfig, message) => {
    expect(() => resolveCreateVersionConfig(rawConfig)).toThrow(message);
  });

  it("should load beez-rp.config.js from the repository root and explain a missing file", async () => {
    const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-config-"));
    temporaryDirectories.push(repositoryRoot);

    await expect(loadCreateVersionConfig(repositoryRoot)).rejects.toThrow(/beez-rp.config.mjs or beez-rp.config.js not found/);

    writeFileSync(path.join(repositoryRoot, "beez-rp.config.js"), 'export default { changelog: { audience: "equipo" }, checks: ["pnpm test"] };\n');
    await expect(loadCreateVersionConfig(repositoryRoot)).resolves.toMatchObject({ checks: ["pnpm test"], changelog: { language: "es" } });

    // A CommonJS project keeps its config as .mjs, which wins over .js.
    writeFileSync(path.join(repositoryRoot, "package.json"), '{ "type": "commonjs" }\n');
    writeFileSync(path.join(repositoryRoot, "beez-rp.config.mjs"), 'export default { changelog: { audience: "equipo" }, checks: ["pnpm lint"] };\n');
    await expect(loadCreateVersionConfig(repositoryRoot)).resolves.toMatchObject({ checks: ["pnpm lint"] });
  });

  it("should read the ci script of package.json for the default checks and name an unreadable manifest", async () => {
    const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-config-"));
    temporaryDirectories.push(repositoryRoot);
    writeFileSync(path.join(repositoryRoot, "beez-rp.config.mjs"), 'export default { changelog: { audience: "equipo" } };\n');

    await expect(loadCreateVersionConfig(repositoryRoot)).resolves.toMatchObject({ checks: null });

    writeFileSync(path.join(repositoryRoot, "package.json"), '{ "scripts": { "ci": "pnpm test" } }\n');
    await expect(loadCreateVersionConfig(repositoryRoot)).resolves.toMatchObject({ checks: ["pnpm run ci"] });

    writeFileSync(path.join(repositoryRoot, "package.json"), "{ not json");
    await expect(loadCreateVersionConfig(repositoryRoot)).rejects.toThrow(/could not read the scripts of .*package\.json/);
  });
});

describe("changelog prompt language", () => {
  const commits = [{ sha: "0123456789abcdef", subject: "feat: add preset" }];

  it("should keep Spanish by default and write English ASCII instructions on request", () => {
    expect(buildChangelogPrompt(commits, "quien usa la app")).toContain("en español");

    const english = buildChangelogPrompt(commits, "plugin users", "en");
    expect(english).toContain("in English and ASCII only, clear for plugin users");
    expect(english).toContain("- 0123456 feat: add preset");
    expect(english).toMatch(/^[\x20-\x7e\n]*$/u);
  });
});
