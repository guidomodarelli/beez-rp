/**
 * Behavior of the generated workflow step that authenticates a dispatched release before any
 * project-controlled code runs. The rendered Bash script is executed against real Git checkouts.
 * @module tests/create-version/ci-release-identity-step
 */

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { resolveCreateVersionConfig } from "../../src/create-version/config.js";
import { renderCiReleaseWorkflow } from "../../src/create-version/ci-setup.js";
import { CI_RELEASE_IDENTITY_STEP_NAME } from "../../src/constants/ci-release.js";
import { GIT_FIXTURE_TEST_TIMEOUT_MS, cleanupTemporaryDirectories, commandEnvironment, commitFixtureRepository, createTemporaryDirectory, runGit } from "./support/cli-harness.js";

/** @typedef {{ worker: string, releaseSha: string, unmergedSha: string }} ReleaseOrigin */

/** Step-level indentation of a generated job step. */
const STEP_LINE_PATTERN = /^ {6}- name: (.+)$/u;

/** Indentation of the `run: |` body inside a generated job step. */
const STEP_SCRIPT_INDENT = " ".repeat(10);

/**
 * Renders the default workflow for a minimal committed project.
 * @param {string} root - Project directory receiving a `package.json`.
 * @returns {Promise<string>} Generated GitHub Actions YAML.
 */
async function renderFixtureWorkflow(root) {
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-identity-app", version: "1.2.3", packageManager: "npm@11.11.1" }));
  commitFixtureRepository(root);
  return renderCiReleaseWorkflow(root, resolveCreateVersionConfig({ checks: ["node checks.mjs"], ci: { workflow: "release.yml" } }));
}

/**
 * Lists the step names of a generated workflow in execution order.
 * @param {string} workflow - Generated GitHub Actions YAML.
 * @returns {string[]} Step names.
 */
function readStepNames(workflow) {
  return workflow.split("\n").map((line) => STEP_LINE_PATTERN.exec(line)?.[1]).filter((name) => name !== undefined);
}

/**
 * Extracts one step's `env` names and `run: |` script from a generated workflow.
 * @param {string} workflow - Generated GitHub Actions YAML.
 * @param {string} stepName - Step to extract.
 * @returns {{ environmentNames: string[], script: string }} Bound names and unindented script.
 */
function readStep(workflow, stepName) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`      - name: ${stepName}`);
  const end = lines.findIndex((line, index) => index > start && STEP_LINE_PATTERN.test(line));
  const body = lines.slice(start + 1, end === -1 ? lines.length : end);
  const runIndex = body.indexOf("        run: |");
  const environmentNames = body.slice(0, runIndex).map((line) => /^ {10}([A-Z][A-Z0-9_]*):/u.exec(line)?.[1]).filter((name) => name !== undefined);
  const script = body.slice(runIndex + 1).filter((line) => line.startsWith(STEP_SCRIPT_INDENT)).map((line) => line.slice(STEP_SCRIPT_INDENT.length)).join("\n");
  return { environmentNames, script };
}

/**
 * Creates an origin whose `main` holds the annotated release tag `v1.2.3`, plus an unmerged
 * collaborator branch tagged `v1.2.4`, and a worker clone checked out like `actions/checkout` does.
 * @returns {ReleaseOrigin} Worker checkout and commit identities.
 */
