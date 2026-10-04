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
import { loadCreateVersionConfig, resolveCreateVersionConfig } from "../../src/create-version/config.js";
import { assertCiCompatiblePublication, assertCiInstallLockfileCommitted, assertCiNodeVersionFileCommitted, assertGeneratedCiWorkflowCurrent, assertResumeExecutionMatches, chooseReleaseExecution, isCommittedCiWorkflowGenerated } from "../../src/create-version/ci.js";
import { createGitReader } from "../../src/create-version/process.js";
import { decideBuildForCheckout } from "../../src/build-gate.js";
import { CiReleaseError, ReleaseStepError } from "../../src/create-version/errors.js";
import * as githubWorkflow from "../../src/create-version/github-workflow.js";
import { parseReleaseArguments } from "../../src/create-version/plan.js";
import { runCreateVersion } from "../../src/create-version/run.js";
import { describeCiEnvironment, describeCiNodeVersion, prepareCiSetupFiles, renderCiReleaseWorkflow } from "../../src/create-version/ci-setup.js";
import { GIT_FIXTURE_TEST_TIMEOUT_MS, cleanupTemporaryDirectories, commandEnvironment, commitFixtureRepository, createTemporaryDirectory, flattenOutput, runCliAsync, runGit } from "./support/cli-harness.js";
import { FIXTURE_GITHUB_REPOSITORY, FIXTURE_GITHUB_TOKEN, startFixtureGithubActionsApi } from "./support/fixture-github-actions-api.js";
import { startFixtureNpmRegistry } from "./support/fixture-npm-registry.js";

/** Project configuration whose custom publisher (logged like `prepare`) is followed by a Vercel deployment. */
const CUSTOM_PUBLISHER_VERCEL_CONFIG = [
  "import { appendFileSync } from 'node:fs'; import { join } from 'node:path';",
  "export default {",
  "  checks: ['node checks.mjs'],",
  "  prepare: ({ version, repositoryRoot }) => appendFileSync(join(repositoryRoot, 'release.log'), `prepare:${version}\\n`),",
  "  publish: ({ version, repositoryRoot }) => appendFileSync(join(repositoryRoot, 'release.log'), `publish:${version}\\n`),",
  "  ci: { workflow: 'release.yml', deployment: 'vercel' },",
  "};", "",
].join("\n");

/**
 * Renders the release workflow synchronously in a child process, so synchronous fixtures can use
 * the asynchronous renderer. A child also avoids the per-process ESM cache of the project's config
 * module, which the test may change before the release under test loads it.
 * @param {string} root - Fixture checkout with a commit at HEAD.
 * @param {string} configExpression - JavaScript expression evaluated in the child, with `loadCreateVersionConfig` and `resolveCreateVersionConfig` in scope.
 * @returns {string} Generated GitHub Actions YAML.
 */
function renderWorkflowInChildProcess(root, configExpression) {
  const configModule = pathToFileURL(path.resolve("src/create-version/config.js")).href;
  const workflowRenderer = pathToFileURL(path.resolve("src/create-version/ci-setup.js")).href;
  const rendered = spawnSync(process.execPath, ["--input-type=module", "-e", `import { loadCreateVersionConfig, resolveCreateVersionConfig } from ${JSON.stringify(configModule)}; import { renderCiReleaseWorkflow } from ${JSON.stringify(workflowRenderer)}; process.stdout.write(await renderCiReleaseWorkflow(${JSON.stringify(root)}, ${configExpression}));`], { env: commandEnvironment(), encoding: "utf8" });
  if (rendered.status !== 0) throw new Error(`renderWorkflowInChildProcess failed to render ${root}: ${rendered.stderr}`);
  return rendered.stdout;
}

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
  // The generated workflow installs with `npm ci`, which needs this lockfile committed.
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "fixture-ci-app", version: "1.2.3", lockfileVersion: 3, requires: true, packages: { "": { name: "fixture-ci-app", version: "1.2.3" } } }));
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
  runGit(["add", "-A"], root);
  runGit(["commit", "--quiet", "-m", "1.2.3"], root);
  if (configured) {
    // The workflow follows the committed state (its Node.js pin is read from HEAD), so it is rendered once HEAD exists.
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(path.join(root, ".github/workflows/release.yml"), renderWorkflowInChildProcess(root, `resolveCreateVersionConfig(${JSON.stringify({ checks: ["node checks.mjs"], ci: { workflow: "release.yml" } })})`));
    runGit(["add", "-A"], root);
    runGit(["commit", "--quiet", "--amend", "--no-edit"], root);
  }
  runGit(["tag", "-a", "v1.2.3", "-m", "1.2.3"], root);
  writeFileSync(path.join(root, "feature.txt"), "New feature\n");
  if (updateChangelog) writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n- Primera versión.\n- Nueva funcionalidad documentada manualmente.\n");
  runGit(["add", "-A"], root);
  runGit(["commit", "--quiet", "-m", "feat: add feature"], root);
  runGit(["push", "--quiet", "origin", "main", "--tags"], root);
  return { root, remote, originalSha: runGit(["rev-parse", "HEAD"], root) };
}

/**
 * Commits and pushes the workflow `--setup-ci` renders for the project's loaded configuration, so
 * the fixture starts without drift (the default fixture workflow targets the default package manager).
 * @param {string} root - Fixture checkout.
 * @returns {string} Pushed commit SHA.
 */
