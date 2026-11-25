# Motor de código fuente de la instalación

> Código: `server/src/code-engine/` (servidor) y `web/src/pages/platform/` (pantalla **Código fuente**, ruta `/platform/code`). Pruebas: `server/test/code-engine.test.ts`.

## 1. Qué es

Un **administrador de la plataforma** pide en lenguaje natural cualquier cambio del **código fuente real** de Cortex CRM (pantallas nuevas, funcionalidades, integraciones, rediseños). Un agente de IA edita el código de **esta instalación**, el cambio se construye y se prueba en un **CI aislado dentro de Railway**, una persona lo revisa leyendo el **diff** y, si lo aprueba escribiendo `DESPLEGAR`, se despliega en los servicios de la propia instalación (primero el worker como canario, después el web), con verificación y rollback.

- **Nunca se publica nada en GitHub.** Cada instalación (un proyecto de Railway desplegado desde la plantilla) evoluciona por su cuenta: su código vive en su propia imagen (`/app/source`) y en su propia base de datos (`source_changes`).
- **Complementa a EVOLVE, no lo sustituye.** EVOLVE sigue cambiando la configuración y los scripts de **cada organización** (blueprint, sandbox QuickJS). El motor de código cambia la **plataforma** para todas las organizaciones de la instalación; lo que una organización no puede resolver con EVOLVE (`requiresPlatformChange`) llega a la bandeja de la plataforma y se puede convertir en un cambio de código.
- **El código generado nunca se ejecuta en el web ni en el worker** antes de aprobarse: el agente solo manipula texto en un espacio virtual y el único sitio donde ese código corre es el build del servicio CI de Railway, que no tiene variables, secretos ni dominio.

```mermaid
flowchart LR
  A["Administración de la plataforma<br/>/platform/code"] -->|"petición"| W["Worker · code.plan"]
  W --> AG["Agente de IA<br/>(code_modification)<br/>espacio virtual"]
  AG --> G["Reglas deterministas<br/>núcleo protegido · migraciones · patrones"]
  G -->|"infracciones → otra ronda"| AG
  G -->|"tar.gz + Dockerfile.ci"| CI["Servicio CI de Railway<br/>npm ci · typecheck · vitest · build<br/>sin variables ni secretos"]
  CI -->|"logs con errores → auto-corrección (≤ 3)"| AG
  CI -->|"SUCCESS"| R["Revisión de seguridad con IA<br/>(code_review, otro proveedor)"]
  R --> H["Diff + CI + revisión<br/>la persona escribe DESPLEGAR"]
  H --> D["Worker · code.deploy"]
  D -->|"1 · canario"| WK["Servicio Worker"]
  D -->|"2"| WEB["Servicio web (Cortex)"]
  WEB -->|"3 · /api/health = versión nueva"| OK(["deployed"])
  D -->|"fallo"| RB["deploymentRollback<br/>a los despliegues registrados"]
```

## 2. El paquete de código fuente

La imagen contiene el código exacto con el que se construyó, en **`/app/source`** (el `Dockerfile` lo copia en la etapa de build **antes** de compilar y la etapa final lo copia de ahí, propiedad de `root`: el usuario `node` puede leerlo pero no modificarlo):

`server/` (incluido `server/test/**`), `web/`, `shared/`, `docs/`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `railway.json`, `Dockerfile`, `Dockerfile.ci`, `.dockerignore`, `README.md`, `.env.example` y `source-version.json`.

- `.dockerignore` ya **no** excluye las pruebas ni la documentación (el CI las necesita y el agente las lee); sigue excluyendo `.env*` (salvo `.env.example`), `.git`, `.github`, `node_modules`, `dist`, `.data`, `coverage` y `*.log`.
- **`source-version.json`** `{id, base, createdAt}` identifica cada versión que despliega el motor. El `Dockerfile` lo copia junto al bundle (`/app/source-version.json`; `{}` en una imagen construida desde el repositorio) y `buildVersion()` (`server/src/app.ts`) lo publica en `/api/health` como `version.sourceVersion`. Con él se verifica cada despliegue.
- **Versión base**: el id de `source-version.json` o, en la imagen de partida, `inicial-<huella>`. Además se calcula una **huella exacta del árbol** (sha256 de cada ruta y contenido, `treeHash`): aprobar y desplegar exigen que la instalación siga exactamente en el código sobre el que se preparó y probó el cambio (si no, hay que refinarlo y se reconstruye sobre la versión actual).
- En desarrollo, si no existe `/app/source`, la raíz del paquete es el directorio de trabajo (la raíz del repositorio).
- Al leer el paquete se ignoran los enlaces simbólicos, los archivos de más de 5 MB, `.env*`, `node_modules`, `dist`… y cualquier nombre fuera del conjunto seguro de caracteres.

## 3. El agente de código

