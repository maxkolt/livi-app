#!/bin/bash
# Скрипт для обновления MONGO_DB на сервере
# ВАЖНО: Запускайте этот скрипт на СЕРВЕРЕ через SSH

MONGO_URI="mongodb+srv://12345kolt:SKp8lGp3WoDR3XM4@info.icgnmhy.mongodb.net/videochat?retryWrites=true&w=majority&appName=info"

echo "==========================================="
echo "ОБНОВЛЕНИЕ MONGO_DB НА СЕРВЕРЕ"
echo "==========================================="
echo ""

BACKEND_DIR="/opt/livi-app/backend"

if [ ! -d "$BACKEND_DIR" ]; then
    echo "❌ Директория $BACKEND_DIR не найдена"
    echo "Убедитесь, что вы запускаете скрипт на сервере"
    exit 1
fi

cd "$BACKEND_DIR" || exit 1

# Создаем .env если его нет
if [ ! -f ".env" ]; then
    echo "📝 Создаю новый .env файл..."
    touch .env
fi

# Удаляем все старые строки MONGO_*
echo "🧹 Очищаю старые MONGO_* переменные..."
sed -i '/^MONGO_DB=/d' .env
sed -i '/^MONGO_URI=/d' .env
sed -i '/^MONGODB_URI=/d' .env

# Добавляем новую строку
echo "➕ Добавляю новую строку подключения..."
echo "MONGO_DB=$MONGO_URI" >> .env

echo ""
echo "✅ .env файл обновлен"
echo ""
echo "Проверка (без пароля):"
grep "MONGO_DB" .env | sed 's|://[^:]*:[^@]*@|://***:***@|'
echo ""

# Проверяем подключение (если node доступен)
if command -v node &> /dev/null; then
    echo "Проверка подключения к MongoDB Atlas..."
    node << 'EOF'
require('dotenv').config();
const mongoose = require('mongoose');
const uri = process.env.MONGO_DB || process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
    console.error('❌ MONGO_DB не найден в .env');
    process.exit(1);
}
mongoose.connect(uri)
    .then(() => {
        console.log('✅ Подключение к MongoDB Atlas успешно');
        return mongoose.connection.db.collection('users').countDocuments();
    })
    .then(count => {
        console.log(`📊 Текущее количество пользователей: ${count}`);
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Ошибка подключения:', err.message);
        process.exit(1);
    });
EOF
else
    echo "⚠️  node не найден, пропускаем проверку подключения"
fi

echo ""
echo "==========================================="
echo "СЛЕДУЮЩИЕ ШАГИ:"
echo "==========================================="
echo ""
echo "1. Перезапустите backend:"
echo "   pm2 restart livi-backend"
echo ""
echo "2. Проверьте логи:"
echo "   pm2 logs livi-backend --lines 50"
echo ""
echo "3. Убедитесь, что IP сервера добавлен в MongoDB Atlas whitelist"
echo ""
