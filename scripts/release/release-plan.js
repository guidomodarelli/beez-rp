/**
 * Pure release planning for `pnpm create-version` of beez-rp.
 *
 * Receives the snapshot gathered by `release-state.js` and decides, without
 * touching Git or npm, what is still missing: a new release (sync `main`,
 * fill the CHANGELOG, run the checks, bump, push and publish), the resume of a
 * release commit that never reached npm, nothing at all, or blockers that
 * explain what to fix first.
 *
 * @module scripts/release/release-plan
 */

import { parseArgs } from "node:util";

import { CHANGE_TYPES, CHANGELOG_FILE, UNRELEASED_HEADING } from "../../src/constants/changelog.js";
import { RELEASE_TYPE } from "../../src/constants/versions.js";
import { isReleaseCommitSubject, isStableReleaseVersion, toReleaseTag } from "../../src/versions.js";
import {
  MAIN_BRANCH,
  MAX_LISTED_CHANGES,
  NPM_LOOKUP_STATUS,
  PORCELAIN_STATUS_WIDTH,
  RELEASE_MODE,
  RELEASE_STEP,
} from "../constants/release.js";

/**
 * @typedef {{ sha?: string, subject: string, body?: string }} ReleaseCommit
 * @typedef {{
 *   currentBranch: string | null,
 *   workingTreeChanges: string[],
 *   main: { aheadCommits: ReleaseCommit[], behindCount: number },
 *   headVersion: string | null,
 *   headSubject: string | null,
 *   npm: { status: string, publishedVersions: string[], reason: string | null },
 *   unreleasedCommits: ReleaseCommit[],
 *   changelog: { exists: boolean, entryCount: number, unknownSections: string[] },
 * }} ReleaseState
 * @typedef {{ id: string, title: string, detail?: string }} ReleasePlanStep
 * @typedef {{ title: string, details: string[] }} ReleaseBlocker
 * @typedef {{ mode: string, steps: ReleasePlanStep[], blockers: ReleaseBlocker[], pendingVersion: string | null }} ReleasePlan
 * @typedef {{ bump: "patch" | "minor" | "major" | null, setVersion: string | null, dryRun: boolean, help: boolean }} ReleaseOptions
 */

/** Usage printed by `pnpm create-version --help`. */
export const RELEASE_USAGE = [
  "Uso: pnpm create-version [opciones]",
  "",
  "  --bump patch|minor|major   Elige el tipo de versión sin preguntar.",
  "  --set-version X.Y.Z        Fija la versión exacta (solo el siguiente patch, minor o major).",
  "  --dry-run                  Diagnostica y muestra el plan sin cambiar nada.",
  "  --help                     Muestra esta ayuda.",
].join("\n");

/**
 * Parses the command-line arguments of `pnpm create-version`.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {ReleaseOptions} Options.
 * @throws {Error} With a Spanish message when an argument is unknown or invalid.
 */
