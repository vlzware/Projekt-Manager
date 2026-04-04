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

# Copy Vite build output
COPY --from=build /app/dist ./dist

# Copy server source (executed via tsx at runtime)
COPY src/server ./src/server
COPY src/domain ./src/domain
COPY src/config ./src/config
COPY src/data ./src/data
COPY tsconfig.json ./

EXPOSE 3000

CMD ["node", "--import", "tsx", "src/server/start.ts"]
