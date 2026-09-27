/**
 * Pure release planning of `beez-rp create-version`.
 *
 * Receives the snapshot gathered by `state.js` and the project capabilities,
 * and decides without touching Git, npm or databases what is still missing
 * to ship a release from `main`:
 *
 * - a new release: sync `main`, apply migrations, fill the changelog, run the
 *   checks, bump (commit `X.Y.Z` + tag `vX.Y.Z`), prepare, push and publish;
 * - the resume of a release commit that never reached `origin` or the registry,
 *   including the publication of a tagged release from a detached `HEAD`;
 * - nothing, when every commit is already released;
 * - blockers that explain what to fix first (feature branch, uncommitted
 *   files, foreign commits on `main`, unreachable registry, invalid changelog,
 *   npm credentials that cannot publish, a last release missing from npm).
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
  NPM_AUTH_STATUS,
  NPM_DIST_TAG,
  NPM_LOOKUP_STATUS,
  PORCELAIN_STATUS_WIDTH,
  PULL_REQUEST_STATE,
  RELEASE_MODE,
  RELEASE_STEP,
  VERSION_PREFIX_PATTERN,
} from "../constants/create-version.js";
import { RELEASE_TYPE } from "../constants/versions.js";
import { compareReleaseVersions, findHighestStableVersion, isReleaseCommitSubject, isStableReleaseVersion, toReleaseTag } from "../versions.js";
import { describeNpmAuthProblem, describeNpmFirstPublicationWarning } from "./npm-auth.js";

/**
 * @typedef {{ sha?: string, subject: string, body?: string }} ReleaseCommit
 * @typedef {{ name: string, headSha: string, hasUpstream: boolean, unpushedCount: number, aheadOfMainCount: number }} FeatureBranchSnapshot
 * @typedef {{ number: number, url: string, title?: string, state: string, isDraft: boolean, headRefOid: string }} PullRequestSnapshot
 * @typedef {import("./npm.js").NpmLookup} NpmLookup
 * @typedef {import("./npm.js").NpmAuthCheck} NpmAuthCheck
 * @typedef {import("./config.js").MigrationCheck} MigrationCheck
 * @typedef {{ sha: string, version: string | null, subject?: string | null, tagged?: boolean }} LastReleaseSnapshot
 *   Newest commit of `origin/main` that changed `version`; `tagged` when `vX.Y.Z` points at it.
 * @typedef {{
 *   currentBranch: string | null,
 *   workingTreeChanges: string[],
 *   branch?: FeatureBranchSnapshot | null,
 *   pullRequest?: PullRequestSnapshot | null,
 *   githubError?: string | null,
 *   main: { aheadCommits: ReleaseCommit[], behindCount: number },
 *   headVersion: string | null,
 *   headSubject: string | null,
 *   headSha?: string | null,
 *   headReleaseTag?: string | null,
 *   remoteReleaseTagSha?: string | null,
 *   releasedVersion?: string | null,
 *   lastRelease?: LastReleaseSnapshot | null,
 *   unreleasedCommits: ReleaseCommit[],
 *   npm: NpmLookup | null,
 *   npmAuth?: NpmAuthCheck | null,
 *   migrations: MigrationCheck | null,
 *   changelog: { exists: boolean, entryCount: number, unknownSections: string[] },
 * }} ReleaseState
 * @typedef {{ checks: boolean, prepare: boolean, publish: boolean, publishTitle: string }} ReleaseCapabilities
 * @typedef {{ id: string, title: string, detail?: string }} ReleasePlanStep
 * @typedef {{ title: string, details: string[] }} ReleaseBlocker
 * @typedef {{ mode: string, steps: ReleasePlanStep[], blockers: ReleaseBlocker[], warnings: string[], pendingVersion: string | null }} ReleasePlan
 * @typedef {{ bump: "patch" | "minor" | "major" | null, setVersion: string | null, dryRun: boolean, skipUnpublished: boolean, help: boolean }} ReleaseOptions
 * @typedef {{ version: string, latestPublished: string | null, resumable: boolean }} UnpublishedRelease
 * @typedef {{ skipUnpublished?: boolean }} PlanOptions
 *   `skipUnpublished` plans a new release even when the last release is missing from npm.
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
  "  --skip-unpublished         Crea un release nuevo aunque el último release no esté en npm (lo saltea).",
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
        [CREATE_VERSION_FLAG.skipUnpublished]: { type: "boolean", default: false },
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
    skipUnpublished: Boolean(values[CREATE_VERSION_FLAG.skipUnpublished]),
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
 * Explains a failed npm lookup through the credential check when the registry answered it and
 * rejected the credential (an invalid or expired token, or a user that cannot publish): an
 * authenticated `npm view` fails with E401/E403 in that case, so replacing the token is the fix,
 * not the connection. A missing token never reached the registry, so it does not explain the lookup.
 *
 * @param {NpmAuthCheck | null | undefined} npmAuth - Credential check, when it ran.
 * @returns {ReleaseBlocker | null} Credential blocker, or `null` to keep the generic lookup blocker.
 */
