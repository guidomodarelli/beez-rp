/**
 * Module trace of `create-version`: the synchronous module hook (`module.registerHooks`) that
 * records every import edge this process resolves, read later by `config-modules.js` to know which
 * files the configuration loaded.
 *
 * This module must not import anything from beez-rp nor from the released repository, only Node
 * built-ins: the CLI imports it before anything else and starts the trace before loading any other
 * module, and a module Node resolved before the hook existed never shows up again, nor do its
 * imports. When beez-rp releases its own checkout, any beez-rp module imported from here (even a
 * file of constants) would load untraced and hide its own imports from the graph. That is why the
 * few literals below live here instead of in `src/constants/`.
 *
 * @module create-version/module-trace-bootstrap
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * URL scheme of the modules loaded from a file. Kept here, not in `src/constants/`, because this
 * bootstrap cannot import repository modules (see the module description).
 */
const FILE_URL_SCHEME = "file:";

/** Prefixes of a relative specifier (`./x.js`, `../x.js`), resolved against the importing module. */
const RELATIVE_SPECIFIER_PREFIXES = Object.freeze(["./", "../"]);

/**
 * Directory of installed dependencies, whose modules are never checked against the tracked files.
 * Same value as `NODE_MODULES_DIRECTORY` of `src/constants/create-version.js`, kept here because
 * this bootstrap cannot import repository modules (see the module description).
 */
const NODE_MODULES_DIRECTORY = "node_modules";

/** Git executable, run to hash a module that loads for the first time while the guard is active. */
const GIT_EXECUTABLE = "git";

/** Segment of a relative path that leaves its base directory. */
const PARENT_DIRECTORY_SEGMENT = "..";

/**
 * Canonical root of the running beez-rp package (two levels above this file): the run loads
 * beez-rp's own modules, which are not part of the released repository (unless it is beez-rp's own
 * checkout).
 */
const BEEZ_RP_PACKAGE_ROOT = realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * @typedef {{ moduleUrlsByParent: Map<string, Set<string>>, requestedUrlsByParent: Map<string, Set<string>>, aliasedModuleUrlsByParent: Map<string, Set<string>>, moduleUrlByRequestedUrl: Map<string, string> }} ModuleTrace
 *   Import edges of this process, keyed by the URL of the importing module: the URLs of the modules
 *   each one resolved (any scheme, such as `file:` with their real path, where Node loads them, or
 *   `data:`), the `file:` URLs its specifiers named before Node followed symbolic links, and the
 *   `file:` modules it reached through a specifier that is not a file path (a `#alias` of the
 *   `imports` field of `package.json`, or a package name), whose path before Node followed
 *   symbolic links is unknown; plus the module each requested path resolved to. The edges are kept for the whole process (Node
 *   never resolves a cached module again), and each configuration only walks the ones reachable
 *   from its own file, so loading the configuration of another repository in the same process does
 *   not mix both graphs.
 * @typedef {{ trace: ModuleTrace, startedExplicitly: boolean }} ModuleTraceState
 *   `startedExplicitly` tells whether {@link startTracingConfigModules} started the trace, instead
 *   of {@link ensureTracingConfigModules} right before loading the configuration.
 */

/** Trace of this process; `null` until the first start. */
/** @type {ModuleTraceState | null} */
let moduleTraceState = null;

/**
 * @typedef {{ repositoryRoots: string[], canonicalRoot: string, committedBlobIdByPath: Map<string, string>, inspectedModuleUrls: Set<string> }} LateModuleGuard
 *   Roots of the repository (as given and its real path); the tracked paths (relative to the root,
 *   separated with `/`) whose working-tree file was safe to load when the guard started (identical
 *   to `HEAD`, without a `filter` attribute nor an index flag that hides its changes), with their
 *   committed blob id; and the URLs of the modules of the configuration graph, which the inspection
 *   before the release steps already compared with `HEAD` and Node never reads again. Any other
 *   module this process already loaded (outside that graph) was never inspected, so it goes through
 *   the whole check even when Node would take it from its cache.
 */

