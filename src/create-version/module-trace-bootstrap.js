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

/** Segment of a relative path that leaves its base directory. */
const PARENT_DIRECTORY_SEGMENT = "..";

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
 * @typedef {{ canonicalRoot: string, trackedPaths: Set<string> }} TrackedModuleGuard
 *   Real path of the repository whose modules must be tracked by Git, and its tracked paths,
 *   relative to the root and separated with `/` like `git ls-files`.
 */

/** Guard active while the release steps run; `null` while repository modules load freely. */
/** @type {TrackedModuleGuard | null} */
let trackedModuleGuard = null;

/**
 * Stops a module that loads for the first time while the guard is active when it is a repository
 * file (by its real path, outside `node_modules`) that Git does not track: an ignored or untracked
 * helper that a hook imports only when it runs never went through the comparison with `HEAD`.
 * Throwing from the resolution keeps Node from evaluating the module.
 *
 * @param {string} moduleUrl - URL Node resolved, with the real path of a file.
 * @throws {Error} When the active guard does not find the module among the tracked files.
 */
function requireTrackedModule(moduleUrl) {
  if (!trackedModuleGuard || !moduleUrl.startsWith(FILE_URL_SCHEME)) {
    return;
  }

  const relativePath = path.relative(trackedModuleGuard.canonicalRoot, fileURLToPath(moduleUrl));
  const segments = relativePath.split(path.sep);

  if (relativePath === "" || path.isAbsolute(relativePath) || segments[0] === PARENT_DIRECTORY_SEGMENT || segments.includes(NODE_MODULES_DIRECTORY)) {
    return;
  }

  const repositoryPath = segments.join("/");
  if (!trackedModuleGuard.trackedPaths.has(repositoryPath)) {
    throw new Error(
      `beez-rp no carga ${repositoryPath} durante el release: Git no lo trackea (lo ignora .gitignore o nunca se commiteó), así que no se pudo comparar con HEAD. Commitealo en una rama y llevalo a main, o dejá de importarlo desde los hooks de beez-rp.config.(m)js, y volvé a correr el release.`
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
      requireTrackedModule(resolution.url);
      const parentUrl = context.parentURL ?? "";
      // Every edge is kept, whatever its scheme: a `data:` module can import a repository file by
      // its `file:` URL, and that file is only reachable through it.
      addToGroup(trace.moduleUrlsByParent, parentUrl, resolution.url);

      const requestedUrl = toRequestedUrl(specifier, context.parentURL);
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
 * Makes the module hook reject, until {@link allowUntrackedRepositoryModules}, every repository
 * module loaded for the first time that Git does not track (see {@link requireTrackedModule}). The
 * run calls it right after its last comparison of the loaded modules with `HEAD`, before the
 * release steps run configuration code (hooks, `migrations.apply`) that may import more modules.
 * Without `module.registerHooks` nothing is checked, but the plan already blocks such a run.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string[]} trackedPaths - Tracked paths (`git ls-files`), relative to the root and separated with `/`.
 */
export function requireTrackedRepositoryModules(repositoryRoot, trackedPaths) {
  trackedModuleGuard = { canonicalRoot: realpathSync.native(repositoryRoot), trackedPaths: new Set(trackedPaths) };
}

/** Lifts the guard of {@link requireTrackedRepositoryModules} once the release steps end. */
export function allowUntrackedRepositoryModules() {
  trackedModuleGuard = null;
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
