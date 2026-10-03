/**
 * Exercises real Git releases while isolating only the external GitHub workflow adapter.
 * No Actions jobs or real package publications are started by these fixtures.
 * @module tests/create-version/ci
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCreateVersionConfig } from "../../src/create-version/config.js";
import { assertCiCompatiblePublication, chooseReleaseExecution } from "../../src/create-version/ci.js";
import { CiReleaseError } from "../../src/create-version/errors.js";
import * as githubWorkflow from "../../src/create-version/github-workflow.js";
import { parseReleaseArguments } from "../../src/create-version/plan.js";
import { runCreateVersion } from "../../src/create-version/run.js";
import { describeCiEnvironment, prepareCiSetupFiles, renderCiReleaseWorkflow } from "../../src/create-version/ci-setup.js";
import { GIT_FIXTURE_TEST_TIMEOUT_MS, cleanupTemporaryDirectories, commandEnvironment, createTemporaryDirectory, flattenOutput, runCliAsync, runGit } from "./support/cli-harness.js";
import { startFixtureNpmRegistry } from "./support/fixture-npm-registry.js";

/**
 * Creates a real checkout and a bare origin with one unreleased feature.
 * @param {{ configured?: boolean, failChecks?: boolean, updateChangelog?: boolean, declaredNullCi?: boolean }} [options] - Fixture behavior.
 * @returns {{ root: string, remote: string, originalSha: string }} Isolated release repository.
 */
function createCiProject({ configured = true, failChecks = false, updateChangelog = true, declaredNullCi = false } = {}) {
  const fixture = createTemporaryDirectory("beez-rp-ci-");
  const root = path.join(fixture, "work");
  const remote = path.join(fixture, "origin.git");
  runGit(["init", "--quiet", "--bare", "--initial-branch=main", remote], fixture);
  runGit(["clone", "--quiet", remote, root], fixture);
  for (const [name, value] of [["user.name", "Release Fixture"], ["user.email", "release@example.test"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"], ["core.autocrlf", "false"]]) runGit(["config", name, value], root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-ci-app", version: "1.2.3", type: "module", packageManager: "npm@11.11.1", scripts: { "create-version": "beez-rp create-version" } }));
  writeFileSync(path.join(root, ".gitignore"), "*.log\nnode_modules\n");
  writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n- Primera versión.\n");
  writeFileSync(path.join(root, "checks.mjs"), `import { appendFileSync } from 'node:fs'; appendFileSync('release.log', 'checks\\n'); ${failChecks ? "process.exitCode = 1;" : ""}\n`);
  writeFileSync(path.join(root, "beez-rp.config.mjs"), [
    "import { appendFileSync } from 'node:fs'; import { join } from 'node:path';",
    "export default {",
    "  checks: ['node checks.mjs'],",
    "  prepare: ({ version, repositoryRoot }) => appendFileSync(join(repositoryRoot, 'release.log'), `prepare:${version}\\n`),",
    "  publish: ({ version, repositoryRoot }) => appendFileSync(join(repositoryRoot, 'release.log'), `publish:${version}\\n`),",
    ...(configured ? ["  ci: { workflow: 'release.yml' },"] : declaredNullCi ? ["  ci: null,"] : []),
    "};", "",
  ].join("\n"));
  if (configured) {
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(path.join(root, ".github/workflows/release.yml"), renderCiReleaseWorkflow(root, resolveCreateVersionConfig({ checks: ["node checks.mjs"], ci: { workflow: "release.yml" } })));
  }
  runGit(["add", "-A"], root);
  runGit(["commit", "--quiet", "-m", "1.2.3"], root);
  runGit(["tag", "-a", "v1.2.3", "-m", "1.2.3"], root);
  writeFileSync(path.join(root, "feature.txt"), "New feature\n");
  if (updateChangelog) writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n- Primera versión.\n- Nueva funcionalidad documentada manualmente.\n");
  runGit(["add", "-A"], root);
  runGit(["commit", "--quiet", "-m", "feat: add feature"], root);
  runGit(["push", "--quiet", "origin", "main", "--tags"], root);
  return { root, remote, originalSha: runGit(["rev-parse", "HEAD"], root) };
}

/**
 * Reads the environment names bound at job level and per step from a generated workflow.
 * Only the indentation layout produced by the release template is understood.
 * @param {string} workflow - Generated GitHub Actions YAML.
 * @returns {{ jobEnvironment: string[], stepEnvironments: Map<string, string[]> }} Bound names by scope.
 */
