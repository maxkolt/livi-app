# Runbook: поднять staging (3 SFU, TURN, Redis) по DoD

Пошагово: подготовка конфигов и запуск.

**Быстрый старт:** из корня репо выполните `./scripts/setup-staging-configs.sh` — создастся `backend/.env.staging`, `livekit/.env.staging`, `backend/turn/turnserver.conf` из примеров. Дальше отредактируйте в них секреты по шагам ниже.

---

## Шаг 1. LiveKit (3 SFU)

1. Создайте `livekit/.env.staging` из примера и подставьте ключи (те же, что в backend):

   ```bash
   cp livekit/.env.staging.example livekit/.env.staging
   ```
   (или уже создано скриптом `./scripts/setup-staging-configs.sh`)

2. Откройте `livekit/.env.staging` и замените `your_api_key:your_api_secret` на реальные значения **в том же формате** (без пробелов вокруг `:`), совпадающие с `LIVEKIT_API_KEY` и `LIVEKIT_API_SECRET` из `backend/.env.staging`.

   Пример:
   ```env
   LIVEKIT_KEYS=devkey:abcrealsecret123
   ```

3. Файл `livekit/livekit.staging.yaml` уже есть в репо — порт 7880, RTC-диапазон 50000–60000. Менять не нужно, если не используете другой порт.

---

## Шаг 2. TURN (coturn)

1. Создайте конфиг TURN из примера и подставьте секрет и realm:

   ```bash
   cp backend/turn/turnserver.conf.example backend/turn/turnserver.conf
   ```

   Откройте `backend/turn/turnserver.conf` и замените:
   - `<SET_SAME_VALUE_AS_BACKEND_TURN_SECRET>` — на **тот же** секрет, что задаёте в `backend/.env.staging` как `TURN_SECRET`.
   - `<YOUR_DOMAIN_OR_TURN_DOMAIN>` — на ваш TURN-домен (тот же, что `TURN_HOST` в backend), например `turn.staging.liviapp.com`.

2. В `backend/.env.staging` задайте (если ещё не задано):
   ```env
   TURN_HOST=turn.staging.liviapp.com
   TURN_SECRET=<тот же секрет, что в turnserver.conf>
   TURN_PORT=3478
   TURN_ENABLE_TCP=1
   ```

---

## Шаг 3. Backend .env.staging и Redis

1. Создайте `backend/.env.staging` из примера (если ещё нет):

   ```bash
   cp backend/.env.staging.example backend/.env.staging
   ```

2. Заполните в `backend/.env.staging`:
   - `MONGO_URI` — строка подключения к MongoDB для staging.
   - `LIVEKIT_URL=wss://livekit.staging.liviapp.com` (или ваш домен).
   - `LIVEKIT_API_KEY` и `LIVEKIT_API_SECRET` — те же, что в `livekit/.env.staging` (в формате ключ:секрет в LiveKit — только ключ и только секрет отдельно).
   - **Redis (DoD):** для формального DoD подставьте URL **managed Redis с failover** (ElastiCache, Redis Cloud, Upstash и т.п.):
     ```env
     REDIS_URL=rediss://your-managed-redis.example.com:6379
     ```
     Для локального прогона через docker-compose можно оставить:
     ```env
     REDIS_URL=redis://redis:6379
     ```
   - Остальное по необходимости (JWT, порт и т.д.).

3. **Проверка Redis после старта backend:** в логах контейнера backend должна появиться строка:
   ```text
   [queueStore:redis] connected
   ```
   Если её нет — backend использует in-memory store (для DoD нужен Redis). Проверьте `REDIS_URL` и доступность хоста Redis.

---

## Шаг 4. Запуск

Из корня репозитория:

```bash
docker compose -f docker-compose.staging.yml up -d
```

Проверка:

- Backend: `curl -s http://localhost:3000/health` (или `https://api.staging.liviapp.com/health` через nginx).
- TURN: `curl -s http://localhost:3000/api/turn-credentials` (или через api.staging) — в ответе должны быть `iceServers` с `turn:...` и полями `username`/`credential`.
- LiveKit: за `livekit.staging.liviapp.com:7880` (или через ваш nginx на 443) должен отвечать балансировщик перед тремя нодами.

---

## Шаг 5. Проверка по DoD

| Что проверить | Как |
|---------------|-----|
| 3 SFU | За `livekit.staging.liviapp.com` стоит nginx, за ним 3 контейнера livekit1, livekit2, livekit3. Или в панели LB — 3 бэкенда. |
| TURN | `GET /api/turn-credentials` возвращает TURN с username/credential; в backend и coturn один и тот же `TURN_SECRET`. |
| Redis | В логах backend есть `[queueStore:redis] connected`; в `backend/.env.staging` указан `REDIS_URL` на managed Redis (для DoD). |

Подробный чеклист: [DOD_STAGING_INFRASTRUCTURE.md](./DOD_STAGING_INFRASTRUCTURE.md).
