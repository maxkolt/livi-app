#!/bin/bash
# Скрипт для установки и настройки TURN сервера (coturn) на Ubuntu

set -e

echo "=== Установка и настройка TURN сервера ==="

# Обновляем систему
echo "Обновление системы..."
apt-get update
apt-get upgrade -y

# Устанавливаем coturn
echo "Установка coturn..."
apt-get install -y coturn

# Получаем внешний IP сервера
EXTERNAL_IP=$(curl -s ifconfig.me || curl -s ipinfo.io/ip)
echo "Обнаружен внешний IP: $EXTERNAL_IP"

# Секретный ключ для ephemeral credentials (должен совпадать с TURN_SECRET на бэкенде)
TURN_SECRET="8f7d6e5c4b3a291827364554839201a1b2c3d4e5f60718293445566778899a0"

# Создаем конфигурацию turnserver
echo "Создание конфигурации turnserver..."
cat > /etc/turnserver.conf << EOF
# ===== Порты =====
listening-port=3478
tls-listening-port=5349

# ===== IP =====
listening-ip=0.0.0.0
relay-ip=$EXTERNAL_IP
external-ip=$EXTERNAL_IP

# ===== Авторизация =====
lt-cred-mech
realm=$EXTERNAL_IP
# Секретный ключ для ephemeral credentials (HMAC-SHA1)
static-auth-secret=$TURN_SECRET
# Статические учетные данные (для совместимости)
user=webrtcuser:supersecretpassword
fingerprint

# ===== Логи =====
log-file=/var/log/turnserver.log
simple-log
verbose

# ===== Безопасность =====
no-stdout-log
no-loopback-peers
no-multicast-peers
no-tlsv1
no-tlsv1_1
EOF

# Включаем coturn в автозагрузку
echo "Включение coturn в автозагрузку..."
systemctl enable coturn

# Запускаем coturn
echo "Запуск coturn..."
systemctl restart coturn

# Проверяем статус
echo "Проверка статуса coturn..."
systemctl status coturn --no-pager | head -10

# Настраиваем firewall (если установлен ufw)
if command -v ufw &> /dev/null; then
    echo "Настройка firewall..."
    ufw allow 3478/udp
    ufw allow 3478/tcp
    ufw allow 5349/udp
    ufw allow 5349/tcp
    echo "Firewall настроен"
fi

echo ""
echo "=== Установка завершена! ==="
echo "IP сервера: $EXTERNAL_IP"
echo "TURN порты: 3478 (UDP/TCP), 5349 (TLS)"
echo ""
echo "Проверьте логи: tail -f /var/log/turnserver.log"
echo "Проверьте статус: systemctl status coturn"

