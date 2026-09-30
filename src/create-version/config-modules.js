/**
 * Module graph of the `create-version` configuration: the files of the repository that the run
 * loads as modules, starting with `beez-rp.config.(m)js` and everything it imports.
 *
 * The run imports the configuration once, from the working tree, before `--ignore-local-changes`
 * sets the uncommitted changes aside, and Node keeps every imported module in its cache. A local
 * change in any file of this graph therefore reaches the release (its `versionFiles`, checks,
 * migrations and hooks, including the values they capture) even after it is set aside, so the plan
 * blocks it like a change in the configuration file itself.
 *
 * The graph is traced in the running process itself with a synchronous module hook
 * (`module.registerHooks`), registered once per process before the configuration loads. It records
 * every `file:` module the process resolves from then on (ESM `import`, CommonJS `require` and JSON
 * modules), for the whole run: the configuration, whatever it imports depending on the process
 * (its arguments, whether it has a terminal), and what its hooks or `migrations.check` import
 * lazily when they run. It also records every symbolic link inside the repository followed to reach
 * one (the module itself or any directory on its way). Each module is recorded with the module that
 * imported it, so the graph of a configuration is what is reachable from its file: another
 * configuration loaded in the same process (another repository) does not leak into it. Files the
 * configuration reads with `fs` instead of importing them are not modules and are not listed.
 *
 * @module create-version/config-modules
 */

import { lstatSync, realpathSync } from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MODULE_HOOKS_MINIMUM_NODE_VERSION, NODE_MODULES_DIRECTORY } from "../constants/create-version.js";

/**
 * @typedef {{ loaded: true, files: string[], externalFiles: string[] } | { loaded: false, reason: string }} ConfigModuleGraph
 *   `files` are relative to the repository root, separated with `/` like `git status` paths, and
 *   only include files inside the repository, outside `node_modules` (loaded modules and the
 *   symbolic links followed to reach them). `externalFiles` are the absolute paths of the modules
 *   loaded from outside the repository, outside `node_modules` and beez-rp itself.
 * @typedef {{ moduleUrlsByParent: Map<string, Set<string>>, requestedUrlsByParent: Map<string, Set<string>>, moduleUrlByRequestedUrl: Map<string, string> }} ModuleTrace
 *   Import edges of this process, keyed by the URL of the importing module: the `file:` URLs of the
 *   modules each one resolved (their real path, where Node loads them) and of the paths its
 *   specifiers named before Node followed symbolic links; plus the module each requested path
 *   resolved to. The edges are kept for the whole process (Node never resolves a cached module
 *   again), and each configuration only walks the ones reachable from its own file, so loading the
 *   configuration of another repository in the same process does not mix both graphs.
 */

/**
 * Canonical root of the running beez-rp package: the run loads beez-rp's own modules, which are
 * not part of the released repository (unless it is beez-rp's own checkout).
 */
const BEEZ_RP_PACKAGE_ROOT = realpathSync.native(fileURLToPath(new URL("../..", import.meta.url)));

/** Trace of this process, created by the first {@link startTracingConfigModules}; `null` before. */
/** @type {ModuleTrace | null} */
let moduleTrace = null;

/**
 * Resolves a specifier to the `file:` URL it names before Node follows symbolic links.
 *
 * @param {string} specifier - Specifier as written in the `import` or `require`.
 * @param {string | undefined} parentUrl - URL of the importing module.
 * @returns {string | null} Requested URL, or `null` when the specifier is not a file path (a
 *   package, a built-in).
 */
