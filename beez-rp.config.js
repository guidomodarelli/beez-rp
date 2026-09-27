/**
 * `beez-rp create-version` configuration of beez-rp itself: validate with
 * `pnpm check`, then publish to npm with `NPM_TOKEN` (environment, `.env` or `~/.config/beez-rp/.env`).
 *
 * @module beez-rp.config
 */

/** @type {import("./src/create-version/config.js").CreateVersionConfig} */
export default {
  changelog: { audience: "quien consume el paquete beez-rp" },
  releaseTypeDescriptions: {
    patch: "Solo arreglos o cambios internos; la API pública no cambia.",
    minor: "Funcionalidades nuevas compatibles; lo existente sigue funcionando igual.",
    major: "Cambio incompatible en la API pública o en el comportamiento del CLI.",
  },
  checks: ["pnpm check"],
  publish: "npm",
  summary: ["Consumidores: pnpm add -D beez-rp@^{version}"],
};
