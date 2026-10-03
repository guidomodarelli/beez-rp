/**
 * Pure planning of a monorepo release. Receives the snapshot of `state.js`
 * and decides, without touching Git or npm, what is still missing:
 *
 * - a new release: the packages with commits under their paths are the
 *   candidates; the run asks the version of each one (or skips it) before
 *   verifying manual changelogs, applying migrations, running the checks and creating one release commit with a tag
 *   per package, prepares, pushes and publishes in dependency order;
 * - the resume of a local release commit that never reached `origin`, or of
 *   tagged releases on `origin/main` that npm does not have yet;
 * - nothing, when no package changed;
 * - blockers explaining what to fix first.
 *
 * @module monorepo/plan
 */

import { CHANGELOG_UPDATE_REQUIRED_CODE } from "../constants/changelog.js";
import {
  CREATE_VERSION_FLAG,
  MAIN_BRANCH,
  MAX_LISTED_ITEMS,
  MIGRATION_STATUS,
  NPM_AUTH_STATUS,
  NPM_LOOKUP_STATUS,
  RELEASE_MODE,
  RELEASE_REMOTE,
  RELEASE_STEP,
  REMOTE_MAIN_REF,
} from "../constants/create-version.js";
import { MONOREPO_RELEASE_STEP } from "../constants/monorepo.js";
import { codeChangesToSetAsideBlocker, describeFeatureBranchGaps, foreignCommitsBlocker, isCodeChange, listPorcelainPaths, missingChecksBlocker } from "../create-version/plan.js";
import { describeNpmAuthProblem, describeNpmFirstPublicationWarning } from "../create-version/npm-auth.js";
import { DEFAULT_PROJECT_COMMANDS } from "../package-manager.js";
import { findHighestStableVersion, isStableReleaseVersion, isStableVersionAbove } from "../versions.js";
import { parseMonorepoReleaseSubject } from "./release-commit.js";
import { formatPackageTag } from "./workspaces.js";

/**
 * @typedef {import("./state.js").MonorepoSnapshot} MonorepoSnapshot
 * @typedef {import("./state.js").PackageSnapshot} PackageSnapshot
 * @typedef {import("../create-version/plan.js").ReleaseCapabilities} ReleaseCapabilities
 * @typedef {import("../create-version/plan.js").ReleasePlanStep} ReleasePlanStep
 * @typedef {import("../create-version/plan.js").ReleaseBlocker} ReleaseBlocker
 * @typedef {import("../package-manager.js").ProjectCommands} ProjectCommands
 * @typedef {{ name: string, version: string, tag: string, commitSha: string, publish: boolean }} PendingPackageRelease
 *   A release to finish: its tag, the release commit it points at and whether it still has to be published.
 * @typedef {{
 *   mode: string,
 *   steps: ReleasePlanStep[],
 *   blockers: ReleaseBlocker[],
 *   warnings: string[],
 *   candidates: string[],
 *   pendingReleases: PendingPackageRelease[],
 * }} MonorepoPlan
 *   `candidates` are the packages a new release may include; `pendingReleases` what a resume finishes.
 */

/**
 * @param {Partial<MonorepoPlan>} plan - Plan fields.
 * @returns {MonorepoPlan} Plan with every list defaulted.
 */
function createPlan(plan) {
  return { mode: RELEASE_MODE.blocked, steps: [], blockers: [], warnings: [], candidates: [], pendingReleases: [], ...plan };
}

/**
 * Tells whether a `git status --porcelain` line changes one of the given files.
 *
 * @param {string} line - Porcelain line.
 * @param {ReadonlySet<string>} paths - Paths relative to the root.
 * @returns {boolean} Whether the line reports one of them.
 */
function changesOneOf(line, paths) {
  return listPorcelainPaths(line).some((changedPath) => paths.has(changedPath));
}

