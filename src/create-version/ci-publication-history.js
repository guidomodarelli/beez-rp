/**
 * Reads the worker's own GitHub Actions history to prove that a custom publisher already finished,
 * so a retry that only needs to deploy never runs a non-idempotent publication again.
 * A registry publication is proven by the registry itself; a custom `publish` function leaves no
 * such record, and the successful release step of an earlier run or attempt is the durable one.
 * @module create-version/ci-publication-history
 */

import {
  CI_ACTIONS_HISTORY_ENVIRONMENT, CI_ACTIONS_HISTORY_PAGE_SIZE, CI_ACTIONS_HISTORY_TIMEOUT_MS, CI_DEFAULT_GITHUB_API_URL,
  CI_GITHUB_API_VERSION, CI_RELEASE_WORKER_STEP_NAME, CI_STEP_SUCCESS_CONCLUSION, CI_VERCEL_DEPLOYMENT,
} from "../constants/ci-release.js";
import { CREATE_VERSION_FLAG } from "../constants/create-version.js";
import { ReleaseStepError } from "./errors.js";
import { formatCiReleaseRunTitle } from "./github-workflow.js";

/**
 * @typedef {{ id: number, display_title: string, run_attempt: number, html_url: string }} ActionsWorkflowRun
 * @typedef {{ steps?: { name: string, conclusion: string | null }[] }} ActionsJob
 * @typedef {{ url: string, attempt: number }} CompletedCiPublication
 */

/**
 * Tells whether the worker must prove from its Actions history that the publication already
 * finished: only a custom publisher followed by a deployment leaves no registry record while a
 * failed deployment still leads to a retry.
 * @param {import("./config.js").ResolvedCreateVersionConfig} config - Project configuration.
 * @returns {boolean} True when `publish` is a function and the workflow deploys afterwards.
 */
export function requiresCiPublicationHistory(config) {
  return typeof config.publish === "function" && config.ci?.deployment === CI_VERCEL_DEPLOYMENT;
}

/**
 * Builds the recovery hint shared by every history failure: nothing was published.
 * @param {string} workflow - Configured workflow filename.
 * @returns {string} Actionable hint.
 */
function describeHistoryRecovery(workflow) {
  return `Dale al job de ${workflow} permissions "actions: read" y GITHUB_TOKEN: \${{ github.token }} (regeneralo con --${CREATE_VERSION_FLAG.setupCi} después de borrarlo en un commit propio) y reintentá con --${CREATE_VERSION_FLAG.retryCi}; el publisher personalizado no se ejecutó.`;
}

/**
 * Requests one Actions REST resource of the worker's repository.
 * @param {{ apiUrl: string, repository: string, token: string, workflow: string }} connection - Validated Actions access.
 * @param {string} resourcePath - Path below `repos/{owner}/{repo}/actions/`, with its query.
 * @returns {Promise<any>} Parsed JSON body.
 * @throws {ReleaseStepError} When the request fails, times out or answers a non-success status.
 */
async function requestActionsResource(connection, resourcePath) {
  const requestPath = `/repos/${connection.repository}/actions/${resourcePath}`;
  let response;
  try {
    response = await fetch(`${connection.apiUrl}${requestPath}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${connection.token}`, "X-GitHub-Api-Version": CI_GITHUB_API_VERSION },
      signal: AbortSignal.timeout(CI_ACTIONS_HISTORY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ReleaseStepError(`ci-publication-history:requestActionsResource failed: no se pudo consultar GET ${requestPath} para saber si el publisher personalizado ya terminó en un intento anterior.`, describeHistoryRecovery(connection.workflow), { cause: error });
  }
  if (!response.ok) {
    throw new ReleaseStepError(`ci-publication-history:requestActionsResource failed: GET ${requestPath} respondió ${response.status} (x-github-request-id ${response.headers.get("x-github-request-id") ?? "ausente"}); no se puede saber si el publisher personalizado ya terminó en un intento anterior.`, describeHistoryRecovery(connection.workflow));
  }
  return response.json();
}

/**
 * Finds an earlier run or attempt of this exact release whose release step succeeded, which means
 * its custom publisher already finished. The current attempt is still running, so it never matches.
 * Fails closed: when the history cannot be read, the worker stops before publishing.
 * @param {string} workflow - Configured workflow filename that dispatches the release.
 * @param {import("./github-workflow.js").CiReleaseIdentity} release - Verified release identity.
 * @param {NodeJS.ProcessEnv} [environment] - Worker environment providing the Actions API, repository and token.
 * @returns {Promise<CompletedCiPublication | null>} The earlier successful attempt, or null when publication never finished.
 * @throws {ReleaseStepError} When the Actions history is unavailable or unreadable.
 */
export async function findCompletedCiPublication(workflow, release, environment = process.env) {
  const repository = environment[CI_ACTIONS_HISTORY_ENVIRONMENT.repository];
  const token = environment[CI_ACTIONS_HISTORY_ENVIRONMENT.token];
  if (!repository || !token) {
    const missing = [CI_ACTIONS_HISTORY_ENVIRONMENT.repository, CI_ACTIONS_HISTORY_ENVIRONMENT.token].filter((name) => !environment[name]);
    throw new ReleaseStepError(`ci-publication-history:findCompletedCiPublication failed: faltan ${missing.join(" y ")} para comprobar en Actions si el publisher personalizado de ${release.tag} ya terminó antes del despliegue.`, describeHistoryRecovery(workflow));
  }
  const connection = { apiUrl: (environment[CI_ACTIONS_HISTORY_ENVIRONMENT.apiUrl] || CI_DEFAULT_GITHUB_API_URL).replace(/\/+$/u, ""), repository, token, workflow };
  const runTitle = formatCiReleaseRunTitle(release);
  const listed = await requestActionsResource(connection, `workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&head_sha=${release.sha}&per_page=${CI_ACTIONS_HISTORY_PAGE_SIZE}`);
  const releaseRuns = /** @type {ActionsWorkflowRun[]} */ (listed.workflow_runs ?? []).filter((run) => run.display_title === runTitle);
  for (const run of releaseRuns) {
    for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
      const attemptJobs = await requestActionsResource(connection, `runs/${run.id}/attempts/${attempt}/jobs?per_page=${CI_ACTIONS_HISTORY_PAGE_SIZE}`);
      const published = /** @type {ActionsJob[]} */ (attemptJobs.jobs ?? []).some((job) => (job.steps ?? []).some((step) => step.name === CI_RELEASE_WORKER_STEP_NAME && step.conclusion === CI_STEP_SUCCESS_CONCLUSION));
      if (published) return { url: run.html_url, attempt };
    }
  }
  return null;
}
