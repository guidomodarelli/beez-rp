/**
 * Local npm registry for tests: a real HTTP server that answers the requests
 * the npm CLI makes for `npm whoami` (`/-/whoami`), `npm view` / `npm owner ls`
 * (the packument with its versions and maintainers) and `npm publish` (PUT of
 * the packument). Tokens map to users; a PUT by a user that is not a
 * maintainer gets the 404 the public registry answers. A package can hide its
 * owners: `npm owner ls` then gets a 404, as a registry answers a user without
 * access to a private package.
 *
 * @module tests/create-version/support/fixture-npm-registry
 */

import { createServer } from "node:http";

/** Prefix of the bearer credential npm sends with `_authToken`. */
const BEARER_PREFIX = "Bearer ";

/** Path of the endpoint `npm whoami` queries. */
const WHOAMI_PATH = "-/whoami";

/** Header where the npm CLI names the command that made the request. */
const NPM_COMMAND_HEADER = "npm-command";

/** Value of {@link NPM_COMMAND_HEADER} for `npm owner ls`. */
const OWNER_COMMAND = "owner";

/**
 * @typedef {{ maintainers: string[], versions: string[], hiddenFromOwnerList?: boolean }} FixturePackage
 *   `hiddenFromOwnerList` answers `npm owner ls` with 404 while `npm view` still lists the versions.
 * @typedef {{ packageName: string, version: string, user: string }} FixturePublication
 * @typedef {{
 *   registryUrl: string,
 *   publications: FixturePublication[],
 *   close: () => Promise<void>,
 * }} FixtureRegistry
 */

/**
 * Sends a JSON response.
 *
 * @param {import("node:http").ServerResponse} response - Response.
 * @param {number} statusCode - HTTP status.
 * @param {unknown} body - JSON body.
 */
function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Reads a request body as text.
 *
 * @param {import("node:http").IncomingMessage} request - Request.
 * @returns {Promise<string>} Body.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * Builds the packument npm reads for `npm view` and `npm owner ls`.
 *
 * @param {string} packageName - Package name.
 * @param {FixturePackage} fixturePackage - Versions and maintainers.
 * @returns {Record<string, unknown>} Packument.
 */
function buildPackument(packageName, fixturePackage) {
  return {
    name: packageName,
    "dist-tags": fixturePackage.versions.length > 0 ? { latest: fixturePackage.versions.at(-1) } : {},
    versions: Object.fromEntries(fixturePackage.versions.map((version) => [version, { name: packageName, version }])),
    maintainers: fixturePackage.maintainers.map((maintainer) => ({ name: maintainer, email: `${maintainer}@example.test` })),
  };
}

/**
 * Starts the fixture registry on a random local port.
 *
 * @param {{
 *   users?: Record<string, string>,
 *   packages?: Record<string, FixturePackage>,
 *   rejectPublications?: boolean,
 * }} [options] - `users` maps each accepted token to its npm user; `packages` are the published
 *   packages; `rejectPublications` answers every PUT with 404, as npm does for a token without write access.
 * @returns {Promise<FixtureRegistry>} Running registry.
 */
export async function startFixtureNpmRegistry({ users = {}, packages = {}, rejectPublications = false } = {}) {
  /** @type {Map<string, FixturePackage>} */
  const registryPackages = new Map(Object.entries(packages).map(([name, fixturePackage]) => [name, { ...fixturePackage, maintainers: [...fixturePackage.maintainers], versions: [...fixturePackage.versions] }]));
  /** @type {FixturePublication[]} */
  const publications = [];

  const server = createServer(async (request, response) => {
    const authorization = request.headers.authorization ?? "";
    const user = authorization.startsWith(BEARER_PREFIX) ? (users[authorization.slice(BEARER_PREFIX.length)] ?? null) : null;
    const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://registry.test").pathname.slice(1));

    if (requestPath === WHOAMI_PATH) {
      sendJson(response, user ? 200 : 401, user ? { username: user } : { error: "authentication required" });
      return;
    }

    const fixturePackage = registryPackages.get(requestPath);

    if (request.method === "GET") {
      const visible = fixturePackage && !(fixturePackage.hiddenFromOwnerList && request.headers[NPM_COMMAND_HEADER] === OWNER_COMMAND);
      sendJson(response, visible ? 200 : 404, visible ? buildPackument(requestPath, fixturePackage) : { error: "Not found" });
      return;
    }

    if (request.method === "PUT") {
      const body = JSON.parse(await readBody(request));

      if (!user) {
        sendJson(response, 401, { error: "authentication required" });
        return;
      }

      if (rejectPublications || (fixturePackage && !fixturePackage.maintainers.includes(user))) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }

      const target = fixturePackage ?? { maintainers: [user], versions: [] };
      for (const version of Object.keys(body.versions ?? {})) {
        target.versions.push(version);
        publications.push({ packageName: requestPath, version, user });
      }
      registryPackages.set(requestPath, target);
      sendJson(response, 200, { ok: true });
      return;
    }

    sendJson(response, 405, { error: "method not allowed" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  return {
    registryUrl: `http://127.0.0.1:${port}/`,
    publications,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}
