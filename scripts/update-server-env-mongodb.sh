#!/bin/bash
# Скрипт для обновления MONGO_DB на сервере
# ВАЖНО: Запускайте этот скрипт на СЕРВЕРЕ через SSH

echo "==========================================="
echo "ОБНОВЛЕНИЕ .env НА СЕРВЕРЕ"
echo "==========================================="
echo ""

BACKEND_DIR="/opt/livi-app/backend"

if [ ! -d "$BACKEND_DIR" ]; then
    echo "❌ Директория $BACKEND_DIR не найдена"
    echo "Убедитесь, что вы запускаете скрипт на сервере"
    exit 1
fi

cd "$BACKEND_DIR" || exit 1

# Создаем резервную копию
if [ -f ".env" ]; then
    echo "📦 Создаю резервную копию .env..."
    cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
fi

# Обновляем .env файл
echo "📝 Обновляю .env файл..."
cat > .env << 'ENVEOF'
# MongoDB Configuration
MONGO_DB=mongodb+srv://12345kolt:SKp8lGp3WoDR3XM4@info.icgnmhy.mongodb.net/videochat?retryWrites=true&w=majority&appName=info

# Server Configuration
PORT=3000
HOST=0.0.0.0

# TURN/STUN Configuration
TURN_SECRET=8f7d6e5c4b3a291827364554839201a1b2c3d4e5f60718293445566778899a0
TURN_HOST=89.111.152.241
TURN_PORT=3478
STUN_HOST=89.111.152.241
TURN_ENABLE_TCP=1
TURN_TTL=600

# Development
NODE_ENV=development
ENVEOF

echo "✅ .env файл обновлен"
echo ""

# Проверяем содержимое (без пароля)
echo "Проверка (без пароля):"
grep "MONGO_DB" .env | sed 's|://[^:]*:[^@]*@|://***:***@|'
echo ""

# Перезапускаем backend с обновленными переменными
echo "🔄 Перезапускаю backend с обновленными переменными..."
pm2 restart livi-backend --update-env

if [ $? -eq 0 ]; then
    echo "✅ Backend перезапущен"
    echo ""
    
    # Ждем немного
    sleep 3
    
    # Показываем логи
    echo "📋 Последние логи (MongoDB и пользователи):"
    pm2 logs livi-backend --lines 50 --nostream | grep -i -E "mongo|user|identity|database|connected" | tail -20
    echo ""
    
    echo "==========================================="
    echo "✅ ГОТОВО!"
    echo "==========================================="
    echo ""
    echo "Проверьте логи на наличие:"
    echo "  - 'MongoDB connected successfully'"
    echo "  - '[MongoDB] Current users count'"
    echo "  - '[identity] ✅ User created'"
    echo ""
else
    echo "❌ Ошибка при перезапуске"
    exit 1
fi