function commitGeneratedWorkflow(root) {
  writeFileSync(path.join(root, ".github/workflows/release.yml"), renderWorkflowInChildProcess(root, `await loadCreateVersionConfig(${JSON.stringify(root)})`));
  runGit(["commit", "--quiet", "-am", "ci: regenerate release workflow"], root);
  runGit(["push", "--quiet", "origin", "main"], root);
  return runGit(["rev-parse", "HEAD"], root);
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

  it("should bind Vercel credentials only to the Vercel steps while preflight still requires them", async () => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-vercel-scope-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-vercel-app", version: "1.0.0", packageManager: "npm@11.11.1" }));
    const config = resolveCreateVersionConfig({ checks: ["node checks.mjs"], ci: { workflow: "release.yml", deployment: "vercel", secrets: ["DATABASE_URL"] } });
    commitFixtureRepository(root);
    const vercelSecrets = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"];
    // Act
    const environment = describeCiEnvironment(config);
    const { jobEnvironment, stepEnvironments } = readWorkflowEnvironmentScopes(await renderCiReleaseWorkflow(root, config));
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

  it("should pull the Vercel production environment only after release checks and right before the production build", async () => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-vercel-order-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-vercel-app", version: "1.0.0", packageManager: "npm@11.11.1" }));
    const config = resolveCreateVersionConfig({ checks: ["node checks.mjs"], ci: { workflow: "release.yml", deployment: "vercel" } });
    commitFixtureRepository(root);
    // Act
    const stepNames = [...readWorkflowEnvironmentScopes(await renderCiReleaseWorkflow(root, config)).stepEnvironments.keys()];
    // Assert
    const releaseStepIndex = stepNames.indexOf("Checks y publicación del release");
    const pullStepIndex = stepNames.indexOf("Obtener entorno de producción");
    expect(releaseStepIndex).toBeGreaterThanOrEqual(0);
    expect(pullStepIndex).toBe(releaseStepIndex + 1);
    expect(stepNames.slice(pullStepIndex + 1)).toEqual(["Construir artefacto de producción", "Desplegar producción después de los checks"]);
  });

  it("should keep explicitly declared Vercel credentials step-scoped and deduplicated", async () => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-vercel-declared-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-vercel-app", version: "1.0.0", packageManager: "npm@11.11.1" }));
    const config = resolveCreateVersionConfig({ checks: ["node checks.mjs"], ci: { workflow: "release.yml", deployment: "vercel", secrets: ["VERCEL_TOKEN", "DATABASE_URL", "VERCEL_PROJECT_ID"] } });
    commitFixtureRepository(root);
    const vercelSecrets = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"];
    // Act
    const environment = describeCiEnvironment(config);
    const { jobEnvironment, stepEnvironments } = readWorkflowEnvironmentScopes(await renderCiReleaseWorkflow(root, config));
    // Assert
    expect(environment.secrets).toEqual(["VERCEL_TOKEN", "DATABASE_URL", "VERCEL_PROJECT_ID", "VERCEL_ORG_ID"]);
    expect(environment.deploymentSecrets).toEqual(vercelSecrets);
    expect(jobEnvironment).toContain("DATABASE_URL");
    for (const name of vercelSecrets) expect(jobEnvironment).not.toContain(name);
    const stepsWithVercelCredentials = [...stepEnvironments].filter(([, names]) => vercelSecrets.some((name) => names.includes(name)));
    expect(stepsWithVercelCredentials.length).toBe(3);
    for (const [, names] of stepsWithVercelCredentials) expect(names).toEqual(vercelSecrets);
  });

  it.each([
    { publisher: "a custom function", publish: () => {}, readsHistory: true },
    { publisher: "a registry", publish: "npm", readsHistory: false },
  ])("should let the Vercel worker read its Actions history only when $publisher publishes", async ({ publish, readsHistory }) => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-vercel-history-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-vercel-app", version: "1.0.0", packageManager: "npm@11.11.1" }));
    const config = resolveCreateVersionConfig({ checks: ["node checks.mjs"], publish, publication: { authentication: "token" }, ci: { workflow: "release.yml", deployment: "vercel" } });
    commitFixtureRepository(root);
    // Act
    const workflow = await renderCiReleaseWorkflow(root, config);
    const { jobEnvironment, stepEnvironments } = readWorkflowEnvironmentScopes(workflow);
    // Assert
    expect(stepEnvironments.has("Checks y publicación del release")).toBe(true);
    expect(workflow.split("\n").includes("  actions: read")).toBe(readsHistory);
    expect(jobEnvironment.includes("GITHUB_TOKEN")).toBe(readsHistory);
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

  it.each(["1", "TRUE", " True ", "yes", "github"])("should never dispatch another release from a CI runtime whose CI signal is %j", async (ciValue) => {
    // Arrange
    const config = resolveCreateVersionConfig({ ci: { workflow: "release.yml" } });
    vi.stubEnv("CI", ciValue);
    // Act and Assert
    expect(await chooseReleaseExecution(config, parseReleaseArguments([]))).toEqual({ execution: "local", setup: false });
    await expect(chooseReleaseExecution(config, parseReleaseArguments(["--ci"]))).rejects.toThrow(/no puede disparar otro release/);
  });

  it.each(["", "0", "FALSE", " no ", "Off"])("should keep dispatching to the configured workflow when the CI signal is the explicit false form %j", async (ciValue) => {
    // Arrange
    const config = resolveCreateVersionConfig({ ci: { workflow: "release.yml" } });
    vi.stubEnv("CI", ciValue);
    // Act and Assert
    expect(await chooseReleaseExecution(config, parseReleaseArguments([]))).toEqual({ execution: "ci", setup: false });
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

  it("should continue setup as an ordinary CI release when the existing generated workflow still matches the configuration", async () => {
    // Arrange
    const { root, remote } = createCiProject();
    commitGeneratedWorkflow(root);
    const committedWorkflow = runGit(["show", "HEAD:.github/workflows/release.yml"], root);
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    // Assert
    expect(status).toBe(0);
    expect(runGit(["rev-parse", "v1.2.4^{commit}"], remote)).toBe(runGit(["rev-parse", "HEAD"], root));
    expect(runGit(["show", "HEAD:.github/workflows/release.yml"], root)).toBe(committedWorkflow);
    expect(github.preflight).toHaveBeenCalledWith("release.yml", [], []);
    expect(github.dispatch).toHaveBeenCalledOnce();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    ["npm token publication", "publish: 'npm', ci: { workflow: 'release.yml' }", "NPM_TOKEN"],
    ["a new worker secret", "ci: { workflow: 'release.yml', secrets: ['DATABASE_URL'] }", "DATABASE_URL"],
  ])("should block setup before any commit, tag or dispatch when the committed workflow drifted after configuring %s", async (_change, configEntries, missingBinding) => {
    // Arrange
    const { root, remote } = createCiProject();
    commitGeneratedWorkflow(root);
    writeFileSync(path.join(root, "beez-rp.config.mjs"), `export default { checks: ['node checks.mjs'], ${configEntries} };\n`);
    runGit(["commit", "--quiet", "-am", "chore: change release configuration"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    const configuredSha = runGit(["rev-parse", "HEAD"], root);
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    const directCheck = assertGeneratedCiWorkflowCurrent(root, await loadCreateVersionConfig(root));
    // Assert
    await expect(directCheck).rejects.toThrow(missingBinding);
    await expect(directCheck).rejects.toMatchObject({ hint: expect.stringContaining("--setup-ci") });
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(configuredSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(configuredSha);
    expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
    expect(runGit(["status", "--porcelain"], root)).toBe("");
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should block setup when the existing workflow is not committed and therefore unavailable to the worker", async () => {
    // Arrange
    const { root, remote, originalSha } = createCiProject();
    runGit(["rm", "--quiet", "--cached", ".github/workflows/release.yml"], root);
    runGit(["commit", "--quiet", "-m", "chore: untrack workflow"], root);
    writeFileSync(path.join(root, ".gitignore"), "*.log\nnode_modules\n.github/\n");
    runGit(["commit", "--quiet", "-am", "chore: ignore workflows"], root);
    const untrackedSha = runGit(["rev-parse", "HEAD"], root);
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    // Assert
    await expect(assertGeneratedCiWorkflowCurrent(root, await loadCreateVersionConfig(root))).rejects.toThrow(/no está commiteado/);
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(untrackedSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(originalSha);
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    ["missing from the project", false, false],
    ["only on disk because Git ignores it", true, false],
    ["missing while setup reuses the existing generated workflow", false, true],
  ])("should block setup before any commit, tag or dispatch when the npm lockfile `npm ci` needs is %s", async (_scenario, keepIgnoredOnDisk, reuseGeneratedWorkflow) => {
    // Arrange
    const { root, remote } = createCiProject({ configured: reuseGeneratedWorkflow });
    if (reuseGeneratedWorkflow) commitGeneratedWorkflow(root);
    runGit(["rm", "--quiet", ...(keepIgnoredOnDisk ? ["--cached"] : []), "package-lock.json"], root);
    if (keepIgnoredOnDisk) writeFileSync(path.join(root, ".gitignore"), "*.log\nnode_modules\npackage-lock.json\n");
    runGit(["commit", "--quiet", "-am", "chore: stop committing the lockfile"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    const lockfilelessSha = runGit(["rev-parse", "HEAD"], root);
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch"] });
    const directCheck = assertCiInstallLockfileCommitted(root, "npm");
    // Assert
    await expect(directCheck).rejects.toThrow(/package-lock\.json ni npm-shrinkwrap\.json/);
    await expect(directCheck).rejects.toMatchObject({ hint: expect.stringContaining("npm install") });
    expect(status).toBe(1);
    expect(existsSync(path.join(root, "package-lock.json"))).toBe(keepIgnoredOnDisk);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(lockfilelessSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(lockfilelessSha);
    expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
    expect(runGit(["status", "--porcelain"], root)).toBe("");
    expect(existsSync(path.join(root, ".github/workflows/release.yml"))).toBe(reuseGeneratedWorkflow);
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  /**
   * Replaces the fixture's committed npm lockfile with another committed lockfile, or with none.
   * @param {string} root - Fixture checkout.
   * @param {string | null} committedLockfile - Lockfile committed instead, or `null` for none.
   * @returns {void}
   */
  function commitOnlyLockfile(root, committedLockfile) {
    runGit(["rm", "--quiet", "package-lock.json"], root);
    if (committedLockfile) {
      writeFileSync(path.join(root, committedLockfile), "lockfile\n");
      runGit(["add", committedLockfile], root);
    }
    runGit(["commit", "--quiet", "-m", "chore: switch lockfile"], root);
  }

  it.each(/** @type {const} */ ([
    ["npm", "npm-shrinkwrap.json"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lockb"],
  ]))("should accept the frozen %s install when HEAD commits its %s lockfile", async (packageManager, committedLockfile) => {
    // Arrange
    const { root } = createCiProject();
    commitOnlyLockfile(root, committedLockfile);
    // Act
    const check = assertCiInstallLockfileCommitted(root, packageManager);
    // Assert
    await expect(check).resolves.toBeUndefined();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each(/** @type {const} */ ([
    ["pnpm", "package-lock.json"],
    ["yarn", "pnpm-lock.yaml"],
    ["bun", null],
  ]))("should reject the frozen %s install when HEAD only commits %s", async (packageManager, committedLockfile) => {
    // Arrange
    const { root } = createCiProject();
    commitOnlyLockfile(root, committedLockfile);
    // Act
    const check = assertCiInstallLockfileCommitted(root, packageManager);
    // Assert
    await expect(check).rejects.toThrow(new RegExp(`instala dependencias con ${packageManager} .*el worker fallaría`, "u"));
    await expect(check).rejects.toMatchObject({ hint: expect.stringContaining(`${packageManager} install`) });
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { scenario: "committed at HEAD", nvmrcState: "committed", followsPinFile: true, accepted: true },
    { scenario: "only on disk and untracked", nvmrcState: "untracked", followsPinFile: false, accepted: false },
    { scenario: "only on disk because Git ignores it", nvmrcState: "ignored", followsPinFile: false, accepted: false },
    { scenario: "absent", nvmrcState: "absent", followsPinFile: false, accepted: true },
  ])("should pin the generated workflow to .nvmrc only when it is $scenario and accept it for setup: $accepted", async ({ nvmrcState, followsPinFile, accepted }) => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-node-file-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-node-file", version: "1.0.0", packageManager: "npm@11.11.1" }));
    if (nvmrcState === "ignored") writeFileSync(path.join(root, ".gitignore"), ".nvmrc\n");
    if (nvmrcState === "committed") writeFileSync(path.join(root, ".nvmrc"), "v24.1.0\n");
    commitFixtureRepository(root);
    if (nvmrcState === "untracked" || nvmrcState === "ignored") writeFileSync(path.join(root, ".nvmrc"), "v24.1.0\n");
    const config = resolveCreateVersionConfig({ checks: ["node checks.mjs"], ci: { workflow: "release.yml" } });
    // Act
    const workflow = await renderCiReleaseWorkflow(root, config);
    const nodeVersion = await describeCiNodeVersion(root);
    let rejection = { message: "", hint: "" };
    try {
      await assertCiNodeVersionFileCommitted(root);
    } catch (error) {
      rejection = { message: error instanceof Error ? error.message : String(error), hint: error instanceof ReleaseStepError ? error.hint : "" };
    }
    // Assert
    const runningNodeMajor = process.versions.node.split(".")[0];
    expect(nodeVersion).toEqual(followsPinFile ? { pinnedFile: ".nvmrc", version: "24.1.0" } : { pinnedFile: null, version: runningNodeMajor });
    expect(workflow.includes("node-version-file: '.nvmrc'")).toBe(followsPinFile);
    expect(workflow.includes(`node-version: '${runningNodeMajor}'`)).toBe(!followsPinFile);
    expect(/\.nvmrc existe en el checkout pero HEAD no lo contiene como archivo regular commiteado/u.test(rejection.message)).toBe(!accepted);
    expect(rejection.hint.includes("Commiteá .nvmrc")).toBe(!accepted);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    ["untracked and set aside by --ignore-local-changes", false, ["--ignore-local-changes"]],
    ["ignored by Git", true, []],
  ])("should block setup before any commit, tag or dispatch when .nvmrc is %s instead of committed at HEAD", async (_scenario, ignoredByGit, extraArguments) => {
    // Arrange
    const { root, remote } = createCiProject({ configured: false });
    if (ignoredByGit) {
      writeFileSync(path.join(root, ".gitignore"), "*.log\nnode_modules\n.nvmrc\n");
      runGit(["commit", "--quiet", "-am", "chore: ignore the Node.js pin"], root);
      runGit(["push", "--quiet", "origin", "main"], root);
    }
    const uncommittedPinSha = runGit(["rev-parse", "HEAD"], root);
    writeFileSync(path.join(root, ".nvmrc"), "24\n");
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--setup-ci", "--bump", "patch", ...extraArguments] });
    // Assert
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(uncommittedPinSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(uncommittedPinSha);
    expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
    expect(existsSync(path.join(root, ".github/workflows/release.yml"))).toBe(false);
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    ["ignored by Git", ".github/\n", []],
    ["untracked and set aside by --ignore-local-changes", "", ["--ignore-local-changes"]],
  ])("should block an ordinary CI release before any commit, tag or dispatch when the configured workflow is %s", async (_scenario, ignoredPaths, extraArguments) => {
    // Arrange
    const { root, remote, originalSha } = createCiProject();
    runGit(["rm", "--quiet", "--cached", ".github/workflows/release.yml"], root);
    writeFileSync(path.join(root, ".gitignore"), `*.log\nnode_modules\n${ignoredPaths}`);
    runGit(["add", ".gitignore"], root);
    runGit(["commit", "--quiet", "-m", "chore: stop tracking the release workflow"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    const untrackedSha = runGit(["rev-parse", "HEAD"], root);
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--ci", "--bump", "patch", ...extraArguments] });
    // Assert
    expect(status).toBe(1);
    expect(untrackedSha).not.toBe(originalSha);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(untrackedSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(untrackedSha);
    expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
    expect(existsSync(path.join(root, ".github/workflows/release.yml"))).toBe(true);
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    ["the configuration disables the npm publication the committed release performs", "beez-rp.config.mjs", "export default { checks: ['node checks.mjs'], publish: null, ci: { workflow: 'release.yml' } };\n"],
    ["the committed lockfile is edited", "package-lock.json", "{}\n"],
    ["another package manager's lockfile is added", "yarn.lock", "# yarn lockfile v1\n"],
    ["an uncommitted Node.js pin is added", ".nvmrc", "24\n"],
    ["the configured workflow is edited", ".github/workflows/release.yml", "name: Release editado\n"],
  ])("should block an ordinary CI release with --ignore-local-changes before any commit, tag or dispatch when %s", async (_scenario, changedPath, changedContent) => {
    // Arrange
    const { root, remote, originalSha } = createCiProject();
    writeFileSync(path.join(root, changedPath), changedContent);
    const changesBefore = runGit(["status", "--porcelain"], root);
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--ci", "--bump", "patch", "--ignore-local-changes"] });
    // Assert
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(originalSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(originalSha);
    expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
    expect(runGit(["status", "--porcelain"], root)).toBe(changesBefore);
    expect(runGit(["stash", "list"], root)).toBe("");
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should still set aside an unrelated change and dispatch an ordinary CI release with --ignore-local-changes", async () => {
    // Arrange
    const { root, remote } = createCiProject();
    writeFileSync(path.join(root, "notes.txt"), "Borrador local\n");
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--ci", "--bump", "patch", "--ignore-local-changes"] });
    // Assert
    expect(status).toBe(0);
    expect(runGit(["rev-parse", "v1.2.4^{commit}"], remote)).toBe(runGit(["rev-parse", "HEAD"], root));
    expect(runGit(["ls-tree", "--name-only", "HEAD", "notes.txt"], root)).toBe("");
    expect(readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("Borrador local\n");
    expect(github.dispatch).toHaveBeenCalledOnce();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    ["the lockfile its frozen install needs was removed from HEAD", "lockfile"],
    ["the .nvmrc on disk is ignored by Git instead of committed", "ignored-nvmrc"],
  ])("should block an ordinary CI release with the committed generated workflow before any commit, tag or dispatch when %s", async (_scenario, missingInput) => {
    // Arrange
    const { root, remote } = createCiProject();
    if (missingInput === "lockfile") {
      runGit(["rm", "--quiet", "package-lock.json"], root);
      runGit(["commit", "--quiet", "-m", "chore: drop the lockfile"], root);
    } else {
      writeFileSync(path.join(root, ".gitignore"), "*.log\nnode_modules\n.nvmrc\n");
      runGit(["commit", "--quiet", "-am", "chore: ignore the Node.js pin"], root);
    }
    const generatedSha = commitGeneratedWorkflow(root);
    if (missingInput === "ignored-nvmrc") writeFileSync(path.join(root, ".nvmrc"), "24\n");
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--ci", "--bump", "patch"] });
    // Assert
    expect(await isCommittedCiWorkflowGenerated(root, await loadCreateVersionConfig(root))).toBe(true);
    expect(status).toBe(1);
    expect(runGit(["rev-parse", "HEAD"], root)).toBe(generatedSha);
    expect(runGit(["rev-parse", "main"], remote)).toBe(generatedSha);
    expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
    expect(github.preflight).not.toHaveBeenCalled();
    expect(github.dispatch).not.toHaveBeenCalled();
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it("should leave the install inputs of a customized committed workflow to the project during an ordinary CI release", async () => {
    // Arrange
    const { root, remote } = createCiProject();
    runGit(["rm", "--quiet", "package-lock.json"], root);
    runGit(["commit", "--quiet", "-m", "chore: drop the lockfile"], root);
    runGit(["push", "--quiet", "origin", "main"], root);
    const github = isolateGithub();
    // Act
    const status = await runCreateVersion({ repositoryRoot: root, argv: ["--ci", "--bump", "patch"] });
    // Assert
    expect(await isCommittedCiWorkflowGenerated(root, await loadCreateVersionConfig(root))).toBe(false);
    expect(status).toBe(0);
    expect(runGit(["rev-parse", "v1.2.4^{commit}"], remote)).toBe(runGit(["rev-parse", "HEAD"], root));
    expect(github.dispatch).toHaveBeenCalledOnce();
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

  it.each([
    { deployment: "vercel", retryLog: ["checks", "prepare:1.2.4"] },
    { deployment: null, retryLog: ["checks"] },
  ])("should re-run preparation without republishing on a worker retry only when the $deployment deployment follows", async ({ deployment, retryLog }) => {
    // Arrange
    const registry = await startFixtureNpmRegistry({ users: { "fixture-owner-token": "fixture-owner" }, packages: { "fixture-ci-app": { maintainers: ["fixture-owner"], versions: ["1.2.3"] } } });
    try {
      const { root } = createCiProject();
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      commitProjectConfig(root, [
        "import { appendFileSync } from 'node:fs'; import { join } from 'node:path';",
        "export default {",
        "  checks: ['node checks.mjs'],",
        "  prepare: ({ version, repositoryRoot }) => appendFileSync(join(repositoryRoot, 'release.log'), `prepare:${version}\\n`),",
        "  publish: 'npm',",
        `  ci: { workflow: 'release.yml', deployment: ${JSON.stringify(deployment)} },`,
        "};", "",
      ].join("\n"), { "package.json": JSON.stringify({ ...manifest, publishConfig: { registry: registry.registryUrl } }) });
      isolateGithub();
      expect(await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] })).toBe(0);
      const sha = runGit(["rev-parse", "HEAD"], root);
      runGit(["switch", "--quiet", "--detach", "v1.2.4"], root);
      const environment = { CI: "true", NPM_TOKEN: "fixture-owner-token", BEEZ_RP_RELEASE_VERSION: "1.2.4", BEEZ_RP_RELEASE_SHA: sha };
      const released = await runCliAsync(root, ["--ci-release", "v1.2.4"], environment);
      writeFileSync(path.join(root, "release.log"), "");
      // Act
      const retried = await runCliAsync(root, ["--ci-release", "v1.2.4"], environment);
      // Assert
      expect(released.status, released.output).toBe(0);
      expect(retried.status, retried.output).toBe(0);
      expect(readFileSync(path.join(root, "release.log"), "utf8").split("\n").filter(Boolean)).toEqual(retryLog);
      expect(registry.publications).toEqual([{ packageName: "fixture-ci-app", version: "1.2.4", user: "fixture-owner" }]);
    } finally {
      await registry.close();
    }
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { scenario: "an earlier run finished the release step", conclusions: [["failure"], ["success"]], expectedLog: ["checks", "prepare:1.2.4"] },
    { scenario: "an earlier attempt of the current run finished the release step", conclusions: [["success", null]], expectedLog: ["checks", "prepare:1.2.4"] },
    { scenario: "earlier attempts stopped before finishing the release step", conclusions: [["failure", "cancelled", null]], expectedLog: ["checks", "prepare:1.2.4", "publish:1.2.4"] },
    { scenario: "this is the first attempt", conclusions: [[null]], expectedLog: ["checks", "prepare:1.2.4", "publish:1.2.4"] },
  ])("should run a custom publisher before a Vercel deployment only when no earlier attempt finished it: $scenario", async ({ conclusions, expectedLog }) => {
    // Arrange
    const { root } = createCiProject();
    commitProjectConfig(root, CUSTOM_PUBLISHER_VERCEL_CONFIG);
    isolateGithub();
    expect(await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] })).toBe(0);
    const sha = runGit(["rev-parse", "HEAD"], root);
    runGit(["switch", "--quiet", "--detach", "v1.2.4"], root);
    const otherRelease = { id: 7, title: `beez-rp release v1.2.3 ${"0".repeat(40)}`, headSha: "0".repeat(40), releaseStepConclusions: ["success"] };
    const releaseRuns = conclusions.map((releaseStepConclusions, index) => ({ id: index + 10, title: `beez-rp release v1.2.4 ${sha}`, headSha: sha, releaseStepConclusions }));
    const actionsApi = await startFixtureGithubActionsApi({ workflow: "release.yml", runs: [otherRelease, ...releaseRuns] });
    try {
      // Act
      const worker = await runCliAsync(root, ["--ci-release", "v1.2.4"], { CI: "true", BEEZ_RP_RELEASE_VERSION: "1.2.4", BEEZ_RP_RELEASE_SHA: sha, GITHUB_API_URL: actionsApi.apiUrl, GITHUB_REPOSITORY: FIXTURE_GITHUB_REPOSITORY, GITHUB_TOKEN: FIXTURE_GITHUB_TOKEN });
      // Assert
      expect(worker.status, worker.output).toBe(0);
      expect(readFileSync(path.join(root, "release.log"), "utf8").split("\n").filter(Boolean)).toEqual(expectedLog);
      expect(actionsApi.requests.every((request) => request.authorization === `Bearer ${FIXTURE_GITHUB_TOKEN}`)).toBe(true);
    } finally {
      await actionsApi.close();
    }
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { scenario: "the job token cannot read Actions", failureStatus: 403, token: FIXTURE_GITHUB_TOKEN },
    { scenario: "the workflow binds no job token", failureStatus: undefined, token: "" },
  ])("should stop a custom publisher before a Vercel deployment without publishing when $scenario", async ({ failureStatus, token }) => {
    // Arrange
    const { root } = createCiProject();
    commitProjectConfig(root, CUSTOM_PUBLISHER_VERCEL_CONFIG);
    isolateGithub();
    expect(await runCreateVersion({ repositoryRoot: root, argv: ["--bump", "patch"] })).toBe(0);
    const sha = runGit(["rev-parse", "HEAD"], root);
    runGit(["switch", "--quiet", "--detach", "v1.2.4"], root);
    const actionsApi = await startFixtureGithubActionsApi({ workflow: "release.yml", failureStatus });
    try {
      // Act
      const worker = await runCliAsync(root, ["--ci-release", "v1.2.4"], { CI: "true", BEEZ_RP_RELEASE_VERSION: "1.2.4", BEEZ_RP_RELEASE_SHA: sha, GITHUB_API_URL: actionsApi.apiUrl, GITHUB_REPOSITORY: FIXTURE_GITHUB_REPOSITORY, GITHUB_TOKEN: token });
      // Assert
      expect(worker.status, worker.output).toBe(1);
      expect(flattenOutput(worker.output)).toContain('permissions "actions: read"');
      expect(existsSync(path.join(root, "release.log"))).toBe(false);
    } finally {
      await actionsApi.close();
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

  it.each([
    { createdWith: ["--local"], committedExecution: "local", mismatchedResume: [], matchingResume: ["--local"] },
    { createdWith: [], committedExecution: "ci", mismatchedResume: ["--local"], matchingResume: [] },
  ])("should keep the execution mode $committedExecution of a non-Vercel release whose push failed without letting the Vercel gate skip it", async ({ createdWith, committedExecution, mismatchedResume, matchingResume }) => {
    // Arrange
    const { root, remote } = createCiProject();
    const configuredSha = commitProjectConfig(root, "export default { checks: ['node checks.mjs'], ci: { workflow: 'release.yml' } };\n");
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
    expect(runGit(["log", "-1", "--format=%(trailers:key=Beez-Rp-Execution,valueonly=true)", releaseSha], root)).toBe(committedExecution);
    expect(existsSync(path.join(root, ".beez-rp/release.json"))).toBe(false);
    expect(mismatched).toBe(1);
    expect(remoteAfterMismatch).toBe(configuredSha);
    expect(dispatchesAfterMismatch).toBe(0);
    expect(resumed).toBe(0);
    expect(runGit(["rev-parse", "main"], remote)).toBe(releaseSha);
    expect(github.dispatch).toHaveBeenCalledTimes(committedExecution === "ci" ? 1 : 0);
    expect(decideBuildForCheckout(root).shouldBuild).toBe(true);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { label: "no trailer", message: ["-m", "1.2.4"], resumeExecution: "local", expectedOutcome: "accepted" },
    { label: "ci trailer", message: ["-m", "1.2.4", "-m", "Beez-Rp-Execution: ci"], resumeExecution: "local", expectedOutcome: "--ci" },
    { label: "local trailer", message: ["-m", "1.2.4", "-m", "Beez-Rp-Execution: local"], resumeExecution: "ci", expectedOutcome: "--local" },
    { label: "unknown trailer", message: ["-m", "1.2.4", "-m", "Beez-Rp-Execution: remote"], resumeExecution: "local", expectedOutcome: "Beez-Rp-Execution: remote" },
  ])("should resolve a pending release commit with $label against a $resumeExecution resume", async ({ message, resumeExecution, expectedOutcome }) => {
    // Arrange
    const { root } = createCiProject();
    runGit(["commit", "--quiet", "--allow-empty", ...message], root);
    const reader = createGitReader(root);
    // Act
    const outcome = await assertResumeExecutionMatches(reader, "1.2.4", /** @type {"local" | "ci"} */ (resumeExecution)).then(
      () => "accepted",
      (error) => `${error.message} ${error.hint}`
    );
    // Assert
    expect(outcome).toContain(expectedOutcome);
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

  it("should leave OIDC and token registry authentication to the worker while rejecting browser authentication", async () => {
    // Arrange
    const browserJsr = resolveCreateVersionConfig({ publish: "jsr" });
    const oidcJsr = resolveCreateVersionConfig({ publish: "jsr", publication: { authentication: "oidc" } });
    const tokenJsr = resolveCreateVersionConfig({ publish: "jsr", publication: { authentication: "token" } });
    // Act and Assert
    const root = createTemporaryDirectory("beez-rp-ci-auth-");
    // Act and Assert
    await expect(assertCiCompatiblePublication(browserJsr, root)).rejects.toThrow(/no puede publicar desde GitHub Actions/);
    await expect(assertCiCompatiblePublication(oidcJsr, root)).resolves.toBeUndefined();
    await expect(assertCiCompatiblePublication(tokenJsr, root)).resolves.toBeUndefined();
    await expect(assertCiCompatiblePublication(resolveCreateVersionConfig({ publish: "npm" }), root)).resolves.toBeUndefined();
  });

  it.each([
    { packageManager: "npm@10.9.0", authentication: "oidc", accepted: false },
    { packageManager: "npm@11.5.0", authentication: "oidc", accepted: false },
    { packageManager: "npm@11.5.1-rc.1", authentication: "oidc", accepted: false },
    { packageManager: "npm@11.4", authentication: "oidc", accepted: false },
    { packageManager: "npm@10", authentication: "oidc", accepted: false },
    { packageManager: "npm@11.5.1", authentication: "oidc", accepted: true },
    { packageManager: "npm@11.5.1+sha512.abc123", authentication: "oidc", accepted: true },
    { packageManager: "npm@11.5", authentication: "oidc", accepted: true },
    { packageManager: "npm@11", authentication: "oidc", accepted: true },
    { packageManager: "npm@12.0.0-beta.1", authentication: "oidc", accepted: true },
    { packageManager: "npm@10.9.0", authentication: "token", accepted: true },
  ])("should accept the worker's pinned $packageManager with $authentication npm publication only when it can publish: $accepted", async ({ packageManager, authentication, accepted }) => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-npm-pin-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-npm-pin", version: "1.0.0", packageManager }));
    writeFileSync(path.join(root, "beez-rp.config.mjs"), `export default { publish: 'npm', publication: { authentication: '${authentication}' } };\n`);
    const config = await loadCreateVersionConfig(root);
    commitFixtureRepository(root);
    // Act
    let rejectionMessage = null;
    try {
      await assertCiCompatiblePublication(config, root);
    } catch (error) {
      rejectionMessage = error instanceof Error ? error.message : String(error);
    }
    // Assert
    expect(rejectionMessage === null).toBe(accepted);
    expect(/requiere npm >= 11\.5\.1/u.test(rejectionMessage ?? "")).toBe(!accepted);
  });

  it.each([
    { packageManager: "pnpm@10.12.1", nvmrc: "22.13", authentication: "oidc", accepted: false },
    { packageManager: "pnpm@10.12.1", nvmrc: "v22.13.0\n", authentication: "oidc", accepted: false },
    { packageManager: "yarn@4.9.2", nvmrc: "20", authentication: "oidc", accepted: false },
    { packageManager: "bun@1.2.15", nvmrc: "22.14.0-rc.1", authentication: "oidc", accepted: false },
    { packageManager: "npm@11.5.1", nvmrc: "22.13.1", authentication: "oidc", accepted: false },
    { packageManager: "pnpm@10.12.1", nvmrc: "22", authentication: "oidc", accepted: true },
    { packageManager: "pnpm@10.12.1", nvmrc: "22.14.0", authentication: "oidc", accepted: true },
    { packageManager: "yarn@4.9.2", nvmrc: "24", authentication: "oidc", accepted: true },
    { packageManager: "pnpm@10.12.1", nvmrc: "lts/*", authentication: "oidc", accepted: true },
    { packageManager: "pnpm@10.12.1", nvmrc: null, authentication: "oidc", accepted: true },
    { packageManager: "pnpm@10.12.1", nvmrc: "22.13", authentication: "token", accepted: true },
  ])("should accept the worker's Node $nvmrc with $packageManager and $authentication npm publication only when it can publish: $accepted", async ({ packageManager, nvmrc, authentication, accepted }) => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-node-pin-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-node-pin", version: "1.0.0", packageManager }));
    if (nvmrc !== null) writeFileSync(path.join(root, ".nvmrc"), nvmrc);
    writeFileSync(path.join(root, "beez-rp.config.mjs"), `export default { publish: 'npm', publication: { authentication: '${authentication}' } };\n`);
    const config = await loadCreateVersionConfig(root);
    commitFixtureRepository(root);
    // Act
    let rejectionMessage = null;
    try {
      await assertCiCompatiblePublication(config, root);
    } catch (error) {
      rejectionMessage = error instanceof Error ? error.message : String(error);
    }
    // Assert
    expect(rejectionMessage === null).toBe(accepted);
    expect(/requiere Node >= 22\.14\.0/u.test(rejectionMessage ?? "")).toBe(!accepted);
  });

  it.each([
    { scenario: "publishConfig.registry on a private host", packageName: "fixture-npm-registry", publishConfig: { registry: "https://npm.example.test/" }, publication: {}, npmrc: null, authentication: "oidc", accepted: false },
    { scenario: "publication.registryUrl on a private host", packageName: "fixture-npm-registry", publishConfig: null, publication: { registryUrl: "https://npm.example.test/" }, npmrc: null, authentication: "oidc", accepted: false },
    { scenario: "publishConfig.registry on GitHub Packages", packageName: "@fixture/npm-registry", publishConfig: { registry: "https://npm.pkg.github.com/" }, publication: {}, npmrc: null, authentication: "oidc", accepted: false },
    { scenario: "the project .npmrc registry on a private host", packageName: "fixture-npm-registry", publishConfig: null, publication: {}, npmrc: "registry=https://npm.example.test/\n", authentication: "oidc", accepted: false },
    { scenario: "publication.registryUrl on the public npm registry", packageName: "fixture-npm-registry", publishConfig: null, publication: { registryUrl: "https://registry.npmjs.org" }, npmrc: null, authentication: "oidc", accepted: true },
    { scenario: "the default npm registry", packageName: "fixture-npm-registry", publishConfig: null, publication: {}, npmrc: null, authentication: "oidc", accepted: true },
    { scenario: "publishConfig.registry on a private host", packageName: "fixture-npm-registry", publishConfig: { registry: "https://npm.example.test/" }, publication: {}, npmrc: null, authentication: "token", accepted: true },
  ])("should accept $authentication npm publication to $scenario before creating the CI release only when trusted publishing can reach it: $accepted", async ({ packageName, publishConfig, publication, npmrc, authentication, accepted }) => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-npm-registry-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0", packageManager: "npm@11.5.1", ...(publishConfig ? { publishConfig } : {}) }));
    if (npmrc !== null) writeFileSync(path.join(root, ".npmrc"), npmrc);
    writeFileSync(path.join(root, "beez-rp.config.mjs"), `export default { publish: 'npm', publication: ${JSON.stringify({ ...publication, authentication })} };\n`);
    const config = await loadCreateVersionConfig(root);
    commitFixtureRepository(root);
    // Act
    let rejectionMessage = null;
    try {
      await assertCiCompatiblePublication(config, root);
    } catch (error) {
      rejectionMessage = error instanceof Error ? error.message : String(error);
    }
    // Assert
    expect(rejectionMessage === null).toBe(accepted);
    expect(/OIDC de npm requiere el registry público de npm/u.test(rejectionMessage ?? "")).toBe(!accepted);
  });

  it.each([
    { packageManager: "pnpm@10.12.1", authentication: "oidc", installsNpmClient: true },
    { packageManager: "yarn@4.9.2", authentication: "oidc", installsNpmClient: true },
    { packageManager: "bun@1.2.15", authentication: "oidc", installsNpmClient: true },
    { packageManager: "npm@11.5.1", authentication: "oidc", installsNpmClient: false },
    { packageManager: "pnpm@10.12.1", authentication: "token", installsNpmClient: false },
  ])("should install the npm trusted publishing client after Node.js for $packageManager with $authentication npm publication: $installsNpmClient", async ({ packageManager, authentication, installsNpmClient }) => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-npm-client-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-npm-client", version: "1.0.0", packageManager }));
    writeFileSync(path.join(root, "beez-rp.config.mjs"), `export default { publish: 'npm', publication: { authentication: '${authentication}' }, ci: { workflow: 'release.yml' } };\n`);
    const config = await loadCreateVersionConfig(root);
    commitFixtureRepository(root);
    // Act
    const workflow = await renderCiReleaseWorkflow(root, config);
    const stepNames = [...readWorkflowEnvironmentScopes(workflow).stepEnvironments.keys()];
    // Assert
    const clientStepIndex = stepNames.indexOf("Configurar npm para trusted publishing");
    expect(clientStepIndex).toBe(installsNpmClient ? stepNames.indexOf("Configurar Node.js") + 1 : -1);
    expect(workflow.includes("npm install --global npm@11.5.1")).toBe(installsNpmClient || packageManager === "npm@11.5.1");
  });

  it.each([
    { authentication: "oidc", installsNpmClient: true },
    { authentication: "token", installsNpmClient: false },
  ])("should install the npm trusted publishing client after npm ci for an unpinned package-lock.json project with $authentication npm publication: $installsNpmClient", async ({ authentication, installsNpmClient }) => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-npm-unpinned-");
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-npm-unpinned", version: "1.0.0" }));
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ name: "fixture-npm-unpinned", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {} }));
    writeFileSync(path.join(root, "beez-rp.config.mjs"), `export default { publish: 'npm', publication: { authentication: '${authentication}' }, ci: { workflow: 'release.yml' } };\n`);
    const config = await loadCreateVersionConfig(root);
    commitFixtureRepository(root);
    // Act
    const workflow = await renderCiReleaseWorkflow(root, config);
    const stepNames = [...readWorkflowEnvironmentScopes(workflow).stepEnvironments.keys()];
    // Assert
    expect(config.commands.packageManager).toBe("npm");
    expect(stepNames).not.toContain("Configurar npm");
    expect(stepNames.indexOf("Configurar npm para trusted publishing")).toBe(installsNpmClient ? stepNames.indexOf("Instalar dependencias") + 1 : -1);
    expect(workflow.includes("npm install --global npm@11.5.1")).toBe(installsNpmClient);
  });

  it.each([
    { argv: ["--bump", "patch"], regenerateWorkflow: false },
    { argv: ["--setup-ci", "--bump", "patch"], regenerateWorkflow: true },
  ])("should reject OIDC npm publication from a pnpm project whose .nvmrc predates trusted publishing before creating the CI release for $argv", async ({ argv, regenerateWorkflow }) => {
    // Arrange
    const registry = await startFixtureNpmRegistry({ users: { "fixture-owner-token": "fixture-owner" }, packages: { "fixture-ci-app": { maintainers: ["fixture-owner"], versions: ["1.2.3"] } } });
    try {
      const { root, remote } = createCiProject();
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      const lowNodeSha = commitProjectConfig(root, "export default { checks: ['node checks.mjs'], publish: 'npm', publication: { authentication: 'oidc' }, ci: { workflow: 'release.yml' } };\n", { "package.json": JSON.stringify({ ...manifest, packageManager: "pnpm@10.12.1", publishConfig: { registry: registry.registryUrl } }), ".nvmrc": "22.13\n" });
      const configuredSha = regenerateWorkflow ? commitGeneratedWorkflow(root) : lowNodeSha;
      const github = isolateGithub();
      // Act
      const status = await runCreateVersion({ repositoryRoot: root, argv });
      // Assert
      expect(status).toBe(1);
      expect(runGit(["rev-parse", "HEAD"], root)).toBe(configuredSha);
      expect(runGit(["rev-parse", "main"], remote)).toBe(configuredSha);
      expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
      expect(github.preflight).not.toHaveBeenCalled();
      expect(github.dispatch).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { argv: ["--bump", "patch"], regenerateWorkflow: false },
    { argv: ["--setup-ci", "--bump", "patch"], regenerateWorkflow: true },
  ])("should reject OIDC npm publication pinned below the trusted publishing minimum before creating the CI release for $argv", async ({ argv, regenerateWorkflow }) => {
    // Arrange
    const registry = await startFixtureNpmRegistry({ users: { "fixture-owner-token": "fixture-owner" }, packages: { "fixture-ci-app": { maintainers: ["fixture-owner"], versions: ["1.2.3"] } } });
    try {
      const { root, remote } = createCiProject();
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      const lowPinSha = commitProjectConfig(root, "export default { checks: ['node checks.mjs'], publish: 'npm', publication: { authentication: 'oidc' }, ci: { workflow: 'release.yml' } };\n", { "package.json": JSON.stringify({ ...manifest, packageManager: "npm@10.9.0", publishConfig: { registry: registry.registryUrl } }) });
      const configuredSha = regenerateWorkflow ? commitGeneratedWorkflow(root) : lowPinSha;
      const github = isolateGithub();
      // Act
      const status = await runCreateVersion({ repositoryRoot: root, argv });
      // Assert
      expect(status).toBe(1);
      expect(runGit(["rev-parse", "HEAD"], root)).toBe(configuredSha);
      expect(runGit(["rev-parse", "main"], remote)).toBe(configuredSha);
      expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
      expect(github.preflight).not.toHaveBeenCalled();
      expect(github.dispatch).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { packageManager: "npm@10.9.0", rejectedBy: "the npm pin" },
    { packageManager: "npm@11.5.1", rejectedBy: "the non-public registry" },
  ])("should refuse to retry an OIDC npm release through CI with $packageManager because of $rejectedBy", async ({ packageManager }) => {
    // Arrange
    const registry = await startFixtureNpmRegistry({ users: { "fixture-owner-token": "fixture-owner" }, packages: { "fixture-ci-app": { maintainers: ["fixture-owner"], versions: ["1.2.3"] } } });
    try {
      const { root, remote } = createCiProject();
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      commitProjectConfig(root, "export default { checks: ['node checks.mjs'], publish: 'npm', publication: { authentication: 'oidc' }, ci: { workflow: 'release.yml' } };\n", { "package.json": JSON.stringify({ ...manifest, packageManager, publishConfig: { registry: registry.registryUrl } }) });
      const github = isolateGithub();
      // Act
      const status = await runCreateVersion({ repositoryRoot: root, argv: ["--retry-ci", "v1.2.3"] });
      // Assert
      expect(status).toBe(1);
      expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
      expect(github.preflight).not.toHaveBeenCalled();
      expect(github.dispatch).not.toHaveBeenCalled();
    } finally {
      await registry.close();
    }
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { argv: ["--bump", "patch"], regenerateWorkflow: false },
    { argv: ["--setup-ci", "--bump", "patch"], regenerateWorkflow: true },
  ])("should reject OIDC npm publication whose publishConfig.registry is not the public npm registry before creating the CI release for $argv", async ({ argv, regenerateWorkflow }) => {
    // Arrange
    const registry = await startFixtureNpmRegistry({ users: { "fixture-owner-token": "fixture-owner" }, packages: { "fixture-ci-app": { maintainers: ["fixture-owner"], versions: ["1.2.3"] } } });
    try {
      const { root, remote } = createCiProject();
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      const privateRegistrySha = commitProjectConfig(root, "export default { checks: ['node checks.mjs'], publish: 'npm', publication: { authentication: 'oidc' }, ci: { workflow: 'release.yml' } };\n", { "package.json": JSON.stringify({ ...manifest, packageManager: "npm@11.5.1", publishConfig: { registry: registry.registryUrl } }) });
      const configuredSha = regenerateWorkflow ? commitGeneratedWorkflow(root) : privateRegistrySha;
      const github = isolateGithub();
      // Act
      const status = await runCreateVersion({ repositoryRoot: root, argv });
      // Assert
      expect(status).toBe(1);
      expect(runGit(["rev-parse", "HEAD"], root)).toBe(configuredSha);
      expect(runGit(["rev-parse", "main"], remote)).toBe(configuredSha);
      expect(runGit(["tag", "--list"], remote)).toBe("v1.2.3");
      expect(github.preflight).not.toHaveBeenCalled();
      expect(github.dispatch).not.toHaveBeenCalled();
      expect(registry.publications).toEqual([]);
    } finally {
      await registry.close();
    }
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);
});
