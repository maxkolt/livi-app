# Быстрое развертывание Backend на сервере 89.111.152.241

## ⚠️ ВАЖНО: Диск заполнен на 95.8%!
Сначала освободите место на диске, иначе установка может не пройти.

## Быстрые команды для выполнения на сервере

### Шаг 1: Проверка и установка зависимостей

```bash
# Проверяем Node.js
node --version || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs)

# Проверяем MongoDB
mongod --version || (curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor && echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list && apt update && apt install -y mongodb-org)

# Устанавливаем PM2
npm install -g pm2

# Запускаем MongoDB
systemctl start mongod
systemctl enable mongod
```

### Шаг 2: Создание директории

```bash
mkdir -p /opt/livi-app/backend
cd /opt/livi-app/backend
```

### Шаг 3: Загрузка файлов (с вашего компьютера)

```bash
# С вашего локального компьютера выполните:
cd /Users/maximkoltovich/LiVi/livi-app
scp -r backend/* root@89.111.152.241:/opt/livi-app/backend/
```

### Шаг 4: Установка зависимостей на сервере

```bash
cd /opt/livi-app/backend
npm install
```

### Шаг 5: Создание .env файла

```bash
nano /opt/livi-app/backend/.env
```

**Добавьте в .env:**
```env
PORT=3000
HOST=0.0.0.0
MONGO_URI=mongodb://localhost:27017/livi-app
```

### Шаг 6: Открытие порта 3000

```bash
ufw allow 3000/tcp
# или если ufw не установлен:
iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
```

### Шаг 7: Запуск backend

```bash
cd /opt/livi-app/backend
pm2 start npm --name "livi-backend" -- run start
pm2 save
pm2 startup
```

### Шаг 8: Проверка

```bash
# Проверка статуса
pm2 status

# Проверка логов
pm2 logs livi-backend

# Проверка доступности
curl http://localhost:3000
```

## Проверка с вашего компьютера

```bash
curl http://89.111.152.241:3000
```

## Управление

```bash
# Остановка
pm2 stop livi-backend

# Перезапуск
pm2 restart livi-backend

# Логи
pm2 logs livi-backend
```
