/**
 * Records and reads, in the release commit itself, where a release was prepared (`local` or `ci`).
 * The mark lives in a commit trailer so it covers every release without adding tracked files that the
 * Vercel build gate would interpret.
 * @module create-version/release-execution
 */

import { RELEASE_EXECUTION, RELEASE_EXECUTION_TRAILER } from "../constants/ci-release.js";
import { ReleaseStepError } from "./errors.js";

/**
 * Builds the trailer paragraph appended to the release commit message.
 * @param {"local" | "ci"} execution - Location where the release commit is prepared.
 * @returns {string} Trailer line such as `Beez-Rp-Execution: ci`.
 */
export function formatReleaseExecutionTrailer(execution) {
  return `${RELEASE_EXECUTION_TRAILER}: ${execution}`;
}

/**
 * Reads the execution location recorded in the trailer of a release commit.
 * Commits created before the trailer existed (or by other tools) have none and yield null.
 * @param {import("./process.js").GitReader} reader - Git reader of the release checkout.
 * @param {string} version - Version of the release commit, used in diagnostics.
 * @param {string} [revision] - Commit holding the trailer; defaults to `HEAD`.
 * @returns {Promise<"local" | "ci" | null>} Recorded location, or null when the commit carries no trailer.
 * @throws {ReleaseStepError} When the commit cannot be read, or its trailers are unknown or contradictory.
 */
export async function readReleaseExecutionTrailer(reader, version, revision = "HEAD") {
  const trailerOutput = await reader.tryGit(["log", "-1", `--format=%(trailers:key=${RELEASE_EXECUTION_TRAILER},valueonly=true)`, revision]);
  if (trailerOutput === null) {
    throw new ReleaseStepError(`No se pudo leer el trailer ${RELEASE_EXECUTION_TRAILER} del commit de release ${version} (${revision}).`, "Revisá el repositorio con git log -1; no se subió ni publicó nada.");
  }
  const recordedValues = [...new Set(trailerOutput.split("\n").map((value) => value.trim()).filter(Boolean))];
  if (recordedValues.length === 0) return null;
  const knownExecutions = /** @type {readonly string[]} */ (Object.values(RELEASE_EXECUTION));
  const [recordedExecution] = recordedValues;
  if (recordedValues.length > 1 || !knownExecutions.includes(recordedExecution)) {
    throw new ReleaseStepError(
      `El commit de release ${version} declara un modo de ejecución inválido en ${RELEASE_EXECUTION_TRAILER}: ${recordedValues.join(", ")} (se espera ${knownExecutions.join(" o ")}).`,
      "Corregilo con un commit de release nuevo; no se subió ni publicó nada."
    );
  }
  return /** @type {"local" | "ci"} */ (recordedExecution);
}
