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
import { CHANGELOG_LANGUAGE } from "./constants/create-version.js";

/**
 * Builds the instructions for Codex from the commits that will ship.
 *
 * @param {{ sha: string, subject: string }[]} commits - Unreleased commits, newest first.
 * @param {string} audience - Who reads the changelog, e.g. "quien consume el paquete".
 * @param {"es" | "en"} [language] - Language of the entries: Spanish by default, or English limited to ASCII.
 * @returns {string} Prompt written in the requested language.
 */
export function buildChangelogPrompt(commits, audience, language = CHANGELOG_LANGUAGE.spanish) {
  const commitList = commits.map((commit) => `- ${commit.sha.slice(0, PROMPT_SHORT_SHA_LENGTH)} ${commit.subject}`).join("\n");

  if (language === CHANGELOG_LANGUAGE.english) {
    return [
      `Fill the \`${UNRELEASED_HEADING}\` block of CHANGELOG.md following Keep a Changelog.`,
      `- Group entries under \`### ${CHANGE_TYPES.join("`, `### ")}\`, in that order and only the sections that apply.`,
      `- One \`- \` line per change, in English and ASCII only, clear for ${audience}; no internal implementation details.`,
      `- If \`${UNRELEASED_HEADING}\` does not exist, create it right below the document title.`,
      "- Modify only CHANGELOG.md: do not touch released versions or other files, and do not commit.",
      "- Use `git show <sha>` when you need the details of a commit.",
      "",
      "Unreleased commits (newest first):",
      commitList,
    ].join("\n");
  }

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
