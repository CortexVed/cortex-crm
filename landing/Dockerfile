# Web del proyecto Cortex CRM: sitio estático servido por Caddy en el puerto de Railway ($PORT, 8080 por defecto).
FROM caddy:2.11.9-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html 404.html robots.txt sitemap.xml styles.css main.js /srv/
COPY assets /srv/assets
EXPOSE 8080
