# syntax=docker/dockerfile:1

# ── Étape build ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── Étape runtime ───────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SOLBOT3_HOME=/app

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY config ./config
COPY scripts ./scripts

# La base SQLite et les backups vivent dans un volume persistant.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node

# Le dashboard et le serveur de supervision écoutent en local par défaut ;
# le healthcheck s'appuie sur /healthz.
EXPOSE 4200 9464

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9464/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
