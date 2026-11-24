# Visión de producto — Cortex CRM

## 1. En una frase

**Cortex CRM es un CRM multi-organización que cada empresa adapta describiendo en lenguaje natural lo que necesita: su motor de IA, EVOLVE AI ENGINE, prepara el cambio (también la lógica a medida, como scripts propios de esa organización), lo prueba en un entorno aislado y lo deja listo para que una persona lo apruebe, con historial de versiones y vuelta atrás en un clic.**

## 2. Problema y propuesta de valor

| Problema habitual | Cómo lo resuelve Cortex CRM |
|---|---|
| Los CRM estándar no encajan con cada negocio y personalizarlos requiere consultoría o desarrollo | La propia organización pide los cambios («quiero gestionar contratos con avisos de vencimiento», «quiero una puntuación automática de cada oportunidad») y el sistema los construye sobre su configuración; si hace falta lógica a medida, escribe un script solo para esa organización |
| Cambiar la configuración en producción da miedo: se rompen informes, automatizaciones o datos | Cada cambio se prueba antes en un sandbox con pruebas automáticas, se clasifica por riesgo, requiere aprobación y se publica como una versión que se puede revertir |
| La IA «mágica» actúa sin control y no se sabe qué ha hecho | La IA nunca toca producción: propone, muestra el impacto (tablas, campos, permisos, salidas de datos) y espera a una persona; todo queda auditado |
| Depender de un único proveedor de IA (precio, disponibilidad, privacidad) | Gestor multi-proveedor: Claude, OpenAI, DeepSeek y OpenRouter (más Gemini, Mistral y Groq experimentales), modelo por tarea, alternativas automáticas, límites y coste visible |
| Integraciones que en la demo funcionan y en la realidad no | Solo se activan integraciones reales con credenciales reales; las que aún no existen se muestran como «Próximamente» con el motivo |

## 3. Para quién

| Perfil | Rol en la aplicación | Qué hace |
|---|---|---|
| Dirección / dueño del negocio | Propietario | Decide los cambios de riesgo alto (entre ellos, cualquier script), gestiona propietarios y administradores, restaura versiones y copias |
| Responsable de operaciones o del CRM | Administrador | Configura la organización, el equipo, los proveedores de IA, los canales y las API keys; aprueba y publica cambios de riesgo bajo/medio; revisa la auditoría |
| Usuario avanzado | Constructor | Pide evoluciones a la IA y las refina; pide propuestas de mejora |
| Comercial / equipo | Miembro | Trabaja contactos, empresas, oportunidades, tareas y actividades; notas, documentos y mensajes; usa el asistente |
| Consulta | Lector | Ve los datos, paneles e informes sin modificarlos |
| Operador de la plataforma | Administrador de plataforma | Supervisa la plataforma (organizaciones, errores, trabajos, métricas y configuración) |
| Integraciones externas | API key | Lee y escribe registros por API con un rol acotado |

## 4. Principios de producto

1. **La IA propone, las personas deciden.** Ningún cambio de estructura, código o datos se aplica sin una acción humana explícita.
2. **Todo es reversible.** Archivar en lugar de borrar, versiones inmutables, migraciones de datos con vuelta atrás, copias previas y rollback automático si la verificación falla.
3. **Nada simulado.** Las integraciones se activan con credenciales reales; lo que no está construido se dice.
4. **Sin dependencia de un proveedor de IA.** El mismo producto funciona con cualquiera de los proveedores soportados y cambia de uno a otro si falla.
5. **Aislamiento y privacidad por defecto.** Cada organización está aislada a nivel de base de datos; las claves se cifran y nunca vuelven al navegador; a la IA se le envía lo mínimo. Los cambios de una organización, scripts incluidos, solo la afectan a ella, se ejecutan dentro de la plataforma y nunca se publican en un repositorio.
6. **En español y para España por defecto.** Interfaz en español, zona horaria `Europe/Madrid`, moneda EUR y formato `es-ES` (configurables por organización).

## 5. Qué ofrece hoy

### 5.1 CRM base (lo que recibe cada organización nueva)

