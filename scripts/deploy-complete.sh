#!/bin/bash
# ПОЛНОЕ РАЗВЕРТЫВАНИЕ - выполните на вашем компьютере
# Этот скрипт загрузит файлы и настроит сервер

SERVER_IP="89.111.152.241"
SERVER_USER="root"
PASSWORD="y4IDFbSuHPqVRd2U"

echo "🚀 Начинаем развертывание..."

# Загружаем скрипт настройки на сервер
echo "📤 Загружаем скрипт настройки..."
cat server-setup-complete.sh | ssh $SERVER_USER@$SERVER_IP "cat > /tmp/setup.sh && chmod +x /tmp/setup.sh && bash /tmp/setup.sh"

# Загружаем файлы backend
echo "📤 Загружаем файлы backend..."
scp -r backend/* $SERVER_USER@$SERVER_IP:/opt/livi-app/backend/

# Устанавливаем зависимости и запускаем
echo "⚙️  Устанавливаем зависимости и запускаем backend..."
ssh $SERVER_USER@$SERVER_IP << 'ENDSSH'
cd /opt/livi-app/backend
npm install
pm2 delete livi-backend 2>/dev/null || true
pm2 start npm --name "livi-backend" -- run start
pm2 save
pm2 startup | grep -v "PM2" | bash || true
sleep 3
pm2 status
pm2 logs livi-backend --lines 20 --nostream
ENDSSH

echo ""
echo "✅ Развертывание завершено!"
echo "🌐 Backend должен быть доступен по адресу: http://89.111.152.241:3000"
