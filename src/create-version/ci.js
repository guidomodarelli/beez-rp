/**
 * Selects the release location and plans the worker for an already-created release tag.
 * @module create-version/ci
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CI_COMMIT_SHA_PATTERN, CI_RELEASE_ENVIRONMENT, CI_RUNTIME_DISABLED_VALUES, CI_RUNTIME_ENVIRONMENT, CI_SETUP_CHOICE,
  CI_WORKFLOW_DIRECTORY, DEFAULT_CI_WORKFLOW, DISPATCH_CI_RELEASE_STEP, RELEASE_EXECUTION,
  CI_MIGRATION_ENVIRONMENT_PATTERN, CI_NODE_VERSION_PIN_PATTERN, CI_RELEASE_METADATA_FILE, CI_VERCEL_CONFIG_FILE, RELEASE_EXECUTION_TRAILER, CI_VERCEL_DEPLOYMENT, CI_WORKFLOW_DRIFT_PREVIEW_LINES,
} from "../constants/ci-release.js";
import { BROWSER_AUTHENTICATION, NPM_OIDC_MINIMUM_NODE_VERSION, NPM_OIDC_MINIMUM_VERSION, NPM_REGISTRY_PROVIDER, OIDC_AUTHENTICATION } from "../constants/registry.js";
import { LOCKFILE_PACKAGE_MANAGERS, PACKAGE_MANAGER } from "../constants/package-manager.js";
import { CREATE_VERSION_FLAG, DEFAULT_NPM_REGISTRY_URL, MAIN_BRANCH, MIGRATION_STATUS, NPM_AUTH_STATUS, NPM_LOOKUP_STATUS, PACKAGE_MANIFEST_FILE, PINNED_NODE_VERSION_FILE, RELEASE_MODE, RELEASE_REMOTE, RELEASE_STEP, REMOTE_MAIN_REF } from "../constants/create-version.js";
import { RELEASE_TAG_PREFIX } from "../constants/versions.js";
import { compareReleaseVersions, findHighestStableVersion, isStableReleaseVersion, parseReleaseVersion, toReleaseTag } from "../versions.js";
import { print, select } from "../terminal-ui.js";
import { ReleaseStepError } from "./errors.js";
import { assertSafeCiPath, describeCiNodeVersion, extractPinnedPackageManagerVersion, renderCiReleaseWorkflow } from "./ci-setup.js";
import { runCaptured } from "./process.js";
import { readReleaseExecutionTrailer } from "./release-execution.js";
import { isRegistryProvider } from "./registry-config.js";
import { findNpmOidcRegistryProblem, resolveRegistry, selectProjectRegistry } from "./registry.js";

/**
 * Detects a CI runtime from its conventional environment signals, accepting values such as `1`,
 * `TRUE` or `yes` and treating only unset, empty or explicit false forms (`0`, `false`, `no`, `off`) as disabled.
 * @returns {boolean} True when any CI signal is enabled.
 */
function isCiRuntime() {
  return CI_RUNTIME_ENVIRONMENT.some((name) => {
    const value = process.env[name];
    return value !== undefined && !CI_RUNTIME_DISABLED_VALUES.includes(value.trim().toLowerCase());
  });
}

/**
 * Selects the execution location without ever dispatching again inside a CI runtime.
 * @param {import("./config.js").ResolvedCreateVersionConfig} config - Project configuration.
 * @param {import("./plan.js").ReleaseOptions} options - CLI overrides.
 * @returns {Promise<{ execution: "local" | "ci", setup: boolean } | null>} Selection, or null when canceled.
 */
