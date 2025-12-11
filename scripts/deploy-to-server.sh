#!/bin/bash

# Автоматическое развертывание backend на сервер
# Использование: ./deploy-to-server.sh

set -e

SERVER_IP="89.111.152.241"
SERVER_USER="root"
BACKEND_PATH="/opt/livi-app/backend"
LOCAL_BACKEND_PATH="./backend"

echo "🚀 Начинаем развертывание backend на сервер $SERVER_IP..."

# 1. Загрузка файлов на сервер
echo "📤 Загружаем файлы backend на сервер..."
scp -r $LOCAL_BACKEND_PATH/* $SERVER_USER@$SERVER_IP:$BACKEND_PATH/

# 2. Выполнение команд на сервере
echo "⚙️  Настраиваем сервер..."
ssh $SERVER_USER@$SERVER_IP << 'ENDSSH'
set -e

echo "📦 Проверяем и устанавливаем зависимости..."

# Проверка Node.js
if ! command -v node &> /dev/null; then
    echo "Устанавливаем Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
else
    echo "✅ Node.js уже установлен: $(node --version)"
fi

# Проверка MongoDB
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

# Установка PM2
echo "📦 Устанавливаем PM2..."
npm install -g pm2 || echo "PM2 уже установлен"

# Создание директории
echo "📁 Создаем директорию проекта..."
mkdir -p /opt/livi-app/backend
cd /opt/livi-app/backend

# Установка зависимостей
echo "📦 Устанавливаем зависимости проекта..."
npm install

# Создание .env файла (если не существует)
if [ ! -f .env ]; then
    echo "📝 Создаем .env файл..."
    cat > .env << 'EOF'
PORT=3000
HOST=0.0.0.0
MONGO_URI=mongodb://localhost:27017/livi-app
EOF
    echo "✅ .env файл создан"
else
    echo "✅ .env файл уже существует"
fi

# Открытие порта 3000
echo "🔓 Открываем порт 3000..."
ufw allow 3000/tcp 2>/dev/null || iptables -A INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || echo "⚠️  Не удалось открыть порт автоматически, сделайте это вручную"

# Остановка старого процесса (если есть)
echo "🛑 Останавливаем старый процесс (если есть)..."
pm2 delete livi-backend 2>/dev/null || true

# Запуск backend
echo "🚀 Запускаем backend..."
cd /opt/livi-app/backend
pm2 start npm --name "livi-backend" -- run start
pm2 save

# Настройка автозапуска
pm2 startup | grep -v "PM2" | bash || true

echo ""
echo "✅ Развертывание завершено!"
echo ""
echo "📊 Статус:"
pm2 status
echo ""
echo "📋 Логи:"
pm2 logs livi-backend --lines 10 --nostream
echo ""
echo "🔍 Проверка доступности:"
sleep 2
curl -s http://localhost:3000 | head -20 || echo "⚠️  Сервер еще не отвечает, проверьте логи: pm2 logs livi-backend"

ENDSSH

echo ""
echo "✅ Развертывание завершено!"
echo "🌐 Backend должен быть доступен по адресу: http://89.111.152.241:3000"
