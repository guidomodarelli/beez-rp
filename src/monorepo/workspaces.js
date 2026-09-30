/**
 * Workspace discovery of the monorepo mode: which packages a repository
 * holds, which of them are released (every non-`private` one) and which paths
 * count as changes of each released package.
 *
 * A released package changes when its own directory changes, and also when a
 * `private` workspace package it depends on changes (transitively): internal
 * packages are usually bundled into their consumers (`noExternal`), so a fix
 * there ships only through a new release of each consumer.
 *
 * @module monorepo/workspaces
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CHANGELOG_FILE } from "../constants/changelog.js";
import { PACKAGE_MANIFEST_FILE, PUBLISHED_DEPENDENCY_FIELDS } from "../constants/create-version.js";
import {
  DEPENDENCY_FIELDS,
  TAG_FORMAT_PLACEHOLDER,
  WORKSPACE_EXCLUSION_PREFIX,
  WORKSPACE_WILDCARD_SUFFIX,
  WORKSPACES_PACKAGES,
} from "../constants/monorepo.js";
import { isPathInsideRoot } from "../create-version/config.js";
import { isStableReleaseVersion } from "../versions.js";

/**
 * @typedef {{
 *   name: string,
 *   directory: string,
 *   private: boolean,
 *   version: string | null,
 *   manifest: Record<string, unknown>,
 * }} WorkspacePackage
 *   `directory` is relative to the repository root, with `/` separators.
 * @typedef {{
 *   name: string,
 *   directory: string,
 *   component: string,
 *   manifestPath: string,
 *   changelogPath: string,
 *   version: string | null,
 *   changePaths: string[],
 *   publishedDependencies: string[],
 * }} ReleaseUnit
 *   A released package: `component` names its tag, `changePaths` are the Git pathspecs whose commits
 *   count as its changes (its own directory plus its private workspace dependencies, excluding the
 *   released packages nested inside it), `publishedDependencies`
 *   the released packages it installs (they are published first).
 */

/**
 * @param {string} relativePath - Path relative to the root.
 * @returns {string} Same path with `/` separators and no trailing slash.
 */
function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join("/").replace(/\/+$/u, "");
}

/**
 * Reads a JSON manifest without throwing.
 *
 * @param {string} manifestPath - Absolute path.
 * @returns {Record<string, unknown> | null} Manifest, or `null` when missing or invalid.
 */
function readManifest(manifestPath) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reads the manifest of a matched workspace directory.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} directory - Workspace directory relative to the root.
 * @returns {Record<string, unknown>} Manifest.
 * @throws {Error} When the manifest is not valid JSON or not an object.
 */
function readWorkspaceManifest(repositoryRoot, directory) {
  const manifestPath = `${directory}/${PACKAGE_MANIFEST_FILE}`;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(repositoryRoot, manifestPath), "utf8"));
  } catch (error) {
    throw new Error(`beez-rp create-version: no se pudo leer ${manifestPath}: ${error instanceof Error ? error.message : String(error)}; corregilo o excluí ese workspace`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`beez-rp create-version: ${manifestPath} no es un objeto JSON; corregilo o excluí ese workspace`);
  }
  return parsed;
}

/**
 * Reads the workspace patterns the root `package.json` declares (`workspaces` as a list, or as an
 * object with `packages`, as Yarn and Bun accept).
 *
 * @param {Record<string, unknown> | null} rootManifest - Root `package.json`.
 * @returns {string[]} Patterns.
 */
export function readDeclaredWorkspaces(rootManifest) {
  const workspaces = rootManifest?.workspaces;
  const patterns = Array.isArray(workspaces) ? workspaces : /** @type {{ packages?: unknown }} */ (workspaces ?? {}).packages;
  return Array.isArray(patterns) ? patterns.filter((pattern) => typeof pattern === "string") : [];
}

/**
 * Expands workspace patterns into package directories. Supported: exact directories
 * (`packages/cli`), direct children (`packages/*`) and exclusions (`!packages/internal`).
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {readonly string[]} patterns - Workspace patterns.
 * @returns {string[]} Directories relative to the root that hold a `package.json`, sorted.
 * @throws {Error} When a pattern escapes the repository or uses a glob beyond a trailing `/*`.
 */
