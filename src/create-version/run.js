/**
 * `beez-rp create-version`: one command that diagnoses a repository, shows
 * what is still missing and ships the release from `main`.
 *
 * 1. Diagnosis: fetches `origin`, reads the branch, working tree, `main`
 *    versus `origin/main`, the last release, unreleased commits, the
 *    published versions, the npm credentials (when the plan would publish to
 *    npm) and pending migrations (`state.js`).
 * 2. Plan: `plan.js` turns that snapshot into ordered steps, or into blockers
 *    that explain what to fix.
 * 3. Execution: runs each step; project-specific work (checks, migrations,
 *    preparation, publication) comes from `beez-rp.config.js`.
 *
 * Every step is derived from the current state, so running the command again
 * after a failure resumes from the first missing step.
 *
 * @module create-version/run
 */

import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readUnreleased, releaseUnreleased } from "../changelog.js";
import { buildChangelogPrompt, runCodex } from "../changelog-ai.js";
import { CHANGE_TYPES, CHANGELOG_FILE, UNRELEASED_HEADING } from "../constants/changelog.js";
import { CODEX_NOT_FOUND_EXIT_CODE } from "../constants/changelog-ai.js";
import {
  CREATE_VERSION_FLAG,
  FAILURE_EXIT_CODE,
  GIT_REGULAR_FILE_MODES,
  GITHUB_REPOSITORY_PATTERN,
  MAIN_BRANCH,
  MAX_LISTED_COMMITS,
  MAX_LISTED_ITEMS,
  MIGRATION_STATUS,
  NPM_AUTH_STATUS,
  NPM_LOOKUP_STATUS,
  NPM_PUBLISHER,
  NPM_TOKEN_LOCATIONS,
  NPM_TOKEN_VARIABLE,
  NPM_WRITE_ACCESS_UNVERIFIED_NOTE,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_VERSION_FIELD_PATTERN,
  PINNED_NODE_VERSION_FILE,
  PROJECT_NPM_CONFIG_FILE,
  RELEASE_MODE,
  RELEASE_REGISTRY,
  RELEASE_REMOTE,
  RELEASE_STEP,
  REMOTE_MAIN_REF,
  SHORT_SHA_LENGTH,
  SUMMARY_VERSION_PLACEHOLDER,
  VERSION_PREFIX_PATTERN,
  buildMainSyncedRestartMessage,
} from "../constants/create-version.js";
import {
  BOX_TONE,
  ICON,
  formatDuration,
  measureActiveMs,
  paint,
  print,
  renderBanner,
  renderBox,
  renderRow,
  renderStepHeader,
  select,
  startSpinner,
} from "../terminal-ui.js";
import {
  GIT_LITERAL_PATHSPEC_PREFIX,
  RELEASE_COMMIT_BUILT_IN_FILES,
  VERSION_BLOCK_END_MARKERS,
  VERSION_BLOCK_PROBLEM,
  VERSION_BLOCK_START_MARKERS,
} from "../constants/version-files.js";
import { updateVersionMarkers, VersionBlockError } from "../version-files.js";
import { listNextVersions, resolveRequestedVersion, suggestReleaseType, toReleaseTag } from "../versions.js";
import {
  expandArtifactPattern,
  findPnpmPackRewrites,
  findPreparedArtifact,
  isSafeArtifactPath,
  verifyPreparedArtifact,
  withArtifactOutsidePackageRoot,
} from "./artifact.js";
import { loadCreateVersionConfig } from "./config.js";
import { ReleaseStepError } from "./errors.js";
import {
  buildNpmAuthConfigLine,
  checkNpmPublishAccess,
  describePublishedRelease,
  lookupPublishedVersions,
  publishToNpm,
  readNpmPackIntegrity,
  resolvePublishRegistry,
} from "./npm.js";
import { describeNpmPublishFailure, describeNpmTokenSource } from "./npm-auth.js";
import { restoreLocalChanges, setAsideLocalChanges } from "./local-changes.js";
import { describeProjectCommands, detectPackageManager } from "../package-manager.js";
import { buildReleasePlan, buildReleaseUsage, listLocalChangesToSetAside, parseReleaseArguments } from "./plan.js";
import { createGitReader, listCommits, runCommandLine, runInherited } from "./process.js";
import { collectReleaseState } from "./state.js";
import { decodeStrictUtf8, InvalidUtf8Error } from "./utf8-text.js";

/**
 * @typedef {import("./config.js").ResolvedCreateVersionConfig} ResolvedCreateVersionConfig
 * @typedef {import("./config.js").HookContext} HookContext
 * @typedef {import("./state.js").ReleaseSnapshot} ReleaseSnapshot
 * @typedef {import("./process.js").GitReader} GitReader
 * @typedef {{
 *   repositoryRoot: string,
 *   config: ResolvedCreateVersionConfig,
 *   state: ReleaseSnapshot,
 *   options: import("./plan.js").ReleaseOptions,
 *   reader: GitReader,
 *   version: string | null,
 *   pushed: boolean,
 *   published: boolean,
 *   commitCount: number | null,
 *   packageName: string,
 *   registryUrl: string | null,
 *   commands: import("../package-manager.js").ProjectCommands,
 * }} ReleaseContext
 */

/** Raised when the user cancels on purpose; ends the run without an error box. */
class ReleaseCancelledError extends Error {}

/**
 * Raised after syncing `main` brought new commits: the diagnosis, the plan and the configuration
 * (with every module it imports) belong to the previous `main`, so the run ends without an error
 * and asks to run the command again in a new process.
 */
class MainSyncedRestartError extends Error {}

/** Answers of the pending-migrations prompt. */
const MIGRATION_CHOICE = Object.freeze({ apply: "apply", skip: "skip", cancel: "cancel" });

/** Answers of the prompt that offers to ignore uncommitted changes. */
const LOCAL_CHANGES_CHOICE = Object.freeze({ ignore: "ignore", cancel: "cancel" });

/**
 * Lists the uncommitted changes and asks whether to set them aside for this release, as
 * `--ignore-local-changes` does. Nothing is preselected, so a stray Enter never ignores them.
 *
 * @param {string[]} changes - `git status --porcelain` lines that would be set aside.
 * @returns {Promise<boolean>} `true` to set them aside and go on.
 */
async function askToIgnoreLocalChanges(changes) {
  const lines = changes.slice(0, MAX_LISTED_ITEMS).map((line) => `${ICON.bullet} ${line}`);
  if (changes.length > MAX_LISTED_ITEMS) {
    lines.push(paint("gray", `… y ${changes.length - MAX_LISTED_ITEMS} más`));
  }
  lines.push("", paint("gray", "Si los ignorás, se apartan con git stash durante el release (no se publican) y se restauran al final."));
  print(renderBox({ title: `Hay ${changes.length} cambio(s) sin commitear`, lines, tone: BOX_TONE.warning }));

  const choice = await select({
    message: "¿Ignorar los cambios locales y seguir con el release?",
    options: [
      { label: "Ignorarlos y seguir", hint: `igual que --${CREATE_VERSION_FLAG.ignoreLocalChanges}`, value: LOCAL_CHANGES_CHOICE.ignore },
      { label: "Cancelar", hint: "commitealos o guardalos antes de publicar", value: LOCAL_CHANGES_CHOICE.cancel },
    ],
    defaultIndex: null,
  });

  return choice === LOCAL_CHANGES_CHOICE.ignore;
}

/**
 * Creates the context passed to project hooks.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {GitReader} reader - Git reader.
 * @param {string | null} version - Version being released, when known.
 * @returns {HookContext} Hook context.
 */
export function createHookContext(repositoryRoot, reader, version) {
  return {
    repositoryRoot,
    version,
    git: reader,
    run: (commandLine) => runCommandLine(commandLine, repositoryRoot),
    print,
    fail: (message, hint) => {
      throw new ReleaseStepError(message, hint);
    },
  };
}

/**
 * Renders a list of commit subjects inside a box.
 *
 * @param {{ subject: string }[]} commits - Commits, newest first.
 * @param {string} title - Box title.
 * @returns {string} Box.
 */
function renderCommitList(commits, title) {
  const lines = commits.slice(0, MAX_LISTED_COMMITS).map((commit) => `${ICON.bullet} ${commit.subject}`);

  if (commits.length > MAX_LISTED_COMMITS) {
    lines.push(paint("gray", `… y ${commits.length - MAX_LISTED_COMMITS} más`));
  }

  return renderBox({ title, lines, tone: BOX_TONE.accent });
}

/**
 * Compares the running Node.js with `.nvmrc`, which may pin a full version or only a major.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {{ matches: boolean, pinned: string } | null} Comparison, or `null` without `.nvmrc`.
 */
function checkPinnedNodeVersion(repositoryRoot) {
  const pinnedPath = path.join(repositoryRoot, PINNED_NODE_VERSION_FILE);

  if (!existsSync(pinnedPath)) {
    return null;
  }

  const pinned = readFileSync(pinnedPath, "utf8").trim().replace(VERSION_PREFIX_PATTERN, "");
  const running = process.versions.node;
  return { matches: running === pinned || running.startsWith(`${pinned}.`), pinned };
}

/**
 * Renders the status panel of the diagnosis.
 *
 * @param {ReleaseSnapshot} state - Snapshot.
 * @param {string} repositoryRoot - Repository root.
 * @returns {string} Box.
 */
