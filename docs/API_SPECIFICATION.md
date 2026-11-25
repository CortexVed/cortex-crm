# Especificación de la API

> Generada a partir de los archivos de rutas de `server/src` (112 endpoints, incluido `/api/health`). Base: `https://<dominio-de-tu-instalación>/api`. Todas las rutas hablan JSON salvo la subida y descarga de archivos.

## 1. Convenciones

### 1.1 Autenticación

| Modo | Cómo | Notas |
|---|---|---|
| **Sesión** (navegador) | Cookie `evolve_session` (`httpOnly`; nombre interno que se mantiene) que fija `POST /api/auth/login` o `/register` | En métodos que modifican (POST, PUT, PATCH, DELETE) hay que enviar `X-CSRF-Token: <csrfToken>` (lo devuelve `/api/auth/me`); si se envía `Origin`, debe ser el de la aplicación |
| **API key** (integraciones) | `Authorization: Bearer evk_<prefijo>_<secreto>` | Creada en Ajustes › API keys; actúa dentro de su organización con el menor rol entre el de la clave y el actual de su creador, y deja de funcionar si el creador sale de la organización; sin CSRF. No accede a los datos personales de su creador (notificaciones, conversaciones del asistente, memoria de IA) ni a las funciones de IA sobre los datos |
| **Pública** | Sin credenciales | Webhooks entrantes, formularios públicos, salud, configuración de login |

En las tablas, la columna **Auth** indica: `S` = solo sesión de usuario (una API key recibe `403`); `S/K` = sesión o API key; `P` = pública; `PA` = administrador de plataforma con sesión.

### 1.2 Roles

`viewer` (Lector) < `member` (Miembro) < `builder` (Constructor) < `admin` (Administrador) < `owner` (Propietario). «Módulo» en la columna de rol significa que manda el permiso del módulo en el blueprint (`permissions.read/create/update/delete`; por defecto lectura `viewer` y escritura `member`).

### 1.3 Formato de error

```json
{ "error": { "code": "validation_failed", "message": "Datos no válidos", "details": [ { "path": "email", "message": "Email inválido" } ] } }
```

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `validation_failed` | Esquema zod no superado (`details`: hasta 20 `{path, message}`) |
| 400 | `bad_request`, `invalid_password`, `connector_error` | Petición incorrecta |
| 401 | `unauthorized` | Sin sesión, sesión caducada, API key inválida o revocada, firma de webhook inválida |
| 403 | `forbidden` | Rol insuficiente, CSRF ausente/incorrecto, origen no permitido, acción que exige sesión hecha con API key |
| 404 | `not_found` | Recurso inexistente **o de otra organización** |
| 409 | `conflict` | Estado incompatible (p. ej. publicar sin aprobar, rollback de una versión que no es la última) |
| 409 | `ai_not_configured` | No hay proveedor de IA utilizable |
| 413 | (código de Fastify) | Cuerpo demasiado grande |
| 422 | `validation_failed` | Datos de registro inválidos: `details.fields = [{field, message}]`; también una pregunta de `POST /api/ai/query` que no se pudo convertir en una consulta válida |
| 429 | `rate_limited`, `ai_limit_exceeded` | Límite de frecuencia o límite/presupuesto de IA |
| 502 | `ai_unavailable`, `ai_<código>` | Fallo del proveedor de IA (`details`: intentos por proveedor) |
| 503 | `busy` | Servidor ocupado: hay 4 cálculos de contraseña en curso y 200 en cola (registro, login, cambio o restablecimiento de contraseña, aceptar invitación). Reintentar en unos segundos |
| 500 | `internal` | Error no controlado (incluye `requestId`; en producción sin detalles) |

### 1.4 Límites de frecuencia

Límite global de 600 peticiones por minuto e IP, más los límites por ruta indicados en la columna **Lím./min**. Superarlos devuelve `429 rate_limited`.

### 1.5 Tipos comunes

```ts
Me = {
  user: { id, name, email, emailVerified, isPlatformAdmin },
  workspace: { id, name, slug, role, version } | null,   // organización activa
  workspaces: { id, name, role }[],
  csrfToken: string | null,
  features: { emailEnabled, signupEnabled }
}
Record = { id, module, data: {<campo>: valor}, createdAt, updatedAt, lastActivityAt, createdBy, updatedBy }
Refs = {
  records: { <id>: { title, module } },    // títulos de relaciones ("Registro restringido" si el rol no puede leer ese módulo)
  users:   { <id>: nombre },
  files:   { <id>: { name, size, mime } }
}
Condition = { field, operator: 'eq'|'neq'|'gt'|'gte'|'lt'|'lte'|'contains'|'not_contains'|'is_empty'|'is_not_empty'|'in'|'changed', value? }
```

Identificadores UUID; fechas ISO 8601; importes como números; las plantillas `{{today}}`, `{{today-30d}}`, `{{month_start}}`… son válidas en los valores de los filtros.