/**
 * Lists the uncommitted changes a run with `--ignore-local-changes` sets aside: every change,
 * except the package changelogs in a new release (its bump commits them).
 *
 * @param {MonorepoSnapshot} state - Snapshot.
 * @param {string} mode - Planned mode.
 * @returns {string[]} `git status --porcelain` lines to set aside.
 */
export function listMonorepoChangesToSetAside(state, mode) {
  const changelogs = new Set(state.packages.map((packageSnapshot) => packageSnapshot.unit.changelogPath));
  return mode === RELEASE_MODE.newRelease ? state.workingTreeChanges.filter((line) => !changesOneOf(line, changelogs)) : state.workingTreeChanges;
}

/**
 * Lists the blockers that must be fixed before any step runs.
 *
 * @param {MonorepoSnapshot} state - Snapshot.
 * @param {boolean} ignoreLocalChanges - Whether uncommitted changes are set aside instead of blocking.
 * @param {ProjectCommands} commands - Project commands quoted by the hints.
 * @returns {ReleaseBlocker[]} Blockers, most urgent first.
 */
function findBlockers(state, ignoreLocalChanges, commands) {
  if (!state.currentBranch) {
    return [
      {
        title: "HEAD está desacoplado (detached)",
        details: [
          `Hacé git switch ${MAIN_BRANCH} y volvé a correr ${commands.createVersion}.`,
          "En un monorepo las publicaciones pendientes también se retoman desde main: cada paquete se publica desde su tag.",
        ],
      },
    ];
  }

  /** @type {ReleaseBlocker[]} */
  const blockers = [];

  if (state.currentBranch !== MAIN_BRANCH) {
    blockers.push({
      title: `Estás en ${state.currentBranch}: los releases salen solo desde ${MAIN_BRANCH}`,
      details: state.branch
        ? describeFeatureBranchGaps(state.branch, state.pullRequest ?? null, state.githubError ?? null, commands)
        : [`Hacé git switch ${MAIN_BRANCH} y volvé a correr ${commands.createVersion}.`],
    });
  }

  // Without origin/main no package has commits to compare, so the plan would say everything is up to date.
  if (!state.remoteMainExists) {
    blockers.push({
      title: `No existe ${REMOTE_MAIN_REF}: no se puede saber qué cambió en cada paquete`,
      details: [`Subí ${MAIN_BRANCH} con git push -u ${RELEASE_REMOTE} ${MAIN_BRANCH} (o revisá el remoto ${RELEASE_REMOTE}) y volvé a correr ${commands.createVersion}.`],
    });
  }

  const blockingChanges = listMonorepoChangesToSetAside(state, RELEASE_MODE.newRelease);

  if (blockingChanges.length > 0 && !ignoreLocalChanges) {
    blockers.push({
      title: `Hay ${blockingChanges.length} archivo(s) sin commitear`,
      details: [
        ...blockingChanges.slice(0, MAX_LISTED_ITEMS),
        `Commitealos en una rama (o git stash) y volvé a correr ${commands.createVersion}, o corré ${commands.createVersion} --${CREATE_VERSION_FLAG.ignoreLocalChanges} para apartarlos durante el release.`,
      ],
    });
  }

  for (const packageSnapshot of state.packages) {
    if (packageSnapshot.npm && packageSnapshot.npm.status !== NPM_LOOKUP_STATUS.ok) {
      const rejectedCredential =
        packageSnapshot.npmAuth && packageSnapshot.npmAuth.status !== NPM_AUTH_STATUS.missingToken ? describeNpmAuthProblem(packageSnapshot.npmAuth, commands) : null;
      blockers.push(
        rejectedCredential ?? {
          title: `No se pudo consultar ${packageSnapshot.npm.registryLabel ?? "npm"} para ${packageSnapshot.unit.name}`,
          details: [`${packageSnapshot.npm.reason ?? "npm no respondió"}.`, `Revisá la conexión y volvé a correr ${commands.createVersion}.`],
        }
      );
    }
  }

  return blockers;
}

