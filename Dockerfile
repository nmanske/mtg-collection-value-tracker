# Debian rather than Alpine on purpose: better-sqlite3 is a native module, and
# its prebuilt binaries target glibc. On musl it has to be compiled from source
# on every build, for no benefit here.
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------- deps ------
FROM base AS deps
# Build tools in case better-sqlite3 has no prebuild for this platform. They
# stay in this stage and never reach the final image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------- prod-deps ------
# The daily price ingest runs as a child process from the source, not from the
# standalone bundle, so it needs the real dependency tree: `stream-json` and
# `stream-chain` are never imported by the web app and so are never traced into
# the bundle. Pruned to production, which now includes `tsx` — it is the
# runtime for the ingest CLI in the container, not just a dev convenience.
FROM deps AS prod-deps
RUN npm prune --omit=dev

# --------------------------------------------------------------- build ------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build must not pick up a developer's local database.
RUN rm -rf data .next
# `npm run build` passes --webpack deliberately. The Turbopack build grows to a
# 42 GB working set and dies; webpack builds the same source in 30s under 0.5 GB.
# See TODO.md. Without this the image cannot be built at all.
RUN npm run build

# -------------------------------------------------------------- runtime -----
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_PATH=/app/data/mtg.db
# How the scheduler invokes the daily price ingest. Called directly rather than
# through `npm run`, which would add a shell and a package manager to the
# process tree for nothing. Set it empty to disable prices entirely and drive
# the ingest from outside the container instead.
ENV INGEST_COMMAND="node_modules/.bin/tsx scripts/ingest-today.mts --rebuild-cache"

# Both upstreams are HTTPS, so a missing trust store means every ingest fails —
# daily, and visibly only because the dashboard now reports a failed run. The
# base image is believed to carry these already; a few hundred KB is a cheap
# price for removing the doubt.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# Order matters. The pruned tree goes down first and the standalone bundle
# overlays it, so Next's traced modules — which it arranges deliberately — win
# any collision, and the extras the ingest needs survive alongside them.
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules

# The standalone bundle carries its own minimal node_modules, traced from the
# actual imports; static assets and public files are not included in it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Migrations are read from disk at startup, so they must be in the image.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

# The ingest CLI is run from source by `tsx`, which needs the path aliases in
# tsconfig.json to resolve `@/...`.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json

# The database and the cached upstream downloads live here. Declared so a
# `docker run` without an explicit volume still persists them rather than
# losing the collection when the container is replaced.
#
# On a Linux host a bind-mounted directory keeps its own ownership, which the
# `nextjs` user must be able to write: `chown -R 1001:1001 ./data` on the host,
# or the migration at startup fails with SQLITE_CANTOPEN.
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
VOLUME /app/data

USER nextjs
EXPOSE 3000

# No shell form: this way the server is PID 1 and receives SIGTERM directly,
# so `docker compose down` closes the database cleanly.
CMD ["node", "server.js"]
