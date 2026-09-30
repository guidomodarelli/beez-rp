/**
 * Process and Git helpers of `beez-rp create-version`: captured and inherited
 * commands that never reject, a Git reader bound to a repository, commit
 * listing and manifest reads at any revision.
 *
 * @module create-version/process
 */

import { spawn } from "node:child_process";

import { FIELD_SEPARATOR, PACKAGE_MANIFEST_FILE, RECORD_SEPARATOR } from "../constants/create-version.js";

/**
 * @typedef {{ status: number, stdout: string, stderr: string }} CapturedResult
 * @typedef {{ cwd?: string, shell?: boolean, env?: NodeJS.ProcessEnv }} CommandOptions
 * @typedef {{ git: (gitArguments: string[]) => Promise<string>, tryGit: (gitArguments: string[]) => Promise<string | null> }} GitReader
 * @typedef {{ sha: string, subject: string, body: string }} CommitRecord
 */

/** Windows resolves `pnpm.cmd`, `npm.cmd` and `codex.cmd` only through a shell. */
export const USES_SHELL_FOR_PACKAGE_MANAGERS = process.platform === "win32";

/**
 * Runs a command and captures its output. Leading whitespace is kept because
 * `git status --porcelain` encodes the file state in the first columns.
 *
 * @param {string} command - Executable name, or a full command line when `shell` is set.
 * @param {string[]} commandArguments - Arguments.
 * @param {CommandOptions} [options] - Spawn options.
 * @returns {Promise<CapturedResult>} Result; never rejects.
 */
export function runCaptured(command, commandArguments, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArguments, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout: stdout.trimEnd(), stderr: stderr.trim() }));
  });
}

/**
 * Runs a command with inherited stdio so its progress stays visible.
 *
 * @param {string} command - Executable name, or a full command line when `shell` is set.
 * @param {string[]} commandArguments - Arguments.
 * @param {CommandOptions} [options] - Spawn options.
 * @returns {Promise<number>} Exit code; never rejects.
 */
export function runInherited(command, commandArguments, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArguments, { cwd: options.cwd, env: options.env, shell: options.shell ?? false, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (status) => resolve(status ?? 1));
  });
}

/**
 * Runs a trusted, configured command line (for example `pnpm check`) through the shell.
 *
 * @param {string} commandLine - Command line written in the project configuration, never user input.
 * @param {string} cwd - Working directory.
 * @returns {Promise<number>} Exit code; never rejects.
 */
export function runCommandLine(commandLine, cwd) {
  return runInherited(commandLine, [], { cwd, shell: true });
}

/**
 * Reads a Git blob byte for byte (unlike {@link runCaptured}, which trims the output), for content
 * whose trailing whitespace matters, such as the target of a committed symbolic link.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} object - Blob object name.
 * @returns {Promise<Buffer | null>} Blob bytes, or `null` when Git cannot read it; never rejects.
 */
export function readGitBlob(repositoryRoot, object) {
  return new Promise((resolve) => {
    const child = spawn("git", ["cat-file", "blob", object], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    /** @type {Buffer[]} */
    const chunks = [];

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (status) => resolve(status === 0 ? Buffer.concat(chunks) : null));
  });
}

/**
 * Creates a Git reader bound to a repository.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {GitReader} Readers.
 */
export function createGitReader(repositoryRoot) {
  /** @param {string[]} gitArguments */
  const tryGit = async (gitArguments) => {
    const result = await runCaptured("git", gitArguments, { cwd: repositoryRoot });
    return result.status === 0 ? result.stdout : null;
  };

  /** @param {string[]} gitArguments */
  const git = async (gitArguments) => {
    const result = await runCaptured("git", gitArguments, { cwd: repositoryRoot });

    if (result.status !== 0) {
      throw new Error(`beez-rp create-version: git ${gitArguments.join(" ")} failed in ${repositoryRoot}: ${result.stderr}`);
    }

    return result.stdout;
  };

  return { git, tryGit };
}

/**
 * Parses `git log` records produced with {@link FIELD_SEPARATOR} and {@link RECORD_SEPARATOR}.
 *
 * @param {string} output - Raw `git log` output.
 * @returns {CommitRecord[]} Commits, newest first.
 */
export function parseCommitLog(output) {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split(FIELD_SEPARATOR);
      return { sha, subject, body: body.trim() };
    });
}

/**
 * Lists the commits of a revision range.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} range - Revision range such as `abc..origin/main`.
 * @returns {Promise<CommitRecord[]>} Commits, newest first.
 */
export async function listCommits(reader, range) {
  const output = await reader.tryGit(["log", `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`, range]);
  return output ? parseCommitLog(output) : [];
}

/**
 * Reads `package.json` at a revision.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} revision - Revision such as `HEAD`, `v1.2.0` or `origin/main`.
 * @returns {Promise<Record<string, unknown> | null>} Parsed manifest, or `null` when missing, unreadable or not a JSON object.
 */
export async function readPackageManifestAt(reader, revision) {
  const manifest = await reader.tryGit(["show", `${revision}:${PACKAGE_MANIFEST_FILE}`]);

  try {
    const parsed = manifest ? JSON.parse(manifest) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads the `version` field of `package.json` at a revision.
 *
 * @param {GitReader} reader - Git reader.
 * @param {string} revision - Revision such as `HEAD` or `origin/main`.
 * @returns {Promise<string | null>} Version, or `null` when unreadable.
 */
export async function readPackageVersionAt(reader, revision) {
  const manifest = await readPackageManifestAt(reader, revision);
  return typeof manifest?.version === "string" ? manifest.version : null;
}