export async function chooseReleaseExecution(config, options) {
  if (options.ciRelease || isCiRuntime()) {
    if (options.execution === RELEASE_EXECUTION.ci || options.setupCi || options.retryCi) throw new ReleaseStepError("Un proceso de CI no puede disparar otro release en CI.", "Usá --ci-release con el tag recibido o --local.");
    return { execution: RELEASE_EXECUTION.local, setup: false };
  }
  if (options.retryCi) return { execution: RELEASE_EXECUTION.ci, setup: false };
  if (options.execution === RELEASE_EXECUTION.local) return { execution: RELEASE_EXECUTION.local, setup: false };
  if (options.setupCi) return { execution: RELEASE_EXECUTION.ci, setup: true };
  if (config.ci) {
    const execution = !process.stdin.isTTY || options.execution || options.dryRun ? options.execution ?? RELEASE_EXECUTION.ci : await select({
      message: "¿Dónde hacemos el release?",
      options: [{ label: "CI", hint: `${config.ci.workflow} configurado; los checks corren en GitHub`, value: RELEASE_EXECUTION.ci }, { label: "Local", hint: "ejecuta el release completo en esta máquina", value: RELEASE_EXECUTION.local }],
    });
    return { execution: /** @type {"local" | "ci"} */ (execution), setup: false };
  }
  print("Para hacer releases en CI, beez-rp puede crear .github/workflows/release.yml y configurar ci.workflow. Usá --setup-ci para configurarlo o --local para continuar en esta máquina.");
  if (options.dryRun || !process.stdin.isTTY) {
    if (options.execution === RELEASE_EXECUTION.ci) throw new ReleaseStepError("No hay un workflow de release configurado.", "Ejecutá --setup-ci o configurá ci.workflow; también podés usar --local.");
    return { execution: RELEASE_EXECUTION.local, setup: false };
  }
  const choice = await select({
    message: "Este repo todavía no tiene CI para releases",
    options: [{ label: "Configurar CI automáticamente", value: CI_SETUP_CHOICE.configure }, { label: "Continuar con el release en local", value: CI_SETUP_CHOICE.local }, { label: "Cancelar", value: CI_SETUP_CHOICE.cancel }],
    defaultIndex: null,
  });
  return choice === CI_SETUP_CHOICE.cancel ? null : { execution: choice === CI_SETUP_CHOICE.configure ? RELEASE_EXECUTION.ci : RELEASE_EXECUTION.local, setup: choice === CI_SETUP_CHOICE.configure };
}

/**
 * Tells whether a pin installed by the worker (`npm install --global npm@<pin>` or setup-node's
 * Node.js version) can resolve to at least the given stable version.
 * A partial pin such as `11` resolves to the newest matching release, so it reaches any minimum
 * that shares its leading components; a prerelease pin is below its own `X.Y.Z` release.
 * @param {string} pinnedVersion - Version accepted by `CI_PACKAGE_MANAGER_VERSION_PATTERN` or `CI_NODE_VERSION_PIN_PATTERN`, such as `10.9.0`, `11` or `11.6.0-rc.1`.
 * @param {string} minimumVersion - Stable `X.Y.Z` minimum.
 * @returns {boolean} True when the pinned npm can satisfy the minimum.
 */
function canPinnedVersionReach(pinnedVersion, minimumVersion) {
  const prereleaseSeparatorIndex = pinnedVersion.indexOf("-");
  const releasePart = prereleaseSeparatorIndex === -1 ? pinnedVersion : pinnedVersion.slice(0, prereleaseSeparatorIndex);
  const pinnedComponents = releasePart.split(".").map(Number);
  const minimumComponents = parseReleaseVersion(minimumVersion);
  const differentIndex = pinnedComponents.findIndex((component, index) => component !== minimumComponents[index]);
  if (differentIndex !== -1) return pinnedComponents[differentIndex] > minimumComponents[differentIndex];
  return pinnedComponents.length < minimumComponents.length || prereleaseSeparatorIndex === -1;
}

/**
 * Rejects the Node.js runtime the generated workflow selects when it is provably older than npm
 * trusted publishing requires, whatever package manager installs dependencies. Aliases such as
 * `lts/*` cannot be resolved locally, so only the worker can judge them.
 * @param {string} repositoryRoot - Project root whose `.nvmrc`, or the local Node.js major, selects the worker's runtime.
 * @returns {void}
 * @throws {ReleaseStepError} When the selected Node.js cannot reach the npm OIDC minimum.
 */
