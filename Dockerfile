# syntax=docker/dockerfile:1
# vihko: one container, two volumes, no required variables.
#   /data/notes  notes folder (source of truth; may be on NFS)
#   /data/state  local state: state.db, index.db, trash, collaboration logs and
#                the note history (history.git); local disk, never NFS: SQLite
#                locking over NFS is unreliable
#
# Built for linux/amd64 and linux/arm64 (.github/workflows/release.yml, which
# also sets the OCI labels and annotations: version, revision, source,
# licence).

FROM node:26-trixie-slim AS deps
# better-sqlite3 compiles on install when it finds no prebuilt binary, for the
# image's own architecture (emulated for arm64 on an amd64 machine): build
# tools only in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# .npmrc: only the install scripts package.json's allowScripts approves run.
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
# Server production dependencies only. No build step: Node runs the
# TypeScript directly.
RUN npm ci --omit=dev --workspace @vihko/server --include-workspace-root=false \
 && npm cache clean --force

FROM --platform=$BUILDPLATFORM node:26-trixie-slim AS web
# The UI is built here; only the static files reach the final image. They are
# the same for every architecture, so this stage runs natively on the build
# machine, not emulated.
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --workspace @vihko/web --include-workspace-root=false --ignore-scripts
COPY packages/core/src packages/core/src
COPY packages/web packages/web
RUN npm run build --workspace @vihko/web

FROM node:26-trixie-slim
# The note history keeps its versions with the system's git (D-016).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    VIHKO_NOTES_DIR=/data/notes \
    VIHKO_STATE_DIR=/data/state \
    VIHKO_HOST=0.0.0.0 \
    VIHKO_PORT=8080
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
 && ln -s /app/packages/server/src/cli.ts /usr/local/bin/vihko
USER node
VOLUME ["/data/notes", "/data/state"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIHKO_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["vihko", "serve"]
