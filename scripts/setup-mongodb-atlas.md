# Настройка MongoDB Atlas для сервера

## Ваша строка подключения:
```
MONGO_DB=mongodb+srv://12345kolt:SKp8lGp3WoDR3XM4@info.icgnmhy.mongodb.net/videochat?retryWrites=true&w=majority&appName=info
```

## Шаги для настройки на сервере:

### 1. Обновите backend/.env на сервере (SSH):

```bash
cd /opt/livi-app/backend

# Отредактируйте .env файл
nano .env
# или
vi .env
```

Добавьте/обновите строку:
```env
MONGO_DB=mongodb+srv://12345kolt:SKp8lGp3WoDR3XM4@info.icgnmhy.mongodb.net/videochat?retryWrites=true&w=majority&appName=info
```

**ВАЖНО:** Убедитесь, что в файле только ОДНА строка MONGO_DB (без дубликатов)

### 2. Настройте IP Whitelist в MongoDB Atlas:

1. Зайдите в [MongoDB Atlas Dashboard](https://cloud.mongodb.com/)
2. Выберите ваш кластер
3. Перейдите в **Network Access** (слева в меню)
4. Нажмите **Add IP Address**
5. Добавьте IP адрес вашего сервера:
   - Если знаете IP: добавьте его (например: `89.111.152.241/32`)
   - Для теста: добавьте `0.0.0.0/0` (разрешает доступ с любого IP - **только для разработки!**)
6. Сохраните изменения

### 3. Проверьте подключение на сервере:

```bash
cd /opt/livi-app/backend

# Проверьте, что переменная установлена
grep MONGO_DB .env

# Перезапустите backend
pm2 restart livi-backend

# Проверьте логи подключения
pm2 logs livi-backend --lines 50 | grep -i mongo
```

Должны увидеть:
```
MongoDB connected successfully
[MongoDB] Current users count: X
```

### 4. Если подключение не работает:

Проверьте логи на ошибки:
```bash
pm2 logs livi-backend --lines 100 | grep -i "mongo\|error\|failed"
```

Возможные ошибки:
- `MongoServerError: IP not whitelisted` - добавьте IP в whitelist
- `MongoServerError: Authentication failed` - проверьте пароль
- `MongooseServerSelectionError` - проблема с сетью или кластером

### 5. Проверьте базу данных в MongoDB Atlas:

1. Зайдите в MongoDB Atlas Dashboard
2. Нажмите **Browse Collections**
3. Выберите базу данных `videochat`
4. Проверьте коллекцию `users` - там должны появиться пользователи после запуска приложения

## Проверка после настройки:

После того как все настроено, запустите приложение на мобильном устройстве. При первом подключении должен создаться пользователь через `identity:attach` socket handler.

Проверьте логи сервера:
```bash
pm2 logs livi-backend --lines 100 | grep -i "user created\|identity"
```

Должны увидеть:
```
[identity] ✅ User created (new): 693b1b6f7c054a0edd97bdae
```
