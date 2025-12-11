#!/bin/bash
# ПОЛНАЯ НАСТРОЙКА СЕРВЕРА С TURN
# Выполните на сервере в SSH сессии

set -e

echo "🚀 Начинаем полную настройку сервера с TURN..."

# 1. Очистка диска
echo "🧹 Очищаем диск..."
apt clean
journalctl --vacuum-time=7d 2>/dev/null || true

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

# 4. Проверка TURN сервера (coturn)
echo "📦 Проверяем TURN сервер..."
if ! command -v turnserver &> /dev/null; then
    echo "⚠️  TURN сервер (coturn) не установлен"
    echo "💡 Установите coturn: apt install -y coturn"
else
    echo "✅ TURN сервер установлен"
    systemctl start coturn 2>/dev/null || true
    systemctl enable coturn 2>/dev/null || true
fi

# 5. Установка PM2
echo "📦 Устанавливаем PM2..."
npm install -g pm2

# 6. Создание директории и .env
echo "📁 Создаем директорию и .env..."
mkdir -p /opt/livi-app/backend
cd /opt/livi-app/backend

# Создаем .env с настройками TURN
cat > .env << 'EOF'
PORT=3000
HOST=0.0.0.0
MONGO_URI=mongodb://localhost:27017/livi-app

# TURN Server Configuration
TURN_HOST=89.111.152.241
TURN_PORT=3478
TURN_SECRET=your_turn_secret_here
TURN_ENABLE_TCP=1
TURN_TTL=600
STUN_HOST=89.111.152.241
EOF

echo "✅ .env создан"
echo "⚠️  ВАЖНО: Обновите TURN_SECRET в .env файле на реальный секрет из вашего coturn конфига!"

# 7. Открытие портов
echo "🔓 Открываем порты..."
ufw allow 3000/tcp 2>/dev/null || iptables -A INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || true
ufw allow 3478/udp 2>/dev/null || iptables -A INPUT -p udp --dport 3478 -j ACCEPT 2>/dev/null || true
ufw allow 3478/tcp 2>/dev/null || iptables -A INPUT -p tcp --dport 3478 -j ACCEPT 2>/dev/null || true
echo "⚠️  Убедитесь, что порты 3000, 3478 (UDP/TCP) открыты в панели управления облачного провайдера!"

echo ""
echo "✅ Базовая настройка завершена!"
echo ""
echo "📤 Теперь загрузите файлы backend с вашего компьютера:"
echo "   cd /Users/maximkoltovich/LiVi/livi-app"
echo "   scp -r backend/* root@89.111.152.241:/opt/livi-app/backend/"
echo ""
echo "📋 После загрузки выполните на сервере:"
echo "   cd /opt/livi-app/backend"
echo "   nano .env  # Обновите TURN_SECRET на реальный секрет!"
echo "   npm install"
echo "   pm2 delete livi-backend 2>/dev/null || true"
echo "   pm2 start npm --name 'livi-backend' -- run start"
echo "   pm2 save"
echo "   pm2 startup"
