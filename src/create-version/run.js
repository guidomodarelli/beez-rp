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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { readUnreleased, releaseUnreleased } from "../changelog.js";
import { buildChangelogPrompt, runCodex } from "../changelog-ai.js";
import { CHANGE_TYPES, CHANGELOG_FILE, UNRELEASED_HEADING } from "../constants/changelog.js";
import { CODEX_NOT_FOUND_EXIT_CODE } from "../constants/changelog-ai.js";
import {
  FAILURE_EXIT_CODE,
  GITHUB_REPOSITORY_PATTERN,
  MAIN_BRANCH,
  MAIN_SYNCED_RESTART_MESSAGE,
  MAX_LISTED_COMMITS,
  MAX_LISTED_ITEMS,
  MIGRATION_STATUS,
  NPM_AUTH_STATUS,
  NPM_LOOKUP_STATUS,
  NPM_PUBLISHER,
  NPM_TOKEN_LOCATIONS,
  NPM_TOKEN_VARIABLE,
  PACKAGE_MANIFEST_FILE,
  PACKAGE_VERSION_FIELD_PATTERN,
  PINNED_NODE_VERSION_FILE,
  RELEASE_MODE,
  RELEASE_REGISTRY,
  RELEASE_REMOTE,
  RELEASE_STEP,
  REMOTE_MAIN_REF,
  SHORT_SHA_LENGTH,
  SUMMARY_VERSION_PLACEHOLDER,
  VERSION_PREFIX_PATTERN,
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
import { RELEASE_USAGE, buildReleasePlan, parseReleaseArguments } from "./plan.js";
import { createGitReader, listCommits, runCommandLine, runInherited } from "./process.js";
import { collectReleaseState } from "./state.js";

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
    const latestPublished = state.npm.publishedVersions.at(-1);
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
 *
 * @param {import("./npm.js").NpmAuthCheck} npmAuth - Credential check.
 * @returns {string} Row.
 */
function renderNpmAuthRow(npmAuth) {
  const source = describeNpmTokenSource(npmAuth);

  switch (npmAuth.status) {
    case NPM_AUTH_STATUS.ok:
      return renderRow(ICON.success, "npm auth", `${npmAuth.user} (${source})${npmAuth.firstPublication ? paint("gray", " · primera publicación") : ""}`);
    case NPM_AUTH_STATUS.missingToken:
      return renderRow(ICON.failure, "npm auth", paint("red", `falta ${NPM_TOKEN_VARIABLE}`));
    case NPM_AUTH_STATUS.invalidToken:
      return renderRow(ICON.failure, "npm auth", paint("red", `token inválido o vencido (${source})`));
    case NPM_AUTH_STATUS.notOwner:
      return renderRow(ICON.failure, "npm auth", paint("red", `${npmAuth.user} no puede publicar ${npmAuth.packageName} (${source})`));
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
    throw new ReleaseStepError("No se pudo leer la versión a publicar.", "Revisá package.json y volvé a correr pnpm create-version.");
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
    checks: config.checks.length > 0,
    prepare: config.prepare !== null,
    publish: config.publish !== null,
    publishTitle: config.publish === NPM_PUBLISHER ? "Publicar en npm" : "Publicar el release",
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
      `Completalo (con la IA o a mano) usando ${CHANGE_TYPES.map((type) => `### ${type}`).join(", ")} y volvé a correr pnpm create-version.`
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
  await runConfiguredCommands(context, context.config.checks, "Corregí el error de arriba; todavía no se tocó la versión.");
}

/**
 * Chooses the next version (flags or prompt), releases the CHANGELOG
 * `[Unreleased]` block and creates the release commit and annotated tag.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function bumpVersionStep(context) {
  const manifestPath = path.join(context.repositoryRoot, PACKAGE_MANIFEST_FILE);
  const manifest = readFileSync(manifestPath, "utf8");
  // Re-read the manifest: syncing main may have brought a newer version.
  const currentVersion = JSON.parse(manifest).version;
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
      defaultIndex: nextVersions.findIndex((candidate) => candidate.releaseType === suggestion.releaseType),
    });
    nextRelease = nextVersions.find((candidate) => candidate.version === chosenVersion) ?? null;
  }

  if (!nextRelease) {
    throw new ReleaseStepError("No se eligió ninguna versión.", "Volvé a correr pnpm create-version.");
  }

  const changelogPath = path.join(context.repositoryRoot, CHANGELOG_FILE);
  let releasedChangelog;

  try {
    releasedChangelog = releaseUnreleased(readFileSync(changelogPath, "utf8"), nextRelease.version, new Date().toISOString().split("T")[0]);
  } catch (error) {
    throw new ReleaseStepError(
      `CHANGELOG.md no está listo: ${error instanceof Error ? error.message : String(error)}`,
      `Completá ${UNRELEASED_HEADING} con ${CHANGE_TYPES.map((type) => `### ${type}`).join(", ")} y volvé a correr pnpm create-version.`,
      { cause: error }
    );
  }

  print(renderBox({ title: `CHANGELOG · ${UNRELEASED_HEADING} → [${nextRelease.version}]`, lines: readWorkingUnreleased(context.repositoryRoot).body.split("\n"), tone: BOX_TONE.info }));
  writeFileSync(manifestPath, manifest.replace(PACKAGE_VERSION_FIELD_PATTERN, `$1${nextRelease.version}$2`));
  writeFileSync(changelogPath, releasedChangelog);

  const tag = toReleaseTag(nextRelease.version);
  await runGitStep(context, ["add", PACKAGE_MANIFEST_FILE, CHANGELOG_FILE], "No se pudo stagear package.json y CHANGELOG.md", "Revisá git status.");
  await runGitStep(
    context,
    ["commit", "--quiet", "-m", nextRelease.version],
    "El commit de versión falló",
    "Corregí el error, descartá el cambio con git checkout package.json CHANGELOG.md y volvé a correr pnpm create-version."
  );
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
    await runConfiguredCommands(context, prepare, "El release quedó en local: corregí el error y volvé a correr pnpm create-version, que retoma desde acá.");
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
    `El release quedó en local: corregí el error y corré pnpm create-version, que retoma el push de ${tag}.`
  );

  if (!(await context.reader.tryGit(["ls-remote", "--tags", RELEASE_REMOTE, tag]))) {
    throw new ReleaseStepError(`${MAIN_BRANCH} se subió pero ${tag} no aparece en ${RELEASE_REMOTE}.`, `Subilo con git push ${RELEASE_REMOTE} ${tag}.`);
  }

  context.version = version;
  context.pushed = true;
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
    throw new ReleaseStepError("No se pudo leer el estado del working tree antes de publicar.", "No se publicó nada. Revisá git status y volvé a correr pnpm create-version.");
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
      "No se publicó nada. prepare puede generar archivos ignorados (dist/, releases/) pero no cambiar archivos versionados como package.json: revertí esos cambios y volvé a correr pnpm create-version."
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
      "Revisá la salida del paso de preparación y volvé a correr pnpm create-version: retoma la preparación y la publicación."
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
      "No se publicó nada. Corré npm pack --dry-run --json --ignore-scripts en la raíz para ver el error y volvé a correr pnpm create-version."
    );
  }

  if (npmPack.pack.version !== version) {
    throw new ReleaseStepError(
      `npm pack --dry-run describe ${npmPack.pack.name}@${npmPack.pack.version} y se está publicando ${version}.`,
      "No se publicó nada. Revisá que HEAD sea el commit de release y volvé a correr pnpm create-version."
    );
  }

  const problems = verifyPreparedArtifact(context.repositoryRoot, prepared, npmPack.pack.integrity);

  if (problems.length > 0) {
    throw new ReleaseStepError(
      `El artefacto ${prepared.path} no se puede publicar: ${problems.join("; ")}.`,
      "No se publicó nada. Hacé que prepare empaquete con npm pack --ignore-scripts después de construir, borrá ese tarball y volvé a correr pnpm create-version."
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
 * @returns {Promise<string>} Registry URL, already checked to be a plain http(s) URL.
 * @throws {ReleaseStepError} When the registry is not a valid http(s) URL or npm cannot report it.
 */
async function resolveReleaseRegistry(manifest, repositoryRoot) {
  try {
    return await resolvePublishRegistry(manifest, repositoryRoot);
  } catch (error) {
    throw new ReleaseStepError(
      `No se puede publicar: ${error instanceof Error ? error.message : String(error)}.`,
      "No se publicó nada. Corregí el registry (publishConfig.registry o publishConfig[\"@scope:registry\"] en package.json, o registry/@scope:registry en .npmrc) con una URL http(s) sin credenciales y volvé a correr pnpm create-version."
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
    const registryUrl = await resolveReleaseRegistry(manifest, context.repositoryRoot);
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
        `Definilo en ${NPM_TOKEN_LOCATIONS} y corré pnpm create-version: retoma solo la publicación.`
      );
    }

    if (result.exitCode !== 0) {
      // npm inherited the terminal (2FA), so its output cannot be parsed: the credentials are checked again.
      const npmAuth = await checkNpmPublishAccess(packageName, context.repositoryRoot, registryUrl);
      const failure = describeNpmPublishFailure(npmAuth, { exitCode: result.exitCode, version });
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
  const isDetached = !context.state.currentBranch;
  const refs = isDetached ? "tag" : `${MAIN_BRANCH} + tag`;
  const target = context.config.publish === NPM_PUBLISHER ? "publicar en npm" : "publicar el release";
  const rerun = isDetached ? `Corré pnpm create-version desde ${tag} (HEAD desacoplado)` : "Corré pnpm create-version";
  return `${tag} ya está en ${host} (${refs}); falta ${target}. ${rerun} para reintentar solo la publicación.`;
}

/**
 * Runs `create-version` in a repository.
 *
 * @param {{ repositoryRoot: string, argv: string[] }} options - Repository root and arguments after the command name.
 * @returns {Promise<number>} Process exit code.
 */
export async function runCreateVersion({ repositoryRoot, argv }) {
  const startedAt = Date.now();
  let options;

  try {
    options = parseReleaseArguments(argv);
  } catch (error) {
    print(`${ICON.failure} ${paint("red", error instanceof Error ? error.message : String(error))}`);
    print(RELEASE_USAGE);
    return FAILURE_EXIT_CODE;
  }

  if (options.help) {
    print(RELEASE_USAGE);
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
  const planOptions = { skipUnpublished: options.skipUnpublished };
  const spinner = startSpinner("Diagnosticando el repositorio");
  let state;

  try {
    state = await collectReleaseState({
      repositoryRoot,
      trackNpm: config.registry === RELEASE_REGISTRY.npm,
      checkMigrations: migrations ? () => migrations.check(createHookContext(repositoryRoot, reader, null)) : null,
      // The credentials are only checked when the plan would publish to npm.
      checkNpmAuth: (snapshot) =>
        config.publish === NPM_PUBLISHER && buildReleasePlan(snapshot, capabilities, planOptions).steps.some((planStep) => planStep.id === RELEASE_STEP.publishRelease),
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

  const plan = buildReleasePlan(state, capabilities, planOptions);

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

  if (options.dryRun) {
    print(`${ICON.info} ${paint("cyan", "--dry-run: no se cambió nada. Corré pnpm create-version para ejecutar el plan.")}`);
    return 0;
  }

  /** @type {ReleaseContext} */
  const context = { repositoryRoot, config, state, options, reader, version: plan.pendingVersion, pushed: false, published: false, commitCount: null, packageName: state.packageName, registryUrl: null };

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
            lines: [`${ICON.info} ${MAIN_SYNCED_RESTART_MESSAGE}`, "", paint("gray", "No se tocó la versión ni los tags.")],
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
      lines.push("", releaseOnOrigin ? `${ICON.warning} ${paint("bold", releaseOnOrigin)}` : paint("gray", "pnpm create-version retoma desde el primer paso que falte."));
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
