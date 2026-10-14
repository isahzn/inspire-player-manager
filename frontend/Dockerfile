# syntax=docker/dockerfile:1
#
# Inspire Academy frontend — the Next.js app, served by the same Caddy as the API.
#
# WHY IT RUNS HERE AND NOT ON VERCEL (a deviation from the runbook's §11 recommendation)
#
# The recommended shape was a static/SSR host for the app and this VPS for the API, which works
# because `app.<domain>` and `api.<domain>` share a registrable domain and the session cookie is
# `SameSite=Lax`. Serving both from one origin is strictly simpler: there is no cross-origin request,
# no CORS, and no cookie-domain reasoning left to get wrong. The VPS has the capacity (2 vCPU,
# 3.8 GiB, 55 GB free) and the provider already forwards the hostname to it, so this needs no
# third-party account and nothing is handed over to anyone.
#
# BUILD-TIME PUBLIC VARIABLES — the two below are the whole configuration, and both are inlined into
# the JavaScript bundle at build time rather than read at run time:
#
#   NEXT_PUBLIC_USE_MOCKS=false  ... the single most expensive mistake available here. Left `true`,
#                                    the app runs against its built-in MSW mocks: everything looks
#                                    right and nothing is real (runbook §11).
#   NEXT_PUBLIC_API_BASE_URL=/api/v1
#                                ... RELATIVE on purpose. Every API caller in this app is a client
#                                    component and nothing fetches during SSR, so a relative base
#                                    resolves against whatever origin the browser is on. That means
#                                    the TLS switch needs no rebuild, and the app does not depend on
#                                    the public name resolving from inside its own container.
#
#      The API's routes carry the `/api/v1` prefix (`src/api/client.ts` calls `/auth/me`,
#      `/players`, …), so the base has to include it — the runbook's env table says the same.

# ---------------------------------------------------------------------------
# 1. build — dependencies, then `next build`
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
# `npm ci` so the lockfile is authoritative. Dev dependencies stay: `next build` needs them
# (tailwind, typescript, the turbopack CSS loader) and this image also keeps them at run time.
RUN npm ci

# `.dockerignore` keeps the host's `node_modules` and `.next` out of this COPY — a Windows or macOS
# `node_modules` landing on top of the container's is the classic way this build breaks.
COPY . .

ARG NEXT_PUBLIC_USE_MOCKS=false
ARG NEXT_PUBLIC_API_BASE_URL=/api/v1
ENV NEXT_PUBLIC_USE_MOCKS=${NEXT_PUBLIC_USE_MOCKS} \
    NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ---------------------------------------------------------------------------
# 2. runtime — the built app, non-root
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3100 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# A fixed non-root identity, mirroring the backend image. The app writes nothing.
RUN groupadd --system --gid 1001 ia \
 && useradd --system --uid 1001 --gid ia --home-dir /app --shell /usr/sbin/nologin ia

# `node_modules` is carried over whole rather than pruned to production dependencies: `next start`
# loads `next.config.ts` in TypeScript form and the tailwind/turbopack toolchain is referenced from
# it, so a prune here would be a guess about what the runner needs. The cost is image size on a box
# with 55 GB free; the alternative is a build that works until the day it does not.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts

USER ia

EXPOSE 3100

# Liveness only, and deliberately shallow: it asks the server for the root document. `node -e`
# rather than curl because this slim image has neither curl nor wget and Node is already here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `exec` so `next start` is PID 1 and receives SIGTERM directly.
ENTRYPOINT ["sh", "-c", "exec node_modules/.bin/next start"]
