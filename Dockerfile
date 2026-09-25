# syntax=docker/dockerfile:1
# thoth: one container, two volumes, no required variables.
#   /data/notes  notes folder (source of truth; may be on NFS)
#   /data/state  local state: state.db, index.db, trash, collaboration logs and
#                the note history (history.git); local disk, never NFS: SQLite
#                locking over NFS is unreliable

FROM node:26-trixie-slim AS deps
# better-sqlite3 compiles on install: build tools only in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
# Server production dependencies only. No build step: Node runs the
# TypeScript directly.
RUN npm ci --omit=dev --workspace @thoth/server --include-workspace-root=false \
 && npm cache clean --force

FROM node:26-trixie-slim AS web
# The UI is built here; only the static files reach the final image.
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --workspace @thoth/web --include-workspace-root=false --ignore-scripts
COPY packages/core/src packages/core/src
COPY packages/web packages/web
RUN npm run build --workspace @thoth/web

FROM node:26-trixie-slim
# The note history keeps its versions with the system's git (D-016).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
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
COPY --from=web /app/packages/web/dist packages/web/dist
COPY LICENSE ./
RUN mkdir -p /data/notes /data/state && chown -R node:node /data \
 && ln -s /app/packages/server/src/cli.ts /usr/local/bin/thoth
USER node
VOLUME ["/data/notes", "/data/state"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.THOTH_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["thoth", "serve"]
