#!/usr/bin/env node
/**
 * `beez-rp` command line.
 *
 * - `beez-rp ignore-build` prints why the current checkout is built or skipped
 *   and, as its last line, the decision (`BUILD` or `SKIP`), exiting with `0`.
 *   It exits with `2` when it cannot decide. Vercel wrappers must build only
 *   when the last line is `BUILD`, so any failure (including `npx` itself)
 *   skips the build.
 * - `beez-rp create-version [--bump patch|minor|major | --set-version X.Y.Z] [--dry-run]`
 *   diagnoses the repository in the current directory and ships its release
 *   from `main`, following its `beez-rp.config.js`.
 *
 * @module beez-rp-cli
 */

import { decideBuildForCheckout } from "../src/build-gate.js";
import { BUILD_DECISION, DECISION_EXIT_CODE, GATE_FAILURE_EXIT_CODE } from "../src/constants/build-gate.js";
import { CLI_COMMAND } from "../src/constants/cli.js";
import { runCreateVersion } from "../src/create-version/run.js";

/** Usage printed for unknown commands. */
const USAGE = `Usage: beez-rp ${CLI_COMMAND.ignoreBuild} | beez-rp ${CLI_COMMAND.createVersion} [options]`;

const [command, ...commandArguments] = process.argv.slice(2);

if (command === CLI_COMMAND.createVersion) {
  process.exitCode = await runCreateVersion({ repositoryRoot: process.cwd(), argv: commandArguments });
} else if (command === CLI_COMMAND.ignoreBuild) {
  try {
    const decision = decideBuildForCheckout(process.cwd());
    console.log(decision.reason);
    console.log(decision.shouldBuild ? BUILD_DECISION.build : BUILD_DECISION.skip);
    process.exitCode = DECISION_EXIT_CODE;
  } catch (error) {
    console.error("beez-rp ignore-build: could not decide; the build must be skipped.", error);
    process.exitCode = GATE_FAILURE_EXIT_CODE;
  }
} else {
  console.error(`beez-rp: unknown command "${command ?? ""}". ${USAGE}`);
  process.exitCode = GATE_FAILURE_EXIT_CODE;
}
