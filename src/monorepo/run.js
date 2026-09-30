/**
 * Monorepo mode of `beez-rp create-version`: diagnoses every released
 * workspace package, shows the plan and ships one release commit with a tag
 * per package, then publishes each package in dependency order.
 *
 * It reuses the single-package steps that do not depend on the package
 * (sync of `main`, migrations, checks, local changes, npm credentials,
 * verified artifacts) and adds the per-package ones. Every step is derived
 * from the current state, so running the command again after a failure
 * resumes from the first missing step, including publications that npm never
 * received: each one is prepared and published from its own release commit.
 *
 * @module monorepo/run
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readUnreleased, releaseUnreleased } from "../changelog.js";
import { buildChangelogPrompt, runCodex } from "../changelog-ai.js";
import { CHANGE_TYPES, CHANGELOG_FILE, UNRELEASED_HEADING } from "../constants/changelog.js";
import { CODEX_NOT_FOUND_EXIT_CODE } from "../constants/changelog-ai.js";
import {
  CREATE_VERSION_FLAG,
  FAILURE_EXIT_CODE,
  GITHUB_REPOSITORY_PATTERN,
  MAIN_BRANCH,
  MAX_LISTED_ITEMS,
  NPM_LOOKUP_STATUS,
  NPM_PUBLISHER,
  NPM_TOKEN_LOCATIONS,
  NPM_TOKEN_VARIABLE,
  PACKAGE_MANIFEST_FILE,
  RELEASE_MODE,
  RELEASE_REGISTRY,
  RELEASE_REMOTE,
  RELEASE_STEP,
  SHORT_SHA_LENGTH,
  SUMMARY_VERSION_PLACEHOLDER,
  buildMainSyncedRestartMessage,
} from "../constants/create-version.js";
import { AUDIENCE_PACKAGE_PLACEHOLDER, MONOREPO_RELEASE_STEP, SKIP_PACKAGE_CHOICE, SUMMARY_PACKAGE_PLACEHOLDER } from "../constants/monorepo.js";
import { RELEASE_TYPE_ORDER } from "../constants/versions.js";
import { findPnpmPackRewrites, findPreparedArtifact, expandArtifactPattern, isSafeArtifactPath, verifyPreparedArtifact, withArtifactOutsidePackageRoot } from "../create-version/artifact.js";
import { ReleaseStepError } from "../create-version/errors.js";
import { restoreLocalChanges, setAsideLocalChanges } from "../create-version/local-changes.js";
import { buildNpmAuthConfigLine, checkNpmPublishAccess, describePublishedRelease, publishToNpm, readNpmPackIntegrity, resolvePublishRegistry } from "../create-version/npm.js";
import { describeNpmPublishFailure } from "../create-version/npm-auth.js";
import { createGitReader } from "../create-version/process.js";
import {
  MainSyncedRestartError,
  ReleaseCancelledError,
  applyMigrationsStep,
  askToIgnoreLocalChanges,
  assertNoTrackedChanges,
  checkPinnedNodeVersion,
  createHookContext,
  describeReleaseCapabilities,
  assertReleaseFilesMatchHead,
  commitReleaseFiles,
  prepareVersionFileUpdates,
  readReleaseFile,
  renderCommitList,
  renderNpmAuthRow,
  rewriteManifestVersion,
  renderPlan,
  runChecksStep,
  runConfiguredCommands,
  runGitStep,
  syncMainStep,
} from "../create-version/run.js";
import { BOX_TONE, ICON, formatDuration, measureActiveMs, paint, print, renderBanner, renderBox, renderRow, renderStepHeader, select, startSpinner } from "../terminal-ui.js";
import { bumpReleaseVersion, compareReleaseVersions, findHighestStableVersion, isStableReleaseVersion, suggestNextReleaseType } from "../versions.js";
import { buildMonorepoPlan, listMonorepoChangesToSetAside, listPackagesToAuthenticate } from "./plan.js";
import { buildMonorepoReleaseSubject } from "./release-commit.js";
import { collectMonorepoState } from "./state.js";
import { discoverWorkspacePackages, formatPackageTag, resolveReleaseUnits, sortByPublicationOrder } from "./workspaces.js";

/**
 * @typedef {import("./workspaces.js").ReleaseUnit} ReleaseUnit
 * @typedef {import("./state.js").MonorepoSnapshot} MonorepoSnapshot
 * @typedef {import("./state.js").PackageSnapshot} PackageSnapshot
 * @typedef {import("./plan.js").MonorepoPlan} MonorepoPlan
 * @typedef {import("./plan.js").PendingPackageRelease} PendingPackageRelease
 * @typedef {import("../create-version/config.js").ResolvedCreateVersionConfig} ResolvedCreateVersionConfig
 * @typedef {import("../create-version/plan.js").ReleaseOptions} ReleaseOptions
 * @typedef {import("../create-version/process.js").GitReader} GitReader
 * @typedef {{ unit: ReleaseUnit, snapshot: PackageSnapshot, version: string, tag: string, commitSha: string | null }} ChosenRelease
 *   A package going out in this run; `commitSha` is set once its release commit exists.
 * @typedef {{
 *   repositoryRoot: string,
 *   config: ResolvedCreateVersionConfig,
 *   state: MonorepoSnapshot,
 *   options: ReleaseOptions,
 *   reader: GitReader,
 *   commands: import("../package-manager.js").ProjectCommands,
 *   tagFormat: string,
 *   units: ReleaseUnit[],
 *   plan: MonorepoPlan,
 *   chosen: ChosenRelease[],
 *   preparedRoots: Set<string>,
 *   pushed: boolean,
 *   published: { name: string, version: string, registryUrl: string | null }[],
 * }} MonorepoContext
 */

/** Prefix of the temporary checkouts a publication prepares an older release commit in. */
const RELEASE_CHECKOUT_PREFIX = "beez-rp-release-";

/**
 * Renders the diagnosis: the repository rows plus one row per released package.
 *
 * @param {MonorepoSnapshot} state - Snapshot.
 * @param {string} repositoryRoot - Repository root.
 * @returns {string} Box.
 */
