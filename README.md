# beez-rp

Proceso de release compartido por los proyectos Beez (beez-ui, TuTribu, Control Mensual). No tiene dependencias de runtime: solo usa módulos `node:*`, así que `npx` lo descarga y ejecuta en segundos. Requiere Node 22.15 o posterior, incluso antes de instalar las dependencias del proyecto.

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
| `beez-rp/version-files` | `updateVersionMarkers(content, version)`: reescribe las versiones de las líneas marcadas de `versionFiles`. |
| `beez-rp/package-manager` | `detectPackageManager(root)` (pnpm, bun, npm o yarn) y `describeProjectCommands(packageManager)`: los comandos que beez-rp corre y muestra en ese proyecto. |
| `beez-rp/terminal-ui` | Cajas, filas, banner, spinner y selector interactivo sin dependencias. |
| `beez-rp/create-version` | Comando compartido de release: `runCreateVersion`, el planificador puro `buildReleasePlan`, el lector de estado y los tipos de `beez-rp.config.js`. |
| `beez-rp/module-trace` | `startTracingConfigModules()`: desde código propio, llamalo antes de importar `beez-rp/create-version` o cualquier código del repo. Este subpath no importa nada más que built-ins de Node, así que el registro de módulos empieza antes de que se cargue cualquier módulo de beez-rp o del repo. |
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

Cada proyecto versiona con el mismo comando y describe sus diferencias en `beez-rp.config.js` (o `beez-rp.config.mjs`, que tiene prioridad y conviene en proyectos sin `"type": "module"`).

Funciona con pnpm, bun, npm o yarn: beez-rp detecta el package manager por el campo `packageManager` del `package.json` (por ejemplo `"bun@1.3.11"`), si no por el lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`) y, sin ninguno, asume pnpm. Con eso arma los checks por defecto (`bun run ci`) y cada "volvé a correr" de los mensajes (`bun run create-version`; `npm run create-version`; `pnpm` y `yarn` corren el script directo). Los ejemplos de abajo usan pnpm. Siempre publica con npm, sea cual sea el package manager.

```json
{ "scripts": { "create-version": "beez-rp create-version", "cv": "beez-rp create-version" } }
```

```bash
pnpm create-version            # o pnpm cv
pnpm cv --bump patch|minor|major
pnpm cv --set-version X.Y.Z    # solo la siguiente patch, minor o major
pnpm cv --dry-run              # diagnóstico y plan, sin cambiar nada
pnpm cv --skip-unpublished     # release nuevo aunque el último no esté en npm (lo saltea)
pnpm cv --ignore-local-changes # publica aunque haya cambios sin commitear (se apartan y se restauran)
```

Sin `--bump` ni `--set-version`, el comando pregunta la versión sin ninguna opción preseleccionada: se elige con su número, o con `↑`/`k` y `↓`/`j`/`Tab` más Enter (Enter no hace nada hasta marcar una). La opción que sugieren los commits lleva una estrella, pero no se elige sola. Sin terminal interactiva (CI) hay que pasar `--bump` o `--set-version`.

Si hay cambios sin commitear y son lo único que frena el release, el comando los lista y pregunta si ignorarlos (sin opción preseleccionada); responder que sí equivale a `--ignore-local-changes`. No lo pregunta si entre ellos está `beez-rp.config.(m)js` o un módulo del repo que carga: la configuración ya está cargada y apartarla no cambia lo que usa el release, así que hay que commitearla, descartarla o guardarla con `git stash`. Con `--dry-run` o sin terminal interactiva no pregunta: muestra el bloqueo.

Con `--ignore-local-changes`, los cambios sin commitear (staged, sin stagear y archivos nuevos) se apartan con `git stash` antes del primer paso y se restauran al terminar, también si un paso falla: ni los checks, ni la preparación, ni la publicación los ven, y el commit de versión solo lleva `package.json` y `CHANGELOG.md`. En un release nuevo, `CHANGELOG.md` queda en el working tree porque el bump lo commitea. La restauración es exacta o no toca nada: lo que estaba staged vuelve staged, lo que estaba solo en el working tree vuelve sin stagear y los archivos nuevos vuelven sin trackear. Si alguna parte choca con el commit de versión (por ejemplo, un cambio en la línea `version` de `package.json`), no se escribe nada, la entrada queda en `git stash` y el comando lo avisa; igual que si el proceso se corta, se recuperan con `git stash pop --index`. No se apartan cambios que involucran enlaces simbólicos (un enlace nuevo, borrado, redirigido o que reemplaza otro archivo, staged o no, o un cambio cuya ruta pasa por uno): la configuración ya se cargó siguiéndolos y apartarlos puede cambiar a qué archivos llega cada ruta, así que el comando se corta sin tocar nada y pide commitearlos o descartarlos.

El comando sale solo desde `main`, limpio y al día con origin (solo `CHANGELOG.md` puede quedar sin commitear en un release nuevo, porque el bump lo commitea; para retomar un release ya commiteado, también tiene que estar limpio). En una rama feature explica qué falta: pushear, abrir o mergear el PR (con `gh`). La única excepción es publicar un release que falta en npm desde su tag (ver [Versiones sin publicar](#versiones-sin-publicar)).

1. Si `main` está atrás de origin, lo actualiza en fast-forward y termina (código de salida 0) sin tocar la versión ni los tags: hay que volver a correr `pnpm create-version`, que en un proceso nuevo carga `beez-rp.config.(m)js`, sus módulos y el diagnóstico desde el código actualizado.
2. Aplica migraciones pendientes, si el proyecto tiene adaptador, después de pedir confirmación.
3. Si `[Unreleased]` está vacío, lo completa Codex a partir de los commits sin publicar.
4. Corre los `checks` (por defecto `pnpm run ci`; ver abajo).
5. Pide la versión, pasa `[Unreleased]` a `## [X.Y.Z] - AAAA-MM-DD` y crea el commit `X.Y.Z` con el tag anotado `vX.Y.Z`.
6. Corre `prepare`, sube `main` y el tag con `git push --atomic` y corre `publish`.

