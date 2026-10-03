/**
 * Exercises manual changelog verification with real Git repositories and preserved release files.
 *
 * @module tests/create-version/changelog
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assertPreservedFilesUnchanged, readChangelogUpdateState, verifyChangelogUpdate } from "../../src/create-version/changelog.js";
import { createGitReader } from "../../src/create-version/process.js";
import { DEFAULT_PROJECT_COMMANDS } from "../../src/package-manager.js";
import { cleanupTemporaryDirectories, createTemporaryDirectory, runGit } from "./support/cli-harness.js";

afterEach(cleanupTemporaryDirectories);

/**
 * Creates a repository whose first commit contains manually maintained release notes.
 *
 * @returns {{ repositoryRoot: string, releaseRevision: string, changelogPath: string, context: import("../../src/create-version/changelog.js").ChangelogContext }} Fixture and read-only release context.
 */
function createChangelogRepository() {
  const repositoryRoot = createTemporaryDirectory("beez-rp-manual-changelog-");
  runGit(["init", "--quiet", "--initial-branch=main"], repositoryRoot);
  runGit(["config", "user.email", "release@example.test"], repositoryRoot);
  runGit(["config", "user.name", "Release Fixture"], repositoryRoot);
  runGit(["config", "commit.gpgsign", "false"], repositoryRoot);
  runGit(["config", "core.autocrlf", "false"], repositoryRoot);
  const changelogPath = path.join(repositoryRoot, "CHANGELOG.md");
  writeFileSync(changelogPath, "# Release notes\n\n## 1.0.0\n\n- Primera versión.\n");
  runGit(["add", "CHANGELOG.md"], repositoryRoot);
  runGit(["commit", "--quiet", "-m", "release: 1.0.0"], repositoryRoot);
  const releaseRevision = runGit(["rev-parse", "HEAD"], repositoryRoot);
  return { repositoryRoot, releaseRevision, changelogPath, context: { repositoryRoot, reader: createGitReader(repositoryRoot), commands: DEFAULT_PROJECT_COMMANDS } };
}

describe("manual changelog verification", () => {
  it("should reject unchanged notes when they already contain release entries", async () => {
    // Arrange
    const { context, releaseRevision, changelogPath } = createChangelogRepository();
    const before = readFileSync(changelogPath);
    const modifiedAt = statSync(changelogPath).mtimeMs;

    // Act
    const state = await readChangelogUpdateState(context.reader, context.repositoryRoot, "CHANGELOG.md", releaseRevision);

    // Assert
    expect(state.updated).toBe(false);
    await expect(verifyChangelogUpdate(context, "CHANGELOG.md", releaseRevision)).rejects.toThrow("no fue actualizado desde el último release");
    expect(readFileSync(changelogPath)).toEqual(before);
    expect(statSync(changelogPath).mtimeMs).toBe(modifiedAt);
    expect(runGit(["status", "--porcelain"], context.repositoryRoot)).toBe("");
  });

  it.each(["unstaged", "staged", "committed"])("should preserve manual notes when the update is %s", async (updateState) => {
    // Arrange
    const { context, releaseRevision, changelogPath } = createChangelogRepository();
    writeFileSync(changelogPath, "# Notas propias\r\n\r\n## Próximo lanzamiento\r\n\r\n- Mejora escrita a mano.\r\n");
    if (updateState !== "unstaged") runGit(["add", "CHANGELOG.md"], context.repositoryRoot);
    if (updateState === "committed") runGit(["commit", "--quiet", "-m", "docs: update release notes"], context.repositoryRoot);
    const before = readFileSync(changelogPath);
    const modifiedAt = statSync(changelogPath).mtimeMs;
    const status = runGit(["status", "--porcelain"], context.repositoryRoot);

    // Act
    const preserved = await verifyChangelogUpdate(context, "CHANGELOG.md", releaseRevision);
    assertPreservedFilesUnchanged(context, [preserved]);

    // Assert
    expect(preserved.originalBytes).toEqual(before);
    expect(readFileSync(changelogPath)).toEqual(before);
    expect(statSync(changelogPath).mtimeMs).toBe(modifiedAt);
    expect(runGit(["status", "--porcelain"], context.repositoryRoot)).toBe(status);
  });

  it.each(["missing", "directory"])("should stop without creating notes when the changelog is a %s", async (fileState) => {
    // Arrange
    const { context, releaseRevision, changelogPath } = createChangelogRepository();
    rmSync(changelogPath);
    if (fileState === "directory") mkdirSync(changelogPath);

    // Act and Assert
    await expect(verifyChangelogUpdate(context, "CHANGELOG.md", releaseRevision)).rejects.toThrow("no existe como archivo regular");
    expect(runGit(["status", "--porcelain"], context.repositoryRoot)).toBe("D CHANGELOG.md");
  });

  it("should accept existing manual notes when there is no previous release", async () => {
    // Arrange
    const { context, changelogPath } = createChangelogRepository();
    const before = readFileSync(changelogPath);

    // Act
    const preserved = await verifyChangelogUpdate(context, "CHANGELOG.md", null);

    // Assert
    expect(preserved.originalBytes).toEqual(before);
    expect(runGit(["status", "--porcelain"], context.repositoryRoot)).toBe("");
  });

  it("should report a later change without restoring the manually maintained notes", async () => {
    // Arrange
    const { context, changelogPath } = createChangelogRepository();
    const preserved = await verifyChangelogUpdate(context, "CHANGELOG.md", null);
    writeFileSync(changelogPath, "# Notas modificadas por un check\n");
    const changed = readFileSync(changelogPath);

    // Act and Assert
    expect(() => assertPreservedFilesUnchanged(context, [preserved])).toThrow("Un paso anterior modificó CHANGELOG.md");
    expect(readFileSync(changelogPath)).toEqual(changed);
  });
});
