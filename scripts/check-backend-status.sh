#!/bin/bash
# Команды для проверки статуса backend после перезапуска

echo "=========================================="
echo "1. Проверка логов MongoDB и пользователей"
echo "=========================================="
pm2 logs livi-backend --lines 100 --nostream | grep -i -E "mongo|user|identity|database|connected|error" | tail -30

echo ""
echo "=========================================="
echo "2. Проверка подключения к MongoDB"
echo "=========================================="
cd /opt/livi-app/backend
node << 'NODEEOF'
require('dotenv').config();
const mongoose = require('mongoose');
const uri = process.env.MONGO_DB || process.env.MONGO_URI || process.env.MONGODB_URI;

if (!uri) {
    console.error('❌ MONGO_DB не найден в .env');
    process.exit(1);
}

console.log('🔌 Подключение к MongoDB...');
mongoose.connect(uri)
    .then(() => {
        const dbName = mongoose.connection.db.databaseName;
        const host = mongoose.connection.host;
        console.log(`✅ Подключено к БД: ${dbName}`);
        console.log(`📍 Хост: ${host}`);
        
        return Promise.all([
            mongoose.connection.db.collection('users').countDocuments(),
            mongoose.connection.db.collection('installs').countDocuments()
        ]);
    })
    .then(([userCount, installCount]) => {
        console.log(`👥 Пользователей в коллекции 'users': ${userCount}`);
        console.log(`📱 Installs: ${installCount}`);
        
        // Показываем последних 5 пользователей
        return mongoose.connection.db.collection('users').find({}).sort({ _id: -1 }).limit(5).toArray();
    })
    .then(users => {
        if (users.length > 0) {
            console.log('\n📋 Последние пользователи:');
            users.forEach((user, i) => {
                console.log(`  ${i + 1}. ID: ${user._id}, Nick: ${user.nick || 'N/A'}, Friends: ${user.friendsCount || 0}`);
            });
        } else {
            console.log('\n⚠️  Пользователей в БД пока нет');
        }
        
        mongoose.connection.close();
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Ошибка подключения:', err.message);
        console.error('   Детали:', err.name);
        process.exit(1);
    });
NODEEOF

echo ""
echo "=========================================="
echo "3. Последние логи backend (все)"
echo "=========================================="
pm2 logs livi-backend --lines 20 --nostream