export function expandWorkspacePatterns(repositoryRoot, patterns) {
  const included = new Set();
  const excluded = new Set();

  for (const rawPattern of patterns) {
    const isExclusion = rawPattern.startsWith(WORKSPACE_EXCLUSION_PREFIX);
    if (!isPathInsideRoot(isExclusion ? rawPattern.slice(WORKSPACE_EXCLUSION_PREFIX.length) : rawPattern)) {
      throw new Error(`beez-rp create-version: el patrón de workspace "${rawPattern}" sale del repositorio; usá rutas relativas a la raíz, sin ".." ni rutas absolutas`);
    }
    const pattern = toPosixPath(isExclusion ? rawPattern.slice(WORKSPACE_EXCLUSION_PREFIX.length) : rawPattern).replace(/^\.\//u, "");
    const base = pattern.endsWith(WORKSPACE_WILDCARD_SUFFIX) ? pattern.slice(0, -WORKSPACE_WILDCARD_SUFFIX.length) : pattern;

    if (/[*?{}[\]]/u.test(base)) {
      throw new Error(`beez-rp create-version: workspace pattern "${rawPattern}" is not supported; use exact directories or a trailing /*`);
    }

    const directories = pattern.endsWith(WORKSPACE_WILDCARD_SUFFIX)
      ? existsSync(path.join(repositoryRoot, base))
        ? readdirSync(path.join(repositoryRoot, base), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => `${base}/${entry.name}`)
        : []
      : [base];

    for (const directory of directories) {
      (isExclusion ? excluded : included).add(directory);
    }
  }

  return [...included]
    .filter((directory) => !excluded.has(directory) && existsSync(path.join(repositoryRoot, directory, PACKAGE_MANIFEST_FILE)))
    .toSorted();
}

/**
 * Lists the workspace packages of a repository.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {"workspaces" | readonly string[]} packages - `packages` of the configuration: the root workspaces, or explicit patterns.
 * @returns {WorkspacePackage[]} Packages with a `name` (private ones without it are skipped), sorted by directory.
 * @throws {Error} When a matched manifest is malformed, non-private without a `name` or without a stable `X.Y.Z` `version`, no package is found or two packages share a name.
 */
export function discoverWorkspacePackages(repositoryRoot, packages) {
  const patterns = packages === WORKSPACES_PACKAGES ? readDeclaredWorkspaces(readManifest(path.join(repositoryRoot, PACKAGE_MANIFEST_FILE))) : packages;
  const found = expandWorkspacePatterns(repositoryRoot, patterns).flatMap((directory) => {
    const manifest = readWorkspaceManifest(repositoryRoot, directory);
    if (typeof manifest.name !== "string" || manifest.name === "") {
      if (manifest.private === true) {
        return [];
      }
      throw new Error(`beez-rp create-version: ${directory}/${PACKAGE_MANIFEST_FILE} no tiene "name"; agregale un "name" para publicarlo, o "private": true (o excluí ese workspace) para omitirlo`);
    }
    if (manifest.private !== true && !isStableReleaseVersion(manifest.version)) {
      const currentVersion = manifest.version === undefined ? "no tiene \"version\"" : `tiene "version": ${JSON.stringify(manifest.version)}`;
      throw new Error(`beez-rp create-version: ${directory}/${PACKAGE_MANIFEST_FILE} ${currentVersion}; un paquete publicado necesita una versión estable X.Y.Z (por ejemplo "0.1.0"), o "private": true (o excluí ese workspace) para omitirlo`);
    }
    return [
      {
        name: manifest.name,
        directory,
        private: manifest.private === true,
        version: typeof manifest.version === "string" ? manifest.version : null,
        manifest,
      },
    ];
  });

  if (found.length === 0) {
    throw new Error(`beez-rp create-version: no workspace package found for packages ${JSON.stringify(packages)}`);
  }

  const seen = new Map();
  for (const workspacePackage of found) {
    if (seen.has(workspacePackage.name)) {
      throw new Error(`beez-rp create-version: ${workspacePackage.name} is declared in both ${seen.get(workspacePackage.name)} and ${workspacePackage.directory}`);
    }
    seen.set(workspacePackage.name, workspacePackage.directory);
  }

  return found;
}

/**
 * Names of the workspace packages a manifest depends on through the given fields.
 *
 * @param {Record<string, unknown>} manifest - Package manifest.
 * @param {readonly string[]} fields - Dependency fields to read.
 * @param {ReadonlySet<string>} workspaceNames - Names of every workspace package.
 * @returns {string[]} Workspace dependency names.
 */
function listWorkspaceDependencies(manifest, fields, workspaceNames) {
  return fields
    .flatMap((field) => Object.keys(/** @type {Record<string, unknown>} */ (manifest[field] ?? {})))
    .filter((dependencyName, index, all) => workspaceNames.has(dependencyName) && all.indexOf(dependencyName) === index);
}

/**
 * Turns the workspace packages into release units: one per non-`private` package.
 *
 * @param {readonly WorkspacePackage[]} workspacePackages - Result of {@link discoverWorkspacePackages}.
 * @returns {ReleaseUnit[]} Released packages, sorted by directory.
 */
export function resolveReleaseUnits(workspacePackages) {
  const byName = new Map(workspacePackages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  const workspaceNames = new Set(byName.keys());

  /**
   * Directories of the private packages `packageName` depends on, transitively.
   *
   * @param {string} packageName - Package whose private dependencies are collected.
   * @param {Set<string>} visited - Packages already walked (cycles).
   * @returns {string[]} Directories.
   */
  const privateDependencyDirectories = (packageName, visited) => {
    const workspacePackage = byName.get(packageName);
    if (!workspacePackage || visited.has(packageName)) {
      return [];
    }
    visited.add(packageName);
    return listWorkspaceDependencies(workspacePackage.manifest, DEPENDENCY_FIELDS, workspaceNames).flatMap((dependencyName) => {
      const dependency = /** @type {WorkspacePackage} */ (byName.get(dependencyName));
      return dependency.private ? [dependency.directory, ...privateDependencyDirectories(dependencyName, visited)] : [];
    });
  };

  /**
   * Git pathspecs whose commits count as changes of a package: its directory and its private
   * dependencies, minus the released packages nested inside its directory (they release their own commits).
   *
   * @param {WorkspacePackage} workspacePackage - Released package.
   * @param {string[]} dependencyDirectories - Directories of its private dependencies.
   * @returns {string[]} Git pathspecs.
   */
  const listChangePaths = (workspacePackage, dependencyDirectories) => {
    const nestedExclusions = workspacePackages
      .filter((nestedPackage) => !nestedPackage.private && nestedPackage.directory.startsWith(`${workspacePackage.directory}/`))
      .map((nestedPackage) => `:(exclude)${nestedPackage.directory}`);
    return [...new Set([workspacePackage.directory, ...dependencyDirectories]), ...nestedExclusions];
  };

  return workspacePackages
    .filter((workspacePackage) => !workspacePackage.private)
    .map((workspacePackage) => ({
      name: workspacePackage.name,
      directory: workspacePackage.directory,
      component: workspacePackage.directory.split("/").at(-1) ?? workspacePackage.directory,
      manifestPath: `${workspacePackage.directory}/${PACKAGE_MANIFEST_FILE}`,
      changelogPath: `${workspacePackage.directory}/${CHANGELOG_FILE}`,
      version: workspacePackage.version,
      changePaths: listChangePaths(workspacePackage, privateDependencyDirectories(workspacePackage.name, new Set())),
      publishedDependencies: listWorkspaceDependencies(workspacePackage.manifest, PUBLISHED_DEPENDENCY_FIELDS, workspaceNames).filter(
        (dependencyName) => byName.get(dependencyName)?.private === false
      ),
    }));
}

/**
 * Orders packages so every one comes after the released packages it installs.
 *
 * @template {{ name: string, publishedDependencies: string[] }} T
 * @param {readonly T[]} units - Packages to publish.
 * @returns {T[]} Same packages, dependencies first (stable for independent packages).
 */
export function sortByPublicationOrder(units) {
  const byName = new Map(units.map((unit) => [unit.name, unit]));
  /** @type {T[]} */
  const ordered = [];
  const placed = new Set();

  /** @param {T} unit - Package to place after its dependencies. @param {Set<string>} walk - Packages on the current walk (cycles). */
  const place = (unit, walk) => {
    if (placed.has(unit.name) || walk.has(unit.name)) {
      return;
    }
    walk.add(unit.name);
    for (const dependencyName of unit.publishedDependencies) {
      const dependency = byName.get(dependencyName);
      if (dependency) {
        place(dependency, walk);
      }
    }
    placed.add(unit.name);
    ordered.push(unit);
  };

  for (const unit of units) {
    place(unit, new Set());
  }
  return ordered;
}

/**
 * Builds the Git tag of a package release.
 *
 * @param {string} tagFormat - Format with `{version}` and optionally `{component}` / `{name}`.
 * @param {{ name: string, component: string }} unit - Released package.
 * @param {string} version - Released version.
 * @returns {string} Tag such as `widget-v1.2.0`.
 */
export function formatPackageTag(tagFormat, unit, version) {
  return tagFormat
    .replaceAll(TAG_FORMAT_PLACEHOLDER.version, version)
    .replaceAll(TAG_FORMAT_PLACEHOLDER.component, unit.component)
    .replaceAll(TAG_FORMAT_PLACEHOLDER.name, unit.name);
}