## 2. Sistema

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/health` | P | `200 {status:"ok", role, db:"ok", version:{sha, name:"cortex-crm", version}, time}` o `503` (`status:"degraded"`). El worker expone `/api/health` con `{status, role:"worker", version}` |

## 3. Autenticación (`/api/auth`)

| Método | Ruta | Auth | Lím./min | Descripción |
|---|---|---|---|---|
| GET | `/config` | P | | `{signupEnabled, emailEnabled}` |
| POST | `/register` | P | 10 | Crea usuario + organización (propietario) con el CRM base; fija la cookie; envía verificación. → `Me`. En producción nunca concede el rol de administrador de plataforma |
| POST | `/login` | P | 10 | → `Me` + cookie. `401` genérico; `429` si la cuenta está bloqueada |
| POST | `/logout` | P | | Cierra la sesión actual. → `{ok}` |
| GET | `/me` | S | | → `Me` |
| POST | `/switch-workspace` | S | | `{workspaceId}` → `Me` (`403` si no es miembro) |
| POST | `/workspaces` | S | 10 | `{name}` crea otra organización y la activa (máx. 10 propias) → `Me` |
| GET | `/sessions` | S | | `[{id (16 hex), current, ip, userAgent, createdAt, lastSeenAt, expiresAt}]` |
| DELETE | `/sessions/:id` | S | | Revoca otra sesión (no la actual) → `{ok}` |
| POST | `/logout-all` | S | | Cierra todas las demás sesiones → `{ok}` |
| POST | `/password/forgot` | P | 5 | `{email}` → `{ok, emailEnabled}` (idéntico exista o no la cuenta) |
| POST | `/password/reset` | P | 10 | `{token, password}` → `{ok, apiKeysRevoked}`; token de un uso (1 h; 30 min si lo generó un propietario); cierra todas las sesiones y revoca las API keys creadas por la cuenta |
| POST | `/password/change` | S | 10 | `{currentPassword, newPassword}` → `{ok}`; cierra las demás sesiones |
| POST | `/verify-email` | P | 10 | `{token}` → `{ok}`. Solo marca el email como verificado (`auth.email_verified`); nunca concede privilegios |
| POST | `/verify-email/resend` | S | 5 | → `{ok, emailEnabled}` o `{ok, alreadyVerified:true}` |
| POST | `/platform-admin/claim` | S | 5 | `{token}` → `{ok}`. Con el token de instalación (`PLATFORM_ADMIN_SETUP_TOKEN`), la cuenta pasa a ser administradora de la plataforma. `404` si no hay token configurado, `403` si no coincide (auditado), `409` si ya hay administración. `Me.features.platformSetupAvailable` indica si está disponible |
| GET | `/invite/:token` | P | | `{email, role, workspaceName, userExists}` |
| POST | `/invite/accept` | P | 10 | `{token, name?, password?}` → `Me`. Si el email ya tiene cuenta, hay que tener sesión con ella; si no, `name` y `password` crean la cuenta, que nace con el email verificado solo si esa invitación se entregó por correo |

Cuerpos: `register` = `{name (2–80), email, password, workspaceName (2–80)}`; contraseñas de 10–200 caracteres con letras y números o símbolos.

## 4. Organización, equipo y notificaciones

| Método | Ruta | Rol | Auth | Lím./min | Descripción |
|---|---|---|---|---|---|
| GET | `/api/workspace` | viewer | S/K | | `{id, name, slug, plan, version, settings, role}` |
| PATCH | `/api/workspace` | admin | S | | `{name?, settings?: {timezone, currency (ISO 4217), locale, industry, description, approval: {requireDistinctApprover}}}` → `{ok, settings}`. `approval` solo propietarios; zona horaria validada |
| GET | `/api/workspace/members` | viewer | S/K | | `[{id, name, email, role, joinedAt}]` |
| PATCH | `/api/workspace/members/:userId` | admin | S | | `{role}` → `{ok}`. Solo propietarios gestionan propietarios y nombran administradores; un administrador no modifica a otro; siempre queda un propietario |
| DELETE | `/api/workspace/members/:userId` | admin | S | | Quita al miembro, desvincula sus sesiones y revoca sus API keys → `{ok}` |
| POST | `/api/workspace/members/:userId/reset-link` | owner | S | | → `{link, expiresInMinutes: 60}` (enlace de restablecimiento para compartir si no hay correo). No disponible para propietarios, administradores de plataforma, miembros de otras organizaciones ni para uno mismo |
| GET | `/api/workspace/invites` | admin | S/K | | Invitaciones pendientes `[{id, email, role, created_at, expires_at}]` |
| POST | `/api/workspace/invites` | admin | S | 20 | `{email, role: admin\|builder\|member\|viewer}` → `{link, emailSent}`. Con el correo entregado responde `{link: null, emailSent: true}` (el enlace solo llega al buzón invitado); sin correo o si el envío falla, devuelve el enlace para compartirlo y la cuenta creada al aceptarlo queda con el email sin verificar. `admin` solo lo invita un propietario; caduca en 7 días |
| DELETE | `/api/workspace/invites/:id` | admin | S | | → `{ok}` |
| GET | `/api/workspace/api-keys` | admin | S/K | | `[{id, name, prefix, role, created_at, last_used_at, revoked_at, created_by_name}]` |
| POST | `/api/workspace/api-keys` | admin | S | | `{name (2–60), role? = member}` → `{id, key, prefix, name, role}`. **`key` solo se devuelve aquí**; rol `admin` solo para propietarios |
| DELETE | `/api/workspace/api-keys/:id` | admin | S | | Revoca → `{ok}` |
| POST | `/api/workspace/integrations/:key/signing-secret` | admin | S | | Secreto de firma de los webhooks salientes de una integración del blueprint (sección 16) → `{secret, algorithm: "HMAC-SHA256", headers: {signature: "X-Cortex-Signature", timestamp: "X-Cortex-Timestamp", event: "X-Cortex-Event"}, signedPayload: "<X-Cortex-Timestamp>.<cuerpo JSON sin modificar>"}`; `404` si la integración no existe. Auditado como `integration.signing_secret_viewed` |
| GET | `/api/workspace/audit?page=1&action=<prefijo>` | admin | S/K | | `{items: [{id, action, actor_type, target_type, target_id, meta, ip, created_at, actor_name}], page}` (50 por página) |
| GET | `/api/workspace/export` | admin | S | 3 | Descarga JSON `{exportedAt, workspace, blueprint, records[], notes[]}` (el blueprint incluye los scripts de la organización) |
| GET | `/api/notifications` | viewer | S | | `{items (50 últimas), unread}` del usuario |
| POST | `/api/notifications/:id/read` | viewer | S | | → `{ok}` |
| POST | `/api/notifications/read-all` | viewer | S | | → `{ok}` |

## 5. CRM: estructura y registros

| Método | Ruta | Rol | Auth | Descripción |
|---|---|---|---|---|
| GET | `/api/blueprint` | viewer | S/K | `{version, settings, blueprint}` con solo los módulos que el rol puede leer (el resto del blueprint, incluidos `automations` y `scripts`, se devuelve completo) |
| GET | `/api/records/:module` | módulo (leer) | S/K | Listado (ver parámetros) → `{items: Record[], total, page, pageSize, refs: Refs}` |
| POST | `/api/records/:module` | módulo (crear) | S/K | `{values}` → `{record, refs}`; `422` con errores por campo. Las automatizaciones y scripts que dispara se ejecutan en la misma transacción; si fallan, el registro se guarda igualmente y la ejecución queda como `failed` |
| GET | `/api/records/:module/:id` | módulo (leer) | S/K | `{record, related, refs}`; `related` = `[{module, label, icon, field, fieldLabel, total, items (≤ 8)}]` (relaciones inversas) |
| PATCH | `/api/records/:module/:id` | módulo (editar) | S/K | `{values}` (parcial; `null` vacía un campo) → `{record, refs}` |
| DELETE | `/api/records/:module/:id` | módulo (borrar) | S/K | Borrado lógico, auditado → `{ok}` |
| POST | `/api/records/:module/:id/restore` | admin | S/K | Restaura un registro borrado → `{ok}` |
| GET | `/api/records/:module/:id/timeline` | módulo (leer) | S/K | `{items}` ordenados por fecha: `history` (`action`, `changes`, `actor`), `note`, `message` (canal, dirección), `automation` (nombre, estado, log; incluye las trazas `[script]` de los scripts) |
| POST | `/api/records/:module/:id/notes` | member | S/K | `{body (1–10.000)}` → `{id}` |
| POST | `/api/records/:module/:id/classify` | member + editar el módulo | S | Clasificación con IA (tarea `customer_classification`, 10/min): sugiere valores para los campos `select`/`multi_select` → `{summary, suggestions: [{field, label, value, valueLabel, current, confidence, reason, multi}], provider, model, costUsd}`. No guarda nada (se aplica con `PATCH`); `400` si el módulo no tiene campos de selección. Detalle en [AI_ENGINE.md](AI_ENGINE.md) |
| DELETE | `/api/notes/:id` | member | S/K | Solo la propia (o administrador) → `{ok}` |

**Parámetros de `GET /api/records/:module`**:

| Parámetro | Descripción |
|---|---|
| `view` | Clave de una vista del módulo: aplica sus filtros y su orden |
| `search` | Texto libre (≤ 200) sobre campos de texto, email, teléfono y URL |
| `filters` | JSON (codificado en la URL) con un array de hasta 20 `Condition`; solo campos del módulo o de sistema (`id`, `created_at`, `updated_at`, `last_activity_at`, `created_by`) |
| `sort`, `dir` | Campo de orden y `asc`/`desc` |
| `page`, `pageSize` | Paginación (por defecto 1 y 50; `pageSize` máx. 500) |

Valores de `values`: ver la tabla de tipos de campo en [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md#73-tipos-de-campo-y-almacenamiento-en-recordsdata) (las opciones de selección admiten valor o etiqueta; relaciones y usuarios, UUID; los campos calculados no se envían).

## 6. Archivos

| Método | Ruta | Rol | Auth | Lím./min | Descripción |
|---|---|---|---|---|---|
| GET | `/api/records/:module/:id/files` | módulo (leer) | S/K | | `[{id, name, mime, size, field_key, created_at, uploaded_by}]` |
| POST | `/api/files` | member (+ editar el módulo si se vincula) | S/K | 30 | Cuerpo binario `Content-Type: application/octet-stream`; cabeceras `X-File-Name` (codificado con `encodeURIComponent`), `X-Record-Id?`, `X-Field-Key?` → `{id, name, mime, size}` |
| GET | `/api/files/:id?inline=1` | módulo (leer) | S/K | | Contenido binario; `attachment` salvo `inline=1` en PDF/imágenes |
| DELETE | `/api/files/:id` | member | S/K | | Solo el propio (o administrador), auditado → `{ok}` |
| POST | `/api/files/:id/analyze` | member (+ leer el módulo del registro vinculado) | S | 6 | Análisis con IA (tarea `document_analysis`) de un PDF (≤ 8 MB) o texto (txt, csv, md, json; recortado a 150.000 caracteres) → `{analysis: {summary, keyPoints, dates, amounts, risks, suggestedTasks}, file: {id, name}, moduleKey, recordId, truncated, provider, model, costUsd}`. Otros formatos o PDF más grandes → `400` |

Extensiones admitidas: pdf, png, jpg, jpeg, gif, webp, txt, csv, md, json, doc, docx, xls, xlsx, ppt, pptx, odt, ods, zip. Máximo `MAX_UPLOAD_MB` (10 MB) por archivo y 1 GB por organización. Para usar el archivo en un campo de tipo `file`, se envía su `id` en `values` del registro.

## 7. Búsqueda, selectores, paneles e informes

| Método | Ruta | Rol | Auth | Lím./min | Descripción |
|---|---|---|---|---|---|
| GET | `/api/lookup/:module?q=&ids=` | módulo (leer) | S/K | | Selector de relaciones: `[{id, title}]` (20; `ids` separados por comas, máx. 100) |
| GET | `/api/members/lookup` | viewer | S/K | | `[{id, name, email, role}]` |
| GET | `/api/search?q=` | viewer | S/K | | Búsqueda global en los módulos legibles: `{groups: [{module, label, icon, total, items: [{id, title, subtitle}] (≤ 5)}]}` |
| GET | `/api/dashboards/:key/data` | viewer | S/K | | `{dashboard, data: {<widget>: WidgetData}}`. Un widget de un módulo que el rol no puede leer devuelve `{type: 'error', message: 'Sin acceso'}`; al agrupar por una relación hacia un módulo no legible, las etiquetas son «Registro restringido» |
| GET | `/api/pages/:key/data` | viewer (+ rol mínimo de la página) | S/K | | Página propia del blueprint (`blueprint.pages`) → `{page, data: {<widget>: WidgetData}}`. La página se resuelve con la misma visibilidad que `/api/blueprint` (`404` si no existe o el rol no llega a su `minRole`; sin los bloques de módulos que el rol no puede leer) y solo se calculan los widgets legibles. Las listas de registros de la página se piden a `/api/records/:module` con sus permisos |
| GET | `/api/reports/:type` | viewer (+ leer los módulos del informe) | S/K | | `type` ∈ `sales`, `conversion`, `activity`, `performance`, `customers` → `Report`; `403` si el rol no puede leer alguno de los módulos que agrega |
| POST | `/api/reports/predictions` | member (+ leer oportunidades) | S/K | 6 | Predicción con IA → `{text (Markdown), provider, model, costUsd}` |

```ts
WidgetData =
  | { type: 'metric', value, format: 'currency'|'number'|'percent', currency? }
  | { type: 'bar'|'donut'|'line', points: [{key, label, value, color?}], format, currency? }
  | { type: 'list', module, items: [{id, title, subtitle?}] }
  | { type: 'error', message }