function assertCiNodeSupportsNpmOidc(repositoryRoot) {
  const nodeVersion = describeCiNodeVersion(repositoryRoot);
  if (!CI_NODE_VERSION_PIN_PATTERN.test(nodeVersion.version) || canPinnedVersionReach(nodeVersion.version, NPM_OIDC_MINIMUM_NODE_VERSION)) return;
  const runtimeSource = nodeVersion.pinnedFile ? `${nodeVersion.pinnedFile} fija Node ${nodeVersion.version}` : `Sin ${PINNED_NODE_VERSION_FILE}, el workflow usa Node ${nodeVersion.version} (el major de este Node.js)`;
  throw new ReleaseStepError(
    `${runtimeSource} en el worker de CI, pero la publicación npm con publication.authentication "${OIDC_AUTHENTICATION}" requiere Node >= ${NPM_OIDC_MINIMUM_NODE_VERSION}; el worker la rechazaría después de subir el tag.`,
    `Subí ${PINNED_NODE_VERSION_FILE} a ${NPM_OIDC_MINIMUM_NODE_VERSION} o superior en un commit propio (regenerá el workflow si ya existe), configurá publication.authentication "token" con su secret o usá --${CREATE_VERSION_FLAG.local}; no se creó, subió ni reenvió ningún release.`
  );
}

/**
 * Rejects registry authentication that a non-interactive GitHub Actions worker can never complete,
 * before the immutable release commit and tag exist (or before a retry dispatches them again).
 * OIDC stays allowed, since only the worker can prove it, except when the runtime the generated
 * workflow sets up provably cannot perform npm trusted publishing: the worker would reject it only
 * after the release was pushed. The Node.js runtime is checked for every package manager. With npm,
 * the version pinned by `packageManager` is checked too and never raised silently, because that
 * would change the client that runs `npm ci` against the committed lockfile; an unpinned npm
 * project and other package managers get a capable npm installed by the workflow for publication
 * (see `requiresCiNpmOidcClient`), after `npm ci` in the unpinned npm case. The effective npm
 * destination is resolved as well, since trusted publishing only exists on the public npm registry.
 * @param {import("./config.js").ResolvedCreateVersionConfig} config - Project configuration.
 * @param {string} repositoryRoot - Project root whose `package.json`, `.nvmrc` and npm config pin the worker's runtime and destination.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When the registry publication authorizes from a browser, or uses npm OIDC with a Node.js or npm pin below the trusted publishing minimum or a registry other than the public npm one.
 */
export async function assertCiCompatiblePublication(config, repositoryRoot) {
  if (!isRegistryProvider(config.publish)) return;
  if (config.publication?.authentication === BROWSER_AUTHENTICATION) {
    throw new ReleaseStepError(
      `${config.publish} con publication.authentication "${BROWSER_AUTHENTICATION}" no puede publicar desde GitHub Actions: el worker no es interactivo.`,
      `Configurá publication.authentication "oidc" (con el paquete vinculado al repositorio) o "token" con su secret, o usá --${CREATE_VERSION_FLAG.local}; no se creó la versión ni el tag.`
    );
  }
  if (config.publish !== NPM_REGISTRY_PROVIDER || config.publication?.authentication !== OIDC_AUTHENTICATION) return;
  assertCiNodeSupportsNpmOidc(repositoryRoot);
  const manifestPath = path.join(repositoryRoot, PACKAGE_MANIFEST_FILE);
  if (!existsSync(manifestPath)) return;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new ReleaseStepError(`No se pudo leer ${PACKAGE_MANIFEST_FILE} para comprobar la publicación npm del worker de CI.`, `Corregí ${PACKAGE_MANIFEST_FILE}; no se creó, subió ni reenvió ningún release.`, { cause: error });
  }
  if (config.commands.packageManager === PACKAGE_MANAGER.npm) assertCiNpmPinSupportsOidc(manifest);
  await assertCiNpmOidcRegistry(config, manifest, repositoryRoot);
}