export function parseReleaseArguments(argv) {
  let values;

  try {
    ({ values } = parseArgs({
      args: argv.filter((argument) => argument !== "--"),
      options: {
        bump: { type: "string" },
        "set-version": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    throw new Error(`Opción inválida: ${error instanceof Error ? error.message : String(error)}. Usá --help para ver las opciones.`, {
      cause: error,
    });
  }

  const releaseTypes = /** @type {string[]} */ (Object.values(RELEASE_TYPE));

  if (values.bump !== undefined && !releaseTypes.includes(values.bump)) {
    throw new Error(`--bump espera ${releaseTypes.join("|")} y recibió "${values.bump}".`);
  }

  if (values.bump !== undefined && values["set-version"] !== undefined) {
    throw new Error("Usá --bump o --set-version, no los dos a la vez.");
  }

  const setVersion = values["set-version"];

  return {
    bump: /** @type {ReleaseOptions["bump"]} */ (values.bump ?? null),
    // A typed `v1.2.0` means `1.2.0`; the version rules validate the rest.
    setVersion: setVersion === undefined ? null : setVersion.replace(/^v/u, ""),
    dryRun: Boolean(values["dry-run"]),
    help: Boolean(values.help),
  };
}

/**
 * Returns whether `HEAD` is a release commit whose version never reached npm,
 * which happens when a previous run failed after committing.
 *
 * @param {ReleaseState} state - Snapshot.
 * @returns {boolean} `true` when that release must be resumed.
 */
function hasPendingRelease(state) {
  const { headVersion, headSubject, npm } = state;

  return (
    isStableReleaseVersion(headVersion) &&
    headSubject?.trim() === headVersion &&
    !npm.publishedVersions.includes(/** @type {string} */ (headVersion))
  );
}

/**
 * Lists the blockers that must be fixed before any release step runs.
 *
 * @param {ReleaseState} state - Snapshot.
 * @returns {ReleaseBlocker[]} Blockers, most urgent first.
 */
function findBlockers(state) {
  /** @type {ReleaseBlocker[]} */
  const blockers = [];

  if (!state.currentBranch) {
    return [{ title: "HEAD está desacoplado (detached)", details: [`Hacé git switch ${MAIN_BRANCH} y volvé a correr pnpm create-version.`] }];
  }

  if (state.currentBranch !== MAIN_BRANCH) {
    blockers.push({
      title: `Estás en ${state.currentBranch}: los releases salen solo desde ${MAIN_BRANCH}`,
      details: [`Mergeá la rama en ${MAIN_BRANCH}, hacé git switch ${MAIN_BRANCH} y volvé a correr pnpm create-version.`],
    });
  }

  const blockingChanges = state.workingTreeChanges.filter((line) => line.slice(PORCELAIN_STATUS_WIDTH) !== CHANGELOG_FILE);

  if (blockingChanges.length > 0) {
    blockers.push({
      title: `Hay ${blockingChanges.length} archivo(s) sin commitear`,
      details: [...blockingChanges.slice(0, MAX_LISTED_CHANGES), `Solo ${CHANGELOG_FILE} puede quedar sin commitear: viaja en el commit de versión.`],
    });
  }

  if (state.npm.status !== NPM_LOOKUP_STATUS.ok) {
    blockers.push({
      title: "No se pudo consultar npm",
      details: [`${state.npm.reason ?? "npm no respondió"}.`, "Revisá la conexión y volvé a correr pnpm create-version."],
    });
  }

  return blockers;
}

/**
 * Decides what is still missing to publish beez-rp from `main`.
 *
 * @param {ReleaseState} state - Snapshot gathered by `release-state.js`.
 * @returns {ReleasePlan} Ordered plan.
 */
export function buildReleasePlan(state) {
  const blockers = findBlockers(state);

  if (blockers.length > 0) {
    return { mode: RELEASE_MODE.blocked, steps: [], blockers, pendingVersion: null };
  }

  if (hasPendingRelease(state)) {
    const version = /** @type {string} */ (state.headVersion);
    const foreignCommits = state.main.aheadCommits.filter((commit) => !isReleaseCommitSubject(commit.subject));

    if (foreignCommits.length > 0) {
      return {
        mode: RELEASE_MODE.blocked,
        steps: [],
        blockers: [{ title: `${MAIN_BRANCH} local tiene commits que no están en origin`, details: foreignCommits.map((commit) => `· ${commit.subject}`) }],
        pendingVersion: null,
      };
    }

    /** @type {ReleasePlanStep[]} */
    const steps = [];

    if (state.main.aheadCommits.length > 0) {
      steps.push({ id: RELEASE_STEP.pushRelease, title: `Subir ${MAIN_BRANCH} y ${toReleaseTag(version)} a origin` });
    }

    steps.push({ id: RELEASE_STEP.publishPackage, title: `Publicar beez-rp@${version} en npm`, detail: "El commit de versión ya existe: solo falta lo que no se completó." });
    return { mode: RELEASE_MODE.resume, steps, blockers: [], pendingVersion: version };
  }

  if (state.main.aheadCommits.length > 0) {
    return {
      mode: RELEASE_MODE.blocked,
      steps: [],
      blockers: [
        {
          title: `${MAIN_BRANCH} local tiene ${state.main.aheadCommits.length} commit(s) que no están en origin`,
          details: [...state.main.aheadCommits.slice(0, MAX_LISTED_CHANGES).map((commit) => `· ${commit.subject}`), `Pushealos a origin/${MAIN_BRANCH} y volvé a correr pnpm create-version.`],
        },
      ],
      pendingVersion: null,
    };
  }

  if (state.unreleasedCommits.length === 0) {
    return { mode: RELEASE_MODE.upToDate, steps: [], blockers: [], pendingVersion: null };
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
      pendingVersion: null,
    };
  }

  /** @type {ReleasePlanStep[]} */
  const steps = [];

  if (state.main.behindCount > 0) {
    steps.push({ id: RELEASE_STEP.syncMain, title: `Actualizar ${MAIN_BRANCH} desde origin`, detail: `${state.main.behindCount} commit(s) nuevos.` });
  }

  if (state.changelog.entryCount === 0) {
    steps.push({
      id: RELEASE_STEP.generateChangelog,
      title: `Completar ${UNRELEASED_HEADING} del CHANGELOG con Codex`,
      detail: "Está vacío: Codex lo arma desde los commits sin publicar. Si no puede, el release se corta.",
    });
  }

  steps.push(
    { id: RELEASE_STEP.runChecks, title: "Validar el paquete", detail: "Typecheck y tests antes de tocar la versión." },
    { id: RELEASE_STEP.bumpVersion, title: "Elegir la nueva versión y crear commit + tag", detail: `${UNRELEASED_HEADING} pasa a esa versión con la fecha de hoy.` },
    { id: RELEASE_STEP.pushRelease, title: `Subir ${MAIN_BRANCH} y el tag a origin` },
    { id: RELEASE_STEP.publishPackage, title: "Publicar en npm", detail: "Usa NPM_TOKEN del entorno o del .env." }
  );

  return { mode: RELEASE_MODE.newRelease, steps, blockers: [], pendingVersion: null };
}
