#!/bin/bash
# Скрипт для диагностики проблем подключения

echo "==========================================="
echo "ДИАГНОСТИКА ПОДКЛЮЧЕНИЯ К СЕРВЕРУ"
echo "==========================================="
echo ""

# 1. Проверка .env файла frontend
echo "1. Проверка конфигурации frontend (.env):"
if [ -f "frontend/.env" ]; then
    echo "✅ Файл .env найден"
    echo "Содержимое (без секретов):"
    grep -E "EXPO_PUBLIC_SERVER_URL|EXPO_PUBLIC_SERVER_URL_IOS|EXPO_PUBLIC_SERVER_URL_ANDROID" frontend/.env | sed 's/=.*/=***/' || echo "  (переменные не найдены)"
else
    echo "❌ Файл frontend/.env не найден"
fi
echo ""

# 2. Проверка доступности сервера
echo "2. Проверка доступности сервера:"
SERVER_URL=$(grep -E "^EXPO_PUBLIC_SERVER_URL=" frontend/.env 2>/dev/null | cut -d'=' -f2 | tr -d '"' || echo "http://192.168.1.12:3000")
echo "Используемый URL: $SERVER_URL"
echo ""

# Проверка локального сервера
echo "Проверка localhost:3000:"
if curl -s --connect-timeout 3 http://localhost:3000 > /dev/null 2>&1; then
    echo "✅ localhost:3000 доступен"
    curl -s http://localhost:3000/api/turn-credentials | head -c 100
    echo ""
else
    echo "❌ localhost:3000 недоступен"
fi
echo ""

# Проверка по IP из .env
if [[ "$SERVER_URL" != "http://localhost:3000" ]]; then
    echo "Проверка $SERVER_URL:"
    if curl -s --connect-timeout 3 "$SERVER_URL" > /dev/null 2>&1; then
        echo "✅ $SERVER_URL доступен"
        curl -s "$SERVER_URL/api/turn-credentials" | head -c 100
        echo ""
    else
        echo "❌ $SERVER_URL недоступен"
        echo "   Возможные причины:"
        echo "   - Сервер не запущен"
        echo "   - Неправильный IP адрес"
        echo "   - Файрвол блокирует подключение"
    fi
    echo ""
fi

# 3. Проверка PM2 (если на сервере)
echo "3. Проверка PM2 процессов (если доступен):"
if command -v pm2 &> /dev/null; then
    echo "Статус PM2:"
    pm2 status 2>/dev/null || echo "  PM2 не запущен или нет процессов"
else
    echo "  PM2 не установлен (это нормально для локальной разработки)"
fi
echo ""

# 4. Проверка портов
echo "4. Проверка портов:"
if command -v netstat &> /dev/null; then
    echo "Порт 3000:"
    netstat -tuln 2>/dev/null | grep ":3000" || echo "  Порт 3000 не слушается"
elif command -v ss &> /dev/null; then
    echo "Порт 3000:"
    ss -tuln 2>/dev/null | grep ":3000" || echo "  Порт 3000 не слушается"
else
    echo "  netstat/ss не доступны"
fi
echo ""

# 5. Рекомендации
echo "==========================================="
echo "РЕКОМЕНДАЦИИ:"
echo "==========================================="
echo ""
echo "Если сервер недоступен:"
echo "1. Проверьте, запущен ли backend:"
echo "   cd backend && npm run start"
echo ""
echo "2. Или через PM2 (на сервере):"
echo "   pm2 status"
echo "   pm2 restart livi-backend"
echo ""
echo "3. Проверьте правильность URL в frontend/.env:"
echo "   EXPO_PUBLIC_SERVER_URL=http://YOUR_SERVER_IP:3000"
echo ""
echo "4. Для локальной разработки используйте:"
echo "   EXPO_PUBLIC_SERVER_URL=http://192.168.1.12:3000"
echo "   (замените 192.168.1.12 на IP вашего компьютера)"
echo ""

