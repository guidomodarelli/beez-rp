/**
 * Exercises provider releases and reconciliation through the real CLI, Git and npm HTTP protocol.
 *
 * @module tests/create-version/registry-integration
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startFixtureNpmRegistry } from "./support/fixture-npm-registry.js";
import { cleanupTemporaryDirectories, createTemporaryDirectory, flattenOutput, GIT_FIXTURE_TEST_TIMEOUT_MS, runCliAsync, runGit } from "./support/cli-harness.js";

/** Registries opened by a scenario. */
const registries = /** @type {Awaited<ReturnType<typeof startFixtureNpmRegistry>>[]} */ ([]);
/** Native JSR HTTP fixtures. */
const jsrServers = /** @type {import("node:http").Server[]} */ ([]);

afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.close();
  for (const server of jsrServers.splice(0)) await new Promise((resolve) => { server.close(() => resolve(undefined)); server.closeAllConnections(); });
  cleanupTemporaryDirectories();
});

/**
 * Creates a tagged release and one feature with manually updated notes.
 *
 * @param {"github" | "gitlab" | "jsr"} provider - Destination.
 * @param {string} registryUrl - Local endpoint.
 * @returns {{ root: string, remote: string, manualNotes: string }} Checkout and bare origin.
 */
function createProviderProject(provider, registryUrl) {
  const parent = createTemporaryDirectory("beez-rp-provider-flow-");
  const remote = path.join(parent, "origin.git");
  const root = path.join(parent, "work");
  runGit(["init", "--quiet", "--bare", "--initial-branch=main", remote], parent);
  runGit(["clone", "--quiet", remote, root], parent);
  runGit(["config", "user.email", "fixture@example.test"], root);
  runGit(["config", "user.name", "Fixture"], root);
  runGit(["config", "commit.gpgsign", "false"], root);
  runGit(["config", "tag.gpgsign", "false"], root);
  runGit(["config", "core.autocrlf", "false"], root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@acme/pkg", version: "1.0.0", type: "module", license: "MIT", files: ["index.js", "CHANGELOG.md"] }));
  writeFileSync(path.join(root, "CHANGELOG.md"), "# Mis notas\n\n## 1.0.0\n\n- Inicial.\n");
  writeFileSync(path.join(root, "index.js"), "export const value = 1;\n");
  writeFileSync(path.join(root, ".gitignore"), ".env\n");
  const publication = provider === "jsr" ? { registryUrl, tokenEnv: "PACKAGE_RELEASE_TOKEN", authentication: "token", jsrClient: "deno" } : { registryUrl, tokenEnv: "PACKAGE_RELEASE_TOKEN", access: "restricted", tag: "next" };
  writeFileSync(path.join(root, "beez-rp.config.js"), `export default ${JSON.stringify({ checks: false, publish: provider, publication })};\n`);
  if (provider === "jsr") writeFileSync(path.join(root, "jsr.json"), JSON.stringify({ name: "@acme/native", version: "1.0.0", license: "MIT", exports: "./index.js" }));
  runGit(["add", "-A"], root);
  runGit(["commit", "--quiet", "-m", "1.0.0"], root);
  runGit(["tag", "-a", "v1.0.0", "-m", "1.0.0"], root);
  const manualNotes = "# Mis notas\n\n## Próxima entrega\n\n- Valor nuevo, escrito a mano.\n";
  writeFileSync(path.join(root, "CHANGELOG.md"), manualNotes);
  writeFileSync(path.join(root, "index.js"), "export const value = 2;\n");
  runGit(["add", "-A"], root);
  runGit(["commit", "--quiet", "-m", "feat: change the value"], root);
  runGit(["push", "--quiet", "origin", "main", "--tags"], root);
  writeFileSync(path.join(root, ".env"), "PACKAGE_RELEASE_TOKEN=fixture-provider-token\n");
  return { root, remote, manualNotes };
}

describe("single destination provider release", () => {
  it.each(["github", "gitlab"])("should release once to %s with independent credentials and preserve manual notes", async (providerName) => {
    // Arrange
    const provider = /** @type {"github" | "gitlab"} */ (providerName);
    const registry = await startFixtureNpmRegistry({
      users: { "fixture-provider-token": "fixture-owner" },
      packages: { "@acme/pkg": { maintainers: ["fixture-owner"], versions: ["1.0.0"] } },
      basePath: provider === "gitlab" ? "api/v4/projects/123/packages/npm/" : "",
      unsupportedPermissionChecks: true,
    });
    registries.push(registry);
    const { root, remote, manualNotes } = createProviderProject(provider, registry.registryUrl);
    // Act
    const released = await runCliAsync(root, ["--bump", "minor"]);
    const repeated = await runCliAsync(root, ["--dry-run"]);
    // Assert
    expect(released.status, released.output).toBe(0);
    expect(registry.publications).toEqual([{ packageName: "@acme/pkg", version: "1.1.0", user: "fixture-owner" }]);
    expect(registry.requests.some((request) => request.path === "-/whoami" || request.command === "owner")).toBe(false);
    expect(flattenOutput(released.output)).toContain("no verificable");
    expect(released.output).not.toContain("fixture-provider-token");
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(manualNotes);
    expect(runGit(["show", "main:CHANGELOG.md"], remote)).toBe(manualNotes.trimEnd());
    expect(JSON.parse(runGit(["show", "main:package.json"], remote)).version).toBe("1.1.0");
    expect(repeated.status, repeated.output).toBe(0);
    expect(repeated.output).toContain("Todo al día");
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should reconcile an accepted publication after the client reports a failed response without repeating the PUT", async () => {
    // Arrange
    const registry = await startFixtureNpmRegistry({
      users: { "fixture-provider-token": "fixture-owner" },
      packages: { "@acme/pkg": { maintainers: ["fixture-owner"], versions: ["1.0.0"] } },
      basePath: "api/v4/projects/123/packages/npm/",
      unsupportedPermissionChecks: true,
      failAfterPublishing: true,
    });
    registries.push(registry);
    const { root, manualNotes } = createProviderProject("gitlab", registry.registryUrl);
    // Act
    const released = await runCliAsync(root, ["--bump", "minor"]);
    const repeated = await runCliAsync(root, ["--dry-run"]);
    // Assert
    expect(released.status, released.output).toBe(0);
    expect(registry.publications).toHaveLength(1);
    expect(repeated.status, repeated.output).toBe(0);
    expect(repeated.output).toContain("Todo al día");
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(manualNotes);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should pin scope routing for lookup and publication when project npmrc points at a different registry", async () => {
    // Arrange
    const options = { users: { "fixture-provider-token": "fixture-owner" }, packages: { "@acme/pkg": { maintainers: ["fixture-owner"], versions: ["1.0.0"] } }, unsupportedPermissionChecks: true };
    const other = await startFixtureNpmRegistry(options);
    const selected = await startFixtureNpmRegistry(options);
    registries.push(other, selected);
    const { root, manualNotes } = createProviderProject("github", selected.registryUrl);
    writeFileSync(path.join(root, ".npmrc"), `@acme:registry=${other.registryUrl}\n`);
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    manifest.publishConfig = { "@acme:registry": other.registryUrl };
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    runGit(["add", ".npmrc", "package.json"], root);
    runGit(["commit", "--quiet", "-m", "chore: configure installation routing"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    // Act
    const released = await runCliAsync(root, ["--bump", "minor"]);
    // Assert
    expect(released.status, released.output).toBe(0);
    expect(selected.publications).toEqual([{ packageName: "@acme/pkg", version: "1.1.0", user: "fixture-owner" }]);
    expect(other.publications).toEqual([]);
    expect(other.requests).toEqual([]);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(manualNotes);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should pin legacy npm scope routing to publishConfig even without publication.registryUrl", async () => {
    // Arrange
    const options = { users: { "fixture-provider-token": "fixture-owner" }, packages: { "@acme/pkg": { maintainers: ["fixture-owner"], versions: ["1.0.0"] } } };
    const other = await startFixtureNpmRegistry(options);
    const selected = await startFixtureNpmRegistry(options);
    registries.push(other, selected);
    const { root, manualNotes } = createProviderProject("github", selected.registryUrl);
    writeFileSync(path.join(root, "beez-rp.config.js"), 'export default { checks: false, publish: "npm", publication: { tokenEnv: "PACKAGE_RELEASE_TOKEN" } };\n');
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    manifest.publishConfig = { "@acme:registry": selected.registryUrl };
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(path.join(root, ".npmrc"), `@acme:registry=${other.registryUrl}\n`);
    runGit(["add", "-A"], root);
    runGit(["commit", "--quiet", "-m", "chore: configure legacy routing"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    // Act
    const released = await runCliAsync(root, ["--bump", "minor"]);
    // Assert
    expect(released.status, released.output).toBe(0);
    expect(selected.publications).toHaveLength(1);
    expect(other.requests).toEqual([]);
    expect(other.publications).toEqual([]);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(manualNotes);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([true, false])("should confirm JSR publication and resume an unconfirmed client success when it uploads: %j", async (uploadsInitially) => {
    // Arrange: the external client boundary uses a local HTTP registry; the real official client was validated in dry-run.
    const versions = ["1.0.0"];
    const uploads = /** @type {string[]} */ ([]);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture.test");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "POST") {
        const version = url.searchParams.get("version");
        versions.push(version ?? "");
        uploads.push(version ?? "");
      }
      response.end(JSON.stringify({ versions: Object.fromEntries(versions.map((version) => [version, {}])) }));
    });
    jsrServers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    const { root, remote, manualNotes } = createProviderProject("jsr", `http://127.0.0.1:${address.port}/`);
    const bin = path.join(createTemporaryDirectory("beez-rp-jsr-client-"), "bin");
    mkdirSync(bin);
    const clientPath = path.join(bin, "fixture-deno.mjs");
    writeFileSync(clientPath, [
      'import { readFileSync } from "node:fs";',
      'const args = process.argv.slice(2);',
      'const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8"));',
      'const token = args[args.indexOf("--token") + 1];',
      'process.stderr.write("Client command: --token " + token.slice(0, 8));',
      'await new Promise((resolve) => setTimeout(resolve, 10));',
      'process.stderr.write(token.slice(8) + "\\n");',
      'if (process.env.BEEZ_FIXTURE_SKIP_UPLOAD !== "1") await fetch(new URL("publish?version=" + config.version, process.env.JSR_URL), { method: "POST" });',
      '',
    ].join("\n"));
    if (process.platform === "win32") writeFileSync(path.join(bin, "deno.cmd"), `@"${process.execPath}" "%~dp0fixture-deno.mjs" %*\r\n`);
    else writeFileSync(path.join(bin, "deno"), `#!/bin/sh\nexec '${process.execPath}' '${clientPath}' "$@"\n`, { mode: 0o755 });
    const environment = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, BEEZ_FIXTURE_SKIP_UPLOAD: uploadsInitially ? "0" : "1" };
    // Act
    const released = await runCliAsync(root, ["--bump", "minor"], environment);
    // Assert
    expect(released.status, released.output).toBe(uploadsInitially ? 0 : 1);
    expect(uploads).toEqual(uploadsInitially ? ["1.1.0"] : []);
    expect(released.output).not.toContain("fixture-provider-token");
    expect(released.output).toContain("[redactado]");
    expect(flattenOutput(released.output)).toContain(uploadsInitially ? "Client command: --token [redactado]" : "El cliente de JSR terminó con código 0, pero no se confirmó @acme/native@1.1.0 en la metadata");
    expect(JSON.parse(runGit(["show", "main:jsr.json"], remote)).version).toBe("1.1.0");
    expect(JSON.parse(runGit(["show", "main:package.json"], remote)).version).toBe("1.1.0");
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(manualNotes);
    const resumed = await runCliAsync(root, ["--bump", "major"], { ...environment, BEEZ_FIXTURE_SKIP_UPLOAD: "0" });
    expect(resumed.status, resumed.output).toBe(0);
    expect(uploads).toEqual(["1.1.0"]);
    const repeated = await runCliAsync(root, ["--dry-run"], environment);
    expect(repeated.status, repeated.output).toBe(0);
    expect(repeated.output).toContain("Todo al día");
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);
});
