/**
 * Exercises registry selection, direct metadata, native manifests and credential policies with real IO.
 *
 * @module tests/create-version/registry
 */

import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveCreateVersionConfig } from "../../src/create-version/config.js";
import { checkRegistryAccess, lookupRegistryVersions, resolveRegistry, selectProjectRegistry } from "../../src/create-version/registry.js";
import { prepareJsrVersionUpdates } from "../../src/create-version/jsr.js";
import { normalizeJsonc, parseJsoncManifest } from "../../src/create-version/jsonc.js";
import { createGitReader } from "../../src/create-version/process.js";
import { DEFAULT_PROJECT_COMMANDS } from "../../src/package-manager.js";
import { describeNpmAuthProblem } from "../../src/create-version/npm-auth.js";
import { cleanupTemporaryDirectories, createTemporaryDirectory, runGit } from "./support/cli-harness.js";

/** External HTTP fixtures closed after each scenario. */
const servers = /** @type {import("node:http").Server[]} */ ([]);

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(() => resolve(undefined)));
  cleanupTemporaryDirectories();
});

/**
 * Starts a metadata endpoint whose requests are visible to the test.
 *
 * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void} handler - External provider behavior.
 * @returns {Promise<string>} Fixture origin.
 */
async function startRegistry(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return `http://127.0.0.1:${address.port}/`;
}

/**
 * Creates a selected provider using the real configuration boundary.
 *
 * @param {"npm" | "github" | "gitlab" | "jsr"} provider - Project registry.
 * @param {import("../../src/create-version/registry-config.js").PublicationOptions} [publication] - Provider options.
 * @returns {import("../../src/create-version/registry.js").RegistrySelection} Resolved selection.
 */
function selection(provider, publication = {}) {
  return selectProjectRegistry(resolveCreateVersionConfig({ publish: provider, publication }));
}

describe("one-registry configuration", () => {
  it("should name the configured credential variable when a token is rejected or shadowed by project config", () => {
    // Arrange
    const base = { user: null, source: "environment", registryUrl: "https://registry.npmjs.org/", packageName: "@acme/pkg", owners: [], firstPublication: false, reason: null, tokenVariable: "NPM_PUBLISH_TOKEN" };
    // Act
    const invalid = describeNpmAuthProblem({ ...base, status: "invalid-token" });
    const shadowed = describeNpmAuthProblem({ ...base, status: "project-credentials" });
    // Assert
    expect(invalid?.title).toContain("NPM_PUBLISH_TOKEN");
    expect(shadowed?.title).toContain("NPM_PUBLISH_TOKEN");
    expect(shadowed?.details.join(" ")).toContain("beez-rp usa NPM_PUBLISH_TOKEN");
  });

  it.each(["npm", "github", "gitlab", "jsr"])("should select %s as the only monitored and published registry", (provider) => {
    // Arrange and Act
    const config = resolveCreateVersionConfig({ publish: /** @type {"npm" | "github" | "gitlab" | "jsr"} */ (provider) });
    // Assert
    expect(config.registry).toBe(provider);
    expect(selectProjectRegistry(config).provider).toBe(provider);
  });

  it("should preserve npm defaults and allow private access, a custom tag and an independent token variable", () => {
    // Arrange and Act
    const legacy = resolveCreateVersionConfig({ publish: "npm" });
    const configured = resolveCreateVersionConfig({ publish: "github", publication: { tokenEnv: "PACKAGES_TOKEN", access: "restricted", tag: "next" } });
    // Assert
    expect(legacy.publication).toMatchObject({ authentication: "token", tokenEnv: "NPM_TOKEN", access: "public", tag: "latest" });
    expect(configured.publication).toMatchObject({ tokenEnv: "PACKAGES_TOKEN", access: "restricted", tag: "next" });
  });

  it.each([
    { publish: "github", registry: "gitlab" },
    { publish: ["npm", "github"] },
    { publish: "gitlab", publication: { authentication: "oidc" } },
    { publish: "jsr", publication: { access: "restricted" } },
    { publish: "jsr", publication: { tag: "next" } },
    { publish: "jsr", artifact: "releases/{version}.tgz" },
    { publish: "jsr", publication: { configFile: "../jsr.json" } },
    { publish: "jsr", publication: { configFile: "CHANGELOG.md" } },
    { publish: "npm", publication: { tokenEnv: "TOKEN&command" } },
    { publish: "npm", publication: { tag: "latest;command" } },
  ])("should reject incompatible or unsafe configuration: %j", (config) => {
    // Act and Assert
    expect(() => resolveCreateVersionConfig(config)).toThrow(/beez-rp create-version/u);
  });

  it("should require a GitHub scope and a GitLab project publishing endpoint", async () => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-registry-config-");
    // Act and Assert
    await expect(resolveRegistry(selection("github"), { name: "unscoped" }, root)).rejects.toThrow("requiere name con scope");
    await expect(resolveRegistry(selection("gitlab", { registryUrl: "https://gitlab.example.test/api/v4/packages/npm/" }), { name: "@acme/pkg" }, root)).rejects.toThrow("endpoint /api/v4/projects");
  });
});

