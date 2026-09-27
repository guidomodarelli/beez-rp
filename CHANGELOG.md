# Changelog

Todos los cambios relevantes de beez-rp se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

### Added

- `artifact` en `beez-rp.config.js`: con `publish: "npm"`, publica exactamente el tarball que dejó el paso `prepare` (por ejemplo `releases/{version}-{sha256}/{name}-{version}.tgz`) en vez de reempaquetar el working tree. Los proyectos lo empaquetan con `npm pack --ignore-scripts`.
- Antes de publicar ese tarball exige que `prepare` no haya modificado archivos versionados, rechaza paquetes que dependen de reescrituras de pnpm al empaquetar (`workspace:`/`catalog:` o campos del manifest en `publishConfig` que solo pnpm sube a la raíz, como `exports`, `main`, `bin` o `types`; cualquier otra clave de `publishConfig` se acepta como configuración de npm), verifica el SHA-256 de su ruta cuando el patrón usa `{sha256}` y compara su SHA-512 con el `integrity` de `npm pack --dry-run --json --ignore-scripts` del commit de release. Durante esa comparación el tarball queda fuera de la raíz del paquete, así que se verifica aunque el paquete no tenga `files` y su carpeta no esté ignorada.
- `beez-rp guard-publish` (y `beez-rp/guard-publish`): guard de `prepublishOnly` que bloquea `pnpm publish`, yarn y bun con un mensaje que indica publicar con `pnpm create-version`; `create-version` quita `npm_config_user_agent` del entorno de `npm publish` para no bloquearse.

### Changed

- `publish: "npm"` usa una config de npm temporal que solo referencia `${NPM_TOKEN}`, asociada al registry donde se publica (`publishConfig["@scope:registry"]` de un paquete con scope, `publishConfig.registry` o `https://registry.npmjs.org/`): los proyectos ya no necesitan `.npmrc` y pnpm deja de advertir por credenciales en el repositorio. La confirmación 2FA de npm sigue siendo interactiva.
- El diagnóstico y la comprobación posterior a publicar consultan las versiones con `npm view --registry` en ese mismo registry, así que un paquete publicado en un registry propio ya no se vuelve a preparar y publicar.

### Removed

- `.npmrc` del repositorio de beez-rp.

## [0.2.0] - 2026-09-26

### Added

- `beez-rp create-version` (y `beez-rp/create-version`): el comando de release compartido por todos los proyectos, configurable con `beez-rp.config.js` (checks, migraciones, preparación, publicación en npm o propia, textos y resumen).
- Retoma en un mismo flujo el push de un commit de versión local y la publicación de una versión que npm todavía no tiene.
- `buildChangelogPrompt` acepta el idioma de las entradas: español por defecto o inglés limitado a ASCII.

### Changed

- El último release es el último commit de `origin/main` que cambió la versión de `package.json`, así que también reconoce releases con otros asuntos o versiones subidas a mano.
- beez-rp se publica con su propio `beez-rp create-version` en lugar de un script aparte.

## [0.1.1] - 2026-09-26

### Added

- Plantilla `.env.example` para configurar el token de npm.

## [0.1.0] - 2026-09-26

### Added

- Reglas de versión compartidas: solo versiones estables `X.Y.Z` y solo la siguiente patch, minor o major, sin saltear, repetir ni bajar versiones.
- Comando `beez-rp ignore-build` para el `ignoreCommand` de Vercel, que buildea solo cuando la versión de `package.json` es la siguiente versión estable válida.
- Módulos `changelog` y `changelog-ai` para liberar el bloque `[Unreleased]` de Keep a Changelog y completarlo con Codex.
- Módulo `terminal-ui` con cajas, spinner y selector interactivo para comandos de release.
- Fixtures `beez-rp/testing` con todas las variantes de versión rechazadas, para los tests de cada proyecto.