function renderDiagnosis(state, repositoryRoot) {
  const isOnMain = state.currentBranch === MAIN_BRANCH;
  const { aheadCommits, behindCount } = state.main;
  const syncParts = [
    ...(behindCount > 0 ? [paint("yellow", `${behindCount} atrás`)] : []),
    ...(aheadCommits.length > 0 ? [paint("yellow", `${aheadCommits.length} adelante`)] : []),
  ];
  const detachedTag = !state.currentBranch && state.headReleaseTag ? state.headReleaseTag : null;
  const branchRow = isOnMain
    ? renderRow(ICON.success, "Rama", MAIN_BRANCH)
    : detachedTag
      ? renderRow(ICON.warning, "Rama", paint("yellow", `HEAD desacoplado en ${detachedTag}`))
      : renderRow(ICON.failure, "Rama", paint("red", state.currentBranch ?? "HEAD desacoplado"));
  const rows = [
    branchRow,
    renderRow(
      state.workingTreeChanges.length === 0 ? ICON.success : ICON.warning,
      "Working tree",
      state.workingTreeChanges.length === 0 ? "limpio" : paint("yellow", `${state.workingTreeChanges.length} cambio(s) sin commitear`)
    ),
    renderRow(syncParts.length > 0 ? ICON.warning : ICON.success, `${MAIN_BRANCH} ↔ origin`, syncParts.join(", ") || "al día"),
    renderRow(
      ICON.info,
      "Último release",
      state.lastRelease?.version
        ? `${paint("cyan", toReleaseTag(state.lastRelease.version))} ${paint("gray", `(${state.lastRelease.sha.slice(0, SHORT_SHA_LENGTH)})`)}`
        : paint("gray", "ninguno todavía")
    ),
  ];

  if (state.npm) {
    const latestPublished = state.npm.latestVersion ?? state.npm.publishedVersions.at(-1);
    rows.push(
      renderRow(
        state.npm.status === NPM_LOOKUP_STATUS.ok ? ICON.success : ICON.failure,
        "npm",
        state.npm.status === NPM_LOOKUP_STATUS.ok ? `latest ${paint("cyan", latestPublished ?? "ninguna todavía")}` : paint("red", "no respondió")
      )
    );
  }

  if (state.npmAuth) {
    rows.push(renderNpmAuthRow(state.npmAuth));
  }

  rows.push(
    renderRow(
      state.unreleasedCommits.length > 0 ? ICON.warning : ICON.success,
      "Sin publicar",
      state.unreleasedCommits.length > 0 ? paint("yellow", `${state.unreleasedCommits.length} commit(s) en ${REMOTE_MAIN_REF}`) : "nada nuevo desde el último release"
    )
  );

  if (state.migrations) {
    const { migrations } = state;
    const [icon, value] =
      migrations.status === MIGRATION_STATUS.pending
        ? [ICON.warning, paint("yellow", `${migrations.pending.length} pendiente(s) en ${migrations.target ?? "desconocido"}`)]
        : migrations.status === MIGRATION_STATUS.upToDate
          ? [ICON.success, `al día en ${migrations.target ?? "la base de datos"}`]
          : [ICON.warning, paint("yellow", "no se pudo verificar")];
    rows.push(renderRow(icon, "Migraciones", value));
  }

  const { changelog } = state;
  rows.push(
    changelog.unknownSections.length > 0
      ? renderRow(ICON.failure, "CHANGELOG", paint("red", `secciones no válidas: ${changelog.unknownSections.join(", ")}`))
      : changelog.entryCount === 0
        ? renderRow(ICON.warning, "CHANGELOG", paint("yellow", "[Unreleased] vacío: lo completa Codex al versionar"))
        : renderRow(ICON.success, "CHANGELOG", `${changelog.entryCount} entrada(s) en [Unreleased]`)
  );

  const node = checkPinnedNodeVersion(repositoryRoot);
  if (node) {
    rows.push(
      renderRow(node.matches ? ICON.success : ICON.warning, "Node.js", node.matches ? process.version : paint("yellow", `${process.version} (.nvmrc pide v${node.pinned})`))
    );
  }

  return renderBox({ title: "Diagnóstico", lines: rows, tone: BOX_TONE.info });
}

/**
 * Renders the npm credential row of the diagnosis: the user and where the token came from, or the problem.
 * An owner passes without claiming that the token can write, which npm cannot check before publishing.
 *
 * @param {import("./npm.js").NpmAuthCheck} npmAuth - Credential check.
 * @returns {string} Row.
 */
function renderNpmAuthRow(npmAuth) {
  const source = describeNpmTokenSource(npmAuth);

  switch (npmAuth.status) {
    case NPM_AUTH_STATUS.ok:
      return npmAuth.firstPublication
        ? renderRow(ICON.success, "npm auth", `${npmAuth.user} (${source})${paint("gray", " · primera publicación")}`)
        : renderRow(ICON.success, "npm auth", `${npmAuth.user} (${source}), dueño de ${npmAuth.packageName}${paint("gray", `; ${NPM_WRITE_ACCESS_UNVERIFIED_NOTE}`)}`);
    case NPM_AUTH_STATUS.missingToken:
      return renderRow(ICON.failure, "npm auth", paint("red", `falta ${NPM_TOKEN_VARIABLE}`));
    case NPM_AUTH_STATUS.invalidToken:
      return renderRow(ICON.failure, "npm auth", paint("red", `token inválido o vencido (${source})`));
    case NPM_AUTH_STATUS.notOwner:
      return renderRow(ICON.failure, "npm auth", paint("red", `${npmAuth.user} no puede publicar ${npmAuth.packageName} (${source})`));
    case NPM_AUTH_STATUS.projectCredentials:
      return renderRow(ICON.failure, "npm auth", paint("red", `el ${PROJECT_NPM_CONFIG_FILE} del proyecto define credenciales que pisan ${NPM_TOKEN_VARIABLE}`));
    default:
      return renderRow(ICON.warning, "npm auth", paint("yellow", `no se pudo verificar (${source})`));
  }
}

/**
 * Renders the plan or its blockers.
 *
 * @param {import("./plan.js").ReleasePlan} plan - Plan.
 * @returns {string} Box.
 */
function renderPlan(plan) {
  if (plan.blockers.length > 0) {
    const lines = plan.blockers.flatMap((blocker, index) => [
      ...(index > 0 ? [""] : []),
      `${ICON.failure} ${paint("bold", blocker.title)}`,
      ...blocker.details.map((detail) => `   ${paint("gray", "→")} ${detail}`),
    ]);
    return renderBox({ title: "No se puede publicar todavía", lines, tone: BOX_TONE.danger });
  }

  const lines = plan.steps.flatMap((planStep, index) => [
    `${paint(["bold", "magenta"], `${index + 1}.`)} ${paint("bold", planStep.title)}`,
    ...(planStep.detail ? [`   ${paint("gray", planStep.detail)}`] : []),
  ]);

  for (const warning of plan.warnings) {
    lines.push("", `${ICON.warning} ${paint("yellow", warning)}`);
  }

  const title = plan.mode === RELEASE_MODE.resume ? "Plan · retomar el release pendiente" : "Plan";
  return renderBox({ title, lines, tone: BOX_TONE.accent });
}

/**
 * Runs Git with visible output and fails the step on error.
 *
 * @param {ReleaseContext} context - Release context.
 * @param {string[]} gitArguments - Git arguments.
 * @param {string} failureMessage - Spanish message when it fails.
 * @param {string} hint - Spanish next action.
 * @returns {Promise<void>}
 */
async function runGitStep(context, gitArguments, failureMessage, hint) {
  const exitCode = await runInherited("git", gitArguments, { cwd: context.repositoryRoot });

  if (exitCode !== 0) {
    throw new ReleaseStepError(`${failureMessage} (git ${gitArguments[0]} salió con código ${exitCode}).`, hint);
  }
}

/**
 * Runs configured command lines in order, stopping at the first failure.
 *
 * @param {ReleaseContext} context - Release context.
 * @param {string[]} commandLines - Commands from `beez-rp.config.js`.
 * @param {string} hint - Spanish next action when one fails.
 * @returns {Promise<void>}
 */
async function runConfiguredCommands(context, commandLines, hint) {
  for (const commandLine of commandLines) {
    print(paint("gray", `$ ${commandLine}`));
    const exitCode = await runCommandLine(commandLine, context.repositoryRoot);

    if (exitCode !== 0) {
      throw new ReleaseStepError(`${commandLine} falló con código ${exitCode}.`, hint);
    }
  }
}

/**
 * Reads the `[Unreleased]` block of the working-tree CHANGELOG.md.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {ReturnType<typeof readUnreleased>} Unreleased state.
 */
function readWorkingUnreleased(repositoryRoot) {
  const changelogPath = path.join(repositoryRoot, CHANGELOG_FILE);
  return existsSync(changelogPath) ? readUnreleased(readFileSync(changelogPath, "utf8")) : { exists: false, entryCount: 0, unknownSections: [], body: "" };
}

/**
 * Reads the working tree `package.json`, which syncing `main` may have changed after the diagnosis.
 *
 * @param {string} repositoryRoot - Repository root.
 * @returns {import("./artifact.js").PackageManifest} Current manifest.
 */
function readWorkingManifest(repositoryRoot) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, PACKAGE_MANIFEST_FILE), "utf8"));
}

/**
 * Returns the version being released: the one just bumped or the pending one.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {string} Version.
 */
function requireReleaseVersion(context) {
  const version = context.version ?? context.state.headVersion;

  if (!version) {
    throw new ReleaseStepError("No se pudo leer la versión a publicar.", `Revisá package.json y volvé a correr ${context.commands.createVersion}.`);
  }

  return version;
}

/**
 * Steps a configuration adds to the release plan.
 *
 * @param {ResolvedCreateVersionConfig} config - Resolved configuration.
 * @returns {import("./plan.js").ReleaseCapabilities} Capabilities for `buildReleasePlan`.
 */
function describeReleaseCapabilities(config) {
  return {
    checks: (config.checks?.length ?? 0) > 0,
    checksMissing: config.checks === null,
    prepare: config.prepare !== null,
    publish: config.publish !== null,
    publishTitle: config.publish === NPM_PUBLISHER ? "Publicar en npm" : "Publicar el release",
    commands: config.commands,
  };
}

/**
 * Fast-forwards local `main` to `origin/main`. When that brings new commits the release stops
 * before touching the version: the diagnosis, the plan and `beez-rp.config.(m)js` (imported with
 * its modules at startup) come from the previous `main`, so the command must run again in a new
 * process to diagnose with the new code and configuration.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When the fast-forward fails.
 * @throws {MainSyncedRestartError} When `main` moved and the command has to run again.
 */
