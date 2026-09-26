/**
 * Pure release planning of `beez-rp create-version`.
 *
 * Receives the snapshot gathered by `state.js` and the project capabilities,
 * and decides without touching Git, npm or databases what is still missing
 * to ship a release from `main`:
 *
 * - a new release: sync `main`, apply migrations, fill the changelog, run the
 *   checks, bump (commit `X.Y.Z` + tag `vX.Y.Z`), prepare, push and publish;
 * - the resume of a release commit that never reached `origin` or the registry;
 * - nothing, when every commit is already released;
 * - blockers that explain what to fix first (feature branch, uncommitted
 *   files, foreign commits on `main`, unreachable registry, invalid changelog).
 *
 * @module create-version/plan
 */

import { parseArgs } from "node:util";

import { CHANGE_TYPES, CHANGELOG_FILE, UNRELEASED_HEADING } from "../constants/changelog.js";
import {
  CREATE_VERSION_FLAG,
  MAIN_BRANCH,
  MAX_LISTED_ITEMS,
  MIGRATION_STATUS,
  NPM_LOOKUP_STATUS,
  PORCELAIN_STATUS_WIDTH,
  PULL_REQUEST_STATE,
  RELEASE_MODE,
  RELEASE_STEP,
  VERSION_PREFIX_PATTERN,
} from "../constants/create-version.js";
import { RELEASE_TYPE } from "../constants/versions.js";
import { isReleaseCommitSubject, isStableReleaseVersion, toReleaseTag } from "../versions.js";

/**
 * @typedef {{ sha?: string, subject: string, body?: string }} ReleaseCommit
 * @typedef {{ name: string, headSha: string, hasUpstream: boolean, unpushedCount: number, aheadOfMainCount: number }} FeatureBranchSnapshot
 * @typedef {{ number: number, url: string, title?: string, state: string, isDraft: boolean, headRefOid: string }} PullRequestSnapshot
 * @typedef {import("./npm.js").NpmLookup} NpmLookup
 * @typedef {import("./config.js").MigrationCheck} MigrationCheck
 * @typedef {{
 *   currentBranch: string | null,
 *   workingTreeChanges: string[],
 *   branch?: FeatureBranchSnapshot | null,
 *   pullRequest?: PullRequestSnapshot | null,
 *   githubError?: string | null,
 *   main: { aheadCommits: ReleaseCommit[], behindCount: number },
 *   headVersion: string | null,
 *   headSubject: string | null,
 *   unreleasedCommits: ReleaseCommit[],
 *   npm: NpmLookup | null,
 *   migrations: MigrationCheck | null,
 *   changelog: { exists: boolean, entryCount: number, unknownSections: string[] },
 * }} ReleaseState
 * @typedef {{ checks: boolean, prepare: boolean, publish: boolean, publishTitle: string }} ReleaseCapabilities
 * @typedef {{ id: string, title: string, detail?: string }} ReleasePlanStep
 * @typedef {{ title: string, details: string[] }} ReleaseBlocker
 * @typedef {{ mode: string, steps: ReleasePlanStep[], blockers: ReleaseBlocker[], warnings: string[], pendingVersion: string | null }} ReleasePlan
 * @typedef {{ bump: "patch" | "minor" | "major" | null, setVersion: string | null, dryRun: boolean, help: boolean }} ReleaseOptions
 */

/** Capabilities of a project without checks, preparation or publication. */
export const DEFAULT_CAPABILITIES = Object.freeze({ checks: false, prepare: false, publish: false, publishTitle: "Publicar el release" });

/** Usage printed by `create-version --help`. */
export const RELEASE_USAGE = [
  "Uso: pnpm create-version [opciones]",
  "",
  "  --bump patch|minor|major   Elige el tipo de versión sin preguntar.",
  "  --set-version X.Y.Z        Fija la versión exacta (solo el siguiente patch, minor o major).",
  "  --dry-run                  Diagnostica y muestra el plan sin cambiar nada.",
  "  --help                     Muestra esta ayuda.",
].join("\n");

/**
 * Parses the command-line arguments of `create-version`.
 *
 * @param {string[]} argv - Arguments after the command name.
 * @returns {ReleaseOptions} Options.
 * @throws {Error} With a Spanish message when an argument is unknown or invalid.
 */