function renderMonorepoDiagnosis(state, repositoryRoot) {
  const { aheadCommits, behindCount } = state.main;
  const syncParts = [
    ...(behindCount > 0 ? [paint("yellow", `${behindCount} atrás`)] : []),
    ...(aheadCommits.length > 0 ? [paint("yellow", `${aheadCommits.length} adelante`)] : []),
  ];
  const rows = [
    state.currentBranch === MAIN_BRANCH ? renderRow(ICON.success, "Rama", MAIN_BRANCH) : renderRow(ICON.failure, "Rama", paint("red", state.currentBranch ?? "HEAD desacoplado")),
    renderRow(
      state.workingTreeChanges.length === 0 ? ICON.success : ICON.warning,
      "Working tree",
      state.workingTreeChanges.length === 0 ? "limpio" : paint("yellow", `${state.workingTreeChanges.length} cambio(s) sin commitear`)
    ),
    renderRow(syncParts.length > 0 ? ICON.warning : ICON.success, `${MAIN_BRANCH} ↔ origin`, syncParts.join(", ") || "al día"),
    "",
  ];

  for (const packageSnapshot of state.packages) {
    const { unit, lastRelease, unreleasedCommits, npm, changelog, npmAuth } = packageSnapshot;
    const released = lastRelease?.version ? paint("cyan", lastRelease.tag ?? lastRelease.version) : paint("gray", "sin releases");
    const pending = unreleasedCommits.length > 0 ? paint("yellow", `${unreleasedCommits.length} commit(s) sin publicar`) : "al día";
    const published = npm ? (npm.status === NPM_LOOKUP_STATUS.ok ? `npm ${npm.latestVersion ?? npm.publishedVersions.at(-1) ?? "—"}` : paint("red", "npm no respondió")) : null;
    const changelogNote = unreleasedCommits.length > 0 && changelog.entryCount === 0 ? paint("gray", "CHANGELOG vacío: lo completa Codex") : null;
    rows.push(
      renderRow(
        unreleasedCommits.length > 0 ? ICON.warning : ICON.success,
        unit.name,
        [released, pending, published, changelogNote].filter(Boolean).join(paint("gray", " · "))
      )
    );
    if (npmAuth) {
      rows.push(renderNpmAuthRow(npmAuth));
    }
  }

  if (state.migrations) {
    rows.push("", renderRow(state.migrations.status === "pending" ? ICON.warning : ICON.success, "Migraciones", state.migrations.status));
  }

  const node = checkPinnedNodeVersion(repositoryRoot);
  if (node) {
    rows.push(renderRow(node.matches ? ICON.success : ICON.warning, "Node.js", node.matches ? process.version : paint("yellow", `${process.version} (.nvmrc pide v${node.pinned})`)));
  }

  return renderBox({ title: "Diagnóstico · monorepo", lines: rows, tone: BOX_TONE.info });
}

/**
 * @param {MonorepoContext} context - Context.
 * @param {string} name - Package name.
 * @returns {PackageSnapshot} Snapshot of a released package.
 */
function requirePackage(context, name) {
  const packageSnapshot = context.state.packages.find((candidate) => candidate.unit.name === name);
  if (!packageSnapshot) {
    throw new ReleaseStepError(`${name} no es un paquete publicado de este monorepo.`, "Revisá packages en beez-rp.config.(m)js.");
  }
  return packageSnapshot;
}

/**
 * Reads the working-tree version of a package.
 *
 * @param {MonorepoContext} context - Context.
 * @param {ReleaseUnit} unit - Package.
 * @returns {string} Version.
 * @throws {ReleaseStepError} When it is not a stable `X.Y.Z` version.
 */
function readWorkingVersion(context, unit) {
  const version = JSON.parse(readFileSync(path.join(context.repositoryRoot, unit.manifestPath), "utf8")).version;
  if (!isStableReleaseVersion(version)) {
    throw new ReleaseStepError(`${unit.manifestPath} tiene la versión ${String(version)}, que no es X.Y.Z.`, `Corregila y volvé a correr ${context.commands.createVersion}.`);
  }
  return version;
}

/**
 * Checks, before anything is written, that the release tag of a package is a valid Git ref name and
 * does not exist locally, so `git tag` cannot fail after the release commit.
 *
 * @param {MonorepoContext} context - Context.
 * @param {string} tag - Tag the release would create.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When the tag is invalid or already exists.
 */
async function assertTagCanBeCreated(context, tag) {
  if ((await context.reader.tryGit(["check-ref-format", `refs/tags/${tag}`])) === null) {
    throw new ReleaseStepError(
      `El tag ${tag} no es un nombre de tag válido para Git (tagFormat "${context.tagFormat}").`,
      `No se escribió nada. Ajustá tagFormat o el nombre del paquete y volvé a correr ${context.commands.createVersion}.`
    );
  }
  if (await context.reader.tryGit(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])) {
    throw new ReleaseStepError(
      `El tag ${tag} ya existe en local.`,
      `No se escribió nada. Revisalo con git show ${tag}; si sobra, borralo con git tag -d ${tag} y volvé a correr ${context.commands.createVersion}.`
    );
  }
}

/**
 * Checks that the `[Unreleased]` block of every chosen package uses only valid sections, so a package
 * left out of the release never blocks the others. Empty blocks are filled by Codex later.
 *
 * @param {MonorepoContext} context - Context, with the chosen packages.
 * @returns {void}
 * @throws {ReleaseStepError} When a chosen changelog uses unknown sections.
 */
function assertChosenChangelogsAreValid(context) {
  const invalid = context.chosen
    .map(({ unit }) => ({ unit, unknownSections: readPackageUnreleased(path.join(context.repositoryRoot, unit.changelogPath)).unknownSections }))
    .filter(({ unknownSections }) => unknownSections.length > 0);

  if (invalid.length > 0) {
    throw new ReleaseStepError(
      `${invalid.map(({ unit, unknownSections }) => `${unit.changelogPath} ${UNRELEASED_HEADING} usa secciones no válidas: ${unknownSections.join(", ")}`).join("; ")}.`,
      `No se escribió nada. Usá solo ${CHANGE_TYPES.map((type) => `### ${type}`).join(", ")} (o elegí "No publicar ahora" para ese paquete) y volvé a correr ${context.commands.createVersion}.`
    );
  }
}

/**
 * Asks (or takes from the flags) the version of every package with changes; a package can be left
 * out of this release.
 *
 * @param {MonorepoContext} context - Context.
 * @returns {Promise<void>}
 */
