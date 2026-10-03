/**
 * Prepares automatic CI setup as rollback-capable files of the release commit.
 * @module create-version/ci-setup
 */

import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CI_CONFIG_EXPORT, CI_DEFAULT_PNPM_VERSION, CI_DEFAULT_YARN_VERSION, CI_PACKAGE_MANAGER_VERSION_PATTERN, CI_RELEASE_TEMPLATE_FILE,
  CI_TEMPLATE_PLACEHOLDER, CI_WORKFLOW_DIRECTORY, DEFAULT_CI_WORKFLOW,
  CI_RELEASE_METADATA_FILE, CI_VERCEL_CLI_VERSION, CI_VERCEL_DEPLOYMENT, CI_VERCEL_SECRETS,
  CI_VERCEL_CONFIG_FILE, CI_VERCEL_GATE_FILE, CI_VERCEL_GATE_TEMPLATE, CI_VERCEL_IGNORE_PLACEHOLDER,
  CI_DENO_JSR_CLIENT, CI_DENO_VERSION,
} from "../constants/ci-release.js";
import { CREATE_VERSION_CONFIG_FILES, PACKAGE_MANIFEST_FILE, PINNED_NODE_VERSION_FILE } from "../constants/create-version.js";
import { ReleaseStepError } from "./errors.js";
import { runCaptured } from "./process.js";
import { GITHUB_REGISTRY_TOKEN_VARIABLE, JSR_REGISTRY_PROVIDER, OIDC_AUTHENTICATION, TOKEN_AUTHENTICATION } from "../constants/registry.js";
import { GIT_LITERAL_PATHSPEC_PREFIX } from "../constants/version-files.js";

/**
 * @typedef {import("./config.js").ResolvedCreateVersionConfig} ResolvedCreateVersionConfig
 * @typedef {import("./run.js").ReleaseFileUpdate} ReleaseFileUpdate
 */

/**
 * Builds the worker's environment from explicit bindings and the selected registry credential.
 * @param {ResolvedCreateVersionConfig} config - Project configuration.
 * @returns {{ secrets: string[], variables: string[], githubToken: boolean, githubTokenWrite: boolean }} Required worker bindings and package permission.
 */
export function describeCiEnvironment(config) {
  const declaredSecrets = config.ci?.secrets ?? [];
  const variables = [...(config.ci?.variables ?? [])];
  const publisherUsesGithubToken = config.publish !== null && typeof config.publish !== "function" && config.publication.authentication === TOKEN_AUTHENTICATION && config.publication.tokenEnv === GITHUB_REGISTRY_TOKEN_VARIABLE;
  const githubToken = publisherUsesGithubToken || declaredSecrets.includes(GITHUB_REGISTRY_TOKEN_VARIABLE);
  const secrets = declaredSecrets.filter((name) => !githubToken || name !== GITHUB_REGISTRY_TOKEN_VARIABLE);
  if (githubToken && variables.includes(GITHUB_REGISTRY_TOKEN_VARIABLE)) throw new ReleaseStepError("GITHUB_TOKEN es una credencial del workflow y no puede declararse en ci.variables.", "Usá ci.secrets para solicitar el token integrado de Actions o elegí otra variable de token.");
  if (config.publish && typeof config.publish !== "function" && config.publication.authentication === TOKEN_AUTHENTICATION && !publisherUsesGithubToken && !secrets.includes(config.publication.tokenEnv)) {
    secrets.push(config.publication.tokenEnv);
  }
  if (config.ci?.deployment === CI_VERCEL_DEPLOYMENT) for (const name of CI_VERCEL_SECRETS) if (!secrets.includes(name)) secrets.push(name);
  if (secrets.some((name) => variables.includes(name))) throw new ReleaseStepError("Una credencial de publicación también figura en ci.variables.", "Guardala solo como secret; no se creó ningún archivo.");
  return { secrets, variables, githubToken, githubTokenWrite: publisherUsesGithubToken };
}

/**
 * Renders a workflow that installs the project's package manager and finishes a pinned release.
 * @param {string} repositoryRoot - Project checkout.
 * @param {ResolvedCreateVersionConfig} config - Release hooks and package manager.
 * @returns {string} GitHub Actions YAML.
 */
