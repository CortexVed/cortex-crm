# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Paquete de código fuente EXACTO de esta imagen (lo edita el motor de código de la instalación, ver
# docs/CODE_ENGINE.md). Se copia antes de compilar: dist/, node_modules y .build-sha no forman parte de él.
# source-version.json identifica la versión que desplegó el motor ({} en una imagen construida desde el repo).
RUN test -f source-version.json || echo '{}' > source-version.json \
 && mkdir -p /source \
 && cp -R server web shared docs /source/ \
 && cp package.json package-lock.json tsconfig.json vitest.config.ts railway.json Dockerfile Dockerfile.ci .dockerignore source-version.json /source/ \
 && for f in README.md .env.example; do if [ -f "$f" ]; then cp "$f" /source/; fi; done
# Versión desplegada (para verificar despliegues):
# Con `railway up` se usa la variable BUILD_SHA (commit desplegado); RAILWAY_GIT_COMMIT_SHA solo existe si Railway despliega desde un repositorio.
ARG RAILWAY_GIT_COMMIT_SHA
ARG BUILD_SHA
RUN echo "${RAILWAY_GIT_COMMIT_SHA:-${BUILD_SHA:-unknown}}" > .build-sha \
 && npm run build \
 && npm prune --omit=dev

# ---------- runtime ----------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/.build-sha ./.build-sha
# Versión del código fuente (la publica /api/health como sourceVersion) y el propio código, que pertenece a
# root: el usuario node puede leerlo pero no modificarlo.
COPY --from=build /app/source-version.json ./source-version.json
COPY --from=build /source ./source
USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
# PROCESS_ROLE=web (API + interfaz) | worker (cola de trabajos y automatizaciones programadas) | ci (servicio de CI del motor de código)
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