function readWorkflowEnvironmentScopes(workflow) {
  const jobEnvironment = [];
  const stepEnvironments = new Map();
  let scope = null;
  let currentStep = null;
  for (const line of workflow.split("\n")) {
    const stepName = /^ {6}- name: (.+)$/u.exec(line)?.[1];
    if (stepName) { currentStep = stepName; stepEnvironments.set(stepName, []); scope = null; continue; }
    if (line === "    env:") { scope = "job"; continue; }
    if (line === "        env:" && currentStep) { scope = "step"; continue; }
    const jobBinding = /^ {6}([A-Z][A-Z0-9_]*):/u.exec(line)?.[1];
    const stepBinding = /^ {10}([A-Z][A-Z0-9_]*):/u.exec(line)?.[1];
    if (scope === "job" && jobBinding) jobEnvironment.push(jobBinding);
    else if (scope === "step" && stepBinding && currentStep) stepEnvironments.get(currentStep)?.push(stepBinding);
    else scope = null;
  }
  return { jobEnvironment, stepEnvironments };
}

/**
 * Isolates the project's GitHub boundary; Git, configuration, checks and hooks remain real.
 * @returns {import("../../src/create-version/github-workflow.js").GithubWorkflowClient} Controlled external client.
 */
function isolateGithub() {
  const client = {
    preflight: vi.fn(async () => {}),
    dispatch: vi.fn(async () => ({ status: /** @type {const} */ ("submitted"), url: "https://github.com/fixture/app/actions" })),
  };
  vi.spyOn(githubWorkflow, "createGithubWorkflowClient").mockReturnValue(client);
  return client;
}

/**
 * Runs the generated Vercel ignore command the way Vercel does: from the checkout root, before installing dependencies.
 * @param {string} checkout - Deployed checkout.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} Exit status 0 skips the build; any other status builds.
 */
function runVercelGate(checkout) {
  return spawnSync(process.execPath, [".beez-rp/vercel-ignore-build.mjs"], { cwd: checkout, encoding: "utf8", env: commandEnvironment() });
}

beforeEach(() => {
  vi.stubEnv("CI", "false");
  vi.stubEnv("GITHUB_ACTIONS", "false");
  vi.stubEnv("GITLAB_CI", "false");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanupTemporaryDirectories();
});

