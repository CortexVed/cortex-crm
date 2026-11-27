# Cambios

Las instalaciones desplegadas desde la [plantilla de Railway](https://railway.com/deploy/cortex-crm) reciben un aviso de actualización cada vez que se publica una versión en la rama `main`, y se aplica cuando quien la desplegó lo decide. Antes de actualizar, revisa aquí qué cambia. Las migraciones de base de datos se aplican solas al arrancar y son aditivas: ninguna borra datos.

## 2026-11-27

- **Archivos en el Bucket de la plantilla.** Con las variables `S3_*` (la plantilla incluye un Bucket de Railway y las rellena sola), los archivos adjuntos nuevos se guardan en un bucket privado compatible con S3. Sin bucket se siguen guardando en PostgreSQL, y los archivos anteriores se siguen descargando igual. Migración `006_file_object_storage` (añade dos columnas a `files`). Las instalaciones anteriores a la plantilla con Bucket pueden añadir uno y las cinco variables `S3_*` cuando quieran.
- **Licencia GNU AGPL v3** (`AGPL-3.0-only`).
- **Web del proyecto** en `landing/` (no forma parte de la aplicación).

## 2026-11-25

- **Interfaz:** 41 correcciones de la auditoría. Panel de EVOLVE AI como capa en pantallas medianas, con la conversación conservada, botón «Detener» y tiempo máximo; las propuestas del asistente recuerdan si ya se aplicaron; fichas y módulos sin estado arrastrado al navegar; teclado en tablas y kanban; calendario por semanas visibles; tema sin destello; capas con Escape y foco correctos.
- **Motor de código fuente:** comprobación de tipos antes del CI, mapa del código y herramientas nuevas para el agente.
- **Sin límites para construir:** dependencias npm con lockfile verificado, más tipos de archivo y capacidades nuevas tratadas con la máxima precaución.
- **Plantilla:** servicio CI sin variables, health check `/api/health` en Cortex y Worker, ningún valor manual al desplegar.

Las versiones anteriores están en el historial del repositorio.
