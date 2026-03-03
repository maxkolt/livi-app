# DoD Staging: 3 SFU, TURN pool, Managed Redis

Формальный чеклист по Definition of Done: **«Staging поднят: 3 SFU, TURN pool, managed Redis»**.

---

## 1. Три ноды SFU (LiveKit)

**Требование:** минимум 3 ноды LiveKit для Stage A (500 concurrent).

### Вариант A: Текущий staging уже развёрнут с 3 нодами

- [ ] Подтвердить в панели/инфраструктуре: за `livekit.staging.liviapp.com` стоит **балансировщик** (nginx, ALB, или аналог), за которым ровно **3 инстанса** LiveKit.
- [ ] В `backend/.env.staging` указан один URL: `LIVEKIT_URL=wss://livekit.staging.liviapp.com` (клиенты ходят на LB, LB распределяет по нодам).

**Как проверить:** посмотреть конфиг балансировщика или список бэкендов (upstream / target group) — должно быть 3 цели (три разных хоста/порта LiveKit).

### Вариант B: Развернуть 3 ноды с нуля (Docker Compose в репо)

В репозитории настроено:

- `docker-compose.staging.yml` поднимает **3 сервиса LiveKit** (`livekit1`, `livekit2`, `livekit3`) и **nginx** как балансировщик перед ними.
- На хосте `livekit.staging.liviapp.com` должен указывать на этот хост; nginx слушает порт 7880 и распределяет трафик на три ноды.

Чеклист:

- [ ] Запуск: `docker compose -f docker-compose.staging.yml up -d`
- [ ] В `backend/.env.staging`: `LIVEKIT_URL=wss://livekit.staging.liviapp.com` (и при необходимости порт, если не 443)
- [ ] Подтверждение: за одним доменом `livekit.staging.*` отдаёт трафик nginx на 3 контейнера LiveKit (проверка через логи/метрики или конфиг nginx).

---

## 2. TURN pool — отдельный пул, не на SFU, multi-AZ

**Требование:** TURN — отдельный пул (не на тех же серверах, что SFU), по возможности multi-AZ.

### Подтверждение / настройка

- [ ] **Отдельно от SFU:** TURN (coturn или аналог) запущен на **отдельных** инстансах/контейнерах, не на нодах LiveKit.
- [ ] **Multi-AZ (рекомендуется):** в облаке — TURN в нескольких зонах доступности; для одного VPS — хотя бы один отдельный хост/контейнер с TURN.
- [ ] В `backend/.env.staging` заданы:
  - `TURN_HOST=<домен или хост TURN>` (например `turn.staging.liviapp.com`)
  - `TURN_SECRET=<общий секрет>` — тот же, что в конфиге coturn (`use-auth-secret`, `static-auth-secret`)
  - `TURN_PORT=3478` (или ваш порт)
- [ ] В DNS: запись для TURN (например `turn.staging.liviapp.com`) указывает на балансировщик или инстансы TURN (не на SFU).
- [ ] Проверка: `GET https://api.staging.liviapp.com/api/turn-credentials` возвращает `iceServers` с `turn:...` и полями `username`/`credential`.

Для локального/односерверного staging в репо: в `docker-compose.staging.yml` включён сервис **coturn** как отдельный контейнер (не на нодах LiveKit). Для формального multi-AZ в облаке — развернуть TURN в нескольких AZ и указать `TURN_HOST` на соответствующий LB/домен.

---

## 3. Redis — managed + failover, REDIS_URL на staging

**Требование:** на staging используется **managed Redis** с failover; в backend явно указан `REDIS_URL` на этот инстанс.

### Подтверждение

- [ ] Redis на staging — **managed** (например AWS ElastiCache, Redis Cloud, Upstash и т.п.) с включённым **failover** (replica/HA).
- [ ] В `backend/.env.staging` задана переменная **`REDIS_URL`** и она указывает на этот managed Redis (например `rediss://...` или `redis://...` в зависимости от провайдера).
- [ ] Backend при старте подхватывает Redis: в логах есть сообщение вида `[queueStore:redis] connected` (см. `backend/utils/queueStore.ts` и `queueStoreRedis.ts`).

**Важно:** если в `docker-compose.staging.yml` поднят локальный контейнер `redis` — это только для локальной проверки. Для **формального DoD** staging должен использовать именно **managed Redis с failover**, и `REDIS_URL` в `.env.staging` должен указывать на него (не на `redis://redis:6379` от локального контейнера).

---

## Краткая сводка

| Компонент | Требование | Где подтвердить |
|-----------|------------|------------------|
| **3 SFU** | Три ноды LiveKit за одним URL (через LB) | Конфиг LB / список бэкендов; или `docker-compose.staging.yml` (3 сервиса + nginx) |
| **TURN pool** | Отдельно от SFU, multi-AZ по возможности | Отдельные инстансы/контейнеры; `TURN_HOST` + `TURN_SECRET` в backend; `/api/turn-credentials` |
| **Redis** | Managed + failover; `REDIS_URL` на staging | `REDIS_URL` в `backend/.env.staging` → managed Redis; лог `[queueStore:redis] connected` |

После выполнения всех пунктов чеклиста формулировка DoD **«Staging поднят: 3 SFU, TURN pool, managed Redis»** считается выполненной.

**Дальше:** для полного закрытия этапа A (нагрузочный тест 500 concurrent, SLO, отчёт) используй [STAGE_A_CLOSE_CHECKLIST.md](./STAGE_A_CLOSE_CHECKLIST.md).