Report = {
  type, title, description,
  available: boolean, missing: string[],       // p. ej. ["deals.amount"] si el blueprint no tiene lo necesario
  kpis: [{label, value, format}],
  charts: [{key, title, type: 'bar'|'line'|'donut'|'funnel', format, points}],
  table?: { columns: [{key, label, format?}], rows }   // informe "performance"
}
```

## 8. IA: proveedores, ajustes, uso, consultas y memoria (`/api/ai`)

| Método | Ruta | Rol | Auth | Lím./min | Descripción |
|---|---|---|---|---|---|
| GET | `/status` | viewer | S/K | | `{configured, providers: [{id, label, model}]}` |
| GET | `/providers` | admin | S/K | | `ProviderState[]` (nunca incluye claves) |
| PUT | `/providers/:id` | admin | S | 20 | `{apiKey?: string\|null, enabled?, defaultModel?: string\|null}` → `ProviderState`. `apiKey: null` o `""` revoca |
| DELETE | `/providers/:id/key` | admin | S | | Revoca la clave → `{ok}` |
| GET | `/providers/:id/models?refresh=1` | admin | S/K | 20 | `{models: [{id, name, contextLength, pricing: {inputPerM, outputPerM}\|null, description}], cachedAt}` (caché de 6 h) |
| POST | `/providers/:id/test` | admin | S/K | 10 | `{ok, error, latencyMs, model}` |
| GET | `/settings` | admin | S/K | | `{settings, tasks: [{key, label}], effectiveRoutes: {<tarea>: [{provider, model}]}}` |
| PUT | `/settings` | admin | S | | Ver cuerpo abajo → ajustes guardados |
| GET | `/usage?days=30` | admin | S/K | | `{days, totals, byModel, byTask, daily, recentErrors}` |
| POST | `/compare` | admin | S | 6 | `{prompt (2–8000), system?, targets: [{provider, model}] (2–4)}` → `{results: [{provider, model, ok, text, latencyMs, inputTokens, outputTokens, costUsd, servedModel} \| {provider, model, ok:false, error}]}` |
| POST | `/query` | viewer | S | 10 | Pregunta en lenguaje natural (tarea `sql_generation`; la ruta está en `crm/routes.ts`): `{question (4–500)}` → `{widget, data: WidgetData, explanation, provider, model, costUsd}`. El modelo devuelve una consulta estructurada (nunca SQL) que se valida contra los módulos que el rol puede leer y se calcula como un widget. `422` si tras una ronda de corrección sigue sin ser válida; `403` si el rol no puede leer ningún módulo |
| GET | `/memory` | member | S | | Memoria de organización + personal (≤ 200) |
| POST | `/memory` | member (`org`: admin) | S | | `{scope: org\|user, kind: decision\|preference\|fact\|instruction, content (3–2000)}` → `{id}` |
| PATCH | `/memory/:id` | member | S | | `{content}` → `{ok}` (organización: administradores; personal: su autor) |
| DELETE | `/memory/:id` | member | S | | Archiva → `{ok}` |

```ts
ProviderState = {
  id, label, tier: 'core'|'experimental', description, docsUrl, keyHint,
  configured, keySource: 'workspace'|'platform'|null, keyHint_masked /* "••••1234" */,
  enabled, defaultModel, modelsCount, modelsCachedAt, lastTestAt, lastTestOk, lastError,
  capabilities: { tools, json, pdf, publicModels, reportsCost }
}
// PUT /api/ai/settings
{
  defaultProvider?: string | null, defaultModel?: string | null,
  routing?: { <tarea>: [{ provider, model }] },   // ≤ 5 por tarea; tareas: chat, crm_analysis, feature_creation,
                                                   // code_modification, code_review, security, sql_generation,
                                                   // automations, document_analysis, customer_classification
  limits?: { monthlyBudgetUsd?: number | null, maxRequestsPerHour?: 1..10000,
             maxOutputTokens?: 256..128000, disabledTasks?: string[] },
  pricing?: { "<proveedor>:<modelo>": { inputPerM, outputPerM } }   // USD por millón de tokens
}
```

`code_modification` es la tarea con la que el desarrollador de EVOLVE escribe el código de los scripts de la organización, y `code_review` la de la revisión cruzada de los change sets.

## 9. Asistente (`/api/assistant`)

| Método | Ruta | Rol | Auth | Lím./min | Descripción |
|---|---|---|---|---|---|
| GET | `/conversations` | viewer | S | | `[{id, title, updated_at}]` (30 del usuario) |
| GET | `/conversations/:id` | viewer | S | | `{id, title, messages: [{id, role, content, context, tool_calls, provider, model, created_at}]}` |
| DELETE | `/conversations/:id` | viewer | S | | → `{ok}` |
| POST | `/chat` | viewer | S | 20 | Ver abajo |

```ts
// POST /api/assistant/chat
{ conversationId?: uuid, message: string /* 1–6000 */, context?: { path?, module?, recordId? } }
// → 200
{
  conversationId,
  message: {
    id, role: 'assistant', content /* Markdown */, provider, model,
    toolCalls: [{ name, input, isError? }],
    actions: [{ type: 'record_change' | 'evolution' | 'memory', summary, payload }]   // propuestas: requieren confirmación
  }
}
```

`payload` de `record_change`: `{action: create|update, module, moduleLabel, id?, values}` (la interfaz lo confirma con `POST/PATCH /api/records/...`); de `evolution`: `{prompt}` (se confirma con `POST /api/evolve/requests`); de `memory`: `{scope, kind, content}` (se confirma con `POST /api/ai/memory`). Errores típicos: `409 ai_not_configured`, `429 ai_limit_exceeded`, `502 ai_unavailable`.

## 10. EVOLVE AI ENGINE (`/api/evolve`)

| Método | Ruta | Rol | Auth | Lím./min | Descripción |
|---|---|---|---|---|---|
| GET | `/steps` | — | P | | Pasos del pipeline `[{key, label}]` (`interpret`, `analyze`, `plan`, `develop`, `test`, `review`, `present`) |
| GET | `/requests?kind=` | viewer | S/K | | `kind` ∈ `config`, `code`, `security`, `advice`; sin `kind`, devuelve las de `kind` `config` y `code`: `[{id, kind, source, prompt, status, risk, title, created_at, updated_at, requested_by_name}]` (100). El filtro no admite `script` ni `platform`, así que las peticiones que el pipeline reclasifica así no aparecen en este listado (limitación conocida; ver [AI_ENGINE.md](AI_ENGINE.md#14-limitaciones-conocidas)) |
| POST | `/requests` | builder | S | 10 | `{prompt (8–4000)}` → `{id}`; crea la petición con `kind: config` y encola el pipeline |
| POST | `/requests/manual` | admin | S | | `{changeSet}` (ver [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md#8-estructura-json-del-change-set-sharedchangesetts); al menos una operación) → `{id}`. Sin IA: un `upsert_script` debe traer su código. Lo usan el editor de personalización, el panel, «Añadir al panel» y activar/desactivar un script |
| GET | `/requests/:id` | viewer | S/K | | Petición completa (`kind`, `status`, `progress`, `change_set`, `validation`, `test_report`, `impact`, `risk`, `cross_review`, `llm`, `error`…) + `approvals`, `release` y `policy: {requiredRole, requiredRoleLabel, needsConfirmation, requireDistinctApprover, canApprove, currentVersion}`. Al terminar el pipeline, `kind` es `script` (el plan incluye `upsert_script`), `platform` (`change_set.requiresPlatformChange` sin operaciones; el texto está en `change_set.platformRequest`) o `config` |
| POST | `/requests/:id/refine` | builder | S | 10 | `{feedback (3–3000)}` → `{ok}`; vuelve a planificar |
| POST | `/requests/:id/approve` | admin (`owner` si riesgo alto) | S | | `{comment?, confirmation?}`; riesgo alto (todo script nuevo o modificado) exige `confirmation: "APLICAR"` → `{ok}`. `409` si las pruebas del sandbox fallaron |
| POST | `/requests/:id/reject` | admin | S | | `{comment?}` → `{ok}` |
| POST | `/requests/:id/cancel` | builder (autor o admin) | S/K | | → `{ok}` |
| POST | `/requests/:id/deploy` | admin (`owner` si riesgo alto) | S | | Publica → `{releaseId, version, tests, verification: {ok, checks: [{name, passed, message?}]}}`. `409` si el blueprint cambió desde que se probó (la petición pasa a `failed`) o si la aprobación tiene más de 7 días (vuelve a `ready_for_review`) |
| GET | `/releases` | viewer | S/K | | `{currentVersion, items: [{id, kind, status, from_version, to_version, title, summary, artifacts, tests, validation, verification, data_changes_count, created_at, rolled_back_at, request_id, approved_by_name, applied_by_name, rolled_back_by_name}]}` |
| POST | `/releases/:id/rollback` | admin (`owner` si el cambio era de riesgo alto) | S | | `{confirmation: "REVERTIR", reason?}` → `{version, revertedRecords, skippedRecords}` (solo la última versión) |
| GET | `/versions/:v` | viewer | S/K | | `{version, createdAt, blueprint}`, con solo los módulos que el rol puede leer (igual que `/api/blueprint`) |
| POST | `/versions/:v/restore` | owner | S | | `{confirmation: "RESTAURAR"}` → `{version}` (no toca datos; la configuración restaurada incluye los scripts de esa versión) |
| GET | `/backups` | owner | S/K | | `[{id, release_id, reason, size, created_at}]` |
| GET | `/backups/:id/download` | owner | S | | Descarga JSON de la copia |
| POST | `/security-review` | admin | S | 4 | → `{id}`; el resultado aparece en `GET /requests/:id` (`kind: security`, campo `impact`: `{score, summary, findings, model, aiError, ranAt}`) |
| POST | `/advice` | builder | S | 4 | → `{id}`; resultado en `impact`: `{summary, suggestions: [{title, description, impact, prompt}], model, ranAt}` |

Estados de una petición: `queued`, `planning`, `testing`, `needs_input`, `ready_for_review`, `approved`, `rejected`, `applied`, `failed`, `rolled_back`, `cancelled` (detalle en [AI_ENGINE.md](AI_ENGINE.md#3-flujo-de-trabajo-en-10-pasos)). Errores frecuentes: `409` si se aprueba algo que no está en revisión o con pruebas fallidas, si se publica sin aprobar, con una aprobación caducada o sobre una versión del blueprint distinta de la probada.

No existe ninguna ruta de código ni de repositorios: las antiguas `/api/evolve/code*` y `/api/evolve/requests/:id/code` se eliminaron y responden `404` (cubierto por `ai-features.test.ts`). Los scripts se gestionan como parte del change set (`upsert_script`, `remove_script`).

## 11. Comunicaciones (`/api/comms`)

| Método | Ruta | Rol | Auth | Lím./min | Descripción |
|---|---|---|---|---|---|
| GET | `/connectors` | viewer | S/K | | `{types: [{type, label, status: available\|planned, description, fields, plannedReason?, docsUrl}], connectors: [{id, type, name, status, config, lastError, lastEventAt, createdAt, webhookUrl?}]}`; `webhookUrl` solo para administradores |
| POST | `/connectors` | admin | S | 10 | `{type: whatsapp\|telegram, name, credentials}` → `{id, webhookUrl, verifyToken?}` |
| DELETE | `/connectors/:id` | admin | S/K | | → `{ok}` (en Telegram elimina el webhook del bot) |
| GET | `/inbox` | member | S/K | | Últimos 100 mensajes `[{id, channel, direction, from_address, body, record_id, created_at}]` |
| POST | `/messages/:id/link` | member | S/K | | `{recordId}` vincula un mensaje a un registro → `{ok}` |
| POST | `/send` | member | S/K | 30 | `{connectorId, recordId, text (1–4000)}` → `{id, externalId}` |

Credenciales: WhatsApp `{phoneNumberId, accessToken, appSecret}` (se verifican contra la Graph API; `verifyToken` se muestra una sola vez para configurarlo en Meta); Telegram `{botToken}` (se verifica con `getMe`, requiere `APP_URL` HTTPS y registra el webhook). En Telegram solo se puede responder a contactos que hayan escrito antes al bot; en WhatsApp se envía al campo `phone` del registro. Gmail, Outlook y Slack aparecen como `planned` y su alta devuelve `400`.

## 12. Webhooks entrantes (públicos)

| Método | Ruta | Lím./min | Verificación |
|---|---|---|---|
| POST | `/api/hooks/telegram/:token` | 240 | Cabecera `X-Telegram-Bot-Api-Secret-Token` (secreto registrado al crear el conector). Mensajes de texto → `{ok: true}` |
| GET | `/api/hooks/whatsapp/:token` | 240 | Suscripción de Meta: `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge` → devuelve el *challenge* en texto plano |
| POST | `/api/hooks/whatsapp/:token` | 240 | `X-Hub-Signature-256: sha256=<HMAC-SHA256(appSecret, cuerpo original)>`. Mensajes de texto → `{ok: true}` |

Token desconocido → `404`; firma inválida → `401`. Los mensajes se vinculan al contacto por teléfono (últimos 9 dígitos) o por usuario de Telegram, y se avisa a su responsable.

## 13. Rutas públicas

| Método | Ruta | Lím./min | Descripción |
|---|---|---|---|
| GET | `/api/public/forms/:slug/:form` | 60 | Definición de un formulario con `public: true`: `{organization, name, submitLabel, fields: [{key, label, type, required, options, helpText}]}` |
| POST | `/api/public/forms/:slug/:form` | 5 | `{values, website?}` (`website` es un *honeypot*: si viene relleno no se guarda nada) → `{ok, message}`. Errores de validación → `422`; un envío que solo duplica un valor único (p. ej. email existente) responde `ok` sin crear nada, para no revelar quién es ya cliente |
| POST | `/api/client-errors` | 10 | `{message, stack?, url?}` → `{ok}` (registro de errores del navegador) |

`slug` es el identificador público de la organización (`workspaces.slug`).

## 14. Plataforma (`/api/admin`)

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/overview` | PA | `{workspaces, users, jobs (7 días por estado), errors24h, llm24h (por proveedor), config: {env, role, appUrl, email, signupOpen, platformLlmKeys, database}}` (sin secretos) |
| GET | `/metrics` | PA | Métricas de la instancia: tiempo activo, peticiones por clase, latencias p50/p95/p99, memoria y rutas más usadas |
| GET | `/errors` | PA | Últimos 100 `error_events` |
| GET | `/jobs` | PA | Últimos 100 trabajos de la cola |