/**
 * Tells whether npm still lacks a version of a package (always `true` when npm is not tracked).
 *
 * @param {PackageSnapshot | undefined} packageSnapshot - Package.
 * @param {string} version - Version.
 * @returns {boolean} Whether the version still has to be published.
 */
function isMissingFromNpm(packageSnapshot, version) {
  return packageSnapshot?.npm ? !packageSnapshot.npm.publishedVersions.includes(version) : true;
}

/**
 * Plans the resume of local release commits that never reached `origin`.
 *
 * @param {MonorepoSnapshot} state - Snapshot.
 * @param {ReleaseCapabilities} capabilities - Project capabilities.
 * @param {string} tagFormat - Tag format.
 * @returns {MonorepoPlan | null} Resume plan, a blocked plan for foreign commits, or `null` when `main` is not ahead.
 */
function planLocalResume(state, capabilities, tagFormat) {
  const { aheadCommits } = state.main;

  if (aheadCommits.length === 0) {
    return null;
  }

  const parsed = aheadCommits.map((commit) => ({ commit, releases: parseMonorepoReleaseSubject(commit.subject) }));
  const foreign = parsed.filter(({ releases }) => releases === null);

  if (foreign.length > 0) {
    return createPlan({ blockers: [foreignCommitsBlocker(foreign.map(({ commit }) => commit))] });
  }

  const byName = new Map(state.packages.map((packageSnapshot) => [packageSnapshot.unit.name, packageSnapshot]));
  /** @type {Map<string, PendingPackageRelease>} */
  const pending = new Map();

  // Newest first: a package released twice locally keeps its newest release.
  for (const { commit, releases } of parsed) {
    for (const release of releases ?? []) {
      const packageSnapshot = byName.get(release.name);
      if (!packageSnapshot || pending.has(release.name)) {
        continue;
      }
      pending.set(release.name, {
        name: release.name,
        version: release.version,
        tag: formatPackageTag(tagFormat, packageSnapshot.unit, release.version),
        commitSha: commit.sha ?? "",
        publish: capabilities.publish && isMissingFromNpm(packageSnapshot, release.version),
      });
    }
  }

  const pendingReleases = [...pending.values()];
  const listed = pendingReleases.map(({ name, version }) => `${name}@${version}`).join(", ");
  /** @type {ReleasePlanStep[]} */
  const steps = [];

  if (capabilities.prepare) {
    steps.push({ id: RELEASE_STEP.prepareRelease, title: "Preparar el release", detail: "El commit de release ya existe: se vuelve a preparar lo necesario." });
  }
  steps.push({ id: MONOREPO_RELEASE_STEP.pushPackages, title: `Subir ${MAIN_BRANCH} y los tags a origin`, detail: `El release quedó creado solo en local: ${listed}.` });
  if (pendingReleases.some((release) => release.publish)) {
    steps.push({ id: MONOREPO_RELEASE_STEP.publishPackages, title: capabilities.publishTitle, detail: "Solo los paquetes que todavía no se publicaron." });
  }

  return createPlan({ mode: RELEASE_MODE.resume, steps, pendingReleases });
}

/**
 * Plans the publication of tagged releases of `origin/main` that npm does not have yet. A version
 * below the highest one published is only warned about: publishing it would move `latest` back.
 *
 * @param {MonorepoSnapshot} state - Snapshot.
 * @param {ReleaseCapabilities} capabilities - Project capabilities.
 * @returns {{ plan: MonorepoPlan | null, warnings: string[] }} Resume plan (or `null` when nothing tagged is
 *   missing from npm), and the warnings about missing versions that cannot be published.
 */
