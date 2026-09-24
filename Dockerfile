# syntax=docker/dockerfile:1
# thoth: un contenedor, dos volúmenes, ninguna variable obligatoria.
#   /data/notes  carpeta de notas (fuente de verdad; puede estar en NFS)
#   /data/state  estado local: state.db, index.db, papelera, logs de colaboración
#                (disco local, nunca NFS: ver docs/infra.md)

FROM node:26-trixie-slim AS deps
# better-sqlite3 se compila al instalar: herramientas solo en esta etapa.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
# Solo dependencias de producción del servidor. Sin paso de compilación:
# Node ejecuta el TypeScript directamente.
RUN npm ci --omit=dev --workspace @thoth/server --include-workspace-root=false \
 && npm cache clean --force

FROM node:26-trixie-slim
ENV NODE_ENV=production \
    THOTH_NOTES_DIR=/data/notes \
    THOTH_STATE_DIR=/data/state \
    THOTH_HOST=0.0.0.0 \
    THOTH_PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/server/package.json packages/server/
COPY packages/server/src packages/server/src
COPY LICENSE ./
RUN mkdir -p /data/notes /data/state && chown -R node:node /data \
 && ln -s /app/packages/server/src/cli.ts /usr/local/bin/thoth
USER node
VOLUME ["/data/notes", "/data/state"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.THOTH_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["thoth", "serve"]