function toRequestedUrl(specifier, parentUrl) {
  try {
    if (specifier.startsWith("file:")) {
      return new URL(specifier).href;
    }
    if (path.isAbsolute(specifier)) {
      return pathToFileURL(specifier).href;
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && parentUrl?.startsWith("file:")) {
      return new URL(specifier, parentUrl).href;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Starts recording the modules this process resolves, once per process: later calls keep the same
 * trace. It must run before the configuration loads, since a module Node already cached is never
 * resolved again from where it was first imported. Without `module.registerHooks` (Node before
 * {@link MODULE_HOOKS_MINIMUM_NODE_VERSION}) nothing is recorded and {@link listConfigModules}
 * says why.
 */
export function startTracingConfigModules() {
  if (moduleTrace || typeof module.registerHooks !== "function") {
    return;
  }

  /** @type {ModuleTrace} */
  const trace = { moduleUrlsByParent: new Map(), requestedUrlsByParent: new Map(), moduleUrlByRequestedUrl: new Map() };
  module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentUrl = context.parentURL ?? "";
      const requestedUrl = toRequestedUrl(specifier, context.parentURL);
      if (requestedUrl) {
        addToGroup(trace.requestedUrlsByParent, parentUrl, requestedUrl);
      }

      const resolution = nextResolve(specifier, context);
      if (resolution.url.startsWith("file:")) {
        addToGroup(trace.moduleUrlsByParent, parentUrl, resolution.url);
        if (requestedUrl) {
          trace.moduleUrlByRequestedUrl.set(requestedUrl, resolution.url);
        }
      }
      return resolution;
    },
  });
  moduleTrace = trace;
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
 * Walks the import edges from the configuration file: the modules it loaded, directly or through
 * other modules (installed dependencies included, filtered later), and the paths their specifiers
 * named before Node followed symbolic links.
 *
 * @param {ModuleTrace} trace - Trace of this process.
 * @param {string} configRequestedUrl - `file:` URL `loadCreateVersionConfig` imported.
 * @returns {{ moduleUrls: Set<string>, requestedUrls: Set<string> } | null} Graph of the
 *   configuration, or `null` when this process never imported that file after the trace started.
 */
function collectReachableModules(trace, configRequestedUrl) {
  const configModuleUrl = trace.moduleUrlByRequestedUrl.get(configRequestedUrl);

  if (!configModuleUrl) {
    return null;
  }

  const moduleUrls = new Set([configModuleUrl]);
  const requestedUrls = new Set([configRequestedUrl]);
  const pendingUrls = [configModuleUrl];

  while (pendingUrls.length > 0) {
    const parentUrl = /** @type {string} */ (pendingUrls.pop());
    for (const requestedUrl of trace.requestedUrlsByParent.get(parentUrl) ?? []) {
      requestedUrls.add(requestedUrl);
    }
    for (const moduleUrl of trace.moduleUrlsByParent.get(parentUrl) ?? []) {
      if (!moduleUrls.has(moduleUrl)) {
        moduleUrls.add(moduleUrl);
        pendingUrls.push(moduleUrl);
      }
    }
  }

  return { moduleUrls, requestedUrls };
}

/**
 * Resolves the directory of a path through symbolic links and, on Windows, to its real casing,
 * keeping the last segment as it is: the module URLs and the repository root then compare equal
 * whatever spelling each one used, and a module that is itself a symbolic link keeps its own path
 * (so it can be reported as a symbolic link instead of disappearing behind its target).
 *
 * @param {string} filePath - Path whose directory exists.
 * @returns {string} Path with a canonical directory, or the same path when it cannot be resolved.
 */
function toCanonicalPath(filePath) {
  try {
    return path.join(realpathSync.native(path.dirname(filePath)), path.basename(filePath));
  } catch {
    return filePath;
  }
}

/**
 * Tells whether a canonical path is inside a directory (or is the directory itself).
 *
 * @param {string} directory - Canonical directory.
 * @param {string} filePath - Canonical path.
 * @returns {boolean} `true` when `filePath` is `directory` or below it.
 */
function isInsideDirectory(directory, filePath) {
  const relativePath = path.relative(directory, filePath);
  return relativePath.split(path.sep)[0] !== ".." && !path.isAbsolute(relativePath);
}

/**
 * Lists the symbolic links (or Windows junctions) along a requested module path inside the
 * repository, from its first segment below the root to the module itself. Node loads the module
 * from its real path, so without this a link (the module itself, or any directory on its way, even
 * one pointing outside the repository) would never show up in the graph.
 *
 * @param {string} requestedUrl - `file:` URL a specifier named.
 * @param {string[]} repositoryRoots - Spellings of the repository root (as given and real).
 * @returns {string[]} Paths of the links, empty when the URL is not inside the repository or no
 *   segment is a link.
 */
function listSymbolicLinks(requestedUrl, repositoryRoots) {
  const requestedPath = fileURLToPath(requestedUrl);
  const repositoryRoot = repositoryRoots.find((root) => {
    const relativePath = path.relative(root, requestedPath);
    return relativePath !== "" && relativePath.split(path.sep)[0] !== ".." && !path.isAbsolute(relativePath);
  });

  if (!repositoryRoot) {
    return [];
  }

  const symbolicLinks = [];
  let currentPath = repositoryRoot;

  for (const segment of path.relative(repositoryRoot, requestedPath).split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatSync(currentPath, { throwIfNoEntry: false });

    if (!stats) {
      break;
    }
    if (stats.isSymbolicLink()) {
      symbolicLinks.push(currentPath);
    }
  }

  return symbolicLinks;
}

/**
 * Lists the repository files this process has loaded as modules so far, and the modules it loaded
 * from outside the repository: files inside the repository become repository-relative paths, and
 * modules outside it are kept apart, since the release cannot compare them with `HEAD` (such as a
 * module reached through a directory of the repository replaced by a link to an outside
 * directory). Installed dependencies (anything inside a `node_modules` directory) and beez-rp
 * itself are dropped; Node built-ins are never recorded.
 *
 * @param {string} repositoryRoot - Repository root.
 * @param {string} configFile - Configuration file the run loaded, relative to the root.
 * @returns {ConfigModuleGraph} Sorted repository-relative paths separated with `/` and sorted
 *   absolute paths of the modules outside the repository, or why the graph is unknown: the trace
 *   was never started, or the configuration was not loaded after it started.
 */
export function listConfigModules(repositoryRoot, configFile) {
  if (!moduleTrace) {
    return {
      loaded: false,
      reason:
        typeof module.registerHooks === "function"
          ? "beez-rp no registró sus hooks de módulos antes de cargar la configuración (loadCreateVersionConfig los registra)"
          : `Node ${process.versions.node} no permite registrar hooks de módulos síncronos (module.registerHooks); hace falta Node ${MODULE_HOOKS_MINIMUM_NODE_VERSION} o posterior`,
    };
  }

  const canonicalRoot = realpathSync.native(repositoryRoot);
  const repositoryRoots = [...new Set([path.resolve(repositoryRoot), canonicalRoot])];
  const files = new Set();
  const externalFiles = new Set();

  /**
   * @param {string} filePath - Loaded module or symbolic link followed to reach one.
   * @param {boolean} isSymbolicLink - Whether the path names a followed symbolic link.
   */
  const classify = (filePath, isSymbolicLink) => {
    const canonicalPath = toCanonicalPath(filePath);
    const isInsideRepository = isInsideDirectory(canonicalRoot, canonicalPath);
    const segments = (isInsideRepository ? path.relative(canonicalRoot, canonicalPath) : canonicalPath).split(path.sep);

    if (segments.includes(NODE_MODULES_DIRECTORY) || canonicalPath === canonicalRoot) {
      return;
    }
    if (isInsideRepository) {
      files.add(segments.join("/"));
    } else if (!isSymbolicLink && !isInsideDirectory(BEEZ_RP_PACKAGE_ROOT, canonicalPath)) {
      externalFiles.add(canonicalPath);
    }
  };

  const trace = moduleTrace;
  // The graph of this configuration only: other configurations loaded in this process (another
  // repository) are not reachable from it.
  const configGraph = repositoryRoots
    .map((root) => collectReachableModules(trace, pathToFileURL(path.join(root, configFile)).href))
    .find((graph) => graph !== null);

  for (const moduleUrl of configGraph?.moduleUrls ?? []) {
    classify(fileURLToPath(moduleUrl), false);
  }
  for (const requestedUrl of configGraph?.requestedUrls ?? []) {
    for (const symbolicLink of listSymbolicLinks(requestedUrl, repositoryRoots)) {
      classify(symbolicLink, true);
    }
  }

  if (!configGraph || !files.has(configFile)) {
    return { loaded: false, reason: `${configFile} no se cargó con loadCreateVersionConfig en este proceso después de registrar los hooks de módulos` };
  }

  return { loaded: true, files: [...files].toSorted(), externalFiles: [...externalFiles].toSorted() };
}