### 14.1 Motor de código fuente (`/api/platform`)

Cambios del código fuente de la instalación (afectan a todas las organizaciones). Todas las rutas exigen `PA` (una API key recibe `403`). Detalle del proceso en [CODE_ENGINE.md](CODE_ENGINE.md).

| Método | Ruta | Lím./min | Descripción |
|---|---|---|---|
| GET | `/platform/code/steps` | | Pasos del proceso `[{key, label}]` |
| GET | `/platform/code/settings` | | Estado de la configuración: si está lista y qué falta, pista del token (`••••abcd`), ids de proyecto, entorno y servicios (web, worker, CI) y versión en ejecución. Nunca devuelve el token |
| PUT | `/platform/code/settings` | 10 | `{token}`: token de **proyecto** de Railway. Se valida contra el proyecto y el entorno en los que corre la instalación y se guarda cifrado → estado |
| DELETE | `/platform/code/settings/token` | 10 | Borra el token |
| POST | `/platform/code/settings/check` | 6 | Pide al worker que vuelva a publicar su configuración de Railway |
| POST | `/platform/code/requests` | 6 | `{prompt}` → `{id}`. Usa la IA de la organización activa (hay que ser su administrador); `409` si esa organización permite menos de 300 peticiones de IA por hora, si falta configuración o si ya hay un cambio en curso |
| GET | `/platform/code/requests` | | `{items, running: {version}}`: historial de cambios y versión en ejecución |
| GET | `/platform/code/requests/:id` | | Detalle: archivos (antes y después), CI (intentos, errores, final del log), revisión, avisos, progreso, despliegue y `policy` |
| POST | `/platform/code/requests/:id/refine` | 10 | `{feedback}`: vuelve a desarrollar con indicaciones |
| POST | `/platform/code/requests/:id/approve` | 5 | `{confirmation: "DESPLEGAR", comment?}`: aprueba y despliega (worker primero, después web) |
| POST | `/platform/code/requests/:id/rollback` | 5 | `{confirmation: "REVERTIR"}`: revierte el último cambio desplegado o un despliegue detenido |
| POST | `/platform/code/requests/:id/cancel` | 20 | Cancela (y retira el CI en curso) |
| GET | `/platform/requests` | | Peticiones de EVOLVE que necesitan la plataforma (`kind: platform` o `requiresPlatformChange`) de todas las organizaciones (100 más recientes), con el cambio de código que se haya creado a partir de cada una |
| POST | `/platform/requests/:id/source-change` | 6 | `{note?}` → `{id}`: crea un cambio de código a partir de una de ellas (el texto de la organización viaja como dato, no como instrucción) |