function createReleaseOrigin() {
  const fixture = createTemporaryDirectory("beez-rp-ci-identity-");
  const remote = path.join(fixture, "origin.git");
  const author = path.join(fixture, "author");
  runGit(["init", "--quiet", "--bare", "--initial-branch=main", remote], fixture);
  runGit(["clone", "--quiet", remote, author], fixture);
  for (const [name, value] of [["user.name", "Release Fixture"], ["user.email", "release@example.test"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"], ["core.autocrlf", "false"]]) runGit(["config", name, value], author);
  writeFileSync(path.join(author, "package.json"), JSON.stringify({ name: "fixture-identity-app", version: "1.2.3" }));
  runGit(["add", "-A"], author);
  runGit(["commit", "--quiet", "-m", "1.2.3"], author);
  runGit(["tag", "-a", "v1.2.3", "-m", "1.2.3"], author);
  runGit(["push", "--quiet", "origin", "main", "--tags"], author);
  const releaseSha = runGit(["rev-parse", "HEAD"], author);
  runGit(["checkout", "--quiet", "-b", "collaborator"], author);
  writeFileSync(path.join(author, "package.json"), JSON.stringify({ name: "fixture-identity-app", version: "1.2.4", scripts: { preinstall: "node steal-secrets.js" } }));
  runGit(["commit", "--quiet", "-am", "1.2.4"], author);
  runGit(["tag", "-a", "v1.2.4", "-m", "1.2.4"], author);
  runGit(["push", "--quiet", "origin", "collaborator", "--tags"], author);
  const unmergedSha = runGit(["rev-parse", "HEAD"], author);
  const worker = path.join(fixture, "worker");
  runGit(["clone", "--quiet", remote, worker], fixture);
  return { worker, releaseSha, unmergedSha };
}

/**
 * Runs the rendered identity script the way the generated workflow does, from a checkout of `checkoutRef`.
 * @param {string} worker - Worker clone.
 * @param {string} script - Rendered Bash script.
 * @param {string} checkoutRef - Ref the worker checks out before the step.
 * @param {{ version: string, tag: string, sha: string }} inputs - Dispatched workflow inputs.
 * @returns {import("node:child_process").SpawnSyncReturns<string>} Script outcome.
 */
function runIdentityScript(worker, script, checkoutRef, inputs) {
  runGit(["checkout", "--quiet", "--detach", checkoutRef], worker);
  const scriptPath = path.join(worker, "..", "identity.sh");
  writeFileSync(scriptPath, `${script}\n`);
  return spawnSync("bash", [scriptPath], { cwd: worker, encoding: "utf8", env: commandEnvironment({ BEEZ_RP_RELEASE_VERSION: inputs.version, BEEZ_RP_RELEASE_SHA: inputs.sha, RELEASE_TAG: inputs.tag }) });
}

afterEach(() => {
  cleanupTemporaryDirectories();
});

describe("generated release identity step", () => {
  it("should authenticate the release right after checkout and before any toolchain or dependency setup, without secrets", async () => {
    // Arrange
    const root = createTemporaryDirectory("beez-rp-ci-identity-order-");
    // Act
    const workflow = await renderFixtureWorkflow(root);
    const stepNames = readStepNames(workflow);
    // Assert
    expect(stepNames.indexOf(CI_RELEASE_IDENTITY_STEP_NAME)).toBe(stepNames.indexOf("Checkout del release") + 1);
    expect(stepNames.indexOf(CI_RELEASE_IDENTITY_STEP_NAME)).toBeLessThan(stepNames.indexOf("Configurar Node.js"));
    expect(stepNames.indexOf(CI_RELEASE_IDENTITY_STEP_NAME)).toBeLessThan(stepNames.indexOf("Instalar dependencias"));
    expect(readStep(workflow, CI_RELEASE_IDENTITY_STEP_NAME).environmentNames.toSorted()).toEqual(["BEEZ_RP_RELEASE_SHA", "BEEZ_RP_RELEASE_VERSION", "RELEASE_TAG"]);
    expect(workflow).toContain("ref: refs/tags/${{ inputs.tag }}");
  });

  it("should accept a stable tag that resolves to the dispatched commit already merged into origin/main", async () => {
    // Arrange
    const { worker, releaseSha } = createReleaseOrigin();
    const { script } = readStep(await renderFixtureWorkflow(createTemporaryDirectory("beez-rp-ci-identity-render-")), CI_RELEASE_IDENTITY_STEP_NAME);
    // Act
    const result = runIdentityScript(worker, script, "refs/tags/v1.2.3", { version: "1.2.3", tag: "v1.2.3", sha: releaseSha });
    // Assert
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);

  it.each([
    { scenario: "a branch name instead of a release tag", checkoutRef: "origin/collaborator", inputs: (/** @type {ReleaseOrigin} */ { unmergedSha }) => ({ version: "1.2.4", tag: "collaborator", sha: unmergedSha }), message: "no es el tag de release" },
    { scenario: "a tag that does not match the dispatched version", checkoutRef: "refs/tags/v1.2.3", inputs: (/** @type {ReleaseOrigin} */ { releaseSha }) => ({ version: "1.2.4", tag: "v1.2.3", sha: releaseSha }), message: "no es el tag de release" },
    { scenario: "an unstable version", checkoutRef: "refs/tags/v1.2.3", inputs: (/** @type {ReleaseOrigin} */ { releaseSha }) => ({ version: "1.2.3-rc.1", tag: "v1.2.3-rc.1", sha: releaseSha }), message: "no es una versión estable" },
    { scenario: "an abbreviated commit", checkoutRef: "refs/tags/v1.2.3", inputs: (/** @type {ReleaseOrigin} */ { releaseSha }) => ({ version: "1.2.3", tag: "v1.2.3", sha: releaseSha.slice(0, 12) }), message: "no es un commit completo" },
    { scenario: "a commit different from the tag", checkoutRef: "refs/tags/v1.2.3", inputs: (/** @type {ReleaseOrigin} */ { unmergedSha }) => ({ version: "1.2.3", tag: "v1.2.3", sha: unmergedSha }), message: "apunta a" },
    { scenario: "a missing tag", checkoutRef: "refs/tags/v1.2.3", inputs: (/** @type {ReleaseOrigin} */ { releaseSha }) => ({ version: "9.9.9", tag: "v9.9.9", sha: releaseSha }), message: "no existe como tag" },
    { scenario: "a checkout that is not the tagged commit", checkoutRef: "origin/collaborator", inputs: (/** @type {ReleaseOrigin} */ { releaseSha }) => ({ version: "1.2.3", tag: "v1.2.3", sha: releaseSha }), message: "El checkout no está en el commit" },
    { scenario: "a collaborator tag outside origin/main", checkoutRef: "refs/tags/v1.2.4", inputs: (/** @type {ReleaseOrigin} */ { unmergedSha }) => ({ version: "1.2.4", tag: "v1.2.4", sha: unmergedSha }), message: "no está en origin/main" },
  ])("should stop before installing dependencies when dispatched with $scenario", async ({ checkoutRef, inputs, message }) => {
    // Arrange
    const origin = createReleaseOrigin();
    const { script } = readStep(await renderFixtureWorkflow(createTemporaryDirectory("beez-rp-ci-identity-render-")), CI_RELEASE_IDENTITY_STEP_NAME);
    // Act
    const result = runIdentityScript(origin.worker, script, checkoutRef, inputs(origin));
    // Assert
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stdout).toContain("::error title=Release no autorizado::");
    expect(result.stdout).toContain(message);
  }, GIT_FIXTURE_TEST_TIMEOUT_MS);
});
