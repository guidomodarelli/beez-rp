# Changelog

Todos los cambios relevantes de beez-rp se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

### Added

- `artifact` en `beez-rp.config.js`: con `publish: "npm"`, publica exactamente el tarball que dejó el paso `prepare` (por ejemplo `releases/{version}-*/{name}-{version}.tgz`) en vez de reempaquetar el working tree.

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