async function syncMainStep(context) {
  const headBeforeSync = await context.reader.git(["rev-parse", "HEAD"]);
  await runGitStep(
    context,
    ["merge", "--ff-only", "--quiet", REMOTE_MAIN_REF],
    `No se pudo actualizar ${MAIN_BRANCH} en fast-forward`,
    `Revisá git status y git log ${REMOTE_MAIN_REF}..${MAIN_BRANCH}.`
  );
  print(`${ICON.success} ${MAIN_BRANCH} quedó igual a ${REMOTE_MAIN_REF}.`);

  if ((await context.reader.git(["rev-parse", "HEAD"])) !== headBeforeSync) {
    throw new MainSyncedRestartError();
  }
}

/**
 * Shows the pending migrations, asks for confirmation and applies them through the project adapter.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function applyMigrationsStep(context) {
  const adapter = context.config.migrations;
  const migrations = context.state.migrations;

  if (!adapter || !migrations) {
    return;
  }

  const lines = migrations.pending.slice(0, MAX_LISTED_ITEMS * 2).map((name) => `${ICON.bullet} ${name}`);
  if (migrations.pending.length > MAX_LISTED_ITEMS * 2) {
    lines.push(paint("gray", `… y ${migrations.pending.length - MAX_LISTED_ITEMS * 2} más`));
  }
  const targetHint = adapter.targetHint ? ` (${adapter.targetHint})` : "";
  lines.push("", `${ICON.warning} Destino: ${paint(["bold", "yellow"], migrations.target ?? "desconocido")}${targetHint}`);
  print(renderBox({ title: "Migraciones pendientes", lines, tone: BOX_TONE.warning }));

  const choice = await select({
    message: "¿Aplicar estas migraciones ahora?",
    options: [
      { label: "Aplicar ahora", hint: "corre la migración del proyecto", value: MIGRATION_CHOICE.apply },
      { label: "Saltear", hint: "seguir con el release sin migrar", value: MIGRATION_CHOICE.skip },
      { label: "Cancelar release", value: MIGRATION_CHOICE.cancel },
    ],
  });

  if (choice === MIGRATION_CHOICE.cancel) {
    throw new ReleaseCancelledError();
  }

  if (choice === MIGRATION_CHOICE.skip) {
    print(`${ICON.warning} ${paint("yellow", "Migraciones salteadas: el deploy puede fallar si el código las necesita.")}`);
    return;
  }

  const hookContext = createHookContext(context.repositoryRoot, context.reader, null);
  await adapter.apply(hookContext);
  const recheck = await adapter.check(hookContext);

  if (recheck.status === MIGRATION_STATUS.pending) {
    throw new ReleaseStepError(
      `Siguen pendientes ${recheck.pending.length} migración(es) después de migrar.`,
      "Revisá el journal de migraciones y la tabla de migraciones aplicadas; no se subió ninguna versión."
    );
  }

  print(`${ICON.success} Base de datos al día.`);
}

/**
 * Asks Codex to fill an empty `[Unreleased]` block from the unreleased commits.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function generateChangelogStep(context) {
  const { audience, language } = context.config.changelog;
  print(paint("gray", "Codex está escribiendo el CHANGELOG a partir de los commits sin publicar…"));
  const exitCode = await runCodex(context.repositoryRoot, buildChangelogPrompt(/** @type {{ sha: string, subject: string }[]} */ (context.state.unreleasedCommits), audience, language));
  const unreleased = readWorkingUnreleased(context.repositoryRoot);

  if (exitCode !== 0 || unreleased.entryCount === 0 || unreleased.unknownSections.length > 0) {
    const reason =
      exitCode === CODEX_NOT_FOUND_EXIT_CODE
        ? "no se encontró la CLI de Codex"
        : exitCode !== 0
          ? `Codex terminó con código ${exitCode}`
          : "el bloque sigue vacío o con secciones no válidas";
    throw new ReleaseStepError(
      `No se pudo completar ${UNRELEASED_HEADING} del CHANGELOG: ${reason}.`,
      `Completalo (con la IA o a mano) usando ${CHANGE_TYPES.map((type) => `### ${type}`).join(", ")} y volvé a correr ${context.commands.createVersion}.`
    );
  }

  print(renderBox({ title: `CHANGELOG · ${UNRELEASED_HEADING} (generado por Codex)`, lines: unreleased.body.split("\n"), tone: BOX_TONE.info }));
}

/**
 * Runs the configured checks before touching the version.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function runChecksStep(context) {
  await runConfiguredCommands(context, context.config.checks ?? [], "Corregí el error de arriba; todavía no se tocó la versión.");
}

/**
 * Part of the release context the `versionFiles` checks read, available before the plan runs.
 *
 * @typedef {Pick<ReleaseContext, "repositoryRoot" | "config" | "reader" | "commands">} VersionFilesContext
 */

/**
 * Finds the first symbolic link (or Windows junction) along a configured path. Writing through it
 * would change a file Git does not stage (the target, maybe outside the repository), while the
 * release commit would only carry the link.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} filePath - Configured path, relative to the root.
 * @returns {string | null} The linked part of the path, or `null` when no segment is a link.
 */
function findSymbolicLinkSegment(repositoryRoot, filePath) {
  const segments = path.normalize(filePath).split(path.sep).filter((segment) => segment !== "" && segment !== ".");
  let currentPath = repositoryRoot;

  for (const [index, segment] of segments.entries()) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatSync(currentPath, { throwIfNoEntry: false });

    if (!stats) {
      return null;
    }
    if (stats.isSymbolicLink()) {
      return segments.slice(0, index + 1).join("/");
    }
  }

  return null;
}

/**
 * Stops the release when a `versionFiles` entry goes through a symbolic link.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} filePath - Configured path.
 * @returns {void}
 * @throws {ReleaseStepError} When a segment of the path is a symbolic link.
 */
function requireVersionFileWithoutLinks(context, filePath) {
  const linkedSegment = findSymbolicLinkSegment(context.repositoryRoot, filePath);

  if (linkedSegment !== null) {
    throw new ReleaseStepError(
      `${filePath} (versionFiles) pasa por el enlace simbólico ${linkedSegment}: Git solo commitearía el enlace y no el archivo con la versión.`,
      `Apuntá versionFiles al archivo real dentro del repositorio y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`
    );
  }
}

/**
 * Builds the pathspec that matches a `versionFiles` entry literally, so a name such as `-v.txt`,
 * `:version` or `v*.txt` is a file, never an option, pathspec magic nor a glob.
 *
 * @param {string} filePath - Configured path, already `/`-separated by the configuration.
 * @returns {string} Literal pathspec, to pass after `--`.
 */
function toLiteralPathspec(filePath) {
  return `${GIT_LITERAL_PATHSPEC_PREFIX}${filePath}`;
}

/**
 * Stops the release, before anything is written, when a `versionFiles` entry is not tracked by Git:
 * an ignored file (such as generated output) or one never committed would make `git add` fail, or
 * leave the release commit without it, after package.json and CHANGELOG.md were already rewritten.
 *
 * @param {VersionFilesContext} context - Release context.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When an entry is not in the Git index.
 */
async function requireTrackedVersionFiles(context) {
  const { versionFiles } = context.config;

  if (versionFiles.length === 0) {
    return;
  }

  const listing = await context.reader.git(["ls-files", "-z", "--", ...versionFiles.map(toLiteralPathspec)]);
  const trackedPaths = new Set(listing.split("\0"));
  const untrackedPath = versionFiles.find((filePath) => !trackedPaths.has(filePath));

  if (untrackedPath !== undefined) {
    throw new ReleaseStepError(
      `${untrackedPath} (versionFiles) no está trackeado en Git (lo ignora .gitignore o nunca se commiteó): el commit de release no podría incluirlo.`,
      `Commitealo (si está ignorado, sacalo de .gitignore o agregalo con git add -f) o sacalo de versionFiles en beez-rp.config.(m)js, y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`
    );
  }
}

/**
 * Stops a resume when a `versionFiles` entry is not a regular file in the release commit (`HEAD`),
 * such as a committed symbolic link or a submodule. It reads the commit, not the working tree: a
 * local change about to be set aside (`--ignore-local-changes`) never decides what gets pushed.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} filePath - Configured path.
 * @param {string} version - Version of the pending release.
 * @returns {Promise<boolean>} Whether the entry exists in `HEAD` (as a regular file).
 * @throws {ReleaseStepError} When the entry exists in `HEAD` but is not a regular file.
 */
async function requireRegularFileInReleaseCommit(context, filePath, version) {
  const entry = await context.reader.git(["ls-tree", "-z", "HEAD", "--", toLiteralPathspec(filePath)]);

  if (entry === "") {
    return false;
  }

  const mode = entry.split(" ", 1)[0];

  if (!GIT_REGULAR_FILE_MODES.includes(mode)) {
    throw new ReleaseStepError(
      `${filePath} (versionFiles) no es un archivo regular en el commit de release ${version} (HEAD, modo ${mode}): Git no llevaría la versión en ese archivo.`,
      `Reemplazalo en el commit de release por el archivo real con sus líneas marcadas en ${version}, o corregí versionFiles en beez-rp.config.(m)js, y volvé a correr ${context.commands.createVersion}; no se subió ni publicó nada.`
    );
  }

  return true;
}

/**
 * Builds the error for a `versionFiles` entry without any marked version.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} filePath - Configured path.
 * @returns {ReleaseStepError} Error with the markers to add.
 */
function missingVersionMarkerError(context, filePath) {
  return new ReleaseStepError(
    `${filePath} (versionFiles) no tiene ninguna versión marcada para actualizar.`,
    `Marcá la línea con un comentario beez-rp-version (o x-release-please-version), o el bloque con beez-rp-start-version … beez-rp-end, y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`
  );
}

/**
 * Explains, in Spanish, which version block markers of a `versionFiles` entry are paired wrongly
 * and how to fix them.
 *
 * @param {VersionBlockError} blockError - Pairing problem found in the file.
 * @param {string} filePath - Configured path.
 * @returns {{ message: string, fix: string }} What is wrong (file and line) and the marker to add or change.
 */
