#!/usr/bin/env node
/**
 * `pnpm create-version` (alias `pnpm cv`): diagnoses the repository, shows
 * what is still missing and publishes beez-rp from `main` in one command.
 *
 * A new release syncs `main`, fills the CHANGELOG `[Unreleased]` block with
 * Codex when it is empty, runs `pnpm check`, asks for the version (or takes
 * `--bump` / `--set-version`, always the next patch, minor or major), creates
 * the `X.Y.Z` commit and the annotated `vX.Y.Z` tag, pushes both atomically
 * and publishes to npm with the `NPM_TOKEN` referenced by `.npmrc`. A release
 * commit that never reached npm is resumed: running the command again only
 * pushes and publishes what is missing.
 *
 * @module scripts/release
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { releaseUnreleased, readUnreleased } from "../src/changelog.js";
import { buildChangelogPrompt, runCodex } from "../src/changelog-ai.js";
import { CHANGE_TYPES, CHANGELOG_FILE, UNRELEASED_HEADING } from "../src/constants/changelog.js";
import { CODEX_NOT_FOUND_EXIT_CODE } from "../src/constants/changelog-ai.js";
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
} from "../src/terminal-ui.js";
import { listNextVersions, resolveRequestedVersion, suggestReleaseType, toReleaseTag } from "../src/versions.js";
import {
  CHANGELOG_AUDIENCE,
  CHECK_COMMAND,
  FAILURE_EXIT_CODE,
  LOCAL_ENVIRONMENT_FILE,
  MAIN_BRANCH,
  MAX_LISTED_COMMITS,
  NPM_DIST_TAG,
  NPM_LOOKUP_STATUS,
  NPM_TOKEN_VARIABLE,
  PACKAGE_VERSION_FIELD_PATTERN,
  RELEASE_MODE,
  RELEASE_REMOTE,
  RELEASE_STEP,
  REMOTE_MAIN_REF,
} from "./constants/release.js";
import { RELEASE_USAGE, buildReleasePlan, parseReleaseArguments } from "./release/release-plan.js";
import { collectReleaseState, createGitReader, lookupPublishedVersions, runInherited } from "./release/release-state.js";

/** Repository root, resolved from this file so the command works from any folder. */
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Windows resolves `pnpm.cmd` and `npm.cmd` only through a shell. */
const USES_SHELL = process.platform === "win32";

/** What each release type means for consumers of the package, shown under each version option. */
const RELEASE_TYPE_DESCRIPTION = {
  patch: "Solo arreglos o cambios internos; la API pública no cambia.",
  minor: "Funcionalidades nuevas compatibles; lo existente sigue funcionando igual.",
  major: "Cambio incompatible en la API pública o en el comportamiento del CLI.",
};

/** Error raised by a step with a Spanish explanation and a next action. */
class ReleaseStepError extends Error {
  /**
   * @param {string} message - What failed, in Spanish.
   * @param {string} hint - What to do next, in Spanish.
   */
  constructor(message, hint) {
    super(message);
    this.name = "ReleaseStepError";
    this.hint = hint;
  }
}

/**
 * @typedef {Awaited<ReturnType<typeof collectReleaseState>>} ReleaseSnapshot
 * @typedef {{
 *   state: ReleaseSnapshot,
 *   options: ReturnType<typeof parseReleaseArguments>,
 *   version: string | null,
 *   published: boolean,
 * }} ReleaseContext
 */

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
 * Renders the status panel of the diagnosis.
 *
 * @param {ReleaseSnapshot} state - Snapshot.
 * @returns {string} Box.
 */
