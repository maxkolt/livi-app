# Инструкция: Обновление .env на сервере

## Проблема
В файле `backend/.env` на сервере были дубликаты строки `MONGO_DB`, что могло вызывать проблемы с подключением к MongoDB Atlas.

## Решение

### Вариант 1: Использовать скрипт (рекомендуется)

1. Загрузите скрипт `update-server-env-mongodb.sh` на сервер
2. Выполните на сервере через SSH:

```bash
chmod +x update-server-env-mongodb.sh
./update-server-env-mongodb.sh
```

### Вариант 2: Вручную через SSH

```bash
# Подключитесь к серверу
ssh root@89.111.152.241

# Перейдите в директорию backend
cd /opt/livi-app/backend

# Создайте резервную копию
cp .env .env.backup

# Отредактируйте .env
nano .env
```

Убедитесь, что в файле **только одна** строка `MONGO_DB`:

```env
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
```

**ВАЖНО:** Удалите все дубликаты `MONGO_DB`, `MONGO_URI`, `MONGODB_URI` - оставьте только одну строку `MONGO_DB`.

После редактирования:

```bash
# Перезапустите backend с обновленными переменными
pm2 restart livi-backend --update-env

# Проверьте логи
pm2 logs livi-backend --lines 50
```

## Что должно появиться в логах:

```
MongoDB connected successfully
[MongoDB] Current users count in database "videochat": X
```

## Проверка в MongoDB Atlas:

1. Зайдите в MongoDB Atlas Dashboard
2. Выберите кластер
3. Нажмите **Browse Collections**
4. Выберите базу данных **videochat**
5. Проверьте коллекцию **users**

После перезапуска и запуска приложения на мобильном устройстве должны появиться пользователи.
