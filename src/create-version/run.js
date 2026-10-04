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

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CHANGELOG_FILE, CHANGELOG_UPDATE_REQUIRED_CODE } from "../constants/changelog.js";
import {
  CREATE_VERSION_FLAG,
  FAILURE_EXIT_CODE,
  GITHUB_REPOSITORY_PATTERN,
  MAIN_BRANCH,
  MAX_LISTED_COMMITS,
  MAX_LISTED_ITEMS,
  MIGRATION_STATUS,
  NPM_AUTH_STATUS,
  NPM_LOOKUP_STATUS,
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
import { GIT_LITERAL_PATHSPEC_PREFIX, VERSION_BLOCK_END_MARKERS, VERSION_BLOCK_PROBLEM, VERSION_BLOCK_START_MARKERS } from "../constants/version-files.js";
import { updateVersionMarkers, VersionBlockError } from "../version-files.js";
import { listNextVersions, resolveRequestedVersion, suggestNextReleaseType, toReleaseTag } from "../versions.js";
import {
  expandArtifactPattern,
  findPnpmPackRewrites,
  findPreparedArtifact,
  isSafeArtifactPath,
  verifyPreparedArtifact,
  withArtifactOutsidePackageRoot,
} from "./artifact.js";
import { describeReleaseTypes, loadCreateVersionConfig } from "./config.js";
import { assertPreservedFilesUnchanged, verifyChangelogUpdate } from "./changelog.js";
import { ReleaseStepError } from "./errors.js";
import {
  describePublishedRelease,
  readNpmPackIntegrity,
} from "./npm.js";
import { describeNpmPublishFailure, describeNpmTokenSource } from "./npm-auth.js";
import { restoreLocalChanges, setAsideLocalChanges } from "./local-changes.js";
import { describeProjectCommands, detectPackageManager } from "../package-manager.js";
import { buildReleasePlan, buildReleaseUsage, listLocalChangesToSetAside, parseReleaseArguments } from "./plan.js";
import { createGitReader, listCommits, runCommandLine, runInherited } from "./process.js";
import { collectReleaseState } from "./state.js";
import { isRegistryProvider } from "./registry-config.js";
import { checkRegistryAccess, lookupRegistryVersions, publishRegistryRelease, resolveRegistry, selectProjectRegistry } from "./registry.js";
import { prepareJsrVersionUpdates, readJsrManifest } from "./jsr.js";
import { JSR_REGISTRY_PROVIDER, REGISTRY_LABELS } from "../constants/registry.js";
import { CI_DISPATCH_STATUS, CI_GIT_HOOKS_OPTION, CI_VERCEL_DEPLOYMENT, CI_WORKFLOW_DIRECTORY, DISPATCH_CI_RELEASE_STEP, RELEASE_EXECUTION } from "../constants/ci-release.js";
import { appendCiDispatch, assertCiCompatiblePublication, assertCiWorkflowFile, assertGeneratedCiWorkflowCurrent, assertResumeExecutionMatches, buildCiWorkerPlan, chooseReleaseExecution, defaultCiReleaseConfig, readCiReleaseIdentity } from "./ci.js";
import { assertCiSetupFilesUnchanged, describeCiEnvironment, prepareCiReleaseMetadata, prepareCiSetupFiles } from "./ci-setup.js";
import { createGithubWorkflowClient } from "./github-workflow.js";
import { findLastRelease } from "./state.js";

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
 *   registryLabel: string | null,
 *   commands: import("../package-manager.js").ProjectCommands,
 *   changelogFiles: import("./changelog.js").PreservedReleaseFile[],
 *   execution?: "local" | "ci",
 *   ciWorker?: boolean,
 *   ciSetupFiles?: ReleaseFileUpdate[],
 *   workflowClient?: import("./github-workflow.js").GithubWorkflowClient,
 * }} ReleaseContext
 * @typedef {{
 *   repositoryRoot: string,
 *   reader: GitReader,
 *   config: ResolvedCreateVersionConfig,
 *   commands: import("../package-manager.js").ProjectCommands,
 *   state: { migrations: import("./config.js").MigrationCheck | null },
 *   execution?: "local" | "ci",
 *   ciWorker?: boolean,
 *   version?: string | null,
 * }} StepContext
 *   What the steps shared with the monorepo mode read: both release contexts satisfy it.
 * @typedef {{ mode: string, steps: import("./plan.js").ReleasePlanStep[], blockers: import("./plan.js").ReleaseBlocker[], warnings: string[] }} RenderablePlan
 */

/** Raised when the user cancels on purpose; ends the run without an error box. */
export class ReleaseCancelledError extends Error {}

/**
 * Raised after syncing `main` brought new commits: the diagnosis, the plan and the configuration
 * (with every module it imports) belong to the previous `main`, so the run ends without an error
 * and asks to run the command again in a new process.
 */