describe("release location and configuration", () => {
  it("should use the built-in GitHub credential for private dependencies without requiring a stored repository secret", () => {
    // Arrange
    const config = resolveCreateVersionConfig({ ci: { workflow: "release.yml", secrets: ["GITHUB_TOKEN", "API_TOKEN"] } });
    // Act and Assert
    expect(describeCiEnvironment(config)).toEqual({ secrets: ["API_TOKEN"], variables: [], githubToken: true, githubTokenWrite: false, deploymentSecrets: [] });
    expect(describeCiEnvironment(resolveCreateVersionConfig({ publish: "npm", ci: { workflow: "release.yml", secrets: ["GITHUB_TOKEN"] } }))).toEqual({ secrets: ["NPM_TOKEN"], variables: [], githubToken: true, githubTokenWrite: false, deploymentSecrets: [] });
    expect(describeCiEnvironment(resolveCreateVersionConfig({ publish: "npm", publication: { registryUrl: "https://npm.pkg.github.com", tokenEnv: "GITHUB_TOKEN" }, ci: { workflow: "release.yml", secrets: ["GITHUB_TOKEN"] } }))).toEqual({ secrets: [], variables: [], githubToken: true, githubTokenWrite: true, deploymentSecrets: [] });
    expect(() => describeCiEnvironment(resolveCreateVersionConfig({ publish: "github", ci: { workflow: "release.yml", variables: ["GITHUB_TOKEN"] } }))).toThrow(/GITHUB_TOKEN/);
  });

  it("should bind Vercel credentials only to the Vercel steps while preflight still requires them", () => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-vercel-scope-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-vercel-app", version: "1.0.0", packageManager: "npm@11.11.1" }));
    const config = resolveCreateVersionConfig({ checks: ["node checks.mjs"], ci: { workflow: "release.yml", deployment: "vercel", secrets: ["DATABASE_URL"] } });
    const vercelSecrets = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"];
    // Act
    const environment = describeCiEnvironment(config);
    const { jobEnvironment, stepEnvironments } = readWorkflowEnvironmentScopes(renderCiReleaseWorkflow(root, config));
    // Assert
    expect(environment.secrets).toEqual(["DATABASE_URL", ...vercelSecrets]);
    expect(jobEnvironment).toContain("DATABASE_URL");
    for (const name of vercelSecrets) expect(jobEnvironment).not.toContain(name);
    const stepsWithVercelCredentials = [...stepEnvironments].filter(([, names]) => vercelSecrets.some((name) => names.includes(name)));
    expect(stepsWithVercelCredentials.length).toBe(3);
    for (const [, names] of stepsWithVercelCredentials) expect(names).toEqual(expect.arrayContaining(vercelSecrets));
    const unscopedSteps = [...stepEnvironments.keys()].filter((name) => !stepsWithVercelCredentials.some(([stepName]) => stepName === name));
    expect(unscopedSteps).toEqual(expect.arrayContaining(["Instalar dependencias", "Checks y publicación del release"]));
  });

  it("should keep explicitly declared Vercel credentials step-scoped and deduplicated", () => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-vercel-declared-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-vercel-app", version: "1.0.0", packageManager: "npm@11.11.1" }));
    const config = resolveCreateVersionConfig({ checks: ["node checks.mjs"], ci: { workflow: "release.yml", deployment: "vercel", secrets: ["VERCEL_TOKEN", "DATABASE_URL", "VERCEL_PROJECT_ID"] } });
    const vercelSecrets = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"];
    // Act
    const environment = describeCiEnvironment(config);
    const { jobEnvironment, stepEnvironments } = readWorkflowEnvironmentScopes(renderCiReleaseWorkflow(root, config));
    // Assert
    expect(environment.secrets).toEqual(["VERCEL_TOKEN", "DATABASE_URL", "VERCEL_PROJECT_ID", "VERCEL_ORG_ID"]);
    expect(environment.deploymentSecrets).toEqual(vercelSecrets);
    expect(jobEnvironment).toContain("DATABASE_URL");
    for (const name of vercelSecrets) expect(jobEnvironment).not.toContain(name);
    const stepsWithVercelCredentials = [...stepEnvironments].filter(([, names]) => vercelSecrets.some((name) => names.includes(name)));
    expect(stepsWithVercelCredentials.length).toBe(3);
    for (const [, names] of stepsWithVercelCredentials) expect(names).toEqual(vercelSecrets);
  });

  it.each(["--ci-release", "--retry-ci"])("should reject invalid tags at the CLI boundary when using %s", (flag) => {
    // Arrange and Act and Assert
    for (const value of ["", " ", "1.2.4", "v1.2.4-beta.1", "v1.2.4\n"]) expect(() => parseReleaseArguments([flag, value])).toThrow(/tag estable vX\.Y\.Z/);
  });

  it("should select CI automatically when a workflow is configured and preserve an explicit local choice", async () => {
    // Arrange
    const config = resolveCreateVersionConfig({ ci: { workflow: "release.yml" } });
    // Act and Assert
    expect(await chooseReleaseExecution(config, parseReleaseArguments(["--bump", "minor"]))).toEqual({ execution: "ci", setup: false });
    expect(await chooseReleaseExecution(config, parseReleaseArguments(["--local"]))).toEqual({ execution: "local", setup: false });
    vi.stubEnv("CI", "true");
    expect(await chooseReleaseExecution(config, parseReleaseArguments([]))).toEqual({ execution: "local", setup: false });
    await expect(chooseReleaseExecution(config, parseReleaseArguments(["--ci"]))).rejects.toThrow(/no puede disparar otro release/);
  });

  it("should reject conflicting CLI operations and unsafe CI settings", () => {
    // Arrange and Act and Assert
    for (const flags of [["--ci", "--local"], ["--local", "--setup-ci"], ["--ci-release", "v1.2.4", "--bump", "patch"], ["--retry-ci", "v1.2.4", "--ci-release", "v1.2.4"]]) expect(() => parseReleaseArguments(flags)).toThrow(/no se combin/);
    for (const ci of [{ workflow: "../release.yml" }, { workflow: "release.yml;whoami" }, { workflow: "release.yml", secrets: ["TOKEN", "TOKEN"] }, { workflow: "release.yml", secrets: ["TOKEN"], variables: ["TOKEN"] }]) expect(() => resolveCreateVersionConfig({ ci })).toThrow(/ci\./);
  });

  it("should keep CI unconfigured and fail an explicit CI request when setup has not been selected", async () => {
    // Arrange
    const config = resolveCreateVersionConfig({ checks: false });
    // Act and Assert
    expect(await chooseReleaseExecution(config, parseReleaseArguments([]))).toEqual({ execution: "local", setup: false });
    await expect(chooseReleaseExecution(config, parseReleaseArguments(["--ci"]))).rejects.toThrow(/No hay un workflow/);
  });
});

