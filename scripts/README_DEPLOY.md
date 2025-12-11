# Развертывание Backend на сервере 89.111.152.241

## ✅ TURN сервер находится на том же сервере

TURN сервер уже настроен на вашем облачном сервере `89.111.152.241`. Backend будет использовать его для генерации ephemeral credentials.

## Быстрая настройка

### Шаг 1: В SSH сессии на сервере

Выполните команды из файла `FINAL_SETUP_COMMANDS.txt` или скопируйте блок ниже:

```bash
# Очистка
apt clean

# Node.js
node --version || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs)

# MongoDB
mongod --version || (curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor && echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list && apt update && apt install -y mongodb-org && systemctl enable mongod && systemctl start mongod)

systemctl start mongod && systemctl enable mongod

# PM2
npm install -g pm2

# Создание директории и .env
mkdir -p /opt/livi-app/backend && cd /opt/livi-app/backend && cat > .env << 'EOF'
PORT=3000
HOST=0.0.0.0
MONGO_URI=mongodb://localhost:27017/livi-app

# TURN Server Configuration (на том же сервере)
TURN_HOST=89.111.152.241
TURN_PORT=3478
TURN_SECRET=your_turn_secret_here
TURN_ENABLE_TCP=1
TURN_TTL=600
STUN_HOST=89.111.152.241
EOF

# Открытие портов
ufw allow 3000/tcp || iptables -A INPUT -p tcp --dport 3000 -j ACCEPT || true
ufw allow 3478/udp || iptables -A INPUT -p udp --dport 3478 -j ACCEPT || true
ufw allow 3478/tcp || iptables -A INPUT -p tcp --dport 3478 -j ACCEPT || true
```

### Шаг 2: Найти TURN_SECRET

```bash
# Найдите секрет TURN сервера
grep -r "static-auth-secret\|shared-secret" /etc/turnserver.conf /etc/coturn/turnserver.conf 2>/dev/null || echo "Проверьте конфиг TURN"
```

### Шаг 3: Обновить .env с реальным секретом

```bash
nano /opt/livi-app/backend/.env
# Замените your_turn_secret_here на реальный секрет
```

### Шаг 4: Загрузить файлы backend

В новом терминале на вашем компьютере:

```bash
cd /Users/maximkoltovich/LiVi/livi-app
scp -r backend/* root@89.111.152.241:/opt/livi-app/backend/
```

### Шаг 5: Установить зависимости и запустить

В SSH сессии:

```bash
cd /opt/livi-app/backend
npm install
pm2 delete livi-backend 2>/dev/null || true
pm2 start npm --name "livi-backend" -- run start
pm2 save
pm2 startup
pm2 status
```

## Важно для TURN

1. **TURN_SECRET** должен совпадать с секретом в вашем coturn конфиге
2. **Порты 3478 UDP/TCP** должны быть открыты в панели управления облачного провайдера
3. **Порт 3000 TCP** должен быть открыт для backend API

## Проверка

```bash
# Проверка backend
curl http://localhost:3000/api/turn-credentials

# Проверка TURN
systemctl status coturn
netstat -tuln | grep 3478
```