async function chooseVersionsStep(context) {
  for (const name of context.plan.candidates) {
    const packageSnapshot = requirePackage(context, name);
    const { unit, unreleasedCommits } = packageSnapshot;
    const currentVersion = readWorkingVersion(context, unit);
    const suggestion = suggestNextReleaseType(unreleasedCommits, currentVersion, { preMajorShift: context.config.preMajorShift });
    print(renderCommitList(unreleasedCommits, `${unit.name} · ${unreleasedCommits.length} commit(s) sin publicar`));

    /** @type {string} */
    let choice;
    if (context.options.bump) {
      choice = context.options.bump;
    } else if (context.options.acceptSuggested) {
      choice = suggestion.releaseType;
    } else {
      choice = await select({
        message: `¿Qué versión de ${unit.name}? (actual ${currentVersion})`,
        options: [
          ...RELEASE_TYPE_ORDER.map((releaseType) => ({
            label: `${releaseType.padEnd(5)}  ${currentVersion} → ${bumpReleaseVersion(currentVersion, releaseType)}`,
            hint: releaseType === suggestion.releaseType ? `${ICON.star} sugerida: ${suggestion.reason}` : undefined,
            description: context.config.releaseTypeDescriptions[releaseType],
            value: releaseType,
          })),
          { label: "No publicar ahora", hint: "queda para un release siguiente", value: SKIP_PACKAGE_CHOICE },
        ],
        // Nothing is preselected so a stray Enter never ships a version.
        defaultIndex: null,
      });
    }

    if (choice === SKIP_PACKAGE_CHOICE) {
      print(`${ICON.info} ${unit.name} queda para otro release.`);
      continue;
    }

    const version = bumpReleaseVersion(currentVersion, /** @type {"patch" | "minor" | "major"} */ (choice));
    // As in single-package mode: a version not above the highest one on npm is either already
    // published or would move `latest` back.
    const highestPublished = findHighestStableVersion(packageSnapshot.npm?.publishedVersions ?? []);
    if (highestPublished && compareReleaseVersions(version, highestPublished) <= 0) {
      throw new ReleaseStepError(
        `${unit.name}@${version} no es mayor que ${highestPublished}, la versión más alta publicada en npm.`,
        `No se escribió nada. Llevá la versión de ${unit.manifestPath} a ${highestPublished} o elegí otro tipo de versión, y volvé a correr ${context.commands.createVersion}.`
      );
    }
    context.chosen.push({ unit, snapshot: packageSnapshot, version, tag: formatPackageTag(context.tagFormat, unit, version), commitSha: null });
    print(`${ICON.success} ${unit.name}: ${currentVersion} → ${paint(["bold", "cyan"], version)} (${choice})`);
  }

  const duplicatedTag = context.chosen.find((release, index) => context.chosen.findIndex(({ tag }) => tag === release.tag) !== index);
  if (duplicatedTag) {
    throw new ReleaseStepError(
      `Dos paquetes del release generan el mismo tag ${duplicatedTag.tag} (tagFormat "${context.tagFormat}").`,
      `No se escribió nada. Usá {name} en tagFormat, o carpetas de paquete con nombres distintos, y volvé a correr ${context.commands.createVersion}.`
    );
  }

  for (const { tag } of context.chosen) {
    await assertTagCanBeCreated(context, tag);
  }

  if (context.chosen.length === 0) {
    print(renderBox({ title: "Release cancelado", lines: [`${ICON.info} No elegiste ningún paquete: no se tocó nada.`], tone: BOX_TONE.info }));
    throw new ReleaseCancelledError();
  }

  assertChosenChangelogsAreValid(context);

  // Checked again before the commit; here it stops the release before migrations are applied.
  const versionFilesByPackage = await assertReleaseScope(context);
  for (const { unit, version } of context.chosen) {
    // Only validates: a missing, untracked or unmarked versionFiles entry stops the release before migrations.
    await prepareVersionFileUpdates(context, versionFilesByPackage.get(unit.name) ?? [], version);
  }
}

/**
 * Reads the `[Unreleased]` block of a package changelog.
 *
 * @param {string} changelogPath - Absolute path.
 * @returns {ReturnType<typeof readUnreleased>} Unreleased state.
 */
function readPackageUnreleased(changelogPath) {
  return existsSync(changelogPath) ? readUnreleased(readFileSync(changelogPath, "utf8")) : { exists: false, entryCount: 0, unknownSections: [], body: "" };
}

/**
 * Asks Codex to fill the empty `[Unreleased]` block of every chosen package, from its own commits.
 *
 * @param {MonorepoContext} context - Context.
 * @returns {Promise<void>}
 */
async function generateChangelogsStep(context) {
  const { audience, language } = context.config.changelog;

  for (const { unit, snapshot } of context.chosen) {
    const packageRoot = path.join(context.repositoryRoot, unit.directory);
    const changelogPath = path.join(packageRoot, CHANGELOG_FILE);

    if (readPackageUnreleased(changelogPath).entryCount > 0) {
      continue;
    }
    if (!existsSync(changelogPath)) {
      writeFileSync(changelogPath, `# Changelog\n\n${UNRELEASED_HEADING}\n`);
    }

    print(paint("gray", `Codex está escribiendo el CHANGELOG de ${unit.name}…`));
    const packageAudience = audience.replaceAll(AUDIENCE_PACKAGE_PLACEHOLDER, unit.name);
    const exitCode = await runCodex(packageRoot, buildChangelogPrompt(snapshot.unreleasedCommits, packageAudience, language));
    const unreleased = readPackageUnreleased(changelogPath);

    if (exitCode !== 0 || unreleased.entryCount === 0 || unreleased.unknownSections.length > 0) {
      const reason =
        exitCode === CODEX_NOT_FOUND_EXIT_CODE ? "no se encontró la CLI de Codex" : exitCode !== 0 ? `Codex terminó con código ${exitCode}` : "el bloque sigue vacío o con secciones no válidas";
      throw new ReleaseStepError(
        `No se pudo completar ${UNRELEASED_HEADING} de ${unit.changelogPath}: ${reason}.`,
        `Completalo (con la IA o a mano) usando ${CHANGE_TYPES.map((type) => `### ${type}`).join(", ")} y volvé a correr ${context.commands.createVersion}.`
      );
    }

    print(renderBox({ title: `${unit.changelogPath} · ${UNRELEASED_HEADING} (generado por Codex)`, lines: unreleased.body.split("\n"), tone: BOX_TONE.info }));
  }
}

/**
 * Assigns every `versionFiles` entry to the chosen package that contains it.
 *
 * @param {MonorepoContext} context - Context.
 * @returns {Map<string, string[]>} Files per package name.
 * @throws {ReleaseStepError} When an entry is outside every released package, or is the manifest or
 *   changelog of its package (the release commit already writes them).
 */