El último release es el último commit de `origin/main` que cambió el `version` de `package.json`, así que sirve con commits `X.Y.Z`, con otros asuntos de release y con versiones subidas a mano. Si algo falla después del commit, volver a correr el comando retoma solo lo que falta: el push de un commit de versión local o, con `registry: "npm"`, la preparación y publicación de una versión que npm todavía no tiene. Las versiones publicadas se consultan con `npm view --registry` en el mismo registry donde se publica (ver abajo), porque `npm view` no aplica el `publishConfig` del `package.json`.

Si un paso falla cuando `main` y el tag ya están en origin (recién pusheados o de antes), el recuadro de error lo dice explícitamente, por ejemplo: "`v1.9.1` ya está en GitHub (main + tag); falta publicar en npm. Corré `pnpm create-version` para reintentar solo la publicación."

### beez-rp.config.js

```js
/** @type {import("beez-rp/create-version").CreateVersionConfig} */
export default {
  projectName: "TuTribu",                       // banner; por defecto el name de package.json
  changelog: { audience: "quien usa TuTribu", language: "es" }, // "en": entradas en inglés ASCII
  releaseTypeDescriptions: { patch: "…", minor: "…", major: "…" },
  publishedLabel: "en producción",              // banner: vX.Y.Z en producción
  registry: "npm",                              // retoma y banner según las versiones en npm
  checks: ["pnpm check"],                       // antes de tocar la versión; false para no validar
  migrations: { check, apply, targetHint },     // adaptador de base de datos
  prepare: ["pnpm release:prepare"],            // comandos o función, sobre el commit de versión
  publish: "npm",                               // npm publish con NPM_TOKEN, o una función
  artifact: "releases/{version}-{sha256}/{name}-{version}.tgz", // con "npm": publica ese tarball verificado
  summary: ["Vercel buildea {version}."],       // líneas extra del resumen final
  versionFiles: ["src/cli.ts"],                 // otros archivos con la versión, en el commit de release
};
```

