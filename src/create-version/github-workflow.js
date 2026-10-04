/**
 * Adapts GitHub CLI for credential preflight and dispatch reconciliation.
 * @module create-version/github-workflow
 */

import {
  CI_DIAGNOSTIC_LIMIT, CI_DISPATCH_STATUS, CI_FAILURE_CODE, CI_GITHUB_TOKEN_VARIABLES, CI_ORGANIZATION_BINDING_PAGE_SIZE,
  CI_ORGANIZATION_BINDING_RESOURCE, CI_RELEASE_RUN_TITLE_PREFIX, CI_RUN_LOOKUP_LIMIT, CI_WORKFLOW_DIRECTORY,
} from "../constants/ci-release.js";
import { GITHUB_REPOSITORY_PATTERN, MAIN_BRANCH, RELEASE_REMOTE, REMOTE_MAIN_REF } from "../constants/create-version.js";
import { CiReleaseError } from "./errors.js";
import { runCaptured } from "./process.js";

/**
 * @typedef {{ version: string, tag: string, sha: string }} CiReleaseIdentity
 * @typedef {{ status: "submitted" | "existing", url: string | null }} CiDispatchResult
 * @typedef {"secret" | "variable"} ActionsBindingKind
 * @typedef {{
 *   preflight: (workflow: string, secrets: string[], variables: string[]) => Promise<void>,
 *   dispatch: (workflow: string, release: CiReleaseIdentity, retryCommand: string) => Promise<CiDispatchResult>,
 * }} GithubWorkflowClient
 */

/**
 * Builds the `run-name` the generated workflow gives a dispatched release, which identifies its runs.
 * @param {CiReleaseIdentity} release - Dispatched release.
 * @returns {string} Run title, such as `beez-rp release v1.2.4 <sha>`.
 */
export function formatCiReleaseRunTitle(release) {
  return `${CI_RELEASE_RUN_TITLE_PREFIX} ${release.tag} ${release.sha}`;
}

/**
 * Redacts inherited GitHub credentials and bounds external command diagnostics.
 * @param {string} diagnostic - GitHub CLI diagnostic.
 * @returns {string} Safe terminal diagnostic.
 */
function safeDiagnostic(diagnostic) {
  return CI_GITHUB_TOKEN_VARIABLES.reduce((output, name) => process.env[name] ? output.replaceAll(/** @type {string} */ (process.env[name]), "[redactado]") : output, diagnostic).slice(0, CI_DIAGNOSTIC_LIMIT);
}

/**
 * Builds the repository-level commands that would configure the missing bindings.
 * @param {ActionsBindingKind} kind - Actions binding kind.
 * @param {string[]} names - Missing binding names.
 * @param {string} repository - `owner/name` repository.
 * @returns {string} Commands joined for a terminal hint.
 */
function repositorySetCommands(kind, names, repository) {
  return names.map((name) => `gh ${kind} set ${name} --repo ${repository}`).join("; ");
}

/**
 * Creates a GitHub workflow adapter with an explicit subprocess boundary.
 * @param {string} repositoryRoot - Checkout whose origin selects the repository.
 * @param {typeof runCaptured} [capture] - Process executor, injectable by other CLI hosts.
 * @returns {GithubWorkflowClient} Preflight and dispatch operations.
 */