/**
 * Rejects an npm `packageManager` pin below the trusted publishing minimum: the worker installs
 * exactly that npm and runs `npm ci` with it, so it is never raised silently.
 * @param {Record<string, unknown>} manifest - Parsed project `package.json`.
 * @returns {void}
 * @throws {ReleaseStepError} When the pinned npm cannot reach the npm OIDC minimum.
 */
function assertCiNpmPinSupportsOidc(manifest) {
  const pinnedNpmVersion = extractPinnedPackageManagerVersion(manifest);
  if (pinnedNpmVersion === null || canPinnedVersionReach(pinnedNpmVersion, NPM_OIDC_MINIMUM_VERSION)) return;
  throw new ReleaseStepError(
    `packageManager fija npm@${pinnedNpmVersion}, que el worker de CI instala, pero la publicación npm con publication.authentication "${OIDC_AUTHENTICATION}" requiere npm >= ${NPM_OIDC_MINIMUM_VERSION}; el worker la rechazaría después de subir el tag.`,
    `Subí packageManager a npm@${NPM_OIDC_MINIMUM_VERSION} o superior en un commit propio (regenerá el workflow si ya existe), configurá publication.authentication "token" con su secret o usá --${CREATE_VERSION_FLAG.local}; no se creó, subió ni reenvió ningún release.`
  );
}

/**
 * Resolves the destination the worker publishes to (`publication.registryUrl`, `publishConfig` or
 * npm's project config, as the worker does) and rejects it when npm trusted publishing cannot
 * reach it, before the immutable release commit and tag exist.
 * @param {import("./config.js").ResolvedCreateVersionConfig} config - Configuration publishing to npm through OIDC.
 * @param {Record<string, unknown>} manifest - Parsed project `package.json`.
 * @param {string} repositoryRoot - Project root whose npm configuration routes the publication.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When the destination cannot be resolved or is not the public npm registry.
 */
async function assertCiNpmOidcRegistry(config, manifest, repositoryRoot) {
  let registry;
  try {
    registry = await resolveRegistry(selectProjectRegistry(config), manifest, repositoryRoot);
  } catch (error) {
    throw new ReleaseStepError(
      `No se pudo resolver el registry de la publicación npm con publication.authentication "${OIDC_AUTHENTICATION}" para comprobarlo antes del release en CI: ${error instanceof Error ? error.message : String(error)}.`,
      `Corregí publication.registryUrl, publishConfig o la configuración de npm del proyecto; no se creó, subió ni reenvió ningún release.`,
      { cause: error }
    );
  }
  const registryProblem = findNpmOidcRegistryProblem(registry);
  if (registryProblem === null) return;
  throw new ReleaseStepError(
    `La publicación npm con publication.authentication "${OIDC_AUTHENTICATION}" apunta a ${registry.registryUrl} (${registry.label}): ${registryProblem}; el worker la rechazaría después de subir el tag.`,
    `Publicá en ${DEFAULT_NPM_REGISTRY_URL} (quitá publication.registryUrl, publishConfig.registry o el registry del .npmrc del proyecto), configurá publication.authentication "token" con su secret o usá --${CREATE_VERSION_FLAG.local}; no se creó, subió ni reenvió ningún release.`
  );
}

/**
 * Rejects resuming a pending release in a location different from the one it was prepared in: the
 * Vercel build gate decides from the committed release metadata, and a CI preparation skipped the
 * checks and migrations that a local resume (which only pushes and publishes) would never run.
 * The Vercel metadata wins when it names this version; otherwise the release commit trailer decides.
 * Release commits without either mark (created before they existed) are accepted as before.
 * @param {import("./process.js").GitReader} reader - Git reader of the checkout whose HEAD is the release commit.
 * @param {string} version - Version of the pending release.
 * @param {"local" | "ci"} execution - Location selected for this run.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When the committed mark belongs to this version and names another location, or is unreadable.
 */
