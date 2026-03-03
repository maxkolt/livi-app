FROM node:20-alpine

WORKDIR /app

# Системные зависимости (curl для healthcheck)
RUN apk add --no-cache bash curl

# Зависимости
COPY package*.json ./
RUN npm ci --include=dev

# Исходники
COPY . .

# Сборка TypeScript
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]

