/**
 * Reads provider metadata without following registry forwarding redirects or exposing upstream bodies.
 *
 * @module create-version/registry-http
 */

import { NPM_LOOKUP_STATUS } from "../constants/create-version.js";
import { GITLAB_REGISTRY_PROVIDER, JSR_REGISTRY_PROVIDER, REGISTRY_LOOKUP_TIMEOUT_MS } from "../constants/registry.js";
import { findHighestStableVersion } from "../versions.js";

/**
 * Fetches versions directly from GitLab or JSR; a forwarding redirect means absent in this registry.
 *
 * @param {{ provider: import("./registry-config.js").RegistryProvider, registryUrl: string, packageName: string, label: string, tag: string | null, options?: { tokenEnv: string } }} registry - Selected registry.
 * @param {string | null} token - Read credential, never included in returned state.
 * @returns {Promise<import("./npm.js").NpmLookup>} Shared published-version contract.
 */
export async function lookupHttpRegistry(registry, token) {
  const baseUrl = registry.registryUrl.endsWith("/") ? registry.registryUrl : `${registry.registryUrl}/`;
  const resource = registry.provider === JSR_REGISTRY_PROVIDER ? `${registry.packageName}/meta.json` : encodeURIComponent(registry.packageName);
  const url = new URL(resource, baseUrl);
  const empty = { status: NPM_LOOKUP_STATUS.ok, publishedVersions: [], latestVersion: null, reason: null, registryLabel: registry.label, tag: registry.tag };
  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { Accept: "application/json", "Cache-Control": "no-cache", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(REGISTRY_LOOKUP_TIMEOUT_MS),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      if (registry.provider === GITLAB_REGISTRY_PROVIDER && !token) {
        return { ...empty, status: NPM_LOOKUP_STATUS.failed, reason: `GitLab: HTTP 404 sin ${registry.options?.tokenEnv ?? "credencial de lectura"}; no se puede distinguir un paquete ausente de un proyecto privado. Definí la credencial antes de diagnosticar.` };
      }
      return empty;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const redirected = location ? new URL(location, url) : null;
      await response.body?.cancel();
      return registry.provider !== JSR_REGISTRY_PROVIDER && redirected && ["registry.npmjs.org", "npmjs.com", "www.npmjs.com"].includes(redirected.hostname)
        ? empty
        : { ...empty, status: NPM_LOOKUP_STATUS.failed, reason: `${registry.label}: la consulta se redirigió fuera del endpoint de metadata; no se confirmó el paquete.` };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ...empty, status: NPM_LOOKUP_STATUS.failed, reason: `${registry.label}: GET de ${registry.packageName} respondió HTTP ${response.status}; revisá el endpoint y los permisos de lectura.` };
    }
    const metadata = /** @type {{ versions?: Record<string, unknown> | string[], "dist-tags"?: Record<string, string> } | null} */ (await response.json());
    const versions = metadata?.versions;
    if (!versions || typeof versions !== "object") {
      return { ...empty, status: NPM_LOOKUP_STATUS.failed, reason: `${registry.label}: no se pudo leer la lista de versiones de ${registry.packageName}.` };
    }
    const publishedVersions = Array.isArray(versions) ? versions : Object.keys(versions);
    const latestVersion = registry.provider === JSR_REGISTRY_PROVIDER
      ? findHighestStableVersion(publishedVersions)
      : metadata?.["dist-tags"]?.[registry.tag ?? "latest"] ?? null;
    return { ...empty, publishedVersions, latestVersion: typeof latestVersion === "string" ? latestVersion : null };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ...empty, status: NPM_LOOKUP_STATUS.failed, reason: `${registry.label}: ${timedOut ? "se agotó el tiempo" : "falló la conexión o la lectura de metadata"} al consultar ${registry.packageName}.` };
  }
}
