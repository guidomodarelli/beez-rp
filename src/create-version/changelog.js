/**
 * Verifies manually maintained changelogs without creating, rewriting or restoring their content.
 *
 * @module create-version/changelog
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { ReleaseStepError } from "./errors.js";

/**
 * @typedef {{ updated: boolean, reason: string | null }} ChangelogUpdateState
 * @typedef {{ filePath: string, originalBytes: Buffer }} PreservedReleaseFile
 * @typedef {{ repositoryRoot: string, reader: import("./process.js").GitReader, commands: import("../package-manager.js").ProjectCommands }} ChangelogContext
 */

/**
 * Compares a changelog with its last release using Git's normalized blob hashes. Local edits,
 * staged edits and committed edits all count; an initial release requires an existing file.
 *
 * @param {import("./process.js").GitReader} reader - Read-only Git adapter.
 * @param {string} repositoryRoot - Repository root.
 * @param {string} filePath - Changelog path relative to the repository root.
 * @param {string | null} releaseRevision - Last release commit, or `null` for an initial release.
 * @returns {Promise<ChangelogUpdateState>} Whether the file was updated, or why publication must stop.
 */
export async function readChangelogUpdateState(reader, repositoryRoot, filePath, releaseRevision) {
  const absolutePath = path.join(repositoryRoot, filePath);

  try {
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
      return { updated: false, reason: `${filePath} no existe como archivo regular.` };
    }

    if (!releaseRevision) {
      return { updated: true, reason: null };
    }

    const previousBlob = await reader.tryGit(["rev-parse", "--verify", `${releaseRevision}:${filePath}`]);
    const currentBlob = await reader.git(["hash-object", `--path=${filePath}`, "--", filePath]);
    return currentBlob !== previousBlob
      ? { updated: true, reason: null }
      : { updated: false, reason: `${filePath} no fue actualizado desde el último release (${releaseRevision}).` };
  } catch (error) {
    return { updated: false, reason: `No se pudo verificar ${filePath}: ${error instanceof Error ? error.message : String(error)}.` };
  }
}

/**
 * Requires a manual changelog update and captures its bytes for preservation checks.
 *
 * @param {ChangelogContext} context - Release context.
 * @param {string} filePath - Changelog path relative to the repository root.
 * @param {string | null} releaseRevision - Last release commit, or `null` for an initial release.
 * @returns {Promise<PreservedReleaseFile>} File whose content the release must leave untouched.
 * @throws {ReleaseStepError} When the changelog is missing, unchanged or cannot be read.
 */
export async function verifyChangelogUpdate(context, filePath, releaseRevision) {
  const update = await readChangelogUpdateState(context.reader, context.repositoryRoot, filePath, releaseRevision);
  const hint = `Actualizá ${filePath} manualmente y volvé a correr ${context.commands.createVersion}; beez-rp no lo modifica y no se tocó la versión.`;

  if (!update.updated) {
    throw new ReleaseStepError(update.reason ?? `${filePath} no fue actualizado.`, hint);
  }

  try {
    return { filePath, originalBytes: readFileSync(path.join(context.repositoryRoot, filePath)) };
  } catch (error) {
    throw new ReleaseStepError(`No se pudo leer ${filePath} para verificar el release.`, hint, { cause: error });
  }
}

/**
 * Stops when a check or hook changed a manually maintained release file. Its bytes are never restored.
 *
 * @param {ChangelogContext} context - Release context.
 * @param {readonly PreservedReleaseFile[]} files - Files captured before running release steps.
 * @returns {void}
 * @throws {ReleaseStepError} When a file changed, disappeared or cannot be read.
 */
export function assertPreservedFilesUnchanged(context, files) {
  for (const { filePath, originalBytes } of files) {
    let unchanged;
    try {
      const absolutePath = path.join(context.repositoryRoot, filePath);
      unchanged = lstatSync(absolutePath).isFile() && readFileSync(absolutePath).equals(originalBytes);
    } catch (error) {
      throw new ReleaseStepError(`Un paso anterior impide verificar ${filePath}.`, `Revisá el check o hook y volvé a correr ${context.commands.createVersion}; beez-rp no reescribe el CHANGELOG.`, { cause: error });
    }
    if (!unchanged) {
      throw new ReleaseStepError(`Un paso anterior modificó ${filePath}.`, `Revisá el check o hook y volvé a correr ${context.commands.createVersion}; beez-rp no reescribe ni restaura el CHANGELOG.`);
    }
  }
}
