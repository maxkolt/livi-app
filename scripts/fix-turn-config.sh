#!/bin/bash
# Исправление конфигурации TURN сервера

echo "=========================================="
echo "Исправление конфигурации TURN"
echo "=========================================="

cd /opt/livi-app/backend

# 1. Получаем TURN_SECRET из .env
if [ ! -f .env ]; then
    echo "❌ .env файл не найден в /opt/livi-app/backend"
    exit 1
fi

TURN_SECRET=$(grep "^TURN_SECRET=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'" | tr -d ' ')

if [ -z "$TURN_SECRET" ]; then
    echo "❌ TURN_SECRET не найден в .env!"
    echo "Содержимое .env (TURN секция):"
    grep -i turn .env || echo "TURN переменные не найдены"
    exit 1
fi

echo "✅ TURN_SECRET найден: ${TURN_SECRET:0:10}..."

# 2. Создаем директорию для логов
mkdir -p /var/log
touch /var/log/turnserver.log
chown turnserver:turnserver /var/log/turnserver.log 2>/dev/null || chmod 666 /var/log/turnserver.log

# 3. Создаем правильную конфигурацию
echo ""
echo "Создание конфигурации coturn..."

cat > /etc/turnserver.conf << EOF
# TURN Server Configuration для LiVi Video Chat
# Generated: $(date)

# Listening
listening-ip=0.0.0.0
listening-port=3478

# External IP
external-ip=89.111.152.241

# Realm
realm=livi-video-chat

# REST API для ephemeral credentials
use-auth-secret
static-auth-secret=$TURN_SECRET

# Логирование
log-file=/var/log/turnserver.log
verbose

# Безопасность
no-cli
no-tls
no-dtls

# Ресурсы
min-port=49152
max-port=65535

# Производительность
total-quota=100
user-quota=12
max-bps=1000000

# Разрешаем relay
no-multicast-peers
no-stdout-log
EOF

echo "✅ Конфигурация создана"

# 4. Перезапуск coturn
echo ""
echo "Перезапуск coturn..."
systemctl restart coturn
sleep 3

# 5. Проверка статуса
echo ""
echo "Проверка статуса..."
if systemctl is-active --quiet coturn; then
    echo "✅ coturn запущен"
    systemctl status coturn --no-pager | head -15
else
    echo "❌ coturn не запущен!"
    echo "Логи:"
    journalctl -u coturn -n 30 --no-pager
    exit 1
fi

# 6. Проверка портов
echo ""
echo "Проверка портов:"
netstat -tuln 2>/dev/null | grep 3478 || ss -tuln 2>/dev/null | grep 3478 || echo "⚠️  Порт 3478 не слушается"

# 7. Тест API
echo ""
echo "Тест API backend:"
sleep 2
curl -s http://localhost:3000/api/turn-credentials 2>/dev/null | head -30 || echo "⚠️  API недоступен"

echo ""
echo "=========================================="
echo "✅ Настройка завершена!"
echo "=========================================="
