#!/bin/bash
# ПОЛНЫЙ СКРИПТ НАСТРОЙКИ СЕРВЕРА
# Скопируйте весь этот файл и выполните на сервере одной командой

set -e

echo "🚀 Начинаем полную настройку сервера..."

# 1. Очистка диска
echo "🧹 Очищаем диск..."
apt clean
journalctl --vacuum-time=7d 2>/dev/null || true
docker system prune -a -f 2>/dev/null || true

# 2. Установка Node.js
echo "📦 Устанавливаем Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
echo "✅ Node.js: $(node --version)"

# 3. Установка MongoDB
echo "📦 Устанавливаем MongoDB..."
if ! command -v mongod &> /dev/null; then
    curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
    apt update
    apt install -y mongodb-org
    systemctl enable mongod
fi
systemctl start mongod
echo "✅ MongoDB запущен"

# 4. Установка PM2
echo "📦 Устанавливаем PM2..."
npm install -g pm2

# 5. Создание директории и .env
echo "📁 Создаем директорию и .env..."
mkdir -p /opt/livi-app/backend
cd /opt/livi-app/backend

cat > .env << 'EOF'
PORT=3000
HOST=0.0.0.0
MONGO_URI=mongodb://localhost:27017/livi-app
EOF

# 6. Открытие порта
echo "🔓 Открываем порт 3000..."
ufw allow 3000/tcp 2>/dev/null || iptables -A INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || echo "⚠️  Откройте порт 3000 в панели управления облачного провайдера"

echo ""
echo "✅ Базовая настройка завершена!"
echo ""
echo "📤 Теперь загрузите файлы backend с вашего компьютера:"
echo "   cd /Users/maximkoltovich/LiVi/livi-app"
echo "   scp -r backend/* root@89.111.152.241:/opt/livi-app/backend/"
echo ""
echo "📋 После загрузки выполните на сервере:"
echo "   cd /opt/livi-app/backend"
echo "   npm install"
echo "   pm2 delete livi-backend 2>/dev/null || true"
echo "   pm2 start npm --name 'livi-backend' -- run start"
echo "   pm2 save"
echo "   pm2 startup"
