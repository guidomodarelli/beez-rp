import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_PROJECT_COMMANDS, describeProjectCommands, detectPackageManager, parsePackageManagerField } from "../src/package-manager.js";

/** @type {string[]} */
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {Record<string, string>} files - File name → content.
 * @returns {string} Temporary project root holding the files.
 */
function createProject(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "beez-rp-package-manager-"));
  temporaryDirectories.push(root);
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(path.join(root, fileName), content);
  }
  return root;
}

describe("parsePackageManagerField", () => {
  it.each([
    ["bun@1.3.11", "bun"],
    ["pnpm@12.6.0+sha512.abc", "pnpm"],
    ["yarn@4.9.2", "yarn"],
    ["npm@11.0.0", "npm"],
  ])("reads %s as %s", (value, packageManager) => {
    expect(parsePackageManagerField(value)).toBe(packageManager);
  });

  it.each([undefined, 42, "", "deno@2.0.0", "bun"])("ignores %j", (value) => {
    expect(parsePackageManagerField(value)).toBeNull();
  });
});

describe("detectPackageManager", () => {
  it("prefers the packageManager field over any lockfile", () => {
    const root = createProject({ "package.json": JSON.stringify({ packageManager: "bun@1.3.11" }), "pnpm-lock.yaml": "" });

    expect(detectPackageManager(root)).toBe("bun");
  });

  it.each([
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ])("falls back to the %s lockfile", (lockfile, packageManager) => {
    const root = createProject({ "package.json": JSON.stringify({ name: "app" }), [lockfile]: "" });

    expect(detectPackageManager(root)).toBe(packageManager);
  });

  it("defaults to pnpm without a declaration nor a lockfile, and with an unreadable manifest", () => {
    expect(detectPackageManager(createProject({ "package.json": "{}" }))).toBe("pnpm");
    expect(detectPackageManager(createProject({ "package.json": "not json" }))).toBe("pnpm");
  });
});

describe("describeProjectCommands", () => {
  it.each([
    ["pnpm", "pnpm run ci", "pnpm create-version"],
    ["yarn", "yarn run ci", "yarn create-version"],
    ["npm", "npm run ci", "npm run create-version"],
    // `bun create-version` would run `bun create`.
    ["bun", "bun run ci", "bun run create-version"],
  ])("builds the %s commands", (packageManager, ciCommand, createVersionCommand) => {
    const commands = describeProjectCommands(/** @type {import("../src/package-manager.js").PackageManagerName} */ (packageManager));

    expect(commands.runScript("ci")).toBe(ciCommand);
    expect(commands.createVersion).toBe(createVersionCommand);
  });

  it("defaults to the pnpm commands", () => {
    expect(DEFAULT_PROJECT_COMMANDS.createVersion).toBe("pnpm create-version");
  });
});