function describeVersionBlockProblem(blockError, filePath) {
  const { problem, lineNumber, marker, openingLineNumber, openingMarker } = blockError;
  const expectedEndMarker = VERSION_BLOCK_END_MARKERS[VERSION_BLOCK_START_MARKERS.indexOf(openingMarker ?? "")];

  switch (problem) {
    case VERSION_BLOCK_PROBLEM.unterminated:
      return {
        message: `${filePath} (versionFiles) abre un bloque de versión con ${marker} en la línea ${lineNumber} y nunca lo cierra.`,
        fix: `Cerralo con ${expectedEndMarker} al final de las líneas que llevan la versión`,
      };
    case VERSION_BLOCK_PROBLEM.nested:
      return {
        message: `${filePath} (versionFiles) abre un bloque de versión con ${marker} en la línea ${lineNumber} dentro del bloque que abrió ${openingMarker} en la línea ${openingLineNumber}.`,
        fix: `Cerrá el bloque de la línea ${openingLineNumber} con ${expectedEndMarker} antes de abrir otro`,
      };
    case VERSION_BLOCK_PROBLEM.mismatched:
      return {
        message: `${filePath} (versionFiles) cierra con ${marker} en la línea ${lineNumber} el bloque que abrió ${openingMarker} en la línea ${openingLineNumber}.`,
        fix: `Cambiá ${marker} por ${expectedEndMarker}`,
      };
    default:
      return {
        message: `${filePath} (versionFiles) tiene ${marker} en la línea ${lineNumber} sin ningún bloque de versión abierto.`,
        fix: `Abrí el bloque con ${VERSION_BLOCK_START_MARKERS[VERSION_BLOCK_END_MARKERS.indexOf(marker)]} o borrá ese marcador`,
      };
  }
}

/**
 * Rewrites the marked versions of a `versionFiles` entry, stopping the release when its block
 * markers are paired wrongly or none of its lines is marked.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} filePath - Configured path.
 * @param {string} content - Content of the file.
 * @param {string} version - Version to write.
 * @param {string} untouchedNote - What the stop leaves untouched, closing the hint.
 * @returns {string} Content with the marked versions rewritten.
 * @throws {ReleaseStepError} When the block markers are paired wrongly or no version is marked.
 */
function rewriteMarkedVersions(context, filePath, content, version, untouchedNote) {
  let update;

  try {
    update = updateVersionMarkers(content, version);
  } catch (error) {
    if (!(error instanceof VersionBlockError)) {
      throw error;
    }
    const { message, fix } = describeVersionBlockProblem(error, filePath);
    throw new ReleaseStepError(message, `${fix} y volvé a correr ${context.commands.createVersion}; ${untouchedNote}.`, { cause: error });
  }

  if (update.replacements === 0) {
    throw missingVersionMarkerError(context, filePath);
  }

  return update.content;
}

/**
 * A file of the release commit: its bytes before the release, kept exactly so a rollback writes
 * them back unchanged whatever they hold, and the content the release writes.
 *
 * @typedef {{ filePath: string, originalBytes: Buffer, content: string }} ReleaseFileUpdate
 */

/**
 * Reads a file the release rewrites, as its exact bytes and as text. The text is decoded strictly:
 * a file that is not valid UTF-8 (such as one saved as ISO-8859-1) stops the release, since writing
 * the decoded text back would replace its other bytes with U+FFFD. A byte order mark is kept.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} filePath - File relative to the root.
 * @param {string} fileLabel - How the messages name the file, such as `src/cli.js (versionFiles)`.
 * @param {string} conversionHint - Spanish action that fixes the encoding, without the rerun instruction.
 * @returns {{ originalBytes: Buffer, text: string }} Bytes on disk and their text.
 * @throws {ReleaseStepError} When the file is not valid UTF-8.
 */
function readReleaseFileText(context, filePath, fileLabel, conversionHint) {
  const originalBytes = readFileSync(path.join(context.repositoryRoot, filePath));

  try {
    return { originalBytes, text: decodeStrictUtf8(originalBytes) };
  } catch (error) {
    if (!(error instanceof InvalidUtf8Error)) {
      throw error;
    }
    throw new ReleaseStepError(
      `${fileLabel} no es texto UTF-8 válido (línea ${error.lineNumber}): reescribir su versión cambiaría también esos bytes.`,
      `${conversionHint} y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`,
      { cause: error }
    );
  }
}

/**
 * Identifies the file a path resolves to on disk (device and inode), so two paths reaching the same
 * file, such as hard links, are told apart from two separate files. `bigint` keeps the inode exact
 * where it does not fit a number (the file index on Windows).
 *
 * @param {string} absolutePath - Existing path.
 * @returns {string | null} Identity of the file, or `null` when the path is missing or the file system reports no inode.
 */
function readFileIdentity(absolutePath) {
  const stats = statSync(absolutePath, { bigint: true, throwIfNoEntry: false });
  return stats && stats.ino !== 0n ? `${stats.dev}:${stats.ino}` : null;
}

/**
 * Stops the release, before anything is written, when a `versionFiles` entry is the same file on
 * disk as `package.json`, `CHANGELOG.md` or another entry (a hard link, which neither the path
 * checks nor the symbolic link check can see): the release would write that file twice, each time
 * from its own snapshot, and the last write would undo the first one.
 *
 * @param {VersionFilesContext} context - Release context.
 * @returns {void}
 * @throws {ReleaseStepError} When two of the files the release writes are the same file.
 */
function requireVersionFilesWithoutAliases(context) {
  /** @type {Map<string, string>} */
  const pathsByIdentity = new Map();

  for (const builtInFile of RELEASE_COMMIT_BUILT_IN_FILES) {
    const identity = readFileIdentity(path.join(context.repositoryRoot, builtInFile));

    if (identity !== null) {
      pathsByIdentity.set(identity, builtInFile);
    }
  }

  for (const filePath of context.config.versionFiles) {
    const identity = readFileIdentity(path.join(context.repositoryRoot, filePath));

    if (identity === null) {
      continue;
    }

    const aliasedPath = pathsByIdentity.get(identity);

    if (aliasedPath !== undefined) {
      const removalHint = RELEASE_COMMIT_BUILT_IN_FILES.includes(aliasedPath)
        ? `Sacalo de versionFiles (el commit de release ya actualiza ${aliasedPath})`
        : "Dejá una sola de las dos entradas en versionFiles";
      throw new ReleaseStepError(
        `${filePath} (versionFiles) es el mismo archivo que ${aliasedPath} (un enlace duro): el release lo escribiría dos veces y una escritura pisaría la otra.`,
        `${removalHint} o reemplazá el enlace duro por una copia independiente, y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`
      );
    }

    pathsByIdentity.set(identity, filePath);
  }
}

/**
 * Stops the release, right before its files are read and rewritten, when `package.json` or a
 * `versionFiles` entry differs from `HEAD`: the run starts from a clean working tree, so the change
 * came from an earlier step (such as a check running `lint --fix`), and `git add` would put it in
 * the release commit next to the version. Git compares the content through its filters (line
 * endings, `.gitattributes`), so a checkout with converted line endings is not a change.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string[]} filePaths - Files the release rewrites only in their version, relative to the root.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When any of them differs from `HEAD`.
 */
async function requireReleaseFilesUnchangedFromHead(context, filePaths) {
  const listing = await context.reader.git(["diff", "--name-only", "-z", "HEAD", "--", ...filePaths.map(toLiteralPathspec)]);
  const changedPaths = listing.split("\0").filter((changedPath) => changedPath !== "");

  if (changedPaths.length > 0) {
    throw new ReleaseStepError(
      `${changedPaths.join(", ")} cambió respecto de HEAD antes de escribir la versión (por ejemplo, lo modificó un check como lint --fix): el commit de release incluiría ese cambio junto con la versión.`,
      `Revisalo con git diff HEAD -- ${changedPaths[0]}; commitealo en una rama y llevalo a ${MAIN_BRANCH}, o descartalo con git restore, y evitá que los checks modifiquen archivos; después volvé a correr ${context.commands.createVersion}; no se tocó la versión.`
    );
  }
}

/**
 * Computes the new content of every configured `versionFiles` entry, before anything is written,
 * so a missing file, a linked path, a file Git does not track, a file that is another release file
 * on disk (a hard link), a file changed since `HEAD`, a file that is not valid UTF-8, a file without
 * markers or with block markers paired wrongly stops the release with the version untouched.
 * `package.json` is checked against `HEAD` too, so it must be read after this call.
 *
 * @param {ReleaseContext} context - Release context.
 * @param {string} version - Version being released.
 * @returns {Promise<ReleaseFileUpdate[]>} Files to write, relative to the root, with their bytes before the release.
 * @throws {ReleaseStepError} When a file is missing, goes through a symbolic link, is not tracked by
 *   Git, is the same file as another release file, differs from `HEAD`, is not valid UTF-8, has
 *   block markers paired wrongly or none of its lines is marked.
 */
async function prepareVersionFileUpdates(context, version) {
  for (const filePath of context.config.versionFiles) {
    requireVersionFileWithoutLinks(context, filePath);

    if (!existsSync(path.join(context.repositoryRoot, filePath))) {
      throw new ReleaseStepError(`${filePath} (versionFiles) no existe.`, `Corregí versionFiles en beez-rp.config.(m)js y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`);
    }
  }

  await requireTrackedVersionFiles(context);
  requireVersionFilesWithoutAliases(context);
  await requireReleaseFilesUnchangedFromHead(context, [PACKAGE_MANIFEST_FILE, ...context.config.versionFiles]);

  return context.config.versionFiles.map((filePath) => {
    const { originalBytes, text } = readReleaseFileText(
      context,
      filePath,
      `${filePath} (versionFiles)`,
      "Convertilo a UTF-8 (por ejemplo, desde ISO-8859-1) y commitealo, o sacalo de versionFiles en beez-rp.config.(m)js,"
    );
    return { filePath, originalBytes, content: rewriteMarkedVersions(context, filePath, text, version, "no se tocó la versión") };
  });
}

