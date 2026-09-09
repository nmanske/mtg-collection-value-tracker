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

# --------------------------------------------------------------- build ------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build must not pick up a developer's local database.
RUN rm -rf data .next
RUN npm run build

# -------------------------------------------------------------- runtime -----
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_PATH=/app/data/mtg.db

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# The standalone bundle carries its own minimal node_modules, traced from the
# actual imports; static assets and public files are not included in it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Migrations are read from disk at startup, so they must be in the image.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

# The database and the cached upstream downloads live here. Declared so a
# `docker run` without an explicit volume still persists them rather than
# losing the collection when the container is replaced.
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
VOLUME /app/data

USER nextjs
EXPOSE 3000

# No shell form: this way the server is PID 1 and receives SIGTERM directly,
# so `docker compose down` closes the database cleanly.
CMD ["node", "server.js"]
