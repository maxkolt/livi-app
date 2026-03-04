#!/bin/bash
# Установка coturn на второй VPS (дополнительный TURN).
# Запуск НА VPS (после SSH).
# Использование: sudo ./setup-second-vps.sh <TURN_SECRET_2> [EXTERNAL_IP]
# Пример: sudo ./setup-second-vps.sh 'ВАШ_СЕКРЕТ' 168.222.253.219

set -e
TURN_SECRET="${1:?Usage: $0 TURN_SECRET_2 [EXTERNAL_IP]}"
EXT_IP="${2:-}"

if [ -z "$EXT_IP" ]; then
  echo "EXTERNAL_IP не задан, пробуем определить..."
  EXT_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || true)
  [ -z "$EXT_IP" ] && { echo "Задайте IP вторым аргументом: $0 SECRET 168.222.253.219"; exit 1; }
fi

echo "TURN secret: задан, External IP: $EXT_IP"

# Установка coturn (Debian/Ubuntu)
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y coturn

# Включить автозапуск
sed -i 's/#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
if ! grep -q 'TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null; then
  echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
fi

# Конфиг coturn
cat > /etc/coturn/turnserver.conf << EOF
listening-ip=0.0.0.0
listening-port=3478
min-port=49152
max-port=65535
external-ip=$EXT_IP
use-auth-secret
static-auth-secret=$TURN_SECRET
realm=$EXT_IP
verbose
fingerprint
no-multicast-peers
no-loopback-peers
EOF

# Фаервол (ufw)
if command -v ufw >/dev/null 2>&1; then
  ufw allow 3478/udp
  ufw allow 3478/tcp
  ufw allow 49152:65535/udp
  echo "y" | ufw enable 2>/dev/null || true
  ufw status
fi

# Запуск
systemctl restart coturn
systemctl enable coturn
systemctl status coturn --no-pager

echo "Готово. Проверка портов:"
ss -ulnp | grep 3478 || true
