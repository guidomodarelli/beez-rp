import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NPM_DIST_TAG } from "../../src/constants/create-version.js";
import { buildNpmAuthConfigLine, buildNpmPublishArguments, resolvePublishRegistry, withNpmAuthConfig } from "../../src/create-version/npm.js";

/** Options every `npm publish` call carries after the publish target. */
const PUBLISH_OPTIONS = ["--access", "public", "--tag", NPM_DIST_TAG];

/** Credential line of the public npm registry. */
const DEFAULT_REGISTRY_AUTH_LINE = "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n";

/** @type {string[]} */
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildNpmPublishArguments", () => {
  it("publishes the working tree when there is no prepared artifact", () => {
    expect(buildNpmPublishArguments(null)).toEqual(["publish", ...PUBLISH_OPTIONS]);
    expect(buildNpmPublishArguments()).toEqual(["publish", ...PUBLISH_OPTIONS]);
  });

  it("prefixes a nested relative artifact so npm reads it as a file instead of a package spec", () => {
    expect(buildNpmPublishArguments("releases/1.9.0-abc/pkg-1.9.0.tgz")).toEqual([
      "publish",
      "./releases/1.9.0-abc/pkg-1.9.0.tgz",
      ...PUBLISH_OPTIONS,
    ]);
  });

  it("prefixes an artifact at the repository root", () => {
    expect(buildNpmPublishArguments("pkg-1.9.0.tgz")).toEqual(["publish", "./pkg-1.9.0.tgz", ...PUBLISH_OPTIONS]);
  });

  it("keeps an artifact that is already explicitly relative", () => {
    expect(buildNpmPublishArguments("./releases/pkg-1.9.0.tgz")).toEqual(["publish", "./releases/pkg-1.9.0.tgz", ...PUBLISH_OPTIONS]);
  });
});

describe("publish registry credentials", () => {
  it("binds the token to the public npm registry when publishConfig.registry is not set", () => {
    const registryUrl = resolvePublishRegistry({ name: "pkg", publishConfig: { access: "public" } });

    expect(registryUrl).toBe("https://registry.npmjs.org/");
    expect(buildNpmAuthConfigLine(registryUrl)).toBe(DEFAULT_REGISTRY_AUTH_LINE);
  });

  it("binds the token to the registry publishConfig declares, keeping its path and port", () => {
    expect(buildNpmAuthConfigLine(resolvePublishRegistry({ publishConfig: { registry: "https://npm.example.test/api/npm/team" } }))).toBe(
      "//npm.example.test/api/npm/team/:_authToken=${NPM_TOKEN}\n"
    );
    expect(buildNpmAuthConfigLine("http://localhost:4873/")).toBe("//localhost:4873/:_authToken=${NPM_TOKEN}\n");
  });

  it("rejects registries that are not plain http(s) URLs", () => {
    expect(() => buildNpmAuthConfigLine("registry.example.test")).toThrow("no es una URL válida");
    expect(() => buildNpmAuthConfigLine("ftp://registry.example.test/")).toThrow("http(s)");
    expect(() => buildNpmAuthConfigLine("https://user:secret@registry.example.test/")).toThrow("sin credenciales");
  });

  it("writes only the NPM_TOKEN reference and removes the config afterwards, even on failure", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "beez-rp-npm-auth-test-"));
    temporaryDirectories.push(parent);
    const authConfigLine = buildNpmAuthConfigLine("https://npm.example.test/team/");
    /** @type {string[]} */
    const seenPaths = [];

    const content = await withNpmAuthConfig(
      authConfigLine,
      async (userConfigPath) => {
        seenPaths.push(userConfigPath);
        return readFileSync(userConfigPath, "utf8");
      },
      parent
    );

    expect(content).toBe("//npm.example.test/team/:_authToken=${NPM_TOKEN}\n");

    await expect(
      withNpmAuthConfig(
        authConfigLine,
        async (userConfigPath) => {
          seenPaths.push(userConfigPath);
          throw new Error("npm failed");
        },
        parent
      )
    ).rejects.toThrow("npm failed");
    expect(seenPaths).toHaveLength(2);
    expect(seenPaths.some((userConfigPath) => existsSync(userConfigPath))).toBe(false);
  });
});
