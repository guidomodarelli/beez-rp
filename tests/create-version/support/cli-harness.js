/**
 * Harness of the end-to-end `create-version` tests: an isolated environment
 * (no inherited npm token or registry, a temporary home, no colors), Git
 * helpers and the real CLI run as a child process.
 *
 * @module tests/create-version/support/cli-harness
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Real Git fixtures with a bare remote can exceed the default timeout on Windows. */
export const GIT_FIXTURE_TEST_TIMEOUT_MS = 60_000;

/** Token the fixture registry accepts for the package owner; not a real credential. */
export const OWNER_TOKEN = "fixture-owner-token";

/** npm user of {@link OWNER_TOKEN}. */
export const OWNER_USER = "fixture-owner";

/** Git variables exported by hooks that would redirect fixture commands. */
const GIT_HOOK_ENVIRONMENT_VARIABLES = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"];

/**
 * Variables of the test runner that would change the token or the registry the command resolves:
 * the command under test only sees the ones each test sets.
 */
const ISOLATED_NPM_VARIABLE_PATTERN = /^(?:npm_config_(?:@[^:]+:)?registry|npm_token)$/iu;

/** Box borders removed by {@link flattenOutput}. */
const BOX_BORDER_PATTERN = /[│╭╮╰╯─]/gu;

/** Command line entrypoint exercised end to end. */
const CLI_PATH = fileURLToPath(new URL("../../../bin/beez-rp.js", import.meta.url));

/** Directories created by the current test, removed by {@link cleanupTemporaryDirectories}. */
export const temporaryDirectories = /** @type {string[]} */ ([]);

/**
 * @param {string} prefix - Directory name prefix.
 * @returns {string} New temporary directory, removed after the test.
 */
export function createTemporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Removes every directory {@link createTemporaryDirectory} created. */
export function cleanupTemporaryDirectories() {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** @returns {NodeJS.ProcessEnv} Environment without Git hook redirections. */
export function cleanEnvironment() {
  const environment = { ...process.env };
  for (const variableName of GIT_HOOK_ENVIRONMENT_VARIABLES) delete environment[variableName];
  return environment;
}

/**
 * Environment of the command under test: no inherited npm token nor registry, and a temporary home
 * (`HOME`/`USERPROFILE`) so the user's real `~/.config/beez-rp/.env` never leaks in.
 *
 * @param {NodeJS.ProcessEnv} [overrides] - Variables the test sets, such as `NPM_TOKEN`.
 * @returns {NodeJS.ProcessEnv} Environment.
 */
export function commandEnvironment(overrides = {}) {
  const temporaryHome = createTemporaryDirectory("beez-rp-cli-home-");
  const environment = Object.fromEntries(Object.entries(cleanEnvironment()).filter(([variableName]) => !ISOLATED_NPM_VARIABLE_PATTERN.test(variableName)));
  // FORCE_COLOR wins over NO_COLOR, and the ANSI codes it adds split the messages the tests match.
  delete environment.FORCE_COLOR;
  return { ...environment, HOME: temporaryHome, USERPROFILE: temporaryHome, NO_COLOR: "1", ...overrides };
}

/**
 * Joins the output without box borders nor line wrapping, so long messages can be matched whole.
 *
 * @param {string} output - Command output.
 * @returns {string} Output on a single line with single spaces.
 */
export function flattenOutput(output) {
  return output.replace(BOX_BORDER_PATTERN, " ").replace(/\s+/gu, " ");
}

/**
 * @param {string[]} gitArguments - Git arguments.
 * @param {string} workingDirectory - Repository.
 * @returns {string} Trimmed stdout.
 */
export function runGit(gitArguments, workingDirectory) {
  const result = spawnSync("git", gitArguments, { cwd: workingDirectory, encoding: "utf8", env: cleanEnvironment() });

  if (result.status !== 0) {
    throw new Error(`git ${gitArguments.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout.trim();
}

/**
 * Turns a fixture directory into a Git repository (when it is not one yet) and commits every file,
 * so code that reads HEAD, as the CI worker sees the release commit, finds the fixture content.
 *
 * @param {string} repositoryRoot - Fixture directory.
 * @returns {string} Commit SHA at HEAD.
 */
export function commitFixtureRepository(repositoryRoot) {
  runGit(["init", "--quiet", "--initial-branch=main"], repositoryRoot);
  for (const [name, value] of [["user.name", "Release Fixture"], ["user.email", "release@example.test"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) runGit(["config", name, value], repositoryRoot);
  runGit(["add", "-A"], repositoryRoot);
  runGit(["commit", "--quiet", "--allow-empty", "-m", "fixture"], repositoryRoot);
  return runGit(["rev-parse", "HEAD"], repositoryRoot);
}

/**
 * @param {string} repositoryRoot - Checkout used as working directory.
 * @param {string[]} commandArguments - Arguments after `create-version`.
 * @returns {{ status: number | null, output: string }} Exit code and combined output.
 */
export function runCli(repositoryRoot, commandArguments) {
  const result = spawnSync(process.execPath, [CLI_PATH, "create-version", ...commandArguments], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: commandEnvironment(),
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Runs the command without blocking the event loop, so a fixture registry in this process can answer npm.
 *
 * @param {string} repositoryRoot - Checkout used as working directory.
 * @param {string[]} commandArguments - Arguments after `create-version`.
 * @param {NodeJS.ProcessEnv} [environmentOverrides] - Variables such as `NPM_TOKEN`.
 * @returns {Promise<{ status: number | null, output: string }>} Exit code and combined output.
 */
export function runCliAsync(repositoryRoot, commandArguments, environmentOverrides = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, "create-version", ...commandArguments], { cwd: repositoryRoot, env: commandEnvironment(environmentOverrides) });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.on("close", (status) => resolve({ status, output }));
  });
}