/** Guard active while the release steps run; `null` while modules load freely. */
/** @type {LateModuleGuard | null} */
let lateModuleGuard = null;

/**
 * Tells whether a directory contains a path (below it or the directory itself).
 *
 * @param {string} directory - Directory.
 * @param {string} filePath - Path to check.
 * @returns {boolean} `true` when `filePath` does not leave `directory`.
 */
function isInsideDirectory(directory, filePath) {
  const relativePath = path.relative(directory, filePath);
  return relativePath.split(path.sep)[0] !== PARENT_DIRECTORY_SEGMENT && !path.isAbsolute(relativePath);
}

/**
 * Tells whether a module outside the released repository may run in the release: only installed
 * dependencies (a path inside a `node_modules` directory, at any level) and beez-rp itself. Any
 * other outside file cannot be compared with `HEAD`. The inspection before the release steps and
 * the guard of the modules the steps load for the first time share this rule.
 *
 * @param {string} canonicalPath - Real path of the module, outside the repository.
 * @returns {boolean} `true` for an installed dependency or a beez-rp module.
 */
export function isAllowedExternalModule(canonicalPath) {
  return canonicalPath.split(path.sep).includes(NODE_MODULES_DIRECTORY) || isInsideDirectory(BEEZ_RP_PACKAGE_ROOT, canonicalPath);
}

/**
 * Finds the repository-relative path (separated with `/`) a requested path names, under any of
 * the repository roots.
 *
 * @param {string[]} repositoryRoots - Roots of the repository.
 * @param {string} requestedPath - Path a specifier named, before Node followed symbolic links.
 * @returns {string | null} Repository path, or `null` outside every root.
 */
function toRepositoryPath(repositoryRoots, requestedPath) {
  const containingRoot = repositoryRoots.find((root) => isInsideDirectory(root, requestedPath));
  return containingRoot === undefined ? null : path.relative(containingRoot, requestedPath).split(path.sep).join("/");
}

/**
 * Hashes a working-tree file as `git add` would store it (line endings normalized; the guarded
 * files have no `filter` attribute), to compare it with its committed blob.
 *
 * @param {string} repositoryRoot - Canonical repository root.
 * @param {string} repositoryPath - Path relative to the root, separated with `/`.
 * @returns {string} Blob id of the current working-tree content.
 * @throws {Error} When `git hash-object` fails, with the Git error as `cause`.
 */