export function parseReleaseArguments(argv) {
  let values;

  try {
    ({ values } = parseArgs({
      args: argv.filter((argument) => argument !== CREATE_VERSION_FLAG.endOfOptions),
      options: {
        [CREATE_VERSION_FLAG.bump]: { type: "string" },
        [CREATE_VERSION_FLAG.setVersion]: { type: "string" },
        [CREATE_VERSION_FLAG.dryRun]: { type: "boolean", default: false },
        [CREATE_VERSION_FLAG.help]: { type: "boolean", short: CREATE_VERSION_FLAG.helpShort, default: false },
      },
    }));
  } catch (error) {
    throw new Error(`Opción inválida: ${error instanceof Error ? error.message : String(error)}. Usá --help para ver las opciones.`, { cause: error });
  }

  const releaseTypes = /** @type {string[]} */ (Object.values(RELEASE_TYPE));
  const bump = /** @type {string | undefined} */ (values[CREATE_VERSION_FLAG.bump]);
  const setVersion = /** @type {string | undefined} */ (values[CREATE_VERSION_FLAG.setVersion]);

  if (bump !== undefined && !releaseTypes.includes(bump)) {
    throw new Error(`--bump espera ${releaseTypes.join("|")} y recibió "${bump}".`);
  }

  if (bump !== undefined && setVersion !== undefined) {
    throw new Error("Usá --bump o --set-version, no los dos a la vez.");
  }

  return {
    bump: /** @type {ReleaseOptions["bump"]} */ (bump ?? null),
    // A typed `v1.2.0` means `1.2.0`; the version rules validate the rest.
    setVersion: setVersion === undefined ? null : setVersion.replace(VERSION_PREFIX_PATTERN, ""),
    dryRun: Boolean(values[CREATE_VERSION_FLAG.dryRun]),
    help: Boolean(values[CREATE_VERSION_FLAG.help]),
  };
}

/**
 * Describes what is still missing for a feature branch to reach `main`, so
 * the blocker tells the user the next concrete action.
 *
 * @param {FeatureBranchSnapshot} branch - Branch snapshot.
 * @param {PullRequestSnapshot | null} pullRequest - Pull request of the branch.
 * @param {string | null} githubError - Why the pull request could not be read.
 * @returns {string[]} Spanish lines, most urgent first.
 */
export function describeFeatureBranchGaps(branch, pullRequest, githubError) {
  if (pullRequest?.state === PULL_REQUEST_STATE.merged && branch.headSha === pullRequest.headRefOid) {
    return [`El PR #${pullRequest.number} ya está mergeado: hacé git switch ${MAIN_BRANCH}.`];
  }

  if (branch.aheadOfMainCount === 0) {
    return [`La rama no tiene commits nuevos respecto de ${MAIN_BRANCH}: hacé git switch ${MAIN_BRANCH}.`];
  }

  const gaps = [];

  if (!branch.hasUpstream) {
    gaps.push(`La rama nunca se subió: git push -u origin ${branch.name}.`);
  } else if (branch.unpushedCount > 0) {
    gaps.push(`${branch.unpushedCount} commit(s) sin subir: git push.`);
  }

  if (githubError) {
    gaps.push(`No se pudo consultar el PR (${githubError}).`);
  } else if (pullRequest?.state === PULL_REQUEST_STATE.merged) {
    gaps.push(`El PR #${pullRequest.number} ya se mergeó, pero la rama tiene commits posteriores: abrí un PR nuevo.`);
  } else if (pullRequest?.state === PULL_REQUEST_STATE.open) {
    const draftNote = pullRequest.isDraft ? " (está en borrador)" : "";
    gaps.push(`Falta mergear el PR #${pullRequest.number}${draftNote}: ${pullRequest.url}`);
  } else {
    gaps.push(`Falta abrir el PR contra ${MAIN_BRANCH}: gh pr create --fill.`);
  }

  gaps.push(`Después hacé git switch ${MAIN_BRANCH} y corré pnpm create-version.`);

  return gaps;
}

/**
 * Lists the blockers that must be fixed before any release step runs.
 *
 * @param {ReleaseState} state - Snapshot.
 * @returns {ReleaseBlocker[]} Blockers, most urgent first.
 */
