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
 * - `beez-rp guard-publish` is the `prepublishOnly` guard: it exits with `1`
 *   and explains why when pnpm, yarn or bun publishes, and with `0` otherwise.
 *
 * The module trace of `create-version` starts before any other module loads: the only static import
 * is `module-trace-bootstrap.js`, which imports nothing but Node built-ins, and every other module
 * (constants included) is imported afterwards. A module Node resolved before the trace started never
 * shows up in it, nor do its imports, and when beez-rp releases its own checkout those modules are
 * part of the release. The trace starts for every command: it only records import edges.
 *
 * @module beez-rp-cli
 */

import { startTracingConfigModules } from "../src/create-version/module-trace-bootstrap.js";

startTracingConfigModules();

const { BUILD_DECISION, DECISION_EXIT_CODE, GATE_FAILURE_EXIT_CODE } = await import("../src/constants/build-gate.js");
const { CLI_COMMAND } = await import("../src/constants/cli.js");

/** Usage printed for unknown commands. */
const USAGE = `Usage: beez-rp ${CLI_COMMAND.ignoreBuild} | beez-rp ${CLI_COMMAND.createVersion} [options] | beez-rp ${CLI_COMMAND.guardPublish}`;

const [command, ...commandArguments] = process.argv.slice(2);

if (command === CLI_COMMAND.createVersion) {
  const { runCreateVersion } = await import("../src/create-version/run.js");
  process.exitCode = await runCreateVersion({ repositoryRoot: process.cwd(), argv: commandArguments });
} else if (command === CLI_COMMAND.guardPublish) {
  const { decidePublishGuardForEnvironment } = await import("../src/guard-publish.js");
  const decision = decidePublishGuardForEnvironment();
  if (decision.message) {
    console.error(decision.message);
  }
  process.exitCode = decision.exitCode;
} else if (command === CLI_COMMAND.ignoreBuild) {
  const { decideBuildForCheckout } = await import("../src/build-gate.js");
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
