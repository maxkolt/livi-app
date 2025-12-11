#!/bin/bash

# Скрипт для развертывания backend на сервере
# Запустите на сервере: bash deploy-server.sh

set -e

echo "🚀 Начинаем развертывание backend..."

# 1. Проверка и установка Node.js
echo "📦 Проверяем Node.js..."
if ! command -v node &> /dev/null; then
    echo "Устанавливаем Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
else
    echo "✅ Node.js уже установлен: $(node --version)"
fi

# 2. Проверка и установка MongoDB
echo "📦 Проверяем MongoDB..."
if ! command -v mongod &> /dev/null; then
    echo "Устанавливаем MongoDB..."
    curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
    apt update
    apt install -y mongodb-org
    systemctl enable mongod
    systemctl start mongod
else
    echo "✅ MongoDB уже установлен"
    systemctl start mongod || true
fi

# 3. Установка PM2
echo "📦 Устанавливаем PM2..."
npm install -g pm2 || echo "PM2 уже установлен"

# 4. Создание директории проекта
echo "📁 Создаем директорию проекта..."
mkdir -p /opt/livi-app/backend
cd /opt/livi-app

# 5. Информация о следующем шаге
echo ""
echo "✅ Базовая настройка завершена!"
echo ""
echo "📋 Следующие шаги:"
echo "1. Загрузите файлы backend на сервер:"
echo "   scp -r backend/* root@89.111.152.241:/opt/livi-app/backend/"
echo ""
echo "2. На сервере выполните:"
echo "   cd /opt/livi-app/backend"
echo "   npm install"
echo "   nano .env  # Создайте .env файл с настройками"
echo "   pm2 start npm --name 'livi-backend' -- run start"
echo "   pm2 save"
echo ""
echo "3. Откройте порт 3000:"
echo "   ufw allow 3000/tcp"
echo ""