/**
 * Writes the files of the release commit, restoring every one of them to its original bytes when
 * any write fails (a read-only file, a denying ACL, a full disk), so a failed bump never leaves
 * `package.json`, `CHANGELOG.md` or a `versionFiles` entry half rewritten.
 *
 * @param {ReleaseContext} context - Release context.
 * @param {ReleaseFileUpdate[]} fileUpdates - Files relative to the root, in writing order.
 * @returns {void}
 * @throws {ReleaseStepError} When a write fails, after restoring the files; the message also lists
 *   the files that could not be restored.
 */
function writeReleaseFiles(context, fileUpdates) {
  /** @type {ReleaseFileUpdate[]} */
  const touchedFiles = [];

  try {
    for (const fileUpdate of fileUpdates) {
      touchedFiles.push(fileUpdate);
      writeFileSync(path.join(context.repositoryRoot, fileUpdate.filePath), fileUpdate.content);
    }
  } catch (error) {
    const failedPath = touchedFiles.at(-1)?.filePath ?? "";
    const unrestoredPaths = touchedFiles.filter(({ filePath, originalBytes }) => !restoreFileBytes(path.join(context.repositoryRoot, filePath), originalBytes)).map(({ filePath }) => filePath);
    const restoreNote =
      unrestoredPaths.length === 0
        ? "se restauraron package.json, CHANGELOG.md y versionFiles, así que no se tocó la versión"
        : `no se pudieron restaurar ${unrestoredPaths.join(", ")}: recuperalos con git restore antes de reintentar`;
    throw new ReleaseStepError(
      `No se pudo escribir ${failedPath} para el release (${error instanceof Error ? error.message : String(error)}).`,
      `Revisá que el archivo se pueda escribir (permisos, atributo de solo lectura) y volvé a correr ${context.commands.createVersion}; ${restoreNote}.`,
      { cause: error }
    );
  }
}

/**
 * Writes back the original bytes of a release file after a failed write or commit.
 *
 * @param {string} absolutePath - File to restore.
 * @param {Buffer} originalBytes - Bytes before the release.
 * @returns {boolean} Whether the file holds its original bytes again.
 */
