# beez-rp

Proceso de release compartido por los proyectos Beez (beez-ui, TuTribu, Control Mensual). No tiene dependencias de runtime: solo usa módulos `node:*`, así que `npx` lo descarga y ejecuta en segundos, incluso antes de instalar las dependencias del proyecto.

## Regla de versiones

- Solo existen versiones estables `X.Y.Z`: nunca `-alpha.X`, `-beta.X`, `-rc.X`, metadata `+build`, prefijos (`v1.2.3`) ni ceros a la izquierda.
- Después de una versión solo se permite la siguiente patch, minor o major. De `1.2.3` valen `1.2.4`, `1.3.0` o `2.0.0`.
- No se puede repetir, bajar ni saltear versiones (`1.0.0` → `3.0.0`, `1.2.3` → `1.4.0`), ni subir la minor o la major sin reiniciar las partes menores (`1.2.3` → `1.3.3`).

## Módulos

| Import | Contenido |
| --- | --- |
| `beez-rp/versions` | `isStableReleaseVersion`, `parseReleaseVersion`, `bumpReleaseVersion`, `listNextVersions`, `listAllowedVersionsAfter`, `resolveRequestedVersion` (`--bump` / `--set-version`), `toReleaseTag`, `isReleaseCommitSubject`, `suggestReleaseType`, `suggestNextReleaseType` e `isPreMajorShiftActive` (con `preMajorShift`). |
| `beez-rp/build-gate` | `decideBuild(previousVersion, currentVersion)` y `decideBuildForCheckout(repositoryRoot)` para el `ignoreCommand` de Vercel. |
| `beez-rp/changelog` | Helpers puros de lectura y transformación de texto de changelog; no escriben archivos. `create-version` solo verifica el CHANGELOG manual. |
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

### Elegir local o CI

En una terminal interactiva, `pnpm cv` pregunta dónde ejecutar el release. Si el repo configura `ci.workflow`, **CI queda seleccionado por defecto** y se puede elegir **Local**. Sin configuración, ofrece **Configurar CI automáticamente**, **Continuar en local** o **Cancelar**. Sin terminal conserva el modo local cuando no hay `ci`; con `ci` usa CI. Dentro de un runtime CI nunca despacha otro workflow.

```js
export default {
  checks: ["pnpm run ci"],
  ci: {
    workflow: "release.yml",           // archivo dentro de .github/workflows
    secrets: ["DATABASE_MIGRATION_URL"], // nombres; los valores van en Actions
    variables: [],
    deployment: "vercel",              // opcional: deploy después de los checks
  },
};
```

En **CI**, el proceso local verifica el CHANGELOG manual, el estado de Git, `gh` y las credenciales del worker; elige la versión, hace el bump, crea commit + tag, hace push y dispara el workflow. Omite checks, migraciones, preparación, publicación y hooks de Git locales: esas validaciones se ejecutan en el worker. La terminal informa **enviado a CI**, no publicado.

El worker hace checkout del tag exacto y, antes de configurar herramientas o instalar dependencias (es decir, antes de ejecutar código del proyecto con los secrets y el permiso OIDC del job), un paso que solo usa Git rechaza el release si `tag` no es `v<version>` estable, si no apunta exactamente al `sha` enviado o si ese commit no está en `origin/main`. Después vuelve a comprobar su versión y SHA antes de ejecutar checks, migraciones, preparación y publicación. Usa `--ci-release vX.Y.Z`; nunca vuelve a hacer bump ni push. Un check fallido corta el release. Una versión que el registry ya confirma publicada no se vuelve a publicar. Tampoco se ejecuta un tag anterior a la versión vigente en `origin/main`.

En **Local**, se conserva el flujo completo en la máquina actual, incluidos sus hooks. Se puede elegir por flag:

```bash
pnpm cv --local --bump patch
pnpm cv --ci --bump minor
pnpm cv --setup-ci --bump patch
pnpm cv --ci --dry-run
pnpm cv --retry-ci v1.2.4
```