export function renderCiReleaseWorkflow(repositoryRoot, config) {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, PACKAGE_MANIFEST_FILE), "utf8"));
  const manager = config.commands.packageManager;
  const pinnedVersion = typeof manifest.packageManager === "string" ? CI_PACKAGE_MANAGER_VERSION_PATTERN.exec(manifest.packageManager)?.[1] : null;
  const nodeSetup = [
    "      - name: Configurar Node.js", "        uses: actions/setup-node@v4", "        with:",
    existsSync(path.join(repositoryRoot, PINNED_NODE_VERSION_FILE)) ? `          node-version-file: '${PINNED_NODE_VERSION_FILE}'` : `          node-version: '${process.versions.node.split(".")[0]}'`,
  ].join("\n");
  let packageSetup;
  if (manager === "pnpm") {
    packageSetup = ["      - name: Configurar pnpm", "        uses: pnpm/action-setup@v4", "        with:", `          version: '${pinnedVersion ?? CI_DEFAULT_PNPM_VERSION}'`, "      - name: Instalar dependencias", "        run: pnpm install --frozen-lockfile"].join("\n");
  } else if (manager === "bun") {
    packageSetup = ["      - name: Configurar Bun", "        uses: oven-sh/setup-bun@v2", ...(pinnedVersion ? ["        with:", `          bun-version: '${pinnedVersion}'`] : []), "      - name: Instalar dependencias", "        run: bun install --frozen-lockfile"].join("\n");
  } else if (manager === "yarn") {
    packageSetup = ["      - name: Configurar Yarn", `        run: npm install --global ${pinnedVersion && Number(pinnedVersion.split(".")[0]) > 1 ? "@yarnpkg/cli-dist" : "yarn"}@${pinnedVersion ?? CI_DEFAULT_YARN_VERSION}`, "      - name: Instalar dependencias", `        run: yarn install ${pinnedVersion && Number(pinnedVersion.split(".")[0]) > 1 ? "--immutable" : "--frozen-lockfile"}`].join("\n");
  } else {
    packageSetup = [...(pinnedVersion ? ["      - name: Configurar npm", `        run: npm install --global npm@${pinnedVersion}`] : []), "      - name: Instalar dependencias", "        run: npm ci"].join("\n");
  }
  const environment = describeCiEnvironment(config);
  const bindings = [
    ...environment.secrets.map((name) => `      ${name}: \${{ secrets.${name} }}`),
    ...environment.variables.map((name) => `      ${name}: \${{ vars.${name} }}`),
    ...(environment.githubToken ? ["      GITHUB_TOKEN: ${{ github.token }}"] : []),
  ];
  const permissions = [
    ...(config.publication.authentication === OIDC_AUTHENTICATION ? ["  id-token: write"] : []),
    ...(environment.githubToken ? [`  packages: ${environment.githubTokenWrite ? "write" : "read"}`] : []),
  ].join("\n");
  const releaseCommand = `${config.commands.createVersion}${manager === "npm" ? " --" : ""} --ci-release "$RELEASE_TAG"`;
  const vercelEnvironment = CI_VERCEL_SECRETS.map((name) => `          ${name}: \${{ secrets.${name} }}`).join("\n");
  const deploymentSetup = config.ci?.deployment === CI_VERCEL_DEPLOYMENT ? ["      - name: Configurar Vercel", `        run: npm install --global vercel@${CI_VERCEL_CLI_VERSION}`, "      - name: Obtener entorno de producción", "        env:", vercelEnvironment, "        run: |", '          vercel pull --yes --environment=production --token="$VERCEL_TOKEN"', "          cp .vercel/.env.production.local .env"].join("\n") : "";
  const deployment = config.ci?.deployment === CI_VERCEL_DEPLOYMENT ? ["      - name: Construir artefacto de producción", "        env:", vercelEnvironment, '        run: vercel build --prod --token="$VERCEL_TOKEN"', "      - name: Desplegar producción después de los checks", "        env:", vercelEnvironment, '        run: vercel deploy --prebuilt --prod --token="$VERCEL_TOKEN"'].join("\n") : "";
  const deno = config.publication.jsrClient === CI_DENO_JSR_CLIENT && config.publish === JSR_REGISTRY_PROVIDER ? ["      - name: Configurar Deno para JSR", "        uses: denoland/setup-deno@v2", "        with:", `          deno-version: '${CI_DENO_VERSION}'`].join("\n") : "";
  return readFileSync(new URL(CI_RELEASE_TEMPLATE_FILE, import.meta.url), "utf8")
    .replace(CI_TEMPLATE_PLACEHOLDER.node, nodeSetup)
    .replace(CI_TEMPLATE_PLACEHOLDER.install, packageSetup)
    .replace(CI_TEMPLATE_PLACEHOLDER.environment, bindings.join("\n"))
    .replace(CI_TEMPLATE_PLACEHOLDER.permissions, permissions)
    .replace(CI_TEMPLATE_PLACEHOLDER.command, releaseCommand)
    .replace(CI_TEMPLATE_PLACEHOLDER.deploymentSetup, deploymentSetup)
    .replace(CI_TEMPLATE_PLACEHOLDER.deployment, deployment)
    .replace(CI_TEMPLATE_PLACEHOLDER.deno, deno);
}