export async function assertResumeExecutionMatches(reader, version, execution) {
  const committedMetadata = await reader.tryGit(["show", `HEAD:${CI_RELEASE_METADATA_FILE}`]);
  let metadata = null;
  if (committedMetadata !== null) {
    try {
      metadata = JSON.parse(committedMetadata);
    } catch (error) {
      throw new ReleaseStepError(`${CI_RELEASE_METADATA_FILE} del commit de release ${version} no es JSON válido.`, "Corregilo con un commit de release nuevo; no se subió ni publicó nada.", { cause: error });
    }
  }
  const recordedInMetadata = metadata?.version === version;
  const committedExecution = recordedInMetadata ? metadata.execution : await readReleaseExecutionTrailer(reader, version);
  if (committedExecution === null || committedExecution === execution) return;
  const resumeFlag = committedExecution === RELEASE_EXECUTION.local ? `--${CREATE_VERSION_FLAG.local}` : `--${CREATE_VERSION_FLAG.ci} (o --${CREATE_VERSION_FLAG.retryCi} ${toReleaseTag(version)} si el tag ya está en origin)`;
  throw new ReleaseStepError(
    `El release ${version} se creó para ejecutarse en ${committedExecution} (${recordedInMetadata ? CI_RELEASE_METADATA_FILE : `trailer ${RELEASE_EXECUTION_TRAILER} del commit`}), pero esta ejecución eligió ${execution}.`,
    `Retomalo con ${resumeFlag}: los checks, las migraciones y el deploy dependen del modo con que se preparó el commit; no se subió ni publicó nada.`
  );
}

/**
 * Checks that the configured workflow is a regular file inside the project.
 * @param {string} repositoryRoot - Project root.
 * @param {string} workflow - Validated workflow filename.
 * @returns {void}
 * @throws {ReleaseStepError} When the configured workflow is missing or a symlink.
 */
export function assertCiWorkflowFile(repositoryRoot, workflow) {
  assertSafeCiPath(repositoryRoot, `${CI_WORKFLOW_DIRECTORY}/${workflow}`);
  const workflowPath = path.join(repositoryRoot, CI_WORKFLOW_DIRECTORY, workflow);
  if (!existsSync(workflowPath) || !lstatSync(workflowPath).isFile()) throw new ReleaseStepError(`No existe un workflow regular en ${CI_WORKFLOW_DIRECTORY}/${workflow}.`, "Crealo y commitealo, o quitá ci.workflow y ejecutá --setup-ci; también podés elegir --local.");
}

/**
 * Reads the configured workflow from HEAD after checking it is a regular file inside the project.
 * `gh workflow run --ref <tag>` only finds workflows contained in the pushed release commit, so a
 * local file that is untracked, ignored or set aside by `--ignore-local-changes` is not enough.
 * @param {string} repositoryRoot - Project root.
 * @param {string} workflow - Validated workflow filename.
 * @param {string} [missingHint] - Recovery hint shown when HEAD does not contain the workflow.
 * @returns {Promise<string>} Workflow content committed at HEAD.
 * @throws {ReleaseStepError} When the workflow is missing, a symlink or not committed at HEAD.
 */
export async function readCommittedCiWorkflow(repositoryRoot, workflow, missingHint = `Commitealo en un commit propio antes de crear el release, o elegí --${CREATE_VERSION_FLAG.local}. No se creó la versión ni el tag.`) {
  assertCiWorkflowFile(repositoryRoot, workflow);
  const workflowPath = `${CI_WORKFLOW_DIRECTORY}/${workflow}`;
  const committed = await runCaptured("git", ["show", `HEAD:${workflowPath}`], { cwd: repositoryRoot });
  if (committed.status !== 0) throw new ReleaseStepError(`${workflowPath} existe pero no está commiteado en HEAD; el worker de CI no lo recibiría.`, missingHint);
  return committed.stdout;
}

/**
 * Rejects the generated workflow when HEAD has no lockfile of the project's package manager: it
 * installs dependencies with a frozen lockfile (`npm ci`, `pnpm install --frozen-lockfile`,
 * `yarn install --frozen-lockfile`/`--immutable`, `bun install --frozen-lockfile`), which fails
 * without one, so the worker would stop only after the release commit and tag were pushed.
 * A file present on disk is not enough: the worker checks out the pushed release commit.
 * @param {string} repositoryRoot - Project root.
 * @param {import("../package-manager.js").PackageManagerName} packageManager - Package manager the workflow installs with.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When HEAD cannot be listed or contains none of the package manager's lockfiles.
 */
