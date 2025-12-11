# Инструкция по развертыванию Backend на облачном сервере

## Информация о сервере
- **Публичный IP:** `89.111.152.241`
- **Приватный IP:** `192.168.0.10`
- **Порт:** `3000` (нужно убедиться, что он открыт)

## Шаги развертывания

### 1. Подключение к серверу

```bash
# Подключитесь к серверу по SSH
ssh root@89.111.152.241
# или
ssh root@192.168.0.10
```

### 2. Установка необходимого ПО

```bash
# Обновление системы
apt update && apt upgrade -y

# Установка Node.js (если еще не установлен)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Установка MongoDB (если еще не установлен)
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
apt update
apt install -y mongodb-org

# Установка PM2 для управления процессом
npm install -g pm2
```

### 3. Клонирование/загрузка проекта

```bash
# Создайте директорию для проекта
mkdir -p /opt/livi-app
cd /opt/livi-app

# Если используете git:
git clone <your-repo-url> .

# Или загрузите файлы через scp:
# scp -r backend/ root@89.111.152.241:/opt/livi-app/backend/
```

### 4. Настройка Backend

```bash
cd /opt/livi-app/backend

# Установка зависимостей
npm install

# Создайте .env файл
nano .env
```

**Содержимое `.env` файла:**
```env
PORT=3000
HOST=0.0.0.0
MONGO_URI=mongodb://localhost:27017/livi-app
# или если MongoDB на другом сервере:
# MONGO_URI=mongodb://username:password@host:27017/livi-app
```

### 5. Настройка файрвола

```bash
# Убедитесь, что порт 3000 открыт
ufw allow 3000/tcp
# или для iptables:
# iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
```

### 6. Запуск Backend

**Вариант 1: С PM2 (рекомендуется для продакшена)**

```bash
cd /opt/livi-app/backend

# Запуск с PM2
pm2 start npm --name "livi-backend" -- run start

# Или для разработки:
pm2 start npm --name "livi-backend-dev" -- run dev

# Сохранение конфигурации PM2
pm2 save
pm2 startup
```

**Вариант 2: Прямой запуск (для тестирования)**

```bash
cd /opt/livi-app/backend
npm run start
```

### 7. Проверка работы

```bash
# Проверьте, что сервер запущен
curl http://localhost:3000

# Проверьте логи PM2
pm2 logs livi-backend

# Проверьте статус
pm2 status
```

### 8. Настройка автозапуска (если используете PM2)

```bash
# PM2 автоматически настроит автозапуск
pm2 startup
pm2 save
```

## Проверка доступности

После запуска проверьте доступность сервера:

```bash
# С вашего локального компьютера
curl http://89.111.152.241:3000

# Или откройте в браузере
# http://89.111.152.241:3000
```

## Управление процессом

```bash
# Остановка
pm2 stop livi-backend

# Перезапуск
pm2 restart livi-backend

# Просмотр логов
pm2 logs livi-backend

# Мониторинг
pm2 monit
```

## Важные замечания

1. **Порт 3000 должен быть открыт** в настройках облачного провайдера
2. **MongoDB должен быть запущен** и доступен
3. **HOST=0.0.0.0** - это правильно, сервер будет слушать на всех интерфейсах
4. Используйте **PM2** для продакшена - это обеспечит автоперезапуск при сбоях

## Troubleshooting

### Проблема: Не могу подключиться к серверу
- Проверьте, что порт 3000 открыт в файрволе облачного провайдера
- Проверьте, что backend запущен: `pm2 status` или `ps aux | grep node`

### Проблема: MongoDB не подключается
- Проверьте, что MongoDB запущен: `systemctl status mongod`
- Проверьте строку подключения в `.env`

### Проблема: Процесс падает
- Проверьте логи: `pm2 logs livi-backend`
- Убедитесь, что все зависимости установлены: `npm install`
