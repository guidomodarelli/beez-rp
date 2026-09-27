/**
 * Pure explanations of the npm credential check of `beez-rp create-version`:
 * the blocker the planner shows before anything is touched, and the error of a
 * failed `npm publish`, whose output cannot be parsed because npm inherits the
 * terminal (2FA). They name where `NPM_TOKEN` came from, never the token.
 *
 * @module create-version/npm-auth
 */

import {
  NPM_AUTH_RERUN_ACTION,
  NPM_AUTH_STATUS,
  NPM_NOT_FOUND_CODE,
  NPM_PUBLISH_RETRY_ACTION,
  NPM_PUT_NOT_FOUND_NOTE,
  NPM_TOKEN_LOCATIONS,
  NPM_TOKEN_SOURCE_LABEL,
  NPM_TOKEN_VARIABLE,
} from "../constants/create-version.js";

/**
 * @typedef {import("./npm.js").NpmAuthCheck} NpmAuthCheck
 * @typedef {{ title: string, details: string[] }} NpmAuthProblem
 */

/**
 * Names the source of the token for messages.
 *
 * @param {NpmAuthCheck} npmAuth - Check result.
 * @returns {string} Source label, or a generic name when it is unknown.
 */
export function describeNpmTokenSource(npmAuth) {
  return npmAuth.source ? NPM_TOKEN_SOURCE_LABEL[/** @type {keyof typeof NPM_TOKEN_SOURCE_LABEL} */ (npmAuth.source)] ?? npmAuth.source : NPM_TOKEN_VARIABLE;
}

/**
 * Describes the owners npm reported, for the not-owner messages.
 *
 * @param {NpmAuthCheck} npmAuth - Check result.
 * @returns {string} Comma-separated owners, or a placeholder when npm listed none.
 */
function describeOwners(npmAuth) {
  return npmAuth.owners.length > 0 ? npmAuth.owners.join(", ") : "ninguno visible";
}

/**
 * Builds the title and the fix of a credential problem.
 *
 * @param {NpmAuthCheck} npmAuth - Check result.
 * @param {string} nextAction - What to run once fixed.
 * @returns {{ title: string, reason: string | null, fix: string } | null} Problem, or `null` when the check does not block.
 */
function describeCredentialProblem(npmAuth, nextAction) {
  const sourceLabel = describeNpmTokenSource(npmAuth);

  switch (npmAuth.status) {
    case NPM_AUTH_STATUS.missingToken:
      return { title: `Falta ${NPM_TOKEN_VARIABLE} para publicar ${npmAuth.packageName}`, reason: null, fix: `Definilo en ${NPM_TOKEN_LOCATIONS} y ${nextAction}.` };
    case NPM_AUTH_STATUS.invalidToken:
      return {
        title: `El ${NPM_TOKEN_VARIABLE} (${sourceLabel}) es inválido o venció`,
        reason: `${npmAuth.reason ?? "npm whoami rechazó el token"} (registry ${npmAuth.registryUrl}).`,
        fix: `Generá uno nuevo con permiso de publicación (npm → Access Tokens), reemplazalo (${sourceLabel}) y ${nextAction}.`,
      };
    case NPM_AUTH_STATUS.notOwner:
      return {
        title: `El token autentica como ${npmAuth.user}, que no puede publicar ${npmAuth.packageName} (dueños: ${describeOwners(npmAuth)})`,
        reason: `${npmAuth.reason ? `${npmAuth.reason} ` : ""}Origen del token: ${sourceLabel}.`,
        fix: `Usá el token de un dueño o pedí que te agreguen (npm owner add ${npmAuth.user} ${npmAuth.packageName}) y ${nextAction}.`,
      };
    default:
      return null;
  }
}

/**
 * Explains an npm credential check that must stop the release before anything is touched.
 *
 * @param {NpmAuthCheck} npmAuth - Result of `checkNpmPublishAccess`.
 * @returns {NpmAuthProblem | null} Blocker, or `null` when the check passed or could not decide (`unknown`).
 */
export function describeNpmAuthProblem(npmAuth) {
  const problem = describeCredentialProblem(npmAuth, NPM_AUTH_RERUN_ACTION);
  return problem ? { title: problem.title, details: [...(problem.reason ? [problem.reason] : []), problem.fix] } : null;
}

/**
 * Warns about a first publication that cannot be told apart from a hidden package: `npm view` and
 * `npm owner ls` answered E404, which is what a registry answers both for a new package and for a
 * private package the token has no access to.
 *
 * @param {NpmAuthCheck} npmAuth - Result of `checkNpmPublishAccess`, confirmed against `npm view`.
 * @returns {string | null} Warning, or `null` when the check is not a first publication.
 */
export function describeNpmFirstPublicationWarning(npmAuth) {
  if (npmAuth.status !== NPM_AUTH_STATUS.ok || !npmAuth.firstPublication) {
    return null;
  }

  return `El registry ${npmAuth.registryUrl} no muestra ${npmAuth.packageName} (npm view y npm owner ls responden ${NPM_NOT_FOUND_CODE}): se toma como primera publicación. Si ya existe como paquete privado, el token (${describeNpmTokenSource(npmAuth)}) no tiene acceso y npm publish va a fallar después de crear y pushear el commit y el tag.`;
}

/**
 * Explains a failed `npm publish` from the credential check re-run after it: an invalid token, a
 * user without permission on the package or, when the credentials are fine, the generic failure.
 *
 * @param {NpmAuthCheck} npmAuth - Result of `checkNpmPublishAccess` after the failure.
 * @param {{ exitCode: number, version: string }} publication - npm exit code and version being published.
 * @returns {{ message: string, hint: string }} Spanish message and next action for `ReleaseStepError`.
 */
export function describeNpmPublishFailure(npmAuth, { exitCode, version }) {
  const failed = `npm publish terminó con código ${exitCode}`;
  const problem = describeCredentialProblem(npmAuth, NPM_PUBLISH_RETRY_ACTION);

  if (problem) {
    const notFoundNote = npmAuth.status === NPM_AUTH_STATUS.notOwner ? `${NPM_PUT_NOT_FOUND_NOTE} ` : "";
    return { message: `${failed}: ${problem.title}.`, hint: `${notFoundNote}${problem.fix}` };
  }

  const credentials =
    npmAuth.status === NPM_AUTH_STATUS.ok
      ? `Las credenciales (${describeNpmTokenSource(npmAuth)}) autentican como ${npmAuth.user} y pueden publicar ${npmAuth.packageName}.`
      : `No se pudieron verificar las credenciales (${npmAuth.reason ?? "motivo desconocido"}).`;
  return { message: `${failed}.`, hint: `Comprobá en npm si ${version} llegó; si no, ${NPM_PUBLISH_RETRY_ACTION}. ${credentials} ${NPM_PUT_NOT_FOUND_NOTE}` };
}