function planPendingPublications(state, capabilities) {
  if (!capabilities.publish) {
    return { plan: null, warnings: [] };
  }

  /** @type {PendingPackageRelease[]} */
  const pendingReleases = [];
  /** @type {string[]} */
  const warnings = [];

  for (const packageSnapshot of state.packages) {
    const { npm, lastRelease, releasedVersion, unit } = packageSnapshot;
    const version = lastRelease?.version ?? null;

    if (npm?.status !== NPM_LOOKUP_STATUS.ok || !lastRelease?.tag || !isStableReleaseVersion(version) || version !== releasedVersion) {
      continue;
    }
    if (!lastRelease.tagged || !lastRelease.tagOnOrigin || npm.publishedVersions.includes(/** @type {string} */ (version))) {
      continue;
    }

    const highestPublished = findHighestStableVersion(npm.publishedVersions);
    if (highestPublished && !isStableVersionAbove(/** @type {string} */ (version), highestPublished)) {
      warnings.push(`${unit.name}@${version} (${lastRelease.tag}) no está en ${npm.registryLabel ?? "npm"}, pero ${npm.registryLabel ?? "npm"} ya tiene ${highestPublished}: publicarla movería ${npm.tag ?? "latest"} hacia atrás, así que no se publica.`);
      continue;
    }

    pendingReleases.push({ name: unit.name, version: /** @type {string} */ (version), tag: lastRelease.tag, commitSha: lastRelease.sha, publish: true });
  }

  if (pendingReleases.length === 0) {
    return { plan: null, warnings };
  }

  const listed = pendingReleases.map(({ name, version }) => `${name}@${version}`).join(", ");
  const plan = createPlan({
    mode: RELEASE_MODE.resume,
    steps: [
      {
        id: MONOREPO_RELEASE_STEP.publishPackages,
        title: `${capabilities.publishTitle} (${listed})`,
        detail: "Ya están en origin con su tag: se prepara y publica cada uno desde su commit de release.",
      },
    ],
    warnings,
    pendingReleases,
  });
  return { plan, warnings };
}

/**
 * Warns that `--skip-unpublished` leaves a tagged release out of npm on purpose.
 *
 * @param {string} name - Package name.
 * @param {string} version - Skipped version.
 * @param {string} tag - Its tag.
 * @param {string} [registryLabel] - Selected registry label.
 * @returns {string} Warning.
 */
function describeSkippedPublication(name, version, tag, registryLabel = "npm") {
  return `Se saltea ${name}@${version} (tag ${tag}), que no está en ${registryLabel}: el release nuevo sale sin publicarla (--${CREATE_VERSION_FLAG.skipUnpublished}).`;
}

/**
 * Plans a new release of the packages that changed.
 *
 * @param {MonorepoSnapshot} state - Snapshot.
 * @param {ReleaseCapabilities} capabilities - Project capabilities.
 * @param {ProjectCommands} commands - Project commands quoted by the hints.
 * @param {string[]} warnings - Warnings gathered so far.
 * @param {boolean} selectAllPackages - Whether the flags select every candidate without allowing skips.
 * @returns {MonorepoPlan} Plan.
 */