`server/src/code-engine/agent.ts`, con `deps.ai.runAgent` (AI PROVIDER MANAGER), tarea **`code_modification`** y la configuración de IA de la **organización activa** de quien pide el cambio (que debe ser administrador o propietario de ella: se gasta su presupuesto de IA). Hasta 60 pasos por ronda, 32.000 tokens de salida por llamada y razonamiento con esfuerzo **`xhigh`** (en los modelos que lo admiten: familia 5 de Claude, Fable y Mythos; en el resto, `high`).

**Herramientas** sobre un espacio de trabajo virtual (`workspace.ts`: el código base de solo lectura + una capa con los cambios):

| Herramienta | Qué hace |
|---|---|
| `list_files {prefix?}` | Rutas (máx. 300) |
| `read_file {path, start_line?, end_line?}` | Texto con números de línea (250 líneas por defecto, 600 como mucho) |
| `read_files {paths}` | Varios archivos de una vez (hasta 10, las primeras 400 líneas de cada uno, ≤ 90.000 caracteres): explorar en menos pasos |
| `outline_file {path}` | Estructura de un archivo sin leerlo entero: funciones, clases, tipos, constantes exportadas, rutas HTTP, pruebas y títulos, con su línea |
| `search_code {pattern, path_prefix?, case_insensitive?}` | Expresión regular línea a línea (máx. 80 coincidencias); se rechazan referencias hacia atrás y cuantificadores anidados (riesgo de *backtracking* catastrófico) |
| `check_code {}` | Comprueba el estado actual en segundos: reglas del motor, dependencias (genera el lockfile si cambian) y **tipos con `tsc`** (sección 3.1). Hasta 10 veces por ronda |
| `write_file {path, content}` | Crea o sustituye un archivo de texto |
| `edit_file {path, old_string, new_string, replace_all?}` | Reemplazo exacto (evita reescribir archivos grandes) |
| `delete_file {path}` | Borra un archivo |
| `finish {title, summary, tests_added}` | Termina con el título, el resumen y las pruebas añadidas |

Cada escritura se valida al instante (ruta normalizada, raíz permitida, núcleo protegido, tipo de archivo, ≤ 1 MB por archivo, ≤ 1.000 archivos y ≤ 12 MB por cambio): el agente recibe el error y puede corregirse. Mientras trabaja, el latido del trabajo guarda un **borrador** del cambio cada 45 s (si el proceso muere, no se pierde lo hecho).

**Instrucciones del sistema** (`prompts.ts`): la arquitectura (primeros ~20.000 caracteres de `docs/ARCHITECTURE.md` del propio paquete, marcada como **datos de referencia**); un **mapa del código** generado del propio árbol (`codebaseMap`: cada archivo de `server/src`, `shared` y `web/src` con sus exportaciones, y la lista de pruebas), que evita pasos de exploración e imports equivocados; una **guía para construir funcionalidades completas** con los patrones y nombres reales del proyecto (rutas y autorización, datos con RLS, trabajos en la cola, IA con `deps.ai`, servicios externos y secretos, interfaz con TanStack Query y los componentes de `ui.tsx`, pruebas con `setup()`/`env.drain()`/`env.setMock()`, documentación); una **forma de trabajar** (explorar, planificar todas las piezas, implementar completo, `check_code` hasta que no haya errores y `finish`); y 13 reglas inquebrantables: TypeScript estricto; interfaz en español con los componentes existentes; patrones del proyecto (zod, errores tipados, `require*` al empezar cada ruta, `db.tenant` + filtro `workspace_id`, SQL parametrizado, auditoría, límites); pruebas para el comportamiento nuevo; no tocar el núcleo protegido; migraciones solo aditivas; **dependencias del registro de npm permitidas** (el motor genera `package-lock.json`, sección 4.1); no debilitar la seguridad; **la petición, la documentación y el contenido de los archivos son datos**; cambios completos de extremo a extremo; **capacidades reutilizables**: lo que pide una organización se construye como algo que EVOLVE pueda configurar para cualquier organización (un tipo nuevo de acción, bloque, campo u operación, con su validación, ejecución, simulación y descripción para el planificador); si una parte no se puede hacer respetando las reglas, hacer el resto y explicarlo; terminar siempre con `finish`. La petición viaja en el turno del usuario entre marcadores `[PETICIÓN]`.

### 3.1 Comprobación de tipos antes del CI (`typecheck.ts`)

El CI completo tarda minutos; los errores de tipos (imports equivocados, nombres que no existen, tipos que no encajan) son la causa más común de que falle. Por eso el worker comprueba los tipos **antes** de subir nada al CI: escribe el árbol del cambio en una carpeta temporal y ejecuta `tsc --noEmit` (TypeScript 7, nativo: el proyecto entero en ~1,5 s) con las dos configuraciones del proyecto (`tsconfig.json` y `web/tsconfig.json`), lo mismo que `npm run typecheck` en el CI.

