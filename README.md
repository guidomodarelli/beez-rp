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
| `beez-rp/create-version` | Comando compartido de release: `runCreateVersion`, el planificador puro `buildReleasePlan`, el lector de estado y los tipos de `beez-rp.config.js`. |
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

## create-version

Cada proyecto versiona con el mismo comando y describe sus diferencias en `beez-rp.config.js` (o `beez-rp.config.mjs`, que tiene prioridad y conviene en proyectos sin `"type": "module"`):

```json
{ "scripts": { "create-version": "beez-rp create-version", "cv": "beez-rp create-version" } }
```

```bash
pnpm create-version            # o pnpm cv
pnpm cv --bump patch|minor|major
pnpm cv --set-version X.Y.Z    # solo la siguiente patch, minor o major
pnpm cv --dry-run              # diagnóstico y plan, sin cambiar nada
```

El comando sale solo desde `main`, limpio y al día con origin (solo `CHANGELOG.md` puede quedar sin commitear). En una rama feature explica qué falta: pushear, abrir o mergear el PR (con `gh`).

1. Actualiza `main` desde origin si está atrás.
2. Aplica migraciones pendientes, si el proyecto tiene adaptador, después de pedir confirmación.
3. Si `[Unreleased]` está vacío, lo completa Codex a partir de los commits sin publicar.
4. Corre los `checks`.
5. Pide la versión, pasa `[Unreleased]` a `## [X.Y.Z] - AAAA-MM-DD` y crea el commit `X.Y.Z` con el tag anotado `vX.Y.Z`.
6. Corre `prepare`, sube `main` y el tag con `git push --atomic` y corre `publish`.

El último release es el último commit de `origin/main` que cambió el `version` de `package.json`, así que sirve con commits `X.Y.Z`, con otros asuntos de release y con versiones subidas a mano. Si algo falla después del commit, volver a correr el comando retoma solo lo que falta: el push de un commit de versión local o, con `registry: "npm"`, la preparación y publicación de una versión que npm todavía no tiene.

### beez-rp.config.js

```js
/** @type {import("beez-rp/create-version").CreateVersionConfig} */
export default {
  projectName: "TuTribu",                       // banner; por defecto el name de package.json
  changelog: { audience: "quien usa TuTribu", language: "es" }, // "en": entradas en inglés ASCII
  releaseTypeDescriptions: { patch: "…", minor: "…", major: "…" },
  publishedLabel: "en producción",              // banner: vX.Y.Z en producción
  registry: "npm",                              // retoma y banner según las versiones en npm
  checks: ["pnpm check"],                       // antes de tocar la versión
  migrations: { check, apply, targetHint },     // adaptador de base de datos
  prepare: ["pnpm release:prepare"],            // comandos o función, sobre el commit de versión
  publish: "npm",                               // npm publish con NPM_TOKEN, o una función
  artifact: "releases/{version}-{sha256}/{name}-{version}.tgz", // con "npm": publica ese tarball verificado
  summary: ["Vercel buildea {version}."],       // líneas extra del resumen final
};
```

Solo `changelog.audience` es obligatorio. Los hooks (`migrations.check`, `migrations.apply`, `prepare`, `publish`) reciben `{ repositoryRoot, version, git, run, print, fail }`: `git` lee Git, `run("pnpm x")` corre un comando visible y devuelve su exit code, y `fail(mensaje, qué hacer)` corta el paso con una explicación. El config no necesita importar `beez-rp`.

`migrations.check` devuelve `{ status: "up-to-date" | "pending" | "unknown", pending, target, reason }`; después de `apply`, el comando vuelve a llamar a `check` y falla si siguen pendientes. `publish: "npm"` toma `NPM_TOKEN` del entorno o de un `.env` ignorado por Git. No hace falta `.npmrc`: el comando escribe una config de npm temporal fuera del repo que solo referencia `${NPM_TOKEN}` (npm la expande; el token nunca queda en disco ni en la línea de comandos) y la borra al terminar. npm hereda la terminal, así que la confirmación 2FA (navegador o código) funciona igual.

Sin `artifact`, `publish: "npm"` publica el working tree. Con `artifact` publica exactamente el tarball que dejó `prepare`, después de verificarlo:

- El patrón es relativo a la raíz, reemplaza `{version}` (obligatorio) y `{name}`, y dentro de un segmento acepta `*` y `{sha256}`. Si hay varios, toma el más reciente.
- `{sha256}`: el SHA-256 del archivo tiene que coincidir con el de su ruta.
- Contenido (leído sin herramientas externas): todo bajo `package/`, sin rutas inseguras, dotfiles ni `node_modules`; nada fuera de `files` (salvo los que npm siempre incluye); todos los entrypoints públicos (`exports`, `main`, `types`, `bin`) presentes; nombre y versión iguales a los de `package.json`.

Si no hay tarball o la verificación falla, no se publica nada y volver a correr el comando retoma preparación y publicación.

## Publicar beez-rp

beez-rp se publica con su propio comando (`beez-rp.config.js`: `checks: ["pnpm check"]`, `publish: "npm"`):

```bash
pnpm cv
```

## Desarrollo

```bash
pnpm install
pnpm check        # typecheck (JSDoc con checkJs) + tests
pnpm build:types  # genera types/*.d.ts (también corre en prepack)
```
