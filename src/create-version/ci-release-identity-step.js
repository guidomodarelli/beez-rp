/**
 * Renders the dependency-free workflow step that authenticates a dispatched release before any
 * project-controlled code (package installation, lifecycle scripts, hooks) runs with the job's
 * publication secrets and OIDC permission.
 * @module create-version/ci-release-identity-step
 */

import { CI_COMMIT_SHA_PATTERN, CI_RELEASE_ENVIRONMENT, CI_RELEASE_IDENTITY_STEP_NAME, CI_RELEASE_TAG_ENVIRONMENT, CI_RELEASE_VERSION_SHELL_PATTERN } from "../constants/ci-release.js";
import { MAIN_BRANCH, RELEASE_REMOTE } from "../constants/create-version.js";
import { RELEASE_TAG_PREFIX } from "../constants/versions.js";

/** Indentation of a `run: |` body inside a generated job step. */
const STEP_SCRIPT_INDENT = "          ";

/**
 * Builds the Bash script that mirrors the identity rules of `readCiReleaseIdentity` using only Git:
 * the tag must be the stable tag of the dispatched version, resolve exactly to the dispatched commit
 * (which must also be the checked-out HEAD), and that commit must already be in `origin/main`.
 * Raw inputs are never echoed before their format is validated, so they cannot inject workflow commands.
 * @returns {string[]} Script lines without indentation.
 */
function buildIdentityScript() {
  const tag = `$${CI_RELEASE_TAG_ENVIRONMENT}`;
  const version = `$${CI_RELEASE_ENVIRONMENT.version}`;
  const sha = `$${CI_RELEASE_ENVIRONMENT.sha}`;
  const mainRef = `refs/remotes/${RELEASE_REMOTE}/${MAIN_BRANCH}`;
  return [
    "set -euo pipefail",
    'fail() { echo "::error title=Release no autorizado::$1"; exit 1; }',
    `version_pattern='${CI_RELEASE_VERSION_SHELL_PATTERN}'`,
    `sha_pattern='${CI_COMMIT_SHA_PATTERN.source}'`,
    `[[ "${version}" =~ $version_pattern ]] || fail "El input version no es una versión estable X.Y.Z; no se instaló nada."`,
    `[[ "${tag}" == "${RELEASE_TAG_PREFIX}${version}" ]] || fail "El input tag no es el tag de release ${RELEASE_TAG_PREFIX}${version}; no se instaló nada."`,
    `[[ "${sha}" =~ $sha_pattern ]] || fail "El input sha no es un commit completo; no se instaló nada."`,
    `git fetch --no-tags --quiet ${RELEASE_REMOTE} "+refs/heads/${MAIN_BRANCH}:${mainRef}" || fail "No se pudo traer ${RELEASE_REMOTE}/${MAIN_BRANCH} para verificar ${tag}."`,
    `tag_sha="$(git rev-parse --verify --quiet "refs/tags/${tag}^{commit}")" || fail "${tag} no existe como tag en ${RELEASE_REMOTE}."`,
    `[[ "$tag_sha" == "${sha}" ]] || fail "${tag} apunta a $tag_sha, no al commit ${sha} enviado."`,
    `[[ "$(git rev-parse HEAD)" == "${sha}" ]] || fail "El checkout no está en el commit ${sha} de ${tag}."`,
    `git merge-base --is-ancestor "${sha}" "${mainRef}" || fail "El commit ${sha} de ${tag} no está en ${RELEASE_REMOTE}/${MAIN_BRANCH}."`,
  ];
}

/**
 * Renders the identity step placed right after checkout and before any toolchain or dependency setup.
 * Inputs reach the script only through step environment variables, never through `${{ }}` interpolation.
 * @returns {string} Workflow YAML for one step, indented for the release job.
 */
export function renderCiReleaseIdentityStep() {
  return [
    `      - name: ${CI_RELEASE_IDENTITY_STEP_NAME}`,
    "        env:",
    `          ${CI_RELEASE_ENVIRONMENT.version}: \${{ inputs.version }}`,
    `          ${CI_RELEASE_ENVIRONMENT.sha}: \${{ inputs.sha }}`,
    `          ${CI_RELEASE_TAG_ENVIRONMENT}: \${{ inputs.tag }}`,
    "        run: |",
    ...buildIdentityScript().map((line) => `${STEP_SCRIPT_INDENT}${line}`),
  ].join("\n");
}
