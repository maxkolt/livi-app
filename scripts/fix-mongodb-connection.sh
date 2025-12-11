#!/bin/bash
# Диагностика и исправление подключения к MongoDB

echo "=========================================="
echo "1. Проверка .env файла"
echo "=========================================="
cd /opt/livi-app/backend
echo "Содержимое MONGO_DB:"
grep "MONGO_DB" .env | sed 's|://[^:]*:[^@]*@|://***:***@|' || echo "❌ MONGO_DB не найден"

echo ""
echo "=========================================="
echo "2. Проверка доступности MongoDB Atlas"
echo "=========================================="
# Извлекаем хост из URI
MONGO_URI=$(grep "^MONGO_DB=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
if [ -z "$MONGO_URI" ]; then
    echo "❌ MONGO_URI не найден в .env"
    exit 1
fi

# Извлекаем хост (например, info.icgnmhy.mongodb.net)
MONGO_HOST=$(echo "$MONGO_URI" | sed -n 's|.*@\([^/]*\)/.*|\1|p')
if [ -z "$MONGO_HOST" ]; then
    echo "❌ Не удалось извлечь хост из URI"
    exit 1
fi

echo "Проверка доступности хоста: $MONGO_HOST"
# Проверяем доступность через telnet или nc
timeout 5 bash -c "echo > /dev/tcp/${MONGO_HOST}/27017" 2>/dev/null && echo "✅ Порт 27017 доступен" || echo "❌ Порт 27017 недоступен"

# Проверяем DNS
echo "Проверка DNS:"
nslookup $MONGO_HOST 2>/dev/null | head -5 || echo "❌ DNS не разрешается"

echo ""
echo "=========================================="
echo "3. Проверка подключения через Node.js"
echo "=========================================="
node << 'NODEEOF'
require('dotenv').config();
const mongoose = require('mongoose');
const uri = process.env.MONGO_DB || process.env.MONGO_URI || process.env.MONGODB_URI;

if (!uri) {
    console.error('❌ MONGO_DB не найден в .env');
    process.exit(1);
}

console.log('🔌 Попытка подключения...');
console.log('URI (скрыт):', uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'));

const timeout = setTimeout(() => {
    console.error('❌ Таймаут подключения (10 секунд)');
    process.exit(1);
}, 10000);

mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
})
    .then(() => {
        clearTimeout(timeout);
        const dbName = mongoose.connection.db.databaseName;
        const host = mongoose.connection.host;
        console.log(`✅ Подключено к БД: ${dbName}`);
        console.log(`📍 Хост: ${host}`);
        mongoose.connection.close();
        process.exit(0);
    })
    .catch(err => {
        clearTimeout(timeout);
        console.error('❌ Ошибка подключения:', err.message);
        console.error('   Тип:', err.name);
        if (err.reason) {
            console.error('   Причина:', err.reason.message || err.reason);
        }
        process.exit(1);
    });
NODEEOF

echo ""
echo "=========================================="
echo "4. Проверка IP сервера для whitelist"
echo "=========================================="
echo "Ваш внешний IP:"
curl -s ifconfig.me || curl -s icanhazip.com || echo "Не удалось определить"
echo ""

echo "=========================================="
echo "ВАЖНО: Убедитесь, что этот IP добавлен в"
echo "MongoDB Atlas -> Network Access -> IP Access List"
echo "Или используйте 0.0.0.0/0 для всех IP (менее безопасно)"
echo "=========================================="