function renderDiagnosis(state) {
  const isOnMain = state.currentBranch === MAIN_BRANCH;
  const { aheadCommits, behindCount } = state.main;
  const syncParts = [
    ...(behindCount > 0 ? [paint("yellow", `${behindCount} atrás`)] : []),
    ...(aheadCommits.length > 0 ? [paint("yellow", `${aheadCommits.length} adelante`)] : []),
  ];
  const { npm } = state;
  const latestPublished = npm.publishedVersions.at(-1);
  const headPublished = state.headVersion !== null && npm.publishedVersions.includes(state.headVersion);
  const { changelog } = state;
  const changelogRow =
    changelog.unknownSections.length > 0
      ? renderRow(ICON.failure, "CHANGELOG", paint("red", `secciones no válidas: ${changelog.unknownSections.join(", ")}`))
      : changelog.entryCount === 0
        ? renderRow(ICON.warning, "CHANGELOG", paint("yellow", "[Unreleased] vacío: lo completa Codex al versionar"))
        : renderRow(ICON.success, "CHANGELOG", `${changelog.entryCount} entrada(s) en [Unreleased]`);

  const rows = [
    renderRow(isOnMain ? ICON.success : ICON.failure, "Rama", isOnMain ? MAIN_BRANCH : paint("red", state.currentBranch ?? "HEAD desacoplado")),
    renderRow(
      state.workingTreeChanges.length === 0 ? ICON.success : ICON.warning,
      "Working tree",
      state.workingTreeChanges.length === 0 ? "limpio" : paint("yellow", `${state.workingTreeChanges.length} cambio(s) sin commitear`)
    ),
    renderRow(syncParts.length > 0 ? ICON.warning : ICON.success, `${MAIN_BRANCH} ↔ origin`, syncParts.join(", ") || "al día"),
    renderRow(ICON.info, "Versión local", `${paint("cyan", state.headVersion ?? "—")}${headPublished ? "" : paint("yellow", " (sin publicar)")}`),
    renderRow(
      npm.status === NPM_LOOKUP_STATUS.ok ? ICON.success : ICON.failure,
      "npm",
      npm.status === NPM_LOOKUP_STATUS.ok ? `latest ${paint("cyan", latestPublished ?? "ninguna todavía")}` : paint("red", "no respondió")
    ),
    renderRow(
      state.unreleasedCommits.length > 0 ? ICON.warning : ICON.success,
      "Sin publicar",
      state.unreleasedCommits.length > 0 ? paint("yellow", `${state.unreleasedCommits.length} commit(s) en ${REMOTE_MAIN_REF}`) : "nada nuevo desde el último release"
    ),
    changelogRow,
  ];

  return renderBox({ title: "Diagnóstico", lines: rows, tone: BOX_TONE.info });
}

/**
 * Renders the plan or its blockers.
 *
 * @param {ReturnType<typeof buildReleasePlan>} plan - Plan.
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
  const title = plan.mode === RELEASE_MODE.resume ? "Plan · retomar el release pendiente" : "Plan";

  return renderBox({ title, lines, tone: BOX_TONE.accent });
}

/**
 * Runs Git with visible output and fails the step on error.
 *
 * @param {string[]} gitArguments - Git arguments.
 * @param {string} failureMessage - Spanish message when it fails.
 * @param {string} hint - Spanish next action.
 * @returns {Promise<void>}
 */
async function runGitStep(gitArguments, failureMessage, hint) {
  const exitCode = await runInherited("git", gitArguments, { cwd: REPOSITORY_ROOT });

  if (exitCode !== 0) {
    throw new ReleaseStepError(`${failureMessage} (git ${gitArguments[0]} salió con código ${exitCode}).`, hint);
  }
}

/**
 * Reads the `[Unreleased]` block of the working-tree CHANGELOG.md.
 *
 * @returns {ReturnType<typeof readUnreleased>} Unreleased state.
 */
function readWorkingUnreleased() {
  return readUnreleased(readFileSync(path.join(REPOSITORY_ROOT, CHANGELOG_FILE), "utf8"));
}

/**
 * Fast-forwards local `main` to `origin/main`.
 *
 * @returns {Promise<void>}
 */
async function syncMainStep() {
  await runGitStep(
    ["merge", "--ff-only", "--quiet", REMOTE_MAIN_REF],
    `No se pudo actualizar ${MAIN_BRANCH} en fast-forward`,
    `Revisá git status y git log ${REMOTE_MAIN_REF}..${MAIN_BRANCH}.`
  );
  print(`${ICON.success} ${MAIN_BRANCH} quedó igual a ${REMOTE_MAIN_REF}.`);
}