function groupVersionFilesByPackage(context) {
  /** @type {Map<string, string[]>} */
  const grouped = new Map();

  for (const filePath of context.config.versionFiles) {
    // With nested workspaces the file belongs to the deepest package that contains it.
    const owner = context.units
      .filter((unit) => filePath.startsWith(`${unit.directory}/`))
      .reduce((/** @type {typeof context.units[number] | undefined} */ closest, unit) => (closest && closest.directory.length >= unit.directory.length ? closest : unit), undefined);
    if (!owner) {
      throw new ReleaseStepError(
        `${filePath} (versionFiles) no está dentro de ningún paquete publicado.`,
        `En un monorepo cada archivo toma la versión del paquete que lo contiene: movelo o sacalo de versionFiles y volvé a correr ${context.commands.createVersion}.`
      );
    }
    if (filePath === owner.manifestPath || filePath === owner.changelogPath) {
      throw new ReleaseStepError(
        `${filePath} (versionFiles) es el package.json o el CHANGELOG.md de ${owner.name}: el commit de release ya lo escribe.`,
        `Sacalo de versionFiles en beez-rp.config.(m)js y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`
      );
    }
    grouped.set(owner.name, [...(grouped.get(owner.name) ?? []), filePath]);
  }

  return grouped;
}

/**
 * Lists the paths of a `git diff --name-only --no-renames -z` run: both sides of a rename count.
 *
 * @param {MonorepoContext} context - Context.
 * @param {string[]} diffArguments - Arguments after `git diff --name-only --no-renames -z`.
 * @returns {Promise<string[]>} Paths relative to the root.
 */
async function listDiffPaths(context, diffArguments) {
  return (await context.reader.git(["diff", "--name-only", "--no-renames", "-z", ...diffArguments])).split("\0").filter(Boolean);
}

/**
 * Stops the release before writing anything when the release commit would carry changes that are
 * not of the chosen packages: `git commit` takes the whole index, and the changelogs of every package
 * are allowed to stay uncommitted during the plan.
 *
 * @param {MonorepoContext} context - Context.
 * @param {ReadonlySet<string>} releasePaths - Manifests, changelogs and `versionFiles` of the chosen packages.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When something outside those files is staged, differs from `HEAD` or is untracked (and not ignored), or the changelog of a package left out has changes.
 */
async function assertOnlyReleaseChanges(context, releasePaths) {
  const foreignStaged = (await listDiffPaths(context, ["--cached"])).filter((filePath) => !releasePaths.has(filePath));
  if (foreignStaged.length > 0) {
    throw new ReleaseStepError(
      `Hay cambios staged que no son del release y entrarían en su commit: ${foreignStaged.slice(0, MAX_LISTED_ITEMS).join(", ")}.`,
      `No se escribió nada. Sacalos del índice con git restore --staged <archivo> (o commitealos aparte) y volvé a correr ${context.commands.createVersion}.`
    );
  }

  const chosenNames = new Set(context.chosen.map(({ unit }) => unit.name));
  const skippedChangelogs = new Set(context.units.filter((unit) => !chosenNames.has(unit.name)).map((unit) => unit.changelogPath));
  // `git diff HEAD` does not list untracked files, yet `npm publish` packs them from the package directory.
  const untrackedPaths = (await context.reader.git(["ls-files", "--others", "--exclude-standard", "-z"])).split(" ").filter(Boolean);
  const changedPaths = [...(await listDiffPaths(context, ["HEAD"])), ...untrackedPaths];
  const dirtySkippedChangelogs = changedPaths.filter((filePath) => skippedChangelogs.has(filePath));
  if (dirtySkippedChangelogs.length > 0) {
    throw new ReleaseStepError(
      `Hay cambios sin commitear en el CHANGELOG de paquetes que no salen en este release: ${dirtySkippedChangelogs.join(", ")}.`,
      `No se escribió nada. Commitealos aparte o guardalos con git stash, o elegí también esos paquetes, y volvé a correr ${context.commands.createVersion}.`
    );
  }

  // Unstaged changes (for example, a check that rewrites a file) stay out of the commit but not out of what gets published.
  // The plan blocks untracked files (or sets them aside with --ignore-local-changes), so an earlier step created these.
  const foreignUntracked = untrackedPaths.filter((filePath) => !releasePaths.has(filePath));
  if (foreignUntracked.length > 0) {
    throw new ReleaseStepError(
      `Un paso anterior (por ejemplo, un check) creó ${foreignUntracked.slice(0, MAX_LISTED_ITEMS).join(", ")}, que no son del release: quedarían fuera del commit pero se publicarían.`,
      `No se escribió nada. Revisá el check, borralos o agregalos a .gitignore, y volvé a correr ${context.commands.createVersion}.`
    );
  }

  const foreignChanged = changedPaths.filter((filePath) => !releasePaths.has(filePath));
  if (foreignChanged.length > 0) {
    throw new ReleaseStepError(
      `Un paso anterior (por ejemplo, un check) modificó ${foreignChanged.slice(0, MAX_LISTED_ITEMS).join(", ")}, que no son del release: se publicarían sin estar commiteados.`,
      `No se escribió nada. Revisá el check o commiteá esos cambios aparte, y volvé a correr ${context.commands.createVersion}.`
    );
  }
}

/**
 * Checks that only the files of the chosen packages would enter the release commit.
 *
 * @param {MonorepoContext} context - Context.
 * @returns {Promise<Map<string, string[]>>} `versionFiles` per package name.
 * @throws {ReleaseStepError} When a `versionFiles` entry has no package, or other changes would enter the commit.
 */
async function assertReleaseScope(context) {
  const versionFilesByPackage = groupVersionFilesByPackage(context);
  await assertOnlyReleaseChanges(
    context,
    new Set(context.chosen.flatMap(({ unit }) => [unit.manifestPath, unit.changelogPath, ...(versionFilesByPackage.get(unit.name) ?? [])]))
  );
  return versionFilesByPackage;
}

/**
 * Writes the new versions, releases every chosen changelog and creates the release commit with an
 * annotated tag per package. Every file is computed before anything is written, and the commit
 * reuses the single-package one: literal staging, rollback on failure and the prepared-tree check.
 *
 * @param {MonorepoContext} context - Context.
 * @returns {Promise<void>}
 */
