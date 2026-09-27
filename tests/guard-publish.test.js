import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GUARD_PUBLISH_EXIT_CODE, PACKAGE_MANAGER_USER_AGENT_VARIABLE } from "../src/constants/guard-publish.js";
import { buildNpmPublishEnvironment } from "../src/create-version/npm.js";
import { decidePublishGuard, decidePublishGuardForEnvironment } from "../src/guard-publish.js";

/** Real npm runs can exceed the default timeout on Windows. */
const NPM_FIXTURE_TEST_TIMEOUT_MS = 120_000;

/** CLI declared by each project as `prepublishOnly`. */
const CLI_PATH = fileURLToPath(new URL("../bin/beez-rp.js", import.meta.url));

/** User agent pnpm exports to the processes it spawns. */
const PNPM_USER_AGENT = "pnpm/12.6.0 npm/? node/v24.21.0 win32 x64";

/** User agent npm reports to its lifecycle scripts. */
const NPM_USER_AGENT = "npm/11.19.1 node/v24.21.0 win32 x64 workspaces/false";

/** @type {string[]} */
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {string | undefined} userAgent - User agent to expose, or `undefined` to remove it.
 * @returns {NodeJS.ProcessEnv} Current environment with that user agent.
 */
function createEnvironmentWithUserAgent(userAgent) {
  // Test runners launched by npm on Windows may also expose NPM_CONFIG_USER_AGENT.
  const environment = buildNpmPublishEnvironment(process.env);
  return userAgent === undefined ? environment : { ...environment, [PACKAGE_MANAGER_USER_AGENT_VARIABLE]: userAgent };
}

/**
 * @param {string | undefined} userAgent - User agent of the lifecycle script.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} Result of `beez-rp guard-publish`.
 */
function runGuardCli(userAgent) {
  return spawnSync(process.execPath, [CLI_PATH, "guard-publish"], { encoding: "utf8", env: createEnvironmentWithUserAgent(userAgent) });
}

/** @returns {string} Package whose `prepublishOnly` runs the guard of this checkout. */
function createGuardedPackageFixture() {
  const packageRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-guard-publish-"));
  temporaryDirectories.push(packageRoot);
  const manifest = {
    name: "beez-rp-guard-publish-fixture",
    version: "1.0.0",
    scripts: { prepublishOnly: `node "${CLI_PATH}" guard-publish` },
  };
  writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(packageRoot, "index.js"), "export {};\n");
  return packageRoot;
}

/**
 * @param {string} packageRoot - Fixture root.
 * @param {NodeJS.ProcessEnv} environment - Environment of the npm process.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} Result of `npm publish --dry-run`.
 */
function runNpmPublishDryRun(packageRoot, environment) {
  return spawnSync("npm publish --dry-run", { cwd: packageRoot, encoding: "utf8", env: environment, shell: true });
}

describe("decidePublishGuard", () => {
  it.each([
    ["pnpm", PNPM_USER_AGENT],
    ["yarn", "yarn/4.9.2 npm/? node/v24.21.0 linux x64"],
    ["bun", "bun/1.2.19 npm/? node/v24.3.0 darwin arm64"],
  ])("blocks %s and explains how Beez packages are published", (packageManager, userAgent) => {
    const decision = decidePublishGuard(userAgent);

    expect(decision).toMatchObject({ allowed: false, packageManager, exitCode: GUARD_PUBLISH_EXIT_CODE.blocked });
    expect(decision.message).toContain(`no publiques con ${packageManager}`);
    expect(decision.message).toContain("pnpm create-version");
  });

  it.each([
    ["npm", NPM_USER_AGENT],
    ["a missing user agent", undefined],
    ["an empty user agent", ""],
    ["an unknown package manager", "deno/2.4.0 npm/? node/v24.0.0 linux x64"],
    ["a name that only contains a blocked prefix later", "npm/11.0.0 pnpm/12.0.0"],
  ])("allows %s silently", (_description, userAgent) => {
    expect(decidePublishGuard(userAgent)).toEqual({ allowed: true, packageManager: null, message: null, exitCode: GUARD_PUBLISH_EXIT_CODE.allowed });
  });

  it("reads the user agent from the given environment", () => {
    expect(decidePublishGuardForEnvironment({ [PACKAGE_MANAGER_USER_AGENT_VARIABLE]: PNPM_USER_AGENT }).allowed).toBe(false);
    expect(decidePublishGuardForEnvironment({}).allowed).toBe(true);
  });
});

describe("beez-rp guard-publish", () => {
  it("fails with the explanation on stderr under pnpm", () => {
    const result = runGuardCli(PNPM_USER_AGENT);

    expect(result.status).toBe(GUARD_PUBLISH_EXIT_CODE.blocked);
    expect(result.stderr).toContain("no publiques con pnpm");
    expect(result.stdout).toBe("");
  });

  it.each([
    ["npm", NPM_USER_AGENT],
    ["no user agent", undefined],
  ])("exits with 0 without output under %s", (_description, userAgent) => {
    const result = runGuardCli(userAgent);

    expect(result.status).toBe(GUARD_PUBLISH_EXIT_CODE.allowed);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("npm publish with the guard as prepublishOnly", () => {
  it(
    "passes when npm publishes on its own",
    () => {
      const result = runNpmPublishDryRun(createGuardedPackageFixture(), createEnvironmentWithUserAgent(undefined));

      expect(result.status, result.stderr).toBe(0);
    },
    NPM_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the pnpm user agent npm inherits, so the guard blocks it unless create-version removes it",
    () => {
      const packageRoot = createGuardedPackageFixture();
      const pnpmEnvironment = createEnvironmentWithUserAgent(PNPM_USER_AGENT);

      const inherited = runNpmPublishDryRun(packageRoot, pnpmEnvironment);
      expect(inherited.status).not.toBe(0);
      expect(inherited.stderr).toContain("no publiques con pnpm");

      const published = runNpmPublishDryRun(packageRoot, buildNpmPublishEnvironment(pnpmEnvironment));
      expect(published.status, published.stderr).toBe(0);
    },
    NPM_FIXTURE_TEST_TIMEOUT_MS,
  );
});

describe("buildNpmPublishEnvironment", () => {
  it("drops only the inherited package manager user agent", () => {
    const environment = { PATH: "/usr/bin", NPM_TOKEN: "token", [PACKAGE_MANAGER_USER_AGENT_VARIABLE]: PNPM_USER_AGENT };

    expect(buildNpmPublishEnvironment(environment)).toEqual({ PATH: "/usr/bin", NPM_TOKEN: "token" });
    expect(environment[PACKAGE_MANAGER_USER_AGENT_VARIABLE]).toBe(PNPM_USER_AGENT);
  });

  it("drops the user agent whatever its casing, since npm reads config variables in any case", () => {
    expect(buildNpmPublishEnvironment({ PATH: "/usr/bin", NPM_CONFIG_USER_AGENT: PNPM_USER_AGENT, Npm_Config_User_Agent: PNPM_USER_AGENT })).toEqual({
      PATH: "/usr/bin",
    });
  });
});
