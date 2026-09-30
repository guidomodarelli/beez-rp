# Changelog

Todos los cambios relevantes de beez-rp se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa [Semantic Versioning](https://semver.org/lang/es/).

## [Unreleased]

### Added

- `versionFiles` en `beez-rp.config.(m)js`: archivos trackeados en Git que también llevan la versión (el `--version` de una CLI, una constante), escritos con `/` o `\` en cualquier sistema, y se actualizan en el commit de release. Solo cambian las líneas marcadas con `beez-rp-version` o los bloques `beez-rp-start-version` … `beez-rp-end`; también se aceptan los marcadores de release-please. Un archivo que falta, que Git no trackea (por ejemplo, uno generado e ignorado), que no tiene ninguna versión marcada, con marcadores de bloque mal emparejados (un inicio sin su fin, un fin sin inicio, un bloque dentro de otro o el fin de la otra herramienta), que no es texto UTF-8 válido (por ejemplo, guardado en ISO-8859-1), que tiene otro enlace duro (hacia otra entrada o hacia un archivo fuera del repo; lo mismo corta el release si lo tiene `package.json` o `CHANGELOG.md`) o cuya ruta pasa por un enlace simbólico corta el release antes de tocar la versión, indicando el archivo y la línea; también lo corta que `package.json` o un archivo de `versionFiles` haya cambiado respecto del último commit antes de escribir la versión (por ejemplo, porque un check corrió `lint --fix`), en vez de meter ese cambio en el commit de release. Fuera de la versión, cada archivo se conserva byte a byte (incluido un BOM); si un archivo no se puede escribir (por ejemplo, de solo lectura), `package.json`, `CHANGELOG.md` y los archivos ya escritos vuelven a su contenido original. `package.json` y `CHANGELOG.md` no se pueden listar porque el commit de release ya los actualiza. Si Git guarda en el commit de release otro contenido que el preparado (por ejemplo, por un filtro clean de `.gitattributes`), no se crea el tag ni se sube nada; si el commit de release falla (por ejemplo, lo rechaza un hook `pre-commit`), `package.json`, `CHANGELOG.md` y los archivos de `versionFiles` vuelven solos a su contenido y a su staging anteriores, sin comandos que copiar y sin tocar las marcas del resto del índice (`skip-worktree`, `assume-unchanged`, sparse checkout). Si un hook `pre-commit` o `commit-msg` stagea otro archivo o modifica y vuelve a stagear uno del release (por ejemplo, un formateador que reescribe un archivo de `versionFiles`), el commit de release se deshace sin tag ni push y los cambios en otros archivos quedan en staging para revisarlos. Al retomar un commit de release ya creado (también uno hecho a mano), no se sube ni publica nada hasta que, en ese commit, cada archivo sea un archivo regular con sus líneas marcadas en la versión pendiente; mientras `beez-rp.config.(m)js` tenga cambios sin commitear (también si se renombró entre `.js` y `.mjs`, o si el archivo que se carga no está commiteado, como un `beez-rp.config.mjs` ignorado que tapa el `beez-rp.config.js` commiteado), no arranca ni un release nuevo ni la reanudación de uno ya commiteado, tampoco con `--ignore-local-changes` (que no puede apartar una configuración ya cargada) ni en `--dry-run`, y el comando no ofrece ignorar esos cambios: el release usaría `versionFiles`, checks, migraciones y hooks que no están commiteados. Lo mismo vale para cualquier módulo del repo que la configuración carga, directa o indirectamente (con `import`, `require` o como JSON; por ejemplo, un helper que arma `versionFiles`, define `migrations` o guarda un valor que usa un hook), aunque `git status` no lo muestre: el diagnóstico siempre carga la configuración en un proceso Node aparte y compara cada módulo del repo (fuera de `node_modules`) con `HEAD`, así que también bloquea un override local ignorado que la configuración importa, un módulo reemplazado por un enlace simbólico y un cambio oculto con `skip-worktree` o `assume-unchanged`, además de un módulo al que se llega por una carpeta del repo reemplazada por un enlace simbólico y cualquier módulo que se carga desde fuera del repo (salvo `node_modules` y el propio beez-rp); el bloqueo nombra cada módulo y qué cambió. Si no se puede saber qué módulos carga (la configuración no carga en un proceso nuevo), el plan se bloquea siempre y dice por qué. Los archivos que la configuración lee con `fs` en vez de importarlos no se detectan. Un archivo trackeado que `git status` no muestra distinto de `HEAD` porque tiene `skip-worktree` o `assume-unchanged` (`git update-index`), sea por su contenido o porque se reemplazó por otro tipo de archivo (por ejemplo, un enlace simbólico), bloquea cualquier release, también con `--ignore-local-changes`, hasta quitarle la marca; y si `package.json`, `CHANGELOG.md` o un archivo de `versionFiles` tiene una de esas marcas, aunque sea igual al último commit, el release se corta antes de escribir la versión y dice cómo quitarla, para que deshacer un commit de release fallido no se la saque en silencio.
- Soporte de bun, npm y yarn además de pnpm: beez-rp detecta el package manager por el campo `packageManager` del `package.json` o, si falta, por el lockfile (sin ninguno asume pnpm, como hasta ahora). Los checks por defecto corren con ese package manager (`bun run ci`) y todos los mensajes indican su comando (`bun run create-version`, `npm run create-version`), incluido el de `guard-publish`. El nuevo módulo `beez-rp/package-manager` expone `detectPackageManager` y `describeProjectCommands`.

### Changed

- beez-rp requiere Node 22.15 o posterior (`engines`): el diagnóstico de `create-version` necesita `module.registerHooks` para saber qué módulos carga la configuración, y sin él bloquea todos los releases.

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