Solo `changelog.audience` es obligatorio. Sin `checks`, un release nuevo corre `<package manager> run ci` (`pnpm run ci`, `bun run ci`…) si el `package.json` declara el script `ci`; si no lo declara, el plan se bloquea para no publicar sin validar. `checks: false` saltea la validación a propósito (por ejemplo, cuando `prepare` ya corre lint, typecheck, tests y build) y una lista vacía no es válida. Los hooks (`migrations.check`, `migrations.apply`, `prepare`, `publish`) reciben `{ repositoryRoot, version, git, run, print, fail }`: `git` lee Git, `run("pnpm x")` corre un comando visible y devuelve su exit code, y `fail(mensaje, qué hacer)` corta el paso con una explicación. El config no necesita importar `beez-rp`.

`versionFiles` lista archivos trackeados en Git (relativos a la raíz, con `/` o `\`) que también llevan la versión, como el `--version` de una CLI o una constante. En el commit de release solo cambian sus líneas marcadas: una línea con el comentario `beez-rp-version`, o todas las líneas entre `beez-rp-start-version` y `beez-rp-end`. También se aceptan los marcadores de release-please (`x-release-please-version`, `x-release-please-start-version` … `x-release-please-end`), así que un proyecto que viene de release-please no toca sus archivos. Si un archivo no existe, no tiene ninguna versión marcada, no está trackeado en Git (por ejemplo, un archivo generado que ignora `.gitignore`), tiene los marcadores de bloque mal emparejados (un inicio sin su fin, un fin sin inicio, un bloque dentro de otro o el fin de la otra herramienta), no es texto UTF-8 válido (por ejemplo, está guardado en ISO-8859-1), tiene otro enlace duro (hacia otra entrada o hacia un archivo fuera del repo, que el release también reescribiría; lo mismo vale para `package.json` y `CHANGELOG.md`) o su ruta pasa por un enlace simbólico, el release se corta antes de tocar la versión e indica el archivo y la línea (release-please lo ignoraría en silencio). Justo antes de escribir la versión, `package.json` y cada archivo de `versionFiles` tienen que ser iguales a `HEAD`: si un paso anterior los cambió (por ejemplo, un check que corre `lint --fix`), el release se corta sin tocar nada en vez de commitear ese cambio junto con la versión. Fuera de la versión, cada archivo se conserva byte a byte (incluido un BOM). Si un archivo no se puede escribir (por ejemplo, de solo lectura), `package.json`, `CHANGELOG.md` y los archivos ya escritos vuelven a su contenido original. Si `package.json`, `CHANGELOG.md` o un archivo de `versionFiles` tiene un atributo `filter` en `.gitattributes`, el release se corta antes de escribir la versión: su filtro clean decidiría qué guarda el commit (la normalización de fin de línea, `text`/`eol`/`core.autocrlf`, sí se acepta). Después del commit de release, y antes de crear el tag, `create-version` verifica que Git haya guardado la versión nueva en cada archivo: si un filtro clean de `.gitattributes` la cambió, se corta sin tag ni push y la próxima corrida vuelve a verificar ese commit. `package.json` y `CHANGELOG.md` no se pueden listar: el commit de release ya los actualiza (tampoco con otras mayúsculas, como `Package.json`, donde el sistema de archivos no las distingue, como en Windows o macOS; donde sí las distingue, es otro archivo y se acepta). Al retomar un commit de release ya creado (por una corrida anterior o a mano), `create-version` no reescribe estos archivos: verifica en ese commit (no en el working tree) que cada uno sea un archivo regular y que sus líneas marcadas ya digan la versión pendiente y, si no, se corta sin subir ni publicar nada. El release usa la configuración commiteada: si `beez-rp.config.(m)js` tiene cambios sin commitear (también si se renombró entre `.js` y `.mjs`, o si el archivo que se carga no está commiteado, como un `beez-rp.config.mjs` ignorado por `.gitignore` que tiene prioridad sobre el `beez-rp.config.js` commiteado), tanto un release nuevo como retomar uno ya commiteado quedan bloqueados (también con `--ignore-local-changes`, que los apartaría recién después de cargarla) hasta commitearlos en una rama, descartarlos o guardarlos con `git stash`. Lo mismo vale para cada módulo del repo que la configuración carga, directa o indirectamente, con `import`, `require` o como JSON (por ejemplo, un helper que arma `versionFiles`, define `migrations` o guarda un valor que usa un hook): Node los deja en caché al cargar la configuración, así que apartarlos no cambia lo que usa el release. Para saber cuáles son, el propio proceso de `create-version` registra, desde antes de cargar la configuración y durante toda la corrida, cada módulo que carga y cada enlace simbólico del repo que sigue para llegar a uno (el módulo mismo o cualquier carpeta de su ruta): también los que la configuración importa según el proceso (sus argumentos, si tiene terminal) y los que un hook o `migrations.check` importan al correr. Esa lista se compara con `HEAD` siempre (aunque `git status` esté limpio) al final del diagnóstico, después de `migrations.check`, y otra vez justo antes de apartar cambios con `--ignore-local-changes` y correr los pasos. Un módulo que se carga por primera vez después de apartar los cambios sale del working tree sin ellos. Cada módulo dentro del repo (salvo los de `node_modules`) tiene que ser igual a `HEAD`: estar commiteado (un override local ignorado o sin trackear que la configuración importa no lo está), ser un archivo regular como en `HEAD` (no un enlace simbólico que lo reemplaza) y tener el mismo contenido, comparado con `git hash-object` sin depender de `git status`, así que también cuenta un cambio oculto con `skip-worktree` o `assume-unchanged`. Cada carpeta de su ruta tiene que ser la de `HEAD` (no un enlace simbólico que la reemplaza), y un módulo que se carga desde fuera del repo (por ejemplo, porque una carpeta del repo es un enlace a otra carpeta externa) también bloquea, salvo las dependencias instaladas en `node_modules` y el propio beez-rp. Un módulo del repo con un atributo `filter` en `.gitattributes` también bloquea, aunque se vea igual a `HEAD`: la comparación pasa por su filtro clean y no por los bytes que cargó Node. Un módulo del repo importado sin su ruta completa (sin extensión o como carpeta, por ejemplo `require("./release/settings")`, que Node resuelve a `settings.js`, `settings.json` o `settings/index.js`) también bloquea: no se puede comprobar qué archivo eligió Node ni si hay un enlace simbólico en el camino, así que hay que importarlo con la ruta completa del archivo (`./release/settings.json`). Lo mismo vale para un módulo del repo (fuera de `node_modules`) importado por un alias `#…` del campo `imports` de `package.json` o por un nombre de paquete (por ejemplo, un paquete del workspace enlazado en `node_modules`): Node solo informa la ruta real del destino, así que un enlace simbólico en el camino (aunque esté ignorado) no se podría revisar; hay que importarlo con su ruta relativa. Los módulos a los que la configuración llega a través de un módulo `data:` (por ejemplo, uno que reexporta un helper del repo por su URL `file:`) cuentan igual que los demás. Si alguno difiere, el plan (también en `--dry-run`) se bloquea nombrando cada módulo y qué cambió. Si Node es anterior a 22.15 (no tiene `module.registerHooks`), o `collectReleaseState` se usa desde código propio sin cargar antes la configuración con `loadCreateVersionConfig`, el plan se bloquea siempre y dice por qué. Si un mismo proceso carga la configuración de varios repos, el diagnóstico de cada uno solo considera los módulos que carga su propia configuración. Si usás `runCreateVersion` o `loadCreateVersionConfig` desde código propio, llamá primero a `startTracingConfigModules()` (de `beez-rp/module-trace`, que no importa nada más que built-ins de Node), antes de importar `beez-rp/create-version` o cualquier código del repo: Node no vuelve a resolver un módulo que ya tiene en caché, así que ni ese módulo importado antes ni lo que él importa quedarían registrados. `loadCreateVersionConfig` registra los módulos por su cuenta si nadie lo hizo antes, pero entonces el plan bloquea `--ignore-local-changes` (sin apartar cambios, `git status` y la comparación con `HEAD` siguen aplicando igual) y dice cómo arreglarlo. La CLI ya empieza el registro antes de importar nada. Mientras corren los pasos del release (migraciones, checks, `prepare`, `publish`), un módulo que se carga por primera vez (que el diagnóstico nunca vio) tiene que cumplir las mismas reglas: dentro del repo (fuera de `node_modules`), estar trackeado, ser igual a `HEAD` (con los cambios locales ya apartados), no tener atributo `filter` ni marca `skip-worktree` o `assume-unchanged`, e importarse por su ruta relativa completa, sin enlaces simbólicos en el camino; fuera del repo, ser una dependencia instalada (dentro de una carpeta `node_modules`) o el propio beez-rp. Si un hook importa al correr un módulo que no cumple, el paso falla antes de evaluarlo y dice qué archivo commitear o dejar de importar. Límite: un archivo que la configuración lee con `fs` en vez de importarlo no es un módulo y no se detecta. Como `git status` y `git stash` no ven los cambios locales de un archivo trackeado marcado con `skip-worktree` o `assume-unchanged` (`git update-index`), cualquier archivo así que difiera de `HEAD` (por su contenido, porque se reemplazó por otro tipo de archivo, como un enlace simbólico, o por su permiso de ejecución donde Git lo registra, con `core.fileMode` activo, y solo el del dueño, el único que Git mira; en Windows suele estar apagado y ese permiso no se compara; un submódulo, si su checkout está en otro commit que el registrado o tiene cambios propios, también archivos sin trackear, según su `git status`, aunque el submódulo los oculte con `status.showUntrackedFiles=no`, y uno sin inicializar solo si su carpeta no está vacía), que falte en el working tree (por ejemplo, porque quedó fuera de un sparse checkout: los checks y `npm publish` lo omitirían; se arregla con `git sparse-checkout disable`) o que tenga un atributo `filter` en `.gitattributes` (aunque se vea igual a `HEAD`: el filtro clean puede ocultar un cambio que los checks y `npm publish` sí usan) bloquea el release (también con `--ignore-local-changes`) hasta quitarle la marca y commitear o descartar el cambio. Esto cubre también los archivos de `versionFiles`: la verificación de que sean iguales a `HEAD` antes de escribir la versión usa `git diff`, que no ve esos cambios ocultos. Además, si `package.json`, `CHANGELOG.md` o un archivo de `versionFiles` tiene una de esas marcas (aunque sea igual a `HEAD`), el release se corta antes de escribir la versión y dice cómo quitarla (`git update-index --no-skip-worktree` y `git update-index --no-assume-unchanged`): deshacer un commit de release fallido le quitaría la marca. Si stagear o commitear el release falla (por ejemplo, lo rechaza un hook `pre-commit` o Git no puede armar el árbol del índice), `package.json`, `CHANGELOG.md` y los archivos de `versionFiles` vuelven solos a su contenido y a su staging anteriores; el resto del índice no se toca, así que conserva sus marcas (`skip-worktree`, `assume-unchanged`, sparse checkout). El commit de release tiene que guardar exactamente lo que `create-version` stageó: si un hook `pre-commit` o `commit-msg` stagea otro archivo (por ejemplo, la configuración) o modifica y vuelve a stagear uno del release (por ejemplo, un formateador que reescribe `package.json` o un archivo de `versionFiles`), el commit se deshace sin tag ni push, los archivos del release vuelven a su estado anterior y los cambios en otros archivos quedan en staging para revisarlos. Lo mismo pasa si el hook modifica un archivo del release, u otro archivo trackeado que estaba igual a `HEAD` (también uno marcado con `skip-worktree` o `assume-unchanged`, que se compara directo con `HEAD`), sin stagearlo: el commit guardaría lo preparado pero `prepare` y `npm publish` usarían los bytes del working tree, así que el commit se deshace sin tag ni push, los archivos del release vuelven a su contenido anterior y los demás cambios quedan en el working tree para revisarlos.

```ts
program.version("1.4.0"); // beez-rp-version
```

`migrations.check` devuelve `{ status: "up-to-date" | "pending" | "unknown", pending, target, reason }`; después de `apply`, el comando vuelve a llamar a `check` y falla si siguen pendientes. `publish: "npm"` toma `NPM_TOKEN` de una sola búsqueda, compartida por el diagnóstico, `npm view` y la publicación (ver [Token de npm](#token-de-npm)). No hace falta `.npmrc`: el comando escribe una config de npm temporal fuera del repo que asocia `${NPM_TOKEN}` al registry donde realmente se publica, resuelto como npm: `publishConfig["@scope:registry"]` si el paquete tiene ese scope, si no `publishConfig.registry` y, si el `package.json` no declara ninguno, lo que devuelve `npm config get @scope:registry` (paquete con scope) o `npm config get registry` en la raíz del repo, que incluye el `.npmrc` del proyecto, las variables `npm_config_*` y la config global (como la publicación, no lee `~/.npmrc`, que se reemplaza por la config temporal); tiene que ser una URL http(s) válida o no se publica. Con `NPM_TOKEN` disponible, el diagnóstico también consulta `npm view` con esa config temporal, así que funciona con paquetes privados; sin token consulta sin autenticar. El resumen final enlaza a npmjs.com solo si el registry es `https://registry.npmjs.org/`; si no, muestra `Registro: <url>` con el paquete y la versión. Solo guarda esa referencia: npm la expande, el token nunca queda en disco ni en la línea de comandos, y la config se borra al terminar. npm hereda la terminal, así que la confirmación 2FA (navegador o código) funciona igual.

Sin `artifact`, `publish: "npm"` publica el working tree. Con `artifact` publica exactamente el tarball que dejó `prepare`. Los proyectos empaquetan siempre con npm: `prepare` construye (con pnpm o lo que use el proyecto) y después corre `npm pack --ignore-scripts`. `npm pack` es reproducible (el mismo commit da siempre los mismos bytes), así que la verificación es una comparación de hash. Después de `prepare` y antes de `npm publish`:

- Working tree: `git status --porcelain --untracked-files=no` tiene que estar vacío. `prepare` puede generar archivos ignorados o no versionados (`dist/`, `releases/`), pero no modificar archivos versionados como `package.json`; así lo que lee npm es exactamente el commit de release.
- Publicable con npm: si el `package.json` depende de algo que solo pnpm reescribe al empaquetar (especificadores `workspace:`, `catalog:` o `jsr:` en `dependencies`, `peerDependencies` u `optionalDependencies`, o campos del manifest dentro de `publishConfig` que pnpm sube a la raíz del `package.json` empaquetado), no se publica. Para npm, `publishConfig` es solo [configuración de npm](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig), así que se acepta cualquier clave (`registry`, `access`, `tag`, `provenance`, `@scope:registry`, `otp`...) salvo las que pnpm aplica al manifest: `name`, `bin`, `engines`, `type`, `imports`, `main`, `module`, `typings`, `types`, `exports`, `browser`, `esnext`, `es2015`, `unpkg`, `umd:main`, `os`, `cpu`, `libc` y `typesVersions` (lista de `PUBLISH_CONFIG_WHITELIST` en pnpm). Declaralos en la raíz del `package.json`.
- Ubicación: el patrón es relativo a la raíz, reemplaza `{version}` (obligatorio) y `{name}` (el nombre de archivo que usa `npm pack`: `@scope/pkg` pasa a `scope-pkg`), y dentro de un segmento acepta `*` y `{sha256}`. Si hay varios, toma el más reciente. La ruta solo puede tener letras, números, `.`, `-`, `_`, `@`, `+`, `~` y `/`.
- `{sha256}`: el SHA-256 del archivo tiene que coincidir con el de su ruta. Puede repetirse en un segmento o en varios; todas las apariciones tienen que declarar el mismo digest.
- Hash: beez-rp corre `npm pack --dry-run --json --ignore-scripts` en la raíz y compara su `integrity` (`sha512-<base64>`) con el SHA-512 del tarball. Durante ese dry run el tarball se mueve a un directorio temporal fuera del paquete y siempre vuelve a su ruta, aunque npm falle: sin una lista `files` ni una regla de `.npmignore`/`.gitignore` que excluya su carpeta, npm lo contaría como parte del paquete y la integrity nunca coincidiría. Después se publica desde su ruta original. Si difieren, el tarball no es lo que npm empaquetaría de este commit (por ejemplo, se armó con otra herramienta o antes de construir) y no se publica. Si npm falla o su salida no se puede leer, tampoco.

Ejemplo de `prepare` que deja `releases/{version}-{sha256}/{name}-{version}.tgz`: `pnpm build`, `npm pack --ignore-scripts --pack-destination releases/<version>-tmp/` y renombrar la carpeta con el SHA-256 del tarball.

Si no hay tarball o la verificación falla, no se publica nada y volver a correr el comando retoma preparación y publicación.

### Token de npm

`NPM_TOKEN` se busca en este orden y se usa el primero que esté definido (no vacío):

1. La variable de entorno `NPM_TOKEN`.
2. El `.env` del repo (ignorado por Git).
3. `~/.config/beez-rp/.env` (en Windows, `%USERPROFILE%\.config\beez-rp\.env`), compartido por todos los proyectos.

Para tener un solo token en todos los proyectos, guardalo solo en el archivo compartido y sacá `NPM_TOKEN` de los `.env` de cada repo (que tienen prioridad):

```bash
mkdir -p ~/.config/beez-rp
printf 'NPM_TOKEN=%s\n' "<token>" > ~/.config/beez-rp/.env
chmod 600 ~/.config/beez-rp/.env
```

El token nunca se escribe en disco ni en la línea de comandos, ni se carga en el `process.env` del comando: solo lo recibe el proceso de npm por su entorno, y la config temporal lo referencia como `${NPM_TOKEN}`. Los mensajes dicen de qué fuente salió, nunca el valor.

### Credenciales antes de publicar

Cuando el plan incluiría la publicación con `publish: "npm"` (release nuevo o retomado), el diagnóstico verifica las credenciales antes de tocar nada, con la misma config temporal y el mismo registry que `npm publish`, y las muestra en la fila `npm auth` (por ejemplo `guidomodarelli (.env del repo), dueño de <paquete>; permiso de escritura del token no verificable antes de publicar`):

- Sin token: bloquea y explica dónde definir `NPM_TOKEN`.
- `.npmrc` del proyecto con credenciales para ese registry (`//host/path/:_authToken`, `_auth`, `_password`, etc.): bloquea, porque npm las prioriza sobre la config temporal y autenticaría con ellas en vez de `NPM_TOKEN`. Solo se leen las claves, nunca los valores.
- `npm whoami --registry <registry>` responde 401/403: bloquea porque el token (de la fuente que corresponda) es inválido o venció.
- `npm owner ls <paquete> --registry <registry>`: si el paquete no existe (E404) es la primera publicación y sigue; si existe y el usuario no está entre los dueños, bloquea con el usuario y los dueños. En un paquete con scope de organización solo advierte, porque el acceso puede venir de un equipo.
- Si la verificación no puede decidir (red, registry sin `npm owner ls`, un `.env` o `.npmrc` que existe pero no se puede leer), advierte y publica igual. Un `.env` ilegible también hace fallar la consulta de `npm view`, que bloquea el diagnóstico nombrando el archivo.

`npm whoami` y `npm owner ls` corren con `--json=false`, así que su salida sigue siendo texto aunque el proyecto active `json=true` (o `npm_config_json=true`).

Límite: que el usuario sea dueño del paquete no prueba que el token pueda escribir. Un token read-only o granular sin permiso de escritura sobre el paquete pasa `npm whoami` y `npm owner ls`, y npm no ofrece una forma sin efectos de verificarlo antes de publicar (`npm publish --dry-run` no autentica). Por eso la fila lo aclara sin bloquear, y ese caso recién falla en `npm publish`, después de pushear el commit y el tag.

`npm publish` hereda la terminal (para el 2FA), así que su salida no se puede leer. Si termina con error, el comando vuelve a verificar las credenciales y explica el motivo: token inválido, usuario sin permisos sobre el paquete o, si el usuario es dueño, el error genérico, que menciona que el token puede ser read-only o granular sin permiso de escritura. Un `404 Not Found` de npm en el PUT suele significar falta de permisos.

### Versiones sin publicar

Con `registry: "npm"`, si la versión del último release (`package.json` en `origin/main`) es estable, no está en npm y es mayor que la última publicada, el comando no crea un release nuevo ni retoma un commit de versión local de otra versión, porque la saltearía. Si npm no tiene ninguna versión, solo bloquea cuando ese release tiene su tag `vX.Y.Z` (una versión inicial sin tag no es un release). El bloqueo explica cómo publicarla:

```bash
git switch --detach vX.Y.Z
pnpm create-version   # prepara (si corresponde) y publica X.Y.Z; no sincroniza ni pushea main
git switch main
pnpm create-version   # ahora sí, el release nuevo
```

Con HEAD desacoplado el comando solo corre cuando HEAD es exactamente el commit del tag `vX.Y.Z`, su asunto es `X.Y.Z` y esa versión falta en npm. Además bloquea si el tag no está en origin o apunta ahí a otro commit (volvé a `main` y corré `pnpm create-version`, que retoma el push) y si la versión no es mayor que la versión estable más alta de npm, porque publicarla con `--tag latest` movería `latest` hacia atrás. Si el release no se puede retomar así (otro asunto o sin tag), hay que publicarlo a mano. `--skip-unpublished` crea el release nuevo igual, a propósito, y lo advierte en el plan.

## Bloquear publicaciones con pnpm

`create-version` publica siempre con npm y verifica el tarball contra `npm pack --dry-run`, así que un `pnpm publish` manual saltearía esas garantías. Cada proyecto lo bloquea con:

```json
{ "scripts": { "prepublishOnly": "beez-rp guard-publish" } }
```

`beez-rp guard-publish` lee `npm_config_user_agent`: si empieza con `pnpm/`, `yarn/` o `bun/`, explica por stderr que se publica con el create-version de ese package manager (`pnpm create-version`, `yarn create-version` o `bun run create-version`) y sale con `1`; con `npm/`, sin la variable o con un valor desconocido sale con `0` sin imprimir nada. npm toma un `npm_config_user_agent` heredado como su config `user-agent`, por eso `create-version` lo quita del entorno de `npm publish`: así `pnpm create-version` no se bloquea a sí mismo.

Es una protección contra errores, no un candado: `--ignore-scripts` la esquiva a propósito. Aun así, un tarball empaquetado con pnpm no pasa la verificación de hash de `create-version`.

## Publicar beez-rp

beez-rp se publica con su propio comando (`beez-rp.config.js`: `checks: ["pnpm check"]`, `publish: "npm"`). Su `prepublishOnly` es `node bin/beez-rp.js guard-publish`, porque no se instala a sí mismo:

```bash
pnpm cv
```

## Desarrollo

```bash
pnpm install
pnpm check        # oxlint (.oxlintrc.json) + typecheck (JSDoc con checkJs) + tests
pnpm build:types  # genera types/*.d.ts (también corre en prepack)
```