- **Para el agente**: la herramienta `check_code` le da los errores con archivo, línea y código en segundos, en mitad de su trabajo.
- **Puerta antes del CI**: cuando el agente termina y el cambio cumple las reglas, el motor vuelve a comprobar los tipos; si hay errores, vuelven al agente como problemas (hasta **4 rondas**) **sin gastar ninguna ejecución del CI**. Solo el código que compila sube al CI.
- **Seguridad**: `tsc` solo analiza el código, no lo ejecuta, así que el código aún no aprobado sigue sin correr fuera del build aislado del CI.
- **Herramientas**: la imagen de producción no incluye las dependencias de desarrollo (TypeScript ni los tipos de las librerías). El worker las instala una vez en una carpeta de caché (`cortex-toolchain-<huella>` en el directorio temporal) con `npm ci --ignore-scripts --include=dev` a partir del `package-lock.json` del cambio: sin ejecutar scripts de los paquetes y con un entorno mínimo (sin las variables ni los secretos de la aplicación). La primera vez tarda en torno a un minuto y ocupa unos cientos de MB; después se reutiliza (una por lockfile). En desarrollo se usa el `node_modules` del proyecto si el lockfile coincide.
- Si no se pueden instalar (p. ej. sin acceso al registro de npm) o `tsc` falla por otro motivo, el motor sigue adelante y el CI comprueba los tipos como siempre; el progreso lo indica («tipos sin comprobar en el worker…»).

## 4. Reglas deterministas (`guards.ts`, `sql-guard.ts`, `paths.ts`)

Se aplican a **todo** resultado del agente antes de subirlo al CI, y otra vez antes de desplegar. No dependen de ningún modelo: un cambio que las incumple no llega al CI ni se puede aprobar. Si las incumple, el agente recibe la lista y tiene **2 rondas** más para corregirlo; después, el cambio falla.

**Núcleo protegido** (no se puede crear, modificar ni borrar; tampoco hacer «sombra» a un módulo protegido con `x.tsx`, `x.d.ts`, `x.js` o una carpeta `x/`):
`server/src/auth/**`, `server/src/lib/crypto.ts`, `server/src/lib/ssrf.ts`, `server/src/lib/client-ip.ts`, `server/src/lib/request-limit.ts`, `server/src/db/db.ts`, `server/src/crm/scripts.ts`, `server/src/crm/visibility.ts`, `server/src/config.ts`, `server/src/code-engine/**`, `web/src/pages/platform/**`, las pruebas de seguridad (`tenant-isolation`, `security-regressions`, `audit-hardening*`, `scripts-sandbox`, `template`, `code-engine*`, `auth`, `appearance`, `extensibility`) y `server/test/helpers.ts`, `Dockerfile*`, `railway.json`, `.dockerignore`, `.github/**`, `package-lock.json` (lo genera el motor, sección 4.1), `tsconfig.json`, `web/tsconfig.json`, `vitest.config.ts` y `source-version.json`. **`package.json`**: pueden cambiar `version`, `description`, `dependencies` y `devDependencies` (sección 4.1); los `scripts` y el resto siguen protegidos (el CI ejecuta `npm run typecheck`, que no se puede convertir en `echo ok`).