async function bumpPackagesStep(context) {
  const today = new Date().toISOString().split("T")[0];
  const versionFilesByPackage = await assertReleaseScope(context);
  await assertReleaseFilesMatchHead(context, [...context.chosen.map(({ unit }) => unit.manifestPath), ...context.config.versionFiles]);
  /** @type {import("../create-version/run.js").ReleaseFileUpdate[]} */
  const releaseFiles = [];

  for (const { unit, version } of context.chosen) {
    const changelog = readReleaseFile(context, unit.changelogPath, unit.changelogPath);
    let releasedChangelog;

    try {
      releasedChangelog = releaseUnreleased(changelog.text, version, today);
    } catch (error) {
      throw new ReleaseStepError(
        `${unit.changelogPath} no está listo: ${error instanceof Error ? error.message : String(error)}`,
        `Completá ${UNRELEASED_HEADING} con ${CHANGE_TYPES.map((type) => `### ${type}`).join(", ")} y volvé a correr ${context.commands.createVersion}.`,
        { cause: error }
      );
    }

    const manifest = readReleaseFile(context, unit.manifestPath, unit.manifestPath);
    releaseFiles.push(
      { filePath: unit.manifestPath, originalBytes: manifest.originalBytes, content: rewriteManifestVersion(context, unit.manifestPath, manifest.text, version) },
      { filePath: unit.changelogPath, originalBytes: changelog.originalBytes, content: releasedChangelog },
      ...(await prepareVersionFileUpdates(context, versionFilesByPackage.get(unit.name) ?? [], version))
    );
  }

  const ordered = sortByPublicationOrder(context.chosen.map((release) => ({ ...release, name: release.unit.name, publishedDependencies: release.unit.publishedDependencies })));
  const subject = buildMonorepoReleaseSubject(ordered.map(({ name, version }) => ({ name, version })));
  await commitReleaseFiles(context, releaseFiles, subject);

  const commitSha = await context.reader.git(["rev-parse", "HEAD"]);
  for (const release of context.chosen) {
    await runGitStep(context, ["tag", "-a", release.tag, "-m", `${release.unit.name}@${release.version}`], `No se pudo crear el tag ${release.tag}`, `Si ya existe, revisalo con git show ${release.tag}.`);
    release.commitSha = commitSha;
  }

  print(`${ICON.success} Commit ${paint("bold", subject)} y ${context.chosen.length} tag(s) creados en local.`);
}

/**
 * Releases the run is finishing: the ones just created, or the pending ones of a resume.
 *
 * @param {MonorepoContext} context - Context.
 * @returns {PendingPackageRelease[]} Releases with their commit.
 */
function listRunReleases(context) {
  if (context.chosen.length > 0) {
    return context.chosen.map((release) => ({ name: release.unit.name, version: release.version, tag: release.tag, commitSha: release.commitSha ?? "", publish: true }));
  }
  return context.plan.pendingReleases;
}

/**
 * Runs the configured preparation once in a checkout, with the releases it covers.
 *
 * @param {MonorepoContext} context - Context.
 * @param {string} checkoutRoot - Directory to prepare (the repository, or a temporary release checkout).
 * @param {PendingPackageRelease[]} releases - Releases prepared there.
 * @returns {Promise<void>}
 */
async function prepareCheckout(context, checkoutRoot, releases) {
  const { prepare } = context.config;
  if (!prepare || context.preparedRoots.has(checkoutRoot)) {
    return;
  }

  const hint = `Corregí el error y volvé a correr ${context.commands.createVersion}, que retoma desde acá.`;
  if (Array.isArray(prepare)) {
    await runConfiguredCommands({ ...context, repositoryRoot: checkoutRoot }, prepare, hint);
  } else {
    const units = new Map(context.units.map((unit) => [unit.name, unit]));
    await prepare({
      ...createHookContext(checkoutRoot, createGitReader(checkoutRoot), null),
      releases: releases.map(({ name, version }) => ({ name, version, directory: units.get(name)?.directory ?? "" })),
    });
  }
  context.preparedRoots.add(checkoutRoot);
}

/**
 * Runs the preparation on the release commit (the plan step).
 *
 * @param {MonorepoContext} context - Context.
 * @returns {Promise<void>}
 */
async function prepareReleaseStep(context) {
  await prepareCheckout(context, context.repositoryRoot, listRunReleases(context));
}

/**
 * Pushes `main` and every release tag atomically, creating the tags a resumed release lacks.
 *
 * @param {MonorepoContext} context - Context.
 * @returns {Promise<void>}
 */
async function pushPackagesStep(context) {
  const releases = listRunReleases(context);

  for (const release of releases) {
    const taggedSha = await context.reader.tryGit(["rev-parse", "--verify", "--quiet", `refs/tags/${release.tag}^{commit}`]);
    if (taggedSha === null) {
      await runGitStep(context, ["tag", "-a", release.tag, "-m", `${release.name}@${release.version}`, release.commitSha], `No se pudo crear el tag ${release.tag}`, `Revisá git tag --list ${release.tag}.`);
    } else if (taggedSha !== release.commitSha) {
      throw new ReleaseStepError(
        `El tag local ${release.tag} apunta a ${taggedSha.slice(0, SHORT_SHA_LENGTH)} y el commit de release de ${release.name}@${release.version} es ${release.commitSha.slice(0, SHORT_SHA_LENGTH)}.`,
        `No se subió nada. Revisalo con git show ${release.tag}; si sobra, borralo con git tag -d ${release.tag} y volvé a correr ${context.commands.createVersion}.`
      );
    }
  }

  await runGitStep(
    context,
    ["push", "--atomic", RELEASE_REMOTE, MAIN_BRANCH, ...releases.map((release) => `refs/tags/${release.tag}`)],
    `El push de ${MAIN_BRANCH} y los tags falló`,
    `El release quedó en local: corregí el error y corré ${context.commands.createVersion}, que retoma el push.`
  );

  for (const release of releases) {
    if (!(await context.reader.tryGit(["ls-remote", "--tags", RELEASE_REMOTE, `refs/tags/${release.tag}`]))) {
      throw new ReleaseStepError(`${MAIN_BRANCH} se subió pero ${release.tag} no aparece en ${RELEASE_REMOTE}.`, `Subilo con git push ${RELEASE_REMOTE} ${release.tag}.`);
    }
  }

  context.pushed = true;
}

/**
 * Finds and verifies the prepared archive of a package when the project configured `artifact`
 * (the pattern is relative to the package directory).
 *
 * @param {MonorepoContext} context - Context.
 * @param {string} packageRoot - Package directory in the checkout.
 * @param {Record<string, unknown>} manifest - Package manifest.
 * @param {string} version - Version being published.
 * @returns {Promise<string | null>} Archive relative to the package directory, or `null` to publish the directory.
 */
