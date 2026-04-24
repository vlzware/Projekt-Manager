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

RUN addgroup -S app && adduser -S app -G app \
 && chown -R app:app /app

USER app

EXPOSE 3000

CMD ["node", "dist/server/start.js"]
