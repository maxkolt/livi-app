# Инструкция по настройке TURN сервера

## Текущая конфигурация

- **TURN Host**: `89.111.152.241`
- **TURN Port**: `3478`
- **TURN Secret**: (из `backend/.env`)

## Проблема

На iOS RTCPeerConnection не может инициализироваться, потому что:
1. VPN блокирует загрузку ICE конфигурации
2. Fallback конфигурация не содержит правильный TURN сервер
3. TURN сервер может быть не запущен на сервере

## Решение

### Шаг 1: Проверка TURN сервера на сервере

Выполните на сервере через SSH:

```bash
ssh root@89.111.152.241

# Проверка установки coturn
which turnserver || echo "coturn не установлен"

# Проверка статуса
systemctl status coturn

# Проверка портов
netstat -tuln | grep 3478
```

### Шаг 2: Установка и настройка coturn (если не установлен)

```bash
# Установка
apt-get update
apt-get install -y coturn

# Проверка TURN_SECRET из backend/.env
cd /opt/livi-app/backend
TURN_SECRET=$(grep "^TURN_SECRET=" .env | cut -d'=' -f2- | tr -d '"' | tr -d "'")
echo "TURN_SECRET: ${TURN_SECRET:0:10}..."
```

### Шаг 3: Создание конфигурации coturn

```bash
# Резервная копия
cp /etc/turnserver.conf /etc/turnserver.conf.backup

# Создание конфигурации
cat > /etc/turnserver.conf << 'EOF'
listening-ip=0.0.0.0
listening-port=3478
external-ip=89.111.152.241
realm=livi-video-chat
use-auth-secret
static-auth-secret=ВАШ_TURN_SECRET_ИЗ_BACKEND_ENV
log-file=/var/log/turnserver.log
verbose
no-cli
no-tls
no-dtls
min-port=49152
max-port=65535
EOF

# Замените ВАШ_TURN_SECRET_ИЗ_BACKEND_ENV на реальный секрет из backend/.env
```

### Шаг 4: Запуск coturn

```bash
# Включить автозапуск
systemctl enable coturn

# Запустить
systemctl start coturn

# Проверить статус
systemctl status coturn

# Проверить логи
journalctl -u coturn -f
```

### Шаг 5: Проверка firewall

```bash
# Проверка открытых портов
ufw status | grep 3478

# Если порт закрыт, откройте:
ufw allow 3478/udp
ufw allow 3478/tcp
ufw allow 49152:65535/udp
```

### Шаг 6: Проверка работы

```bash
# Проверка доступности
curl http://localhost:3478

# Проверка через API backend
curl http://localhost:3000/api/turn-credentials
```

### Шаг 7: Перезапуск backend

```bash
cd /opt/livi-app/backend
pm2 restart livi-backend --update-env
```

## Проверка на frontend

После настройки проверьте логи:

1. **Успешная загрузка ICE конфигурации**:
   ```
   [ICE Config] Server configuration loaded: { hasTurn: true, ... }
   ```

2. **RTCPeerConnection создается успешно**:
   ```
   [RandomChatSession] ✅ RTCPeerConnection создан успешно
   ```

## Альтернатива: Использование внешнего TURN сервера

Если не хотите настраивать свой TURN сервер, можно использовать внешний:

1. **Twilio STUN/TURN** (платный)
2. **Xirsys** (платный)
3. **metered.ca** (бесплатный tier)

Но для продакшена рекомендуется свой TURN сервер.