async function resolvePackageArtifact(context, packageRoot, manifest, version) {
  const { artifact } = context.config;
  if (!artifact) {
    return null;
  }

  const release = { version, packageName: String(manifest.name) };
  const prepared = findPreparedArtifact(packageRoot, artifact, release);
  if (!prepared || !isSafeArtifactPath(prepared.path)) {
    throw new ReleaseStepError(`No hay un artefacto preparado de ${release.packageName}@${version} que coincida con ${expandArtifactPattern(artifact, release)}.`, `Revisá la preparación y volvé a correr ${context.commands.createVersion}.`);
  }

  const npmPack = await withArtifactOutsidePackageRoot(packageRoot, prepared.path, () => readNpmPackIntegrity(packageRoot));
  if (!npmPack.pack || npmPack.pack.version !== version) {
    throw new ReleaseStepError(`No se pudo verificar ${prepared.path} de ${release.packageName}: ${npmPack.problem ?? "npm pack describe otra versión"}.`, `No se publicó nada. Volvé a correr ${context.commands.createVersion}.`);
  }

  const problems = verifyPreparedArtifact(packageRoot, prepared, npmPack.pack.integrity);
  if (problems.length > 0) {
    throw new ReleaseStepError(`El artefacto ${prepared.path} de ${release.packageName} no se puede publicar: ${problems.join("; ")}.`, `No se publicó nada. Rearmalo con npm pack y volvé a correr ${context.commands.createVersion}.`);
  }

  return prepared.path;
}

/**
 * Publishes one package from a checkout, with npm or the project hook.
 *
 * @param {MonorepoContext} context - Context.
 * @param {string} checkoutRoot - Checkout holding the release commit.
 * @param {PendingPackageRelease} release - Release to publish.
 * @returns {Promise<void>}
 */
async function publishPackage(context, checkoutRoot, release) {
  const { unit } = requirePackage(context, release.name);
  const packageRoot = path.join(checkoutRoot, unit.directory);

  if (context.config.publish !== NPM_PUBLISHER) {
    await /** @type {import("../create-version/config.js").ReleaseHook} */ (context.config.publish)({
      ...createHookContext(checkoutRoot, createGitReader(checkoutRoot), release.version),
      releases: [{ name: release.name, version: release.version, directory: unit.directory }],
    });
    context.published.push({ name: release.name, version: release.version, registryUrl: null });
    return;
  }

  // npm publishes the checkout of the release commit: no tracked file may differ from it, and npm
  // would upload as they are the specifiers only pnpm rewrites when packing.
  await assertNoTrackedChanges({ reader: createGitReader(checkoutRoot), commands: context.commands });
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, PACKAGE_MANIFEST_FILE), "utf8"));
  if (manifest.name !== release.name) {
    throw new ReleaseStepError(
      `El commit de release ${release.tag} publica ${String(manifest.name)} desde ${unit.manifestPath}, pero el paquete ahora se llama ${release.name}.`,
      `No se publicó nada. Publicá ese release a mano con su nombre original, o dalo por descartado con --${CREATE_VERSION_FLAG.skipUnpublished}.`
    );
  }
  const rewrites = findPnpmPackRewrites(manifest);
  if (rewrites.length > 0) {
    throw new ReleaseStepError(`${release.name} depende de reescrituras del package manager al empaquetar: ${rewrites.join("; ")}.`, "No se publicó nada. Reemplazá workspace:/catalog:/jsr: por rangos de versión.");
  }

  let registryUrl;
  try {
    // Resolved in the repository, as the diagnosis did: a temporary release checkout lacks an untracked project .npmrc.
    registryUrl = await resolvePublishRegistry(manifest, context.repositoryRoot);
  } catch (error) {
    throw new ReleaseStepError(`No se puede publicar ${release.name}: ${error instanceof Error ? error.message : String(error)}.`, "Corregí el registry (publishConfig) y volvé a correr el comando.");
  }

  const artifactPath = await resolvePackageArtifact(context, packageRoot, manifest, release.version);
  const result = await publishToNpm(context.repositoryRoot, { authConfigLine: buildNpmAuthConfigLine(registryUrl), artifactPath, packageRoot, registryUrl });

  if (result.missingToken) {
    throw new ReleaseStepError(`Falta ${NPM_TOKEN_VARIABLE} para publicar ${release.name}@${release.version}.`, `Definilo en ${NPM_TOKEN_LOCATIONS} y corré ${context.commands.createVersion}: retoma solo lo que falta publicar.`);
  }

  if (result.exitCode !== 0) {
    const npmAuth = await checkNpmPublishAccess(release.name, context.repositoryRoot, registryUrl);
    const failure = describeNpmPublishFailure(npmAuth, { exitCode: result.exitCode, version: `${release.name}@${release.version}` }, context.commands);
    throw new ReleaseStepError(failure.message, failure.hint);
  }

  context.published.push({ name: release.name, version: release.version, registryUrl });
}

/**
 * Checks out a release commit in a temporary worktree (or uses the repository when `HEAD` is that
 * commit), runs an operation there and removes the worktree.
 *
 * @template T
 * @param {MonorepoContext} context - Context.
 * @param {string} commitSha - Release commit.
 * @param {(checkoutRoot: string) => Promise<T>} operation - Work done in the checkout.
 * @returns {Promise<T>} Operation result.
 */
async function withReleaseCheckout(context, commitSha, operation) {
  const headSha = await context.reader.git(["rev-parse", "HEAD"]);
  if (headSha === commitSha) {
    return operation(context.repositoryRoot);
  }

  const parentDirectory = mkdtempSync(path.join(os.tmpdir(), RELEASE_CHECKOUT_PREFIX));
  const checkoutRoot = path.join(parentDirectory, "checkout");
  await runGitStep(context, ["worktree", "add", "--quiet", "--detach", checkoutRoot, commitSha], `No se pudo preparar el commit ${commitSha.slice(0, SHORT_SHA_LENGTH)} en un worktree temporal`, "Revisá git worktree list.");

  try {
    return await operation(checkoutRoot);
  } finally {
    await context.reader.tryGit(["worktree", "remove", "--force", checkoutRoot]);
    rmSync(parentDirectory, { recursive: true, force: true });
  }
}

/**
 * Publishes every pending package in dependency order, each from its release commit.
 *
 * @param {MonorepoContext} context - Context.
 * @returns {Promise<void>}
 */