export async function assertCiInstallLockfileCommitted(repositoryRoot, packageManager) {
  const lockfiles = LOCKFILE_PACKAGE_MANAGERS.filter(([, lockfileManager]) => lockfileManager === packageManager).map(([fileName]) => fileName);
  const listed = await runCaptured("git", ["ls-tree", "--name-only", "HEAD", "--", ...lockfiles], { cwd: repositoryRoot });
  if (listed.status !== 0) throw new ReleaseStepError(`No se pudo comprobar si HEAD contiene ${lockfiles.join(" o ")} para el workflow de CI (git ls-tree terminó con status ${listed.status}).`, "Revisá el repositorio Git antes de configurar CI; no se creó la versión ni el tag.");
  if (listed.stdout.trim() !== "") return;
  throw new ReleaseStepError(
    `El workflow generado instala dependencias con ${packageManager} y lockfile congelado, pero HEAD no contiene ${lockfiles.join(" ni ")}; el worker fallaría después de subir el tag.`,
    `Generá el lockfile con ${packageManager} install y commitealo en un commit propio, o usá --${CREATE_VERSION_FLAG.local}; no se creó la versión ni el tag.`
  );
}

/**
 * Splits workflow content into comparable lines regardless of checkout line endings.
 * @param {string} content - Workflow YAML.
 * @returns {string[]} Lines without the trailing newline.
 */
function toWorkflowLines(content) {
  return content.replace(/\r\n/gu, "\n").trimEnd().split("\n");
}

/**
 * Rejects `--setup-ci` over an existing workflow whose committed content no longer matches what
 * setup would generate for the current configuration (for example a new publication token binding).
 * Regeneration is never automatic: the committed file may hold intentional manual edits, so the
 * user decides between regenerating it and releasing with the customized workflow through `--ci`.
 * @param {string} repositoryRoot - Project root.
 * @param {import("./config.js").ResolvedCreateVersionConfig} config - Configuration with a validated `ci.workflow`.
 * @returns {Promise<void>}
 * @throws {ReleaseStepError} When the workflow is not committed at HEAD or differs from the rendered one.
 */
export async function assertGeneratedCiWorkflowCurrent(repositoryRoot, config) {
  if (!config.ci) return;
  const workflowPath = `${CI_WORKFLOW_DIRECTORY}/${config.ci.workflow}`;
  const regenerateHint = `Regeneralo con --${CREATE_VERSION_FLAG.setupCi} después de borrarlo en un commit propio, o actualizalo y commitealo a mano; si lo personalizaste a propósito, usá --${CREATE_VERSION_FLAG.ci}. No se creó la versión ni el tag.`;
  const committedLines = toWorkflowLines(await readCommittedCiWorkflow(repositoryRoot, config.ci.workflow, regenerateHint));
  const renderedLines = toWorkflowLines(renderCiReleaseWorkflow(repositoryRoot, config));
  if (committedLines.length === renderedLines.length && committedLines.every((line, index) => line === renderedLines[index])) return;
  const missingLines = renderedLines.filter((line) => line.trim() !== "" && !committedLines.includes(line)).map((line) => line.trim());
  const missingDetail = missingLines.length > 0 ? ` Líneas esperadas ausentes: ${missingLines.slice(0, CI_WORKFLOW_DRIFT_PREVIEW_LINES).join(" | ")}.` : "";
  throw new ReleaseStepError(`${workflowPath} no coincide con el workflow que --${CREATE_VERSION_FLAG.setupCi} genera para la configuración actual; el worker podría fallar después de subir el tag.${missingDetail}`, regenerateHint);
}

