# Estado del desarrollo y hoja de ruta

## 1. Estado por fases

La numeración sigue las 8 fases de desarrollo del MASTER PROMPT; el alcance de cada fase se describe a partir de lo que realmente está entregado en el código.

| Fase | Alcance entregado | Estado | Evidencia (tests automatizados) |
|---|---|---|---|
| **1. Fundamentos e infraestructura** | Monorepo TypeScript (servidor Fastify, SPA React, lógica compartida), PostgreSQL/PGlite, migraciones con *advisory lock*, configuración validada, Dockerfile, Railway (servicios `cortex-crm` y `cortex-worker`, despliegue con `railway up`), workflow de CI opcional para GitHub Actions | ✅ Completa | Toda la suite arranca la app real sobre PGlite con migraciones |
| **2. Identidad, multi-organización y seguridad base** | Registro, login, logout, recuperación de contraseña, verificación de email, sesiones, invitaciones, 5 roles, CSRF, CSP, *rate limiting*, validación, RLS, auditoría, cifrado de secretos, API keys | ✅ Completa | `auth.test.ts` (11), `tenant-isolation.test.ts` (8) |
| **3. CRM base metadata-driven** | Blueprint versionado, CRM por defecto (empresas, contactos, oportunidades, tareas, actividades), registros con validación por tipo, relaciones, unicidad, fórmulas, vistas tabla/kanban/calendario, fichas, notas, archivos, búsqueda global, borrado lógico y restauración | ✅ Completa | `crm.test.ts` (10), `blueprint.test.ts` (11) |
| **4. Automatizaciones, paneles e informes** | Automatizaciones por evento y programadas (fecha, inactividad) con deduplicación, paneles con widgets, 5 informes, predicciones con IA, preguntas en lenguaje natural sobre los datos (consulta estructurada validada, nunca SQL; se puede añadir al panel) | ✅ Completa | `crm.test.ts`, `evolve.test.ts` (automatizaciones programadas en sandbox), `ai-features.test.ts` |
| **5. AI Provider Manager y memoria** | Claude (SDK oficial), OpenAI, DeepSeek, OpenRouter (+ Gemini, Mistral, Groq experimentales), claves cifradas/enmascaradas/revocables, catálogo de modelos por API, enrutado para 10 tareas (todas con uso: también clasificación de registros, análisis de documentos PDF/texto, planificación de automatizaciones y escritura de código de scripts), *fallback*, límites, costes, comparación, memoria por organización y usuario | ✅ Completa (sin validar contra APIs reales; PDF con OpenAI/OpenRouter sin probar) | `ai.test.ts` (11), `ai-features.test.ts` (15) |
| **6. EVOLVE AI ENGINE** | Pipeline de 10 pasos, sandbox con reloj simulado, 5 suites de pruebas, auto-corrección, revisión cruzada, riesgo determinista, aprobación por roles, publicación transaccional, verificación con rollback automático, rollback manual, restauración de versiones, copias, cambios manuales, refinado, cancelación definitiva aunque el pipeline esté en curso | ✅ Completa | `evolve.test.ts` (11), `ai-features.test.ts` |
| **7. Asistente contextual, comunicaciones y scripts por organización** | Asistente con contexto de pantalla y herramientas (escrituras solo propuestas); conectores WhatsApp y Telegram; arquitectura para Gmail/Outlook/Slack; **scripts por organización** (especificados por el planificador, escritos por el desarrollador con la tarea `code_modification`, probados en el sandbox QuickJS/WebAssembly, aprobados por un propietario y versionados con el blueprint; sin ningún repositorio), que sustituyen al antiguo motor de código basado en GitHub, eliminado por completo; peticiones que necesitan la plataforma registradas con `platformRequest` | ✅ Completa (conectores sin validar en real; código de scripts generado solo con el proveedor simulado) | `assistant-security.test.ts` (6), `scripts.test.ts` (12), `ai-features.test.ts` |
| **8. Seguridad avanzada, endurecimiento y comercialización** | Analizador de seguridad (automático + IA) y endurecimiento **hechos** (SSRF con análisis IPv6 y nombres internos, AAD, aislamiento de scripts en QuickJS con límites de memoria y tiempo, redacción de logs, cabeceras, IP de cliente no falseable, API keys ligadas a su creador, administrador de plataforma solo por verificación o CLI, aprobaciones con caducidad, CLI de operación, secreto de firma de webhooks visible para administradores, API keys sin acceso a datos personales, versiones filtradas por permisos, `503 busy` ante saturación de scrypt, detección de cuentas bloqueadas); facturación, planes y demás capacidades comerciales **pendientes** | 🟡 Parcial | `security-regressions.test.ts` (18), `ai-features.test.ts`, `scripts.test.ts`, `assistant-security.test.ts`, `auth.test.ts` |