`--setup-ci` prepara el workflow y agrega `export const ci = ...` al config existente, sin reemplazar sus hooks. Se aceptan tanto un objeto `ci` dentro de `export default` como ese export nombrado; el objeto del default tiene prioridad y un campo ausente o `null` permite usar el export nombrado. Los archivos se incluyen en el mismo commit del bump y se restauran si el commit falla. Los workflows existentes no se sobrescriben: si `ci` ya estaba configurado y el workflow commiteado difiere del que generaría la configuración actual (por ejemplo, un secret o token de publicación nuevo), `--setup-ci` se detiene antes de crear el commit, el tag o el dispatch; regeneralo borrándolo en un commit propio, actualizalo a mano o, si está personalizado a propósito, usá `--ci`. Los archivos que modifica el setup, como `.gitignore`, deben estar commiteados y limpios incluso con `--ignore-local-changes`. El comando detecta el package manager y `.nvmrc`; usa instalación con lockfile congelado (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`/`--immutable` o `bun install --frozen-lockfile`) y una versión predeterminada de pnpm si solo hay lockfile. Por eso `--setup-ci` se detiene antes del bump si HEAD no contiene commiteado un lockfile del package manager detectado (`package-lock.json` o `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` o `bun.lockb`); tenerlo solo en disco no alcanza. Para proyectos con `vercel.json` y sin publisher propio, configura el deploy de Vercel; los nombres de variables explícitos en `migrations.targetHint` se incluyen como secrets del worker.

El workflow recibe tres inputs `string`: `version`, `tag` y `sha`. Debe declarar `workflow_dispatch`, tener un `run-name` como `beez-rp release ${{ inputs.tag }} ${{ inputs.sha }}` y llamar al script `create-version` con `--ci-release`. La configuración automática genera ese contrato. Ejemplo del despacho que hace beez-rp ([GitHub CLI](https://cli.github.com/manual/gh_workflow_run)):

```bash
gh workflow run release.yml --ref main \
  -f version=1.2.4 -f tag=v1.2.4 -f sha=<commit-del-tag>
```

Se requiere `origin` de GitHub, `main` como rama por defecto y `gh auth login` con acceso al repo. Las credenciales de publicación y los nombres de `ci.secrets` / `ci.variables` se comprueban antes del bump, aceptando tanto los del repo como los secrets/variables de organización compartidos con él; si no se pueden listar los de organización, el preflight bloquea indicando los nombres sin verificar. Se configuran con `gh secret set NPM_TOKEN`, por ejemplo. El entorno configurado también está disponible durante la instalación de dependencias privadas. OIDC usa `id-token: write`; GitHub Packages con `GITHUB_TOKEN` usa el token del workflow y `packages: write`. Si JSR selecciona `jsrClient: "deno"`, el workflow instala Deno. Con npm y OIDC, el Node.js que fija `.nvmrc` (o el major local si no existe) debe alcanzar Node >= 22.14.0 antes del bump; con pnpm, Yarn o Bun el workflow instala además npm 11.5.1 solo para publicar; con npm se valida el pin de `packageManager` y, sin pin, el workflow instala npm 11.5.1 después de `npm ci`; además, el registry efectivo (`publication.registryUrl`, `publishConfig` o el `.npmrc` del proyecto) debe ser el público de npm. Otros secretos usados por hooks deben declararse explícitamente. Un estado de migraciones desconocido, antes o después de aplicar, corta el worker. Este protocolo de tag `vX.Y.Z` corresponde al modo de una única versión; los monorepos conservan el modo local.

Si el despacho falla después del push, el tag queda en origin y el error indica `--retry-ci vX.Y.Z`: conserva la misma versión y no repite el push. Antes de despachar, consulta las ejecuciones con el mismo tag y SHA; reutiliza una activa o exitosa. Si una respuesta fallida no permite confirmar la aceptación, pide revisar Actions antes de reenviar y nunca reintenta automáticamente.

Con `deployment: "vercel"`, se necesitan `VERCEL_TOKEN`, `VERCEL_ORG_ID` y `VERCEL_PROJECT_ID` como secrets de Actions. La configuración automática conserva el `ignoreCommand` anterior detrás de un gate sin dependencias, que evita el deploy por Git del release delegado a CI. `.beez-rp/release.json` registra la versión y el destino de ese release; un release local vuelve a usar el gate original. Después de los checks, migraciones y hooks, el workflow obtiene el entorno de producción y recién entonces construye y despliega con `vercel deploy --prebuilt --prod` ([flujo oficial de Vercel](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel)). Un workflow configurado manualmente debe incluir ese gate o desactivar el deploy automático por Git para que producción espere a CI. beez-rp no configura cuentas ni sube secretos desde `.env`.

Funciona con pnpm, bun, npm o yarn: beez-rp detecta el package manager por el campo `packageManager` del `package.json` (por ejemplo `"bun@1.3.11"`), si no por el lockfile (`bun.lock`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`) y, sin ninguno, asume pnpm. Con eso arma los checks por defecto (`bun run ci`) y cada "volvé a correr" de los mensajes (`bun run create-version`; `npm run create-version`; `pnpm` y `yarn` corren el script directo). Los ejemplos de abajo usan pnpm. npm, GitHub Packages y GitLab se publican con el CLI de npm; JSR usa su cliente oficial o Deno.

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