function planNewRelease(state, capabilities, commands, warnings, selectAllPackages) {
  const candidates = state.packages.filter((packageSnapshot) => packageSnapshot.unreleasedCommits.length > 0);
  const candidateNames = candidates.map((packageSnapshot) => packageSnapshot.unit.name);

  // Before the up-to-date check: the local checkout may not have the changes (or workspaces) origin already has.
  if (state.main.behindCount > 0) {
    return createPlan({
      mode: RELEASE_MODE.newRelease,
      steps: [
        {
          id: RELEASE_STEP.syncMain,
          title: `Actualizar ${MAIN_BRANCH} desde origin`,
          detail: `${state.main.behindCount} commit(s) nuevos. Después hay que volver a correr ${commands.createVersion}, que diagnostica con el código nuevo.`,
        },
      ],
      warnings,
      candidates: candidateNames,
    });
  }

  if (candidates.length === 0) {
    return createPlan({ mode: RELEASE_MODE.upToDate, warnings });
  }

  if (capabilities.checksMissing) {
    return createPlan({ blockers: [missingChecksBlocker(commands)] });
  }

  const unchangedChangelogs = candidates.filter(({ changelog }) => changelog.updated !== true);
  if (selectAllPackages && unchangedChangelogs.length > 0) {
    return createPlan({
      blockers: unchangedChangelogs.map(({ changelog, unit }) => ({
        code: CHANGELOG_UPDATE_REQUIRED_CODE,
        title: changelog.reason ?? `${unit.changelogPath} no fue actualizado desde el último release`,
        details: [`Actualizá ${unit.changelogPath} manualmente y volvé a correr ${commands.createVersion}; beez-rp no lo modifica.`],
      })),
      warnings,
    });
  }

  // The versions are chosen first: skipping every package must not leave migrations applied.
  /** @type {ReleasePlanStep[]} */
  const steps = [
    {
      id: MONOREPO_RELEASE_STEP.chooseVersions,
      title: `Elegir la versión de cada paquete con cambios (${candidates.length})`,
      detail: candidateNames.join(", "),
    },
    {
      id: MONOREPO_RELEASE_STEP.verifyChangelogs,
      title: "Verificar la actualización manual de los CHANGELOG elegidos",
      detail: "Cada uno debe haber cambiado desde su último release; su contenido se conserva sin reescribirlo.",
    },
  ];

  for (const { changelog, unit } of unchangedChangelogs) {
    warnings.push(`${changelog.reason ?? `${unit.changelogPath} no fue actualizado desde el último release`}; si elegís publicar ${unit.name}, el release se corta. Actualizalo manualmente.`);
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

  if (capabilities.checks) {
    steps.push({ id: RELEASE_STEP.runChecks, title: "Validar el proyecto", detail: "Corre los checks configurados antes de tocar las versiones." });
  }

  steps.push({
    id: MONOREPO_RELEASE_STEP.bumpPackages,
    title: "Crear el commit de release y un tag por paquete",
    detail: "Actualiza los package.json e incluye los CHANGELOG manuales sin modificar su contenido.",
  });

  if (capabilities.prepare) {
    steps.push({ id: RELEASE_STEP.prepareRelease, title: "Preparar el release", detail: "Corre la preparación configurada sobre el commit de release." });
  }

  steps.push({ id: MONOREPO_RELEASE_STEP.pushPackages, title: `Subir ${MAIN_BRANCH} y los tags a origin` });

  if (capabilities.publish) {
    steps.push({ id: MONOREPO_RELEASE_STEP.publishPackages, title: capabilities.publishTitle, detail: "En orden de dependencias entre los paquetes publicados." });
  }

  return createPlan({ mode: RELEASE_MODE.newRelease, steps, warnings, candidates: candidateNames });
}

/**
 * Stops a plan whose publications would fail on the npm credentials, or warns when they could not
 * be verified or a first publication cannot be told apart from a hidden private package.
 *
 * @param {MonorepoPlan} plan - Plan.
 * @param {MonorepoSnapshot} state - Snapshot, with the credentials of the packages to publish.
 * @param {ProjectCommands} commands - Project commands quoted by the fix.
 * @returns {MonorepoPlan} The same plan, blocked or with warnings when needed.
 */
function applyNpmAuth(plan, state, commands) {
  if (!plan.steps.some((planStep) => planStep.id === MONOREPO_RELEASE_STEP.publishPackages)) {
    return plan;
  }

  const blockers = [];
  const warnings = [...plan.warnings];

  for (const packageSnapshot of state.packages) {
    const { npmAuth, unit } = packageSnapshot;
    if (!npmAuth) {
      continue;
    }
    const problem = describeNpmAuthProblem(npmAuth, commands);
    if (problem) {
      blockers.push(problem);
    } else if (npmAuth.status === NPM_AUTH_STATUS.unknown) {
      warnings.push(`No se pudieron verificar las credenciales de ${npmAuth.registryLabel ?? "npm"} de ${unit.name}: ${npmAuth.reason ?? "motivo desconocido"}. Se intenta publicar igual.`);
    } else {
      const firstPublication = describeNpmFirstPublicationWarning(npmAuth);
      if (firstPublication) {
        warnings.push(firstPublication);
      }
    }
  }

  return blockers.length > 0 ? createPlan({ blockers }) : { ...plan, warnings };
}

/**
 * Names the packages whose npm credentials the diagnosis checks: the ones the plan could publish.
 *
 * @param {MonorepoPlan} plan - Plan built without credentials.
 * @returns {string[]} Package names.
 */
export function listPackagesToAuthenticate(plan) {
  if (!plan.steps.some((planStep) => planStep.id === MONOREPO_RELEASE_STEP.publishPackages)) {
    return [];
  }
  return plan.mode === RELEASE_MODE.resume ? plan.pendingReleases.filter((release) => release.publish).map((release) => release.name) : plan.candidates;
}

/**
 * Decides what is still missing to release the monorepo from `main`.
 *
 * @param {MonorepoSnapshot} state - Snapshot gathered by `collectMonorepoState`.
 * @param {ReleaseCapabilities} capabilities - Steps the project configured.
 * @param {{ tagFormat: string, ignoreLocalChanges?: boolean, skipUnpublished?: boolean, selectAllPackages?: boolean }} options -
 *   Tag format and command-line options. `skipUnpublished` allows a new release despite missing publications;
 *   `selectAllPackages` requires updated changelogs for every candidate because the flags do not allow skips.
 * @returns {MonorepoPlan} Ordered plan.
 */
export function buildMonorepoPlan(state, capabilities, { tagFormat, ignoreLocalChanges = false, skipUnpublished = false, selectAllPackages = false }) {
  const commands = capabilities.commands ?? DEFAULT_PROJECT_COMMANDS;
  const blockers = findBlockers(state, ignoreLocalChanges, commands);

  if (blockers.length > 0) {
    return createPlan({ blockers });
  }

  const localResume = planLocalResume(state, capabilities, tagFormat);
  const pending = localResume ? { plan: null, warnings: [] } : planPendingPublications(state, capabilities);
  const skipped = skipUnpublished && pending.plan ? pending.plan.pendingReleases.map(({ name, version, tag }) => describeSkippedPublication(name, version, tag, state.packages.find(({ unit }) => unit.name === name)?.npm?.registryLabel)) : [];
  const plan = localResume ?? (skipUnpublished ? null : pending.plan) ?? planNewRelease(state, capabilities, commands, [...pending.warnings, ...skipped], selectAllPackages);
  const withAuth = applyNpmAuth(plan, state, commands);
  // As in single-package mode: the configuration and the workspace manifests were already read from the
  // working tree, so code and data changes cannot be set aside.
  const codeChanges = ignoreLocalChanges && withAuth.steps.length > 0 ? listMonorepoChangesToSetAside(state, withAuth.mode).filter(isCodeChange) : [];

  if (codeChanges.length > 0) {
    return createPlan({ blockers: [codeChangesToSetAsideBlocker(codeChanges, commands)] });
  }

  const changelogPaths = new Set(state.packages.map(({ unit }) => unit.changelogPath));
  const dirtyChangelogs = state.workingTreeChanges.filter((line) => changesOneOf(line, changelogPaths));
  if (withAuth.mode === RELEASE_MODE.resume && ((!ignoreLocalChanges && state.workingTreeChanges.length > 0) || dirtyChangelogs.length > 0)) {
    return createPlan({
      blockers: [
        {
          title: "Hay cambios sin commitear y el release ya está commiteado",
          details: [
            ...state.workingTreeChanges.slice(0, MAX_LISTED_ITEMS),
            dirtyChangelogs.length > 0
              ? `Guardá manualmente los cambios del CHANGELOG (git stash) y volvé a correr ${commands.createVersion}; --${CREATE_VERSION_FLAG.ignoreLocalChanges} no lo aparta ni restaura.`
              : `Retomar un release usa los archivos de su commit: guardalos (git stash) y volvé a correr ${commands.createVersion}, o usá --${CREATE_VERSION_FLAG.ignoreLocalChanges}.`,
          ],
        },
      ],
    });
  }

  return withAuth;
}
