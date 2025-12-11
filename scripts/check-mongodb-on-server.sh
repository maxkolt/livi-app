#!/bin/bash
# Команды для выполнения НА СЕРВЕРЕ через SSH

echo "=========================================="
echo "1. Проверка .env файла"
echo "=========================================="
cd /opt/livi-app/backend
cat .env | grep MONGO_DB | sed 's|://[^:]*:[^@]*@|://***:***@|' || echo "❌ MONGO_DB не найден"

echo ""
echo "=========================================="
echo "2. Проверка подключения к MongoDB"
echo "=========================================="
node << 'NODEEOF'
require('dotenv').config();
const mongoose = require('mongoose');
const uri = process.env.MONGO_DB;
if (!uri) {
    console.error('❌ MONGO_DB не найден');
    process.exit(1);
}
console.log('🔌 Подключение...');
mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })
    .then(() => {
        console.log('✅ Подключено:', mongoose.connection.db.databaseName);
        mongoose.connection.close();
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Ошибка:', err.message);
        if (err.reason) {
            console.error('   Причина:', err.reason.message || err.reason);
        }
        process.exit(1);
    });
NODEEOF

echo ""
echo "=========================================="
echo "3. IP сервера для MongoDB Atlas whitelist"
echo "=========================================="
echo "Ваш IP: 135.148.121.57"
echo ""
echo "ВАЖНО: Добавьте этот IP в MongoDB Atlas:"
echo "1. Зайдите в MongoDB Atlas"
echo "2. Network Access -> IP Access List"
echo "3. Add IP Address -> 135.148.121.57"
echo "=========================================="