| Módulo | Contenido principal | Vistas |
|---|---|---|
| **Empresas** | Estado (prospecto, cliente, partner, ex cliente), importancia, sector, tamaño, web, email, teléfono, ciudad, país, facturación anual, responsable, etiquetas, descripción | Tabla · Kanban por estado |
| **Contactos** | Nombre, email (único), teléfono, cargo, empresa, etapa del ciclo de vida (lead → cliente), origen, responsable, etiquetas, usuario de Telegram, notas internas | Tabla · Kanban por etapa |
| **Oportunidades** | Etapa (nuevo, cualificado, propuesta, negociación, ganado, perdido), importe, probabilidad, **importe ponderado calculado**, cierre previsto, empresa, contacto, comercial, origen, próximo paso, motivo de pérdida | **Pipeline kanban** · Tabla · Calendario de cierres |
| **Tareas** | Estado, prioridad, vencimiento, **recordatorio**, asignada a, contacto, empresa, oportunidad | Pendientes · Tablero · **Calendario** · Todas |
| **Actividades** | Llamadas, reuniones, emails y visitas con fecha, resultado y relaciones | Tabla · Calendario |

Incluye tres automatizaciones (oportunidad ganada → probabilidad 100 %, perdida → 0 %, aviso al asignado cuando llega el recordatorio de una tarea), un panel principal y un formulario de captación web (desactivado para el público por defecto).

### 5.2 Trabajo diario

- **Listados** con búsqueda, filtros, orden y vistas guardadas; **kanban** con arrastrar y soltar (cambia la etapa); **calendario** mensual en el que se crea un registro pulsando un día.
- **Ficha de registro** con secciones configurables, edición, registros relacionados (con creación directa de uno relacionado), **línea de tiempo** (cambios, notas, mensajes y automatizaciones ejecutadas), **documentos** adjuntos y envío de mensajes por WhatsApp/Telegram.
- **IA en la ficha**: «Clasificar con IA» propone valores para los campos de selección (por ejemplo, importancia o etiquetas) a partir de los datos, los registros relacionados y las últimas notas, con su confianza y su motivo; no se guarda nada hasta que el usuario elige qué aplicar. Cada documento PDF o de texto se puede **analizar con IA**: resumen, puntos clave, fechas, importes, riesgos y tareas sugeridas, que se crean con un clic (vinculadas al registro si el módulo de tareas tiene una relación con su módulo) o se guardan como nota.
- **Búsqueda global** y **paleta de comandos** (`⌘/Ctrl+K`): registros, navegación, «Nuevo: …», «Preguntar a EVOLVE AI» y «Pedir este cambio al CRM».
- **Notificaciones** en la campana: avisos de automatizaciones, nuevas versiones y rollbacks (administradores) y mensajes entrantes (responsable del contacto).
- **Borrado seguro**: los registros borrados se pueden restaurar (administradores) y todo queda en el historial.

### 5.3 Automatizaciones

Reglas por organización con disparadores por **evento** (alta, edición, borrado, cambio de un campo a un valor) o **programados** (al llegar una fecha con antelación configurable, p. ej. 30 días antes de un vencimiento; tras N días sin actividad), condiciones y acciones (actualizar un campo, crear un registro relacionado, avisar a una persona/rol/todos, enviar un webhook firmado o ejecutar un script de la organización). Se crean pidiéndoselas a EVOLVE y se prueban con reloj simulado antes de publicarse. Cada ejecución queda en la línea de tiempo de la ficha, con su resultado. Para los webhooks, los administradores consultan en Ajustes › API keys el secreto con el que el sistema receptor verifica la firma (cada consulta queda en la auditoría).

### 5.4 Comunicaciones

| Canal | Estado |
|---|---|
| **WhatsApp Business** (Cloud API de Meta) | Implementado: los mensajes entrantes se asocian al contacto por teléfono y se responde desde su ficha (ventana de 24 h). Pendiente de probar con credenciales reales |
| **Telegram** (bot) | Implementado: vinculación por usuario de Telegram, respuesta desde la ficha. Pendiente de probar con credenciales reales |
| Gmail, Outlook / Microsoft 365, Slack | Arquitectura preparada; **no implementados** a propósito (requieren aplicaciones OAuth de plataforma). Se muestran como «Próximamente» con el motivo |

Bandeja de entrada de mensajes y vinculación manual de un mensaje a un registro.

### 5.5 Paneles e informes