/**
 * Asks Codex to fill an empty `[Unreleased]` block from the unreleased commits.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function generateChangelogStep(context) {
  print(paint("gray", "Codex está escribiendo el CHANGELOG a partir de los commits sin publicar…"));
  const exitCode = await runCodex(REPOSITORY_ROOT, buildChangelogPrompt(context.state.unreleasedCommits, CHANGELOG_AUDIENCE));
  const unreleased = readWorkingUnreleased();

  if (exitCode !== 0 || unreleased.entryCount === 0 || unreleased.unknownSections.length > 0) {
    const reason =
      exitCode === CODEX_NOT_FOUND_EXIT_CODE
        ? "no se encontró la CLI de Codex"
        : exitCode !== 0
          ? `Codex terminó con código ${exitCode}`
          : "el bloque sigue vacío o con secciones no válidas";
    throw new ReleaseStepError(
      `No se pudo completar ${UNRELEASED_HEADING} del CHANGELOG: ${reason}.`,
      `Completalo usando ${CHANGE_TYPES.map((type) => `### ${type}`).join(", ")} y volvé a correr pnpm create-version.`
    );
  }

  print(renderBox({ title: `CHANGELOG · ${UNRELEASED_HEADING} (generado por Codex)`, lines: unreleased.body.split("\n"), tone: BOX_TONE.info }));
}

/**
 * Runs the package checks (typecheck and tests) before touching the version.
 *
 * @returns {Promise<void>}
 */
async function runChecksStep() {
  const [command, ...commandArguments] = CHECK_COMMAND.split(" ");
  const exitCode = USES_SHELL
    ? await runInherited(CHECK_COMMAND, [], { cwd: REPOSITORY_ROOT, shell: true })
    : await runInherited(command, commandArguments, { cwd: REPOSITORY_ROOT });

  if (exitCode !== 0) {
    throw new ReleaseStepError(`${CHECK_COMMAND} falló con código ${exitCode}.`, "Corregí el error de arriba; todavía no se tocó la versión.");
  }
}

/**
 * Chooses the next version, releases the CHANGELOG and creates the release commit and tag.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function bumpVersionStep(context) {
  const manifestPath = path.join(REPOSITORY_ROOT, "package.json");
  const manifest = readFileSync(manifestPath, "utf8");
  // Re-read the manifest: syncing main may have brought a newer version.
  const currentVersion = JSON.parse(manifest).version;
  const { unreleasedCommits } = context.state;
  print(renderCommitList(unreleasedCommits, `Qué se publica (${unreleasedCommits.length} commit(s))`));

  let nextRelease = resolveRequestedVersion(currentVersion, context.options);

  if (nextRelease) {
    print(`${ICON.info} Versión elegida por flag: ${paint(["bold", "cyan"], nextRelease.version)} (${nextRelease.releaseType})`);
  } else {
    const suggestion = suggestReleaseType(unreleasedCommits);
    const nextVersions = listNextVersions(currentVersion);
    const chosenVersion = await select({
      message: `¿Qué versión publicamos? (actual ${currentVersion})`,
      options: nextVersions.map((candidate) => ({
        label: `${candidate.releaseType.padEnd(5)}  ${currentVersion} → ${candidate.version}`,
        hint: candidate.releaseType === suggestion.releaseType ? `${ICON.star} sugerida: ${suggestion.reason}` : undefined,
        description: RELEASE_TYPE_DESCRIPTION[candidate.releaseType],
        value: candidate.version,
      })),
      defaultIndex: nextVersions.findIndex((candidate) => candidate.releaseType === suggestion.releaseType),
    });
    nextRelease = nextVersions.find((candidate) => candidate.version === chosenVersion) ?? null;
  }

  if (!nextRelease) {
    throw new ReleaseStepError("No se eligió ninguna versión.", "Volvé a correr pnpm create-version.");
  }

  const changelogPath = path.join(REPOSITORY_ROOT, CHANGELOG_FILE);
  let releasedChangelog;

  try {
    releasedChangelog = releaseUnreleased(readFileSync(changelogPath, "utf8"), nextRelease.version, new Date().toISOString().split("T")[0]);
  } catch (error) {
    throw new ReleaseStepError(
      `CHANGELOG.md no está listo: ${error instanceof Error ? error.message : String(error)}`,
      `Completá ${UNRELEASED_HEADING} y volvé a correr pnpm create-version.`
    );
  }

  writeFileSync(manifestPath, manifest.replace(PACKAGE_VERSION_FIELD_PATTERN, `$1${nextRelease.version}$2`));
  writeFileSync(changelogPath, releasedChangelog);

  const tag = toReleaseTag(nextRelease.version);
  await runGitStep(["add", "package.json", CHANGELOG_FILE], "No se pudo stagear package.json y CHANGELOG.md", "Revisá git status.");
  await runGitStep(
    ["commit", "--quiet", "-m", nextRelease.version],
    "El commit de versión falló",
    "Descartá el cambio con git checkout package.json CHANGELOG.md y volvé a correr pnpm create-version."
  );
  await runGitStep(["tag", "-a", tag, "-m", nextRelease.version], `No se pudo crear el tag ${tag}`, `Si ya existe, revisalo con git show ${tag}.`);

  context.version = nextRelease.version;
  print(`${ICON.success} Commit ${paint("bold", nextRelease.version)} y tag ${paint(["bold", "cyan"], tag)} creados en local.`);
}

/**
 * Returns the version being released: the one just bumped or the pending one.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {string} Version.
 */
