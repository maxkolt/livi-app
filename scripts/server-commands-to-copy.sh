#!/bin/bash
# Скопируйте и выполните эти команды на сервере через SSH

# 1. Подключитесь к серверу
# ssh root@89.111.152.241
# (введите пароль: y4IDFbSuHPqVRd2U)

# 2. Перейдите в директорию backend
cd /opt/livi-app/backend

# 3. Создайте резервную копию
cp .env .env.backup.$(date +%Y%m%d_%H%M%S)

# 4. Обновите .env файл (удалите дубликаты)
cat > .env << 'EOF'
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
EOF

# 5. Проверьте содержимое (без пароля)
echo "Проверка .env:"
grep "MONGO_DB" .env | sed 's|://[^:]*:[^@]*@|://***:***@|'

# 6. Перезапустите backend с обновленными переменными
pm2 restart livi-backend --update-env

# 7. Подождите 3 секунды
sleep 3

# 8. Проверьте логи
echo ""
echo "Логи MongoDB и пользователей:"
pm2 logs livi-backend --lines 50 --nostream | grep -i -E "mongo|user|identity|database|connected" | tail -20

# 9. Проверьте количество пользователей в БД
echo ""
echo "Проверка количества пользователей:"
node << 'NODEEOF'
require('dotenv').config();
const mongoose = require('mongoose');
const uri = process.env.MONGO_DB || process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
    console.error('❌ MONGO_URI не найден');
    process.exit(1);
}
mongoose.connect(uri)
    .then(() => {
        const dbName = mongoose.connection.db.databaseName;
        console.log(`✅ Подключено к БД: ${dbName}`);
        return mongoose.connection.db.collection('users').countDocuments();
    })
    .then(count => {
        console.log(`👥 Пользователей в коллекции users: ${count}`);
        return mongoose.connection.db.collection('installs').countDocuments();
    })
    .then(count => {
        console.log(`📱 Installs: ${count}`);
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Ошибка:', err.message);
        process.exit(1);
    });
NODEEOF

echo ""
echo "✅ Готово! Проверьте результаты выше."
