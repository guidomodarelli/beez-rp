import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { NPM_AUTH_STATUS, NPM_DIST_TAG, NPM_LOOKUP_STATUS, NPM_TOKEN_SOURCE } from "../../src/constants/create-version.js";
import { describeNpmAuthProblem, describeNpmPublishFailure } from "../../src/create-version/npm-auth.js";
import {
  buildNpmAuthConfigLine,
  buildNpmOwnerListArguments,
  buildNpmPublishArguments,
  buildNpmViewArguments,
  buildNpmWhoamiArguments,
  checkNpmPublishAccess,
  describePublishedRelease,
  lookupPublishedVersions,
  parseNpmOwnerList,
  resolveNpmToken,
  resolvePublishRegistry,
  withNpmAuthConfig,
} from "../../src/create-version/npm.js";
import { startFixtureNpmRegistry } from "./support/fixture-npm-registry.js";

/** Options every `npm publish` call carries after the publish target. */
const PUBLISH_OPTIONS = ["--access", "public", "--tag", NPM_DIST_TAG];

/** Credential line of the public npm registry. */
const DEFAULT_REGISTRY_AUTH_LINE = "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n";

/** Real npm processes can exceed the default timeout on Windows. */
const NPM_PROCESS_TEST_TIMEOUT_MS = 60_000;

/**
 * Variables of the test runner that would override the registry or the token the fixtures set:
 * they are removed while each test runs, so the fixtures decide what npm resolves.
 */
const ISOLATED_VARIABLE_PATTERN = /^(?:npm_config_(?:@[^:]+:)?registry|npm_token)$/iu;

/** Variables `os.homedir()` reads (HOME on POSIX, USERPROFILE on Windows); they point at a temporary home in every test. */
const HOME_VARIABLES = ["HOME", "USERPROFILE"];

/** @type {string[]} */
const temporaryDirectories = [];

/** @type {Record<string, string | undefined>} */
let isolatedVariables = {};

/** @type {Record<string, string | undefined>} */
let originalHomeVariables = {};

/** Temporary home of the running test, so the user's real ~/.config/beez-rp/.env never leaks in. */
let temporaryHome = "";

beforeEach(() => {
  isolatedVariables = Object.fromEntries(Object.entries(process.env).filter(([variableName]) => ISOLATED_VARIABLE_PATTERN.test(variableName)));
  for (const variableName of Object.keys(isolatedVariables)) delete process.env[variableName];
  originalHomeVariables = Object.fromEntries(HOME_VARIABLES.map((variableName) => [variableName, process.env[variableName]]));
  temporaryHome = mkdtempSync(path.join(os.tmpdir(), "beez-rp-npm-home-"));
  temporaryDirectories.push(temporaryHome);
  for (const variableName of HOME_VARIABLES) process.env[variableName] = temporaryHome;
});