- **Panel principal** con métricas, gráficos de barras, donut, evolución temporal y listas; los administradores lo personalizan (añadir/quitar widgets) y el cambio se publica como una versión más.
- **Informes**: Ventas (ganado en 12 meses, ticket medio, pipeline abierto y ponderado), Conversión (tasa de cierre y embudos), Actividad comercial, Rendimiento del equipo (por comercial) y Evolución de clientes. Si el CRM de una organización no tiene los campos necesarios, el informe indica qué falta.
- **Predicción con IA**: previsión de ingresos a 30 y 90 días, oportunidades en riesgo y recomendaciones, a partir de datos agregados sin datos personales.
- **Pregunta a tus datos** (en Informes): una pregunta en lenguaje natural («¿cuánto importe tenemos en oportunidades abiertas por etapa?») se convierte en una consulta segura —nunca en SQL libre— que respeta los permisos de quien pregunta y se muestra como métrica, gráfico o lista. Un administrador puede **añadirla al panel**, como un cambio más que se prueba, se aprueba y se publica como versión.

### 5.6 Personalización por organización

Cada organización tiene su propia configuración versionada (su «blueprint»): módulos, campos, vistas, permisos por módulo, automatizaciones, paneles, integraciones webhook, formularios y scripts. Se modifica de tres formas, todas con el mismo control (pruebas, riesgo, aprobación, versión):
1. **En lenguaje natural** con EVOLVE AI ENGINE.
2. **Con el editor de Personalización** (sin IA): crear módulos, editar su identidad y permisos, añadir/editar/archivar/restaurar campos y añadir opciones; para vistas nuevas remite a EVOLVE. La tarjeta **Scripts de la organización** muestra cada script (qué hace, qué automatizaciones lo usan y su código) y permite activarlo o desactivarlo, como un cambio más que aprueba un propietario.
3. **Personalizando el panel** directamente.

Los módulos nuevos aparecen en la navegación al publicarse, sin desplegar código.

### 5.7 EVOLVE AI ENGINE

El corazón del producto. El recorrido para el usuario:

1. **Pide** el cambio con sus palabras (o elige un ejemplo, o acepta una propuesta del asesor o de la auditoría de seguridad).
2. **Sigue el progreso** en directo: interpretar, analizar, planificar, desarrollar en aislamiento (incluido escribir el código de los scripts, si el cambio los necesita), probar (con auto-corrección), revisión cruzada con otro modelo, presentar.
3. **Revisa** el resultado: resumen, supuestos y preguntas de la IA, informe de pruebas por suites, impacto (tablas y columnas, migraciones de datos, permisos, salidas de datos, funcionalidades afectadas), el código de los scripts, riesgo y quién puede aprobar.
4. **Refina** con indicaciones si no es exactamente lo que quería.
5. **Aprueba y publica** (riesgo alto: solo propietarios escribiendo `APLICAR`; opción de exigir que apruebe una persona distinta a quien lo pidió). La aprobación vale 7 días y solo para la versión del CRM sobre la que se probó: si entretanto se publicó otro cambio, hay que volver a planificarlo.
6. **Verificación automática** tras publicar; si algo falla, vuelve sola a la versión anterior.
7. **Historial de versiones** con rollback (`REVERTIR`), restauración de cualquier versión (`RESTAURAR`) y copias descargables.

**Scripts por organización.** Cuando lo pedido no cabe en la configuración (una puntuación, un reparto, una regla con muchas condiciones), EVOLVE especifica un script, un paso «desarrollador» escribe su código y el sandbox lo ejecuta de verdad en las pruebas. El script se ejecuta dentro de Cortex CRM en un entorno aislado (sin red ni archivos, con límite de tiempo y memoria), solo ve y modifica datos de su organización y se versiona con su configuración: se puede desactivar, revertir o restaurar. Si falla en producción, la ficha se guarda igualmente y el fallo queda registrado. Siempre lo aprueba un propietario.

**Lo que necesita la plataforma.** Las peticiones que requieren una funcionalidad nueva de la plataforma (integraciones con OAuth, pantallas nuevas…) no se simulan: la petición lo indica («queda registrada para el equipo de Cortex CRM») y el resto del cambio, si lo hay, sigue el proceso normal.

Además: **asesor de mejoras** (propone mejoras del CRM a partir del uso real) y **auditoría de seguridad** (hallazgos automáticos + IA con correcciones listas para EVOLVE o, si afectan a la plataforma, descritas para el equipo de Cortex CRM).

### 5.8 Asistente EVOLVE AI

