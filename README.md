# beez-rp

Proceso de release compartido por los proyectos Beez (beez-ui, TuTribu, Control Mensual). No tiene dependencias de runtime: solo usa módulos `node:*`, así que `npx` lo descarga y ejecuta en segundos, incluso antes de instalar las dependencias del proyecto.

## Regla de versiones

- Solo existen versiones estables `X.Y.Z`: nunca `-alpha.X`, `-beta.X`, `-rc.X`, metadata `+build`, prefijos (`v1.2.3`) ni ceros a la izquierda.
- Después de una versión solo se permite la siguiente patch, minor o major. De `1.2.3` valen `1.2.4`, `1.3.0` o `2.0.0`.
- No se puede repetir, bajar ni saltear versiones (`1.0.0` → `3.0.0`, `1.2.3` → `1.4.0`), ni subir la minor o la major sin reiniciar las partes menores (`1.2.3` → `1.3.3`).

## Módulos

| Import | Contenido |
| --- | --- |
| `beez-rp/versions` | `isStableReleaseVersion`, `parseReleaseVersion`, `bumpReleaseVersion`, `listNextVersions`, `listAllowedVersionsAfter`, `resolveRequestedVersion` (`--bump` / `--set-version`), `toReleaseTag`, `isReleaseCommitSubject`, `suggestReleaseType`. |
| `beez-rp/build-gate` | `decideBuild(previousVersion, currentVersion)` y `decideBuildForCheckout(repositoryRoot)` para el `ignoreCommand` de Vercel. |
| `beez-rp/changelog` | Lectura y release del bloque `## [Unreleased]` de `CHANGELOG.md` (Keep a Changelog). |
| `beez-rp/changelog-ai` | Prompt e invocación de Codex para completar `[Unreleased]` vacío. |
| `beez-rp/terminal-ui` | Cajas, filas, banner, spinner y selector interactivo sin dependencias. |
| `beez-rp/testing` | Fixtures de versiones permitidas y rechazadas para los tests de cada proyecto. |
| `beez-rp/constants` | Todas las constantes, agrupadas por dominio. |

## Gate de Vercel

`beez-rp ignore-build` compara la versión de `package.json` del commit desplegado con la de `HEAD^`. Imprime el motivo y, como última línea, `BUILD` o `SKIP`, y sale con `0`. Si no puede decidir, sale con `2`.

El `ignoreCommand` de Vercel corre antes de instalar dependencias. Por eso cada proyecto usa un wrapper que buildea solo cuando la última línea es `BUILD`: cualquier otra salida, incluido un fallo de `npx` o de red, saltea el build.

```bash
#!/bin/bash
# scripts/ignore-build.sh — Vercel: exit 0 saltea el build, exit 1 buildea.
set -u
GATE_OUTPUT=$(npx --yes beez-rp@X.Y.Z ignore-build)
GATE_EXIT_CODE=$?
echo "$GATE_OUTPUT"
if [ "$GATE_EXIT_CODE" -eq 0 ] && [ "$(printf '%s\n' "$GATE_OUTPUT" | tail -n 1)" = "BUILD" ]; then
  exit 1
fi
exit 0
```

```json
{ "ignoreCommand": "bash scripts/ignore-build.sh" }
```

## Tests en los proyectos

```ts
import { REJECTED_VERSION_BUMP_CASES, CURRENT_STABLE_VERSION } from "beez-rp/testing";
import { resolveRequestedVersion } from "beez-rp/versions";

it.each(REJECTED_VERSION_BUMP_CASES)("rechaza %s (%j)", (_reason, version) => {
  expect(() => resolveRequestedVersion(CURRENT_STABLE_VERSION, { bump: null, setVersion: version })).toThrow();
});
```

## Publicar beez-rp

```bash
pnpm create-version            # o pnpm cv
pnpm cv --bump patch|minor|major
pnpm cv --set-version X.Y.Z    # solo la siguiente patch, minor o major
pnpm cv --dry-run              # diagnóstico y plan, sin cambiar nada
```

El comando sale solo desde `main`, limpio y al día con origin (solo `CHANGELOG.md` puede quedar sin commitear).

1. Si `[Unreleased]` está vacío, lo completa Codex a partir de los commits sin publicar.
2. Corre `pnpm check`.
3. Pide la versión, pasa `[Unreleased]` a `## [X.Y.Z] - AAAA-MM-DD` y crea el commit `X.Y.Z` con el tag `vX.Y.Z`.
4. Sube `main` y el tag con `git push --atomic`.
5. Publica en npm. El `.npmrc` del repo referencia `${NPM_TOKEN}`, que se toma del entorno o de un `.env` ignorado por Git.

Si algo falla después del commit, volver a correr el comando retoma solo el push o la publicación, sin generar otra versión.

## Desarrollo

```bash
pnpm install
pnpm check        # typecheck (JSDoc con checkJs) + tests
pnpm build:types  # genera types/*.d.ts (también corre en prepack)
```