## 15. Ejemplos con API key

```bash
export CORTEX_URL="https://<dominio-de-tu-instalación>"
export CORTEX_KEY="evk_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Listar contactos que contienen "globex" (20 por página)
curl -s "$CORTEX_URL/api/records/contacts?search=globex&pageSize=20" \
  -H "Authorization: Bearer $CORTEX_KEY"

# Oportunidades de más de 1.000 €, ordenadas por importe descendente
curl -s -G "$CORTEX_URL/api/records/deals" -H "Authorization: Bearer $CORTEX_KEY" \
  --data-urlencode 'filters=[{"field":"amount","operator":"gte","value":1000}]' \
  --data-urlencode 'sort=amount' --data-urlencode 'dir=desc'

# Crear una oportunidad (la etapa admite valor o etiqueta)
curl -s -X POST "$CORTEX_URL/api/records/deals" \
  -H "Authorization: Bearer $CORTEX_KEY" -H "Content-Type: application/json" \
  -d '{"values": {"title": "Renovación anual", "amount": 12000, "stage": "propuesta"}}'

# Adjuntar un PDF a un registro
curl -s -X POST "$CORTEX_URL/api/files" -H "Authorization: Bearer $CORTEX_KEY" \
  -H "Content-Type: application/octet-stream" -H "X-File-Name: contrato.pdf" \
  -H "X-Record-Id: <uuid-del-registro>" --data-binary @contrato.pdf
```