Panel lateral disponible en toda la aplicación (`⌘/Ctrl+J`), abierto por defecto en pantallas anchas (1280 px o más; en pantallas más estrechas nunca se abre solo), que **entiende lo que el usuario está viendo** («¿qué oportunidades tenemos con este cliente?» en la ficha de una empresa). Consulta datos reales con sus permisos, calcula métricas, **prepara** registros, peticiones de evolución o notas de memoria (preferencias y decisiones) que el usuario confirma con un clic; la memoria es visible y editable. Conserva el historial de conversaciones.

### 5.9 Gestión de la IA

Ajustes › Proveedores de IA: claves cifradas y enmascaradas (revocables), catálogo de modelos obtenido de cada proveedor (OpenRouter con precios en vivo), modelo por tarea para 10 tipos de tarea (cada función usa el suyo: por ejemplo, las preguntas a los datos, la clasificación, el análisis de documentos, las peticiones de automatizaciones o la escritura del código de los scripts pueden ir a modelos distintos), alternativas automáticas si un proveedor falla, límites (peticiones por hora, presupuesto mensual, tokens, tareas desactivadas), comparación de modelos lado a lado y panel de uso con coste, latencia y errores.

### 5.10 Equipo, seguridad y cumplimiento

Registro, inicio y cierre de sesión, recuperación de contraseña, verificación de email, gestión de sesiones activas, invitaciones con rol, cinco roles, API keys por organización (sin acceso a los datos personales de quien las creó), auditoría consultable, exportación de los datos de la organización, aislamiento estricto entre organizaciones (también en la base de datos) y cifrado de secretos. Detalle en [SECURITY.md](SECURITY.md).

### 5.11 Experiencia de uso

Interfaz cuidada con tipografía Inter, **modo claro/oscuro/sistema**, diseño adaptable a móvil, **paleta de comandos**, **atajos de teclado** (`⌘K`, `⌘J`, `G D` panel, `G E` EVOLVE, `G R` informes, `G S` ajustes, `C` crear, `?` ayuda), notificaciones, avisos contextuales y el **panel de IA** a mano en todas las pantallas (abierto por defecto en pantallas de 1280 px o más, donde recuerda la elección explícita de cada persona; en pantallas estrechas es una capa que solo se abre a petición y se cierra al navegar).

## 6. Un ejemplo de punta a punta

> «Quiero un módulo para gestionar contratos con fechas de vencimiento, documentos adjuntos y avisos automáticos.»

1. EVOLVE planifica un módulo **Contratos** (nombre, empresa, vencimiento, importe, responsable, documentos), una vista de tabla y un **calendario de vencimientos**, y una automatización que avisa al responsable 30 días antes.
2. Genera una prueba: crea un contrato que vence en 40 días, **avanza el reloj 10 días**, ejecuta el planificador y espera un aviso.
3. El sandbox ejecuta las suites de validación, compatibilidad, integración, aceptación y seguridad; riesgo **bajo**.
4. Un administrador lo aprueba y lo publica: versión 2, verificada. El módulo aparece en el menú y ya se pueden crear contratos.
5. Si se arrepiente, un rollback vuelve a la versión 3 = definición de la 1, **sin perder los contratos**; restaurar la versión 2 los recupera.

Este recorrido es exactamente el que comprueban los tests automáticos de `server/test/evolve.test.ts`.

**Con lógica a medida:**

> «Quiero una puntuación automática de cada oportunidad según su importe y su etapa.»

1. EVOLVE planifica un campo **Puntuación**, un script `deal_score` con su especificación (importe/1.000 redondeado, +30 si la etapa es negociación, máximo 100) y una automatización que lo ejecuta al crear cada oportunidad.
2. El desarrollador escribe el código del script y el sandbox lo prueba: una oportunidad de 50.000 € en negociación debe puntuar 80, y el script se ejecuta aislado con datos mínimos.
3. Como incluye código a medida, el riesgo es **alto**: lo aprueba un propietario escribiendo `APLICAR`, y se publica como una versión nueva.
4. Desde ese momento, cada oportunidad nueva recibe su puntuación y la ejecución queda en su línea de tiempo. Otra organización no tiene ni el script ni sus efectos, y un rollback o la restauración de una versión anterior lo retiran.

Este segundo recorrido lo comprueba `server/test/scripts.test.ts`.

## 7. Cobertura de los requisitos (MASTER PROMPT)