/**
 * Reads an immutable release identity and proves it already exists on origin/main.
 * @param {import("./process.js").GitReader} reader - Git reader.
 * @param {string} tag - Stable release tag, vX.Y.Z.
 * @param {boolean} [requireHead] - Require the checkout to be exactly this release.
 * @returns {Promise<import("./github-workflow.js").CiReleaseIdentity>} Verified remote identity.
 * @throws {ReleaseStepError} When the tag, commit, version or checkout differs.
 */
export async function readCiReleaseIdentity(reader, tag, requireHead = false) {
  const version = tag.startsWith(RELEASE_TAG_PREFIX) ? tag.slice(RELEASE_TAG_PREFIX.length) : "";
  if (!isStableReleaseVersion(version) || toReleaseTag(version) !== tag) throw new ReleaseStepError(`Tag de release inválido: ${tag}.`, "Usá un tag estable vX.Y.Z creado por create-version.");
  const sha = await reader.tryGit(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  if (!sha || !CI_COMMIT_SHA_PATTERN.test(sha)) throw new ReleaseStepError(`No se pudo resolver ${tag}.`, "Traé el tag de origin antes de retomar el release.");
  const remote = await reader.git(["ls-remote", "--tags", RELEASE_REMOTE, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  const remoteSha = remote.split("\n").find((line) => line.endsWith(`refs/tags/${tag}^{}`))?.split(/\s+/u)[0] ?? remote.split(/\s+/u)[0];
  if (remoteSha !== sha || (await reader.tryGit(["merge-base", "--is-ancestor", sha, REMOTE_MAIN_REF])) === null) throw new ReleaseStepError(`${tag} no coincide con origin o su commit no está en ${MAIN_BRANCH}.`, "No se publicó ni se reenviará nada; verificá el tag y origin/main.");
  const manifest = JSON.parse(await reader.git(["show", `${tag}:${PACKAGE_MANIFEST_FILE}`]));
  const currentMain = JSON.parse(await reader.git(["show", `${REMOTE_MAIN_REF}:${PACKAGE_MANIFEST_FILE}`]));
  if (currentMain.version !== version) throw new ReleaseStepError(`${tag} ya no es la versión de origin/main.`, "No se ejecutará un release anterior sobre uno más nuevo; retomá el tag vigente.");
  if (manifest.version !== version || (await reader.git(["log", "-1", "--format=%s", sha])) !== version) throw new ReleaseStepError(`${tag} no corresponde a un commit de versión ${version}.`, "Usá el tag creado por create-version; no se hizo otro bump.");
  if (requireHead) {
    if (await reader.git(["rev-parse", "HEAD"]) !== sha || (process.env[CI_RELEASE_ENVIRONMENT.version] && process.env[CI_RELEASE_ENVIRONMENT.version] !== version) || (process.env[CI_RELEASE_ENVIRONMENT.sha] && process.env[CI_RELEASE_ENVIRONMENT.sha] !== sha)) throw new ReleaseStepError("El checkout de CI no coincide con la versión y el commit enviados.", `Hacé checkout de ${tag} y conservá los inputs originales del workflow.`);
  }
  return { version, tag, sha };
}

/**
 * Appends dispatch to the minimal local preparation plan.
 * @param {import("./plan.js").ReleasePlan} plan - Existing bump/push plan.
 * @returns {import("./plan.js").ReleasePlan} Plan whose last step only submits the worker.
 */
export function appendCiDispatch(plan) {
  if (plan.blockers.length > 0 || !plan.steps.some((step) => step.id === RELEASE_STEP.pushRelease)) return plan;
  return { ...plan, steps: [...plan.steps, { id: DISPATCH_CI_RELEASE_STEP, title: "Enviar el release a GitHub Actions", detail: "Los checks, la preparación y la publicación continúan en CI sobre el tag exacto." }] };
}

/**
 * Plans checks and unfinished publication for a pinned worker; never bumps or pushes.
 * @param {import("./state.js").ReleaseSnapshot} state - Diagnosed worker checkout.
 * @param {import("./plan.js").ReleaseCapabilities} capabilities - Normal project hooks.
 * A retry after the registry publication succeeded skips migrations and publication, but still
 * re-runs the preparation when the workflow deploys afterwards: the retry starts from a fresh
 * checkout, so files or setup produced by `prepare` would otherwise be missing from the deployment.
 * @param {string} version - Existing release version.
 * @param {boolean} [deploymentFollows] - Whether the workflow deploys (for example to Vercel) after this worker finishes.
 * @returns {import("./plan.js").ReleasePlan} Worker-only execution plan.
 */
export function buildCiWorkerPlan(state, capabilities, version, deploymentFollows = false) {
  const blockers = [];
  if (state.workingTreeChanges.length > 0) blockers.push({ title: "CI necesita un checkout limpio del tag", details: state.workingTreeChanges });
  if (capabilities.checksMissing) blockers.push({ title: "Faltan checks para ejecutar el release en CI", details: ["Configurá checks o un script ci antes de publicar."] });
  if (state.npm?.status !== undefined && state.npm.status !== NPM_LOOKUP_STATUS.ok) blockers.push({ title: "No se pudo consultar el registry del release", details: [state.npm.reason ?? "Verificá las credenciales y la conexión del worker."] });
  if (state.npmAuth && state.npmAuth.status !== NPM_AUTH_STATUS.ok && state.npmAuth.status !== NPM_AUTH_STATUS.unknown) blockers.push({ title: "Las credenciales del worker no permiten publicar", details: [state.npmAuth.reason ?? "Configurá la credencial de publicación en Actions."] });
  const alreadyPublished = state.npm?.publishedVersions.includes(version) ?? false;
  if (!alreadyPublished && state.migrations?.status === MIGRATION_STATUS.unknown) blockers.push({ title: "No se pudieron verificar las migraciones del release", details: [state.migrations.reason ?? "Configurá el entorno y la conexión de las migraciones en Actions."] });
  const highestPublished = findHighestStableVersion(state.npm?.publishedVersions ?? []);
  if (!alreadyPublished && highestPublished && compareReleaseVersions(version, highestPublished) < 0) blockers.push({ title: "El registry ya tiene una versión más nueva", details: [`${version} no se publicará sobre ${highestPublished}.`] });
  const steps = [
    ...(capabilities.checks ? [{ id: RELEASE_STEP.runChecks, title: "Validar el release en CI" }] : []),
    ...(!alreadyPublished && state.migrations?.status === MIGRATION_STATUS.pending ? [{ id: RELEASE_STEP.applyMigrations, title: "Aplicar migraciones del release" }] : []),
    ...((!alreadyPublished || deploymentFollows) && capabilities.prepare ? [{ id: RELEASE_STEP.prepareRelease, title: "Preparar el release" }] : []),
    ...(!alreadyPublished && capabilities.publish ? [{ id: RELEASE_STEP.publishRelease, title: capabilities.publishTitle }] : []),
  ];
  if (alreadyPublished) print(`${toReleaseTag(version)} ya está publicado; CI verifica los checks${deploymentFollows && capabilities.prepare ? " y vuelve a preparar el release para el despliegue" : ""} sin repetir la publicación.`);
  return { mode: blockers.length > 0 ? RELEASE_MODE.blocked : RELEASE_MODE.resume, pendingVersion: version, blockers, warnings: [], steps: blockers.length > 0 ? [] : steps };
}

/**
 * Derives setup defaults from the application's deployment and migration configuration.
 * @param {string} repositoryRoot - Checkout offered automatic setup.
 * @param {import("./config.js").ResolvedCreateVersionConfig} config - Existing project hooks.
 * @returns {import("./ci-config.js").ResolvedCiReleaseConfig} In-memory settings, committed only with a successful bump.
 */
export function defaultCiReleaseConfig(repositoryRoot, config) {
  return { workflow: DEFAULT_CI_WORKFLOW, secrets: [...new Set(config.migrations?.targetHint?.match(CI_MIGRATION_ENVIRONMENT_PATTERN) ?? [])], variables: [], deployment: config.publish === null && existsSync(path.join(repositoryRoot, CI_VERCEL_CONFIG_FILE)) ? CI_VERCEL_DEPLOYMENT : null };
}
