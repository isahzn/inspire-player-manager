# syntax=docker/dockerfile:1
#
# Inspire Academy backend — one immutable image, two processes (DEPLOYMENT_AND_OPERATIONS §2/§5).
#
# The API and the worker are the same build; only the entrypoint differs, which is what makes
# "deploy the same image twice" true rather than aspirational:
#
#   API     (default)   docker run --env-file /run/secrets/ia.env <image>
#   worker              docker run --env-file /run/secrets/ia.env \
#                         -e APP_ENTRY=dist/src/worker/index.js <image>
#
# Nothing is baked in: no `.env`, no secret, no database URL. Everything arrives as environment
# variables at run time (§4), and the process refuses to start on a weak or missing secret.
#
# ---------------------------------------------------------------------------
# 1. deps — every dependency, including dev, so the build can run tsc
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` (not `install`) so the lockfile is authoritative and the build is reproducible.
RUN npm ci

# ---------------------------------------------------------------------------
# 2. build — compiled JavaScript only; the image ships no TypeScript toolchain
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY spec ./spec
COPY scripts ./scripts
# `tsc -p tsconfig.build.json`. Its `rootDir` is `.` and it includes src/, spec/ and scripts/,
# so the emitted paths are dist/src/… and dist/spec/… — spec/ is required at run time because
# the route registry is the source of truth for the served surface, not a build-time artefact.
RUN npm run build

# ---------------------------------------------------------------------------
# 3. runtime — production dependencies, non-root, no build inputs
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
# SYS-03 reports this. CI sets it from the git SHA; the image build can override it.
ARG APP_VERSION=0.1.0
ENV APP_VERSION=${APP_VERSION}

WORKDIR /app

# A fixed non-root identity. The process never needs to write anywhere except the storage root
# and the backup directory, and both are created here so a `local`-driver deployment works from
# the first request.
RUN groupadd --system --gid 1001 ia \
 && useradd --system --uid 1001 --gid ia --home-dir /app --shell /usr/sbin/nologin ia

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The SQL is looked up at run time, not compiled in, and both paths are relative to the working
# directory (`scripts/migrate.ts`: MIGRATIONS_DIR = cwd/migrations; `scripts/bootstrap-roles.ts`:
# cwd/db/bootstrap.sql). Without these two lines the image starts but cannot be migrated or
# bootstrapped — the failure only appears on the VPS, as an ENOENT from an operator CLI, which is
# exactly the kind of gap that gets discovered at the worst moment.
COPY migrations ./migrations
COPY db ./db

# `STORAGE_DRIVER=local` writes here (FILES_AND_PDF §5); a production deployment sets
# `STORAGE_DRIVER=s3` and this directory stays empty. `BACKUP_DIR` defaults to var/backups.
RUN mkdir -p /app/var/files /app/var/backups \
 && chown -R ia:ia /app/var

USER ia

# The API's port (config.ts: PORT, default 3200). The worker opens no socket — it only needs
# an outbound path to PostgreSQL and the bucket.
EXPOSE 3200

# Which entrypoint this process runs. Overriding it is the *only* difference between the API
# container and the worker container.
ENV APP_ENTRY=dist/src/server.js

# Liveness, per DEPLOYMENT §6: unauthenticated and deliberately shallow (SYS-01). `node -e`
# rather than curl/wget because the slim image has neither and we already require Node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `exec` so the Node process is PID 1 and receives SIGTERM directly — the worker's graceful
# shutdown (finish the current job, release `sending` rows) depends on that signal arriving.
ENTRYPOINT ["sh", "-c", "exec node \"$APP_ENTRY\""]
