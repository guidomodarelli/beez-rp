# Changelog

Todos los cambios relevantes de beez-rp se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

## [0.1.0] - 2026-09-26

### Added

- Reglas de versión compartidas: solo versiones estables `X.Y.Z` y solo la siguiente patch, minor o major, sin saltear, repetir ni bajar versiones.
- Comando `beez-rp ignore-build` para el `ignoreCommand` de Vercel, que buildea solo cuando la versión de `package.json` es la siguiente versión estable válida.
- Módulos `changelog` y `changelog-ai` para liberar el bloque `[Unreleased]` de Keep a Changelog y completarlo con Codex.
- Módulo `terminal-ui` con cajas, spinner y selector interactivo para comandos de release.
- Fixtures `beez-rp/testing` con todas las variantes de versión rechazadas, para los tests de cada proyecto.

