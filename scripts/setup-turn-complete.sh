#!/bin/bash
# Полная настройка TURN сервера на сервере

echo "=========================================="
echo "Настройка TURN сервера (coturn)"
echo "=========================================="

cd /opt/livi-app/backend

# 1. Проверка .env
if [ ! -f .env ]; then
    echo "❌ .env файл не найден!"
    exit 1
fi

TURN_SECRET=$(grep "^TURN_SECRET=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'" | tr -d ' ')
TURN_HOST=$(grep "^TURN_HOST=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'" | tr -d ' ' || echo "89.111.152.241")
TURN_PORT=$(grep "^TURN_PORT=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'" | tr -d ' ' || echo "3478")

if [ -z "$TURN_SECRET" ]; then
    echo "❌ TURN_SECRET не найден в .env!"
    echo "Добавьте в backend/.env:"
    echo "TURN_SECRET=ваш_секретный_ключ_64_символа"
    exit 1
fi

echo "✅ Конфигурация найдена:"
echo "   TURN_HOST: $TURN_HOST"
echo "   TURN_PORT: $TURN_PORT"
echo "   TURN_SECRET: ${TURN_SECRET:0:10}... (скрыт)"

# 2. Установка coturn
echo ""
echo "Проверка установки coturn..."
if ! command -v turnserver &> /dev/null; then
    echo "Установка coturn..."
    apt-get update -qq
    apt-get install -y coturn
else
    echo "✅ coturn уже установлен"
fi

# 3. Создание конфигурации
echo ""
echo "Создание конфигурации coturn..."

COTURN_CONFIG="/etc/turnserver.conf"
COTURN_CONFIG_BACKUP="/etc/turnserver.conf.backup.$(date +%Y%m%d_%H%M%S)"

# Резервная копия
if [ -f "$COTURN_CONFIG" ]; then
    cp "$COTURN_CONFIG" "$COTURN_CONFIG_BACKUP"
    echo "✅ Резервная копия: $COTURN_CONFIG_BACKUP"
fi

# Создаем конфигурацию
cat > "$COTURN_CONFIG" << EOF
# TURN Server Configuration для LiVi Video Chat
# Generated: $(date)

# Listening
listening-ip=0.0.0.0
listening-port=$TURN_PORT

# External IP
external-ip=$TURN_HOST

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

echo "✅ Конфигурация создана: $COTURN_CONFIG"

# 4. Включение и запуск coturn
echo ""
echo "Запуск coturn..."
systemctl enable coturn
systemctl restart coturn
sleep 3

# 5. Проверка статуса
echo ""
echo "Проверка статуса..."
if systemctl is-active --quiet coturn; then
    echo "✅ coturn запущен"
else
    echo "❌ coturn не запущен!"
    echo "Логи:"
    journalctl -u coturn -n 30 --no-pager
    exit 1
fi

# 6. Проверка портов
echo ""
echo "Проверка портов:"
netstat -tuln | grep -E "$TURN_PORT|49152" | head -5 || ss -tuln | grep -E "$TURN_PORT|49152" | head -5

# 7. Проверка firewall
echo ""
echo "Проверка firewall:"
if command -v ufw &> /dev/null; then
    ufw status | grep -E "$TURN_PORT|49152" || echo "⚠️  Порты могут быть закрыты в firewall"
    echo "Если порты закрыты, выполните:"
    echo "  ufw allow $TURN_PORT/udp"
    echo "  ufw allow $TURN_PORT/tcp"
    echo "  ufw allow 49152:65535/udp"
fi

# 8. Тест API
echo ""
echo "Тест API backend:"
sleep 2
curl -s http://localhost:3000/api/turn-credentials | head -20 || echo "⚠️  API недоступен (backend может быть не запущен)"

echo ""
echo "=========================================="
echo "✅ Настройка TURN завершена!"
echo "=========================================="
echo ""
echo "Проверьте логи:"
echo "  journalctl -u coturn -f"
echo ""
echo "Проверьте работу:"
echo "  curl http://localhost:3000/api/turn-credentials"
