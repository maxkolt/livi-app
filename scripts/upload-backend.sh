#!/bin/bash

# Скрипт для загрузки backend на сервер
# Использование: ./upload-backend.sh

SERVER_IP="89.111.152.241"
SERVER_USER="root"
BACKEND_PATH="/opt/livi-app/backend"

echo "📤 Загружаем backend на сервер $SERVER_IP..."

# Создаем директорию на сервере
ssh $SERVER_USER@$SERVER_IP "mkdir -p $BACKEND_PATH"

# Загружаем файлы
scp -r backend/* $SERVER_USER@$SERVER_IP:$BACKEND_PATH/

echo "✅ Файлы загружены!"