export function createGithubWorkflowClient(repositoryRoot, capture = runCaptured) {
  let repository = "";

  /** @param {string[]} args - GitHub CLI arguments. @returns {ReturnType<typeof runCaptured>} Captured result. */
  const github = (args) => capture("gh", args, { cwd: repositoryRoot });

  /**
   * Lists matching accepted runs before a dispatch is repeated.
   * @param {string} workflow - Workflow filename.
   * @param {CiReleaseIdentity} release - Existing immutable release.
   * @param {string} retryCommand - Recovery command preserving the tag.
   * @returns {Promise<{ status: string, conclusion: string | null, url: string } | null>} Existing active or successful run.
   */
  async function findAcceptedRun(workflow, release, retryCommand) {
    const result = await github(["run", "list", "--repo", repository, "--workflow", workflow, "--event", "workflow_dispatch", "--limit", String(CI_RUN_LOOKUP_LIMIT), "--json", "displayTitle,status,conclusion,url"]);
    if (result.status !== 0) throw new CiReleaseError(CI_FAILURE_CODE.lookup, `No se pudo verificar si ${release.tag} ya tiene una ejecución de ${workflow}: ${safeDiagnostic(result.stderr)}`, `No se envió otra ejecución. Revisá Actions y retomá con ${retryCommand} cuando se pueda consultar el estado.`);
    const runs = JSON.parse(result.stdout);
    return runs.find((/** @type {{ displayTitle: string, status: string, conclusion: string | null }} */ run) => run.displayTitle === formatCiReleaseRunTitle(release) && (run.status !== "completed" || run.conclusion === "success")) ?? null;
  }

  /**
   * Lists organization bindings of one kind that GitHub shares with the repository, honoring their visibility.
   * @param {ActionsBindingKind} kind - Actions binding kind.
   * @param {string} workflow - Workflow to be dispatched, for diagnostics.
   * @param {string[]} missing - Names absent at repository level, for diagnostics.
   * @returns {Promise<string[]>} Binding names available to the repository through its organization.
   * @throws {CiReleaseError} When organization bindings cannot be listed; the missing names stay unverified.
   */
  async function listOrganizationBindings(kind, workflow, missing) {
    const resource = CI_ORGANIZATION_BINDING_RESOURCE[kind];
    const result = await github(["api", "--paginate", `repos/${repository}/actions/${resource.path}?per_page=${CI_ORGANIZATION_BINDING_PAGE_SIZE}`, "--jq", `.${resource.collection}[].name`]);
    if (result.status !== 0) throw new CiReleaseError(CI_FAILURE_CODE.preflight, `Faltan ${kind}s de Actions para ${workflow} a nivel repositorio (${missing.join(", ")}) y no se pudieron verificar los ${kind}s de organización compartidos con ${repository}: ${safeDiagnostic(result.stderr)}`, `Dale a gh permiso para leer los ${kind}s de Actions de ${repository} o configurá ${repositorySetCommands(kind, missing, repository)}; no se tocó la versión.`);
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /**
   * Requires the release tag to contain the workflow, since dispatching with `--ref <tag>` runs the
   * definition stored in that tag instead of whatever `main` holds today.
   * @param {string} workflow - Workflow filename.
   * @param {CiReleaseIdentity} release - Existing immutable release.
   * @param {string} retryCommand - Recovery command preserving the tag.
   * @returns {Promise<void>} Resolves when the tag carries the workflow.
   * @throws {CiReleaseError} When the tag has no such workflow; nothing is dispatched.
   */
  async function assertWorkflowInReleaseTag(workflow, release, retryCommand) {
    const workflowPath = `${CI_WORKFLOW_DIRECTORY}/${workflow}`;
    const contained = await capture("git", ["cat-file", "-e", `refs/tags/${release.tag}:${workflowPath}`], { cwd: repositoryRoot });
    if (contained.status !== 0) throw new CiReleaseError(CI_FAILURE_CODE.preflight, `${release.tag} no contiene ${workflowPath}; el release solo se ejecuta con el workflow de su propio tag, no con el de ${MAIN_BRANCH}.`, `No se envió ninguna ejecución. Publicá ${release.tag} con --local, o traé el tag con git fetch ${RELEASE_REMOTE} tag ${release.tag} si falta localmente y volvé a correr ${retryCommand}.`);
  }

  /**
   * Requires the workflow file to exist on the default branch as well: GitHub only triggers
   * `workflow_dispatch` for workflows present on the default branch, even when `--ref <tag>` selects
   * the definition stored in the tag, so a workflow renamed or deleted on `main` after the release can
   * no longer be dispatched under its old name. Reads `origin/main` as last fetched by the release flow.
   * @param {string} workflow - Workflow filename.
   * @param {CiReleaseIdentity} release - Existing immutable release.
   * @param {string} retryCommand - Recovery command preserving the tag.
   * @returns {Promise<void>} Resolves when the default branch carries the workflow.
   * @throws {CiReleaseError} When the default branch has no such workflow; nothing is dispatched.
   */
  async function assertWorkflowOnDefaultBranch(workflow, release, retryCommand) {
    const workflowPath = `${CI_WORKFLOW_DIRECTORY}/${workflow}`;
    const contained = await capture("git", ["cat-file", "-e", `refs/remotes/${REMOTE_MAIN_REF}:${workflowPath}`], { cwd: repositoryRoot });
    if (contained.status !== 0) throw new CiReleaseError(CI_FAILURE_CODE.preflight, `${REMOTE_MAIN_REF} no contiene ${workflowPath}: GitHub solo dispara workflow_dispatch para workflows que existen en la rama por defecto (${MAIN_BRANCH}), aunque ${release.tag} conserve el suyo.`, `No se envió ninguna ejecución. Restaurá ${workflowPath} con ese nombre en ${MAIN_BRANCH} y volvé a correr ${retryCommand}, o publicá ${release.tag} con --local.`);
  }

  return {
    /**
     * Checks GitHub CLI, authentication, default branch and configured worker credentials.
     * @param {string} workflow - Workflow to be dispatched.
     * @param {string[]} secrets - Secret names required by the worker, at repository or shared organization level.
     * @param {string[]} variables - Variable names required by the worker, at repository or shared organization level.
     * @returns {Promise<void>} Resolves before any bump when dispatch prerequisites are available.
     * @throws {CiReleaseError} When a prerequisite is missing or cannot be checked.
     */
    async preflight(workflow, secrets, variables) {
      const origin = await capture("git", ["remote", "get-url", RELEASE_REMOTE], { cwd: repositoryRoot });
      repository = GITHUB_REPOSITORY_PATTERN.exec(origin.stdout)?.[1] ?? "";
      if (!repository) throw new CiReleaseError(CI_FAILURE_CODE.preflight, "El modo CI requiere un origin de GitHub.", "Configurá el remoto de GitHub o elegí --local; no se tocó la versión.");
      const installed = await github(["--version"]);
      if (installed.status !== 0) throw new CiReleaseError(CI_FAILURE_CODE.preflight, "No se pudo ejecutar GitHub CLI (gh).", "Instalá gh y ejecutá gh auth login, o elegí --local.");
      const authenticated = await github(["auth", "status", "--hostname", "github.com"]);
      if (authenticated.status !== 0) throw new CiReleaseError(CI_FAILURE_CODE.preflight, `gh no está autenticado para disparar ${workflow}.`, "Ejecutá gh auth login con acceso al repo; no se tocó la versión.");
      const metadata = await github(["repo", "view", repository, "--json", "defaultBranchRef,isInOrganization"]);
      if (metadata.status !== 0) throw new CiReleaseError(CI_FAILURE_CODE.preflight, `No se pudo consultar ${repository}: ${safeDiagnostic(metadata.stderr)}`, "Verificá el acceso del usuario de gh al repo.");
      const repositoryMetadata = JSON.parse(metadata.stdout);
      if (repositoryMetadata.defaultBranchRef?.name !== MAIN_BRANCH) throw new CiReleaseError(CI_FAILURE_CODE.preflight, "workflow_dispatch requiere que el workflow exista en la rama por defecto, que en este flujo debe ser main.", "Usá main como rama por defecto o ejecutá el release con --local.");
      const ownedByOrganization = repositoryMetadata.isInOrganization === true;
      for (const [kind, required] of /** @type {[ActionsBindingKind, string[]][]} */ ([["secret", secrets], ["variable", variables]])) {
        if (required.length === 0) continue;
        const listed = await github([kind, "list", "--repo", repository, "--json", "name"]);
        if (listed.status !== 0) throw new CiReleaseError(CI_FAILURE_CODE.preflight, `No se pudieron verificar los ${kind}s de CI en ${repository}.`, `Revisá los permisos de gh y los ${kind}s de Actions; no se tocó la versión.`);
        const available = JSON.parse(listed.stdout).map((/** @type {{ name: string }} */ entry) => entry.name);
        let missing = required.filter((name) => !available.includes(name));
        if (missing.length > 0 && ownedByOrganization) {
          const shared = await listOrganizationBindings(kind, workflow, missing);
          missing = missing.filter((name) => !shared.includes(name));
        }
        if (missing.length > 0) {
          const organizationHint = ownedByOrganization ? ` o compartí el ${kind} de organización con ${repository}` : "";
          throw new CiReleaseError(CI_FAILURE_CODE.preflight, `Faltan ${kind}s de Actions para ${workflow}: ${missing.join(", ")}.`, `Configurá ${repositorySetCommands(kind, missing, repository)}${organizationHint} y volvé a correr el comando.`);
        }
      }
    },

    /**
     * Submits the exact pushed tag pinned to the workflow version stored in that tag (`--ref <tag>`), so a
     * retry never runs a newer workflow from `main` against the older tagged checkout; reconciles a failed
     * response without automatic resubmission.
     * @param {string} workflow - Workflow filename.
     * @param {CiReleaseIdentity} release - Version, tag and commit already on origin.
     * @param {string} retryCommand - Explicit retry command that never creates another bump.
     * @returns {Promise<CiDispatchResult>} Submission state, never a claim that publication finished.
     * @throws {CiReleaseError} When acceptance cannot be confirmed.
     */
    async dispatch(workflow, release, retryCommand) {
      const existing = await findAcceptedRun(workflow, release, retryCommand);
      if (existing) return { status: CI_DISPATCH_STATUS.existing, url: existing.url };
      await assertWorkflowInReleaseTag(workflow, release, retryCommand);
      await assertWorkflowOnDefaultBranch(workflow, release, retryCommand);
      const dispatched = await github(["workflow", "run", workflow, "--repo", repository, "--ref", release.tag, "-f", `version=${release.version}`, "-f", `tag=${release.tag}`, "-f", `sha=${release.sha}`]);
      if (dispatched.status !== 0) {
        let accepted = null;
        try { accepted = await findAcceptedRun(workflow, release, retryCommand); } catch { /* The original dispatch remains unconfirmed; do not repeat it. */ }
        if (accepted) return { status: CI_DISPATCH_STATUS.existing, url: accepted.url };
        throw new CiReleaseError(CI_FAILURE_CODE.dispatch, `${release.tag} ya está en origin, pero no se confirmó el inicio de ${workflow}: ${safeDiagnostic(dispatched.stderr)}`, `Revisá Actions antes de reenviar con ${retryCommand}; no hace otro bump ni repite el push.`);
      }
      return { status: CI_DISPATCH_STATUS.submitted, url: `https://github.com/${repository}/actions/workflows/${workflow}` };
    },
  };
}
