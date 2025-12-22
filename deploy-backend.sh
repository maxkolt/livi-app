#!/bin/bash

# Скрипт для деплоя измененных файлов бэкенда
# Использование: ./deploy-backend.sh USER@HOST /path/to/backend

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Использование: $0 USER@HOST /path/to/backend"
  echo "Пример: $0 root@192.168.1.100 /var/www/livi-app/backend"
  exit 1
fi

SSH_HOST="$1"
BACKEND_PATH="$2"

echo "📦 Копирование файлов бэкенда..."
scp backend/routes/livekit.ts "$SSH_HOST:$BACKEND_PATH/routes/livekit.ts"
scp backend/index.ts "$SSH_HOST:$BACKEND_PATH/index.ts"

echo "✅ Файлы скопированы"
echo "🚀 Запуск бэкенда..."

# Выберите один из вариантов запуска:

# Вариант 1: Простой запуск
ssh "$SSH_HOST" "cd $BACKEND_PATH && npm run start"

# Вариант 2: PM2 (раскомментируйте если используете)
# ssh "$SSH_HOST" "cd $BACKEND_PATH && pm2 restart backend"

# Вариант 3: С компиляцией TypeScript (раскомментируйте если нужно)
# ssh "$SSH_HOST" "cd $BACKEND_PATH && npm run build && npm run start"

echo "✅ Готово!"
