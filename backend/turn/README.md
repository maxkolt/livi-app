## TURN (coturn) для стабильных звонков (VPN/моб.сеть/CGNAT)

В приложении TURN берётся через endpoint `GET /api/turn-credentials`.
Сервер уже умеет отдавать **эпhemeral** креды (HMAC-SHA1) в формате, совместимом с coturn.

### Почему это важно
- Без TURN часть пользователей (особенно **VPN/моб.сети/CGNAT/строгие NAT**) будут периодически **не соединяться** или иметь нестабильность.

### Что нужно настроить в проде (без изменения клиента)

1) **Запустить coturn** и открыть порты:
- `3478/udp` (основной TURN UDP)
- `3478/tcp` (TURN TCP — полезно при VPN/фаерволах)
- `443/tcp` (TURN TCP/443 — “последний шанс” при жёстких сетях, **только если 443 не занят HTTPS**)
- UDP диапазон релея (например `49152-65535/udp`) — иначе TURN “подключится”, но не сможет прокидывать медиа

2) **Задать env на backend** (пример):
- `TURN_SECRET` — общий секрет (shared secret) **тот же**, что в coturn
- `TURN_HOST` — домен TURN (рекомендуется), например `turn.example.com`
- `TURN_PORT` — порт TURN (обычно `3478`)
- `TURN_ENABLE_TCP=1` — включить добавление TCP кандидатов (рекомендовано)
- `TURN_ENABLE_TCP_443=1` — **опционально**, добавляет `turn:<host>:443?transport=tcp` (включать только если 443 свободен под coturn)
- `TURN_TTL=600` — TTL кредов (секунды)
- (опционально) `STUN_HOST` — если STUN должен отличаться от `TURN_HOST`

3) Проверка
- Открой: `GET /api/turn-credentials`
- В ответе должен быть `ok: true` и `iceServers` со строками `turn:...` и **с `username`/`credential`**
- В логах клиента исчезнет предупреждение `⚠️ NO TURN SERVER - NAT traversal may fail!`

### Второй TURN (дополнительный VPS)

Для лучшей работы можно подключить **второй** TURN на отдельном VPS. Клиенты автоматически получат оба сервера в `iceServers` и смогут использовать тот, что быстрее/доступнее.

1) На **новом VPS** установите и настройте coturn (см. `turnserver.conf.example` и `turnserver.conf.second.example`).
2) В **backend** задайте переменные:
   - `TURN_HOST_2` — домен или IP второго TURN (например `turn2.example.com` или IP VPS)
   - `TURN_SECRET_2` — **тот же** shared secret, что в конфиге coturn на втором VPS
   - `TURN_PORT_2=3478` (по умолчанию)
   - `TURN_ENABLE_TCP_2=1`, `TURN_ENABLE_TCP_443_2=0` (по необходимости)

Проверка: `GET /api/turn-credentials` должен вернуть в `iceServers` записи и для первого, и для второго TURN.

### Файлы в этой папке
- `turnserver.conf.example` — пример конфига coturn под shared-secret
- `turnserver.conf.second.example` — пример для второго TURN на отдельном VPS
- `docker-compose.turn.example.yml` — пример docker-compose для coturn
- `setup-second-vps.sh` — скрипт установки coturn на VPS (запуск на сервере)