function describeRejectedNpmCredential(npmAuth) {
  if (!npmAuth || npmAuth.status === NPM_AUTH_STATUS.missingToken) {
    return null;
  }

  return describeNpmAuthProblem(npmAuth);
}

/**
 * Lists the blockers that must be fixed before any release step runs.
 *
 * @param {ReleaseState} state - Snapshot.
 * @returns {ReleaseBlocker[]} Blockers, most urgent first.
 */
function findBlockers(state) {
  if (!state.currentBranch && !findDetachedReleaseVersion(state)) {
    return [
      {
        title: "HEAD está desacoplado (detached)",
        details: [
          `Hacé git switch ${MAIN_BRANCH} y volvé a correr pnpm create-version.`,
          "Desacoplado solo se puede publicar un release que falta en npm: HEAD tiene que ser el commit X.Y.Z de su tag vX.Y.Z.",
        ],
      },
    ];
  }

  /** @type {ReleaseBlocker[]} */
  const blockers = [];

  if (state.currentBranch && state.currentBranch !== MAIN_BRANCH) {
    blockers.push({
      title: `Estás en ${state.currentBranch}: los releases salen solo desde ${MAIN_BRANCH}`,
      details: state.branch
        ? describeFeatureBranchGaps(state.branch, state.pullRequest ?? null, state.githubError ?? null)
        : [`Hacé git switch ${MAIN_BRANCH} y volvé a correr pnpm create-version.`],
    });
  }

  // CHANGELOG.md may be uncommitted only for a new release, whose bump commits it: resuming an
  // existing release commit re-checks it with requireCleanChangelog.
  const blockingChanges = state.workingTreeChanges.filter((line) => !isChangelogChange(line));

  if (blockingChanges.length > 0) {
    blockers.push({
      title: `Hay ${blockingChanges.length} archivo(s) sin commitear`,
      details: [...blockingChanges.slice(0, MAX_LISTED_ITEMS), "Commitealos en una rama (o git stash) y volvé a correr pnpm create-version."],
    });
  }

  if (state.npm && state.npm.status !== NPM_LOOKUP_STATUS.ok) {
    blockers.push(
      describeRejectedNpmCredential(state.npmAuth) ?? {
        title: "No se pudo consultar npm",
        details: [`${state.npm.reason ?? "npm no respondió"}.`, "Revisá la conexión y volvé a correr pnpm create-version."],
      }
    );
  }

  return blockers;
}

/**
 * Tells whether a `git status --porcelain` line is a change of `CHANGELOG.md`.
 *
 * @param {string} line - Porcelain line.
 * @returns {boolean} `true` when the line reports `CHANGELOG.md`.
 */
function isChangelogChange(line) {
  return line.slice(PORCELAIN_STATUS_WIDTH) === CHANGELOG_FILE;
}

/**
 * Blocks a resume plan while `CHANGELOG.md` has uncommitted changes: only a new release commits
 * that file (in its bump), so resuming would prepare or publish content that is not in the
 * release commit.
 *
 * @param {ReleasePlan} plan - Resume plan (from `main` or from a detached release tag).
 * @param {ReleaseState} state - Snapshot.
 * @returns {ReleasePlan} The same plan, or a blocked plan when `CHANGELOG.md` is dirty.
 */
