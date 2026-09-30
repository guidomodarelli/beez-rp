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
| `beez-rp/version-files` | `updateVersionMarkers(content, version)`: reescribe las versiones de las líneas marcadas de `versionFiles`. |
| `beez-rp/package-manager` | `detectPackageManager(root)` (pnpm, bun, npm o yarn) y `describeProjectCommands(packageManager)`: los comandos que beez-rp corre y muestra en ese proyecto. |
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
pnpm cv --accept-suggested     # toma la versión sugerida por los commits sin preguntar
```

Sin `--bump` ni `--set-version`, el comando pregunta la versión sin ninguna opción preseleccionada: se elige con su número, o con `↑`/`k` y `↓`/`j`/`Tab` más Enter (Enter no hace nada hasta marcar una). La opción que sugieren los commits lleva una estrella, pero no se elige sola. Sin terminal interactiva (CI) hay que pasar `--bump` o `--set-version`.

Si hay cambios sin commitear y son lo único que frena el release, el comando los lista y pregunta si ignorarlos (sin opción preseleccionada); responder que sí equivale a `--ignore-local-changes`. Con `--dry-run` o sin terminal interactiva no pregunta: muestra el bloqueo.

Con `--ignore-local-changes`, los cambios sin commitear (staged, sin stagear y archivos nuevos) se apartan con `git stash` antes del primer paso y se restauran al terminar, también si un paso falla: ni los checks, ni la preparación, ni la publicación los ven, y el commit de versión solo lleva `package.json`, `CHANGELOG.md` y `versionFiles`. En un release nuevo, `CHANGELOG.md` queda en el working tree porque el bump lo commitea. La restauración es exacta o no toca nada: lo que estaba staged vuelve staged, lo que estaba solo en el working tree vuelve sin stagear y los archivos nuevos vuelven sin trackear. Si alguna parte choca con el commit de versión (por ejemplo, un cambio en la línea `version` de `package.json`), no se escribe nada, la entrada queda en `git stash` y el comando lo avisa; igual que si el proceso se corta, se recuperan con `git stash pop --index`.

`--ignore-local-changes` no aparta cambios en archivos `.js`, `.mjs`, `.cjs`, `.ts` ni `.json`: la configuración ya se cargó desde el working tree y puede depender de ellos. El plan, también con `--dry-run`, se bloquea y pide commitearlos o guardarlos con `git stash`.

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

`versionFiles` lista archivos que también llevan la versión, como el `--version` de una CLI o una constante: rutas relativas a la raíz, con `/` o `\` (`.\src\cli.ts` es `src/cli.ts`), sin rutas absolutas, `..`, `package.json` ni `CHANGELOG.md` (el commit de release ya los escribe). En el commit de release solo cambian sus líneas marcadas: una línea con el comentario `beez-rp-version`, o todas las líneas entre `beez-rp-start-version` y `beez-rp-end`. También se aceptan los marcadores de release-please (`x-release-please-version`, `x-release-please-start-version` … `x-release-please-end`), así que un proyecto que viene de release-please no toca sus archivos. Una versión seguida de un punto final (`1.2.3.`) se reescribe; `1.2.3.4` no. Un bloque sin cierre, un cierre sin bloque, un bloque dentro de otro o cerrado con el marcador de la otra herramienta cortan el release con el archivo, la línea y el marcador. Antes de escribir nada, cada archivo tiene que existir como archivo regular (no un symlink), estar trackeado en Git, ser UTF-8 válido y tener al menos una versión marcada; si no, el release se corta sin tocar la versión (release-please lo ignoraría en silencio). Si un paso anterior (por ejemplo, un check con `--fix`) modificó `package.json` o un `versionFiles`, el release también se corta sin tocar la versión, para no llevar ese cambio al commit de release. Si falla una escritura, `git add` o el commit, beez-rp devuelve `package.json`, `CHANGELOG.md` y `versionFiles` a su contenido y staging anteriores; si un hook cambia o agrega algo al commit de versión, lo deshace sin crear el tag ni subir nada. Al retomar un release ya commiteado, verifica que los `versionFiles` del commit tengan la versión pendiente antes de subir o publicar, y no retoma mientras `beez-rp.config.(m)js` tenga cambios sin commitear.

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

### Monorepo

Con `packages` en el config, cada paquete publicable del monorepo tiene su propia versión, su `CHANGELOG.md`, su tag y su publicación:

```js
export default {
  changelog: { audience: "quien consume {name}" }, // {name}: el paquete de cada CHANGELOG
  packages: "workspaces",                          // los workspaces del package.json raíz, o ["packages/*", "!packages/internal"]
  tagFormat: "{component}-v{version}",             // por defecto: widget-v1.2.0 ({component} es la carpeta; también {name})
  checks: ["bun run ci"],
  prepare: ["bun install --frozen-lockfile", "bun run build"], // una vez para todos los paquetes
  publish: "npm",
};
```

- Paquetes: los workspaces con `name` que no son `private`. Un paquete tiene cambios cuando un commit toca su carpeta, o la de un paquete `private` del que depende (directa o transitivamente, en cualquier campo de dependencias): los paquetes internos suelen ir bundleados en quien los usa, así que un cambio ahí sale con un release de cada consumidor.
- Último release de cada paquete: el último commit de `origin/main` que cambió el `version` de su `package.json`.
- Versión: por cada paquete con cambios pregunta patch, minor o major (la sugerida por sus commits lleva una estrella) o "No publicar ahora". `--bump` aplica el mismo tipo a todos y `--accept-suggested` toma la sugerida de cada uno; `--set-version` no aplica.
- `[Unreleased]` vacío: Codex lo completa en la carpeta del paquete, solo con sus commits.
- Un solo commit de release (`release: @scope/a@1.2.0, @scope/b@0.3.1`) con un tag anotado por paquete; `main` y los tags suben con `git push --atomic`.
- `versionFiles` sigue siendo relativo a la raíz: cada archivo toma la versión del paquete que lo contiene y solo cambia cuando ese paquete sale, con las mismas validaciones, el mismo rollback y la misma verificación del commit de release. Al retomar un release no se verifica la versión de esos archivos, y `--ignore-local-changes` no bloquea los cambios en `.js`, `.mjs`, `.cjs`, `.ts` ni `.json`.
- `prepare` corre una vez (su contexto trae `releases` con nombre, versión y carpeta); `publish: "npm"` publica cada paquete desde su carpeta, en orden de dependencias (primero los que otros instalan). `artifact`, si se usa, es relativo a la carpeta de cada paquete. Un `publish` propio corre una vez por paquete.
- Retoma: si el commit de release quedó solo en local, retoma el push y la publicación. Si un release ya está en origin con su tag y falta en npm, lo publica antes de cualquier release nuevo, preparándolo desde su propio commit en un worktree temporal (no hace falta desacoplar HEAD) aunque `main` haya avanzado. Una versión menor que la más alta de npm no se publica (movería `latest` hacia atrás) y se avisa.
- No aplican `ignore-build` ni la publicación desde HEAD desacoplado.

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
