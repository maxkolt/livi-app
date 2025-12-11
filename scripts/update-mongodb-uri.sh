#!/bin/bash
# Скрипт для обновления строки подключения к MongoDB Atlas

MONGO_URI="mongodb+srv://12345kolt:SKp8lGp3WoDR3XM4@info.icgnmhy.mongodb.net/videochat?retryWrites=true&w=majority&appName=info"

echo "==========================================="
echo "ОБНОВЛЕНИЕ MONGO_URI"
echo "==========================================="
echo ""

# Проверяем, существует ли backend/.env
if [ ! -f "backend/.env" ]; then
    echo "❌ Файл backend/.env не найден"
    echo "Создаю новый файл..."
    mkdir -p backend
    touch backend/.env
fi

# Проверяем, есть ли уже MONGO_DB в файле
if grep -q "^MONGO_DB=" backend/.env; then
    echo "📝 Обновляю существующий MONGO_DB..."
    # Обновляем существующую строку
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s|^MONGO_DB=.*|MONGO_DB=$MONGO_URI|" backend/.env
    else
        # Linux
        sed -i "s|^MONGO_DB=.*|MONGO_DB=$MONGO_URI|" backend/.env
    fi
else
    echo "➕ Добавляю MONGO_DB в .env..."
    echo "MONGO_DB=$MONGO_URI" >> backend/.env
fi

# Также добавляем альтернативные варианты для совместимости
if ! grep -q "^MONGO_URI=" backend/.env; then
    echo "MONGO_URI=$MONGO_URI" >> backend/.env
fi

if ! grep -q "^MONGODB_URI=" backend/.env; then
    echo "MONGODB_URI=$MONGO_URI" >> backend/.env
fi

echo ""
echo "✅ Строка подключения обновлена"
echo ""
echo "Проверка содержимого (без пароля):"
grep "MONGO" backend/.env | sed 's|://[^:]*:[^@]*@|://***:***@|'
echo ""

# Проверка подключения (если mongosh доступен)
if command -v mongosh &> /dev/null; then
    echo "Проверка подключения к MongoDB Atlas..."
    mongosh "$MONGO_URI" --eval "db.adminCommand('ping')" --quiet 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "✅ Подключение к MongoDB Atlas успешно"
        
        # Проверяем количество пользователей
        USER_COUNT=$(mongosh "$MONGO_URI" --eval "db.users.countDocuments()" --quiet 2>/dev/null | tail -1)
        echo "📊 Текущее количество пользователей: $USER_COUNT"
    else
        echo "❌ Не удалось подключиться к MongoDB Atlas"
        echo "   Проверьте:"
        echo "   - Правильность пароля"
        echo "   - Доступность сети (IP whitelist в MongoDB Atlas)"
        echo "   - Правильность имени базы данных (videochat)"
    fi
elif command -v mongo &> /dev/null; then
    echo "Проверка подключения к MongoDB Atlas (старая версия mongo)..."
    mongo "$MONGO_URI" --eval "db.adminCommand('ping')" --quiet 2>/dev/null
    if [ $? -eq 0 ]; then
        echo "✅ Подключение к MongoDB Atlas успешно"
        USER_COUNT=$(mongo "$MONGO_URI" --eval "db.users.countDocuments()" --quiet 2>/dev/null | tail -1)
        echo "📊 Текущее количество пользователей: $USER_COUNT"
    else
        echo "❌ Не удалось подключиться к MongoDB Atlas"
    fi
else
    echo "⚠️  mongosh/mongo не установлен, пропускаем проверку подключения"
fi

echo ""
echo "==========================================="
echo "ВАЖНО:"
echo "==========================================="
echo ""
echo "1. Убедитесь, что IP адрес сервера добавлен в whitelist MongoDB Atlas:"
echo "   - Зайдите в MongoDB Atlas Dashboard"
echo "   - Network Access -> Add IP Address"
echo "   - Добавьте IP вашего сервера (или 0.0.0.0/0 для всех)"
echo ""
echo "2. Перезапустите backend сервер:"
echo "   pm2 restart livi-backend"
echo ""
echo "3. Проверьте логи:"
echo "   pm2 logs livi-backend --lines 50"
echo ""