describe("local CI preparation with real Git", () => {
  it("should preserve an editor change made during preflight instead of replacing its configuration", async () => {
    // Arrange
    const { root, originalSha } = createCiProject({ configured: false });
    const github = isolateGithub();
    vi.mocked(github.preflight).mockImplementation(async () => {
      // Simulate an editor saving the config while the asynchronous preflight is in progress.
      writeFileSync(path.join(root, "beez-rp.config.mjs"), "export default { checks: false, projectName: 'New editor choice' };\n");
    });
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    // Assert
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(originalSha);
    expect(runGit(["diff", "--name-only", "HEAD"], root)).toBe("beez-rp.config.mjs");
    expect(existsSync(path.join(root, ".github/workflows/release.yml"))).toBe(false);
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should roll back setup and its staging without another tag when the release commit fails", async () => {
    // Arrange
    const { root, remote, originalSha } = createCiProject({ configured: false });
    runGit(["config", "user.name", ""], root);
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    // Assert
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(originalSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(originalSha);
    expect(runGit(["status", "--porcelain"], root)).toBe("");
    expect(runGit(["tag", "--list"], root)).toBe("v1.2.3");
    expect(existsSync(path.join(root, ".github/workflows/release.yml"))).toBe(false);
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should preserve uncommitted setup-owned files without creating a release when local changes are ignored", async () => {
    // Arrange
    const { root, remote } = createCiProject({ configured: false });
    writeFileSync(path.join(root, "vercel.json"), JSON.stringify({ ignoreCommand: "node -e \"process.exit(1)\"" }));
    writeFileSync(path.join(root, "beez-rp.config.mjs"), "export default { checks: ['node checks.mjs'] };\n");
    runGit(["add", "vercel.json", "beez-rp.config.mjs"], root);
    runGit(["commit", "--quiet", "-m", "chore: configure deployment"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    const originalSha = runGit(["rev-parse", "HEAD"], root);
    writeFileSync(path.join(root, ".gitignore"), "*.log\nnode_modules\ndraft/\n");
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch", "--ignore-local-changes"] });
    // Assert
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(originalSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(originalSha);
    expect(runGit(["diff", "--name-only", "HEAD"], root)).toBe(".gitignore");
    expect(runGit(["stash", "list"], root)).toBe("");
    expect(existsSync(path.join(root, ".github/workflows/release.yml"))).toBe(false);
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should block automatic Git deployment for a CI release and preserve the original local gate after Vercel setup", async () => {
    // Arrange
    const { root, remote } = createCiProject({ configured: false });
    writeFileSync(path.join(root, "vercel.json"), JSON.stringify({ ignoreCommand: "node -e \"process.exit(1)\"" }));
    writeFileSync(path.join(root, "beez-rp.config.mjs"), "export default { checks: ['node checks.mjs'] };\n");
    runGit(["add", "vercel.json", "beez-rp.config.mjs"], root);
    runGit(["commit", "--quiet", "-m", "chore: configure deployment"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    const ciGate = spawnSync(process.execPath, [".beez-rp/vercel-ignore-build.mjs"], { cwd: root, encoding: "utf8", env: commandEnvironment() });
    writeFileSync(path.join(root, ".beez-rp/release.json"), JSON.stringify({ version: "1.2.4", execution: "local" }));
    const localGate = spawnSync(process.execPath, [".beez-rp/vercel-ignore-build.mjs"], { cwd: root, encoding: "utf8", env: commandEnvironment() });
    // Assert
    expect(status).toBe(0);
    expect(ciGate.status, ciGate.stderr).toBe(0);
    expect(localGate.status, localGate.stderr).toBe(1);
    expect(JSON.parse(runGit(["show", "main:.beez-rp/release.json"], remote))).toEqual({ version: "1.2.4", execution: "ci" });
    expect(github.preflight).toHaveBeenCalledWith("release.yml", ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"], []);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    ["the original ignoreCommand", { ignoreCommand: "node -e \"process.exit(7)\"" }, 7],
    ["a normal build", {}, 1],
  ])("should skip only the delegated release commit and let later commits without a bump reach %s", async (_outcome, vercelConfig, laterCommitStatus) => {
    // Arrange
    const { root, remote } = createCiProject({ configured: false });
    writeFileSync(path.join(root, "vercel.json"), JSON.stringify(vercelConfig));
    writeFileSync(path.join(root, "beez-rp.config.mjs"), "export default { checks: ['node checks.mjs'] };\n");
    runGit(["add", "vercel.json", "beez-rp.config.mjs"], root);
    runGit(["commit", "--quiet", "-m", "chore: configure deployment"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    isolateGithub();
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    const shallowCheckout = path.join(createTemporaryDirectory("beez-rp-vercel-shallow-"), "checkout");
    runGit(["clone", "--quiet", "--depth", "1", pathToFileURL(remote).href, shallowCheckout], root);
    // Act
    const releaseGate = runVercelGate(root);
    const shallowReleaseGate = runVercelGate(shallowCheckout);
    writeFileSync(path.join(root, "feature.txt"), "Follow-up change without a version bump\n");
    runGit(["commit", "--quiet", "-am", "fix: follow-up change"], root);
    const laterCommitGate = runVercelGate(root);
    // Assert
    expect(status).toBe(0);
    expect(releaseGate.status, releaseGate.stderr).toBe(0);
    expect(shallowReleaseGate.status, shallowReleaseGate.stderr).toBe(laterCommitStatus);
    expect(JSON.parse(runGit(["show", "HEAD:.beez-rp/release.json"], root))).toEqual({ version: "1.2.4", execution: "ci" });
    expect(JSON.parse(runGit(["show", "HEAD:package.json"], root)).version).toBe("1.2.4");
    expect(laterCommitGate.status, laterCommitGate.stderr).toBe(laterCommitStatus);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([".env", ".vercel/project.json"])("should reject Vercel setup without creating a release when the worker would overwrite tracked %s", async (trackedPath) => {
    // Arrange
    const { root, remote } = createCiProject({ configured: false });
    writeFileSync(path.join(root, "vercel.json"), JSON.stringify({ ignoreCommand: "node -e \"process.exit(1)\"" }));
    writeFileSync(path.join(root, "beez-rp.config.mjs"), "export default { checks: ['node checks.mjs'] };\n");
    mkdirSync(path.dirname(path.join(root, trackedPath)), { recursive: true });
    writeFileSync(path.join(root, trackedPath), "PUBLIC_FLAG=committed\n");
    runGit(["add", "vercel.json", "beez-rp.config.mjs", trackedPath], root);
    runGit(["commit", "--quiet", "-m", "chore: configure deployment"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    const originalSha = runGit(["rev-parse", "HEAD"], root);
    const github = isolateGithub();
    const config = resolveCreateVersionConfig({ checks: ["node checks.mjs"], ci: { workflow: "release.yml", deployment: "vercel" } });
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    const directSetup = prepareCiSetupFiles(root, config);
    // Assert
    await expect(directSetup).rejects.toThrow(trackedPath);
    await expect(directSetup).rejects.toMatchObject({ hint: expect.stringContaining("git rm -r --cached") });
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(originalSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(originalSha);
    expect(runGit(["status", "--porcelain"], root)).toBe("");
    expect(existsSync(path.join(root, ".github/workflows/release.yml"))).toBe(false);
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should push the chosen bump and exact tag without running project hooks when CI is selected", async () => {
    // Arrange
    const { root, remote } = createCiProject();
    const github = isolateGithub();
    const hook = path.join(root, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho local-hook > hook.log\nexit 1\n");
    chmodSync(hook, 0o755);
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "minor"] });
    // Assert
    expect(status).toBe(0);
    expect(JSON.parse(runGit(["show", "main:package.json"], remote)).version).toBe("1.3.0");
    expect(runGit(["rev-parse", "v1.3.0^{commit}"], remote)).toBe(runGit(["rev-parse", "HEAD"], root));
    expect(existsSync(path.join(root, "release.log"))).toBe(false);
    expect(existsSync(path.join(root, "hook.log"))).toBe(false);
    expect(github.dispatch).toHaveBeenCalledWith("release.yml", { version: "1.3.0", tag: "v1.3.0", sha: runGit(["rev-parse", "HEAD"], root) }, "npm run create-version --retry-ci v1.3.0");
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should run the complete original flow when local is selected despite configured CI", async () => {
    // Arrange
    const { root, remote } = createCiProject();
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--local", "--bump", "patch"] });
    // Assert
    expect(status).toBe(0);
    expect(readFileSync(path.join(root, "release.log"), "utf8").split("\n").filter(Boolean)).toEqual(["checks", "prepare:1.2.4", "publish:1.2.4"]);
    expect(JSON.parse(runGit(["show", "main:package.json"], remote)).version).toBe("1.2.4");
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([false, true])("should activate automatic CI configuration atomically when setup is chosen and the default declares ci:null: %j", async (declaredNullCi) => {
    // Arrange
    const { root, remote } = createCiProject({ configured: false, declaredNullCi });
    isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    // Assert
    expect(status).toBe(0);
    expect(runGit(["ls-tree", "--name-only", "HEAD", "--", ".github/workflows/release.yml"], root)).toBe(".github/workflows/release.yml");
    expect(runGit(["log", "-1", "--format=%s"], remote)).toBe("1.2.4");
    const configLoader = pathToFileURL(path.resolve("src/create-version/config.js")).href;
    const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", `import { loadCreateVersionConfig } from ${JSON.stringify(configLoader)}; const config = await loadCreateVersionConfig(${JSON.stringify(root)}); console.log(JSON.stringify({ ci: config.ci, hooksPreserved: typeof config.prepare === 'function' && typeof config.publish === 'function' }));`], { env: commandEnvironment(), encoding: "utf8" });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(JSON.parse(loaded.stdout)).toEqual({ ci: { workflow: "release.yml", secrets: [], variables: [], deployment: null }, hooksPreserved: true });
    expect(existsSync(path.join(root, "release.log"))).toBe(false);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each(["changelog", "preflight"])("should leave the repository untouched when %s fails before setup", async (failure) => {
    // Arrange
    const { root, remote, originalSha } = createCiProject({ configured: false, updateChangelog: failure !== "changelog" });
    const github = isolateGithub();
    if (failure === "preflight") vi.mocked(github.preflight).mockRejectedValue(new CiReleaseError("ci-preflight-failed", "Falta acceso a Actions.", "Configurá gh."));
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "minor"] });
    // Assert
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(originalSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(originalSha);
    expect(existsSync(path.join(root, ".github/workflows/release.yml"))).toBe(false);
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should preview setup without writes or GitHub calls when dry-run is requested", async () => {
    // Arrange
    const { root, originalSha } = createCiProject({ configured: false });
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch", "--dry-run"] });
    // Assert
    expect(status).toBe(0);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(originalSha);
    expect(existsSync(path.join(root, ".github/workflows/release.yml"))).toBe(false);
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should retry the same pushed release without another bump when workflow submission fails", async () => {
    // Arrange
    const { root, remote } = createCiProject();
    const github = isolateGithub();
    vi.mocked(github.dispatch).mockRejectedValueOnce(new CiReleaseError("ci-dispatch-unconfirmed", "No se confirmó el inicio.", "Revisá Actions."));
    // Act
    const failed = await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] });
    const pushedSha = runGit(["rev-parse", "HEAD"], root);
    const retried = await runCreateVersion({ repositoryRoot: root, argv: ["--retry-ci", "v1.2.4"] });
    // Assert
    expect(failed).toBe(1);
    expect(retried).toBe(0);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(pushedSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(pushedSha);
    expect(runGit(["tag", "--list"], remote).split("\n")).toEqual(["v1.2.3", "v1.2.4"]);
    expect(existsSync(path.join(root, "release.log"))).toBe(false);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);
});

describe("pinned CI worker through the real CLI", () => {
  it("should stop publication when migration application cannot be confirmed by its recheck", async () => {
    // Arrange
    const { root } = createCiProject();
    writeFileSync(path.join(root, "beez-rp.config.mjs"), [
      "import { appendFileSync } from 'node:fs'; import { join } from 'node:path'; let checks = 0;",
      "export default { checks: ['node checks.mjs'], ci: { workflow: 'release.yml' },",
      "migrations: { check: () => ({ status: ++checks === 1 ? 'pending' : 'unknown', pending: ['001'], target: 'fixture', reason: 'Database unavailable' }), apply: ({ repositoryRoot, version }) => appendFileSync(join(repositoryRoot, 'release.log'), `migrate:${version}\\n`) },",
      "publish: ({ repositoryRoot }) => appendFileSync(join(repositoryRoot, 'release.log'), 'published\\n') };", "",
    ].join("\n"));
    runGit(["add", "beez-rp.config.mjs"], root);
    runGit(["commit", "--quiet", "-m", "chore: configure migrations"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    isolateGithub();
    expect(await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] })).toBe(0);
    // Act
    const worker = await runCliAsync(root, ["--ci-release", "v1.2.4"], { CI: "true" });
    // Assert
    expect(worker.status, worker.output).toBe(1);
    expect(flattenOutput(worker.output)).toContain("no se pudo confirmar que la base esté al día");
    expect(readFileSync(path.join(root, "release.log"), "utf8").split("\n").filter(Boolean)).toEqual(["checks", "migrate:1.2.4"]);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should stop the worker before publication when migration state cannot be determined", async () => {
    // Arrange
    const { root } = createCiProject();
    writeFileSync(path.join(root, "beez-rp.config.mjs"), "export default { checks: ['node checks.mjs'], ci: { workflow: 'release.yml' }, migrations: { check: () => ({ status: 'unknown', pending: [], target: null, reason: 'Database unavailable' }), apply: () => { throw new Error('must not migrate'); } }, publish: () => { throw new Error('must not publish'); } };\n");
    runGit(["add", "beez-rp.config.mjs"], root);
    runGit(["commit", "--quiet", "-m", "chore: configure migrations"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    isolateGithub();
    expect(await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] })).toBe(0);
    // Act
    const worker = await runCliAsync(root, ["--ci-release", "v1.2.4"], { CI: "true" });
    // Assert
    expect(worker.status, worker.output).toBe(1);
    expect(worker.output).toContain("No se pudieron verificar las migraciones del release");
    expect(existsSync(path.join(root, "release.log"))).toBe(false);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should publish through npm only in the worker and preserve confirmed publication on retry", async () => {
    // Arrange
    const registry = await startFixtureNpmRegistry({ users: { "fixture-owner-token": "fixture-owner" }, packages: { "fixture-ci-app": { maintainers: ["fixture-owner"], versions: ["1.2.3"] } } });
    try {
      const { root } = createCiProject();
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...manifest, publishConfig: { registry: registry.registryUrl } }));
      writeFileSync(path.join(root, "beez-rp.config.mjs"), "export default { checks: ['node checks.mjs'], publish: 'npm', ci: { workflow: 'release.yml' } };\n");
      runGit(["add", "-A"], root);
      runGit(["commit", "--quiet", "-m", "chore: configure publication"], root);
      runGit(["push", "--quiet", "origin", "main"], root);
      isolateGithub();
      // Act
      expect(await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] })).toBe(0);
      expect(registry.publications).toEqual([]);
      const sha = runGit(["rev-parse", "HEAD"], root);
      runGit(["switch", "--quiet", "--detach", "v1.2.4"], root);
      const environment = { CI: "true", NPM_TOKEN: "fixture-owner-token", BEEZ_RP_RELEASE_VERSION: "1.2.4", BEEZ_RP_RELEASE_SHA: sha };
      const released = await runCliAsync(root, ["--ci-release", "v1.2.4"], environment);
      const repeated = await runCliAsync(root, ["--ci-release", "v1.2.4"], environment);
      // Assert
      expect(released.status, released.output).toBe(0);
      expect(repeated.status, repeated.output).toBe(0);
      expect(registry.publications).toEqual([{ packageName: "fixture-ci-app", version: "1.2.4", user: "fixture-owner" }]);
      expect(runGit(["rev-parse", "HEAD"], root)).toBe(sha);
    } finally {
      await registry.close();
    }
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([false, true])("should execute checks and stop publication on failure when failChecks is %j", async (failChecks) => {
    // Arrange
    const { root, remote } = createCiProject({ failChecks });
    isolateGithub();
    expect(await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] })).toBe(0);
    const releaseSha = runGit(["rev-parse", "HEAD"], root);
    runGit(["switch", "--quiet", "--detach", "v1.2.4"], root);
    // Act
    const worker = await runCliAsync(root, ["--ci-release", "v1.2.4"], { CI: "true", BEEZ_RP_RELEASE_VERSION: "1.2.4", BEEZ_RP_RELEASE_SHA: releaseSha });
    // Assert
    expect(worker.status, worker.output).toBe(failChecks ? 1 : 0);
    expect(readFileSync(path.join(root, "release.log"), "utf8").split("\n").filter(Boolean)).toEqual(failChecks ? ["checks"] : ["checks", "prepare:1.2.4", "publish:1.2.4"]);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(releaseSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(releaseSha);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should reject a mismatched worker identity before executing checks or hooks", async () => {
    // Arrange
    const { root } = createCiProject();
    isolateGithub();
    expect(await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] })).toBe(0);
    // Act
    const worker = await runCliAsync(root, ["--ci-release", "v1.2.4"], { CI: "true", BEEZ_RP_RELEASE_SHA: "0".repeat(40) });
    // Assert
    expect(worker.status, worker.output).toBe(1);
    expect(existsSync(path.join(root, "release.log"))).toBe(false);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);
});

/**
 * Commits and pushes a new project configuration on top of the fixture's main.
 * @param {string} root - Fixture checkout.
 * @param {string} configSource - Content of beez-rp.config.mjs.
 * @param {Record<string, string>} [extraFiles] - Additional files to commit, relative to the root.
 * @returns {string} SHA of the pushed configuration commit.
 */
function commitProjectConfig(root, configSource, extraFiles = {}) {
  writeFileSync(path.join(root, "beez-rp.config.mjs"), configSource);
  for (const [relativePath, content] of Object.entries(extraFiles)) writeFileSync(path.join(root, relativePath), content);
  runGit(["add", "-A"], root);
  runGit(["commit", "--quiet", "-m", "chore: configure release"], root);
  runGit(["push", "--quiet", "origin", "main"], root);
  return runGit(["rev-parse", "HEAD"], root);
}

describe("CI preparation invariants shared with local releases", () => {
  it("should block CI preparation while the last tagged release is missing from the registry unless it is skipped on purpose", async () => {
    // Arrange
    const registry = await startFixtureNpmRegistry({ users: { "fixture-owner-token": "fixture-owner" }, packages: { "fixture-ci-app": { maintainers: ["fixture-owner"], versions: ["1.2.2"] } } });
    try {
      const { root, remote } = createCiProject();
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      const configuredSha = commitProjectConfig(root, "export default { checks: ['node checks.mjs'], publish: 'npm', ci: { workflow: 'release.yml' } };\n", { "package.json": JSON.stringify({ ...manifest, publishConfig: { registry: registry.registryUrl } }) });
      const github = isolateGithub();
      // Act
      const blocked = await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] });
      const blockedHead = runGit(["rev-parse", "HEAD"], root);
      const blockedTags = runGit(["tag", "--list"], remote);
      const dispatchedWhileBlocked = vi.mocked(github.dispatch).mock.calls.length;
      const skipped = await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch", "--skip-unpublished"] });
      // Assert
      expect(blocked).toBe(1);
      expect(blockedHead).toBe(configuredSha);
      expect(blockedTags).toBe("v1.2.3");
      expect(dispatchedWhileBlocked).toBe(0);
      expect(skipped).toBe(0);
      expect(JSON.parse(runGit(["show", "main:package.json"], remote)).version).toBe("1.2.4");
      expect(github.dispatch).toHaveBeenCalledTimes(1);
      expect(registry.publications).toEqual([]);
    } finally {
      await registry.close();
    }
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { createdWith: ["--local"], committedExecution: "local", mismatchedResume: [], matchingResume: ["--local"] },
    { createdWith: [], committedExecution: "ci", mismatchedResume: ["--local"], matchingResume: [] },
  ])("should keep the committed Vercel execution mode $committedExecution when resuming a release whose push failed", async ({ createdWith, committedExecution, mismatchedResume, matchingResume }) => {
    // Arrange
    const { root, remote } = createCiProject();
    const configuredSha = commitProjectConfig(root, "export default { checks: ['node checks.mjs'], ci: { workflow: 'release.yml', deployment: 'vercel' } };\n");
    const github = isolateGithub();
    runGit(["config", "remote.origin.pushurl", path.join(root, "..", "missing-origin.git")], root);
    const created = await runCreateVersion({ repositoryRoot: root, argv: [...createdWith, "--bump", "patch"] });
    const releaseSha = runGit(["rev-parse", "HEAD"], root);
    runGit(["config", "--unset", "remote.origin.pushurl"], root);
    // Act
    const mismatched = await runCreateVersion({ repositoryRoot: root, argv: mismatchedResume });
    const remoteAfterMismatch = runGit(["rev-parse", "main"], remote);
    const dispatchesAfterMismatch = vi.mocked(github.dispatch).mock.calls.length;
    const resumed = await runCreateVersion({ repositoryRoot: root, argv: matchingResume });
    // Assert
    expect(created).toBe(1);
    expect(JSON.parse(runGit(["show", "HEAD:.beez-rp/release.json"], root))).toEqual({ version: "1.2.4", execution: committedExecution });
    expect(mismatched).toBe(1);
    expect(remoteAfterMismatch).toBe(configuredSha);
    expect(dispatchesAfterMismatch).toBe(0);
    expect(resumed).toBe(0);
    expect(runGit(["rev-parse", "main"], remote)).toBe(releaseSha);
    expect(JSON.parse(runGit(["show", "main:.beez-rp/release.json"], remote))).toEqual({ version: "1.2.4", execution: committedExecution });
    expect(github.dispatch).toHaveBeenCalledTimes(committedExecution === "ci" ? 1 : 0);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should reject browser-authenticated JSR publication before creating the CI release commit or tag", async () => {
    // Arrange
    const { root, remote } = createCiProject();
    const configuredSha = commitProjectConfig(root, "export default { checks: ['node checks.mjs'], publish: 'jsr', ci: { workflow: 'release.yml' } };\n", { "jsr.json": JSON.stringify({ name: "@fixture/ci-app", version: "1.2.3", exports: "./checks.mjs" }) });
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] });
    // Assert
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(configuredSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(configuredSha);
    expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should leave OIDC and token registry authentication to the worker while rejecting browser authentication", () => {
    // Arrange
    const browserJsr = resolveCreateVersionConfig({ publish: "jsr" });
    const oidcJsr = resolveCreateVersionConfig({ publish: "jsr", publication: { authentication: "oidc" } });
    const tokenJsr = resolveCreateVersionConfig({ publish: "jsr", publication: { authentication: "token" } });
    // Act and Assert
    expect(() => assertCiCompatiblePublication(browserJsr)).toThrow(/no puede publicar desde GitHub Actions/);
    expect(() => assertCiCompatiblePublication(oidcJsr)).not.toThrow();
    expect(() => assertCiCompatiblePublication(tokenJsr)).not.toThrow();
    expect(() => assertCiCompatiblePublication(resolveCreateVersionConfig({ publish: "npm" }))).not.toThrow();
  });
});
