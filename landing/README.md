# Web del proyecto

Página pública de Cortex CRM: https://cortex-crm-web-production.up.railway.app

Sitio estático (HTML, CSS y un JS mínimo, sin dependencias) servido por Caddy. No forma parte de la aplicación: el
`.dockerignore` de la raíz lo excluye de la imagen del CRM y se despliega como un servicio aparte.

- `index.html`: contenido, metadatos para buscadores y redes (Open Graph, JSON-LD de la aplicación y de las preguntas frecuentes).
- `styles.css`, `main.js`: diseño y comportamiento (menú móvil, apariciones al hacer scroll, ejemplos que rotan; respeta «reducir movimiento»).
- `assets/screens/`: capturas reales de la aplicación con una organización de demostración (datos ficticios).
- `Caddyfile`: compresión, caché, cabeceras de seguridad (CSP sin `unsafe-inline`), `404.html` y `/healthz`.

Desplegar (desde la raíz del repositorio; servicio `cortex-crm-web`, health check `/healthz`):

```bash
railway up landing --path-as-root --project <proyecto> --environment <entorno> --service cortex-crm-web --detach
```

Si cambia el dominio, actualiza `canonical`, `og:url`, `og:image`, el JSON-LD, `robots.txt` y `sitemap.xml`.
