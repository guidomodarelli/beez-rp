/**
 * Contracts shared by local release preparation and the GitHub Actions worker.
 * @module constants/ci-release
 */

import { CREATE_VERSION_CONFIG_FILES, PACKAGE_MANIFEST_FILE, PINNED_NODE_VERSION_FILE, PROJECT_NPM_CONFIG_FILE } from "./create-version.js";
import { LOCKFILE_PACKAGE_MANAGERS } from "./package-manager.js";

/** Release execution locations offered by the CLI. */
export const RELEASE_EXECUTION = Object.freeze({ local: "local", ci: "ci" });

/** Choices offered when the repository has no CI release configuration. */
export const CI_SETUP_CHOICE = Object.freeze({ configure: "configure", local: "local", cancel: "cancel" });

/** Default workflow filename, relative to GitHub's workflow directory. */
export const DEFAULT_CI_WORKFLOW = "release.yml";

/** Directory GitHub reads for versioned workflows. */
export const CI_WORKFLOW_DIRECTORY = ".github/workflows";

/** Named configuration export used by automatic setup without rewriting existing hooks. */
export const CI_CONFIG_EXPORT = "ci";

/** Workflow filenames accepted as a configuration value or CLI argument. */
export const CI_WORKFLOW_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.ya?ml$/u;

/** Environment variable names allowed in generated secret and variable bindings. */
export const CI_ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

/** Full Git commit identity passed to the worker. */
export const CI_COMMIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/u;

/** Worker inputs exposed through environment variables instead of shell interpolation. */
export const CI_RELEASE_ENVIRONMENT = Object.freeze({ version: "BEEZ_RP_RELEASE_VERSION", sha: "BEEZ_RP_RELEASE_SHA" });

/** Environment variable carrying the dispatched release tag into generated workflow steps. */
export const CI_RELEASE_TAG_ENVIRONMENT = "RELEASE_TAG";

/** Step that authenticates the dispatched tag, commit and `origin/main` ancestry before any project code runs. */
export const CI_RELEASE_IDENTITY_STEP_NAME = "Verificar identidad del release";

/** POSIX ERE equivalent of `RELEASE_VERSION_PATTERN` for the dependency-free identity step (Bash has no `\d`). */
export const CI_RELEASE_VERSION_SHELL_PATTERN = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$";

/** Environment signals that prevent a CI worker from dispatching another workflow. */
export const CI_RUNTIME_ENVIRONMENT = Object.freeze(["CI", "GITHUB_ACTIONS", "GITLAB_CI"]);

/** Normalized (trimmed, lowercase) CI signal values that explicitly mean "not a CI runtime"; any other non-empty value enables it. */
export const CI_RUNTIME_DISABLED_VALUES = Object.freeze(["", "0", "false", "no", "off"]);

/** Relative template path from the CI setup module. */
export const CI_RELEASE_TEMPLATE_FILE = "./templates/release.yml";

/** Placeholders owned by the release workflow template. */
export const CI_TEMPLATE_PLACEHOLDER = Object.freeze({ node: "__NODE_SETUP__", install: "__PACKAGE_SETUP__", environment: "__RELEASE_ENVIRONMENT__", permissions: "__RELEASE_PERMISSIONS__", command: "__RELEASE_COMMAND__", deploymentSetup: "__DEPLOYMENT_SETUP__", deployment: "__DEPLOYMENT_STEP__", deno: "__DENO_SETUP__", identity: "__RELEASE_IDENTITY_CHECK__" });

/** Version pin formats safe to place in generated package manager setup commands. */
export const CI_PACKAGE_MANAGER_VERSION_PATTERN = /^(?:pnpm|npm|yarn|bun)@([0-9]+(?:\.[0-9]+){0,2}(?:-[a-zA-Z0-9.-]+)?)(?:\+sha\d+\.[a-fA-F0-9]+)?$/u;