**Tests**: 277 tests en 19 archivos (`npm test`; 277 superados): `ai` 11, `ai-features` 15, `appearance` 24, `assistant-security` 6, `audit-hardening` 29, `audit-hardening-access` 11, `auth` 11, `blueprint` 11, `code-engine` 38, `crm` 10, `evolve` 11, `expansion` 7, `extensibility` 7, `jobs-webhooks` 19, `scripts` 12, `scripts-sandbox` 19, `security-regressions` 18, `template` 10 y `tenant-isolation` 8. Se ejecutan contra PostgreSQL embebido (PGlite) y un proveedor de IA simulado. El workflow de CI (`.github/workflows/ci.yml`) ejecuta además *typecheck*, build y `npm audit` de dependencias de producción en cada cambio del repositorio público de la plataforma.

**Producción** (última verificación real, hecha **antes** de los últimos cambios del código; el redespliegue con el código actual está en curso y sus resultados aún no se han comprobado): prueba de humo en navegador 13/13, *rate limiting* del login (10 × `401` y después `429`), IP real del cliente en la auditoría, migraciones 001–003 aplicadas, RLS en 26 tablas y worker procesando trabajos. Sin claves de proveedores de IA ni correo (Resend) configurados. Detalle en [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md#14-último-estado-verificado-en-producción).

## 2. Limitaciones y pendientes (sin adornos)

| Área | Situación |
|---|---|
| **Proveedores de IA** | Los adaptadores (SDK oficial de Anthropic; compatible con OpenAI para OpenAI, DeepSeek, OpenRouter, Gemini, Mistral y Groq) tienen tests unitarios con HTTP simulado, pero **no se han ejercitado contra las APIs reales** durante el desarrollo por falta de claves. Gemini, Mistral y Groq están marcados como experimentales. El envío de PDF a OpenAI y OpenRouter (parte `file`) está implementado sin probar contra sus APIs y sin tests automáticos |
| **Scripts por organización** | La planificación y la escritura de su código solo se han probado con el proveedor simulado. No tienen red ni credenciales: las integraciones externas siguen necesitando una funcionalidad de la plataforma. Su ejecución es síncrona en el proceso que la dispara (≤ 3 s y 16 MB por ejecución) |
| **Peticiones que necesitan la plataforma** | `requiresPlatformChange` + `platformRequest` solo quedan guardados en la petición de la organización; no hay una vista de plataforma que las reúna ni un flujo para tratarlas |
| **WhatsApp y Telegram** | Implementados (verificación de firmas, vinculación con contactos, envío), **sin probar contra las APIs reales** por falta de credenciales |
| **Gmail, Outlook, Slack** | Arquitectura preparada; **intencionadamente no implementados** (necesitan aplicaciones OAuth de plataforma) y mostrados como no disponibles en la interfaz |
| **Correo** | Requiere `RESEND_API_KEY` + `EMAIL_FROM`. Sin él, los propietarios pueden generar enlaces de restablecimiento y las invitaciones devuelven el enlace; la verificación de email no es obligatoria para usar la aplicación (con correo configurado solo muestra un aviso), pero sí para obtener el rol de administrador de plataforma desde la web (alternativa: CLI `dist/server/cli.js`) |
| **Base de datos** | La aplicación se conecta como superusuario (`postgres`); RLS se aplica mediante `SET LOCAL ROLE evolve_tenant` en cada `db.tenant()`. Un rol de conexión dedicado sin superusuario sería más robusto |
| **Rate limiting** | En memoria por instancia; con varias réplicas web hace falta un almacén compartido |
| **Asistente** | Las respuestas no se transmiten en *streaming* todavía (previsto: SSE) |
| **Autenticación avanzada** | Sin 2FA ni SSO |
| **Comercial** | Sin facturación ni planes (previsto: Stripe); la columna `workspaces.plan` existe pero no tiene lógica |
| **Pruebas** | Sin tests E2E con Playwright ni CI obligatorio (el workflow de GitHub Actions es opcional) |
| **Archivos** | Guardados en PostgreSQL (previsto: Railway Buckets/S3) |
| **Fórmulas con agregados** | Los campos con `COUNT/SUM/AVG_RELATED` se recalculan al cambiar los registros relacionados y cada hora (las que usan `TODAY`/`DAYS_*` también cada hora) |

### Observaciones técnicas detectadas al documentar

| Tema | Detalle |
|---|---|
| Verificación de módulos nuevos | La verificación posterior hace consultas reales solo sobre las vistas de módulos ya existentes; los creados se verifican repitiendo las pruebas de aceptación |
| Revisión cruzada | Si no hay un proveedor distinto del de la última llamada del pipeline (por ejemplo, con un único proveedor configurado), la revisión cruzada se omite |
| Listado de peticiones de EVOLVE | `GET /api/evolve/requests` sin `kind` (la lista de la página de EVOLVE) solo devuelve `config` y `code`, y el filtro no admite `script` ni `platform`: las peticiones que el pipeline reclasifica así desaparecen de esa lista |
| Restos del motor de código | La tabla `code_changes` sigue en la migración 001 y en `TENANT_TABLES` sin ningún uso; `.env.example` conserva líneas `GITHUB_*` que el código no lee |
| Estado `deploying` y `ai_providers.base_url` | Existen (constante de estados y columna) pero no se usan |
| Índice GIN de `records` | Los filtros generados usan `data->>'campo'` y no aprovechan el índice GIN; con volumen harán falta índices de expresión |
| Precios y capacidades de modelos | La tabla de precios de Claude, el modelo sugerido de Anthropic y la detección de capacidades por nombre de modelo están en el código y hay que mantenerlos |
| Indicador de PDF | El adaptador envía PDF a OpenAI y OpenRouter, pero su `supportsPdf` del catálogo sigue en `false`, así que Ajustes › Proveedores de IA los muestra sin «PDF nativo» |
| Tarea de planificación | La elección entre `automations` y `feature_creation` es una heurística de palabras clave en español sobre el texto de la petición |

Las observaciones de seguridad (2FA, verificación de email, rotación de secretos, archivos, CAPTCHA, CSP, tratamiento de datos por proveedores de IA, usuario de base de datos, scripts, etc.) están en [SECURITY.md](SECURITY.md#4-endurecimiento-pendiente-y-observaciones).

## 3. Hoja de ruta propuesta

> Propuesta de priorización para el responsable de producto; no describe funcionalidades existentes.

### Corto plazo (0–6 semanas): poner en producción con garantías

1. **Verificar el redespliegue en curso** (servicios `cortex-crm` y `cortex-worker`) repitiendo las comprobaciones de [RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md#5-verificación-tras-desplegar), incluido un script de prueba de punta a punta.
2. **Validar los proveedores de IA con claves reales** (Anthropic, OpenAI, DeepSeek, OpenRouter): prueba de humo por proveedor, planificación y escritura de código de scripts con modelos reales, ajustar el mapeo de errores y decidir si Gemini/Mistral/Groq salen de «experimental».
3. **Validar WhatsApp y Telegram** con credenciales reales (firma, vinculación, envío, ventana de 24 h de WhatsApp).
4. **Operación**: correo con Resend y dominio verificado; comprobaciones locales (typecheck, tests, build y `npm audit`) antes de cada `railway up`; PITR y copias programadas de Postgres; monitor externo de `/api/health`.
5. **Cerrar observaciones**: que el listado de EVOLVE muestre también las peticiones `script` y `platform`; probar el análisis de PDF con Anthropic, OpenAI y OpenRouter reales y alinear el indicador `supportsPdf` del catálogo con lo que hace el adaptador; verificar con consultas reales también las vistas de los módulos creados en un cambio; retirar las líneas `GITHUB_*` de `.env.example`.
6. **Streaming SSE** de las respuestas del asistente.
7. **Tests E2E con Playwright** para los flujos críticos: registro/login, crear y editar registros, petición EVOLVE → aprobación → publicación → rollback, y un script de organización de punta a punta.
8. **Verificación de email configurable** como requisito para acciones sensibles.

### Medio plazo (1–3 meses): escalar y vender

1. **2FA (TOTP)** para propietarios y administradores; **SSO (OIDC/SAML)** para empresas.
2. **Facturación y planes con Stripe**: límites por plan (usuarios, almacenamiento, presupuesto de IA, número de scripts), periodo de prueba (la columna `plan` ya existe).
3. **Archivos en Railway Buckets/S3** con URLs firmadas y escaneo antivirus.
4. **Redis** para *rate limiting* compartido y notificaciones en tiempo real (pub/sub), habilitando varias réplicas web.
5. **Gmail y Outlook** (aplicaciones OAuth verificadas) y **Slack**.
6. **Importación de datos** (CSV y desde otros CRM) con el mismo modelo de validación por campos.
7. **Rendimiento**: índices de expresión para los campos JSONB más consultados, métricas de consultas lentas y ejecución de scripts fuera del hilo principal si su uso crece.
8. **Seguridad de la base de datos**: rol de conexión dedicado sin superusuario.
9. **Ampliar las funciones de IA sobre los datos**: análisis de formatos de Office (hoy solo PDF y texto) y elección del panel al que se añade una consulta (hoy, siempre el primero).

### Largo plazo (3–12 meses): plataforma

1. **Plantillas de CRM por sector** (blueprints listos para inmobiliarias, agencias, SaaS…) instalables como change sets.
2. **API pública documentada** (OpenAPI) y SDK; webhooks de eventos configurables por organización.
3. **Vista de plataforma para las peticiones que necesitan funcionalidades nuevas** (`platformRequest`) y métricas de calidad de los cambios y scripts generados.
4. **Residencia de datos / multi-región** y réplicas de lectura.
5. **Analítica avanzada** (previsiones con el histórico propio de cada organización).
6. **Cumplimiento**: herramientas RGPD (borrado/anonimización, solicitudes de interesados), contratos de encargo con proveedores de IA, preparación para ENS/ISO 27001.
7. **PWA/app móvil** para el equipo comercial.
