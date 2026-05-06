# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Без apk: node:20-alpine уже содержит wget (busybox) — healthcheck в docker-compose.yml.

# Зависимости (долго только при первом скачивании; кэш npm ускоряет повторные билды)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --no-audit --fund=false

# Исходники
COPY . .

# Сборка TypeScript
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]