describe("direct registry metadata and permissions", () => {
  it.each([true, false])("should classify a GitLab 404 safely when the lookup is authenticated: %j", async (authenticated) => {
    // Arrange
    const origin = await startRegistry((_request, response) => { response.writeHead(404); response.end(); });
    const root = createTemporaryDirectory("beez-rp-gitlab-private-");
    if (authenticated) writeFileSync(path.join(root, ".env"), "BEEZ_FIXTURE_READ_TOKEN=fixture-read-token\n");
    // Act
    const lookup = await lookupRegistryVersions(selection("gitlab", { registryUrl: `${origin}api/v4/projects/123/packages/npm/`, tokenEnv: "BEEZ_FIXTURE_READ_TOKEN" }), { name: "@acme/pkg" }, root);
    // Assert
    expect(lookup.status).toBe(authenticated ? "ok" : "failed");
    expect(lookup.publishedVersions).toEqual([]);
    expect(lookup.reason).toBe(authenticated ? null : "GitLab: HTTP 404 sin BEEZ_FIXTURE_READ_TOKEN; no se puede distinguir un paquete ausente de un proyecto privado. Definí la credencial antes de diagnosticar.");
  });

  it("should query the GitLab project with its configured token and leave write access unverified", async () => {
    // Arrange
    const requests = /** @type {{ url: string, authorization: string | undefined }[]} */ ([]);
    const origin = await startRegistry((request, response) => {
      requests.push({ url: request.url ?? "", authorization: request.headers.authorization });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ versions: { "1.0.0": {}, "1.1.0": {} }, "dist-tags": { next: "1.1.0", latest: "1.0.0" } }));
    });
    const root = createTemporaryDirectory("beez-rp-gitlab-metadata-");
    writeFileSync(path.join(root, ".env"), "CI_JOB_TOKEN=fixture-job-token\n");
    const registry = selection("gitlab", { registryUrl: `${origin}api/v4/projects/123/packages/npm/`, tokenEnv: "CI_JOB_TOKEN", tag: "next" });
    // Act
    const lookup = await lookupRegistryVersions(registry, { name: "@acme/pkg" }, root);
    const access = await checkRegistryAccess(registry, { name: "@acme/pkg" }, root);
    // Assert
    expect(lookup).toMatchObject({ status: "ok", publishedVersions: ["1.0.0", "1.1.0"], latestVersion: "1.1.0", registryLabel: "GitLab", tag: "next" });
    expect(requests).toEqual([{ url: "/api/v4/projects/123/packages/npm/%40acme%2Fpkg", authorization: "Bearer fixture-job-token" }]);
    expect(access).toMatchObject({ status: "unknown", source: "repository", tokenVariable: "CI_JOB_TOKEN" });
    expect(access.reason).toContain("no se ejecutan npm whoami ni npm owner ls");
  });

  it("should treat GitLab forwarding as absent locally without fetching npmjs", async () => {
    // Arrange
    let requests = 0;
    const origin = await startRegistry((_request, response) => {
      requests += 1;
      response.writeHead(302, { Location: "https://registry.npmjs.org/@acme/pkg" });
      response.end();
    });
    const root = createTemporaryDirectory("beez-rp-gitlab-forwarding-");
    // Act
    const lookup = await lookupRegistryVersions(selection("gitlab", { registryUrl: `${origin}api/v4/projects/123/packages/npm/` }), { name: "@acme/pkg" }, root);
    // Assert
    expect(lookup).toMatchObject({ status: "ok", publishedVersions: [] });
    expect(requests).toBe(1);
  });

  it("should report upstream rejection without copying its body or accusing the token of expiry", async () => {
    // Arrange
    const origin = await startRegistry((_request, response) => {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token: "fixture-secret", stack: "upstream-stack", error: "timeout" }));
    });
    const root = createTemporaryDirectory("beez-rp-registry-rejection-");
    // Act
    const lookup = await lookupRegistryVersions(selection("gitlab", { registryUrl: `${origin}api/v4/projects/123/packages/npm/` }), { name: "@acme/pkg" }, root);
    // Assert
    expect(lookup.status).toBe("failed");
    expect(lookup.reason).toContain("HTTP 403");
    expect(lookup.reason).not.toMatch(/fixture-secret|upstream-stack|venció|inválido/u);
  });

  it("should read the native JSR version map under its own scoped manifest name", async () => {
    // Arrange
    const requests = /** @type {string[]} */ ([]);
    const origin = await startRegistry((request, response) => {
      requests.push(request.url ?? "");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ versions: { "1.0.0": {}, "1.1.0": {} } }));
    });
    const root = createTemporaryDirectory("beez-rp-jsr-metadata-");
    writeFileSync(path.join(root, "jsr.json"), JSON.stringify({ name: "@acme/native", version: "1.0.0", exports: "./mod.ts" }));
    // Act
    const lookup = await lookupRegistryVersions(selection("jsr", { registryUrl: origin }), { name: "node-package" }, root);
    // Assert
    expect(lookup).toMatchObject({ status: "ok", publishedVersions: ["1.0.0", "1.1.0"], latestVersion: "1.1.0", registryLabel: "JSR" });
    expect(requests).toEqual(["/@acme/native/meta.json"]);
  });
});

