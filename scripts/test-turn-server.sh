#!/bin/bash
# Скрипт для проверки работы TURN сервера

echo "=== Проверка TURN сервера ==="
echo ""

# IP сервера
TURN_IP="89.111.152.241"
TURN_PORT="3478"

echo "1. Проверка доступности сервера (ping)..."
ping -c 3 $TURN_IP 2>&1 | tail -3
echo ""

echo "2. Проверка портов TURN сервера..."
echo "Проверка UDP порта 3478:"
timeout 3 nc -u -v $TURN_IP $TURN_PORT 2>&1 | head -2 || echo "UDP порт недоступен или firewall блокирует"
echo ""

echo "Проверка TCP порта 3478:"
timeout 3 nc -v $TURN_IP $TURN_PORT 2>&1 | head -2 || echo "TCP порт недоступен или firewall блокирует"
echo ""

echo "3. Проверка эндпоинта бэкенда для получения TURN credentials..."
BACKEND_URL="http://localhost:3000/api/turn-credentials"
echo "Запрос к: $BACKEND_URL"
curl -s $BACKEND_URL | python3 -m json.tool 2>/dev/null || curl -s $BACKEND_URL
echo ""
echo ""

echo "4. Проверка конфигурации бэкенда..."
cd /Users/maximkoltovich/LiVi/livi-app
echo "TURN_HOST: $(grep TURN_HOST backend/.env | cut -d'=' -f2)"
echo "STUN_HOST: $(grep STUN_HOST backend/.env | cut -d'=' -f2)"
echo ""

echo "=== Проверка завершена ==="
echo ""
echo "Для полной проверки на сервере выполните:"
echo "ssh root@$TURN_IP 'systemctl status coturn && tail -20 /var/log/turnserver.log'"