function restoreFileBytes(absolutePath, originalBytes) {
  try {
    if (!readFileSync(absolutePath).equals(originalBytes)) {
      writeFileSync(absolutePath, originalBytes);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Undoes a release whose files were written but whose commit failed (a rejected `git add`, a
 * `pre-commit` hook that fails): the index goes back to the tree it had before staging and every
 * release file to its original content, so nothing is left for the user to discard by hand and no
 * command has to quote the configured paths for a shell.
 *
 * @param {ReleaseContext} context - Release context.
 * @param {ReleaseFileUpdate[]} fileUpdates - Files the release wrote.
 * @param {string | null} indexTree - Tree of the index before staging (`git write-tree`), or `null` when Git could not write it.
 * @param {ReleaseStepError} failure - Failure of `git add` or `git commit`.
 * @returns {Promise<ReleaseStepError>} Failure to throw, whose hint says what was restored and what was not.
 */
async function rollBackUncommittedRelease(context, fileUpdates, indexTree, failure) {
  const indexRestored = indexTree !== null && (await context.reader.tryGit(["read-tree", indexTree])) !== null;
  const unrestoredPaths = fileUpdates.filter(({ filePath, originalBytes }) => !restoreFileBytes(path.join(context.repositoryRoot, filePath), originalBytes)).map(({ filePath }) => filePath);
  const pendingRestores = [
    ...(indexRestored ? [] : ["no se pudo volver el staging a como estaba: revisá git status y sacá del staging package.json, CHANGELOG.md y versionFiles"]),
    ...(unrestoredPaths.length === 0 ? [] : [`no se pudo restaurar el contenido de ${unrestoredPaths.join(", ")}: devolvelos a su contenido anterior (git diff muestra el cambio)`]),
  ];
  const restoreNote =
    pendingRestores.length === 0
      ? "se restauraron package.json, CHANGELOG.md y versionFiles (contenido y staging), así que no se tocó la versión"
      : `${pendingRestores.join("; ")}, antes de reintentar`;

  return new ReleaseStepError(failure.message, `${failure.hint} Después volvé a correr ${context.commands.createVersion}; ${restoreNote}.`, { cause: failure });
}

/**
 * Checks, before resuming a release commit that already exists (created by a previous run or by
 * hand), that every configured `versionFiles` entry in `HEAD` already carries the pending version
 * in its marked lines: the resume never rewrites them, so it would push or publish stale versions.
 * Everything is read from `HEAD`, the content that gets pushed: the working tree may hold local
 * changes that `--ignore-local-changes` sets aside afterwards.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} version - Version of the pending release.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When a file is missing from `HEAD` or is not a regular file there, has
 *   block markers paired wrongly, has no marked version or has a marked version other than the pending one.
 */
async function verifyReleasedVersionFiles(context, version) {
  for (const filePath of context.config.versionFiles) {
    const content = (await requireRegularFileInReleaseCommit(context, filePath, version)) ? await context.reader.git(["show", `HEAD:${filePath}`]) : null;

    if (content === null) {
      throw new ReleaseStepError(
        `${filePath} (versionFiles) no existe en el commit de release ${version} (HEAD).`,
        `Agregalo al commit de release con sus líneas marcadas en ${version}, o corregí versionFiles en beez-rp.config.(m)js, y volvé a correr ${context.commands.createVersion}; no se subió ni publicó nada.`
      );
    }

    if (rewriteMarkedVersions(context, filePath, content, version, "no se subió ni publicó nada") !== content) {
      throw new ReleaseStepError(
        `${filePath} (versionFiles) tiene en el commit de release (HEAD) una versión marcada distinta de ${version}.`,
        `Actualizá sus líneas marcadas a ${version} dentro del commit de release (git commit --amend, y recreá el tag ${toReleaseTag(version)} si ya existe en local) y volvé a correr ${context.commands.createVersion}; no se subió ni publicó nada.`
      );
    }
  }
}

/**
 * Checks, right after the release commit and before its tag, that Git stored the prepared
 * versions: a `.gitattributes` clean filter may change or drop a marked version while staging, and
 * the commit would carry the previous one. The commit stays local and untagged, so the next run
 * resumes it and checks it again before pushing.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} version - Version just committed.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When a `versionFiles` entry of the new commit does not carry `version`.
 */
async function verifyCommittedVersionFiles(context, version) {
  try {
    await verifyReleasedVersionFiles(context, version);
  } catch (error) {
    if (!(error instanceof ReleaseStepError)) {
      throw error;
    }
    throw new ReleaseStepError(
      `${error.message} Git guardó en el commit ${version} otro contenido que el preparado (por ejemplo, por un filtro clean de .gitattributes); no se creó el tag ${toReleaseTag(version)}.`,
      `Revisá los filtros de .gitattributes de ese archivo (git check-attr filter -- <archivo>). ${error.hint}`,
      { cause: error }
    );
  }
}

/**
 * Chooses the next version (flags or prompt), releases the CHANGELOG
 * `[Unreleased]` block and creates the release commit and annotated tag.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function bumpVersionStep(context) {
  // Re-read the manifest: syncing main may have brought a newer version.
  const currentVersion = /** @type {string} */ (readWorkingManifest(context.repositoryRoot).version);
  const lastReleaseSha = context.state.lastRelease?.sha;
  const commits = await listCommits(context.reader, lastReleaseSha ? `${lastReleaseSha}..HEAD` : "HEAD");
  print(renderCommitList(commits, `Qué se publica (${commits.length} commit(s))`));

  let nextRelease = resolveRequestedVersion(currentVersion, context.options);

  if (nextRelease) {
    print(`${ICON.info} Versión elegida por flag: ${paint(["bold", "cyan"], nextRelease.version)} (${nextRelease.releaseType})`);
  } else {
    const suggestion = suggestReleaseType(commits);
    const nextVersions = listNextVersions(currentVersion);
    const chosenVersion = await select({
      message: `¿Qué versión publicamos? (actual ${currentVersion})`,
      options: nextVersions.map((candidate) => ({
        label: `${candidate.releaseType.padEnd(5)}  ${currentVersion} → ${candidate.version}`,
        hint: candidate.releaseType === suggestion.releaseType ? `${ICON.star} sugerida: ${suggestion.reason}` : undefined,
        description: context.config.releaseTypeDescriptions[candidate.releaseType],
        value: candidate.version,
      })),
      // Nothing is preselected so a stray Enter never ships a version: the suggestion is only a hint.
      defaultIndex: null,
    });
    nextRelease = nextVersions.find((candidate) => candidate.version === chosenVersion) ?? null;
  }

  if (!nextRelease) {
    throw new ReleaseStepError("No se eligió ninguna versión.", `Volvé a correr ${context.commands.createVersion}.`);
  }

  const changelog = readReleaseFileText(context, CHANGELOG_FILE, CHANGELOG_FILE, `Convertí ${CHANGELOG_FILE} a UTF-8 (por ejemplo, desde ISO-8859-1)`);
  let releasedChangelog;

  try {
    releasedChangelog = releaseUnreleased(changelog.text, nextRelease.version, new Date().toISOString().split("T")[0]);
  } catch (error) {
    throw new ReleaseStepError(
      `CHANGELOG.md no está listo: ${error instanceof Error ? error.message : String(error)}`,
      `Completá ${UNRELEASED_HEADING} con ${CHANGE_TYPES.map((type) => `### ${type}`).join(", ")} y volvé a correr ${context.commands.createVersion}.`,
      { cause: error }
    );
  }

  const versionFileUpdates = await prepareVersionFileUpdates(context, nextRelease.version);
  // Read after prepareVersionFileUpdates, which checks that package.json still matches HEAD.
  const manifest = readReleaseFileText(context, PACKAGE_MANIFEST_FILE, PACKAGE_MANIFEST_FILE, `Convertí ${PACKAGE_MANIFEST_FILE} a UTF-8 y commitealo`);
  print(renderBox({ title: `CHANGELOG · ${UNRELEASED_HEADING} → [${nextRelease.version}]`, lines: readWorkingUnreleased(context.repositoryRoot).body.split("\n"), tone: BOX_TONE.info }));
  /** @type {ReleaseFileUpdate[]} */
  const releaseFileUpdates = [
    { filePath: PACKAGE_MANIFEST_FILE, originalBytes: manifest.originalBytes, content: manifest.text.replace(PACKAGE_VERSION_FIELD_PATTERN, `$1${nextRelease.version}$2`) },
    { filePath: CHANGELOG_FILE, originalBytes: changelog.originalBytes, content: releasedChangelog },
    ...versionFileUpdates,
  ];
  // The index before staging, so a failed commit puts it back exactly (a CHANGELOG.md the user staged stays staged).
  const indexTree = await context.reader.tryGit(["write-tree"]);
  writeReleaseFiles(context, releaseFileUpdates);

  const tag = toReleaseTag(nextRelease.version);
  // Literal pathspecs after `--`: a configured name such as `-v.txt` or `:version` is a file, never an option nor pathspec magic.
  const releaseFilePathspecs = releaseFileUpdates.map(({ filePath }) => toLiteralPathspec(filePath));

  try {
    await runGitStep(context, ["add", "--", ...releaseFilePathspecs], "No se pudo stagear package.json, CHANGELOG.md y versionFiles", "Revisá git status.");
    await runGitStep(context, ["commit", "--quiet", "-m", nextRelease.version], "El commit de versión falló", "Corregí el error (por ejemplo, un hook pre-commit que lo rechaza).");
  } catch (error) {
    if (!(error instanceof ReleaseStepError)) {
      throw error;
    }
    throw await rollBackUncommittedRelease(context, releaseFileUpdates, indexTree, error);
  }

  await verifyCommittedVersionFiles(context, nextRelease.version);
  await runGitStep(context, ["tag", "-a", tag, "-m", nextRelease.version], `No se pudo crear el tag ${tag}`, `Si ya existe, revisalo con git show ${tag}.`);

  context.version = nextRelease.version;
  context.commitCount = commits.length;
  print(`${ICON.success} Commit ${paint("bold", nextRelease.version)} y tag ${paint(["bold", "cyan"], tag)} creados en local.`);
}

/**
 * Runs the configured preparation (commands or hook) on the release commit.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function prepareReleaseStep(context) {
  const { prepare } = context.config;
  const version = requireReleaseVersion(context);

  if (Array.isArray(prepare)) {
    await runConfiguredCommands(context, prepare, `El release quedó en local: corregí el error y volvé a correr ${context.commands.createVersion}, que retoma desde acá.`);
  } else if (prepare) {
    await prepare(createHookContext(context.repositoryRoot, context.reader, version));
  }
}

/**
 * Pushes `main` and the release tag atomically, creating the tag when a resumed release lacks it.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function pushReleaseStep(context) {
  const version = requireReleaseVersion(context);
  const tag = toReleaseTag(version);

  if ((await context.reader.tryGit(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])) === null) {
    await runGitStep(context, ["tag", "-a", tag, "-m", version], `No se pudo crear el tag ${tag}`, `Revisá git tag --list ${tag}.`);
  }

  // Running `create-version` is the request to publish; `--dry-run` previews the plan.
  await runGitStep(
    context,
    ["push", "--atomic", RELEASE_REMOTE, MAIN_BRANCH, `refs/tags/${tag}`],
    `El push de ${MAIN_BRANCH} + ${tag} falló`,
    `El release quedó en local: corregí el error y corré ${context.commands.createVersion}, que retoma el push de ${tag}.`
  );

  if (!(await context.reader.tryGit(["ls-remote", "--tags", RELEASE_REMOTE, tag]))) {
    throw new ReleaseStepError(`${MAIN_BRANCH} se subió pero ${tag} no aparece en ${RELEASE_REMOTE}.`, `Subilo con git push ${RELEASE_REMOTE} ${tag}.`);
  }

  context.version = version;
  context.pushed = true;
}

/**
 * Pushes only the release tag of a detached `HEAD` whose commit `origin/main` already has, so
 * the detached publication can go on without touching `main`. The push is not forced: a tag that
 * already exists on `origin` with another commit rejects it.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When the push fails or the tag does not show up on `origin`.
 */
async function pushReleaseTagStep(context) {
  const version = requireReleaseVersion(context);
  const tag = toReleaseTag(version);

  await runGitStep(
    context,
    ["push", RELEASE_REMOTE, `refs/tags/${tag}`],
    `El push de ${tag} falló`,
    `No se publicó nada: corregí el error y corré ${context.commands.createVersion} desde ${tag} (HEAD desacoplado).`
  );

  if (!(await context.reader.tryGit(["ls-remote", "--tags", RELEASE_REMOTE, `refs/tags/${tag}`]))) {
    throw new ReleaseStepError(`${tag} no aparece en ${RELEASE_REMOTE} después del push.`, `Subilo con git push ${RELEASE_REMOTE} ${tag} y volvé a correr ${context.commands.createVersion} desde el tag.`);
  }

  context.version = version;
}

/**
 * Lists the tracked files that differ from `HEAD`. `prepare` may create untracked or ignored
 * output (`dist/`, `releases/`), but a modified tracked file (such as `package.json`) means
 * `npm pack --dry-run` would no longer read the release commit.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<string[]>} `git status --porcelain` lines of modified tracked files.
 * @throws {ReleaseStepError} When Git cannot report the working tree state.
 */
async function listTrackedChanges(context) {
  const output = await context.reader.tryGit(["status", "--porcelain", "--untracked-files=no"]);

  if (output === null) {
    throw new ReleaseStepError("No se pudo leer el estado del working tree antes de publicar.", `No se publicó nada. Revisá git status y volvé a correr ${context.commands.createVersion}.`);
  }

  return output.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Finds and verifies the archive prepared for the release when the project configured `artifact`.
 * The working tree must still be the release commit (no tracked file modified by `prepare`), the
 * manifest must not rely on rewrites only `pnpm pack` applies, and the archive must have the same
 * SHA-512 integrity `npm pack --dry-run --ignore-scripts` reports for that commit: `npm pack` is
 * reproducible, so equal hashes mean the archive is byte for byte what npm packs.
 *
 * @param {ReleaseContext} context - Release context.
 * @param {string} version - Version being published.
 * @param {Record<string, unknown>} workingManifest - Working tree `package.json`, after `prepare`.
 * @returns {Promise<string | null>} Verified archive path relative to the root, or `null` to publish the working tree.
 */
async function resolvePublishedArtifact(context, version, workingManifest) {
  const { artifact } = context.config;

  if (!artifact) {
    return null;
  }

  const trackedChanges = await listTrackedChanges(context);

  if (trackedChanges.length > 0) {
    throw new ReleaseStepError(
      `El paso de preparación modificó archivos versionados: ${trackedChanges.slice(0, MAX_LISTED_ITEMS).join("; ")}.`,
      `No se publicó nada. prepare puede generar archivos ignorados (dist/, releases/) pero no cambiar archivos versionados como package.json: revertí esos cambios y volvé a correr ${context.commands.createVersion}.`
    );
  }

  const pnpmRewrites = findPnpmPackRewrites(workingManifest);

  if (pnpmRewrites.length > 0) {
    throw new ReleaseStepError(
      `Este paquete depende de reescrituras de pnpm al empaquetar y beez-rp publica con npm: ${pnpmRewrites.slice(0, MAX_LISTED_ITEMS).join("; ")}.`,
      "No se publicó nada. Reemplazá los especificadores workspace:/catalog:/jsr: por rangos de versión y sacá de publishConfig los campos del manifest que solo pnpm aplica al empaquetar (exports, main, bin, types...): declaralos en la raíz de package.json."
    );
  }

  const release = { version, packageName: String(workingManifest.name) };
  const prepared = findPreparedArtifact(context.repositoryRoot, artifact, release);

  if (!prepared) {
    throw new ReleaseStepError(
      `No hay un artefacto preparado de ${version} que coincida con ${expandArtifactPattern(artifact, release)}.`,
      `Revisá la salida del paso de preparación y volvé a correr ${context.commands.createVersion}: retoma la preparación y la publicación.`
    );
  }

  if (!isSafeArtifactPath(prepared.path)) {
    throw new ReleaseStepError(`La ruta del artefacto ${prepared.path} tiene caracteres no permitidos.`, "Usá rutas con letras, números, ., -, _, @, +, ~ y /.");
  }

  // Without a `files` allowlist or an ignore rule, npm would pack the archive into the package it
  // describes; it is moved out of the root during the dry run and published later from its path.
  const npmPack = await withArtifactOutsidePackageRoot(context.repositoryRoot, prepared.path, () => readNpmPackIntegrity(context.repositoryRoot));

  if (!npmPack.pack) {
    throw new ReleaseStepError(
      `No se pudo verificar ${prepared.path}: ${npmPack.problem}.`,
      `No se publicó nada. Corré npm pack --dry-run --json --ignore-scripts en la raíz para ver el error y volvé a correr ${context.commands.createVersion}.`
    );
  }

  if (npmPack.pack.version !== version) {
    throw new ReleaseStepError(
      `npm pack --dry-run describe ${npmPack.pack.name}@${npmPack.pack.version} y se está publicando ${version}.`,
      `No se publicó nada. Revisá que HEAD sea el commit de release y volvé a correr ${context.commands.createVersion}.`
    );
  }

  const problems = verifyPreparedArtifact(context.repositoryRoot, prepared, npmPack.pack.integrity);

  if (problems.length > 0) {
    throw new ReleaseStepError(
      `El artefacto ${prepared.path} no se puede publicar: ${problems.join("; ")}.`,
      `No se publicó nada. Hacé que prepare empaquete con npm pack --ignore-scripts después de construir, borrá ese tarball y volvé a correr ${context.commands.createVersion}.`
    );
  }

  print(`${ICON.success} ${prepared.path} verificado${prepared.expectedSha256 ? " (SHA-256 de la ruta e integrity de npm pack)" : " (integrity de npm pack)"}.`);
  return prepared.path;
}

/**
 * Resolves the registry the release is published to: `publishConfig["@scope:registry"]` for a
 * scoped package, else `publishConfig.registry`, else the registry npm's config resolves in the
 * repository (project `.npmrc`, environment, global config).
 *
 * @param {Record<string, unknown>} manifest - Working tree `package.json`.
 * @param {string} repositoryRoot - Repository root.
 * @param {string} createVersionCommand - How the project runs create-version (for the hint).
 * @returns {Promise<string>} Registry URL, already checked to be a plain http(s) URL.
 * @throws {ReleaseStepError} When the registry is not a valid http(s) URL or npm cannot report it.
 */
async function resolveReleaseRegistry(manifest, repositoryRoot, createVersionCommand) {
  try {
    return await resolvePublishRegistry(manifest, repositoryRoot);
  } catch (error) {
    throw new ReleaseStepError(
      `No se puede publicar: ${error instanceof Error ? error.message : String(error)}.`,
      `No se publicó nada. Corregí el registry (publishConfig.registry o publishConfig["@scope:registry"] en package.json, o registry/@scope:registry en .npmrc) con una URL http(s) sin credenciales y volvé a correr ${createVersionCommand}.`
    );
  }
}

/**
 * Publishes the release with npm or the project hook.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function publishReleaseStep(context) {
  const version = requireReleaseVersion(context);
  const { publish } = context.config;

  if (publish === NPM_PUBLISHER) {
    // Syncing main may have renamed the package after the diagnosis: publish under the current name.
    const manifest = readWorkingManifest(context.repositoryRoot);
    const packageName = String(manifest.name);
    context.packageName = packageName;
    const registryUrl = await resolveReleaseRegistry(manifest, context.repositoryRoot, context.commands.createVersion);
    context.registryUrl = registryUrl;
    const authConfigLine = buildNpmAuthConfigLine(registryUrl);
    const artifactPath = await resolvePublishedArtifact(context, version, manifest);
    if (artifactPath) {
      print(paint("gray", `Publicando ${artifactPath}; npm puede pedir la confirmación 2FA en el navegador o un código.`));
    }
    const result = await publishToNpm(context.repositoryRoot, { authConfigLine, artifactPath });

    if (result.missingToken) {
      throw new ReleaseStepError(
        `Falta ${NPM_TOKEN_VARIABLE} para publicar ${version}.`,
        `Definilo en ${NPM_TOKEN_LOCATIONS} y corré ${context.commands.createVersion}: retoma solo la publicación.`
      );
    }

    if (result.exitCode !== 0) {
      // npm inherited the terminal (2FA), so its output cannot be parsed: the credentials are checked again.
      const npmAuth = await checkNpmPublishAccess(packageName, context.repositoryRoot, registryUrl);
      const failure = describeNpmPublishFailure(npmAuth, { exitCode: result.exitCode, version }, context.commands);
      throw new ReleaseStepError(failure.message, failure.hint);
    }

    // npm view ignores publishConfig, so the registry the release went to is queried explicitly.
    const npm = await lookupPublishedVersions(packageName, context.repositoryRoot, registryUrl);
    if (!npm.publishedVersions.includes(version)) {
      print(`${ICON.warning} ${paint("yellow", `npm todavía no muestra ${version}; puede tardar unos segundos en propagarse.`)}`);
    }
  } else if (publish) {
    await publish(createHookContext(context.repositoryRoot, context.reader, version));
  }

  context.version = version;
  context.published = true;
}

/**
 * Executors of each plan step.
 *
 * @type {Record<string, (context: ReleaseContext) => Promise<void>>}
 */
const STEP_EXECUTORS = {
  [RELEASE_STEP.syncMain]: syncMainStep,
  [RELEASE_STEP.applyMigrations]: applyMigrationsStep,
  [RELEASE_STEP.generateChangelog]: generateChangelogStep,
  [RELEASE_STEP.runChecks]: runChecksStep,
  [RELEASE_STEP.bumpVersion]: bumpVersionStep,
  [RELEASE_STEP.prepareRelease]: prepareReleaseStep,
  [RELEASE_STEP.pushRelease]: pushReleaseStep,
  [RELEASE_STEP.pushReleaseTag]: pushReleaseTagStep,
  [RELEASE_STEP.publishRelease]: publishReleaseStep,
};

/**
 * Renders the closing summary of a pushed or published release.
 *
 * @param {ReleaseContext} context - Release context.
 * @param {string} remoteUrl - `origin` URL.
 * @param {number} startedAt - Start timestamp.
 * @returns {string} Box.
 */
function renderReleaseSummary(context, remoteUrl, startedAt) {
  const version = /** @type {string} */ (context.version);
  const tag = toReleaseTag(version);
  const lines = [`${ICON.success} ${paint("bold", "Versión")}   ${paint(["bold", "greenBright"], version)}  ${paint("gray", `(${tag})`)}`];

  if (context.commitCount !== null) {
    lines.push(`${ICON.success} ${paint("bold", "Commits")}   ${context.commitCount}`);
  }

  if (context.pushed) {
    lines.push(`${ICON.success} ${paint("bold", "Git")}       ${MAIN_BRANCH} + ${tag} en ${RELEASE_REMOTE}`);
  }

  if (context.published && context.registryUrl) {
    lines.push(`${ICON.success} ${paint("bold", "npm")}       ${describePublishedRelease({ registryUrl: context.registryUrl, packageName: context.packageName, version })}`);
  }

  const githubRepository = GITHUB_REPOSITORY_PATTERN.exec(remoteUrl)?.[1];
  const previousSha = context.state.lastRelease?.sha;
  if (githubRepository && previousSha) {
    lines.push(`${ICON.info} ${paint("bold", "Cambios")}   https://github.com/${githubRepository}/compare/${previousSha.slice(0, SHORT_SHA_LENGTH)}...${tag}`);
  }

  for (const line of context.config.summary) {
    lines.push(`${ICON.info} ${line.replaceAll(SUMMARY_VERSION_PLACEHOLDER, version)}`);
  }

  lines.push("", paint("gray", `Tiempo total: ${formatDuration(measureActiveMs(startedAt))} (sin contar la espera de tus respuestas)`));

  return renderBox({ title: `${ICON.rocket} ${tag} publicado`, lines, tone: BOX_TONE.success });
}

/**
 * Explains, after a failed step, that the release already reached `origin` and only the
 * publication is missing, so the user knows GitHub has it and npm does not.
 *
 * @param {ReleaseContext} context - Release context.
 * @param {string} remoteUrl - `origin` URL.
 * @returns {Promise<string | null>} Spanish summary, or `null` when the release tag is not on `origin` or it was published.
 */
async function describeReleaseOnOrigin(context, remoteUrl) {
  const version = context.version;

  if (!version || context.published || !context.config.publish) {
    return null;
  }

  const tag = toReleaseTag(version);
  const tagOnOrigin = context.pushed || Boolean(await context.reader.tryGit(["ls-remote", "--tags", RELEASE_REMOTE, `refs/tags/${tag}`]));

  if (!tagOnOrigin) {
    return null;
  }

  const host = GITHUB_REPOSITORY_PATTERN.test(remoteUrl) ? "GitHub" : RELEASE_REMOTE;
  const target = context.config.publish === NPM_PUBLISHER ? "publicar en npm" : "publicar el release";

  // A detached release is published from its tag and never pushes `main`.
  if (!context.state.currentBranch) {
    return `${tag} ya está en ${host} (tag); falta ${target}. Corré ${context.commands.createVersion} desde ${tag} (HEAD desacoplado) para reintentar solo la publicación.`;
  }

  if (context.pushed || (await isTagCommitOnRemoteMain(context.reader, tag))) {
    return `${tag} ya está en ${host} (${MAIN_BRANCH} + tag); falta ${target}. Corré ${context.commands.createVersion} para reintentar solo la publicación.`;
  }

  return `${tag} ya está en ${host} solo como tag: ${MAIN_BRANCH} de ${RELEASE_REMOTE} todavía no tiene el commit del release; faltan subir ${MAIN_BRANCH} y ${target}. Corré ${context.commands.createVersion} para retomar desde el push.`;
}

/**
 * Tells whether `main` on `origin` already contains the commit a release tag points at. The remote
 * ref is read with `git ls-remote`, independently of the tag, because a prior or manual push may
 * have sent only the tag.
 *
 * @param {GitReader} reader - Git reader of the repository.
 * @param {string} tag - Release tag, such as `v1.2.0`.
 * @returns {Promise<boolean>} `true` when remote `main` includes the tag commit; `false` when it
 *   does not, or when it cannot be decided (no remote `main`, or its commit is not fetched locally).
 */
async function isTagCommitOnRemoteMain(reader, tag) {
  const remoteMainLine = await reader.tryGit(["ls-remote", RELEASE_REMOTE, `refs/heads/${MAIN_BRANCH}`]);
  const remoteMainSha = remoteMainLine?.trim().split(/\s+/u)[0];

  if (!remoteMainSha) {
    return false;
  }

  return (await reader.tryGit(["merge-base", "--is-ancestor", `refs/tags/${tag}^{commit}`, remoteMainSha])) !== null;
}

/**
 * Tells whether the npm lookup of the diagnosis ran and failed, so the plan is blocked before it
 * could show a publication step.
 *
 * @param {{ npm: import("./npm.js").NpmLookup | null }} snapshot - Snapshot without credentials.
 * @returns {boolean} `true` when npm was queried and did not answer with the published versions.
 */
function hasFailedNpmLookup(snapshot) {
  return snapshot.npm !== null && snapshot.npm.status !== NPM_LOOKUP_STATUS.ok;
}

/**
 * Runs `create-version` in a repository.
 *
 * @param {{ repositoryRoot: string, argv: string[] }} options - Repository root and arguments after the command name.
 * @returns {Promise<number>} Process exit code.
 */
export async function runCreateVersion({ repositoryRoot, argv }) {
  const startedAt = Date.now();
  // Usage and argument errors are printed before the configuration loads.
  const usage = buildReleaseUsage(describeProjectCommands(detectPackageManager(repositoryRoot)));
  let options;

  try {
    options = parseReleaseArguments(argv);
  } catch (error) {
    print(`${ICON.failure} ${paint("red", error instanceof Error ? error.message : String(error))}`);
    print(usage);
    return FAILURE_EXIT_CODE;
  }

  if (options.help) {
    print(usage);
    return 0;
  }

  let config;

  try {
    config = await loadCreateVersionConfig(repositoryRoot);
  } catch (error) {
    print(`${ICON.failure} ${paint("red", error instanceof Error ? error.message : String(error))}`);
    return FAILURE_EXIT_CODE;
  }

  const reader = createGitReader(repositoryRoot);
  const remoteUrl = (await reader.tryGit(["remote", "get-url", RELEASE_REMOTE])) ?? "";
  const { migrations } = config;
  const capabilities = describeReleaseCapabilities(config);
  const planOptions = { skipUnpublished: options.skipUnpublished, ignoreLocalChanges: options.ignoreLocalChanges };
  const spinner = startSpinner("Diagnosticando el repositorio");
  let state;

  try {
    state = await collectReleaseState({
      repositoryRoot,
      trackNpm: config.registry === RELEASE_REGISTRY.npm,
      checkMigrations: migrations ? () => migrations.check(createHookContext(repositoryRoot, reader, null)) : null,
      // The credentials are checked when the plan would publish to npm, and also when the npm lookup
      // failed: an authenticated `npm view` rejected with E401/E403 means the token, not the connection, is wrong.
      checkNpmAuth: (snapshot) =>
        config.publish === NPM_PUBLISHER &&
        // Planned as if local changes were ignored: the run may still offer to ignore them, and
        // that plan must not publish with unchecked credentials.
        (hasFailedNpmLookup(snapshot) ||
          buildReleasePlan(snapshot, capabilities, { ...planOptions, ignoreLocalChanges: true }).steps.some((planStep) => planStep.id === RELEASE_STEP.publishRelease)),
      onProgress: (label) => spinner.update(label),
    });
    spinner.succeed("Diagnóstico completo");
  } catch (error) {
    spinner.fail("No se pudo diagnosticar el repositorio");
    print(paint("red", error instanceof Error ? error.message : String(error)));
    return FAILURE_EXIT_CODE;
  }

  const latestPublished = state.npm?.publishedVersions.at(-1);
  const publishedLabel = state.npm
    ? latestPublished ? `v${latestPublished} en npm` : null
    : state.releasedVersion ? `v${state.releasedVersion} ${config.publishedLabel}` : null;
  print(renderBanner({ projectName: config.projectName ?? state.packageName, publishedLabel }));
  print(renderDiagnosis(state, repositoryRoot));

  let plan = buildReleasePlan(state, capabilities, planOptions);

  // Uncommitted changes are the only blocker when ignoring them unblocks the plan: an interactive
  // run asks instead of stopping (a dry run, or one without terminal, keeps the blocker and its hint).
  if (plan.blockers.length > 0 && !options.ignoreLocalChanges && !options.dryRun && process.stdin.isTTY) {
    const planIgnoringChanges = buildReleasePlan(state, capabilities, { ...planOptions, ignoreLocalChanges: true });

    if (planIgnoringChanges.blockers.length === 0 && planIgnoringChanges.steps.length > 0) {
      if (!(await askToIgnoreLocalChanges(listLocalChangesToSetAside(state, planIgnoringChanges.mode)))) {
        print(`${ICON.info} Release cancelado: no se tocó nada. Commiteá o guardá los cambios y volvé a correr ${config.commands.createVersion}.`);
        return 0;
      }

      options = { ...options, ignoreLocalChanges: true };
      plan = planIgnoringChanges;
    }
  }

  if (plan.mode === RELEASE_MODE.upToDate) {
    const since = state.lastRelease?.version ? toReleaseTag(state.lastRelease.version) : "el inicio";
    print(renderBox({ title: "Todo al día", lines: [`${ICON.success} No hay nada nuevo para publicar desde ${since}.`], tone: BOX_TONE.success }));
    return 0;
  }

  if (plan.mode === RELEASE_MODE.newRelease) {
    print(renderCommitList(state.unreleasedCommits, "Commits sin publicar"));
  }

  print(renderPlan(plan));

  // A blocker is an expected outcome already explained in the box, not a command failure.
  if (plan.blockers.length > 0) {
    return 0;
  }

  if (plan.mode === RELEASE_MODE.newRelease && state.headVersion) {
    try {
      resolveRequestedVersion(state.headVersion, options);
    } catch (error) {
      print(`${ICON.failure} ${paint("red", error instanceof Error ? error.message : String(error))}`);
      return FAILURE_EXIT_CODE;
    }
  } else if (plan.mode === RELEASE_MODE.resume && (options.bump || options.setVersion)) {
    print(`${ICON.warning} ${paint("yellow", `Se ignoran --bump y --set-version: se retoma ${plan.pendingVersion}, que ya tiene versión y CHANGELOG.`)}`);
  }

  // A resume never rewrites versionFiles: before pushing or publishing, HEAD must already carry the pending version.
  if (plan.mode === RELEASE_MODE.resume && plan.pendingVersion) {
    try {
      await verifyReleasedVersionFiles({ repositoryRoot, config, reader, commands: config.commands }, plan.pendingVersion);
    } catch (error) {
      const hint = error instanceof ReleaseStepError ? ` ${error.hint}` : "";
      print(`${ICON.failure} ${paint("red", `${error instanceof Error ? error.message : String(error)}${hint}`)}`);
      return FAILURE_EXIT_CODE;
    }
  }

  if (options.dryRun) {
    print(`${ICON.info} ${paint("cyan", `--dry-run: no se cambió nada. Corré ${config.commands.createVersion} para ejecutar el plan.`)}`);
    return 0;
  }

  // The version prompt has no default, so it cannot answer itself without a terminal: fail before
  // any step runs instead of after the checks.
  if (plan.steps.some((planStep) => planStep.id === RELEASE_STEP.bumpVersion) && !options.bump && !options.setVersion && !process.stdin.isTTY) {
    print(`${ICON.failure} ${paint("red", `Sin terminal interactiva no se puede elegir la versión: usá --${CREATE_VERSION_FLAG.bump} patch|minor|major o --${CREATE_VERSION_FLAG.setVersion} X.Y.Z.`)}`);
    return FAILURE_EXIT_CODE;
  }

  /** @type {ReleaseContext} */
  const context = {
    repositoryRoot,
    config,
    state,
    options,
    reader,
    version: plan.pendingVersion,
    pushed: false,
    published: false,
    commitCount: null,
    packageName: state.packageName,
    registryUrl: null,
    commands: config.commands,
  };
  const changesToSetAside = options.ignoreLocalChanges ? listLocalChangesToSetAside(state, plan.mode) : [];
  let setAside = null;

  if (changesToSetAside.length > 0) {
    try {
      setAside = await setAsideLocalChanges(reader, { keepChangelog: plan.mode === RELEASE_MODE.newRelease, createVersionCommand: config.commands.createVersion });
    } catch (error) {
      const hint = error instanceof ReleaseStepError ? ` ${error.hint}` : "";
      print(`${ICON.failure} ${paint("red", `${error instanceof Error ? error.message : String(error)}${hint}`)}`);
      return FAILURE_EXIT_CODE;
    }

    print(`${ICON.info} ${changesToSetAside.length} cambio(s) sin commitear apartados con git stash; al terminar vuelven igual: lo staged staged y el resto sin stagear.`);
  }

  try {
    return await runPlanSteps(context, plan, remoteUrl, startedAt);
  } finally {
    if (setAside) {
      const restore = await restoreLocalChanges(reader, repositoryRoot, setAside);
      print(
        restore.restored
          ? `${ICON.success} Cambios sin commitear restaurados como estaban: lo staged sigue staged y el resto sin stagear.`
          : `${ICON.warning} ${paint("yellow", `No se pudieron restaurar los cambios sin commitear (${restore.reason}): cuando lo resuelvas, recuperalos con git stash pop --index.`)}`
      );
    }
  }
}

/**
 * Runs the plan steps in order and prints the outcome.
 *
 * @param {ReleaseContext} context - Release context.
 * @param {import("./plan.js").ReleasePlan} plan - Runnable plan.
 * @param {string} remoteUrl - URL of the release remote, for the summary.
 * @param {number} startedAt - Start time of the command, in milliseconds.
 * @returns {Promise<number>} Process exit code.
 */
async function runPlanSteps(context, plan, remoteUrl, startedAt) {
  for (const [index, planStep] of plan.steps.entries()) {
    print(renderStepHeader(index + 1, plan.steps.length, planStep.title));

    try {
      await STEP_EXECUTORS[planStep.id](context);
    } catch (error) {
      if (error instanceof ReleaseCancelledError) {
        return 0;
      }

      // Not a failure: the run ends on purpose so the next one diagnoses the updated main.
      if (error instanceof MainSyncedRestartError) {
        print(
          renderBox({
            title: `${MAIN_BRANCH} actualizado`,
            lines: [`${ICON.info} ${buildMainSyncedRestartMessage(context.commands.createVersion)}`, "", paint("gray", "No se tocó la versión ni los tags.")],
            tone: BOX_TONE.info,
          })
        );
        return 0;
      }

      const lines = [`${ICON.failure} ${error instanceof Error ? error.message : String(error)}`];
      if (error instanceof ReleaseStepError) {
        lines.push("", `${paint("bold", "Qué hacer:")} ${error.hint}`);
      }
      const releaseOnOrigin = await describeReleaseOnOrigin(context, remoteUrl);
      lines.push("", releaseOnOrigin ? `${ICON.warning} ${paint("bold", releaseOnOrigin)}` : paint("gray", `${context.commands.createVersion} retoma desde el primer paso que falte.`));
      print(renderBox({ title: `Falló el paso ${index + 1}: ${planStep.title}`, lines, tone: BOX_TONE.danger }));
      return FAILURE_EXIT_CODE;
    }
  }

  print("");
  print(
    context.version && (context.pushed || context.published)
      ? renderReleaseSummary(context, remoteUrl, startedAt)
      : renderBox({ title: "Listo", lines: [`${ICON.success} Plan completado en ${formatDuration(measureActiveMs(startedAt))}.`], tone: BOX_TONE.success })
  );

  return 0;
}
