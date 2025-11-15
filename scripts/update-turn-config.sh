#!/bin/bash
# Скрипт для обновления конфигурации TURN сервера после создания нового сервера

if [ -z "$1" ]; then
    echo "Использование: $0 <НОВЫЙ_IP_АДРЕС>"
    echo "Пример: $0 123.45.67.89"
    exit 1
fi

NEW_IP=$1
echo "Обновление конфигурации на IP: $NEW_IP"

# Обновляем локальную конфигурацию TURN сервера (если используется)
if [ -f "/opt/homebrew/etc/turnserver.conf" ]; then
    echo "Обновление /opt/homebrew/etc/turnserver.conf..."
    sudo sed -i.bak "s/relay-ip=.*/relay-ip=$NEW_IP/" /opt/homebrew/etc/turnserver.conf
    sudo sed -i.bak "s/external-ip=.*/external-ip=$NEW_IP/" /opt/homebrew/etc/turnserver.conf
    sudo sed -i.bak "s/realm=.*/realm=$NEW_IP/" /opt/homebrew/etc/turnserver.conf
    echo "✓ Локальная конфигурация TURN обновлена"
fi

# Обновляем конфигурацию бэкенда
BACKEND_ENV="./backend/.env"
if [ -f "$BACKEND_ENV" ]; then
    echo "Обновление $BACKEND_ENV..."
    sed -i.bak "s/TURN_HOST=.*/TURN_HOST=$NEW_IP/" "$BACKEND_ENV"
    sed -i.bak "s/STUN_HOST=.*/STUN_HOST=$NEW_IP/" "$BACKEND_ENV"
    echo "✓ Конфигурация бэкенда обновлена"
else
    echo "⚠ Файл $BACKEND_ENV не найден"
fi

echo ""
echo "=== Обновление завершено! ==="
echo "Новый IP: $NEW_IP"
echo ""
echo "Следующие шаги:"
echo "1. Перезапустите локальный TURN сервер (если используется):"
echo "   brew services restart coturn"
echo ""
echo "2. Перезапустите бэкенд:"
echo "   cd backend && npm run dev"

