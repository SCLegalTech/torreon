# Torreón — imagen del servidor MCP + interfaz.
# El estado vive en un volumen: la realidad del jugador no puede perderse
# cuando la máquina se recicla.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @torreon/server --include-workspace-root

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist

# El servidor escucha en todas las interfaces solo dentro del contenedor;
# la protección real es TORREON_MCP_TOKEN.
ENV HOST=0.0.0.0
ENV PORT=8080
ENV TORREON_STATE_PATH=/data/torreon-state.json
EXPOSE 8080

CMD ["node", "apps/server/dist/index.js"]
