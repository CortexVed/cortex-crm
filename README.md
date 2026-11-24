# Cortex CRM

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/TK1L4n)

**CRM multi-organización, evolutivo y multi-LLM.** Cada organización adapta su CRM describiendo en lenguaje natural lo que necesita: EVOLVE AI ENGINE interpreta la petición, planifica los cambios (configuración y, si hace falta lógica a medida, scripts propios de esa organización), los prueba en un entorno aislado y los presenta para que una persona los apruebe; cada publicación es una versión nueva, verificada y reversible, que solo afecta a esa organización y nunca se publica en un repositorio. Funciona con Claude, OpenAI, DeepSeek u OpenRouter (y Gemini, Mistral y Groq en modo experimental) sin depender de ninguno.

> Estado: fases 1–7 implementadas y cubiertas por tests automatizados (201 tests en 15 archivos, todos superados); fase 8 parcial (analizador de seguridad y endurecimiento hechos; capacidades comerciales pendientes). Ver [limitaciones](#limitaciones-conocidas).

## Funcionalidades

- **CRM completo**: empresas, contactos, oportunidades (pipeline kanban con importe ponderado), tareas (calendario y recordatorios) y actividades; fichas con relaciones, línea de tiempo, notas y documentos; búsqueda global; borrado restaurable.
- **EVOLVE AI ENGINE**: pipeline de 10 pasos (interpretar → analizar → planificar → desarrollar en aislamiento → probar → presentar → autorizar → desplegar → verificar → recuperar), sandbox con reloj simulado y cinco suites de pruebas, auto-corrección, revisión cruzada con otro modelo, riesgo determinista, aprobación por roles, versiones con rollback y restauración.
- **Scripts por organización**: cuando la configuración no basta, EVOLVE especifica un script, un paso «desarrollador» escribe su código (JavaScript) y el sandbox lo prueba antes de aprobarlo. Se ejecuta dentro de la plataforma en QuickJS compilado a WebAssembly (sin red ni archivos, con límites de memoria y tiempo), se versiona con la configuración de su organización y nunca afecta a otras.
- **AI PROVIDER MANAGER**: claves cifradas, enmascaradas y revocables; catálogo de modelos descubierto por API (OpenRouter con precios en vivo); modelo por tarea (10 tipos); *fallback* automático; límites por hora y presupuesto mensual; coste, latencia y errores por llamada; comparación de modelos.
- **Asistente EVOLVE AI** contextual (entiende la pantalla actual), con herramientas que respetan permisos; las escrituras siempre requieren confirmación. Memoria de IA por organización y usuario.
- **IA sobre los datos**, cada función con su propio tipo de tarea (y modelo configurable): «Pregunta a tus datos» en Informes (la pregunta se convierte en una consulta estructurada y validada, nunca en SQL, y se puede añadir al panel), «Clasificar con IA» en la ficha (sugiere valores para los campos de selección; no se guarda nada hasta aplicarlo) y análisis de documentos PDF o de texto (resumen, fechas, importes, riesgos y tareas sugeridas).
- **Automatizaciones** por evento y programadas (fechas, inactividad), que pueden ejecutar scripts de la organización; **paneles** personalizables, **informes** (ventas, conversión, actividad, rendimiento, clientes) y **predicciones con IA**.
- **Comunicaciones**: WhatsApp Business (Cloud API) y Telegram; Gmail, Outlook y Slack preparados y marcados como no disponibles.
- **Multi-organización con aislamiento estricto** (filtros de aplicación + Row Level Security de PostgreSQL, con tests entre organizaciones), 5 roles, API keys, auditoría, CSRF, CSP, *rate limiting* y cifrado AES-256-GCM.
- **Interfaz** en español con modo claro/oscuro, paleta de comandos (`⌘/Ctrl+K`), atajos de teclado, notificaciones y panel de IA (`⌘/Ctrl+J`) en todas las pantallas, abierto por defecto en pantallas de 1280 px o más.

## Stack

| Capa | Tecnología |
|---|---|
| Servidor | Node.js 24 (`engines: >=22`), Fastify 5, zod 4, `pg`, `@anthropic-ai/sdk` |
| Sandbox de scripts | QuickJS en WebAssembly: `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync` 0.32.0 |
| Cliente | React 19, Vite 8, Tailwind CSS 4, TanStack Query 5, React Router 8, lucide-react |
| Base de datos | PostgreSQL (Railway: Postgres 18) con RLS; PGlite (Postgres en WASM) en desarrollo y tests |
| Tests y calidad | Vitest 5, TypeScript estricto; workflow de CI opcional para GitHub Actions (`.github/workflows/ci.yml`) |
| Despliegue | Plantilla de Railway (Docker `node:24-alpine`): servicios `Cortex` (web), `Worker` y `Postgres` |

## Estructura

```text
server/src/   API Fastify, worker, IA, EVOLVE, CRM (incluido el sandbox de scripts), seguridad   (ver docs/ARCHITECTURE.md)
server/test/  Tests Vitest (201 tests en 15 archivos)
shared/       Esquemas y lógica compartidos por servidor, sandbox y cliente
web/          SPA React (Vite)
docs/         Documentación técnica y de producto
```

## Puesta en marcha local

**Requisitos**: Node.js 22 o superior (recomendado 24) y npm. No hace falta PostgreSQL: sin `DATABASE_URL` se usa PGlite en `.data/pglite`.

```bash
npm ci
cp .env.example .env    # opcional (PowerShell: Copy-Item .env.example .env)
```

### Opción A — desarrollo con recarga (dos terminales)

El servidor (API + worker, rol `all`) escucha en `:3000` y la interfaz de Vite en `:5173` con *proxy* de `/api`. El *proxy* conserva la cabecera `Host` del navegador (`changeOrigin: false` en `web/vite.config.ts`), así que la comprobación de origen acepta las peticiones del servidor de desarrollo sin definir `APP_URL`. Los mismos comandos sirven en Bash y en PowerShell:

```bash
npm run dev        # terminal 1: API + worker en http://localhost:3000
npm run dev:web    # terminal 2: interfaz en http://localhost:5173
```

### Opción B — build de producción en local

```bash
npm run build
npm start        # → http://localhost:3000 (sirve la SPA y la API en el mismo origen)
```

### Variables de entorno

Todas las que lee el código se validan en `server/src/config.ts` y están documentadas en [`.env.example`](.env.example) y en [ARCHITECTURE.md](docs/ARCHITECTURE.md#12-configuración). Fuera de producción, el servidor y la CLI cargan automáticamente el archivo `.env` del directorio desde el que se lanzan, si existe (`process.loadEnvFile`); con `NODE_ENV=production` (como en la imagen Docker) solo cuentan las variables del entorno del proceso. Las variables vacías (por ejemplo `DATABASE_URL=` o `APP_ENCRYPTION_KEY=`, tal cual vienen en `.env.example`) cuentan como no definidas, así que una copia sin cambios de `.env.example` pasa la validación de la configuración (comprobado con Node 24). Las líneas `GITHUB_TOKEN`, `GITHUB_REPO` y `GITHUB_BASE_BRANCH` que aún aparecen en `.env.example` son restos del antiguo motor de código: ninguna parte del código las lee.

`.env.example` trae `APP_URL=http://localhost:5173`, la dirección de la opción A, que se usa para construir los enlaces de los correos. Con la opción B, cámbiala a `http://localhost:3000` o elimínala (fuera de producción, sin `APP_URL` se usa el `Host` de la petición).

Para usar un PostgreSQL local, define `DATABASE_URL`; el usuario debe poder crear roles y hacer `SET ROLE` (en local, un superusuario).

### Primer uso

1. Abre `/register` y crea tu cuenta y tu organización (recibe el CRM base).
2. Fuera de producción el primer usuario es administrador de plataforma. En producción el rol nunca se concede desde la web: solo con la CLI incluida en el build, dentro del contenedor: `node dist/server/cli.js grant-platform-admin <email>` (también `revoke-platform-admin` y `list-platform-admins`; script `npm run cli`).
3. Sin correo configurado, en desarrollo los correos (verificación, recuperación, invitaciones) se escriben en el log del servidor con su enlace.
4. Configura un proveedor de IA en **Ajustes › Proveedores de IA** (o claves de plataforma con `ALLOW_PLATFORM_LLM_KEYS=true`) para usar EVOLVE, el asistente y las funciones de IA sobre los datos.

## Tests

```bash
npm test             # Vitest: 201 tests en 15 archivos (PGlite en memoria + proveedor de IA simulado)
npm run typecheck    # TypeScript del servidor y del cliente
```

| Archivo | Tests | Cubre |
|---|---|---|
| `auth.test.ts` | 11 | Registro, login/logout, rate limiting, contraseñas débiles, CSRF y origen, bloqueo de cuenta, recuperación sin enumeración, sesiones, invitaciones, cabeceras de seguridad |
| `tenant-isolation.test.ts` | 8 | Acceso cruzado por URL, listados/búsqueda/selectores, archivos, relaciones y usuarios ajenos, API keys, cambio de organización, RLS en PostgreSQL, columnas sensibles |
| `crm.test.ts` | 10 | Registros y relaciones, validación, fórmulas y automatizaciones, ficha y timeline, listados con filtros/orden/vistas, archivos, borrado y restauración, paneles e informes, automatizaciones programadas sobre la BD real sin duplicados, búsqueda |
| `blueprint.test.ts` | 11 | Blueprint por defecto, aplicación de operaciones, cambios incompatibles, referencias rotas, parches que solo cambian lo indicado, riesgo, fórmulas, validación de registros, condiciones y plantillas |
| `evolve.test.ts` | 11 | Flujo completo de EVOLVE, aprobación obligatoria, publicación verificada, rollback y restauración, auto-corrección, reparación de JSON, riesgo alto, peticiones sin operaciones, cambios manuales, roles, automatizaciones programadas en sandbox |
| `scripts.test.ts` | 12 | Sandbox QuickJS: función pura con intenciones validadas, sin acceso a `process`/`require`/`fetch`/temporizadores, corte por tiempo y por memoria, rechazo de resultados no permitidos, el proceso anfitrión no se contamina. EVOLVE con scripts: el planificador especifica, el desarrollador escribe el código (tarea `code_modification`) y el sandbox lo prueba (riesgo alto); el script se ejecuta en producción y deja su log; cada organización es independiente; un script que falla no impide guardar; un script roto no se puede aprobar; rollback y restauración retiran los scripts |
| `ai.test.ts` | 11 | Adaptador compatible con OpenAI (mensajes, herramientas, coste de OpenRouter), descubrimiento de modelos, errores tipados, JSON, precios, capacidades de Claude, claves cifradas, enrutado con *fallback*, límites, comparación, permisos |
| `assistant-security.test.ts` | 6 | Contexto de pantalla como datos (fuera del prompt de sistema) y herramientas, escrituras solo propuestas, sin proveedor no inventa, SSRF, cifrado con AAD, redacción de secretos |
| `security-regressions.test.ts` | 18 | Regresiones de la revisión de seguridad: solo el propietario nombra/invita administradores; API keys limitadas al rol actual de su creador y revocadas al salir; enlaces de recuperación acotados; invitaciones y verificación de email según la entrega del correo; administrador de plataforma solo por email verificado en producción; `APP_URL` obligatoria; IP del cliente no falseable; bloqueo de login no esquivable en paralelo; aprobaciones sobre versiones antiguas; permisos de lectura en informes y referencias; fórmulas que filtran datos = riesgo alto; rollback de riesgo alto solo propietario; memoria con confirmación; SSRF ampliado; logs sin tokens |
| `ai-features.test.ts` | 15 | Funciones de IA sobre los datos y correcciones: preguntas en lenguaje natural (tarea `sql_generation`, ejecución con datos reales, ronda de corrección y `422`, módulos restringidos invisibles para la IA, «Registro restringido» al agrupar por relaciones, sin API key); clasificación (tarea `customer_classification`, solo sugerencias válidas, nada se guarda, un lector no puede); análisis de documentos (tarea `document_analysis`, el archivo viaja como adjunto, formatos no admitidos); planificación con la tarea `automations`; una petición cancelada no se revive; lo que necesita la plataforma queda registrado (`kind: platform`) y las rutas del antiguo motor de código ya no existen (`404`); secreto de firma de webhooks (solo administradores, auditado); API keys sin acceso a datos personales; detección de cuentas bloqueadas; versiones filtradas por permisos |

## Build

```bash
npm run build        # Vite → dist/web · esbuild → dist/server/index.js y dist/server/cli.js
npm start            # node --enable-source-maps dist/server/index.js
```

El rol del proceso se elige con `PROCESS_ROLE` (`web`, `worker` o `all`; en producción, `web` por defecto).

## Despliegue en Railway

**Con la plantilla (recomendado, [despliegue en un clic](https://railway.com/new/template/TK1L4n)):** crea en tu proyecto los servicios `Postgres`, `Cortex` (web, dominio público) y `Worker`, genera la clave de cifrado y el token de instalación, y conecta todas las variables. Después de desplegar:

1. Abre el dominio público de `Cortex` y regístrate (se crea tu organización).
2. En *Ajustes › Mi cuenta*, pega el `PLATFORM_ADMIN_SETUP_TOKEN` (Railway › `Cortex` › *Variables*) para administrar la plataforma.
3. Configura un proveedor de IA en *Ajustes › Proveedores de IA*.

Composición exacta de la plantilla y cómo mantenerla: [docs/RAILWAY_TEMPLATE.md](docs/RAILWAY_TEMPLATE.md).

**A mano con la CLI:** el mismo `Dockerfile` en dos servicios (`PROCESS_ROLE=web` y `worker`), `DATABASE_URL=${{Postgres.DATABASE_URL}}`, una `APP_ENCRYPTION_KEY` compartida por referencia y `railway up` en cada servicio. Las migraciones se aplican solas al arrancar y el cambio de versión no corta el servicio. Guía completa: [docs/RAILWAY_DEPLOYMENT.md](docs/RAILWAY_DEPLOYMENT.md).

## Documentación

| Documento | Contenido |
|---|---|
| [PRODUCT_VISION.md](docs/PRODUCT_VISION.md) | Visión, usuarios, funcionalidades y cobertura de requisitos |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitectura, mapa del código, convenciones y decisiones (ADR) |
| [DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md) | Tablas, índices, RLS y estructuras JSON (blueprint, scripts y change set) |
| [AI_ENGINE.md](docs/AI_ENGINE.md) | EVOLVE AI ENGINE, scripts por organización, AI Provider Manager, asistente y memoria |
| [SECURITY.md](docs/SECURITY.md) | Modelo de amenazas, controles implementados y endurecimiento pendiente |
| [API_SPECIFICATION.md](docs/API_SPECIFICATION.md) | Todos los endpoints, autenticación, errores y ejemplos |
| [RAILWAY_DEPLOYMENT.md](docs/RAILWAY_DEPLOYMENT.md) | Despliegue, variables, rollback, CI opcional, copias y monitorización |
| [DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md) | Estado por fases, limitaciones y hoja de ruta |

## Limitaciones conocidas

- Los adaptadores de IA están probados con HTTP simulado, **no contra las APIs reales** (en la última verificación de producción no había ninguna clave de proveedor configurada); Gemini, Mistral y Groq son experimentales. El envío de PDF a OpenAI y OpenRouter (parte `file` de Chat Completions) está implementado pero sin probar contra sus APIs ni cubierto por tests; el resto de proveedores compatibles con OpenAI rechazan los PDF.
- La escritura de código de scripts por un modelo real no se ha ejercitado (solo con el proveedor simulado); un script no puede usar red ni credenciales, y lo que necesita una funcionalidad nueva de la plataforma solo queda registrado en la petición.
- WhatsApp y Telegram están implementados pero sin probar con credenciales reales; Gmail, Outlook y Slack no están implementados (requieren apps OAuth de plataforma).
- El correo requiere `RESEND_API_KEY` + `EMAIL_FROM` (sin configurar en la última verificación de producción); la verificación de email no bloquea el uso (con el correo configurado, solo muestra un aviso).
- *Rate limiting* en memoria por instancia; respuestas del asistente sin *streaming*; sin 2FA/SSO; sin facturación; sin tests E2E en CI; archivos en PostgreSQL; la aplicación se conecta a PostgreSQL como superusuario (RLS mediante `SET LOCAL ROLE`).

Detalle y plan: [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md).