describe("native JSR version files", () => {
  it("should prepare a version-only JSONC edit while preserving comments, Unicode, URLs and original files", async () => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-jsr-version-");
    runGit(["init", "--quiet", "--initial-branch=main"], root);
    runGit(["config", "user.email", "fixture@example.test"], root);
    runGit(["config", "user.name", "Fixture"], root);
    runGit(["config", "commit.gpgsign", "false"], root);
    const content = '// 😀 notas manuales\n{\n  "name": "@acme/native",\n  "version" /* comentario */: "1.0.0",\n  "exports": "./mod.ts",\n  "url": "https://example.test/path//segment",\n}\n';
    writeFileSync(path.join(root, "jsr.jsonc"), content);
    runGit(["add", "jsr.jsonc"], root);
    runGit(["commit", "--quiet", "-m", "feat: native manifest"], root);
    const options = selection("jsr").options;
    // Act
    const updates = await prepareJsrVersionUpdates({ repositoryRoot: root, reader: createGitReader(root), commands: DEFAULT_PROJECT_COMMANDS }, root, options, "1.1.0");
    // Assert
    expect(updates).toHaveLength(1);
    expect(parseJsoncManifest(updates[0].content)).toMatchObject({ name: "@acme/native", version: "1.1.0", url: "https://example.test/path//segment" });
    expect(updates[0].content).toBe(content.replace('"1.0.0"', '"1.1.0"'));
    expect(readFileSync(path.join(root, "jsr.jsonc"), "utf8")).toBe(content);
    expect(runGit(["status", "--porcelain"], root)).toBe("");
    expect(normalizeJsonc(content)).toHaveLength(content.length);
  });
});