/**
 * Prepares a named CI export and a new workflow without replacing existing project code.
 * Syntax is checked with Node before anything in the project is written.
 * @param {string} repositoryRoot - Checkout whose configuration is already loaded.
 * @param {ResolvedCreateVersionConfig} config - Configuration selecting the default workflow.
 * @param {boolean} [writeConfiguration] - Add a named CI export only when settings were absent.
 * @returns {Promise<ReleaseFileUpdate[]>} Files to include atomically with the bump.
 * @throws {ReleaseStepError} When an existing workflow would be overwritten or configuration cannot be extended.
 */
export async function prepareCiSetupFiles(repositoryRoot, config, writeConfiguration = true) {
  const workflowPath = `${CI_WORKFLOW_DIRECTORY}/${config.ci?.workflow ?? DEFAULT_CI_WORKFLOW}`;
  assertSafeCiPath(repositoryRoot, workflowPath);
  if (existsSync(path.join(repositoryRoot, workflowPath))) throw new ReleaseStepError(`${workflowPath} ya existe; no se reemplazó.`, "Configurá ci.workflow en beez-rp.config.(m)js y verificá que reciba version, tag y sha y ejecute --ci-release.");
  const configFile = CREATE_VERSION_CONFIG_FILES.find((fileName) => existsSync(path.join(repositoryRoot, fileName)));
  if (!configFile || !lstatSync(path.join(repositoryRoot, configFile)).isFile()) throw new ReleaseStepError("No se pudo encontrar una configuración regular para agregar CI.", "Configurá ci.workflow manualmente en beez-rp.config.(m)js.");
  const originalBytes = readFileSync(path.join(repositoryRoot, configFile));
  const content = `${originalBytes.toString("utf8").trimEnd()}\n\n/** GitHub Actions workflow used by create-version. */\nexport const ${CI_CONFIG_EXPORT} = ${JSON.stringify(config.ci)};\n`;
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "beez-rp-ci-config-"));
  try {
    const candidate = path.join(temporaryDirectory, "config.mjs");
    writeFileSync(candidate, content);
    const checked = await runCaptured(process.execPath, ["--check", candidate]);
    if (writeConfiguration && checked.status !== 0) throw new ReleaseStepError("La configuración existente no admite el export ci automático.", "Agregá ci: { workflow: 'release.yml' } a su export default; no se cambió ningún archivo.");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  /** @type {ReleaseFileUpdate[]} */
  const updates = [
    ...(writeConfiguration ? [{ filePath: configFile, originalBytes, content }] : []),
    { filePath: workflowPath, originalBytes: null, content: renderCiReleaseWorkflow(repositoryRoot, config) },
  ];
  if (config.ci?.deployment === CI_VERCEL_DEPLOYMENT) {
    for (const fileName of [".gitignore", CI_VERCEL_CONFIG_FILE, CI_VERCEL_GATE_FILE]) assertSafeCiPath(repositoryRoot, fileName);
    const ignored = path.join(repositoryRoot, ".gitignore");
    const originalIgnoredBytes = existsSync(ignored) ? readFileSync(ignored) : null;
    updates.push({ filePath: ".gitignore", originalBytes: originalIgnoredBytes, content: `${originalIgnoredBytes?.toString("utf8").trimEnd() ?? ""}\n.vercel/\n.env\n` });
    const vercelPath = path.join(repositoryRoot, CI_VERCEL_CONFIG_FILE);
    const originalVercelBytes = readFileSync(vercelPath);
    const vercel = JSON.parse(originalVercelBytes.toString("utf8"));
    if (vercel.ignoreCommand !== undefined && typeof vercel.ignoreCommand !== "string") throw new ReleaseStepError("vercel.json tiene un ignoreCommand que no es un comando válido.", "Corregilo antes de configurar CI; no se cambió ningún archivo.");
    if (existsSync(path.join(repositoryRoot, CI_VERCEL_GATE_FILE))) throw new ReleaseStepError(`${CI_VERCEL_GATE_FILE} ya existe; no se reemplazó.`, "Revisá la configuración de CI existente.");
    const gate = readFileSync(new URL(CI_VERCEL_GATE_TEMPLATE, import.meta.url), "utf8").replace(CI_VERCEL_IGNORE_PLACEHOLDER, () => JSON.stringify(vercel.ignoreCommand ?? null));
    updates.push({ filePath: CI_VERCEL_GATE_FILE, originalBytes: null, content: gate });
    updates.push({ filePath: CI_VERCEL_CONFIG_FILE, originalBytes: originalVercelBytes, content: `${JSON.stringify({ ...vercel, ignoreCommand: `node ${CI_VERCEL_GATE_FILE}` }, null, 2)}\n` });
  }
  if (updates.some((update) => config.versionFiles.includes(update.filePath))) throw new ReleaseStepError("Un archivo de la configuración automática de CI también figura en versionFiles.", "Quitalo de versionFiles antes de configurar CI; no se cambió nada.");
  for (const update of updates.filter((file) => file.originalBytes !== null)) {
    const literalPath = `${GIT_LITERAL_PATHSPEC_PREFIX}${update.filePath}`;
    const tracked = await runCaptured("git", ["ls-files", "--error-unmatch", "--", literalPath], { cwd: repositoryRoot });
    const clean = await runCaptured("git", ["diff", "--quiet", "HEAD", "--", literalPath], { cwd: repositoryRoot });
    if (tracked.status !== 0 || clean.status !== 0) throw new ReleaseStepError(`La configuración automática de CI necesita ${update.filePath} commiteado y limpio.`, "Commiteá esos ajustes o guardalos con git stash antes de configurar CI; --ignore-local-changes no los incluirá en el release.");
  }
  return updates;
}