function hashWorkingTreeFile(repositoryRoot, repositoryPath) {
  try {
    return execFileSync(GIT_EXECUTABLE, ["hash-object", "--", repositoryPath], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(`beez-rp no pudo comparar ${repositoryPath} con HEAD antes de cargarlo durante el release (git hash-object falló en ${repositoryRoot}).`, { cause: error });
  }
}

/**
 * Stops a module a step resolves while the guard is active (loaded for the first time, or taken from
 * the cache outside the inspected graph) unless the inspection before the release steps would have
 * let it run: a repository module (outside `node_modules`)
 * must be one of the clean tracked files, named by its own full path (no symbolic link on the way,
 * no added extension, folder index nor `#alias`) whose content still hashes to its committed blob
 * (an earlier step, such as a check or a hook, may have rewritten it after the guard started), and
 * a module outside the repository must pass
 * {@link isAllowedExternalModule}. Only a module of the inspected configuration graph skips it,
 * even if Node already cached any other one. A hook that imports a helper only when it runs would otherwise
 * run bytes nobody compared with `HEAD`. Throwing from the resolution keeps Node from evaluating it.
 *
 * @param {string} moduleUrl - URL Node resolved, with the real path of a file.
 * @param {string | null} requestedUrl - `file:` URL the specifier named, or `null` when it is not a file path.
 * @throws {Error} When the active guard does not allow the module.
 */
function requireAllowedLateModule(moduleUrl, requestedUrl) {
  if (!lateModuleGuard || !moduleUrl.startsWith(FILE_URL_SCHEME) || lateModuleGuard.inspectedModuleUrls.has(moduleUrl)) {
    return;
  }

  const modulePath = fileURLToPath(moduleUrl);

  if (!isInsideDirectory(lateModuleGuard.canonicalRoot, modulePath)) {
    if (isAllowedExternalModule(modulePath)) {
      return;
    }
    throw new Error(
      `beez-rp no carga ${modulePath} durante el release: está fuera del repositorio y no es una dependencia instalada (node_modules) ni parte de beez-rp, así que no se puede comparar con HEAD. Movelo al repositorio y commitealo (o instalalo como dependencia), o dejá de importarlo desde los hooks de beez-rp.config.(m)js, y volvé a correr el release.`
    );
  }

  const repositoryPath = path.relative(lateModuleGuard.canonicalRoot, modulePath).split(path.sep).join("/");

  if (repositoryPath.split("/").includes(NODE_MODULES_DIRECTORY)) {
    return;
  }

  const namedPath = requestedUrl ? toRepositoryPath(lateModuleGuard.repositoryRoots, fileURLToPath(requestedUrl)) : null;

  const committedBlobId = lateModuleGuard.committedBlobIdByPath.get(repositoryPath);

  if (namedPath !== repositoryPath || committedBlobId === undefined) {
    throw new Error(
      `beez-rp no carga ${repositoryPath} durante el release: solo corren archivos trackeados idénticos a HEAD, sin atributo filter ni marca skip-worktree o assume-unchanged, importados por su ruta relativa completa (sin enlaces simbólicos, extensión implícita ni alias #…). Commitealo tal cual en una rama y llevalo a main (o quitale el filter o la marca, o importalo por su ruta real), o dejá de importarlo desde los hooks de beez-rp.config.(m)js, y volvé a correr el release.`
    );
  }

  if (hashWorkingTreeFile(lateModuleGuard.canonicalRoot, repositoryPath) !== committedBlobId) {
    throw new Error(
      `beez-rp no carga ${repositoryPath} durante el release: cambió después de empezar los pasos del release (lo reescribió un check o un hook anterior), así que ya no es idéntico a HEAD. Hacé que los checks y hooks de beez-rp.config.(m)js no modifiquen ese archivo (o commiteá el resultado en una rama y llevalo a main), restaurá su contenido con git restore -- ${repositoryPath} y volvé a correr el release.`
    );
  }
}

/**
 * Resolves a specifier to the `file:` URL it names before Node follows symbolic links.
 *
 * @param {string} specifier - Specifier as written in the `import` or `require`.
 * @param {string | undefined} parentUrl - URL of the importing module.
 * @returns {string | null} Requested URL, or `null` when the specifier is not a file path (a
 *   package, a built-in, a `data:` module).
 */
function toRequestedUrl(specifier, parentUrl) {
  try {
    if (specifier.startsWith(FILE_URL_SCHEME)) {
      return new URL(specifier).href;
    }
    if (path.isAbsolute(specifier)) {
      return pathToFileURL(specifier).href;
    }
    if (RELATIVE_SPECIFIER_PREFIXES.some((prefix) => specifier.startsWith(prefix)) && parentUrl?.startsWith(FILE_URL_SCHEME)) {
      return new URL(specifier, parentUrl).href;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Adds a value to the set of a key, creating the set on first use.
 *
 * @param {Map<string, Set<string>>} groups - Sets by key.
 * @param {string} key - Key.
 * @param {string} value - Value to add.
 */
function addToGroup(groups, key, value) {
  const group = groups.get(key) ?? new Set();
  group.add(value);
  groups.set(key, group);
}

/**
 * Registers the module hook of this process, once: later calls keep the same trace.
 *
 * @param {boolean} startedExplicitly - Whether the caller starts it before importing repository code.
 */
function startModuleTrace(startedExplicitly) {
  if (moduleTraceState || typeof module.registerHooks !== "function") {
    return;
  }

  /** @type {ModuleTrace} */
  const trace = { moduleUrlsByParent: new Map(), requestedUrlsByParent: new Map(), aliasedModuleUrlsByParent: new Map(), moduleUrlByRequestedUrl: new Map() };
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolution = nextResolve(specifier, context);
      const requestedUrl = toRequestedUrl(specifier, context.parentURL);
      requireAllowedLateModule(resolution.url, requestedUrl);
      const parentUrl = context.parentURL ?? "";
      // Every edge is kept, whatever its scheme: a `data:` module can import a repository file by
      // its `file:` URL, and that file is only reachable through it.
      addToGroup(trace.moduleUrlsByParent, parentUrl, resolution.url);

      if (requestedUrl) {
        addToGroup(trace.requestedUrlsByParent, parentUrl, requestedUrl);
        trace.moduleUrlByRequestedUrl.set(requestedUrl, resolution.url);
      } else if (resolution.url.startsWith(FILE_URL_SCHEME)) {
        addToGroup(trace.aliasedModuleUrlsByParent, parentUrl, resolution.url);
      }
      return resolution;
    },
  });
  moduleTraceState = { trace, startedExplicitly };
}

/**
 * Starts recording the modules this process resolves, once per process: later calls keep the same
 * trace. Custom tooling that calls `runCreateVersion` or `loadCreateVersionConfig` must import it
 * from `beez-rp/module-trace` and call it first, before importing `beez-rp/create-version` (whose
 * modules would otherwise load untraced when beez-rp releases itself) or any code of the repository
 * it releases (the CLI already does, before
 * importing any other module): a module Node already cached is never resolved again, so neither it
 * nor what it imports would reach the graph, and the plan refuses `--ignore-local-changes` when the
 * trace did not start here. Without `module.registerHooks` (Node before 22.15) nothing is recorded
 * and `listConfigModules` says why.
 */
export function startTracingConfigModules() {
  startModuleTrace(true);
}

/**
 * Starts the trace when nobody started it yet, as `loadCreateVersionConfig` does right before
 * importing the configuration. A trace started here is not explicit: code of the repository
 * imported before it may be missing from the graph.
 */
export function ensureTracingConfigModules() {
  startModuleTrace(false);
}

/**
 * Makes the module hook reject, until {@link liftLateModuleGuard}, every module a step resolves
 * (outside the inspected configuration graph) that the inspection before the release steps would not allow (see
 * {@link requireAllowedLateModule}). The run calls it after its last comparison of the loaded
 * modules with `HEAD` and after setting local changes aside, right before the release steps run
 * configuration code (hooks, `migrations.apply`) that may import more modules. Without
 * `module.registerHooks` nothing is checked, but the plan already blocks such a run.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {Map<string, string>} committedBlobIdByPath - Committed blob id of each tracked path safe to
 *   load (identical to `HEAD`, without a `filter` attribute nor index flags), keyed by its path
 *   relative to the root and separated with `/`.
 * @param {Iterable<string>} inspectedModuleUrls - URLs of the modules of the configuration graph
 *   that the inspection before the release steps compared with `HEAD` (or allowed as installed
 *   dependencies or beez-rp itself): the only already loaded modules that skip the check.
 */
export function guardLateModules(repositoryRoot, committedBlobIdByPath, inspectedModuleUrls) {
  const canonicalRoot = realpathSync.native(repositoryRoot);
  lateModuleGuard = { repositoryRoots: [...new Set([path.resolve(repositoryRoot), canonicalRoot])], canonicalRoot, committedBlobIdByPath, inspectedModuleUrls: new Set(inspectedModuleUrls) };
}

/** Lifts the guard of {@link guardLateModules} once the release steps end. */
export function liftLateModuleGuard() {
  lateModuleGuard = null;
}

/**
 * Reads the trace of this process.
 *
 * @returns {ModuleTraceState | null} Trace and how it started, or `null` when it never started
 *   (or Node has no `module.registerHooks`).
 */
export function readModuleTrace() {
  return moduleTraceState;
}