function findBlockers(state) {
  if (!state.currentBranch) {
    return [{ title: "HEAD está desacoplado (detached)", details: [`Hacé git switch ${MAIN_BRANCH} y volvé a correr pnpm create-version.`] }];
  }

  /** @type {ReleaseBlocker[]} */
  const blockers = [];

  if (state.currentBranch !== MAIN_BRANCH) {
    blockers.push({
      title: `Estás en ${state.currentBranch}: los releases salen solo desde ${MAIN_BRANCH}`,
      details: state.branch
        ? describeFeatureBranchGaps(state.branch, state.pullRequest ?? null, state.githubError ?? null)
        : [`Hacé git switch ${MAIN_BRANCH} y volvé a correr pnpm create-version.`],
    });
  }

  // CHANGELOG.md may be uncommitted: it travels in the release commit.
  const blockingChanges = state.workingTreeChanges.filter((line) => line.slice(PORCELAIN_STATUS_WIDTH) !== CHANGELOG_FILE);

  if (blockingChanges.length > 0) {
    blockers.push({
      title: `Hay ${blockingChanges.length} archivo(s) sin commitear`,
      details: [...blockingChanges.slice(0, MAX_LISTED_ITEMS), "Commitealos en una rama (o git stash) y volvé a correr pnpm create-version."],
    });
  }

  if (state.npm && state.npm.status !== NPM_LOOKUP_STATUS.ok) {
    blockers.push({
      title: "No se pudo consultar npm",
      details: [`${state.npm.reason ?? "npm no respondió"}.`, "Revisá la conexión y volvé a correr pnpm create-version."],
    });
  }

  return blockers;
}

/**
 * Builds the blocker for local `main` commits that are not release commits.
 *
 * @param {ReleaseCommit[]} commits - Foreign commits.
 * @returns {ReleaseBlocker} Blocker.
 */
function foreignCommitsBlocker(commits) {
  return {
    title: `${MAIN_BRANCH} local tiene ${commits.length} commit(s) que no están en origin`,
    details: [
      ...commits.slice(0, MAX_LISTED_ITEMS).map((commit) => `· ${commit.subject}`),
      "Movelos a una rama (git switch -c <rama>) y llevalos por un PR.",
    ],
  };
}

/**
 * Plans the steps still missing for a release commit already created at `HEAD`.
 *
 * @param {ReleaseState} state - Snapshot.
 * @param {ReleaseCapabilities} capabilities - Project capabilities.
 * @returns {ReleasePlan | null} Resume plan, or `null` when `HEAD` is not a pending release.
 */
function planResume(state, capabilities) {
  const { headVersion, headSubject, main, npm } = state;

  if (!isStableReleaseVersion(headVersion) || headSubject?.trim() !== headVersion) {
    return null;
  }

  const version = /** @type {string} */ (headVersion);
  const pendingPush = main.aheadCommits.length > 0;
  const pendingPublish = npm !== null && !npm.publishedVersions.includes(version);

  if (!pendingPush && !pendingPublish) {
    return null;
  }

  const foreignCommits = main.aheadCommits.filter((commit) => !isReleaseCommitSubject(commit.subject));

  if (foreignCommits.length > 0) {
    return { mode: RELEASE_MODE.blocked, steps: [], blockers: [foreignCommitsBlocker(foreignCommits)], warnings: [], pendingVersion: null };
  }

  const needsPublish = capabilities.publish && (npm !== null ? pendingPublish : pendingPush);
  /** @type {ReleasePlanStep[]} */
  const steps = [];

  if (capabilities.prepare && (pendingPush || needsPublish)) {
    steps.push({ id: RELEASE_STEP.prepareRelease, title: `Preparar el release ${version}`, detail: "El commit de versión ya existe: se vuelve a preparar lo necesario." });
  }

  if (pendingPush) {
    steps.push({ id: RELEASE_STEP.pushRelease, title: `Subir ${MAIN_BRANCH} y ${toReleaseTag(version)} a origin`, detail: "El release quedó creado solo en local." });
  }

  if (needsPublish) {
    steps.push({ id: RELEASE_STEP.publishRelease, title: `${capabilities.publishTitle} (${version})`, detail: "Solo falta lo que no se completó." });
  }

  return steps.length > 0 ? { mode: RELEASE_MODE.resume, steps, blockers: [], warnings: [], pendingVersion: version } : null;
}

