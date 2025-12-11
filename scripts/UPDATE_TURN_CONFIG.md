# Обновление настроек TURN для сервера 89.111.152.241

## Настройки TURN на сервере

Если у вас уже настроен TURN сервер на 89.111.152.241, нужно обновить конфигурацию:

### 1. Backend .env файл (на сервере)

Создайте или обновите `/opt/livi-app/backend/.env`:

```env
PORT=3000
HOST=0.0.0.0
MONGO_URI=mongodb://localhost:27017/livi-app

# TURN Server Configuration
TURN_HOST=89.111.152.241
TURN_PORT=3478
TURN_SECRET=your_turn_secret_here
TURN_ENABLE_TCP=1
TURN_TTL=600
STUN_HOST=89.111.152.241
```

**Важно:** 
- `TURN_SECRET` должен совпадать с секретом в вашем coturn конфиге
- `TURN_PORT` обычно 3478 для UDP и TCP
- Если используете другой порт, укажите его

### 2. Frontend .env файл (на вашем компьютере)

Обновите `frontend/.env`:

```env
# TURN Server Configuration
EXPO_PUBLIC_TURN_URL=turn:89.111.152.241:3478
EXPO_PUBLIC_TURN_TCP_URLS=turn:89.111.152.241:3478?transport=tcp
EXPO_PUBLIC_TURN_USERNAME=  # Оставляем пустым - используется ephemeral credentials
EXPO_PUBLIC_TURN_CREDENTIAL=  # Оставляем пустым - используется ephemeral credentials
```

**Примечание:** 
- Frontend получает TURN credentials через `/api/turn-credentials` endpoint
- Ephemeral credentials генерируются автоматически на backend
- Если используете статические credentials, укажите их в EXPO_PUBLIC_TURN_USERNAME и EXPO_PUBLIC_TURN_CREDENTIAL

### 3. Проверка TURN сервера

Проверьте, что TURN сервер работает:

```bash
# На сервере
systemctl status coturn

# Проверка портов
netstat -tuln | grep 3478
```
