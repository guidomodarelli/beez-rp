import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NPM_DIST_TAG } from "../../src/constants/create-version.js";
import {
  buildNpmAuthConfigLine,
  buildNpmPublishArguments,
  buildNpmViewArguments,
  resolvePublishRegistry,
  withNpmAuthConfig,
} from "../../src/create-version/npm.js";

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

  it("binds the token to the scope-specific registry of a scoped package, as npm publish resolves it", () => {
    const registryUrl = resolvePublishRegistry({
      name: "@team/pkg",
      publishConfig: { "@team:registry": "https://npm.example.test/team/", registry: "https://fallback.example.test/" },
    });

    expect(registryUrl).toBe("https://npm.example.test/team/");
    expect(buildNpmAuthConfigLine(registryUrl)).toBe("//npm.example.test/team/:_authToken=${NPM_TOKEN}\n");
    expect(resolvePublishRegistry({ name: "@team/pkg", publishConfig: { "@team:registry": "https://npm.example.test/team/" } })).toBe(
      "https://npm.example.test/team/"
    );
  });

  it("ignores the registry of another scope and falls back to publishConfig.registry or npm's default", () => {
    const otherScope = { "@other:registry": "https://other.example.test/" };

    expect(resolvePublishRegistry({ name: "@team/pkg", publishConfig: otherScope })).toBe("https://registry.npmjs.org/");
    expect(resolvePublishRegistry({ name: "@team/pkg", publishConfig: { ...otherScope, registry: "https://fallback.example.test/" } })).toBe(
      "https://fallback.example.test/"
    );
    expect(resolvePublishRegistry({ name: "pkg", publishConfig: { "@team:registry": "https://npm.example.test/team/" } })).toBe("https://registry.npmjs.org/");
    expect(resolvePublishRegistry({ name: "pkg", publishConfig: { registry: "https://plain.example.test/" } })).toBe("https://plain.example.test/");
    expect(resolvePublishRegistry({ name: "pkg" })).toBe("https://registry.npmjs.org/");
  });

  it("rejects an invalid registry while resolving it, scoped or not", () => {
    expect(() => resolvePublishRegistry({ name: "@team/pkg", publishConfig: { "@team:registry": "npm.example.test" } })).toThrow("no es una URL válida");
    expect(() => resolvePublishRegistry({ name: "pkg", publishConfig: { registry: "ftp://registry.example.test/" } })).toThrow("http(s)");
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

describe("npm view arguments", () => {
  it("queries the registry the package is published to, because npm view ignores publishConfig", () => {
    const registryUrl = resolvePublishRegistry({ name: "@team/pkg", publishConfig: { "@team:registry": "https://npm.example.test/team/" } });

    expect(buildNpmViewArguments("@team/pkg", registryUrl)).toEqual(["view", "@team/pkg", "versions", "--json", "--registry", "https://npm.example.test/team/"]);
    expect(buildNpmViewArguments("pkg", resolvePublishRegistry({ name: "pkg" }))).toEqual([
      "view",
      "pkg",
      "versions",
      "--json",
      "--registry",
      "https://registry.npmjs.org/",
    ]);
  });

  it("rejects registries that are invalid or unsafe on the Windows shell command line", () => {
    expect(() => buildNpmViewArguments("pkg", "not a url")).toThrow("no es una URL válida");
    expect(() => buildNpmViewArguments("pkg", "https://npm.example.test/a&b/")).toThrow("caracteres no permitidos");
    expect(() => buildNpmViewArguments("pkg", "https://npm.example.test/a%20b/")).toThrow("caracteres no permitidos");
  });
});
