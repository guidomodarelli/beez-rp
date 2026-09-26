/**
 * Codex invocation used to fill an empty `[Unreleased]` block.
 *
 * @module constants/changelog-ai
 */

/** Exit code shells use when a command does not exist. */
export const CODEX_NOT_FOUND_EXIT_CODE = 127;

/** Fixed Codex command: non-interactive, allowed to edit the workspace, no saved session, prompt on stdin. */
export const CODEX_COMMAND = "codex exec --sandbox workspace-write --ephemeral --color never -";

/** Length of the abbreviated commit ids listed in the prompt. */
export const PROMPT_SHORT_SHA_LENGTH = 7;