function resolveReleaseVersion(context) {
  const version = context.version ?? context.state.headVersion;

  if (!version) {
    throw new ReleaseStepError("No se pudo leer la versión a publicar.", "Revisá package.json y volvé a correr pnpm create-version.");
  }

  return version;
}

/**
 * Pushes `main` and the release tag atomically, creating the tag when a resumed release lacks it.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function pushReleaseStep(context) {
  const version = resolveReleaseVersion(context);
  const tag = toReleaseTag(version);
  const reader = createGitReader(REPOSITORY_ROOT);

  if ((await reader.tryGit(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])) === null) {
    await runGitStep(["tag", "-a", tag, "-m", version], `No se pudo crear el tag ${tag}`, `Revisá git tag --list ${tag}.`);
  }

  await runGitStep(
    ["push", "--atomic", RELEASE_REMOTE, MAIN_BRANCH, `refs/tags/${tag}`],
    `El push de ${MAIN_BRANCH} + ${tag} falló`,
    `El release quedó en local: corregí el error y corré pnpm create-version, que retoma el push de ${tag}.`
  );
}

/**
 * Publishes the package to npm with the token referenced by `.npmrc` and confirms it.
 *
 * @param {ReleaseContext} context - Release context.
 * @returns {Promise<void>}
 */
