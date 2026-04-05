# Stage 1: Build
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Production
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy Vite frontend + esbuild server bundle
COPY --from=build /app/dist ./dist

# Copy migration SQL files (read at runtime by Drizzle migrator)
COPY --from=build /app/src/server/db/migrations ./dist/server/db/migrations

EXPOSE 3000

CMD ["node", "dist/server/start.js"]
