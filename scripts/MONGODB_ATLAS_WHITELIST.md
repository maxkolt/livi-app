# Настройка MongoDB Atlas Whitelist

## Проблема
Backend не может подключиться к MongoDB Atlas из-за таймаута подключения. Это обычно означает, что IP сервера не добавлен в whitelist.

## Решение

### 1. Определите IP вашего сервера
IP вашего сервера: **135.148.121.57**

### 2. Добавьте IP в MongoDB Atlas

1. Зайдите в [MongoDB Atlas](https://cloud.mongodb.com/)
2. Выберите ваш кластер
3. Перейдите в **Network Access** (в левом меню)
4. Нажмите **Add IP Address**
5. Введите IP: `135.148.121.57`
6. Или для тестирования можно временно разрешить все IP: `0.0.0.0/0` (менее безопасно)
7. Нажмите **Confirm**

### 3. Проверьте подключение на сервере

Выполните на сервере через SSH:

```bash
ssh root@89.111.152.241
cd /opt/livi-app/backend
node << 'NODEEOF'
require('dotenv').config();
const mongoose = require('mongoose');
const uri = process.env.MONGO_DB;
mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 })
    .then(() => {
        console.log('✅ Подключено:', mongoose.connection.db.databaseName);
        mongoose.connection.close();
        process.exit(0);
    })
    .catch(err => {
        console.error('❌ Ошибка:', err.message);
        process.exit(1);
    });
NODEEOF
```

### 4. Перезапустите backend

```bash
pm2 restart livi-backend --update-env
pm2 logs livi-backend --lines 50 --nostream | grep -i mongo
```

## Альтернатива: Разрешить все IP (только для тестирования)

Если нужно быстро протестировать, можно временно разрешить все IP:
- IP Address: `0.0.0.0/0`
- Comment: `Allow all (testing only)`

⚠️ **Внимание**: Это менее безопасно, используйте только для тестирования!