/** Numeric Node.js pins (`22`, `22.14`, `v22.14.0` without its `v`) that setup-node resolves to a comparable release; aliases such as `lts/*` stay unverifiable. */
export const CI_NODE_VERSION_PIN_PATTERN = /^[0-9]+(?:\.[0-9]+){0,2}(?:-[a-zA-Z0-9.-]+)?$/u;

/** Git tree modes of regular files (non-executable and executable); symlinks (`120000`) and submodules are excluded. */
export const GIT_REGULAR_FILE_MODES = Object.freeze(["100644", "100755"]);

/** Maximum external diagnostic length displayed by the CLI, in characters. */
export const CI_DIAGNOSTIC_LIMIT = 800;

/** Credentials that must be redacted from GitHub CLI diagnostics. */
export const CI_GITHUB_TOKEN_VARIABLES = Object.freeze(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

/** Maximum workflow runs considered when reconciling an uncertain dispatch. */
export const CI_RUN_LOOKUP_LIMIT = 100;

/**
 * REST resources (under `repos/{owner}/{repo}/actions/`) listing organization bindings that GitHub
 * exposes to one repository, keyed by `gh` binding kind. Unlike `gh secret list --org`, they honor
 * each binding's repository visibility, so they match what `${{ secrets.* }}`/`${{ vars.* }}` resolve.
 */
export const CI_ORGANIZATION_BINDING_RESOURCE = Object.freeze({
  secret: Object.freeze({ path: "organization-secrets", collection: "secrets" }),
  variable: Object.freeze({ path: "organization-variables", collection: "variables" }),
});

/** Page size requested when listing organization bindings shared with a repository. */
export const CI_ORGANIZATION_BINDING_PAGE_SIZE = 100;

/** Git override that delegates hooks to the worker during local CI preparation. */
export const CI_GIT_HOOKS_OPTION = "core.hooksPath=/dev/null";

/** Release step that submits the already-pushed release to GitHub Actions. */
export const DISPATCH_CI_RELEASE_STEP = "dispatch-ci-release";

/** Stable failure categories of the GitHub workflow boundary. */
export const CI_FAILURE_CODE = Object.freeze({ preflight: "ci-preflight-failed", lookup: "ci-run-lookup-failed", dispatch: "ci-dispatch-unconfirmed" });

/** Default Yarn Classic pin when the project does not declare a package manager version. */
export const CI_DEFAULT_YARN_VERSION = "1.22.22";

/** pnpm setup pin for repositories detected only through their lockfile. */
export const CI_DEFAULT_PNPM_VERSION = "12.6.0";

/** Deno runtime installed when JSR publication selects its native client. */
export const CI_DENO_VERSION = "v2.9.7";

/** Native JSR client that needs a Deno runtime in the generated workflow. */
export const CI_DENO_JSR_CLIENT = "deno";

/** Observable acceptance outcomes returned by the workflow adapter. */
export const CI_DISPATCH_STATUS = Object.freeze({ submitted: "submitted", existing: "existing" });

/**
 * Prefix of the temporary directory, created inside the repository's Git directory, where `--retry-ci`
 * checks out the release tag to load the configuration stored in it; living under the checkout lets the
 * tagged configuration resolve the project's installed dependencies while staying outside the working tree.
 */
export const CI_RELEASE_TAG_CONFIG_DIRECTORY_PREFIX = "beez-rp-release-tag-config-";

/** Early-build metadata; its version and the commit that changes it scope the decision to exactly one release commit. */
export const CI_RELEASE_METADATA_FILE = ".beez-rp/release.json";

/**
 * Git trailer of the release commit naming where it was prepared (`local` or `ci`), so a resume after a
 * failed push keeps that location for every release, not only those whose Vercel metadata records it.
 */
export const RELEASE_EXECUTION_TRAILER = "Beez-Rp-Execution";

/** Vercel project configuration used to offer deployment setup for applications. */
export const CI_VERCEL_CONFIG_FILE = "vercel.json";

/** Provider handled by the generated application deployment steps. */
export const CI_VERCEL_DEPLOYMENT = "vercel";

/** Vercel CLI version used by generated workflows. */
export const CI_VERCEL_CLI_VERSION = "62.2.0";

/** Repository secrets required to deploy prebuilt output to Vercel. */
export const CI_VERCEL_SECRETS = Object.freeze(["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]);

/** Paths the generated Vercel worker writes after checkout; they must stay untracked to keep the release tree clean. */
export const CI_VERCEL_WORKER_WRITTEN_PATHS = Object.freeze([".env", ".vercel"]);

/** Environment names explicitly mentioned by a project's migration target hint. */
export const CI_MIGRATION_ENVIRONMENT_PATTERN = /\b[A-Z][A-Z0-9_]*(?:URL|TOKEN|KEY|SECRET|PASSWORD)\b/gu;

/** Bindings owned by the worker protocol and unavailable for user overrides. */
export const CI_RESERVED_ENVIRONMENT_NAMES = Object.freeze([CI_RELEASE_TAG_ENVIRONMENT, "HUSKY", ...Object.values(CI_RELEASE_ENVIRONMENT)]);

/** Generated Vercel gate; it runs before dependencies are installed. */
export const CI_VERCEL_GATE_FILE = ".beez-rp/vercel-ignore-build.mjs";

/** Relative template path for the dependency-free Vercel gate. */
export const CI_VERCEL_GATE_TEMPLATE = "./templates/vercel-ignore-build.mjs";

/** Template placeholder preserving the project's original ignoreCommand. */
export const CI_VERCEL_IGNORE_PLACEHOLDER = "__ORIGINAL_IGNORE_COMMAND__";

/** Rendered workflow lines quoted when a committed generated workflow drifted from the current configuration. */
export const CI_WORKFLOW_DRIFT_PREVIEW_LINES = 3;

/**
 * Root-relative files that shape what the CI worker runs besides the configured workflow: the
 * configuration modules, the manifest, the project npm config, the Node.js pin and every lockfile.
 * Local preparation reads them from the working tree while the worker checks them out from the
 * release tag, so `--ignore-local-changes` must not set changes to them aside during CI preparation.
 */
export const CI_WORKER_CONFIGURATION_FILES = Object.freeze([
  ...CREATE_VERSION_CONFIG_FILES,
  PACKAGE_MANIFEST_FILE,
  PROJECT_NPM_CONFIG_FILE,
  PINNED_NODE_VERSION_FILE,
  ...LOCKFILE_PACKAGE_MANAGERS.map(([lockfileName]) => lockfileName),
]);

/** Prefix of the `run-name` the generated workflow gives each dispatched release, followed by its tag and commit. */
export const CI_RELEASE_RUN_TITLE_PREFIX = "beez-rp release";

/** Generated workflow step that runs `--ci-release`; its success proves checks, preparation and publication finished. */
export const CI_RELEASE_WORKER_STEP_NAME = "Checks y publicación del release";

/** Environment the worker reads to query its own GitHub Actions history (set by Actions, plus the bound job token). */
export const CI_ACTIONS_HISTORY_ENVIRONMENT = Object.freeze({ apiUrl: "GITHUB_API_URL", repository: "GITHUB_REPOSITORY", token: "GITHUB_TOKEN" });

/** GitHub REST API used when the runner does not provide `GITHUB_API_URL`. */
export const CI_DEFAULT_GITHUB_API_URL = "https://api.github.com";

/** REST API version pinned for the worker's Actions history requests. */
export const CI_GITHUB_API_VERSION = "2022-11-28";

/** Page size of the worker's Actions history requests; one release has far fewer runs, attempts or jobs. */
export const CI_ACTIONS_HISTORY_PAGE_SIZE = 100;

/** Maximum wait for each Actions history request before the worker stops without publishing, in milliseconds. */
export const CI_ACTIONS_HISTORY_TIMEOUT_MS = 30_000;

/** Step conclusion GitHub Actions reports for a step that finished successfully. */
export const CI_STEP_SUCCESS_CONCLUSION = "success";
