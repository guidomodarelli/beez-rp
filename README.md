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
| `beez-rp/guard-publish` | `decidePublishGuard(userAgent)` del `prepublishOnly` que bloquea publicaciones con pnpm, yarn o bun. |
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

El último release es el último commit de `origin/main` que cambió el `version` de `package.json`, así que sirve con commits `X.Y.Z`, con otros asuntos de release y con versiones subidas a mano. Si algo falla después del commit, volver a correr el comando retoma solo lo que falta: el push de un commit de versión local o, con `registry: "npm"`, la preparación y publicación de una versión que npm todavía no tiene. Las versiones publicadas se consultan con `npm view --registry` en el mismo registry donde se publica (ver abajo), porque `npm view` no aplica el `publishConfig` del `package.json`. Si el `main` local estaba atrás, después de actualizarlo se vuelve a cargar `beez-rp.config.(m)js` y los pasos siguientes usan esa versión; si cambia qué pasos corresponden (checks, preparación, publicación), el registry o las migraciones, el comando corta sin tocar la versión y hay que volver a correrlo.

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

`migrations.check` devuelve `{ status: "up-to-date" | "pending" | "unknown", pending, target, reason }`; después de `apply`, el comando vuelve a llamar a `check` y falla si siguen pendientes. `publish: "npm"` toma `NPM_TOKEN` del entorno o de un `.env` ignorado por Git. No hace falta `.npmrc`: el comando escribe una config de npm temporal fuera del repo que asocia `${NPM_TOKEN}` al registry donde realmente se publica, resuelto como npm desde el `package.json`: `publishConfig["@scope:registry"]` si el paquete tiene ese scope, si no `publishConfig.registry` y, si tampoco está, `https://registry.npmjs.org/` (tiene que ser una URL http(s) válida o no se publica). Solo guarda esa referencia: npm la expande, el token nunca queda en disco ni en la línea de comandos, y la config se borra al terminar. npm hereda la terminal, así que la confirmación 2FA (navegador o código) funciona igual.

Sin `artifact`, `publish: "npm"` publica el working tree. Con `artifact` publica exactamente el tarball que dejó `prepare`. Los proyectos empaquetan siempre con npm: `prepare` construye (con pnpm o lo que use el proyecto) y después corre `npm pack --ignore-scripts`. `npm pack` es reproducible (el mismo commit da siempre los mismos bytes), así que la verificación es una comparación de hash. Después de `prepare` y antes de `npm publish`:

- Working tree: `git status --porcelain --untracked-files=no` tiene que estar vacío. `prepare` puede generar archivos ignorados o no versionados (`dist/`, `releases/`), pero no modificar archivos versionados como `package.json`; así lo que lee npm es exactamente el commit de release.
- Publicable con npm: si el `package.json` depende de algo que solo pnpm reescribe al empaquetar (especificadores `workspace:`, `catalog:` o `jsr:` en `dependencies`, `peerDependencies` u `optionalDependencies`, o campos del manifest dentro de `publishConfig` que pnpm sube a la raíz del `package.json` empaquetado), no se publica. Para npm, `publishConfig` es solo [configuración de npm](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig), así que se acepta cualquier clave (`registry`, `access`, `tag`, `provenance`, `@scope:registry`, `otp`...) salvo las que pnpm aplica al manifest: `name`, `bin`, `engines`, `type`, `imports`, `main`, `module`, `typings`, `types`, `exports`, `browser`, `esnext`, `es2015`, `unpkg`, `umd:main`, `os`, `cpu`, `libc` y `typesVersions` (lista de `PUBLISH_CONFIG_WHITELIST` en pnpm). Declaralos en la raíz del `package.json`.
- Ubicación: el patrón es relativo a la raíz, reemplaza `{version}` (obligatorio) y `{name}` (el nombre de archivo que usa `npm pack`: `@scope/pkg` pasa a `scope-pkg`), y dentro de un segmento acepta `*` y `{sha256}`. Si hay varios, toma el más reciente. La ruta solo puede tener letras, números, `.`, `-`, `_`, `@`, `+`, `~` y `/`.
- `{sha256}`: el SHA-256 del archivo tiene que coincidir con el de su ruta. Puede repetirse en un segmento o en varios; todas las apariciones tienen que declarar el mismo digest.
- Hash: beez-rp corre `npm pack --dry-run --json --ignore-scripts` en la raíz y compara su `integrity` (`sha512-<base64>`) con el SHA-512 del tarball. Durante ese dry run el tarball se mueve a un directorio temporal fuera del paquete y siempre vuelve a su ruta, aunque npm falle: sin una lista `files` ni una regla de `.npmignore`/`.gitignore` que excluya su carpeta, npm lo contaría como parte del paquete y la integrity nunca coincidiría. Después se publica desde su ruta original. Si difieren, el tarball no es lo que npm empaquetaría de este commit (por ejemplo, se armó con otra herramienta o antes de construir) y no se publica. Si npm falla o su salida no se puede leer, tampoco.

Ejemplo de `prepare` que deja `releases/{version}-{sha256}/{name}-{version}.tgz`: `pnpm build`, `npm pack --ignore-scripts --pack-destination releases/<version>-tmp/` y renombrar la carpeta con el SHA-256 del tarball.

Si no hay tarball o la verificación falla, no se publica nada y volver a correr el comando retoma preparación y publicación.

## Bloquear publicaciones con pnpm

`create-version` publica siempre con npm y verifica el tarball contra `npm pack --dry-run`, así que un `pnpm publish` manual saltearía esas garantías. Cada proyecto lo bloquea con:

```json
{ "scripts": { "prepublishOnly": "beez-rp guard-publish" } }
```

`beez-rp guard-publish` lee `npm_config_user_agent`: si empieza con `pnpm/`, `yarn/` o `bun/`, explica por stderr que se publica con `pnpm create-version` y sale con `1`; con `npm/`, sin la variable o con un valor desconocido sale con `0` sin imprimir nada. npm toma un `npm_config_user_agent` heredado como su config `user-agent`, por eso `create-version` lo quita del entorno de `npm publish`: así `pnpm create-version` no se bloquea a sí mismo.

Es una protección contra errores, no un candado: `--ignore-scripts` la esquiva a propósito. Aun así, un tarball empaquetado con pnpm no pasa la verificación de hash de `create-version`.

## Publicar beez-rp

beez-rp se publica con su propio comando (`beez-rp.config.js`: `checks: ["pnpm check"]`, `publish: "npm"`). Su `prepublishOnly` es `node bin/beez-rp.js guard-publish`, porque no se instala a sí mismo:

```bash
pnpm cv
```

## Desarrollo

```bash
pnpm install
pnpm check        # typecheck (JSDoc con checkJs) + tests
pnpm build:types  # genera types/*.d.ts (también corre en prepack)
```