Respuesta típica de creación:

```json
{
  "record": { "id": "…", "module": "deals", "data": { "title": "Renovación anual", "amount": 12000, "stage": "propuesta", "probability": 10, "weighted_amount": 1200 }, "createdAt": "…", "updatedAt": "…", "lastActivityAt": "…", "createdBy": null, "updatedBy": null },
  "refs": { "records": {}, "users": {}, "files": {} }
}
```

## 16. Webhooks salientes (integraciones del blueprint)

Cuando una automatización ejecuta `send_webhook`, el worker envía `POST` (JSON) a la URL HTTPS de la integración:

```json
{ "event": "record_updated", "automation": "won_to_accounting", "module": "deals",
  "record": { "id": "…", "title": "Venta", "data": { "title": "Venta", "amount": 1000 } },
  "occurredAt": "2026-11-23T10:00:00.000Z" }
```

Cabeceras: `X-Cortex-Event`, `X-Cortex-Timestamp` (segundos Unix) y `X-Cortex-Signature: sha256=<hex>`, donde la firma es el HMAC-SHA256 en hexadecimal, con el secreto de la integración como clave, de `"<X-Cortex-Timestamp>.<cuerpo>"` (el cuerpo JSON exactamente como llega, sin volver a serializarlo). `record.data` se limita a `includeFields` si la integración lo define. Se reintenta hasta 5 veces con *backoff* exponencial ante respuestas no 2xx.

**Secreto de firma**: lo obtiene un administrador con `POST /api/workspace/integrations/:key/signing-secret` (sesión de usuario; cada consulta queda auditada como `integration.signing_secret_viewed`) o en **Ajustes › API keys › Webhooks salientes** («Mostrar secreto de firma»), donde también hay un ejemplo de verificación en Node.js. El secreto se usa tal cual se muestra (texto) como clave del HMAC:

```js
const crypto = require('node:crypto');
const ts = req.headers['x-cortex-timestamp'];
const expected = 'sha256=' + crypto.createHmac('sha256', SECRETO).update(ts + '.' + cuerpoSinModificar).digest('hex');
const valido = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-cortex-signature']))
  && Math.abs(Date.now() / 1000 - Number(ts)) < 300; // rechaza reenvíos antiguos
```

El secreto no se almacena: se deriva con `SecretBox.derive('webhook:<organización>:<clave de la integración>')` a partir de `APP_ENCRYPTION_KEY`. Por eso es estable entre versiones del blueprint y **no se puede rotar por integración** (solo cambia si la integración se crea con otra clave), y rotar `APP_ENCRYPTION_KEY` cambia los secretos de todas las integraciones.
