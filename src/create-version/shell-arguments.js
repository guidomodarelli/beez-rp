/**
 * Quoting of the arguments `beez-rp create-version` prints inside copyable commands, such as the
 * recovery hint that lists the `versionFiles` of a failed release commit.
 *
 * @module create-version/shell-arguments
 */

import {
  POSIX_ESCAPED_SHELL_QUOTE,
  POSIX_SHELL_QUOTE,
  SHELL_SAFE_ARGUMENT_PATTERN,
  WINDOWS_PLATFORM,
  WINDOWS_SHELL_QUOTE,
} from "../constants/create-version.js";

/**
 * Quotes an argument so the shell of the platform reads it as a single literal word when the user
 * copies the command: a path with spaces or metacharacters (`;`, `&`, `|`, `$`, `(`, quotes) is
 * never split nor interpreted. Plain arguments stay as they are, so common paths remain readable.
 *
 * On POSIX the argument goes between single quotes, with every `'` escaped. On Windows it goes
 * between double quotes, which cmd.exe and PowerShell both accept and a Windows path never
 * contains; there `%VAR%` (cmd.exe) and `$VAR` (PowerShell) still expand inside the quotes.
 *
 * @param {string} argument - Argument to print, such as a relative path.
 * @param {NodeJS.Platform} [platform] - Platform whose shell reads the command (the current one when omitted).
 * @returns {string} Argument ready to paste into a command line.
 */
export function quoteShellArgument(argument, platform = process.platform) {
  if (SHELL_SAFE_ARGUMENT_PATTERN.test(argument)) {
    return argument;
  }

  if (platform === WINDOWS_PLATFORM) {
    return `${WINDOWS_SHELL_QUOTE}${argument}${WINDOWS_SHELL_QUOTE}`;
  }

  return `${POSIX_SHELL_QUOTE}${argument.replaceAll(POSIX_SHELL_QUOTE, POSIX_ESCAPED_SHELL_QUOTE)}${POSIX_SHELL_QUOTE}`;
}

/**
 * Quotes every argument with {@link quoteShellArgument} and joins them with spaces.
 *
 * @param {string[]} commandArguments - Arguments to print.
 * @param {NodeJS.Platform} [platform] - Platform whose shell reads the command (the current one when omitted).
 * @returns {string} Arguments ready to paste after a command.
 */
export function joinShellArguments(commandArguments, platform = process.platform) {
  return commandArguments.map((commandArgument) => quoteShellArgument(commandArgument, platform)).join(" ");
}
