#!/bin/bash
# ВСЕ В ОДНОМ - выполните на сервере одной командой
# Скопируйте весь этот скрипт и выполните на сервере: bash <(cat << 'SCRIPT'
# ...вставьте содержимое...
# SCRIPT

set -e

echo "🚀 Начинаем полную настройку сервера..."

# Очистка диска
echo "🧹 Очищаем диск..."
apt clean
journalctl --vacuum-time=7d 2>/dev/null || true

# Node.js
echo "📦 Устанавливаем Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
echo "✅ Node.js: $(node --version)"

# MongoDB
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

# PM2
echo "📦 Устанавливаем PM2..."
npm install -g pm2

# Директория
echo "📁 Создаем директорию..."
mkdir -p /opt/livi-app/backend
cd /opt/livi-app/backend

# .env
echo "📝 Создаем .env..."
cat > .env << 'EOF'
PORT=3000
HOST=0.0.0.0
MONGO_URI=mongodb://localhost:27017/livi-app
EOF

# Порт
echo "🔓 Открываем порт 3000..."
ufw allow 3000/tcp 2>/dev/null || iptables -A INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || true

echo ""
echo "✅ Базовая настройка завершена!"
echo ""
echo "📤 Теперь загрузите файлы backend с вашего компьютера:"
echo "   scp -r backend/* root@89.111.152.241:/opt/livi-app/backend/"
echo ""
echo "📋 После загрузки выполните на сервере:"
echo "   cd /opt/livi-app/backend"
echo "   npm install"
echo "   pm2 start npm --name 'livi-backend' -- run start"
echo "   pm2 save"