| Requisito | Estado |
|---|---|
| Despliegue en Railway | Hecho: servicios `cortex-crm` (web) y `cortex-worker` con la misma imagen, Postgres reutilizado, health checks y migraciones automáticas; despliegue con `railway up` |
| EVOLVE AI ENGINE con flujo de 10 pasos | Hecho, también para la lógica a medida: scripts por organización escritos por la IA, probados en un sandbox y versionados con la configuración, sin publicar nada en repositorios. Lo que necesita una funcionalidad nueva de la plataforma se registra en la petición |
| AI PROVIDER MANAGER: Claude, OpenAI, DeepSeek, OpenRouter; extensible a Gemini/Mistral/Groq | Hecho (Gemini, Mistral y Groq como experimentales). Adaptadores probados con HTTP simulado, **no contra las APIs reales** |
| Modelo por tarea (10 tipos), claves cifradas/enmascaradas/revocables, coste/latencia/errores, límites, alternativas, comparación, catálogo OpenRouter por API | Hecho: los 10 tipos tienen uso (preguntas a los datos, clasificación, análisis de documentos, planificación de automatizaciones y escritura del código de los scripts incluidos) |
| Contactos, empresas, oportunidades en kanban, tareas con calendario y recordatorios | Hecho |
| Comunicaciones (Gmail, Outlook, WhatsApp, Telegram, Slack) sin simular | WhatsApp y Telegram implementados (sin probar en real); Gmail, Outlook y Slack preparados y marcados como no disponibles |
| Informes, incluidas predicciones con IA | Hecho, además de preguntas en lenguaje natural sobre los datos |
| Personalización por organización | Hecho |
| Interfaz premium: modo oscuro, paleta de comandos, atajos, notificaciones, panel de IA contextual permanente | Hecho; el panel de IA está disponible en todas las pantallas, abierto por defecto en pantallas de 1280 px o más, y se abre/cierra a voluntad |
| Multi-organización con aislamiento estricto (RLS) y tests entre organizaciones | Hecho |
| Autenticación completa y seguridad (CSRF, XSS, rate limiting, validación, auditoría, cifrado) | Hecho; la verificación de email no bloquea el acceso; sin 2FA/SSO |
| Memoria y contexto de IA por organización | Hecho |
| Versionado con rollback | Hecho |
| 8 fases de desarrollo | Fases 1–7 completadas; fase 8 parcial (ver [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md)) |

## 8. Lo que todavía no hace

Facturación y planes, 2FA/SSO, *streaming* de respuestas del asistente, Gmail/Outlook/Slack, almacenamiento de archivos en un servicio de objetos, pruebas E2E, escalado horizontal con *rate limiting* compartido y una vista de plataforma para las peticiones que necesitan funcionalidades nuevas, entre otros. Los scripts no pueden conectarse a servicios externos. La lista completa y el plan propuesto están en [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md).

## 9. Glosario

| Término | Significado |
|---|---|
| **Organización** (workspace) | Cliente de la plataforma; sus datos, usuarios y configuración están aislados |
| **Blueprint** | Configuración versionada del CRM de una organización (módulos, campos, vistas, permisos, automatizaciones, paneles, integraciones, formularios y scripts) |
| **Change set** | Plan de cambios declarativo (operaciones + pruebas) que produce la IA o el editor |
| **Script** | Lógica a medida (JavaScript) de una organización, que forma parte de su blueprint y se ejecuta en un entorno aislado dentro de la plataforma cuando una automatización lo indica |
| **Sandbox** | Entorno aislado en memoria donde se prueba un change set con la misma lógica que producción y un reloj simulado |
| **Release / versión** | Publicación de un change set como nueva versión del blueprint, con verificación y posibilidad de rollback |
| **Riesgo** | Clasificación automática (bajo, medio, alto) que decide quién puede aprobar |
| **Rollback / restaurar** | Volver a la versión anterior / publicar de nuevo cualquier versión pasada |
| **Proveedor de IA** | Servicio de modelos (Anthropic, OpenAI, DeepSeek, OpenRouter…) configurado con la clave de la organización |
| **Tarea de IA** | Tipo de uso (chat, análisis de CRM, creación de funcionalidades, revisión de código…) con su propia ruta de modelos |
| **Worker** | Proceso que ejecuta en segundo plano el pipeline de EVOLVE, webhooks y automatizaciones programadas |
| **EVOLVE AI ENGINE / EVOLVE AI** | El motor de IA que hace evolucionar el CRM de cada organización y el asistente contextual, ambos parte de Cortex CRM |