/**
 * Decides what is still missing to publish a release from `main`.
 *
 * @param {ReleaseState} state - Snapshot gathered by `state.js`.
 * @param {ReleaseCapabilities} [capabilities] - Steps the project configured.
 * @returns {ReleasePlan} Ordered plan.
 */
export function buildReleasePlan(state, capabilities = DEFAULT_CAPABILITIES) {
  const blockers = findBlockers(state);

  if (blockers.length > 0) {
    return { mode: RELEASE_MODE.blocked, steps: [], blockers, warnings: [], pendingVersion: null };
  }

  const resume = planResume(state, capabilities);

  if (resume) {
    return resume;
  }

  if (state.main.aheadCommits.length > 0) {
    return { mode: RELEASE_MODE.blocked, steps: [], blockers: [foreignCommitsBlocker(state.main.aheadCommits)], warnings: [], pendingVersion: null };
  }

  if (state.unreleasedCommits.length === 0) {
    return { mode: RELEASE_MODE.upToDate, steps: [], blockers: [], warnings: [], pendingVersion: null };
  }

  if (state.changelog.unknownSections.length > 0) {
    return {
      mode: RELEASE_MODE.blocked,
      steps: [],
      blockers: [
        {
          title: `CHANGELOG.md ${UNRELEASED_HEADING} usa secciones no válidas: ${state.changelog.unknownSections.join(", ")}`,
          details: [`Usá solo ${CHANGE_TYPES.map((type) => `### ${type}`).join(", ")} y volvé a correr pnpm create-version.`],
        },
      ],
      warnings: [],
      pendingVersion: null,
    };
  }

  /** @type {ReleasePlanStep[]} */
  const steps = [];
  /** @type {string[]} */
  const warnings = [];

  if (state.main.behindCount > 0) {
    steps.push({ id: RELEASE_STEP.syncMain, title: `Actualizar ${MAIN_BRANCH} desde origin`, detail: `${state.main.behindCount} commit(s) nuevos.` });
  }

  if (state.migrations?.status === MIGRATION_STATUS.pending) {
    steps.push({
      id: RELEASE_STEP.applyMigrations,
      title: `Aplicar ${state.migrations.pending.length} migración(es) en la base de datos`,
      detail: `Destino: ${state.migrations.target ?? "desconocido"} · se pide confirmación antes.`,
    });
  } else if (state.migrations?.status === MIGRATION_STATUS.unknown) {
    warnings.push(`No se pudo verificar si hay migraciones pendientes: ${state.migrations.reason ?? "motivo desconocido"}.`);
  }

  if (state.changelog.entryCount === 0) {
    steps.push({
      id: RELEASE_STEP.generateChangelog,
      title: `Completar ${UNRELEASED_HEADING} del CHANGELOG con Codex`,
      detail: "Está vacío: Codex lo arma desde los commits sin publicar. Si no puede, el release se corta.",
    });
  }

  if (capabilities.checks) {
    steps.push({ id: RELEASE_STEP.runChecks, title: "Validar el proyecto", detail: "Corre los checks configurados antes de tocar la versión." });
  }

  steps.push({
    id: RELEASE_STEP.bumpVersion,
    title: "Elegir la nueva versión y crear commit + tag",
    detail: `${UNRELEASED_HEADING} pasa a esa versión con la fecha de hoy y se commitea junto con package.json.`,
  });

  if (capabilities.prepare) {
    steps.push({ id: RELEASE_STEP.prepareRelease, title: "Preparar el release", detail: "Corre la preparación configurada sobre el commit de versión." });
  }

  steps.push({ id: RELEASE_STEP.pushRelease, title: `Subir ${MAIN_BRANCH} y el tag a origin` });

  if (capabilities.publish) {
    steps.push({ id: RELEASE_STEP.publishRelease, title: capabilities.publishTitle });
  }

  return { mode: RELEASE_MODE.newRelease, steps, blockers: [], warnings, pendingVersion: null };
}