`--ignore-local-changes` no aparta cambios en archivos `.js`, `.mjs`, `.cjs`, `.ts` ni `.json`, ni en ningún `.npmrc`: la configuración ya se cargó desde el working tree y puede depender de ellos, y el diagnóstico ya resolvió el registry y las credenciales desde el `.npmrc`. El plan, también con `--dry-run`, se bloquea y pide commitearlos o guardarlos con `git stash`.

El comando sale solo desde `main`, limpio y al día con origin (solo `CHANGELOG.md` puede quedar sin commitear en un release nuevo, porque el bump lo commitea; para retomar un release ya commiteado, también tiene que estar limpio). En una rama feature explica qué falta: pushear, abrir o mergear el PR (con `gh`). La única excepción es publicar un release que falta en npm desde su tag (ver [Versiones sin publicar](#versiones-sin-publicar)).

1. Si `main` está atrás de origin, lo actualiza en fast-forward y termina (código de salida 0) sin tocar la versión ni los tags: hay que volver a correr `pnpm create-version`, que en un proceso nuevo carga `beez-rp.config.(m)js`, sus módulos y el diagnóstico desde el código actualizado.
2. Verifica que `CHANGELOG.md` exista y haya cambiado desde el último release. Si falta o no fue actualizado, corta con código de salida `1` y lo reporta antes de aplicar migraciones o cambiar la versión, también con `--dry-run` y sin que otros flags salteen la verificación. Se aceptan actualizaciones manuales ya commiteadas, staged o sin stagear. Para el primer release solo se requiere que exista.
3. Aplica migraciones pendientes, si el proyecto tiene adaptador, después de pedir confirmación.
4. Corre los `checks` (por defecto `pnpm run ci`; ver abajo).
5. Pide la versión y crea el commit `X.Y.Z` con el tag anotado `vX.Y.Z`. Incluye el CHANGELOG manual tal como está: nunca lo genera, reescribe, agrega fechas ni mueve bloques. Si un check o hook lo cambia durante el release, corta y reporta ese cambio sin restaurar su contenido.
6. Corre `prepare`, sube `main` y el tag con `git push --atomic` y corre `publish`.

El último release es el último commit de `origin/main` que cambió el `version` de `package.json`, así que sirve con commits `X.Y.Z`, con otros asuntos de release y con versiones subidas a mano. Si algo falla después del commit, volver a correr el comando retoma solo lo que falta: el push de un commit de versión local o, con `registry: "npm"`, la preparación y publicación de una versión que npm todavía no tiene. Las versiones publicadas se consultan con `npm view --registry` en el mismo registry donde se publica (ver abajo), porque `npm view` no aplica el `publishConfig` del `package.json`.

Si un paso falla cuando `main` y el tag ya están en origin (recién pusheados o de antes), el recuadro de error lo dice explícitamente, por ejemplo: "`v1.9.1` ya está en GitHub (main + tag); falta publicar en npm. Corré `pnpm create-version` para reintentar solo la publicación."

### beez-rp.config.js

```js
/** @type {import("beez-rp/create-version").CreateVersionConfig} */
export default {
  projectName: "TuTribu",                       // banner; por defecto el name de package.json
  releaseTypeDescriptions: { patch: "…", minor: "…", major: "…" },
  preMajorShift: true,                          // en 0.x la sugerida baja un nivel (breaking → minor, feat → patch)
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

### Un registry por proyecto

`publish` elige un único destino: `"npm"`, `"github"`, `"gitlab"` o `"jsr"`. `registry` toma ese mismo valor por defecto; consulta las versiones en ese destino para decidir qué falta publicar. `publish: "npm"` conserva su comportamiento y sus defaults anteriores. Una función de `publish` sigue siendo válida para un flujo propio.

```js
export default {
  checks: ["pnpm check"],
  publish: "gitlab",
  publication: {
    registryUrl: "https://gitlab.com/api/v4/projects/123/packages/npm/",
    authentication: "token",
    tokenEnv: "CI_JOB_TOKEN",
    access: "restricted",
    tag: "latest",
  },
};
```

GitHub Packages requiere un `name` con scope en `package.json` (`@owner/package`). Su URL por defecto es `https://npm.pkg.github.com/` y su variable de token por defecto es `GITHUB_TOKEN`; en ejecución local puede contener un PAT classic con permisos de paquetes. La visibilidad del paquete también depende de la configuración de GitHub: `access` no reemplaza esos permisos. GitLab requiere el endpoint del **proyecto** para publicar, también en instalaciones propias. Su variable por defecto es `GITLAB_TOKEN`, configurable como `CI_JOB_TOKEN` o cualquier otra variable mediante `tokenEnv`. Un redirect de GitLab hacia npmjs.com se interpreta como paquete ausente en GitLab; nunca confirma una publicación local.

Los tokens se buscan en el entorno, `.env` del repo y `~/.config/beez-rp/.env`, en ese orden. `tokenEnv` selecciona qué variable leer. Las verificaciones de permisos que el proveedor no expone se muestran como **no verificables**; GitHub y GitLab no necesitan implementar `npm whoami` ni `npm owner ls` para publicar. Si una publicación falla, se consulta el registry elegido antes de declararla pendiente; una versión confirmada no se vuelve a subir.

Para npm con trusted publishing, configurá `publication: { authentication: "oidc" }`. Se verifica el entorno de GitHub Actions o GitLab CI, npm >= 11.5.1 y Node >= 22.14.0; no exige `NPM_TOKEN` para publicar. El paquete debe tener el trusted publisher configurado en npm. La consulta de un paquete privado puede usar una credencial de lectura mediante `tokenEnv`.

```js
export default {
  checks: ["pnpm check"],
  publish: "jsr",
  publication: {
    authentication: "oidc", // GitHub Actions; local: "browser", otro CI: "token"
    configFile: "jsr.json", // también jsr.jsonc, deno.json o deno.jsonc
    jsrClient: "npx",       // cliente oficial fijado a jsr@0.14.3; alternativa: "deno"
  },
};
```

JSR requiere un manifest propio trackeado, con `name` con scope, `version`, `exports` y los demás requisitos del cliente oficial (ESM y licencia). beez-rp sincroniza su versión con `package.json` en el mismo commit, conservando comentarios y formato de JSONC. En monorepos cada paquete publicado tiene su propio manifest dentro de su carpeta. No agregues ese archivo a `versionFiles`: su versión se gestiona automáticamente. Los tarballs y la comprobación contra `npm pack` aplican a los tres destinos compatibles con npm; JSR publica fuentes y confirma la versión en su API nativa. No admite paquetes privados ni dist-tags de npm. El cliente oficial puede descargarse en su caché con `npx`; `jsrClient: "deno"` usa Deno instalado. Los errores del cliente se muestran ocultando el token. El CHANGELOG sigue siendo exclusivamente manual.

El CHANGELOG se mantiene manualmente y no requiere un formato ni secciones específicos. Un release nuevo exige que cambie desde el último release; beez-rp verifica ese requisito y conserva sus bytes. Para retomar un release ya commiteado, el CHANGELOG debe estar limpio incluso con --ignore-local-changes, porque el comando no lo aparta ni restaura. Sin `checks`, un release nuevo corre `<package manager> run ci` (`pnpm run ci`, `bun run ci`…) si el `package.json` declara el script `ci`; si no lo declara, el plan se bloquea para no publicar sin validar. `checks: false` saltea la validación a propósito (por ejemplo, cuando `prepare` ya corre lint, typecheck, tests y build) y una lista vacía no es válida. Los hooks (`migrations.check`, `migrations.apply`, `prepare`, `publish`) reciben `{ repositoryRoot, version, git, run, print, fail }`: `git` lee Git, `run("pnpm x")` corre un comando visible y devuelve su exit code, y `fail(mensaje, qué hacer)` corta el paso con una explicación. El config no necesita importar `beez-rp`.

La versión sugerida sale de los commits: un breaking change (`feat!:` o `BREAKING CHANGE:`) sugiere major, un `feat` (o un asunto como "Add …") minor, y solo arreglos y mantenimiento patch. Con `preMajorShift: true`, mientras la versión es `0.x` la sugerida baja un nivel (breaking → minor, `feat` → patch), la convención de `0.x` que release-please aplica con `bump-minor-pre-major` y `bump-patch-for-minor-pre-major`: así un breaking change en `0.x` no sugiere saltar a `1.0.0`. Las descripciones por defecto de cada opción bajan con ella (patch: arreglos o funcionalidades nuevas compatibles; minor: cambio incompatible; major: salir de `0.x` a `1.0.0`); las que el proyecto definió en `releaseTypeDescriptions` se muestran tal cual. Es solo la sugerida (la estrella y `--accept-suggested`); se puede elegir cualquiera de las tres.

`versionFiles` lista archivos que también llevan la versión, como el `--version` de una CLI o una constante: rutas relativas a la raíz, con `/` o `\` (`.\src\cli.ts` es `src/cli.ts`), sin rutas absolutas, `..`, `package.json` ni `CHANGELOG.md` (el commit de release los incluye y conserva el CHANGELOG sin reescribirlo). En el commit de release solo cambian sus líneas marcadas: una línea con el comentario `beez-rp-version`, o todas las líneas entre `beez-rp-start-version` y `beez-rp-end`. También se aceptan los marcadores de release-please (`x-release-please-version`, `x-release-please-start-version` … `x-release-please-end`), así que un proyecto que viene de release-please no toca sus archivos. Una versión seguida de un punto final (`1.2.3.`) se reescribe; `1.2.3.4` no. Un bloque sin cierre, un cierre sin bloque, un bloque dentro de otro o cerrado con el marcador de la otra herramienta cortan el release con el archivo, la línea y el marcador. Antes de escribir nada, cada archivo tiene que existir como archivo regular (no un symlink), estar trackeado en Git, ser UTF-8 válido y tener al menos una versión marcada; si no, el release se corta sin tocar la versión (release-please lo ignoraría en silencio). Si un paso anterior (por ejemplo, un check con `--fix`) modificó `package.json` o un `versionFiles`, el release también se corta sin tocar la versión, para no llevar ese cambio al commit de release. Si falla una escritura, `git add` o el commit, beez-rp devuelve `package.json` y `versionFiles` a su contenido y staging anteriores, y restaura solo el staging del CHANGELOG; nunca reescribe ni restaura su contenido; si un hook cambia o agrega algo al commit de versión, lo deshace sin crear el tag ni subir nada. Al retomar un release ya commiteado, verifica que los `versionFiles` del commit tengan la versión pendiente antes de subir o publicar, y no retoma mientras `beez-rp.config.(m)js` tenga cambios sin commitear.

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
  packages: "workspaces",                          // los workspaces del package.json raíz, o ["packages/*", "!packages/internal"]
  tagFormat: "{component}-v{version}",             // por defecto: widget-v1.2.0 ({component} es la carpeta; también {name})
  checks: ["bun run ci"],
  prepare: ["bun install --frozen-lockfile", "bun run build"], // una vez para todos los paquetes
  publish: "npm",
};
```

- Paquetes: los workspaces con `name` que no son `private`. Un paquete tiene cambios cuando un commit toca su carpeta, o la de un paquete `private` del que depende (directa o transitivamente, en cualquier campo de dependencias): los paquetes internos suelen ir bundleados en quien los usa, así que un cambio ahí sale con un release de cada consumidor. Los patrones son rutas relativas a la raíz: uno con `..` o absoluto corta el comando, igual que un `package.json` inválido en una carpeta que coincide con un patrón, o uno que no es `private` sin `name` o sin un `version` estable `X.Y.Z` (se indica la ruta y el motivo).
- Último release de cada paquete: el último commit de `origin/main` que cambió el `version` de su `package.json`. Un paquete en `0.0.0` (el placeholder de release-please) nunca salió, salvo que su propio tag apunte a ese commit o que un commit `release: …` lo liste en `0.0.0`: todos sus commits van en su primer release, cuya sugerida no baja con `preMajorShift` (un `feat` da `0.1.0`).
- Versión: por cada paquete con cambios pregunta patch, minor o major (la sugerida por sus commits lleva una estrella) o "No publicar ahora". `--bump` aplica el mismo tipo a todos y `--accept-suggested` toma la sugerida de cada uno; `--set-version` no aplica. Si una versión elegida no es mayor que la más alta publicada en npm (ya está publicada o movería `latest` hacia atrás), si dos paquetes elegidos darían el mismo tag (por ejemplo, dos carpetas `server` con `{component}`), si un tag no es un nombre válido para Git o ya existe en local, se corta sin escribir nada. El CHANGELOG conserva el formato y las secciones elegidas manualmente.
- CHANGELOG: cada paquete elegido debe tener su archivo actualizado manualmente respecto de su último release. Si falta o no cambió, el comando corta y reporta el archivo antes de aplicar migraciones o cambiar versiones. El plan avisa qué paquetes necesitan actualización; un paquete que no se elige no exige notas nuevas. El contenido se incluye en el commit sin reescribirlo ni restaurarlo.
- Las versiones se eligen antes de aplicar migraciones: si no sale ningún paquete, no se toca la base de datos.
- Los `CHANGELOG.md` de los paquetes pueden quedar sin commitear durante el plan, pero antes de escribir el commit de release el comando se corta sin tocar nada si hay algo staged que no es de los paquetes elegidos, o si el `CHANGELOG.md` de un paquete que no sale tiene cambios. Como en un solo paquete, `--ignore-local-changes` no aparta cambios en `.js`, `.mjs`, `.cjs`, `.ts`, `.json` (incluidos los `package.json` de los workspaces) ni `.npmrc`.
- `summary`: una línea con `{version}` o `{name}` se muestra una vez por paquete publicado, con su versión y su nombre; las demás, una sola vez.
- Un solo commit de release (`release: @scope/a@1.2.0, @scope/b@0.3.1`) con un tag anotado por paquete; `main` y los tags suben con `git push --atomic`.
- `versionFiles` sigue siendo relativo a la raíz: cada archivo toma la versión del paquete que lo contiene y solo cambia cuando ese paquete sale (no puede ser el `package.json` ni el `CHANGELOG.md` de un paquete: el commit de release ya los escribe), con las mismas validaciones, el mismo rollback y la misma verificación del commit de release. Al retomar un release no se verifica la versión de esos archivos.
- `prepare` corre una vez (su contexto trae `releases` con nombre, versión y carpeta); `publish: "npm"` publica cada paquete desde su carpeta, en orden de dependencias (primero los que otros instalan). `artifact`, si se usa, es relativo a la carpeta de cada paquete. Con o sin `artifact`, npm no publica si `prepare` modificó archivos versionados o si el `package.json` del paquete usa `workspace:`, `catalog:` o `jsr:` en `dependencies`, `peerDependencies` u `optionalDependencies`. Un `publish` propio corre una vez por paquete.
- Retoma: si el commit de release quedó solo en local, retoma el push y la publicación. Si un release ya está en origin con su tag y falta en npm, lo publica antes de cualquier release nuevo, preparándolo desde su propio commit en un worktree temporal (no hace falta desacoplar HEAD) aunque `main` haya avanzado. Se publica en el registry que resolvió el diagnóstico en el repositorio (también el de un `.npmrc` sin trackear). Si un tag local ya existe y apunta a otro commit que el de release, no se sube nada. Si el paquete cambió de `name` desde su commit de release, ese release no se publica. Una versión menor que la más alta de npm no se publica (movería `latest` hacia atrás) y se avisa. `--skip-unpublished` saltea esos releases pendientes (lo advierte el plan) y planifica el release nuevo.
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
