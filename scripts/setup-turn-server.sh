#!/bin/bash
# Скрипт для настройки TURN сервера на сервере

echo "=========================================="
echo "Настройка TURN сервера (coturn)"
echo "=========================================="

# 1. Проверка установки coturn
if ! command -v turnserver &> /dev/null; then
    echo "Установка coturn..."
    apt-get update
    apt-get install -y coturn
else
    echo "✅ coturn уже установлен"
fi

# 2. Проверка конфигурации
echo ""
echo "Текущая конфигурация TURN:"
echo "TURN_HOST: 89.111.152.241"
echo "TURN_PORT: 3478"
echo "TURN_SECRET: (из backend/.env)"

# 3. Проверка backend/.env
echo ""
echo "Проверка backend/.env:"
cd /opt/livi-app/backend
if [ -f .env ]; then
    TURN_SECRET=$(grep "^TURN_SECRET=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    TURN_HOST=$(grep "^TURN_HOST=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    TURN_PORT=$(grep "^TURN_PORT=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    
    echo "TURN_SECRET: ${TURN_SECRET:0:10}... (скрыт)"
    echo "TURN_HOST: $TURN_HOST"
    echo "TURN_PORT: $TURN_PORT"
    
    if [ -z "$TURN_SECRET" ]; then
        echo "❌ TURN_SECRET не найден в .env!"
        exit 1
    fi
else
    echo "❌ .env файл не найден!"
    exit 1
fi

# 4. Создание конфигурации coturn
echo ""
echo "Создание конфигурации coturn..."

COTURN_CONFIG="/etc/turnserver.conf"
COTURN_CONFIG_BACKUP="/etc/turnserver.conf.backup.$(date +%Y%m%d_%H%M%S)"

# Резервная копия
if [ -f "$COTURN_CONFIG" ]; then
    cp "$COTURN_CONFIG" "$COTURN_CONFIG_BACKUP"
    echo "✅ Резервная копия создана: $COTURN_CONFIG_BACKUP"
fi

# Создаем конфигурацию
cat > "$COTURN_CONFIG" << EOF
# TURN Server Configuration
# Generated: $(date)

# Listening interfaces
listening-ip=0.0.0.0
listening-port=3478

# External IP (ваш публичный IP)
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

# Разрешаем все IP (для тестирования)
# В продакшене можно ограничить
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255

# Разрешаем relay для всех
no-multicast-peers
no-stdout-log
EOF

echo "✅ Конфигурация создана: $COTURN_CONFIG"

# 5. Проверка и перезапуск coturn
echo ""
echo "Проверка статуса coturn..."
systemctl status coturn --no-pager | head -10

echo ""
echo "Перезапуск coturn..."
systemctl restart coturn
sleep 2

# 6. Проверка работы
echo ""
echo "Проверка работы TURN сервера:"
if systemctl is-active --quiet coturn; then
    echo "✅ coturn запущен"
else
    echo "❌ coturn не запущен!"
    echo "Логи:"
    journalctl -u coturn -n 20 --no-pager
    exit 1
fi

# 7. Проверка портов
echo ""
echo "Проверка портов:"
netstat -tuln | grep -E "3478|49152" | head -5

# 8. Тест подключения
echo ""
echo "Тест подключения к TURN:"
timeout 3 bash -c "echo > /dev/tcp/89.111.152.241/3478" 2>/dev/null && echo "✅ Порт 3478 доступен" || echo "⚠️  Порт 3478 недоступен (проверьте firewall)"

echo ""
echo "=========================================="
echo "✅ Настройка TURN завершена!"
echo "=========================================="
echo ""
echo "Проверьте логи:"
echo "  journalctl -u coturn -f"
echo ""
echo "Проверьте конфигурацию backend:"
echo "  cd /opt/livi-app/backend && cat .env | grep TURN"
