# Stage 1: Build
FROM node:22.20.0-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Production
FROM node:22.20.0-alpine

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Copy migration SQL files (read at runtime by Drizzle migrator)
COPY --from=build /app/src/server/db/migrations ./dist/server/db/migrations

# `age` binary — required by KeyEnvelopeService at every download-url /
# bulk-fetch unwrap (ADR-0024). The boot probe reads age-keygen at
# startup; both must be on PATH before the process forks them.
# `findmnt` is used by load-binary-key.sh's tmpfs-invariant check;
# without it the script falls back to /proc/mounts parsing.
RUN apk add --no-cache age findmnt

# Operator helper: load the binary `age` private identity into tmpfs
# (ADR-0024 §Operator workflow). Mirrors how Dockerfile.backup installs
# load-drill-key — script lives in repo as *.sh, container path drops
# the suffix so the runbook command stays short.
COPY scripts/binary-key/load-binary-key.sh /usr/local/bin/load-binary-key
RUN chmod +x /usr/local/bin/load-binary-key

RUN addgroup -S app && adduser -S app -G app \
 && chown -R app:app /app

USER app

EXPOSE 3000

CMD ["node", "dist/server/start.js"]