async function publishPackageStep(context) {
  const version = resolveReleaseVersion(context);
  const environmentFilePath = path.join(REPOSITORY_ROOT, LOCAL_ENVIRONMENT_FILE);

  if (!process.env[NPM_TOKEN_VARIABLE] && existsSync(environmentFilePath)) {
    process.loadEnvFile(environmentFilePath);
  }

  if (!process.env[NPM_TOKEN_VARIABLE]) {
    throw new ReleaseStepError(
      `Falta ${NPM_TOKEN_VARIABLE} para publicar ${version}.`,
      `Definilo en el entorno o en ${LOCAL_ENVIRONMENT_FILE} (ignorado por Git) y corré pnpm create-version: retoma solo la publicación.`
    );
  }

  // The command line is constant; the token only travels through the environment and `.npmrc`.
  const publishArguments = ["publish", "--access", "public", "--tag", NPM_DIST_TAG];
  const exitCode = USES_SHELL
    ? await runInherited(`npm ${publishArguments.join(" ")}`, [], { cwd: REPOSITORY_ROOT, shell: true })
    : await runInherited("npm", publishArguments, { cwd: REPOSITORY_ROOT });

  if (exitCode !== 0) {
    throw new ReleaseStepError(
      `npm publish terminó con código ${exitCode}.`,
      `Comprobá en npm si ${version} llegó; si no, corré pnpm create-version para reintentar solo la publicación.`
    );
  }

  const npm = await lookupPublishedVersions(context.state.packageName, REPOSITORY_ROOT);

  if (!npm.publishedVersions.includes(version)) {
    print(`${ICON.warning} ${paint("yellow", `npm todavía no muestra ${version}; puede tardar unos segundos en propagarse.`)}`);
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
  [RELEASE_STEP.generateChangelog]: generateChangelogStep,
  [RELEASE_STEP.runChecks]: runChecksStep,
  [RELEASE_STEP.bumpVersion]: bumpVersionStep,
  [RELEASE_STEP.pushRelease]: pushReleaseStep,
  [RELEASE_STEP.publishPackage]: publishPackageStep,
};

/**
 * Runs the release command.
 *
 * @returns {Promise<number>} Process exit code.
 */
async function main() {
  const startedAt = Date.now();
  let options;

  try {
    options = parseReleaseArguments(process.argv.slice(2));
  } catch (error) {
    print(`${ICON.failure} ${paint("red", error instanceof Error ? error.message : String(error))}`);
    print(RELEASE_USAGE);
    return FAILURE_EXIT_CODE;
  }

  if (options.help) {
    print(RELEASE_USAGE);
    return 0;
  }

  const spinner = startSpinner("Diagnosticando el repositorio");
  let state;

  try {
    state = await collectReleaseState({ repositoryRoot: REPOSITORY_ROOT, onProgress: (label) => spinner.update(label) });
    spinner.succeed("Diagnóstico completo");
  } catch (error) {
    spinner.fail("No se pudo diagnosticar el repositorio");
    print(paint("red", error instanceof Error ? error.message : String(error)));
    return FAILURE_EXIT_CODE;
  }

  const latestPublished = state.npm.publishedVersions.at(-1);
  print(renderBanner({ projectName: state.packageName, publishedLabel: latestPublished ? `v${latestPublished} en npm` : null }));
  print(renderDiagnosis(state));

  const plan = buildReleasePlan(state);

  if (plan.mode === RELEASE_MODE.upToDate) {
    print(renderBox({ title: "Todo al día", lines: [`${ICON.success} No hay nada nuevo para publicar.`], tone: BOX_TONE.success }));
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
  const context = { state, options, version: plan.pendingVersion, published: false };

  for (const [index, planStep] of plan.steps.entries()) {
    print(renderStepHeader(index + 1, plan.steps.length, planStep.title));

    try {
      await STEP_EXECUTORS[planStep.id](context);
    } catch (error) {
      const lines = [`${ICON.failure} ${error instanceof Error ? error.message : String(error)}`];
      if (error instanceof ReleaseStepError) {
        lines.push("", `${paint("bold", "Qué hacer:")} ${error.hint}`);
      }
      lines.push("", paint("gray", "pnpm create-version retoma desde el primer paso que falte."));
      print(renderBox({ title: `Falló el paso ${index + 1}: ${planStep.title}`, lines, tone: BOX_TONE.danger }));
      return FAILURE_EXIT_CODE;
    }
  }

  const duration = formatDuration(measureActiveMs(startedAt));
  print("");
  print(
    context.published && context.version
      ? renderBox({
          title: `${ICON.rocket} ${state.packageName}@${context.version} publicado`,
          lines: [
            `${ICON.success} ${paint("bold", "npm")}          https://www.npmjs.com/package/${state.packageName}/v/${context.version}`,
            `${ICON.success} ${paint("bold", "Git")}          ${MAIN_BRANCH} + ${toReleaseTag(context.version)} en ${RELEASE_REMOTE}`,
            `${ICON.info} ${paint("bold", "Consumidores")} pnpm add -D ${state.packageName}@^${context.version}`,
            "",
            paint("gray", `Tiempo total: ${duration} (sin contar la espera de tus respuestas)`),
          ],
          tone: BOX_TONE.success,
        })
      : renderBox({ title: "Listo", lines: [`${ICON.success} Plan completado en ${duration}.`], tone: BOX_TONE.success })
  );

  return 0;
}

main().then((exitCode) => {
  process.exitCode = exitCode;
});