export class MainSyncedRestartError extends Error {}

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
export async function askToIgnoreLocalChanges(changes) {
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
export function renderCommitList(commits, title) {
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
export function checkPinnedNodeVersion(repositoryRoot) {
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
        state.npm.registryLabel ?? "npm",
        state.npm.status === NPM_LOOKUP_STATUS.ok ? `${state.npm.tag ?? "latest"} ${paint("cyan", latestPublished ?? "ninguna todavía")}` : paint("red", "no respondió")
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

  if (state.unreleasedCommits.length > 0) {
    rows.push(renderRow(state.changelog.updated ? ICON.success : ICON.warning, "CHANGELOG", state.changelog.updated ? "actualizado manualmente; se conserva sin cambios" : state.changelog.reason ?? "sin actualización manual desde el último release"));
  } else {
    rows.push(renderRow(ICON.info, "CHANGELOG", "sin actualización requerida"));
  }

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
export function renderNpmAuthRow(npmAuth) {
  const source = describeNpmTokenSource(npmAuth);
  const label = `${npmAuth.registryLabel ?? "npm"} auth`;

  switch (npmAuth.status) {
    case NPM_AUTH_STATUS.ok:
      return npmAuth.firstPublication
        ? renderRow(ICON.success, label, `${npmAuth.user} (${source})${paint("gray", " · primera publicación")}`)
        : renderRow(ICON.success, label, `${npmAuth.user} (${source}), dueño de ${npmAuth.packageName}${paint("gray", `; ${NPM_WRITE_ACCESS_UNVERIFIED_NOTE}`)}`);
    case NPM_AUTH_STATUS.missingToken:
      return renderRow(ICON.failure, label, paint("red", `falta ${npmAuth.tokenVariable ?? NPM_TOKEN_VARIABLE}`));
    case NPM_AUTH_STATUS.invalidToken:
      return renderRow(ICON.failure, label, paint("red", `token inválido o vencido (${source})`));
    case NPM_AUTH_STATUS.notOwner:
      return renderRow(ICON.failure, label, paint("red", `${npmAuth.user} no puede publicar ${npmAuth.packageName} (${source})`));
    case NPM_AUTH_STATUS.projectCredentials:
      return renderRow(ICON.failure, label, paint("red", `el ${PROJECT_NPM_CONFIG_FILE} del proyecto define credenciales que pisan ${npmAuth.tokenVariable ?? NPM_TOKEN_VARIABLE}`));
    case NPM_AUTH_STATUS.unsupportedAuth:
      return renderRow(ICON.failure, label, paint("red", npmAuth.reason ?? "autenticación no disponible"));
    default:
      return renderRow(ICON.warning, label, paint("yellow", `no verificable (${source}): ${npmAuth.reason ?? "permiso de escritura no verificable"}`));
  }
}

/**
 * Renders the plan or its blockers.
 *
 * @param {RenderablePlan} plan - Plan.
 * @returns {string} Box.
 */
export function renderPlan(plan) {
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
 * @param {StepContext} context - Release context.
 * @param {string[]} gitArguments - Git arguments.
 * @param {string} failureMessage - Spanish message when it fails.
 * @param {string} hint - Spanish next action.
 * @returns {Promise<void>}
 */
export async function runGitStep(context, gitArguments, failureMessage, hint) {
  const argumentsWithHooks = context.execution === RELEASE_EXECUTION.ci ? ["-c", CI_GIT_HOOKS_OPTION, ...gitArguments] : gitArguments;
  const exitCode = await runInherited("git", argumentsWithHooks, { cwd: context.repositoryRoot });

  if (exitCode !== 0) {
    throw new ReleaseStepError(`${failureMessage} (git ${gitArguments[0]} salió con código ${exitCode}).`, hint);
  }
}

/**
 * Runs configured command lines in order, stopping at the first failure.
 *
 * @param {StepContext} context - Release context.
 * @param {string[]} commandLines - Commands from `beez-rp.config.js`.
 * @param {string} hint - Spanish next action when one fails.
 * @returns {Promise<void>}
 */
export async function runConfiguredCommands(context, commandLines, hint) {
  for (const commandLine of commandLines) {
    print(paint("gray", `$ ${commandLine}`));
    const exitCode = await runCommandLine(commandLine, context.repositoryRoot);

    if (exitCode !== 0) {
      throw new ReleaseStepError(`${commandLine} falló con código ${exitCode}.`, hint);
    }
  }
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
 * @param {string} [registryLabel] - Provider discovered from the resolved endpoint.
 * @returns {import("./plan.js").ReleaseCapabilities} Capabilities for `buildReleasePlan`.
 */
export function describeReleaseCapabilities(config, registryLabel) {
  return {
    checks: (config.checks?.length ?? 0) > 0,
    checksMissing: config.checks === null,
    prepare: config.prepare !== null,
    publish: config.publish !== null,
    publishTitle: isRegistryProvider(config.publish) ? `Publicar en ${registryLabel ?? REGISTRY_LABELS[config.publish]}` : "Publicar el release",
    commands: config.commands,
  };
}

/**
 * Fast-forwards local `main` to `origin/main`. When that brings new commits the release stops
 * before touching the version: the diagnosis, the plan and `beez-rp.config.(m)js` (imported with
 * its modules at startup) come from the previous `main`, so the command must run again in a new
 * process to diagnose with the new code and configuration.
 *
 * @param {StepContext} context - Release context.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When the fast-forward fails.
 * @throws {MainSyncedRestartError} When `main` moved and the command has to run again.
 */
export async function syncMainStep(context) {
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
 * @param {StepContext} context - Release context.
 * @returns {Promise<void>}
 */
export async function applyMigrationsStep(context) {
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

  const hookContext = createHookContext(context.repositoryRoot, context.reader, context.ciWorker ? context.version ?? null : null);
  await adapter.apply(hookContext);
  const recheck = await adapter.check(hookContext);

  if (recheck.status === MIGRATION_STATUS.pending) {
    throw new ReleaseStepError(
      `Siguen pendientes ${recheck.pending.length} migración(es) después de migrar.`,
      context.ciWorker ? "Revisá el journal y la base antes de reintentar este mismo tag; no se publicó el release." : "Revisá el journal de migraciones y la tabla de migraciones aplicadas; no se subió ninguna versión."
    );
  }

  if (context.ciWorker && recheck.status !== MIGRATION_STATUS.upToDate) {
    context.state.migrations = recheck;
    throw new ReleaseStepError("Las migraciones se ejecutaron, pero no se pudo confirmar que la base esté al día.", "Verificá la base y las credenciales antes de reintentar el workflow de este mismo tag; no se publicó el release.");
  }

  print(`${ICON.success} Base de datos al día.`);
}

/**
 * Verifies the manual changelog before migrations or checks, preserving its exact bytes.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function verifyChangelogStep(context) {
  context.changelogFiles = [await verifyChangelogUpdate(context, CHANGELOG_FILE, context.state.lastRelease?.sha ?? null)];
  if (context.config.publish === JSR_REGISTRY_PROVIDER && context.state.headVersion) {
    const candidate = listNextVersions(context.state.headVersion)[0].version;
    await prepareJsrVersionUpdates(context, context.repositoryRoot, context.config.publication, candidate);
  }
  print(`${ICON.success} ${CHANGELOG_FILE} actualizado manualmente; se conserva sin reescribirlo.`);
}

/**
 * Runs the configured checks before touching the version.
 *
 * @param {StepContext} context - Release context.
 * @returns {Promise<void>}
 */
export async function runChecksStep(context) {
  await runConfiguredCommands(context, context.config.checks ?? [], "Corregí el error de arriba; todavía no se tocó la versión.");
}

/**
 * A file of the release commit: its bytes before the release, kept so a rollback writes them back
 * exactly, and the content the release writes.
 *
 * @typedef {{ filePath: string, originalBytes: Buffer | null, content: string }} ReleaseFileUpdate
 *   `null` means the file was absent and must be removed on rollback.
 */

/**
 * @typedef {Pick<StepContext, "repositoryRoot" | "config" | "reader" | "commands">} VersionFilesContext
 */

/** Strict UTF-8 decoder: invalid bytes throw instead of turning into U+FFFD, and a byte order mark is kept as text. */
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reads a file the release rewrites, as its exact bytes and as strict UTF-8 text: writing back the
 * text of a file that is not UTF-8 (such as ISO-8859-1) would replace its other bytes.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} filePath - File relative to the root, `/`-separated.
 * @param {string} fileLabel - How the messages name the file, such as `src/cli.js (versionFiles)`.
 * @returns {{ originalBytes: Buffer, text: string }} Bytes on disk and their text.
 * @throws {ReleaseStepError} When the file is not valid UTF-8.
 */
export function readReleaseFile(context, filePath, fileLabel) {
  const originalBytes = readFileSync(path.join(context.repositoryRoot, filePath));

  try {
    return { originalBytes, text: STRICT_UTF8_DECODER.decode(originalBytes) };
  } catch (error) {
    throw new ReleaseStepError(
      `${fileLabel} no es texto UTF-8 válido: reescribir su versión cambiaría también otros bytes.`,
      `Convertilo a UTF-8 y commitealo, y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`,
      { cause: error }
    );
  }
}

/**
 * Writes a new version into the top-level `version` of a manifest, keeping the rest of its bytes.
 * The text replacement changes the first `"version"` field of the file, so the result is parsed to
 * confirm it was the top-level one and not nested metadata.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} filePath - Manifest path relative to the root, as the messages name it.
 * @param {string} text - Manifest content.
 * @param {string} version - Version to write.
 * @returns {string} Manifest content with the new top-level `version`.
 * @throws {ReleaseStepError} When the first `"version"` of the file is not the top-level one.
 */
export function rewriteManifestVersion(context, filePath, text, version) {
  const content = text.replace(PACKAGE_VERSION_FIELD_PATTERN, `$1${version}$2`);

  if (JSON.parse(content).version !== version) {
    throw new ReleaseStepError(
      `${filePath} tiene un campo "version" anidado antes del "version" de primer nivel: el release reescribiría ese otro campo.`,
      `Mové el "version" de primer nivel antes de cualquier objeto con su propio "version" y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`
    );
  }

  return content;
}

/**
 * Builds the pathspec that matches a release file literally, so a name such as `:version` or
 * `v*.txt` is never read as pathspec magic nor a glob.
 *
 * @param {string} filePath - Path relative to the root, `/`-separated.
 * @returns {string} Literal pathspec, to pass after `--`.
 */
function toLiteralPathspec(filePath) {
  return `${GIT_LITERAL_PATHSPEC_PREFIX}${filePath}`;
}

/**
 * Explains, in Spanish, which version block markers of a file are paired wrongly and how to fix them.
 *
 * @param {VersionBlockError} blockError - Pairing problem found in the file.
 * @param {string} filePath - Configured path.
 * @returns {{ message: string, fix: string }} What is wrong (file, line and marker) and what to change.
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
 * markers are paired wrongly or none of its lines carries a version.
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
    throw new ReleaseStepError(
      `${filePath} (versionFiles) no tiene ninguna versión marcada para actualizar.`,
      `Marcá la línea con un comentario beez-rp-version (o x-release-please-version), o el bloque con beez-rp-start-version … beez-rp-end, y volvé a correr ${context.commands.createVersion}; ${untouchedNote}.`
    );
  }

  return update.content;
}

/**
 * Computes the new content of `versionFiles` entries before anything is written, so
 * a missing, non-regular (symlink or directory), untracked, non-UTF-8 or unmarked file stops the release with the version untouched.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {readonly string[]} versionFiles - Entries that get `version`: every configured one, or in a
 *   monorepo the ones inside the package being released.
 * @param {string} version - Version being released.
 * @returns {Promise<ReleaseFileUpdate[]>} Files to write, with their bytes before the release.
 * @throws {ReleaseStepError} When a file is missing, is not a regular file, is not tracked by Git, is not valid UTF-8, has
 *   block markers paired wrongly or none of its lines is marked.
 */
export async function prepareVersionFileUpdates(context, versionFiles, version) {
  const untouchedNote = "no se tocó la versión";

  for (const filePath of versionFiles) {
    if (!existsSync(path.join(context.repositoryRoot, filePath))) {
      throw new ReleaseStepError(`${filePath} (versionFiles) no existe.`, `Corregí versionFiles en beez-rp.config.(m)js y volvé a correr ${context.commands.createVersion}; ${untouchedNote}.`);
    }
    // lstat does not follow links: writing through a symlink would change a file outside versionFiles.
    if (!lstatSync(path.join(context.repositoryRoot, filePath)).isFile()) {
      throw new ReleaseStepError(
        `${filePath} (versionFiles) no es un archivo regular (es un symlink o un directorio).`,
        `Apuntá versionFiles al archivo real en beez-rp.config.(m)js y volvé a correr ${context.commands.createVersion}; ${untouchedNote}.`
      );
    }
  }

  const trackedPaths = versionFiles.length === 0 ? [] : (await context.reader.git(["ls-files", "-z", "--", ...versionFiles.map(toLiteralPathspec)])).split("\0");
  const untrackedPath = versionFiles.find((filePath) => !trackedPaths.includes(filePath));

  if (untrackedPath !== undefined) {
    throw new ReleaseStepError(
      `${untrackedPath} (versionFiles) no está trackeado en Git (lo ignora .gitignore o nunca se commiteó): el commit de release no podría incluirlo.`,
      `Commitealo (si está ignorado, con git add -f) o sacalo de versionFiles en beez-rp.config.(m)js, y volvé a correr ${context.commands.createVersion}; ${untouchedNote}.`
    );
  }

  return versionFiles.map((filePath) => {
    const { originalBytes, text } = readReleaseFile(context, filePath, `${filePath} (versionFiles)`);
    return { filePath, originalBytes, content: rewriteMarkedVersions(context, filePath, text, version, untouchedNote) };
  });
}

/**
 * Undoes a release whose files were written but not committed (a failed write, `git add`,
 * `git write-tree` or `git commit`, or a commit undone because a hook changed it): the index entries
 * of the release files go back to the tree the index had before staging, and every release file to
 * its original bytes.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {ReleaseFileUpdate[]} fileUpdates - Files of the release commit.
 * @param {string | null} indexTree - Tree of the index before staging, or `null` when Git could not write it.
 * @param {ReleaseStepError} failure - What failed.
 * @param {readonly import("./changelog.js").PreservedReleaseFile[]} preservedFiles - Files staged without rewriting their content.
 * @returns {Promise<ReleaseStepError>} Failure to throw, whose hint says what was restored.
 */
async function rollBackRelease(context, fileUpdates, indexTree, failure, preservedFiles) {
  const releasePathspecs = [...fileUpdates, ...preservedFiles].map(({ filePath }) => toLiteralPathspec(filePath));
  const indexRestored = indexTree !== null && (await context.reader.tryGit(["reset", "--quiet", indexTree, "--", ...releasePathspecs])) !== null;
  const unrestoredPaths = fileUpdates
    .filter(({ filePath, originalBytes }) => {
      const absolutePath = path.join(context.repositoryRoot, filePath);
      try {
        if (originalBytes === null) {
          rmSync(absolutePath, { force: true });
          return false;
        }
        // Only files that changed: one that could not be written (read-only) already holds its bytes.
        if (!readFileSync(absolutePath).equals(originalBytes)) {
          writeFileSync(absolutePath, originalBytes);
        }
        return false;
      } catch {
        return true;
      }
    })
    .map(({ filePath }) => filePath);
  const restoreNote =
    indexRestored && unrestoredPaths.length === 0
      ? "se restauraron package.json y versionFiles (contenido y staging), y el staging del CHANGELOG; su contenido no se reescribió, así que no se tocó la versión"
      : `no se pudo restaurar todo: revisá git status y devolvé ${unrestoredPaths.length > 0 ? unrestoredPaths.join(", ") : "los archivos de versión y el staging del release"} a su estado anterior antes de reintentar; el contenido del CHANGELOG no se reescribió`;

  return new ReleaseStepError(failure.message, `${failure.hint} Después volvé a correr ${context.commands.createVersion}; ${restoreNote}.`, { cause: failure });
}

/**
 * Checks, before a resume pushes or publishes a release commit that already exists, that every
 * `versionFiles` entry in `HEAD` carries the pending version in its marked lines: a resume never
 * rewrites them.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {string} version - Version of the pending release.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When an entry is missing from `HEAD`, has no marked version, has block
 *   markers paired wrongly or has a marked version other than `version`.
 */
async function verifyReleasedVersionFiles(context, version) {
  const untouchedNote = "no se subió ni publicó nada";

  for (const filePath of context.config.versionFiles) {
    const content = await context.reader.tryGit(["show", `HEAD:${filePath}`]);

    if (content === null) {
      throw new ReleaseStepError(
        `${filePath} (versionFiles) no existe en el commit de release ${version} (HEAD).`,
        `Agregalo al commit de release con sus líneas marcadas en ${version}, o corregí versionFiles en beez-rp.config.(m)js, y volvé a correr ${context.commands.createVersion}; ${untouchedNote}.`
      );
    }

    if (rewriteMarkedVersions(context, filePath, content, version, untouchedNote) !== content) {
      throw new ReleaseStepError(
        `${filePath} (versionFiles) tiene en el commit de release (HEAD) una versión marcada distinta de ${version}.`,
        `Actualizá sus líneas marcadas a ${version} dentro del commit de release (git commit --amend, y recreá el tag ${toReleaseTag(version)} si ya existe en local) y volvé a correr ${context.commands.createVersion}; ${untouchedNote}.`
      );
    }
  }
}

/**
 * Stops the release when an earlier step (such as a check running a formatter with `--fix`) changed
 * a `package.json` or a `versionFiles` entry: the plan requires them clean, so any difference from
 * `HEAD` would be read as the original content and shipped in the release commit.
 *
 * @param {VersionFilesContext} context - Release context.
 * @param {readonly string[]} filePaths - Manifests and `versionFiles` entries the release rewrites.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When any of those files differs from `HEAD`.
 */
export async function assertReleaseFilesMatchHead(context, filePaths) {
  const releasePathspecs = filePaths.map(toLiteralPathspec);
  const changedPaths = (await context.reader.git(["diff", "--name-only", "-z", "HEAD", "--", ...releasePathspecs])).split("\0").filter(Boolean);

  if (changedPaths.length > 0) {
    throw new ReleaseStepError(
      `Un paso anterior (por ejemplo, un check) modificó ${changedPaths.join(", ")}: el commit de release incluiría esos cambios.`,
      `Revisá el check o commiteá esos cambios, y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`
    );
  }
}

/**
 * Writes version files, stages them and preserved files literally, and creates the release commit, checking that it
 * holds exactly the prepared tree. Any failure (or a hook that changes the commit) rolls the files and
 * their staging back and undoes the commit, so no tag is created.
 *
 * @param {StepContext} context - Release context.
 * @param {ReleaseFileUpdate[]} releaseFiles - Files of the release commit, with their bytes before the release.
 * @param {string} subject - Subject of the release commit.
 * @param {readonly import("./changelog.js").PreservedReleaseFile[]} [preservedFiles] - Manually maintained files to stage without rewriting or restoring their bytes.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When writing, staging or committing fails, or the commit differs from the prepared tree.
 */
export async function commitReleaseFiles(context, releaseFiles, subject, preservedFiles = []) {
  assertPreservedFilesUnchanged(context, preservedFiles);
  // The index before staging, so a rollback puts it back exactly (a CHANGELOG.md the user staged stays staged).
  const indexTree = await context.reader.tryGit(["write-tree"]);
  let preparedTree = "";

  try {
    for (const { filePath, content } of releaseFiles) {
      try {
        mkdirSync(path.dirname(path.join(context.repositoryRoot, filePath)), { recursive: true });
        writeFileSync(path.join(context.repositoryRoot, filePath), content);
      } catch (error) {
        throw new ReleaseStepError(`No se pudo escribir ${filePath} para el release (${error instanceof Error ? error.message : String(error)}).`, "Revisá que se pueda escribir (permisos, solo lectura).", {
          cause: error,
        });
      }
    }
    await runGitStep(context, ["add", "--", ...[...releaseFiles, ...preservedFiles].map(({ filePath }) => toLiteralPathspec(filePath))], "No se pudo stagear package.json, CHANGELOG.md y versionFiles", "Revisá git status.");
    // What the commit must hold: a hook that changes or stages anything else makes it differ.
    preparedTree = await context.reader.git(["write-tree"]);
    await runGitStep(context, ["commit", "--quiet", "-m", subject], "El commit de versión falló", "Corregí el error (por ejemplo, un hook pre-commit que lo rechaza).");
  } catch (error) {
    const failure =
      error instanceof ReleaseStepError
        ? error
        : new ReleaseStepError(`No se pudo preparar el commit de versión ${subject} (${error instanceof Error ? error.message : String(error)}).`, "Revisá git status.", { cause: error });
    throw await rollBackRelease(context, releaseFiles, indexTree, failure, preservedFiles);
  }

  /** @type {ReleaseStepError | null} */
  let failure = null;
  if ((await context.reader.git(["rev-parse", "HEAD^{tree}"])) !== preparedTree) {
    const unpreparedPaths = await context.reader.git(["diff", "--name-only", preparedTree, "HEAD"]);
    failure = new ReleaseStepError(
      `El commit de versión ${subject} incluía cambios que beez-rp no preparó: ${unpreparedPaths.split("\n").slice(0, MAX_LISTED_ITEMS).join(", ")} (por ejemplo, de un hook). Se deshizo el commit y no se creó el tag.`,
      "Revisá el hook y esos cambios."
    );
  } else {
    try {
      assertPreservedFilesUnchanged(context, preservedFiles);
    } catch (error) {
      if (!(error instanceof ReleaseStepError)) throw error;
      failure = error;
    }
  }
  if (failure) {
    if ((await context.reader.tryGit(["reset", "--soft", "--quiet", "HEAD^"])) === null) {
      throw new ReleaseStepError(failure.message, `No se pudo deshacer el commit: corré git reset --soft HEAD^, revisá git status y volvé a correr ${context.commands.createVersion}.`);
    }
    throw await rollBackRelease(context, releaseFiles, indexTree, failure, preservedFiles);
  }
}

/**
 * Chooses the next version (flags or prompt), preserves the manual CHANGELOG and creates
 * the release commit and annotated tag.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function bumpVersionStep(context) {
  assertPreservedFilesUnchanged(context, context.changelogFiles);
  await assertReleaseFilesMatchHead(context, [PACKAGE_MANIFEST_FILE, ...context.config.versionFiles]);
  // Re-read the manifest: syncing main may have brought a newer version.
  const manifest = readReleaseFile(context, PACKAGE_MANIFEST_FILE, PACKAGE_MANIFEST_FILE);
  const currentVersion = JSON.parse(manifest.text).version;
  const lastReleaseSha = context.state.lastRelease?.sha;
  const commits = await listCommits(context.reader, lastReleaseSha ? `${lastReleaseSha}..HEAD` : "HEAD");
  print(renderCommitList(commits, `Qué se publica (${commits.length} commit(s))`));

  let nextRelease = resolveRequestedVersion(currentVersion, context.options);
  const suggestion = suggestNextReleaseType(commits, currentVersion, { preMajorShift: context.config.preMajorShift });

  if (!nextRelease && context.options.acceptSuggested) {
    nextRelease = resolveRequestedVersion(currentVersion, { bump: suggestion.releaseType, setVersion: null });
    print(`${ICON.info} Versión sugerida aceptada: ${paint(["bold", "cyan"], nextRelease?.version ?? "")} (${suggestion.releaseType}: ${suggestion.reason})`);
  } else if (nextRelease) {
    print(`${ICON.info} Versión elegida por flag: ${paint(["bold", "cyan"], nextRelease.version)} (${nextRelease.releaseType})`);
  } else {
    const nextVersions = listNextVersions(currentVersion);
    const releaseTypeDescriptions = describeReleaseTypes(context.config, currentVersion);
    const chosenVersion = await select({
      message: `¿Qué versión publicamos? (actual ${currentVersion})`,
      options: nextVersions.map((candidate) => ({
        label: `${candidate.releaseType.padEnd(5)}  ${currentVersion} → ${candidate.version}`,
        hint: candidate.releaseType === suggestion.releaseType ? `${ICON.star} sugerida: ${suggestion.reason}` : undefined,
        description: releaseTypeDescriptions[candidate.releaseType],
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

  assertCiSetupFilesUnchanged(context.repositoryRoot, context.ciSetupFiles ?? []);

  /** @type {ReleaseFileUpdate[]} */
  const releaseFiles = [
    { filePath: PACKAGE_MANIFEST_FILE, originalBytes: manifest.originalBytes, content: rewriteManifestVersion(context, PACKAGE_MANIFEST_FILE, manifest.text, nextRelease.version) },
    ...(await prepareVersionFileUpdates(context, context.config.versionFiles, nextRelease.version)),
    ...(context.config.publish === JSR_REGISTRY_PROVIDER ? await prepareJsrVersionUpdates(context, context.repositoryRoot, context.config.publication, nextRelease.version) : []),
    ...(context.ciSetupFiles ?? []),
    ...(context.config.ci?.deployment === CI_VERCEL_DEPLOYMENT ? [prepareCiReleaseMetadata(context.repositoryRoot, nextRelease.version, context.execution ?? RELEASE_EXECUTION.local)] : []),
  ];
  await commitReleaseFiles(context, releaseFiles, nextRelease.version, context.changelogFiles);

  const tag = toReleaseTag(nextRelease.version);
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
 * Checks that no tracked file differs from `HEAD` before publishing. `prepare` may create untracked
 * or ignored output (`dist/`, `releases/`), but a modified tracked file (such as `package.json`)
 * means the publication would no longer be the release commit.
 *
 * @param {{ reader: GitReader, commands: import("../package-manager.js").ProjectCommands }} context - Git reader of
 *   the checkout being published and the project commands quoted by the hint.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When Git cannot report the working tree state or a tracked file changed.
 */
export async function assertNoTrackedChanges(context) {
  const output = await context.reader.tryGit(["status", "--porcelain", "--untracked-files=no"]);

  if (output === null) {
    throw new ReleaseStepError("No se pudo leer el estado del working tree antes de publicar.", `No se publicó nada. Revisá git status y volvé a correr ${context.commands.createVersion}.`);
  }

  const trackedChanges = output.split("\n").filter((line) => line.trim() !== "");

  if (trackedChanges.length > 0) {
    throw new ReleaseStepError(
      `El paso de preparación modificó archivos versionados: ${trackedChanges.slice(0, MAX_LISTED_ITEMS).join("; ")}.`,
      `No se publicó nada. prepare puede generar archivos ignorados (dist/, releases/) pero no cambiar archivos versionados como package.json: revertí esos cambios y volvé a correr ${context.commands.createVersion}.`
    );
  }
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

  await assertNoTrackedChanges(context);

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
 * Publishes the release with npm or the project hook.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function publishReleaseStep(context) {
  const version = requireReleaseVersion(context);
  const { publish } = context.config;

  if (isRegistryProvider(publish)) {
    // Syncing main may have renamed the package after the diagnosis: publish under the current name.
    const manifest = readWorkingManifest(context.repositoryRoot);
    const packageName = String(manifest.name);
    context.packageName = packageName;
    const selection = selectProjectRegistry(context.config);
    let registry;
    try {
      registry = await resolveRegistry(selection, manifest, context.repositoryRoot);
    } catch (error) {
      throw new ReleaseStepError(`No se puede resolver el destino de publicación: ${error instanceof Error ? error.message : "configuración inválida"}.`, `Corregí publication.registryUrl, el proveedor o el manifest y volvé a correr ${context.commands.createVersion}; no se publicó nada.`, { cause: error });
    }
    const registryUrl = registry.registryUrl;
    context.registryUrl = registryUrl;
    context.registryLabel = registry.label;
    const artifactPath = registry.provider === JSR_REGISTRY_PROVIDER ? (await assertNoTrackedChanges(context), null) : await resolvePublishedArtifact(context, version, manifest);
    if (artifactPath) {
      print(paint("gray", `Publicando ${artifactPath}; npm puede pedir la confirmación 2FA en el navegador o un código.`));
    }
    const result = await publishRegistryRelease(selection, manifest, context.repositoryRoot, context.repositoryRoot, version, artifactPath);

    if (result.missingToken) {
      throw new ReleaseStepError(
        `Falta ${registry.options.tokenEnv} para publicar ${version} en ${registry.label}.`,
        `Definilo en el entorno, .env del repo o ~/.config/beez-rp/.env y corré ${context.commands.createVersion}: retoma solo la publicación.`
      );
    }

    if (!result.confirmed) {
      // npm inherited the terminal (2FA), so its output cannot be parsed: the credentials are checked again.
      const npmAuth = await checkRegistryAccess(selection, manifest, context.repositoryRoot);
      const failure = registry.provider === RELEASE_REGISTRY.npm ? describeNpmPublishFailure(npmAuth, { exitCode: result.exitCode, version }, context.commands) : {
        message: result.exitCode === 0
          ? `El cliente de ${registry.label} terminó con código 0, pero no se confirmó ${registry.packageName}@${version} en la metadata.`
          : `La publicación en ${registry.label} terminó con código ${result.exitCode} y no se confirmó ${registry.packageName}@${version}.`,
        hint: `Consultá ${registry.registryUrl} antes de reintentar; ${context.commands.createVersion} retoma la publicación. ${npmAuth.reason ?? "Revisá las credenciales y el permiso de escritura."}`,
      };
      throw new ReleaseStepError(failure.message, failure.hint);
    }

    // npm view ignores publishConfig, so the registry the release went to is queried explicitly.
    const npm = await lookupRegistryVersions(selection, manifest, context.repositoryRoot);
    if (!npm.publishedVersions.includes(version)) {
      print(`${ICON.warning} ${paint("yellow", `${registry.label} todavía no muestra ${version}; puede tardar unos segundos en propagarse.`)}`);
    }
    context.packageName = registry.packageName;
  } else if (typeof publish === "function") {
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
  [RELEASE_STEP.verifyChangelog]: verifyChangelogStep,
  [RELEASE_STEP.runChecks]: runChecksStep,
  [RELEASE_STEP.bumpVersion]: bumpVersionStep,
  [RELEASE_STEP.prepareRelease]: prepareReleaseStep,
  [RELEASE_STEP.pushRelease]: pushReleaseStep,
  [RELEASE_STEP.pushReleaseTag]: pushReleaseTagStep,
  [RELEASE_STEP.publishRelease]: publishReleaseStep,
  [DISPATCH_CI_RELEASE_STEP]: dispatchCiReleaseStep,
};

/**
 * Dispatches the pushed tag without performing any project checks or publication locally.
 * @param {ReleaseContext} context - Prepared release and GitHub adapter.
 * @returns {Promise<void>} Resolves when GitHub accepted the workflow.
 * @throws {ReleaseStepError} When dispatch remains unconfirmed.
 */
async function dispatchCiReleaseStep(context) {
  const tag = toReleaseTag(requireReleaseVersion(context));
  const workflow = context.config.ci?.workflow;
  if (!workflow || !context.workflowClient) throw new ReleaseStepError("No hay un workflow disponible para enviar el release.", `Reintentá con ${context.commands.createVersion} --retry-ci ${tag}.`);
  const release = await readCiReleaseIdentity(context.reader, tag);
  const result = await context.workflowClient.dispatch(workflow, release, `${context.commands.createVersion} --retry-ci ${tag}`);
  print(`${ICON.success} ${tag} ${result.status === CI_DISPATCH_STATUS.existing ? "ya tiene una ejecución activa o exitosa" : "enviado a CI"}. Los checks y la publicación se ejecutan en GitHub.`);
  if (result.url) print(`${ICON.info} ${result.url}`);
}

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
  if (context.execution === RELEASE_EXECUTION.ci) return renderBox({ title: `${tag} enviado a CI`, lines: [...lines, "El release todavía no está confirmado: revisá el resultado del workflow en Actions."], tone: BOX_TONE.info });

  if (context.commitCount !== null) {
    lines.push(`${ICON.success} ${paint("bold", "Commits")}   ${context.commitCount}`);
  }

  if (context.pushed) {
    lines.push(`${ICON.success} ${paint("bold", "Git")}       ${MAIN_BRANCH} + ${tag} en ${RELEASE_REMOTE}`);
  }

  if (context.published && context.registryUrl) {
    lines.push(`${ICON.success} ${paint("bold", context.registryLabel ?? "Registro")}       ${describePublishedRelease({ registryUrl: context.registryUrl, packageName: context.packageName, version })}`);
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
  const target = isRegistryProvider(context.config.publish) ? `publicar en ${context.registryLabel ?? context.state.npm?.registryLabel ?? REGISTRY_LABELS[context.config.publish]}` : "publicar el release";

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
  /** @type {import("./plan.js").ReleaseOptions} */
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

  if (config.packages) {
    if ((config.ci && options.execution !== RELEASE_EXECUTION.local) || options.execution === RELEASE_EXECUTION.ci || options.setupCi || options.ciRelease || options.retryCi) {
      print(`${ICON.failure} CI por tag vX.Y.Z requiere un proyecto con una única versión; para monorepos usá --local sin ci configurado.`);
      return FAILURE_EXIT_CODE;
    }
    // Imported lazily: the monorepo mode imports this module for the steps it shares.
    const { runMonorepoCreateVersion } = await import("../monorepo/run.js");
    return runMonorepoCreateVersion({ repositoryRoot, config, options, startedAt });
  }

  const ciWasConfigured = config.ci !== null;
  let selection;
  try {
    selection = await chooseReleaseExecution(config, options);
  } catch (error) {
    print(`${ICON.failure} ${error instanceof Error ? error.message : String(error)}${error instanceof ReleaseStepError ? ` ${error.hint}` : ""}`);
    return FAILURE_EXIT_CODE;
  }
  if (!selection) return 0;
  if (selection.setup && !config.ci) config = { ...config, ci: defaultCiReleaseConfig(repositoryRoot, config) };
  if (selection.setup && ciWasConfigured && config.ci && existsSync(path.join(repositoryRoot, CI_WORKFLOW_DIRECTORY, config.ci.workflow))) {
    // An existing workflow turns setup into an ordinary CI release only while it still matches the current configuration.
    try {
      await assertGeneratedCiWorkflowCurrent(repositoryRoot, config);
    } catch (error) {
      print(`${ICON.failure} ${error instanceof Error ? error.message : String(error)}${error instanceof ReleaseStepError ? ` ${error.hint}` : ""}`);
      return FAILURE_EXIT_CODE;
    }
    selection = { ...selection, setup: false };
  }
  const isCiPreparation = selection.execution === RELEASE_EXECUTION.ci;
  // Rejected before diagnosing or bumping: a pushed tag could never be published by a non-interactive worker.
  if (isCiPreparation) {
    try {
      assertCiCompatiblePublication(config);
    } catch (error) {
      print(`${ICON.failure} ${error instanceof Error ? error.message : String(error)}${error instanceof ReleaseStepError ? ` ${error.hint}` : ""}`);
      return FAILURE_EXIT_CODE;
    }
  }
  const workflowClient = isCiPreparation ? createGithubWorkflowClient(repositoryRoot) : undefined;

  const reader = createGitReader(repositoryRoot);
  const remoteUrl = (await reader.tryGit(["remote", "get-url", RELEASE_REMOTE])) ?? "";
  const { migrations } = config;
  let capabilities = describeReleaseCapabilities(config);
  if (isCiPreparation) capabilities = { ...capabilities, checks: false, prepare: false, publish: false };
  const planOptions = { skipUnpublished: options.skipUnpublished, ignoreLocalChanges: options.ignoreLocalChanges };
  const spinner = startSpinner("Diagnosticando el repositorio");
  let state;

  try {
    state = await collectReleaseState({
      repositoryRoot,
      // CI preparation still reads the registry: the plan must block (or require --skip-unpublished)
      // when the last release is missing, before an immutable tag is pushed for the worker.
      trackNpm: config.registry !== null,
      registrySelection: selectProjectRegistry(config),
      checkMigrations: !isCiPreparation && migrations ? () => migrations.check(createHookContext(repositoryRoot, reader, null)) : null,
      // The credentials are checked when the plan would publish to npm, and also when the npm lookup
      // failed: an authenticated `npm view` rejected with E401/E403 means the token, not the connection, is wrong.
      checkNpmAuth: (snapshot) =>
        !isCiPreparation && isRegistryProvider(config.publish) &&
        // Planned as if local changes were ignored: the run may still offer to ignore them, and
        // that plan must not publish with unchecked credentials.
        (Boolean(options.ciRelease && !snapshot.npm?.publishedVersions.includes(snapshot.headVersion ?? "")) || hasFailedNpmLookup(snapshot) ||
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
  capabilities = describeReleaseCapabilities(config, state.npm?.registryLabel);
  if (isCiPreparation) capabilities = { ...capabilities, checks: false, prepare: false, publish: false };
  const publishedLabel = state.npm
    ? latestPublished ? `v${latestPublished} en ${state.npm.registryLabel ?? "npm"}` : null
    : state.releasedVersion ? `v${state.releasedVersion} ${config.publishedLabel}` : null;
  print(renderBanner({ projectName: config.projectName ?? state.packageName, publishedLabel }));
  print(renderDiagnosis(state, repositoryRoot));

  let plan = buildReleasePlan(state, capabilities, planOptions);
  if (options.ciRelease) {
    try {
      const release = await readCiReleaseIdentity(reader, options.ciRelease, true);
      state.lastRelease = await findLastRelease(reader, "HEAD^");
      plan = buildCiWorkerPlan(state, capabilities, release.version);
      plan.steps.unshift({ id: RELEASE_STEP.verifyChangelog, title: "Verificar el CHANGELOG del release recibido" });
    } catch (error) {
      print(`${ICON.failure} ${error instanceof Error ? error.message : String(error)}${error instanceof ReleaseStepError ? ` ${error.hint}` : ""}`);
      return FAILURE_EXIT_CODE;
    }
  }

  if (options.retryCi) {
    try {
      if (!config.ci || !workflowClient) throw new ReleaseStepError("No hay un workflow configurado para reenviar el release.", "Configurá ci.workflow y volvé a ejecutar --retry-ci con el mismo tag.");
      assertCiWorkflowFile(repositoryRoot, config.ci.workflow);
      const release = await readCiReleaseIdentity(reader, options.retryCi);
      if (options.dryRun) { print(`--dry-run: se reenviaría ${release.tag} a ${config.ci.workflow}; no se cambió nada.`); return 0; }
      const environment = describeCiEnvironment(config);
      await workflowClient.preflight(config.ci.workflow, environment.secrets, environment.variables);
      const submitted = await workflowClient.dispatch(config.ci.workflow, release, `${config.commands.createVersion} --retry-ci ${release.tag}`);
      print(`${release.tag} ${submitted.status === CI_DISPATCH_STATUS.existing ? "ya tiene una ejecución activa o exitosa" : "enviado a CI"}: ${submitted.url ?? "revisá Actions"}. No se creó otra versión.`);
      return 0;
    } catch (error) {
      print(`${ICON.failure} ${error instanceof Error ? error.message : String(error)}${error instanceof ReleaseStepError ? ` ${error.hint}` : ""}`);
      return FAILURE_EXIT_CODE;
    }
  }

  // Uncommitted changes are the only blocker when ignoring them unblocks the plan: an interactive
  // run asks instead of stopping (a dry run, or one without terminal, keeps the blocker and its hint).
  if (!options.ciRelease && plan.blockers.length > 0 && !options.ignoreLocalChanges && !options.dryRun && process.stdin.isTTY) {
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
  if (isCiPreparation) plan = appendCiDispatch(plan);

  if (plan.mode === RELEASE_MODE.upToDate) {
    const since = state.lastRelease?.version ? toReleaseTag(state.lastRelease.version) : "el inicio";
    print(renderBox({ title: "Todo al día", lines: [`${ICON.success} No hay nada nuevo para publicar desde ${since}.`], tone: BOX_TONE.success }));
    return 0;
  }

  if (plan.mode === RELEASE_MODE.newRelease) {
    print(renderCommitList(state.unreleasedCommits, "Commits sin publicar"));
  }

  print(renderPlan(plan));

  // A missing manual changelog update must fail CI; other diagnostic blockers retain their exit behavior.
  if (plan.blockers.length > 0) {
    return isCiPreparation || options.ciRelease || plan.blockers.some((blocker) => blocker.code === CHANGELOG_UPDATE_REQUIRED_CODE) ? FAILURE_EXIT_CODE : 0;
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
      // The worker always runs the release committed for CI; local runs must resume in the committed mode.
      if (!options.ciRelease) await assertResumeExecutionMatches(reader, plan.pendingVersion, selection.execution);
      await verifyReleasedVersionFiles({ repositoryRoot, config, reader, commands: config.commands }, plan.pendingVersion);
      if (config.publish === JSR_REGISTRY_PROVIDER && readJsrManifest(repositoryRoot, config.publication.configFile).manifest.version !== plan.pendingVersion) {
        throw new ReleaseStepError("El manifest JSR no coincide con la versión del release pendiente.", "Corregilo dentro del commit de release antes de subir o publicar; no se reescribió ningún archivo.");
      }
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
  if (plan.steps.some((planStep) => planStep.id === RELEASE_STEP.bumpVersion) && !options.bump && !options.setVersion && !options.acceptSuggested && !process.stdin.isTTY) {
    print(`${ICON.failure} ${paint("red", `Sin terminal interactiva no se puede elegir la versión: usá --${CREATE_VERSION_FLAG.bump} patch|minor|major, --${CREATE_VERSION_FLAG.setVersion} X.Y.Z o --${CREATE_VERSION_FLAG.acceptSuggested}.`)}`);
    return FAILURE_EXIT_CODE;
  }

  /** @type {ReleaseFileUpdate[]} */
  let ciSetupFiles = [];
  if (isCiPreparation && config.ci && workflowClient) {
    try {
      if (selection.setup && plan.mode !== RELEASE_MODE.newRelease) throw new ReleaseStepError("La configuración automática de CI requiere un release nuevo.", "Completá el release pendiente con --local y después ejecutá --setup-ci.");
      if (selection.setup) ciSetupFiles = await prepareCiSetupFiles(repositoryRoot, config, !ciWasConfigured);
      else assertCiWorkflowFile(repositoryRoot, config.ci.workflow);
      const environment = describeCiEnvironment(config);
      await workflowClient.preflight(config.ci.workflow, environment.secrets, environment.variables);
      if (config.migrations && environment.secrets.length === 0) print(`${ICON.warning} El worker necesita las variables de las migraciones: declaralas en ci.secrets o ci.variables y configurá Actions antes de publicar.`);
      print(`${ICON.info} CI ejecutará los checks y hooks; la preparación local omite los hooks de Git.`);
    } catch (error) {
      print(`${ICON.failure} ${error instanceof Error ? error.message : String(error)}${error instanceof ReleaseStepError ? ` ${error.hint}` : ""}`);
      return FAILURE_EXIT_CODE;
    }
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
    registryLabel: state.npm?.registryLabel ?? null,
    commands: config.commands,
    changelogFiles: [],
    execution: selection.execution,
    ciWorker: Boolean(options.ciRelease),
    ciSetupFiles,
    workflowClient,
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
      lines.push("", context.execution === RELEASE_EXECUTION.ci && context.version && context.pushed
        ? `${ICON.warning} ${toReleaseTag(context.version)} ya está en origin. Revisá Actions y reenviá el mismo release con ${context.commands.createVersion} --retry-ci ${toReleaseTag(context.version)}; no hagas otro bump.`
        : context.ciWorker && context.version ? `${ICON.warning} ${toReleaseTag(context.version)} ya está en origin. Corregí el paso y reintentá el workflow de este mismo tag; no se hizo otro bump ni push.`
        : releaseOnOrigin ? `${ICON.warning} ${paint("bold", releaseOnOrigin)}` : paint("gray", `${context.commands.createVersion} retoma desde el primer paso que falte.`));
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
