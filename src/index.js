/**
 * `beez-rp`: dependency-free release process shared by the Beez projects.
 *
 * - `beez-rp/versions`: stable `X.Y.Z` rules; only the next patch, minor or major is allowed.
 * - `beez-rp/build-gate`: Vercel `ignoreCommand` decision built on those rules.
 * - `beez-rp/changelog` and `beez-rp/changelog-ai`: Keep a Changelog release and Codex fill-in.
 * - `beez-rp/guard-publish`: `prepublishOnly` guard that blocks pnpm, yarn and bun publications.
 * - `beez-rp/package-manager`: detection of pnpm, bun, npm or yarn and the commands each one runs.
 * - `beez-rp/terminal-ui`: boxes, spinners and prompts for release commands.
 * - `beez-rp/testing`: shared version bump fixtures for consumer test suites.
 * - `beez-rp/constants`: every constant above, grouped by domain.
 *
 * @module beez-rp
 */

export * from "./build-gate.js";
export * from "./changelog.js";
export * from "./changelog-ai.js";
export * from "./guard-publish.js";
export * from "./package-manager.js";
export * from "./versions.js";
export {
  ICON,
  countTerminalRows,
  formatDuration,
  getPromptWaitMs,
  measureActiveMs,
  paint,
  print,
  renderBanner,
  renderBox,
  renderRow,
  renderStepHeader,
  resolveBoxWidth,
  resolveNumberKey,
  select,
  startSpinner,
  visibleWidth,
  wrapStyledLine,
} from "./terminal-ui.js";
export * from "./constants/index.js";
