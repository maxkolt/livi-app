#!/bin/bash
# Проверка что backend подключен к MongoDB и работает

echo "=========================================="
echo "1. Перезапуск backend с обновленным .env"
echo "=========================================="
pm2 restart livi-backend --update-env
sleep 3

echo ""
echo "=========================================="
echo "2. Проверка логов MongoDB подключения"
echo "=========================================="
pm2 logs livi-backend --lines 100 --nostream | grep -i -E "mongo|database|connected|videochat" | tail -20

echo ""
echo "=========================================="
echo "3. Проверка количества пользователей в БД"
echo "=========================================="
cd /opt/livi-app/backend
node << 'NODEEOF'
require('dotenv').config();
const mongoose = require('mongoose');
const uri = process.env.MONGO_DB;

mongoose.connect(uri)
    .then(async () => {
        const dbName = mongoose.connection.db.databaseName;
        console.log(`✅ БД: ${dbName}`);
        
        const userCount = await mongoose.connection.db.collection('users').countDocuments();
        const installCount = await mongoose.connection.db.collection('installs').countDocuments();
        
        console.log(`👥 Пользователей: ${userCount}`);
        console.log(`📱 Installs: ${installCount}`);
        
        if (userCount > 0) {
            const users = await mongoose.connection.db.collection('users').find({}).sort({ _id: -1 }).limit(5).toArray();
            console.log('\n📋 Последние пользователи:');
            users.forEach((u, i) => {
                console.log(`  ${i + 1}. ${u._id}: ${u.nick || 'N/A'}`);
            });
        }
        
        mongoose.connection.close();
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Ошибка:', err.message);
        process.exit(1);
    });
NODEEOF

echo ""
echo "=========================================="
echo "4. Статус PM2"
echo "=========================================="
pm2 status
