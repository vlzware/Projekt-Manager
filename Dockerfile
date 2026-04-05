# Stage 1: Build
FROM node:22.20.0-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production
FROM node:22.20.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy Vite frontend + esbuild server bundle
COPY --from=build /app/dist ./dist

# Copy migration SQL files (read at runtime by Drizzle migrator)
COPY --from=build /app/src/server/db/migrations ./dist/server/db/migrations

RUN addgroup -S app && adduser -S app -G app \
 && chown -R app:app /app

USER app

EXPOSE 3000

CMD ["node", "dist/server/start.js"]
