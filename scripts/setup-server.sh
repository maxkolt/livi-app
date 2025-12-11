#!/bin/bash

# Скрипт для настройки сервера
# Загрузите этот файл на сервер и выполните: bash setup-server.sh

set -e

echo "🚀 Начинаем настройку сервера..."

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

# 4. Создание директории
echo "📁 Создаем директорию проекта..."
mkdir -p /opt/livi-app/backend
cd /opt/livi-app/backend

# 5. Установка зависимостей
if [ -f "package.json" ]; then
    echo "📦 Устанавливаем зависимости проекта..."
    npm install
else
    echo "⚠️  package.json не найден, пропускаем установку зависимостей"
fi

# 6. Создание .env файла
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

# 7. Открытие порта 3000
echo "🔓 Открываем порт 3000..."
ufw allow 3000/tcp 2>/dev/null || iptables -A INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || echo "⚠️  Не удалось открыть порт автоматически"

# 8. Остановка старого процесса
echo "🛑 Останавливаем старый процесс (если есть)..."
pm2 delete livi-backend 2>/dev/null || true

# 9. Запуск backend
if [ -f "package.json" ]; then
    echo "🚀 Запускаем backend..."
    cd /opt/livi-app/backend
    pm2 start npm --name "livi-backend" -- run start
    pm2 save
    pm2 startup | grep -v "PM2" | bash || true
    
    echo ""
    echo "✅ Backend запущен!"
    echo ""
    echo "📊 Статус:"
    pm2 status
    echo ""
    echo "📋 Последние логи:"
    sleep 2
    pm2 logs livi-backend --lines 20 --nostream
else
    echo "⚠️  package.json не найден, backend не запущен"
    echo "💡 Сначала загрузите файлы backend на сервер"
fi

echo ""
echo "✅ Настройка завершена!"
