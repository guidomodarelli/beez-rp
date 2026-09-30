import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { joinShellArguments, quoteShellArgument } from "../../src/create-version/shell-arguments.js";

/**
 * Paths the shell of the current platform must receive unchanged. `%` (cmd.exe) and `$`
 * (PowerShell) still expand inside Windows double quotes, and Windows paths cannot contain `"`,
 * `|` nor `*`, so those are only checked on POSIX.
 */
const PATHS_WITH_SHELL_METACHARACTERS = [
  "docs/my version.txt",
  "src/a&b.js",
  "src/semi;colon.js",
  "src/paren(1).js",
  "src/it's.js",
  ...(process.platform === "win32" ? [] : ["src/$HOME.js", "src/`date`.js", 'src/quote".js', "src/glob*.js", "src/pipe|name.js"]),
];

/** @type {string[]} */
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Runs a command line through the platform shell (`/bin/sh` on POSIX, cmd.exe on Windows) and
 * returns the arguments the program received.
 *
 * @param {string} quotedArguments - Arguments as they would be pasted after the command.
 * @returns {string[]} Arguments received by the program.
 */
function readArgumentsThroughShell(quotedArguments) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "beez-rp-shell-arguments-"));
  temporaryDirectories.push(fixtureRoot);
  const scriptPath = path.join(fixtureRoot, "print-arguments.cjs");
  writeFileSync(scriptPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const result = spawnSync(`"${process.execPath}" "${scriptPath}" ${quotedArguments}`, { shell: true, encoding: "utf8", cwd: fixtureRoot });

  if (result.status !== 0) {
    throw new Error(`The shell rejected ${quotedArguments}: ${result.stderr}`);
  }

  return JSON.parse(result.stdout);
}

describe("shell arguments", () => {
  it.each(PATHS_WITH_SHELL_METACHARACTERS)("should make the shell of the platform read %s as one literal argument", (filePath) => {
    expect(readArgumentsThroughShell(quoteShellArgument(filePath))).toEqual([filePath]);
  });

  it("should keep every path a separate argument when joining them", () => {
    const filePaths = ["package.json", "docs/my version.txt", "src/a&b.js"];

    expect(readArgumentsThroughShell(joinShellArguments(filePaths))).toEqual(filePaths);
  });

  it("should leave plain paths readable and quote the rest for the given platform", () => {
    expect(quoteShellArgument("src/cli.js", "linux")).toBe("src/cli.js");
    expect(quoteShellArgument("src/it's here.js", "linux")).toBe("'src/it'\\''s here.js'");
    expect(quoteShellArgument("docs/my version.txt", "win32")).toBe('"docs/my version.txt"');
  });
});
