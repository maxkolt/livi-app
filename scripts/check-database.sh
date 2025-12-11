#!/bin/bash
# Скрипт для проверки состояния базы данных

echo "==========================================="
echo "ПРОВЕРКА БАЗЫ ДАННЫХ"
echo "==========================================="
echo ""

# 1. Проверка подключения к MongoDB
echo "1. Проверка подключения к MongoDB:"
if command -v mongosh &> /dev/null; then
    echo "  Используем mongosh..."
    mongosh --eval "db.adminCommand('ping')" --quiet 2>/dev/null && echo "  ✅ MongoDB доступен" || echo "  ❌ MongoDB недоступен"
elif command -v mongo &> /dev/null; then
    echo "  Используем mongo..."
    mongo --eval "db.adminCommand('ping')" --quiet 2>/dev/null && echo "  ✅ MongoDB доступен" || echo "  ❌ MongoDB недоступен"
else
    echo "  ⚠️  mongosh/mongo не установлен, пропускаем проверку"
fi
echo ""

# 2. Проверка переменных окружения
echo "2. Проверка переменных окружения:"
if [ -f "backend/.env" ]; then
    echo "  ✅ Файл backend/.env найден"
    MONGO_URI=$(grep -E "^MONGO_URI=|^MONGO_DB=|^MONGODB_URI=" backend/.env | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    if [ -n "$MONGO_URI" ]; then
        # Скрываем пароль
        MONGO_URI_SAFE=$(echo "$MONGO_URI" | sed 's|//[^:]*:[^@]*@|//***:***@|')
        echo "  MONGO_URI: $MONGO_URI_SAFE"
        
        # Извлекаем имя базы данных
        DB_NAME=$(echo "$MONGO_URI" | sed -n 's|.*/\([^?]*\).*|\1|p')
        if [ -n "$DB_NAME" ]; then
            echo "  Имя БД: $DB_NAME"
        fi
    else
        echo "  ❌ MONGO_URI не найден в .env"
    fi
else
    echo "  ❌ Файл backend/.env не найден"
fi
echo ""

# 3. Проверка логов сервера
echo "3. Проверка логов сервера (последние 50 строк):"
if command -v pm2 &> /dev/null; then
    echo "  Логи PM2:"
    pm2 logs livi-backend --lines 50 --nostream 2>/dev/null | grep -i -E "mongo|user|error|connected" | tail -20 || echo "  (нет релевантных логов)"
else
    echo "  ⚠️  PM2 не установлен, пропускаем проверку логов"
fi
echo ""

# 4. Рекомендации
echo "==========================================="
echo "РЕКОМЕНДАЦИИ:"
echo "==========================================="
echo ""
echo "1. Проверьте логи сервера:"
echo "   pm2 logs livi-backend --lines 100"
echo ""
echo "2. Проверьте подключение к MongoDB:"
echo "   mongosh 'mongodb://localhost:27017/videochat'"
echo ""
echo "3. Проверьте коллекции в MongoDB Compass:"
echo "   - users (должна быть не пустая)"
echo "   - installs (должна содержать связи installId -> userId)"
echo ""
echo "4. Если пользователей нет, проверьте:"
echo "   - Запущен ли backend сервер"
echo "   - Подключен ли MongoDB"
echo "   - Есть ли ошибки в логах при создании пользователей"
echo ""
echo "5. Для создания тестового пользователя:"
echo "   - Запустите приложение на мобильном устройстве"
echo "   - При первом запуске должен создаться пользователь через identity:attach"
echo ""

