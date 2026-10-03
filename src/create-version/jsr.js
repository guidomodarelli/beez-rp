/**
 * Reads and versions native JSR manifests, then publishes with the official JSR or Deno client.
 *
 * @module create-version/jsr
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { PACKAGE_VERSION_FIELD_PATTERN, UNSAFE_QUOTED_PATH_PATTERN } from "../constants/create-version.js";
import { JSR_CHILD_TOKEN_VARIABLE, JSR_CONFIG_FILES, JSR_NPM_CLIENT_SPEC, JSR_PACKAGE_NAME_PATTERN, JSR_SHELL_SAFE_TOKEN_PATTERN } from "../constants/registry.js";
import { ReleaseStepError } from "./errors.js";
import { normalizeJsonc, parseJsoncManifest } from "./jsonc.js";
import { runRedactedInherited, USES_SHELL_FOR_PACKAGE_MANAGERS } from "./process.js";
import { buildNpmPublishEnvironment } from "./npm.js";

/** Strict decoder used for version-only JSONC changes. */
const MANIFEST_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Finds the native JSR manifest inside a package and reads only its publication metadata.
 *
 * @param {string} packageRoot - Package directory.
 * @param {string | null} configFile - Explicit package-relative path, or auto-detection.
 * @returns {{ filePath: string, originalBytes: Buffer, text: string, manifest: Record<string, unknown>, packageName: string }} Native manifest.
 * @throws {Error} When the file is absent, linked outside the package, malformed or unscoped.
 */
export function readJsrManifest(packageRoot, configFile = null) {
  const filePath = configFile ?? JSR_CONFIG_FILES.find((candidate) => existsSync(path.join(packageRoot, candidate)));
  if (!filePath) throw new Error("JSR requiere jsr.json, jsr.jsonc, deno.json o deno.jsonc dentro del paquete");
  const absolutePath = path.join(packageRoot, filePath);
  const relativeRealPath = path.relative(realpathSync(packageRoot), realpathSync(absolutePath));
  if (!lstatSync(absolutePath).isFile() || relativeRealPath.split(path.sep).includes("..") || path.isAbsolute(relativeRealPath)) {
    throw new Error(`${filePath} debe ser un archivo regular dentro del paquete`);
  }
  const originalBytes = readFileSync(absolutePath);
  const text = MANIFEST_UTF8_DECODER.decode(originalBytes);
  const manifest = parseJsoncManifest(text);
  const packageName = manifest.name;
  if (typeof packageName !== "string" || !JSR_PACKAGE_NAME_PATTERN.test(packageName)) {
    throw new Error(`${filePath} debe declarar un nombre JSR con scope (@scope/package)`);
  }
  return { filePath: filePath.replaceAll("\\", "/"), originalBytes, text, manifest, packageName };
}

/**
 * Prepares a native manifest version edit for the same transaction as package.json; never writes it.
 *
 * @param {{ repositoryRoot: string, reader: import("./process.js").GitReader, commands: import("../package-manager.js").ProjectCommands, config?: { versionFiles: string[] } }} context - Release context.
 * @param {string} packageRoot - Package checkout directory.
 * @param {import("./registry-config.js").ResolvedPublicationOptions} options - Native publication options.
 * @param {string} version - New stable version.
 * @returns {Promise<import("./run.js").ReleaseFileUpdate[]>} Transactional native manifest update.
 * @throws {ReleaseStepError} When the manifest is dirty, untracked or lacks a usable top-level version.
 */
export async function prepareJsrVersionUpdates(context, packageRoot, options, version) {
  const native = readJsrManifest(packageRoot, options.configFile);
  const filePath = path.relative(context.repositoryRoot, path.join(packageRoot, native.filePath)).replaceAll("\\", "/");
  if (context.config?.versionFiles.includes(filePath)) throw new ReleaseStepError(`${filePath} ya sincroniza su versión como manifest JSR.`, "Sacalo de versionFiles para que una sola operación gestione su versión; no se escribió nada.");
  const pathspec = `:(literal)${filePath}`;
  const tracked = await context.reader.git(["ls-files", "-z", "--", pathspec]);
  const changed = await context.reader.git(["diff", "--name-only", "HEAD", "--", pathspec]);
  if (!tracked.split("\0").includes(filePath) || changed) {
    throw new ReleaseStepError(`${filePath} debe estar trackeado y sin cambios antes de versionar JSR.`, `Commiteá el manifest y volvé a correr ${context.commands.createVersion}; no se tocó la versión.`);
  }
  const normalized = normalizeJsonc(native.text);
  const match = PACKAGE_VERSION_FIELD_PATTERN.exec(normalized);
  if (!match) throw new ReleaseStepError(`${filePath} no tiene un campo version para sincronizar.`, "Declaralo en el manifest JSR antes de crear el release.");
  const start = match.index + match[1].length;
  const end = match.index + match[0].length - match[2].length;
  const content = `${native.text.slice(0, start)}${version}${native.text.slice(end)}`;
  if (parseJsoncManifest(content).version !== version) {
    throw new ReleaseStepError(`${filePath} tiene una versión anidada antes de la versión principal.`, "Mové version al nivel principal antes de los objetos anidados; no se escribió nada.");
  }
  return [{ filePath, originalBytes: native.originalBytes, content }];
}

/**
 * Publishes with a pinned official client and a selected config; the token is never printed by beez-rp.
 *
 * @param {string} packageRoot - Release checkout.
 * @param {{ registryUrl: string, options: import("./registry-config.js").ResolvedPublicationOptions }} registry - Selected native registry.
 * @param {string | null} token - Personal token, or `null` for browser/OIDC authentication.
 * @param {boolean} [dryRun] - Whether to validate without uploading.
 * @returns {Promise<number>} Official client exit code.
 * @throws {Error} When a shell operand or token cannot be passed safely.
 */
export async function publishToJsr(packageRoot, registry, token, dryRun = false) {
  const native = readJsrManifest(packageRoot, registry.options.configFile);
  const command = registry.options.jsrClient === "deno" ? "deno" : "npx";
  const prefix = registry.options.jsrClient === "deno" ? [] : ["--yes", "--registry=https://registry.npmjs.org/", JSR_NPM_CLIENT_SPEC];
  const args = [...prefix, "publish", "--config", native.filePath, ...(dryRun ? ["--dry-run"] : [])];
  if (args.some((argument) => UNSAFE_QUOTED_PATH_PATTERN.test(argument))) throw new Error("JSR: un argumento del cliente no es seguro para el shell");
  if (token && !JSR_SHELL_SAFE_TOKEN_PATTERN.test(token)) throw new Error("JSR: el token no se puede pasar de forma segura al cliente");
  const env = { ...buildNpmPublishEnvironment(), JSR_URL: registry.registryUrl, DEBUG: "", ...(token ? { [JSR_CHILD_TOKEN_VARIABLE]: token } : {}) };
  if (USES_SHELL_FOR_PACKAGE_MANAGERS) {
    const operands = args.map((argument) => `"${argument}"`).join(" ");
    return runRedactedInherited(`${command} ${operands}${token ? ` --token "%${JSR_CHILD_TOKEN_VARIABLE}%"` : ""}`, [], { cwd: packageRoot, shell: true, env }, token ? [token] : []);
  }
  return runRedactedInherited(command, [...args, ...(token ? ["--token", token] : [])], { cwd: packageRoot, env }, token ? [token] : []);
}
