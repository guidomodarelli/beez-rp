# Changelog

Todos los cambios relevantes de beez-rp se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

### Added

- Modo monorepo: con `packages: "workspaces"` (o patrones como `["packages/*"]`) en `beez-rp.config.(m)js`, cada paquete publicable tiene su versión, su `CHANGELOG.md`, su tag (`{component}-v{version}` por defecto, configurable con `tagFormat`) y su publicación. Solo salen los paquetes con commits en su carpeta (sin contar los de un paquete publicable anidado dentro, que salen con ese paquete) o en la de un paquete `private` que usan, y un paquete recién agregado con su versión inicial y sin tag, o que sigue en `0.0.0` (el placeholder de release-please) sin su tag ni un commit de release que lo liste, se ofrece en su primer release; por cada uno se elige la versión (con la sugerida marcada, o "No publicar ahora"), Codex completa su `[Unreleased]` vacío con sus propios commits, y todo va en un solo commit de release con un tag por paquete. Se publica en orden de dependencias y, si un release quedó sin publicar en npm, se retoma desde su propio commit aunque `main` haya avanzado, en el registry que resolvió el diagnóstico (también el de un `.npmrc` sin trackear); `--skip-unpublished` lo saltea a propósito. No publica si `prepare` modificó archivos versionados o si un paquete usa `workspace:`/`catalog:`/`jsr:` en sus dependencias publicadas, no sube un tag local que apunte a otro commit y rechaza patrones de paquetes que salen del repositorio y `package.json` inválidos en los workspaces, incluidos los de paquetes publicables sin un `version` estable `X.Y.Z`. Corta sin escribir nada si una versión elegida no es mayor que la más alta publicada en npm (ya publicada, o movería `latest` hacia atrás), si dos paquetes darían el mismo tag o si un tag no es un nombre válido para Git o ya existe en local, y no publica un release pendiente cuyo paquete cambió de `name` desde su commit. Las versiones se eligen antes de aplicar migraciones; el commit de release no se crea si hay algo staged fuera de los paquetes elegidos o si el `CHANGELOG.md` de un paquete que no sale tiene cambios (el de un paquete que sale puede quedar sin commitear, también en carpetas con caracteres no ASCII); `--ignore-local-changes` no aparta cambios en `.js`, `.mjs`, `.cjs`, `.ts`, `.json` (tampoco los `package.json` de los workspaces) ni `.npmrc`, y cada línea de `summary` con `{version}` o `{name}` se muestra una vez por paquete publicado; sin `publish`, el resumen final dice que los paquetes salieron sin publicar. El diagnóstico se corta si no existe `origin/main` o si no puede listar los tags de `origin`, en vez de dar todo por al día; `versionFiles` no acepta el `package.json` ni el `CHANGELOG.md` de un paquete, y el release (también fuera del modo monorepo) se corta sin escribir si un `package.json` tiene un campo `"version"` anidado antes del de primer nivel.
- `preMajorShift: true` en `beez-rp.config.(m)js`: mientras la versión es `0.x`, la versión sugerida baja un nivel (un breaking change sugiere minor y un `feat` patch), como `bump-minor-pre-major` y `bump-patch-for-minor-pre-major` de release-please. Las descripciones por defecto de patch, minor y major en la pregunta de versión bajan con ella (las definidas en `releaseTypeDescriptions` se respetan). Sin la opción, las sugerencias no cambian. `beez-rp/versions` expone `suggestNextReleaseType` e `isPreMajorShiftActive`.
- `--accept-suggested` toma la versión que sugieren los commits sin preguntar (en un monorepo, la de cada paquete), también sin terminal interactiva.
- `versionFiles` en `beez-rp.config.(m)js`: rutas relativas a la raíz (con `/` o `\`, sin `package.json` ni `CHANGELOG.md`) de archivos que también llevan la versión y se actualizan en el commit de release. Solo cambian las líneas marcadas con `beez-rp-version` o los bloques `beez-rp-start-version` … `beez-rp-end` (también los marcadores de release-please); un bloque mal cerrado corta el release indicando archivo y línea. Cada archivo tiene que existir como archivo regular (no symlink), estar trackeado en Git, ser UTF-8 y tener al menos una versión marcada, o el release se corta antes de tocar la versión; también si un check modificó `package.json` o alguno de esos archivos. Si falla la escritura o el commit, o un hook cambia el commit de versión, se restauran los archivos y su staging sin crear tag. Al retomar un release commiteado, se verifica que esos archivos ya tengan la versión antes de subir o publicar.
- Soporte de bun, npm y yarn además de pnpm: beez-rp detecta el package manager por el campo `packageManager` del `package.json` o, si falta, por el lockfile (sin ninguno asume pnpm, como hasta ahora). Los checks por defecto corren con ese package manager (`bun run ci`) y todos los mensajes indican su comando (`bun run create-version`, `npm run create-version`), incluido el de `guard-publish`. El nuevo módulo `beez-rp/package-manager` expone `detectPackageManager` y `describeProjectCommands`.

### Changed

- `--ignore-local-changes` ya no aparta cambios en archivos `.js`, `.mjs`, `.cjs`, `.ts` ni `.json`, ni en ningún `.npmrc`: la configuración y el registry ya se resolvieron con ellos, así que el plan (también con `--dry-run`) pide commitearlos o guardarlos con `git stash`.

## [0.5.0] - 2026-09-27

### Added

- `create-version --ignore-local-changes` publica aunque haya cambios sin commitear: los aparta con `git stash` (staged, sin stagear y archivos nuevos) mientras corre el release, así no llegan a los checks, la preparación, la publicación ni al commit de versión, y los restaura al terminar, también si un paso falla: lo staged vuelve staged, lo del working tree vuelve sin stagear y los archivos nuevos vuelven sin trackear. Si algo choca con el commit de versión no toca nada y deja la entrada en `git stash`. Sin el flag, si esos cambios son lo único que frena el release, el comando pregunta si ignorarlos (sin opción preseleccionada); con `--dry-run` o sin terminal interactiva muestra el bloqueo, que sugiere el flag.

### Changed

- El prompt de versión ya no preselecciona ninguna opción: hay que elegir una con su número o con las flechas, y Enter no hace nada hasta entonces. La versión sugerida sigue marcada con una estrella. Sin terminal interactiva, un release nuevo exige `--bump` o `--set-version` y corta antes de correr cualquier paso.

## [0.4.0] - 2026-09-27

### Changed

- Un release nuevo ya no se publica sin validar: si `beez-rp.config.(m)js` no define `checks`, corre `pnpm run ci` cuando el `package.json` declara el script `ci`, y si no lo declara el plan se bloquea y explica cómo agregarlo. `checks: false` saltea la validación a propósito (por ejemplo, cuando `prepare` ya valida) y `checks: []` deja de ser válido.

## [0.3.1] - 2026-09-27

### Added

- Con `publish: "npm"`, el diagnóstico verifica las credenciales antes de tocar nada cuando el plan publicaría: falta `NPM_TOKEN`, token inválido o vencido (`npm whoami` con 401/403) o usuario que no es dueño del paquete (`npm owner ls`) cortan con un bloqueo que dice qué hacer; un paquete que `npm owner ls` no encuentra (E404) solo es la primera publicación si `npm view` tampoco lista versiones: si las lista, el token no tiene acceso y bloquea; si ninguno lo muestra, sigue con una advertencia porque también podría ser un paquete privado sin acceso. La fila `npm auth` muestra el usuario y de dónde salió el token, nunca el valor, y aclara que el permiso de escritura del token no se puede verificar antes de publicar (un token read-only o granular sin escritura pasa la verificación).
- `NPM_TOKEN` también se lee de `~/.config/beez-rp/.env`, compartido por todos los proyectos, después de la variable de entorno y del `.env` del repo.
- Si el último release no está en npm y es mayor que la última versión publicada, `create-version` no crea un release nuevo que lo saltee: explica cómo publicarlo con `git switch --detach vX.Y.Z` y `pnpm create-version`, que con HEAD desacoplado en ese tag solo prepara y publica (sin sincronizar ni pushear `main`). `--skip-unpublished` crea el release nuevo igual, con una advertencia. Lo mismo vale para retomar un commit de versión local de otra versión. Desde el tag desacoplado solo publica si el commit ya está en origin (si el tag existe solo en local y `origin/main` ya tiene su commit, sube únicamente el tag antes de publicar; si en origin apunta a otro commit, bloquea) y si la versión es mayor que la versión estable más alta de npm y que la versión a la que apunta el dist-tag `latest` (aunque sea un prerelease), para no mover `latest` hacia atrás.

### Changed

- Si `npm publish` falla, vuelve a verificar las credenciales y explica si el token es inválido, si el usuario no puede publicar el paquete (un 404 en el PUT suele significar eso) o, si es dueño, el error genérico, que menciona un token read-only o granular sin permiso de escritura como causa posible.
- Si un paso falla cuando `main` y el tag ya están en origin, el recuadro de error dice que el release ya está en GitHub (o en origin) y que solo falta publicar.
- El diagnóstico, `npm view` y la publicación resuelven `NPM_TOKEN` con una sola búsqueda y ya no lo cargan en el entorno del proceso: solo lo recibe el proceso de npm.

### Fixed

- Las variables de entorno que se pasan a los comandos con salida capturada (como `npm config get`) ahora llegan al proceso hijo.
- La verificación de credenciales reconoce al dueño aunque el proyecto active la salida JSON global de npm (`json=true`): `npm whoami` y `npm owner ls` corren con `--json=false`.
- Un `.env` (del repo o compartido) que existe pero no se puede leer ya no aborta el diagnóstico: la consulta de npm falla con el bloqueo habitual y nombra el archivo, sin mostrar su contenido.
- Si el `.npmrc` del proyecto define credenciales para el registry de publicación, el diagnóstico bloquea antes de publicar: npm las prioriza sobre `NPM_TOKEN` y la verificación habría autenticado con ellas. Solo cuentan los campos que eligen la credencial HTTP (`_authToken`, `_auth`, `_password`, `username`): un `keyfile` o `certfile` de TLS no bloquea.
- La verificación de credenciales y la publicación descartan las variables `npm_config_*` heredadas con credenciales de npm (por ejemplo `npm_config_//registry/:_authToken`, en cualquier capitalización), que npm prioriza sobre la config temporal: autentican siempre con el `NPM_TOKEN` elegido.

## [0.3.0] - 2026-09-27

### Added

- `artifact` en `beez-rp.config.js`: con `publish: "npm"`, publica exactamente el tarball que dejó el paso `prepare` (por ejemplo `releases/{version}-{sha256}/{name}-{version}.tgz`) en vez de reempaquetar el working tree. Los proyectos lo empaquetan con `npm pack --ignore-scripts`.
- Antes de publicar ese tarball exige que `prepare` no haya modificado archivos versionados, rechaza paquetes que dependen de reescrituras de pnpm al empaquetar (`workspace:`/`catalog:`/`jsr:` o campos del manifest en `publishConfig` que solo pnpm sube a la raíz, como `exports`, `main`, `bin` o `types`; cualquier otra clave de `publishConfig` se acepta como configuración de npm), verifica el SHA-256 de su ruta cuando el patrón usa `{sha256}` y compara su SHA-512 con el `integrity` de `npm pack --dry-run --json --ignore-scripts` del commit de release. Durante esa comparación el tarball queda fuera de la raíz del paquete, así que se verifica aunque el paquete no tenga `files` y su carpeta no esté ignorada.
- `beez-rp guard-publish` (y `beez-rp/guard-publish`): guard de `prepublishOnly` que bloquea `pnpm publish`, yarn y bun con un mensaje que indica publicar con `pnpm create-version`; `create-version` quita `npm_config_user_agent` del entorno de `npm publish` para no bloquearse.

### Changed

- `publish: "npm"` usa una config de npm temporal que solo referencia `${NPM_TOKEN}`, asociada al registry donde se publica (`publishConfig["@scope:registry"]` de un paquete con scope, `publishConfig.registry` o, si no hay, el registry que resuelve la config de npm en el repo: `.npmrc` del proyecto, variables de entorno o config global): los proyectos ya no necesitan `.npmrc` y pnpm deja de advertir por credenciales en el repositorio. La confirmación 2FA de npm sigue siendo interactiva.
- El diagnóstico y la comprobación posterior a publicar consultan las versiones con `npm view --registry` en ese mismo registry, así que un paquete publicado en un registry propio ya no se vuelve a preparar y publicar. Con `NPM_TOKEN` (entorno o `.env`) esa consulta se autentica con la misma config temporal, así que también funciona con paquetes privados.
- El resumen final enlaza a npmjs.com solo cuando se publicó en `https://registry.npmjs.org/`; en otro registry muestra `Registro: <url>` con el paquete y la versión.

### Removed

- `.npmrc` del repositorio de beez-rp.

### Fixed

- Si `main` estaba atrás de `origin/main`, `create-version` lo actualiza y termina sin tocar la versión ni los tags (código de salida 0), pidiendo volver a correr `pnpm create-version`: así el diagnóstico, el plan, las migraciones y `beez-rp.config.(m)js` con sus módulos importados salen del código actualizado y no del `main` anterior.

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