function requireCleanChangelog(plan, state) {
  const changelogChanges = state.workingTreeChanges.filter(isChangelogChange);

  if (plan.mode !== RELEASE_MODE.resume || changelogChanges.length === 0) {
    return plan;
  }

  return {
    mode: RELEASE_MODE.blocked,
    steps: [],
    blockers: [
      {
        title: `${CHANGELOG_FILE} tiene cambios sin commitear y el release ${plan.pendingVersion} ya está commiteado`,
        details: [
          ...changelogChanges,
          `Retomar un release usa el ${CHANGELOG_FILE} de su commit: descartá los cambios (git restore ${CHANGELOG_FILE}) o guardalos (git stash) y volvé a correr pnpm create-version.`,
        ],
      },
    ],
    warnings: [],
    pendingVersion: null,
  };
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
 * Returns the version a detached `HEAD` may publish: `HEAD` must be exactly the commit its tag
 * `vX.Y.Z` points at, with subject `X.Y.Z`, and npm must report that the version is missing.
 *
 * @param {ReleaseState} state - Snapshot.
 * @returns {string | null} Version to publish, or `null` when `HEAD` is not detached on such a release.
 */
function findDetachedReleaseVersion(state) {
  const { currentBranch, headVersion, headSubject, headReleaseTag, npm } = state;

  if (currentBranch || !isStableReleaseVersion(headVersion) || headSubject?.trim() !== headVersion) {
    return null;
  }

  const version = /** @type {string} */ (headVersion);
  const tagged = headReleaseTag === toReleaseTag(version);
  const missingFromNpm = npm?.status === NPM_LOOKUP_STATUS.ok && !npm.publishedVersions.includes(version);
  return tagged && missingFromNpm ? version : null;
}

/**
 * Lists why a detached release tag cannot be published: its commit and tag must already be on
 * `origin` (a detached publication never pushes), and its version must be higher than every
 * stable version on npm (the publication moves the `latest` dist-tag).
 *
 * @param {string} version - Version found by {@link findDetachedReleaseVersion}.
 * @param {ReleaseState} state - Snapshot.
 * @returns {ReleaseBlocker[]} Blockers, empty when the tag can be published.
 */
function findDetachedReleaseBlockers(version, state) {
  const tag = toReleaseTag(version);
  const returnToMain = `Volvé con git switch ${MAIN_BRANCH} y corré pnpm create-version, que retoma el push de ${MAIN_BRANCH} y ${tag} antes de publicar.`;
  /** @type {ReleaseBlocker[]} */
  const blockers = [];

  if (!state.remoteReleaseTagSha) {
    blockers.push({
      title: `${tag} no está en origin (o no se pudo consultar origin)`,
      details: ["Desacoplado solo se publica un release cuyo commit y tag ya están en origin: publicarlo dejaría en npm una versión sin su commit en origin.", returnToMain],
    });
  } else if (state.remoteReleaseTagSha !== state.headSha) {
    blockers.push({
      title: `${tag} de origin apunta a otro commit que el ${tag} local`,
      details: [`origin: ${state.remoteReleaseTagSha} · HEAD: ${state.headSha ?? "desconocido"}.`, `Revisá cuál es el release correcto antes de publicar. ${returnToMain}`],
    });
  }

  const latestPublished = findHighestStableVersion(state.npm?.publishedVersions ?? []);

  if (latestPublished && compareReleaseVersions(version, latestPublished) <= 0) {
    blockers.push({
      title: `${version} no es mayor que ${latestPublished}, la versión más alta publicada en npm`,
      details: [
        `Publicarla con --tag ${NPM_DIST_TAG} movería ${NPM_DIST_TAG} hacia atrás: si hace falta, publicala a mano con otro dist-tag.`,
        `Hacé git switch ${MAIN_BRANCH} para volver.`,
      ],
    });
  }

  return blockers;
}

/**
 * Plans the publication of a tagged release from a detached `HEAD`: preparation and publication
 * only, without syncing nor pushing `main`.
 *
 * @param {string} version - Version found by {@link findDetachedReleaseVersion}.
 * @param {ReleaseCapabilities} capabilities - Project capabilities.
 * @param {ReleaseState} state - Snapshot.
 * @returns {ReleasePlan} Resume plan, or a blocker when the project has no publication step, the
 *   tag is not on `origin` or the version is not above the latest one on npm.
 */
function planDetachedResume(version, capabilities, state) {
  const tag = toReleaseTag(version);

  if (!capabilities.publish) {
    return {
      mode: RELEASE_MODE.blocked,
      steps: [],
      blockers: [{ title: `${tag} no está en npm, pero este proyecto no configura publish`, details: ["Agregá publish en beez-rp.config.js o publicalo a mano."] }],
      warnings: [],
      pendingVersion: null,
    };
  }

  const blockers = findDetachedReleaseBlockers(version, state);

  if (blockers.length > 0) {
    return { mode: RELEASE_MODE.blocked, steps: [], blockers, warnings: [], pendingVersion: null };
  }

  /** @type {ReleasePlanStep[]} */
  const steps = [];

  if (capabilities.prepare) {
    steps.push({ id: RELEASE_STEP.prepareRelease, title: `Preparar el release ${version}`, detail: `Desde el tag ${tag} (HEAD desacoplado): no se toca ${MAIN_BRANCH}.` });
  }

  steps.push({ id: RELEASE_STEP.publishRelease, title: `${capabilities.publishTitle} (${version})`, detail: `Desde el tag ${tag}: solo falta publicarlo, sin sync ni push de ${MAIN_BRANCH}.` });
  return { mode: RELEASE_MODE.resume, steps, blockers: [], warnings: [], pendingVersion: version };
}

/**
 * Finds a last release that npm never received and that a new release would skip: a stable
 * version (from `origin/main`) missing from the published versions and higher than every
 * published one (or, with nothing published, tagged as `vX.Y.Z`).
 *
 * @param {ReleaseState} state - Snapshot.
 * @returns {UnpublishedRelease | null} Unpublished release, or `null` when npm is not tracked or
 *   has it. `resumable` when its commit is `X.Y.Z` with tag `vX.Y.Z`.
 */
function findUnpublishedLastRelease(state) {
  const { npm, lastRelease } = state;
  const version = state.releasedVersion ?? lastRelease?.version ?? null;

  if (npm?.status !== NPM_LOOKUP_STATUS.ok || !isStableReleaseVersion(version) || npm.publishedVersions.includes(/** @type {string} */ (version))) {
    return null;
  }

  const releaseVersion = /** @type {string} */ (version);
  const latestPublished = findHighestStableVersion(npm.publishedVersions);

  if (latestPublished && compareReleaseVersions(releaseVersion, latestPublished) <= 0) {
    return null;
  }

  // With nothing published, an untagged version is the initial one of a package that was never
  // released (not a skipped release), so only a tagged release blocks.
  if (!latestPublished && !lastRelease?.tagged) {
    return null;
  }

  const resumable = Boolean(lastRelease?.tagged) && lastRelease?.version === releaseVersion && lastRelease?.subject?.trim() === releaseVersion;
  return { version: releaseVersion, latestPublished, resumable };
}

/**
 * Explains why no new release is planned while the last one is missing from npm, and how to publish it.
 *
 * @param {UnpublishedRelease} unpublished - Unpublished release.
 * @returns {ReleaseBlocker} Blocker.
 */
function unpublishedReleaseBlocker({ version, latestPublished, resumable }) {
  const tag = toReleaseTag(version);
  const published = latestPublished ? `npm llega hasta ${latestPublished}` : "npm no tiene ninguna versión publicada";
  const howToPublish = resumable
    ? [
        `Para publicarla: git switch --detach ${tag} y pnpm create-version, que retoma solo la preparación y la publicación desde el tag (sin tocar ${MAIN_BRANCH}).`,
        `Después volvé con git switch ${MAIN_BRANCH} y corré pnpm create-version para el release nuevo.`,
      ]
    : [`Su commit no es un commit ${version} con el tag ${tag}, así que create-version no puede retomarlo: publicala a mano desde ese commit.`];

  return {
    title: `La versión ${version} (último release, tag ${tag}) no está en npm`,
    details: [`${published}; un release nuevo la saltearía.`, ...howToPublish, "Para saltearla a propósito: pnpm create-version --skip-unpublished."],
  };
}

/**
 * Warns that `--skip-unpublished` leaves the last release out of npm on purpose.
 *
 * @param {UnpublishedRelease} unpublished - Skipped release.
 * @returns {string} Warning.
 */
function skippedReleaseWarning({ version }) {
  return `Se saltea ${version} (tag ${toReleaseTag(version)}), que no está en npm: el release nuevo sale sin publicarla (--skip-unpublished).`;
}

/**
 * Checks the last release of `origin/main` missing from npm before resuming a different local
 * release: pushing and publishing that one would skip it. `--skip-unpublished` skips it on purpose.
 *
 * @param {ReleasePlan} resume - Plan built by {@link planResume}.
 * @param {ReleaseState} state - Snapshot.
 * @param {boolean} skipUnpublished - Whether `--skip-unpublished` was chosen.
 * @returns {ReleasePlan} The same plan, blocked, or with a warning when the release is skipped.
 */
function checkUnpublishedBeforeResume(resume, state, skipUnpublished) {
  const unpublished = resume.mode === RELEASE_MODE.resume ? findUnpublishedLastRelease(state) : null;

  if (!unpublished || unpublished.version === resume.pendingVersion) {
    return resume;
  }

  return skipUnpublished
    ? { ...resume, warnings: [...resume.warnings, skippedReleaseWarning(unpublished)] }
    : { mode: RELEASE_MODE.blocked, steps: [], blockers: [unpublishedReleaseBlocker(unpublished)], warnings: [], pendingVersion: null };
}

/**
 * Stops a plan that would publish when the npm credential check found a problem, or warns when
 * the check could not decide or the first publication cannot be told apart from a hidden private package.
 *
 * @param {ReleasePlan} plan - Plan built from the rest of the snapshot.
 * @param {NpmAuthCheck | null | undefined} npmAuth - Credential check, when the project publishes to npm.
 * @returns {ReleasePlan} The same plan, blocked or with a warning when needed.
 */
function applyNpmAuth(plan, npmAuth) {
  if (!npmAuth || !plan.steps.some((planStep) => planStep.id === RELEASE_STEP.publishRelease)) {
    return plan;
  }

  const problem = describeNpmAuthProblem(npmAuth);

  if (problem) {
    return { mode: RELEASE_MODE.blocked, steps: [], blockers: [problem], warnings: [], pendingVersion: null };
  }

  if (npmAuth.status === NPM_AUTH_STATUS.unknown) {
    return { ...plan, warnings: [...plan.warnings, `No se pudieron verificar las credenciales de npm: ${npmAuth.reason ?? "motivo desconocido"}. Se intenta publicar igual.`] };
  }

  const firstPublicationWarning = describeNpmFirstPublicationWarning(npmAuth);
  return firstPublicationWarning ? { ...plan, warnings: [...plan.warnings, firstPublicationWarning] } : plan;
}

/**
 * Decides what is still missing to publish a release from `main` (or, from a detached `HEAD` on
 * a release tag, to publish that release).
 *
 * @param {ReleaseState} state - Snapshot gathered by `state.js`.
 * @param {ReleaseCapabilities} [capabilities] - Steps the project configured.
 * @param {PlanOptions} [planOptions] - Options chosen on the command line.
 * @returns {ReleasePlan} Ordered plan.
 */
export function buildReleasePlan(state, capabilities = DEFAULT_CAPABILITIES, planOptions = {}) {
  return applyNpmAuth(planRelease(state, capabilities, planOptions), state.npmAuth);
}

/**
 * Plans the release from the snapshot, before the npm credential check is applied.
 *
 * @param {ReleaseState} state - Snapshot gathered by `state.js`.
 * @param {ReleaseCapabilities} capabilities - Steps the project configured.
 * @param {PlanOptions} planOptions - Options chosen on the command line.
 * @returns {ReleasePlan} Ordered plan.
 */
function planRelease(state, capabilities, { skipUnpublished = false }) {
  const blockers = findBlockers(state);

  if (blockers.length > 0) {
    return { mode: RELEASE_MODE.blocked, steps: [], blockers, warnings: [], pendingVersion: null };
  }

  const detachedVersion = findDetachedReleaseVersion(state);

  if (detachedVersion) {
    return requireCleanChangelog(planDetachedResume(detachedVersion, capabilities, state), state);
  }

  const resume = planResume(state, capabilities);

  if (resume) {
    return requireCleanChangelog(checkUnpublishedBeforeResume(resume, state, skipUnpublished), state);
  }

  if (state.main.aheadCommits.length > 0) {
    return { mode: RELEASE_MODE.blocked, steps: [], blockers: [foreignCommitsBlocker(state.main.aheadCommits)], warnings: [], pendingVersion: null };
  }

  const unpublished = findUnpublishedLastRelease(state);

  if (unpublished && !skipUnpublished) {
    return { mode: RELEASE_MODE.blocked, steps: [], blockers: [unpublishedReleaseBlocker(unpublished)], warnings: [], pendingVersion: null };
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
  const warnings = unpublished ? [skippedReleaseWarning(unpublished)] : [];

  // The rest of the plan depends on the code and configuration of the updated main, so the run
  // stops after syncing and the next one diagnoses again.
  if (state.main.behindCount > 0) {
    steps.push({
      id: RELEASE_STEP.syncMain,
      title: `Actualizar ${MAIN_BRANCH} desde origin`,
      detail: `${state.main.behindCount} commit(s) nuevos. Después hay que volver a correr pnpm create-version, que diagnostica con el código nuevo.`,
    });
    return { mode: RELEASE_MODE.newRelease, steps, blockers: [], warnings, pendingVersion: null };
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