afterEach(() => {
  for (const variableName of Object.keys(process.env).filter((name) => ISOLATED_VARIABLE_PATTERN.test(name))) delete process.env[variableName];
  Object.assign(process.env, isolatedVariables);
  for (const [variableName, value] of Object.entries(originalHomeVariables)) {
    if (value === undefined) delete process.env[variableName];
    else process.env[variableName] = value;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Creates a package root where npm reads its project config.
 *
 * @param {Record<string, unknown>} manifest - `package.json` content.
 * @param {string} [projectNpmrc] - Project `.npmrc` content; omitted for none.
 * @returns {string} Package root.
 */
function createPackageRoot(manifest, projectNpmrc) {
  const packageRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-npm-registry-"));
  temporaryDirectories.push(packageRoot);
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
  if (projectNpmrc !== undefined) writeFileSync(path.join(packageRoot, ".npmrc"), projectNpmrc);
  return packageRoot;
}

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

describe("publish registry resolution", () => {
  it(
    "binds the token to the public npm registry when neither publishConfig nor npm's config set a registry",
    async () => {
      const registryUrl = await resolvePublishRegistry({ name: "pkg", publishConfig: { access: "public" } }, createPackageRoot({ name: "pkg" }));

      expect(registryUrl).toBe("https://registry.npmjs.org/");
      expect(buildNpmAuthConfigLine(registryUrl)).toBe(DEFAULT_REGISTRY_AUTH_LINE);
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it("binds the token to the registry publishConfig declares, keeping its path and port", async () => {
    const manifest = { name: "pkg", publishConfig: { registry: "https://npm.example.test/api/npm/team" } };

    expect(buildNpmAuthConfigLine(await resolvePublishRegistry(manifest, createPackageRoot(manifest)))).toBe(
      "//npm.example.test/api/npm/team/:_authToken=${NPM_TOKEN}\n"
    );
    expect(buildNpmAuthConfigLine("http://localhost:4873/")).toBe("//localhost:4873/:_authToken=${NPM_TOKEN}\n");
  });

  it("binds the token to the scope-specific registry of a scoped package, as npm publish resolves it", async () => {
    const manifest = { name: "@team/pkg", publishConfig: { "@team:registry": "https://npm.example.test/team/", registry: "https://fallback.example.test/" } };
    const registryUrl = await resolvePublishRegistry(manifest, createPackageRoot(manifest));

    expect(registryUrl).toBe("https://npm.example.test/team/");
    expect(buildNpmAuthConfigLine(registryUrl)).toBe("//npm.example.test/team/:_authToken=${NPM_TOKEN}\n");
  });

  it(
    "ignores the publishConfig registry of another scope and falls back to publishConfig.registry or npm's config",
    async () => {
      const otherScope = { "@other:registry": "https://other.example.test/" };
      const packageRoot = createPackageRoot({ name: "@team/pkg" });

      expect(await resolvePublishRegistry({ name: "@team/pkg", publishConfig: otherScope }, packageRoot)).toBe("https://registry.npmjs.org/");
      expect(
        await resolvePublishRegistry({ name: "@team/pkg", publishConfig: { ...otherScope, registry: "https://fallback.example.test/" } }, packageRoot)
      ).toBe("https://fallback.example.test/");
      expect(await resolvePublishRegistry({ name: "pkg", publishConfig: { "@team:registry": "https://npm.example.test/team/" } }, packageRoot)).toBe(
        "https://registry.npmjs.org/"
      );
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it(
    "resolves the registry a project .npmrc selects, plain or for the package scope, as npm publish does",
    async () => {
      const plainRoot = createPackageRoot({ name: "pkg" }, "registry=https://npm.example.test/plain/\n");
      expect(await resolvePublishRegistry({ name: "pkg" }, plainRoot)).toBe("https://npm.example.test/plain/");

      const scopedRoot = createPackageRoot({ name: "@team/pkg" }, "@team:registry=https://npm.example.test/team/\nregistry=https://npm.example.test/plain/\n");
      expect(await resolvePublishRegistry({ name: "@team/pkg" }, scopedRoot)).toBe("https://npm.example.test/team/");
      expect(await resolvePublishRegistry({ name: "@other/pkg" }, scopedRoot)).toBe("https://npm.example.test/plain/");
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it(
    "prefers publishConfig over the project .npmrc and validates the registry npm's config resolves",
    async () => {
      const packageRoot = createPackageRoot({ name: "@team/pkg" }, "@team:registry=https://npm.example.test/team/\n");
      expect(await resolvePublishRegistry({ name: "@team/pkg", publishConfig: { registry: "https://declared.example.test/" } }, packageRoot)).toBe(
        "https://declared.example.test/"
      );

      const invalidRoot = createPackageRoot({ name: "pkg" }, "registry=ftp://npm.example.test/\n");
      await expect(resolvePublishRegistry({ name: "pkg" }, invalidRoot)).rejects.toThrow("http(s)");
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it("rejects an invalid publishConfig registry, scoped or not", async () => {
    const packageRoot = createPackageRoot({ name: "pkg" });

    await expect(resolvePublishRegistry({ name: "@team/pkg", publishConfig: { "@team:registry": "npm.example.test" } }, packageRoot)).rejects.toThrow(
      "no es una URL válida"
    );
    await expect(resolvePublishRegistry({ name: "pkg", publishConfig: { registry: "ftp://registry.example.test/" } }, packageRoot)).rejects.toThrow("http(s)");
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
    expect(buildNpmViewArguments("@team/pkg", "https://npm.example.test/team/")).toEqual([
      "view",
      "@team/pkg",
      "versions",
      "dist-tags",
      "--json",
      "--registry",
      "https://npm.example.test/team/",
    ]);
    expect(buildNpmViewArguments("pkg", "https://registry.npmjs.org/")).toEqual(["view", "pkg", "versions", "dist-tags", "--json", "--registry", "https://registry.npmjs.org/"]);
  });

  it("adds the temporary authenticated user config when there is one", () => {
    expect(buildNpmViewArguments("pkg", "https://npm.example.test/", "/tmp/beez-rp-npm-auth-fixture/npmrc")).toEqual([
      "view",
      "pkg",
      "versions",
      "dist-tags",
      "--json",
      "--registry",
      "https://npm.example.test/",
      "--userconfig",
      "/tmp/beez-rp-npm-auth-fixture/npmrc",
    ]);
  });

  it("rejects registries that are invalid or unsafe on the Windows shell command line", () => {
    expect(() => buildNpmViewArguments("pkg", "not a url")).toThrow("no es una URL válida");
    expect(() => buildNpmViewArguments("pkg", "https://npm.example.test/a&b/")).toThrow("caracteres no permitidos");
    expect(() => buildNpmViewArguments("pkg", "https://npm.example.test/a%20b/")).toThrow("caracteres no permitidos");
  });
});

describe("published versions lookup", () => {
  /** Token the fixture registry accepts; not a real credential. */
  const FIXTURE_TOKEN = "fixture-registry-token";

  /** Private package served by the fixture registry. */
  const PRIVATE_PACKAGE_NAME = "fixture-private";

  /**
   * Serves a private package that answers only requests carrying {@link FIXTURE_TOKEN}.
   *
   * @returns {Promise<{ registryUrl: string, close: () => Promise<void> }>} Local registry.
   */
  async function startPrivateRegistry() {
    const server = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "authentication required" }));
        return;
      }

      const versions = Object.fromEntries(["1.0.0", "1.1.0"].map((version) => [version, { name: PRIVATE_PACKAGE_NAME, version }]));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: PRIVATE_PACKAGE_NAME, "dist-tags": { latest: "1.1.0" }, versions }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    return { registryUrl: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
  }

  it(
    "authenticates npm view with NPM_TOKEN from .env so a private package can be diagnosed",
    async () => {
      const registry = await startPrivateRegistry();

      try {
        const packageRoot = createPackageRoot({ name: PRIVATE_PACKAGE_NAME });
        const anonymous = await lookupPublishedVersions(PRIVATE_PACKAGE_NAME, packageRoot, registry.registryUrl);
        expect(anonymous.status).toBe(NPM_LOOKUP_STATUS.failed);

        writeFileSync(path.join(packageRoot, ".env"), `NPM_TOKEN=${FIXTURE_TOKEN}\n`);
        const authenticated = await lookupPublishedVersions(PRIVATE_PACKAGE_NAME, packageRoot, registry.registryUrl);
        expect(authenticated).toEqual({ status: NPM_LOOKUP_STATUS.ok, publishedVersions: ["1.0.0", "1.1.0"], latestVersion: "1.1.0", reason: null });
      } finally {
        await registry.close();
      }
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );
});

describe("published release summary", () => {
  it("links the npmjs.com page only for the public npm registry", () => {
    expect(describePublishedRelease({ registryUrl: "https://registry.npmjs.org/", packageName: "@team/pkg", version: "1.2.0" })).toBe(
      "https://www.npmjs.com/package/@team/pkg/v/1.2.0"
    );
    expect(describePublishedRelease({ registryUrl: "https://registry.npmjs.org", packageName: "pkg", version: "1.2.0" })).toBe(
      "https://www.npmjs.com/package/pkg/v/1.2.0"
    );
    expect(describePublishedRelease({ registryUrl: "https://npm.example.test/team/", packageName: "@team/pkg", version: "1.2.0" })).toBe(
      "Registro: https://npm.example.test/team/ · @team/pkg@1.2.0"
    );
  });
});

/**
 * Writes the environment file shared by every project inside the temporary home.
 *
 * @param {string} content - File content.
 */
function writeSharedEnvironmentFile(content) {
  const directory = path.join(temporaryHome, ".config", "beez-rp");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, ".env"), content);
}

describe("NPM_TOKEN resolution", () => {
  it("prefers the environment, then the repository .env, then ~/.config/beez-rp/.env from os.homedir()", () => {
    const packageRoot = createPackageRoot({ name: "pkg" });
    expect(resolveNpmToken(packageRoot)).toEqual({ token: null, source: null });

    writeSharedEnvironmentFile("NPM_TOKEN=shared-token\n");
    expect(resolveNpmToken(packageRoot)).toEqual({ token: "shared-token", source: NPM_TOKEN_SOURCE.shared });

    writeFileSync(path.join(packageRoot, ".env"), "OTHER=1\nNPM_TOKEN=repository-token\n");
    expect(resolveNpmToken(packageRoot)).toEqual({ token: "repository-token", source: NPM_TOKEN_SOURCE.repository });

    process.env.NPM_TOKEN = "environment-token";
    expect(resolveNpmToken(packageRoot)).toEqual({ token: "environment-token", source: NPM_TOKEN_SOURCE.environment });
  });

  it("skips sources with an empty NPM_TOKEN and never loads the files into process.env", () => {
    const packageRoot = createPackageRoot({ name: "pkg" });
    writeFileSync(path.join(packageRoot, ".env"), "NPM_TOKEN=\nOTHER_SECRET=1\n");
    writeSharedEnvironmentFile("NPM_TOKEN=shared-token\n");

    expect(resolveNpmToken(packageRoot, { environment: { NPM_TOKEN: "" } })).toEqual({ token: "shared-token", source: NPM_TOKEN_SOURCE.shared });
    expect(process.env.NPM_TOKEN).toBeUndefined();
    expect(process.env.OTHER_SECRET).toBeUndefined();
  });
});

describe("npm credential commands", () => {
  it("builds whoami and owner ls against the publish registry with the temporary config", () => {
    expect(buildNpmWhoamiArguments("https://npm.example.test/team/", "/tmp/npmrc")).toEqual(["whoami", "--json=false", "--registry", "https://npm.example.test/team/", "--userconfig", "/tmp/npmrc"]);
    expect(buildNpmOwnerListArguments("@team/pkg", "https://registry.npmjs.org/", "/tmp/npmrc")).toEqual([
      "owner",
      "ls",
      "--json=false",
      "@team/pkg",
      "--registry",
      "https://registry.npmjs.org/",
      "--userconfig",
      "/tmp/npmrc",
    ]);
    expect(() => buildNpmWhoamiArguments("https://npm.example.test/a&b/", "/tmp/npmrc")).toThrow("caracteres no permitidos");
  });

  it("parses the owners npm owner ls prints", () => {
    expect(parseNpmOwnerList("guidomodarelli <guido@example.test>\nother-user <other@example.test>\n")).toEqual(["guidomodarelli", "other-user"]);
    expect(parseNpmOwnerList("")).toEqual([]);
  });
});

describe("npm publish access check", () => {
  /** Token of the package owner in the fixture registry; not a real credential. */
  const OWNER_TOKEN = "fixture-owner-token";

  /** Token of a user that does not own the package; not a real credential. */
  const STRANGER_TOKEN = "fixture-stranger-token";

  /** Package published by the owner in the fixture registry. */
  const PACKAGE_NAME = "fixture-published";

  /** @returns {ReturnType<typeof startFixtureNpmRegistry>} Registry with one package owned by `fixture-owner`. */
  function startRegistry() {
    return startFixtureNpmRegistry({
      users: { [OWNER_TOKEN]: "fixture-owner", [STRANGER_TOKEN]: "fixture-stranger" },
      packages: { [PACKAGE_NAME]: { maintainers: ["fixture-owner"], versions: ["1.0.0"] } },
    });
  }

  it(
    "reports the user and the token source when the owner token can publish",
    async () => {
      const registry = await startRegistry();

      try {
        const packageRoot = createPackageRoot({ name: PACKAGE_NAME });
        writeFileSync(path.join(packageRoot, ".env"), `NPM_TOKEN=${OWNER_TOKEN}\n`);

        expect(await checkNpmPublishAccess(PACKAGE_NAME, packageRoot, registry.registryUrl)).toMatchObject({
          status: NPM_AUTH_STATUS.ok,
          user: "fixture-owner",
          source: NPM_TOKEN_SOURCE.repository,
          owners: ["fixture-owner"],
          firstPublication: false,
        });
      } finally {
        await registry.close();
      }
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it(
    "blocks an invalid token and names its source without showing it",
    async () => {
      const registry = await startRegistry();

      try {
        const packageRoot = createPackageRoot({ name: PACKAGE_NAME });
        writeSharedEnvironmentFile("NPM_TOKEN=expired-token\n");

        const check = await checkNpmPublishAccess(PACKAGE_NAME, packageRoot, registry.registryUrl);
        const problem = describeNpmAuthProblem(check);

        expect(check).toMatchObject({ status: NPM_AUTH_STATUS.invalidToken, source: NPM_TOKEN_SOURCE.shared, user: null });
        expect(problem?.title).toBe("El NPM_TOKEN (~/.config/beez-rp/.env) es inválido o venció");
        expect(JSON.stringify(problem)).not.toContain("expired-token");
      } finally {
        await registry.close();
      }
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it(
    "blocks a token whose user does not own the package and lists the owners",
    async () => {
      const registry = await startRegistry();

      try {
        const packageRoot = createPackageRoot({ name: PACKAGE_NAME });
        process.env.NPM_TOKEN = STRANGER_TOKEN;

        const check = await checkNpmPublishAccess(PACKAGE_NAME, packageRoot, registry.registryUrl);

        expect(check).toMatchObject({ status: NPM_AUTH_STATUS.notOwner, user: "fixture-stranger", owners: ["fixture-owner"], source: NPM_TOKEN_SOURCE.environment });
        expect(describeNpmAuthProblem(check)?.title).toBe(
          "El token autentica como fixture-stranger, que no puede publicar fixture-published (dueños: fixture-owner)"
        );
      } finally {
        await registry.close();
      }
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it(
    "accepts the first publication of a package the registry does not know yet",
    async () => {
      const registry = await startRegistry();

      try {
        const packageRoot = createPackageRoot({ name: "fixture-new" });
        process.env.NPM_TOKEN = STRANGER_TOKEN;

        expect(await checkNpmPublishAccess("fixture-new", packageRoot, registry.registryUrl)).toMatchObject({
          status: NPM_AUTH_STATUS.ok,
          user: "fixture-stranger",
          firstPublication: true,
        });
      } finally {
        await registry.close();
      }
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it(
    "recognizes the owner when the project config enables npm's global JSON output",
    async () => {
      const registry = await startRegistry();

      try {
        const packageRoot = createPackageRoot({ name: PACKAGE_NAME }, "json=true\n");
        process.env.NPM_TOKEN = OWNER_TOKEN;

        expect(await checkNpmPublishAccess(PACKAGE_NAME, packageRoot, registry.registryUrl)).toMatchObject({
          status: NPM_AUTH_STATUS.ok,
          user: "fixture-owner",
          owners: ["fixture-owner"],
        });
      } finally {
        await registry.close();
      }
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it(
    "blocks project .npmrc credentials for the registry, which npm would use instead of NPM_TOKEN, without showing them",
    async () => {
      const registry = await startRegistry();

      try {
        const registryKey = registry.registryUrl.replace(/^http:/u, "");
        const packageRoot = createPackageRoot({ name: PACKAGE_NAME }, `${registryKey}:_authToken=${STRANGER_TOKEN}\n`);
        process.env.NPM_TOKEN = OWNER_TOKEN;

        const check = await checkNpmPublishAccess(PACKAGE_NAME, packageRoot, registry.registryUrl);
        const problem = describeNpmAuthProblem(check);

        expect(check).toMatchObject({ status: NPM_AUTH_STATUS.projectCredentials, user: null, source: NPM_TOKEN_SOURCE.environment });
        expect(problem?.title).toBe(`El .npmrc del proyecto define credenciales para ${registry.registryUrl} que tienen prioridad sobre NPM_TOKEN`);
        expect(problem?.details.join(" ")).toContain("Sacalas: beez-rp usa NPM_TOKEN con una config temporal.");
        expect(JSON.stringify(problem)).not.toContain(STRANGER_TOKEN);

        writeFileSync(path.join(packageRoot, ".npmrc"), `//npm.example.test/:_authToken=${STRANGER_TOKEN}\n`);
        expect(await checkNpmPublishAccess(PACKAGE_NAME, packageRoot, registry.registryUrl)).toMatchObject({ status: NPM_AUTH_STATUS.ok, user: "fixture-owner" });
      } finally {
        await registry.close();
      }
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it(
    "authenticates with the selected NPM_TOKEN even when the environment inherits another credential for the registry",
    async () => {
      const registry = await startRegistry();

      try {
        const registryKey = registry.registryUrl.replace(/^http:/u, "");
        const packageRoot = createPackageRoot({ name: PACKAGE_NAME });
        const environment = { ...process.env, NPM_TOKEN: OWNER_TOKEN, [`npm_config_${registryKey}:_authToken`]: "inherited-invalid-token" };

        expect(await checkNpmPublishAccess(PACKAGE_NAME, packageRoot, registry.registryUrl, { environment })).toMatchObject({
          status: NPM_AUTH_STATUS.ok,
          user: "fixture-owner",
          source: NPM_TOKEN_SOURCE.environment,
        });
      } finally {
        await registry.close();
      }
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it(
    "keeps a registry-scoped TLS keyfile in the project .npmrc usable alongside NPM_TOKEN",
    async () => {
      const registry = await startRegistry();

      try {
        const registryKey = registry.registryUrl.replace(/^http:/u, "");
        const packageRoot = createPackageRoot({ name: PACKAGE_NAME }, `${registryKey}:keyfile=client-key.pem\n`);
        process.env.NPM_TOKEN = OWNER_TOKEN;

        expect(await checkNpmPublishAccess(PACKAGE_NAME, packageRoot, registry.registryUrl)).toMatchObject({ status: NPM_AUTH_STATUS.ok, user: "fixture-owner" });
      } finally {
        await registry.close();
      }
    },
    NPM_PROCESS_TEST_TIMEOUT_MS
  );

  it("fails the lookup and leaves the access check unverified, naming the .env it could not read", async () => {
    const packageRoot = createPackageRoot({ name: PACKAGE_NAME });
    const environmentFilePath = path.join(packageRoot, ".env");
    mkdirSync(environmentFilePath);

    expect(await lookupPublishedVersions(PACKAGE_NAME, packageRoot, "https://registry.npmjs.org/")).toEqual({
      status: NPM_LOOKUP_STATUS.failed,
      publishedVersions: [],
      reason: expect.stringContaining(`no se pudo leer ${environmentFilePath}`),
    });
    expect(await checkNpmPublishAccess(PACKAGE_NAME, packageRoot, "https://registry.npmjs.org/")).toMatchObject({
      status: NPM_AUTH_STATUS.unknown,
      reason: expect.stringContaining(`no se pudo leer ${environmentFilePath}`),
    });
  });

  it("reports a missing token with every place where it can be defined", async () => {
    const check = await checkNpmPublishAccess(PACKAGE_NAME, createPackageRoot({ name: PACKAGE_NAME }), "https://registry.npmjs.org/");

    expect(check.status).toBe(NPM_AUTH_STATUS.missingToken);
    expect(describeNpmAuthProblem(check)?.details.join(" ")).toContain("~/.config/beez-rp/.env");
  });
});

describe("npm publish failure translation", () => {
  /** @type {import("../../src/create-version/npm.js").NpmAuthCheck} */
  const PASSING_CHECK = {
    status: NPM_AUTH_STATUS.ok,
    user: "fixture-owner",
    source: NPM_TOKEN_SOURCE.repository,
    registryUrl: "https://registry.npmjs.org/",
    packageName: "fixture-published",
    owners: ["fixture-owner"],
    firstPublication: false,
    reason: null,
  };

  it("explains an invalid token and a user without permission, mentioning the 404 of the PUT", () => {
    const invalid = describeNpmPublishFailure({ ...PASSING_CHECK, status: NPM_AUTH_STATUS.invalidToken, user: null }, { exitCode: 1, version: "1.1.0" });
    expect(invalid.message).toBe("npm publish terminó con código 1: El NPM_TOKEN (.env del repo) es inválido o venció.");
    expect(invalid.hint).toContain("reintentar solo la publicación");

    const notOwner = describeNpmPublishFailure({ ...PASSING_CHECK, status: NPM_AUTH_STATUS.notOwner, user: "fixture-stranger" }, { exitCode: 1, version: "1.1.0" });
    expect(notOwner.message).toContain("fixture-stranger, que no puede publicar fixture-published (dueños: fixture-owner)");
    expect(notOwner.hint).toContain("404 Not Found");
  });

  it("keeps the generic failure for an owner and names a read-only or granular token as a possible cause", () => {
    const generic = describeNpmPublishFailure(PASSING_CHECK, { exitCode: 1, version: "1.1.0" });

    expect(generic.message).toBe("npm publish terminó con código 1.");
    expect(generic.hint).toContain("Comprobá en npm si 1.1.0 llegó");
    expect(generic.hint).toContain("autentican como fixture-owner, dueño de fixture-published");
    expect(generic.hint).toContain("El token puede ser read-only o granular sin permiso de escritura sobre el paquete");
    expect(generic.hint).toContain("404 Not Found");
  });

  it("does not call the user an owner when the failed publication was the first one", () => {
    const firstPublication = describeNpmPublishFailure({ ...PASSING_CHECK, owners: [], firstPublication: true }, { exitCode: 1, version: "1.0.0" });

    expect(firstPublication.hint).toContain("autentican como fixture-owner.");
    expect(firstPublication.hint).not.toContain("dueño de");
    expect(firstPublication.hint).toContain("read-only o granular");
  });
});
