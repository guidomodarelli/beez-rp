/**
 * Local GitHub Actions REST API for tests: a real HTTP server answering the two requests the CI worker
 * makes to read its own history, the workflow runs of a release (`GET .../workflows/{file}/runs`) and
 * the jobs of each run attempt (`GET .../runs/{id}/attempts/{n}/jobs`). Every request must carry the
 * fixture token; a configured status replaces every answer, as GitHub does without `actions: read`.
 *
 * @module tests/create-version/support/fixture-github-actions-api
 */

import { createServer } from "node:http";

/** Repository the fixture serves, as `GITHUB_REPOSITORY` names it. */
export const FIXTURE_GITHUB_REPOSITORY = "fixture/app";

/** Job token the fixture accepts; not a real credential. */
export const FIXTURE_GITHUB_TOKEN = "fixture-actions-token";

/** Step of the generated workflow that runs `--ci-release`. */
const RELEASE_STEP_NAME = "Checks y publicación del release";

/** Request path of a workflow's runs: `/repos/{owner}/{repo}/actions/workflows/{file}/runs`. */
const WORKFLOW_RUNS_PATH_PATTERN = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/runs$/u;

/** Request path of an attempt's jobs: `/repos/{owner}/{repo}/actions/runs/{id}/attempts/{n}/jobs`. */
const ATTEMPT_JOBS_PATH_PATTERN = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/u;

/**
 * @typedef {{ id: number, title: string, headSha: string, releaseStepConclusions: (string | null)[] }} FixtureWorkflowRun
 *   `releaseStepConclusions[n]` is the release step conclusion of attempt `n + 1`; its length is the run's attempt count.
 * @typedef {{ apiUrl: string, requests: { path: string, authorization: string | undefined }[], close: () => Promise<void> }} FixtureGithubActionsApi
 */

/**
 * Sends a JSON response.
 * @param {import("node:http").ServerResponse} response - Response.
 * @param {number} statusCode - HTTP status.
 * @param {unknown} body - JSON body.
 */
function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Starts the fixture API on a random local port.
 * @param {{ workflow: string, runs?: FixtureWorkflowRun[], failureStatus?: number }} options - Runs of the
 *   configured workflow, and a status answered to every request instead of the history.
 * @returns {Promise<FixtureGithubActionsApi>} Base URL, received requests and shutdown.
 */
export async function startFixtureGithubActionsApi({ workflow, runs = [], failureStatus }) {
  /** @type {{ path: string, authorization: string | undefined }[]} */
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ path: `${url.pathname}${url.search}`, authorization: request.headers.authorization });
    if (failureStatus !== undefined) return sendJson(response, failureStatus, { message: "Resource not accessible by integration" });
    if (request.headers.authorization !== `Bearer ${FIXTURE_GITHUB_TOKEN}`) return sendJson(response, 401, { message: "Bad credentials" });
    const runsMatch = WORKFLOW_RUNS_PATH_PATTERN.exec(url.pathname);
    if (runsMatch && runsMatch[1] === FIXTURE_GITHUB_REPOSITORY && decodeURIComponent(runsMatch[2]) === workflow && url.searchParams.get("event") === "workflow_dispatch") {
      const headSha = url.searchParams.get("head_sha");
      const workflowRuns = runs.filter((run) => !headSha || run.headSha === headSha).map((run) => ({ id: run.id, display_title: run.title, run_attempt: run.releaseStepConclusions.length, html_url: `https://github.com/${FIXTURE_GITHUB_REPOSITORY}/actions/runs/${run.id}` }));
      return sendJson(response, 200, { total_count: workflowRuns.length, workflow_runs: workflowRuns });
    }
    const jobsMatch = ATTEMPT_JOBS_PATH_PATTERN.exec(url.pathname);
    const run = jobsMatch && jobsMatch[1] === FIXTURE_GITHUB_REPOSITORY ? runs.find((candidate) => candidate.id === Number(jobsMatch[2])) : undefined;
    const attemptIndex = jobsMatch ? Number(jobsMatch[3]) - 1 : -1;
    if (run && attemptIndex >= 0 && attemptIndex < run.releaseStepConclusions.length) {
      return sendJson(response, 200, { total_count: 1, jobs: [{ name: "release", steps: [{ name: "Checkout del release", conclusion: "success" }, { name: RELEASE_STEP_NAME, conclusion: run.releaseStepConclusions[attemptIndex] }] }] });
    }
    return sendJson(response, 404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}