async function publishPackagesStep(context) {
  const releases = listRunReleases(context).filter((release) => release.publish);
  const units = new Map(context.units.map((unit) => [unit.name, unit]));
  const ordered = sortByPublicationOrder(releases.map((release) => ({ ...release, publishedDependencies: units.get(release.name)?.publishedDependencies ?? [] })));
  /** @type {Map<string, typeof ordered>} */
  const byCommit = new Map();
  for (const release of ordered) {
    byCommit.set(release.commitSha, [...(byCommit.get(release.commitSha) ?? []), release]);
  }

  for (const [commitSha, commitReleases] of byCommit) {
    await withReleaseCheckout(context, commitSha, async (checkoutRoot) => {
      await prepareCheckout(context, checkoutRoot, commitReleases);
      for (const release of commitReleases) {
        print(paint("gray", `Publicando ${release.name}@${release.version}…`));
        await publishPackage(context, checkoutRoot, release);
        print(`${ICON.success} ${release.name}@${release.version} publicado.`);
      }
    });
  }
}

/**
 * Executors of each plan step.
 *
 * @type {Record<string, (context: MonorepoContext) => Promise<void>>}
 */
const STEP_EXECUTORS = {
  [RELEASE_STEP.syncMain]: syncMainStep,
  [RELEASE_STEP.applyMigrations]: applyMigrationsStep,
  [RELEASE_STEP.runChecks]: runChecksStep,
  [RELEASE_STEP.prepareRelease]: prepareReleaseStep,
  [MONOREPO_RELEASE_STEP.chooseVersions]: chooseVersionsStep,
  [MONOREPO_RELEASE_STEP.generateChangelogs]: generateChangelogsStep,
  [MONOREPO_RELEASE_STEP.bumpPackages]: bumpPackagesStep,
  [MONOREPO_RELEASE_STEP.pushPackages]: pushPackagesStep,
  [MONOREPO_RELEASE_STEP.publishPackages]: publishPackagesStep,
};

/**
 * Renders the closing summary.
 *
 * @param {MonorepoContext} context - Context.
 * @param {string} remoteUrl - `origin` URL.
 * @param {number} startedAt - Start timestamp.
 * @returns {string} Box.
 */
function renderMonorepoSummary(context, remoteUrl, startedAt) {
  const releases = listRunReleases(context);
  const githubRepository = GITHUB_REPOSITORY_PATTERN.exec(remoteUrl)?.[1];
  const lines = releases.map((release) => {
    const published = context.published.find((entry) => entry.name === release.name);
    const npmNote = published?.registryUrl ? paint("gray", ` · ${describePublishedRelease({ registryUrl: published.registryUrl, packageName: release.name, version: release.version })}`) : "";
    return `${ICON.success} ${paint("bold", release.name)} ${paint(["bold", "greenBright"], release.version)} ${paint("gray", `(${release.tag})`)}${npmNote}`;
  });

  if (context.pushed) {
    lines.push("", `${ICON.success} ${paint("bold", "Git")}  ${MAIN_BRANCH} + ${releases.length} tag(s) en ${RELEASE_REMOTE}`);
  }
  if (githubRepository) {
    lines.push(`${ICON.info} ${paint("bold", "Tags")}  https://github.com/${githubRepository}/tags`);
  }
  for (const line of context.config.summary) {
    const perPackage = line.includes(SUMMARY_VERSION_PLACEHOLDER) || line.includes(SUMMARY_PACKAGE_PLACEHOLDER);
    const expanded = perPackage ? releases.map(({ name, version }) => line.replaceAll(SUMMARY_VERSION_PLACEHOLDER, version).replaceAll(SUMMARY_PACKAGE_PLACEHOLDER, name)) : [line];
    lines.push(...expanded.map((expandedLine) => `${ICON.info} ${expandedLine}`));
  }
  lines.push("", paint("gray", `Tiempo total: ${formatDuration(measureActiveMs(startedAt))} (sin contar la espera de tus respuestas)`));

  const outcome = context.published.length > 0 ? "publicados" : "releaseados (sin publicar)";
  return renderBox({ title: `${ICON.rocket} ${releases.length} paquete(s) ${outcome}`, lines, tone: BOX_TONE.success });
}

/**
 * Runs the plan steps in order and prints the outcome.
 *
 * @param {MonorepoContext} context - Context.
 * @param {string} remoteUrl - `origin` URL.
 * @param {number} startedAt - Start timestamp.
 * @returns {Promise<number>} Exit code.
 */
async function runPlanSteps(context, remoteUrl, startedAt) {
  const { steps } = context.plan;

  for (const [index, planStep] of steps.entries()) {
    print(renderStepHeader(index + 1, steps.length, planStep.title));

    try {
      await STEP_EXECUTORS[planStep.id](context);
    } catch (error) {
      if (error instanceof ReleaseCancelledError) {
        return 0;
      }
      if (error instanceof MainSyncedRestartError) {
        print(
          renderBox({
            title: `${MAIN_BRANCH} actualizado`,
            lines: [`${ICON.info} ${buildMainSyncedRestartMessage(context.commands.createVersion)}`, "", paint("gray", "No se tocaron versiones ni tags.")],
            tone: BOX_TONE.info,
          })
        );
        return 0;
      }

      const lines = [`${ICON.failure} ${error instanceof Error ? error.message : String(error)}`];
      if (error instanceof ReleaseStepError) {
        lines.push("", `${paint("bold", "Qué hacer:")} ${error.hint}`);
      }
      if (context.published.length > 0) {
        lines.push("", `${ICON.warning} Ya se publicaron: ${context.published.map(({ name, version }) => `${name}@${version}`).join(", ")}.`);
      }
      lines.push("", paint("gray", `${context.commands.createVersion} retoma desde el primer paso que falte.`));
      print(renderBox({ title: `Falló el paso ${index + 1}: ${planStep.title}`, lines, tone: BOX_TONE.danger }));
      return FAILURE_EXIT_CODE;
    }
  }

  print("");
  print(
    context.pushed || context.published.length > 0
      ? renderMonorepoSummary(context, remoteUrl, startedAt)
      : renderBox({ title: "Listo", lines: [`${ICON.success} Plan completado en ${formatDuration(measureActiveMs(startedAt))}.`], tone: BOX_TONE.success })
  );
  return 0;
}

/**
 * Runs `create-version` in monorepo mode (`packages` in the configuration).
 *
 * @param {{
 *   repositoryRoot: string,
 *   config: ResolvedCreateVersionConfig,
 *   options: ReleaseOptions,
 *   startedAt: number,
 * }} run - Repository, resolved configuration, command-line options and start time.
 * @returns {Promise<number>} Exit code.
 */