/**
 * Records the execution mode for the early Vercel build gate without importing project dependencies.
 * @param {string} repositoryRoot - Project root.
 * @param {string} version - Version of the release being committed.
 * @param {"local" | "ci"} execution - Execution location chosen for this release.
 * @returns {ReleaseFileUpdate} Version-scoped metadata included in the bump.
 */
export function prepareCiReleaseMetadata(repositoryRoot, version, execution) {
  assertSafeCiPath(repositoryRoot, CI_RELEASE_METADATA_FILE);
  const metadataPath = path.join(repositoryRoot, CI_RELEASE_METADATA_FILE);
  return { filePath: CI_RELEASE_METADATA_FILE, originalBytes: existsSync(metadataPath) ? readFileSync(metadataPath) : null, content: `${JSON.stringify({ version, execution })}\n` };
}

/**
 * Prevents concurrent editor changes from being overwritten after an interactive version prompt.
 * @param {string} repositoryRoot - Checkout about to receive the bump.
 * @param {ReleaseFileUpdate[]} updates - CI files captured before prompting.
 * @returns {void}
 * @throws {ReleaseStepError} When a captured file changed or a new workflow appeared.
 */
export function assertCiSetupFilesUnchanged(repositoryRoot, updates) {
  for (const update of updates) {
    assertSafeCiPath(repositoryRoot, update.filePath);
    const target = path.join(repositoryRoot, update.filePath);
    const current = existsSync(target) ? readFileSync(target) : null;
    if (update.originalBytes === null ? current !== null : current === null || !update.originalBytes.equals(current)) throw new ReleaseStepError(`${update.filePath} cambió después de preparar la configuración de CI.`, "Conservá esos cambios y volvé a correr el comando; no se escribió el bump ni se reemplazó la configuración.");
  }
}

/**
 * Rejects symlinks anywhere in an owned setup path before writes can leave the checkout.
 * @param {string} repositoryRoot - Trusted checkout root.
 * @param {string} relativePath - Constant or validated relative file path.
 * @returns {void}
 * @throws {ReleaseStepError} When an existing path component is a symlink.
 */
export function assertSafeCiPath(repositoryRoot, relativePath) {
  let current = repositoryRoot;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let entry;
    try { entry = lstatSync(current); } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") break;
      throw new ReleaseStepError(`No se pudo comprobar la ruta ${relativePath} para CI.`, "Revisá los permisos antes de configurar CI; no se escribió nada.", { cause: error });
    }
    if (entry.isSymbolicLink()) throw new ReleaseStepError(`${relativePath} contiene un enlace simbólico.`, "Usá archivos y directorios regulares para configurar CI; no se escribió nada.");
  }
}