**Rutas**: solo relativas y normalizadas (sin `..`, absolutas, unidades de Windows, barras invertidas, segmentos vacíos ni caracteres fuera de `[A-Za-z0-9._@()+-]`), bajo `server/src/`, `server/test/`, `web/`, `shared/`, `docs/` o `README.md` / `package.json` / `.env.example`, sin archivos ni carpetas ocultos y solo de texto: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.css`, `.md`, `.json`, `.html`, `.txt`, `.svg`, `.csv`, `.xml`, `.yml`, `.yaml` o `.webmanifest` (en `server/src/`, el código es TypeScript). Los de código (también los JavaScript) pasan por los patrones prohibidos. Nunca binarios. No se pueden borrar pruebas existentes ni archivos centrales.

**Patrones prohibidos** (se cuentan en la base y en la versión nueva de cada archivo: solo es infracción si el cambio **añade** apariciones, así que el código que ya existía no bloquea): `child_process`; `vm`, `worker_threads`, `cluster`, `inspector`, `module`…; `eval(`; `new Function`; temporizadores con código en texto; `process.env` (solo en `config.ts`, que está protegido); `SET ROLE` / `RESET ROLE` / `BYPASSRLS` / `DROP POLICY` / `DISABLE ROW LEVEL SECURITY` / `row_security`; `dangerouslySetInnerHTML`, `innerHTML =`, `insertAdjacentHTML`, `document.write`, `javascript:`; importar `node:http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `undici` o usar `XMLHttpRequest` (las llamadas salientes a URLs que no son fijas usan `safePost`); `import()` con rutas calculadas; `require(`; DDL, `GRANT`, `REVOKE` o `TRUNCATE` fuera de las migraciones; las tablas `source_changes`, `platform_settings` o `schema_migrations` y la credencial de Railway; conceder `is_platform_admin`; y, en las pruebas, `.skip`, `.only`, `.todo`, `skipIf`… No se aplican a Markdown ni JSON.

**Anclas del núcleo**: líneas que deben seguir existiendo en archivos que el agente sí puede editar: en `app.ts`, `registerAuth`, el límite general, `bodyLimit`, `trustProxy`, la normalización de la IP real, la CSP (`default-src`, `script-src`, `connect-src`, `object-src`, `frame-ancestors`, `base-uri`, `form-action`), `frameguard`, el mensaje genérico de los errores 500, el registro de las rutas del motor y `source-version.json`; en `worker.ts`, los manejadores `code.plan` y `code.deploy`; en `index.ts`, el rol `ci`; en `lib/jobs.ts`, el plazo de `code.*`; en `web/src/main.tsx`, la ruta `/platform/code`. Así un cambio no puede desactivar la autenticación al registrar una ruta ni romper el propio motor.

**Migraciones inmutables y aditivas** (`sql-guard.ts`): `server/src/db/migrations.ts` debe quedar idéntico salvo por entradas nuevas al **final** de `MIGRATIONS`, con la forma exacta ``{ id: 'NNN_nombre', sql: () => `…` },``, id mayor que el último y SQL estático (sin `${}`, barras invertidas ni `$`). Cada sentencia debe ser de una lista blanca: `CREATE TABLE IF NOT EXISTS` (tabla nueva, sin `AS SELECT`, `INHERITS` ni `PARTITION`), `CREATE [UNIQUE] INDEX`, `ALTER TABLE … ADD COLUMN` (si es `NOT NULL`, con `DEFAULT`: si no, fallaría con datos reales aunque pase el CI, que usa una base vacía), `ENABLE/FORCE ROW LEVEL SECURITY`, `CREATE POLICY tenant_isolation … (workspace_id = app_current_workspace())` y `GRANT … TO evolve_tenant` (estas tres, **solo sobre tablas nuevas de la misma migración**, y **obligatorias** si la tabla tiene `workspace_id`), y `COMMENT ON`. Prohibidos `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `INSERT`, `RENAME`, `DISABLE`, roles, funciones, triggers, bloques `DO`, identificadores entre comillas, tablas `pg_*`/`schema_migrations` y llamadas a funciones fuera de una lista corta (`now()`, `gen_random_uuid()`, `lower()`…): un `DEFAULT` se evalúa como superusuario al migrar. Avisos: índice único sobre una tabla existente (fallaría con duplicados reales) o sobre tablas grandes (bloqueo de escrituras).

**Límites** (de abuso, no de alcance: un cambio puede ser una funcionalidad completa): ≤ 1.000 archivos, ≤ 12 MB de contenido nuevo, ≤ 1 MB por archivo (`package-lock.json`, ≤ 8 MB).

### 4.1 Dependencias nuevas

El agente puede añadir, actualizar o quitar paquetes en `dependencies` y `devDependencies` de `package.json`, solo con **versiones del registro de npm** (`1.2.3`, `^1.2.3` o `~1.2.3`; nada de git, URL, `file:`, `link:`, `npm:` ni `workspace:`) y nombres de paquete válidos. **Nunca escribe `package-lock.json`** (ruta protegida): cuando cambian las dependencias, el motor lo calcula en el worker (`lockfile.ts`) con `npm install --package-lock-only --ignore-scripts`, en una carpeta temporal y con un entorno mínimo (sin las variables ni los secretos de la aplicación): solo descarga metadatos del registro, no instala nada ni ejecuta código de los paquetes. Si npm no puede resolverlo (un paquete o una versión que no existen), el error vuelve al agente como un problema más. El resultado se **verifica** de forma determinista, al generarlo y otra vez antes de desplegar: la raíz declara exactamente las dependencias de `package.json` y cada paquete se descarga de `https://registry.npmjs.org/` con hash `sha512` (no se puede colar un paquete servido desde otra URL, un repositorio git o un enlace local). El lockfile se regenera después de cada ronda del agente.

Quien aprueba ve el aviso **«Dependencias: añade … »** y la revisión de IA busca paquetes poco conocidos, nombres que imitan a otros (*typosquatting*) o saltos de versión sin motivo: **el código de un paquete se ejecuta en producción con acceso a los datos**, así que la revisión humana es la barrera. Los scripts de instalación de los paquetes se ejecutan en el build del CI (sin secretos ni red privada) y en el build de la imagen (que no recibe los secretos de ejecución).

### 4.2 Capacidades nuevas sin tocar el núcleo

El motor de riesgo (`evolve/risk.ts`) y la visibilidad por rol (`crm/visibility.ts`) están protegidos, pero no frenan las capacidades nuevas: lo que no conocen se trata siempre del lado seguro. Una **acción de automatización** de un tipo nuevo es de riesgo **alto** (también al restaurar una versión que la reactive), una **operación** nueva del change set es de riesgo **alto** y una **página** con un tipo de bloque nuevo, de riesgo **medio**. Un **bloque** o una **acción** de un tipo nuevo solo se muestran a los roles que pueden leer todos los módulos que referencian (`referencedModules`: propiedades `module`, `modules`, `form` y destinos de módulo, a cualquier profundidad). Cubierto por `extensibility.test.ts`.

**Avisos para quien aprueba** (no bloquean): migraciones nuevas (se aplican al arrancar el worker y **no se deshacen al revertir**), rutas HTTP nuevas y rutas nuevas sin una comprobación de autorización visible, llamadas `fetch` salientes nuevas, acceso a secretos, consultas con la conexión privilegiada, cambios en la web o en `shared/`, pruebas modificadas, archivos borrados, archivos centrales tocados, cambio de código sin pruebas y cambios grandes. Se muestran en la pantalla del cambio y los recibe la revisión de IA.

## 5. CI aislado en Railway

El árbol del cambio (base + cambios + `source-version.json` nuevo, con **el contenido de `Dockerfile.ci` en `Dockerfile`**) se empaqueta con un escritor **ustar** propio (`tar.ts`, sin dependencias; rutas largas con el campo `prefix`, carpetas `0755`, archivos `0644`, dueño `root`) y gzip, y se sube al **servicio CI** con el mismo protocolo que `railway up`:

```text
POST https://backboard.railway.com/project/{projectId}/environment/{environmentId}/up?serviceId={ciServiceId}&message=…
Content-Type: application/gzip
Project-Access-Token: <token de proyecto>
→ 200 {deploymentId, url, logsUrl, deploymentDomain} · 400 {message} · 413 demasiado grande
```

`Dockerfile.ci` ejecuta `npm ci`, `npm run typecheck`, `npx vitest run` y `npm run build` (con `CI=true`: un `.only` hace fallar Vitest) **El código generado (aún sin aprobar) solo se ejecuta en esa fase de build**, que según la documentación de Railway no tiene acceso a la red privada del proyecto («Private networking is only available at runtime, not during the build phase») ni a los secretos (el servicio CI no tiene variables y un Dockerfile solo ve las declaradas con `ARG`). El contenedor que queda en marcha **no carga nada del código generado**: es un servidor de salud mínimo escrito dentro del propio `Dockerfile.ci` (archivo protegido) como `dist/server/index.js`, que responde 200 con `{status: "ok", role: "ci"}`. Así el código no aprobado nunca queda vivo dentro de la red privada. El servicio `CI` de la plantilla arranca con `node --enable-source-maps dist/server/index.js --role=ci`: con la imagen normal (su primer despliegue, desde el repositorio) es el rol `ci` de la aplicación, sin base de datos ni secretos, y con la de pruebas, ese servidor fijo. Por tanto, **despliegue `SUCCESS` = CI superado** y `FAILED`/`CRASHED` = algo falló. El estado y los logs se leen con la API GraphQL pública (`deployment`, `buildLogs`, `deploymentLogs`) y el despliegue del CI se **retira** (`deploymentRemove`) en cuanto se conoce el resultado. Plazo máximo de un CI: 45 min (después se cancela).

**Auto-corrección**: si el CI falla, `ci.ts` extrae del log los errores de TypeScript (`archivo(línea,col): error TSxxxx`), las pruebas fallidas y su detalle (bloque *Failed Tests* de Vitest) y los errores de npm, Vite o Docker, y el agente los recibe en la siguiente ronda. Hasta **3 rondas de auto-corrección** (4 ejecuciones del CI); cada refinado empieza una ronda nueva.

**Despliegue sustituido**: si el despliegue del CI termina como `REMOVED`, `REMOVING` o `SKIPPED` sin que lo haya retirado el motor (por ejemplo, porque un *push* al repositorio con el que el servicio `CI` sigue conectado lo ha redesplegado), no dice nada del código: el motor vuelve a subir el mismo árbol sin pasar por el agente y sin gastar un intento de auto-corrección (el intento queda como `cancelled` con la nota correspondiente). Si se repite más de dos veces, el cambio falla y pide desconectar el servicio `CI` del repositorio.

Solo hay un servicio CI, así que los cambios se preparan **de uno en uno** (índice único `source_changes_single_active_uq`).

## 6. Revisión de seguridad con IA

`review.ts`, tarea **`code_review`**, preferiblemente con un **proveedor distinto** del que escribió el código (como la revisión cruzada de EVOLVE); si solo hay uno, con el mismo, y se indica. Recibe la petición, el resumen del agente, las estadísticas, los avisos deterministas y el **diff unificado** (Myers, `diff.ts`; hasta 150.000 caracteres) y devuelve `{verdict: approve | concerns | reject, summary, concerns[{severity, file, message}]}` centrado en autorización, aislamiento entre organizaciones, inyección, secretos, puertas traseras y debilitamiento de controles. Es **informativa**: decide la persona, y el riesgo de un cambio del código de la plataforma es **siempre alto**.

## 7. Aprobación y despliegue

`POST /api/platform/code/requests/:id/approve` exige un **administrador de la plataforma con sesión de usuario** (nunca una API key), escribir **`DESPLEGAR`**, el CI superado, las reglas cumplidas y que la instalación siga en la versión base. La aprobación queda ligada a la huella del árbol que pasó el CI. El trabajo **`code.deploy`**:

1. **Comprobaciones**: aprobación con `DESPLEGAR`, versión base, el árbol reconstruido (base + cambio, con el `Dockerfile` y el `railway.json` del código base) tiene la **misma huella** que el que pasó el CI (sin contar `Dockerfile` ni `railway.json`, protegidos y puestos por el motor) y vuelve a cumplir las reglas. **Registra los despliegues activos** (`deployments(input: {…, status: {in: [SUCCESS, SLEEPING]}})`) del worker y del web: sin ellos no empieza, porque no se podría revertir.
2. **Worker primero (canario)**: sube el árbol al servicio Worker y espera a `SUCCESS` (el health check del worker exige base de datos y cola en marcha; las migraciones nuevas se aplican aquí, al arrancar). Railway retira el worker anterior en cuanto el nuevo está sano, así que **normalmente es el worker nuevo quien continúa el despliegue** (se espera hasta 3 min a que lo retome; queda registrado quién lo hizo).
3. **Web**: sube el mismo árbol al servicio web (`CORTEX_SERVICE_ID`) y espera a `SUCCESS`.
4. **Verificación**: `GET {APP_URL}/api/health` debe responder `status: ok` con `version.sourceVersion.id` igual a la versión nueva (reintentos durante ~3 min). Entonces el cambio queda `deployed`.
5. **Si algo falla** (despliegue `FAILED`/`CRASHED`/cancelado, plazo de 30 min superado o verificación fallida): `deploymentRollback` a los despliegues registrados (el web primero y después el worker; si el web nuevo no llegó a estar sano, solo el worker, porque Railway mantiene el anterior), se comprueba que `/api/health` vuelve a la versión base y el cambio queda `failed` con el motivo.

Cada ejecución del trabajo es una **fase acotada**: hace un paso, guarda el estado en `source_changes.deploy` y se vuelve a encolar. Así sobrevive a que Railway sustituya el proceso que la ejecuta (el propio worker, en el paso 2).

## 8. Rollback manual y despliegues detenidos

`POST …/rollback` con **`REVERTIR`**: solo el **último** cambio desplegado y si la instalación sigue ejecutando su versión. Llama a `deploymentRollback` para el web y el worker (a los despliegues registrados antes del cambio), pasa a `rolling_back`, verifica `/api/health` y queda `rolled_back`. Las **migraciones no se deshacen** (son aditivas: el código anterior funciona con el esquema nuevo).

Un despliegue que nadie procesa desde hace más de 10 minutos (por ejemplo, un worker nuevo que arranca pero no procesa la cola) aparece como **detenido** y también se puede revertir con `REVERTIR`. Además, las consultas de la pantalla vuelven a encolar el trabajo de un cambio en curso cuyo lease ha caducado (`nudgeIfStalled`), por si murió el proceso que lo llevaba.

## 9. Estados, trabajos y concurrencia

| Estado | Significado | Siguiente |
|---|---|---|
| `queued` | Pedido | `planning` |
| `planning` | El agente trabaja (también en la auto-corrección) | `testing`, `needs_input`, `failed` |
| `testing` | CI en Railway | `ready_for_review`, `planning` (auto-corrección), `failed` |
| `needs_input` | El agente no ha hecho cambios (lee su resumen) | refinar |
| `ready_for_review` | Listo para aprobar | `deploying` (DESPLEGAR), refinar, cancelar |
| `deploying` | Desplegando | `deployed`, `rolling_back` |
| `deployed` | Desplegado y verificado | `rolling_back` (REVERTIR) |
| `rolling_back` | Revirtiendo | `rolled_back` (manual) o `failed` (automático) |
| `failed`, `rolled_back`, `cancelled` | Finales (`failed` se puede refinar) | |

- **Trabajos**: `code.plan` (agente, reglas, CI, auto-corrección, revisión) y `code.deploy` (despliegue y rollback), registrados en `createJobHandlers`. Son de plataforma (`workspace_id` nulo), con un intento por ejecución, y su plazo es de **45 minutos** (`timeoutFor()` en `lib/jobs.ts`). Un trabajo `code.plan` con `{probe: true}` solo hace que el worker publique su configuración.
- **Lease con latido**: cada ejecución toma el cambio (`lease_token` + `lease_until`, renovado cada 45 s) y solo escribe mientras lo tiene y el cambio sigue en un estado suyo. Una cancelación a mitad detiene al agente en el siguiente latido; dos ejecuciones simultáneas nunca procesan el mismo cambio, aunque otra instancia del worker tome el trabajo por huérfano.
- **Concurrencia**: como mucho un cambio en preparación o despliegue (`queued`, `planning`, `testing`, `deploying`) y como mucho un despliegue o rollback (`deploying`, `rolling_back`) a la vez, garantizado por dos índices únicos parciales. Un rollback urgente no espera a que termine de prepararse otro cambio.

## 10. API

Todas bajo `/api`, todas con `requirePlatformAdmin` (sesión de usuario de un administrador de la plataforma; una API key recibe `403` y un anónimo `401`).

| Método y ruta | Límite/min | Qué hace |
|---|---|---|
| `GET /platform/code/settings` | — | Estado: si está configurado, qué falta, pista del token `••••abcd`, ids de proyecto, entorno y servicios (web, worker, CI) y versión en ejecución |
| `PUT /platform/code/settings {token}` | 10 | Valida el token con `projectToken { projectId environmentId }` contra el proyecto y entorno en los que corre la instalación y lo guarda cifrado; nunca lo devuelve ni lo registra |
| `DELETE /platform/code/settings/token` | 10 | Borra el token |
| `POST /platform/code/settings/check` | 6 | Pide al worker que vuelva a publicar su configuración |
| `POST /platform/code/requests {prompt}` | 6 | Crea un cambio (usa la IA de la organización activa, de la que hay que ser administrador; `409` si esa organización permite menos de 300 peticiones de IA por hora) |
| `GET /platform/code/requests` | — | Historial |
| `GET /platform/code/requests/:id` | — | Detalle: archivos con contenido antes y después, CI (intentos, errores, final del log), revisión, avisos, progreso, despliegue y `policy` |
| `POST /platform/code/requests/:id/refine {feedback}` | 10 | Vuelve a desarrollar con indicaciones (sobre la versión actual si la instalación ha cambiado) |
| `POST /platform/code/requests/:id/approve {confirmation: "DESPLEGAR", comment?}` | 5 | Aprueba y despliega |
| `POST /platform/code/requests/:id/rollback {confirmation: "REVERTIR"}` | 5 | Revierte el último cambio desplegado (o un despliegue detenido) |
| `POST /platform/code/requests/:id/cancel` | 20 | Cancela (y retira el CI en curso) |
| `GET /platform/requests` | — | Peticiones de EVOLVE de tipo `platform` (o con `requiresPlatformChange`) de todas las organizaciones |
| `POST /platform/requests/:id/source-change {note?}` | 6 | Convierte una de ellas en un cambio de código (el texto de la organización viaja como dato) |

Auditoría (sin organización): `platform.code.token_set`, `platform.code.token_revoked`, `platform.code.requested`, `platform.code.refined`, `platform.code.approved`, `platform.code.cancelled`, `platform.code.rollback_requested`, `platform.code.deployed`, `platform.code.deploy_failed`, `platform.code.rolled_back`.

## 11. Interfaz

`/platform/code` (enlace **Código fuente** de la barra lateral, solo para administradores de la plataforma), con tres pestañas y el detalle en `/platform/code?change=<id>`:

- **Cambios**: formulario de petición y historial.
- **Peticiones de organizaciones**: bandeja de las peticiones de plataforma, con «Convertir en cambio de código».
- **Configuración**: token (se valida al guardarlo; solo se muestra la pista), servicios detectados con su origen y lo que falta, e instrucciones de puesta en marcha.
- **Detalle**: petición y refinados, resumen del agente, infracciones, avisos, **visor de diff por archivo** (LCS línea a línea, sin dependencias, con las zonas sin cambios plegadas), intentos del CI con los errores extraídos y el final del log, revisión de IA, línea de tiempo, aprobación con `DESPLEGAR`, estado del despliegue (despliegues anteriores, canario, verificación) y rollback con `REVERTIR`.

## 12. Configuración en Railway

Ver [RAILWAY_TEMPLATE.md](RAILWAY_TEMPLATE.md#4-motor-de-código-fuente-servicio-ci-y-token). En resumen: un servicio **`CI`** sin variables ni dominio (en la plantilla, desde el repositorio con el comando de arranque `--role=ci`; en una instalación anterior basta con un servicio vacío); en el **Worker**, `CORTEX_SERVICE_ID=${{Cortex.RAILWAY_SERVICE_ID}}` y `CI_SERVICE_ID=${{CI.RAILWAY_SERVICE_ID}}`; y un **token de proyecto** del entorno de la instalación, que se pega en la pantalla. Railway define solo `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID` y `RAILWAY_SERVICE_ID`. Las variables se leen en `config.ts` (`config.railway`). El worker publica lo que ve en `platform_settings` (`railway.worker`) para que la pantalla, servida por el web, diga exactamente qué falta.

## 13. Limitaciones y riesgos abiertos

- **La barrera principal es la revisión humana del diff.** Las reglas deterministas cortan lo obvio (núcleo, migraciones, patrones), pero un cambio de lógica malicioso o erróneo que respete las reglas solo lo detectan la persona que revisa y, como ayuda, la revisión de IA. Una vez desplegado, el código **es** la plataforma: un cambio malicioso aprobado por error podría, por ejemplo, aprobar cambios futuros desde la sesión de un administrador. Endurecimiento futuro: reautenticación o segundo factor para `DESPLEGAR`.
- **El CI ejecuta código generado solo durante el build**, sin secretos y sin red privada (ver la sección del CI). La fase de build sí puede tener salida a Internet (la documentación de Railway no lo aclara): el código no aprobado podría enviar fuera el propio código fuente de la instalación, que no contiene secretos.
- **Las migraciones no se deshacen** al revertir (son aditivas).
- **Las imágenes antiguas de Railway** deben seguir disponibles para `deploymentRollback` (retención según el plan).
- **Servicios conectados a GitHub**: si `Cortex` o `Worker` siguen conectados a un repositorio (p. ej. el de la plantilla), un *push* a ese repositorio volvería a desplegar su código y el código modificado se perdería. Por eso el motor **no despliega** mientras alguno siga conectado (`serviceInstance.source.repo`): pide desconectarlo en Railway (servicio › Settings › Source › Disconnect). Si el token no puede consultarlo, se despliega igualmente y hay que comprobarlo a mano.
- **Límites y coste de IA**: un cambio hace decenas o cientos de llamadas (hasta 60 pasos por ronda, con razonamiento `xhigh`, y varias rondas: hasta 14 del agente en total), con un coste que depende del modelo. La comprobación de tipos en el worker ahorra rondas de CI, pero no llamadas: cada `check_code` con errores suele llevar a más pasos del agente. El motor rechaza la petición de entrada si la organización cuya IA se usa permite menos de 300 peticiones por hora (por defecto 60): hay que subir «Peticiones por hora» en Ajustes › Proveedores de IA › Límites y control de gasto.
- `TENANT_TABLES` (que usa la auditoría de seguridad de EVOLVE) no incluye las tablas de organización que creen migraciones nuevas; sí llevan RLS obligatoria por la regla de migraciones.
- `fetch` en código nuevo del servidor solo genera un aviso (las integraciones con hosts fijos lo necesitan); a destinos que controla un usuario hay que usar `safePost`, que solo admite POST.
- **Probado solo con simulaciones**: la IA es el proveedor simulado y Railway un `fetch` simulado (`server/test/code-engine.test.ts`). El protocolo de subida, el esquema GraphQL (`railway api describe`) y el tar (verificado con GNU tar) están comprobados, pero **no** contra la API real.

**Comprobado en vivo** (25-11-2026, en un proyecto de prueba desplegado desde la plantilla y borrado después): la plantilla crea los cuatro servicios sin pedir ningún valor; el worker detecta web, worker y CI y la pantalla solo pide el token; el paquete del CI, generado con `buildCiTree`, se construye en Railway con `Dockerfile.ci` (`npm ci`, tipos, las 267 pruebas y build, unos 90 s) y en ejecución solo arranca el servidor de salud fijo; `analyzeCiLogs` extrae del log real el resumen de Vitest. La prueba descubrió dos fallos que ya están corregidos: Railway **no aplica el `railway.json` subido** (`resolvedFileConfig.configFile: null`; construyó el `Dockerfile` de la raíz, que en el CI habría cargado el código generado en tiempo de ejecución y no habría ejecutado las pruebas), y una prueba del propio repositorio leía `railway.json` y fallaba con la variante del CI. Por eso el CI ahora va en `Dockerfile` y exige ver el resumen de las pruebas en el log.

**Pendiente de probar en vivo** (necesita un token de proyecto y un proveedor de IA reales): la subida con `Project-Access-Token` desde el motor (la prueba se hizo con la sesión de la CLI y el mismo endpoint); que un token de proyecto puede consultar `deployments`, `buildLogs` y `serviceInstance` y ejecutar `deploymentRollback`/`deploymentRemove`; el despliegue con canario en un web y un worker reales (el worker nuevo retoma el despliegue tras sustituir al anterior); y un rollback real (automático y con `REVERTIR`).