export async function runMonorepoCreateVersion({ repositoryRoot, config, options: initialOptions, startedAt }) {
  let options = initialOptions;
  const commands = config.commands;
  const tagFormat = /** @type {string} */ (config.tagFormat);

  if (options.setVersion) {
    print(`${ICON.failure} ${paint("red", `En un monorepo cada paquete tiene su versión: usá --${CREATE_VERSION_FLAG.bump} (para todos) o --${CREATE_VERSION_FLAG.acceptSuggested}.`)}`);
    return FAILURE_EXIT_CODE;
  }

  let units;
  try {
    units = resolveReleaseUnits(discoverWorkspacePackages(repositoryRoot, /** @type {"workspaces" | string[]} */ (config.packages)));
  } catch (error) {
    print(`${ICON.failure} ${paint("red", error instanceof Error ? error.message : String(error))}`);
    return FAILURE_EXIT_CODE;
  }

  if (units.length === 0) {
    print(`${ICON.failure} ${paint("red", "No hay paquetes para publicar: todos los workspaces son private.")}`);
    return FAILURE_EXIT_CODE;
  }

  const reader = createGitReader(repositoryRoot);
  const remoteUrl = (await reader.tryGit(["remote", "get-url", RELEASE_REMOTE])) ?? "";
  const capabilities = describeReleaseCapabilities(config);
  const { migrations } = config;
  const spinner = startSpinner("Diagnosticando el monorepo");
  let state;

  try {
    state = await collectMonorepoState({
      repositoryRoot,
      units,
      tagFormat,
      trackNpm: config.registry === RELEASE_REGISTRY.npm,
      checkMigrations: migrations ? () => migrations.check(createHookContext(repositoryRoot, reader, null)) : null,
      checkNpmAuthFor: (snapshot) =>
        config.publish === NPM_PUBLISHER ? listPackagesToAuthenticate(buildMonorepoPlan(snapshot, capabilities, { tagFormat, ignoreLocalChanges: true, skipUnpublished: options.skipUnpublished })) : [],
      onProgress: (label) => spinner.update(label),
    });
    spinner.succeed("Diagnóstico completo");
  } catch (error) {
    spinner.fail("No se pudo diagnosticar el monorepo");
    print(paint("red", error instanceof Error ? error.message : String(error)));
    return FAILURE_EXIT_CODE;
  }

  const rootName = (() => {
    try {
      return String(JSON.parse(readFileSync(path.join(repositoryRoot, PACKAGE_MANIFEST_FILE), "utf8")).name ?? "monorepo");
    } catch {
      return "monorepo";
    }
  })();
  print(renderBanner({ projectName: config.projectName ?? rootName, publishedLabel: `${units.length} paquete(s)` }));
  print(renderMonorepoDiagnosis(state, repositoryRoot));

  let plan = buildMonorepoPlan(state, capabilities, { tagFormat, ignoreLocalChanges: options.ignoreLocalChanges, skipUnpublished: options.skipUnpublished });

  if (plan.blockers.length > 0 && !options.ignoreLocalChanges && !options.dryRun && process.stdin.isTTY) {
    const planIgnoringChanges = buildMonorepoPlan(state, capabilities, { tagFormat, ignoreLocalChanges: true, skipUnpublished: options.skipUnpublished });
    if (planIgnoringChanges.blockers.length === 0 && planIgnoringChanges.steps.length > 0) {
      if (!(await askToIgnoreLocalChanges(listMonorepoChangesToSetAside(state, planIgnoringChanges.mode)))) {
        print(`${ICON.info} Release cancelado: no se tocó nada. Commiteá o guardá los cambios y volvé a correr ${commands.createVersion}.`);
        return 0;
      }
      options = { ...options, ignoreLocalChanges: true };
      plan = planIgnoringChanges;
    }
  }

  if (plan.mode === RELEASE_MODE.upToDate) {
    print(renderBox({ title: "Todo al día", lines: [`${ICON.success} Ningún paquete tiene cambios sin publicar.`, ...plan.warnings.map((warning) => `${ICON.warning} ${warning}`)], tone: BOX_TONE.success }));
    return 0;
  }

  print(renderPlan(plan));

  if (plan.blockers.length > 0) {
    return 0;
  }

  if (options.dryRun) {
    print(`${ICON.info} ${paint("cyan", `--dry-run: no se cambió nada. Corré ${commands.createVersion} para ejecutar el plan.`)}`);
    return 0;
  }

  if (plan.steps.some((planStep) => planStep.id === MONOREPO_RELEASE_STEP.chooseVersions) && !options.bump && !options.acceptSuggested && !process.stdin.isTTY) {
    print(`${ICON.failure} ${paint("red", `Sin terminal interactiva no se puede elegir la versión de cada paquete: usá --${CREATE_VERSION_FLAG.bump} patch|minor|major o --${CREATE_VERSION_FLAG.acceptSuggested}.`)}`);
    return FAILURE_EXIT_CODE;
  }

  /** @type {MonorepoContext} */
  const context = {
    repositoryRoot,
    config,
    state,
    options,
    reader,
    commands,
    tagFormat,
    units,
    plan,
    chosen: [],
    preparedRoots: new Set(),
    pushed: false,
    published: [],
  };

  const changesToSetAside = options.ignoreLocalChanges ? listMonorepoChangesToSetAside(state, plan.mode) : [];
  let setAside = null;

  if (changesToSetAside.length > 0) {
    try {
      setAside = await setAsideLocalChanges(reader, {
        keptPaths: plan.mode === RELEASE_MODE.newRelease ? units.map((unit) => unit.changelogPath) : [],
        createVersionCommand: commands.createVersion,
      });
    } catch (error) {
      const hint = error instanceof ReleaseStepError ? ` ${error.hint}` : "";
      print(`${ICON.failure} ${paint("red", `${error instanceof Error ? error.message : String(error)}${hint}`)}`);
      return FAILURE_EXIT_CODE;
    }
    print(`${ICON.info} ${changesToSetAside.length} cambio(s) sin commitear apartados con git stash; al terminar vuelven igual.`);
  }

  try {
    return await runPlanSteps(context, remoteUrl, startedAt);
  } finally {
    if (setAside) {
      const restore = await restoreLocalChanges(reader, repositoryRoot, setAside);
      print(
        restore.restored
          ? `${ICON.success} Cambios sin commitear restaurados como estaban.`
          : `${ICON.warning} ${paint("yellow", `No se pudieron restaurar los cambios sin commitear (${restore.reason}): recuperalos con git stash pop --index.`)}`
      );
    }
  }
}
