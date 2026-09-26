/**
 * Asks Codex to fill the CHANGELOG `[Unreleased]` block when a release finds it empty.
 *
 * The prompt travels through stdin (`codex exec -`), so the shell command stays a
 * fixed string on Windows, where `codex` is a `.cmd` shim that needs a shell.
 *
 * @module changelog-ai
 */

import { spawn } from "node:child_process";

import { CHANGE_TYPES, UNRELEASED_HEADING } from "./constants/changelog.js";
import { CODEX_COMMAND, CODEX_NOT_FOUND_EXIT_CODE, PROMPT_SHORT_SHA_LENGTH } from "./constants/changelog-ai.js";

/**
 * Builds the instructions for Codex from the commits that will ship.
 *
 * @param {{ sha: string, subject: string }[]} commits - Unreleased commits, newest first.
 * @param {string} audience - Who reads the changelog, e.g. "quien consume el paquete".
 * @returns {string} Prompt in Spanish.
 */
export function buildChangelogPrompt(commits, audience) {
  const commitList = commits.map((commit) => `- ${commit.sha.slice(0, PROMPT_SHORT_SHA_LENGTH)} ${commit.subject}`).join("\n");
  return [
    `Completá el bloque \`${UNRELEASED_HEADING}\` de CHANGELOG.md siguiendo Keep a Changelog.`,
    `- Agrupá las entradas bajo \`### ${CHANGE_TYPES.join("`, `### ")}\`, en ese orden y solo las secciones que apliquen.`,
    `- Una línea \`- \` por cambio, en español, clara para ${audience}; nada de detalles internos de implementación.`,
    `- Si \`${UNRELEASED_HEADING}\` no existe, crealo justo debajo del título del documento.`,
    "- Modificá únicamente CHANGELOG.md: no toques las versiones ya publicadas, ni otros archivos, ni hagas commits.",
    "- Usá `git show <sha>` si necesitás ver el detalle de un commit.",
    "",
    "Commits sin publicar (del más nuevo al más viejo):",
    commitList,
  ].join("\n");
}

/**
 * Runs Codex non-interactively with the prompt on stdin, showing its progress.
 *
 * @param {string} root - Repository directory where Codex edits CHANGELOG.md.
 * @param {string} prompt - Instructions from {@link buildChangelogPrompt}.
 * @returns {Promise<number>} Codex exit code; {@link CODEX_NOT_FOUND_EXIT_CODE} when the CLI is not installed.
 */
export function runCodex(root, prompt) {
  return new Promise((resolve) => {
    // The command line is a constant; the prompt only travels through stdin.
    const child = spawn(CODEX_COMMAND, { cwd: root, shell: true, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => resolve(CODEX_NOT_FOUND_EXIT_CODE));
    child.on("close", (status) => resolve(status ?? 1));
    child.stdin.end(prompt);
  });
}
