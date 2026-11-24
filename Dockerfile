# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Versión desplegada (para verificar despliegues del motor de código):
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
USER node
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
# PROCESS_ROLE=web (API + interfaz) | worker (cola de trabajos y automatizaciones programadas)
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
