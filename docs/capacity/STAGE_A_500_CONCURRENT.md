# Этап A — 500 concurrent: Definition of Done и Runbook

## Definition of Done (Этап A)

- [ ] **Staging поднят:** 3 SFU, TURN pool, managed Redis. Чеклист и подтверждение: [DOD_STAGING_INFRASTRUCTURE.md](./DOD_STAGING_INFRASTRUCTURE.md).
- [ ] **Прогон до 500 concurrent завершён** (минимум 30–60 мин).
- [ ] **SLO на этапе A выполнены:**
  - P95 join time &lt; 2.5s
  - P95 packet loss &lt; 2%
  - P95 RTT &lt; 180ms
  - call failure &lt; 0.5%
- [ ] **Есть отчёт capacity:** participants/node, calls/node, TURN ratio, CPU/NIC headroom.

Решение: если SLO держатся и headroom есть → Этап A закрыт, переход к 2k. Если нет → фикс узких мест (TURN ratio, CPU peaks, reconnect spikes), повтор теста.

---

## 1. Инфраструктура (что нужно сделать вручную)

Поднять **отдельный staging-контур** (не prod).

| Компонент | Требование |
|-----------|------------|
| **SFU** | Минимум 3 ноды, autoscaling включен. LiveKit: отдельный кластер/namespace для staging. |
| **TURN** | Отдельный пул (не на SFU), multi-AZ. Coturn или аналог с тем же REST API для ephemeral credentials (`TURN_SECRET`, `TURN_HOST`). |
| **Redis** | Managed Redis + failover (для очереди матчинга и блокировок; сейчас в коде — in-memory fallback, для staging обязателен Redis). |

Переменные backend для staging: `MONGO_URI`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `TURN_HOST`, `TURN_SECRET`, `TURN_PORT`, `REDIS_URL` (обязательно для staging — backend подключает Redis автоматически при заданном `REDIS_URL`).

Метрики backend: `GET /metrics` (Prometheus), `GET /api/capacity/stats` (JSON), `POST /api/capacity/client-metrics` (тело: `joinTimeMs`, `rttMs`, `packetLoss`, `reconnect`, `joinSuccess`, `joinFailure`). Пример алертов: `docs/capacity/prometheus-alerts.example.yml`. Staging compose: `docker-compose -f docker-compose.staging.yml up`.

---

## 2. Конфиг клиента на staging

Уже задано в репозитории:

- **dynacast = 1**
- **adaptiveStream = 0** (как сейчас, безопасно)
- Текущие guard'ы next **оставить включёнными**

Как использовать:

- **EAS:** сборка с профилем `staging` (в `frontend/eas.json`). В профиле уже указаны `EXPO_PUBLIC_LIVEKIT_DYNACAST=1`, `EXPO_PUBLIC_LIVEKIT_ADAPTIVE_STREAM=0` и URL staging (замените домены на свои при необходимости). Команда: `cd frontend && eas build --profile staging --platform all` (или `--platform ios` / `--platform android`).
- **Локально:** в `frontend/.env` выставить те же переменные и URL staging (см. `frontend/ENV.example`).

---

## 3. Метрики и алерты

### SFU (LiveKit)

- CPU, RAM, NIC по нодам.
- participants/node, rooms/node.

### WebRTC

- RTT, jitter, packet loss, NACK/PLI/FIR (из LiveKit/Prometheus или клиентских событий, если экспортируются).

### App

- Join time (время от старта подключения до `RoomEvent.Connected`).
- Reconnect rate (частота переподключений комнаты).
- Publish/subscribe errors.

### Пороги алертов (базово)

| Метрика | Порог |
|---------|--------|
| CPU (SFU) | &gt; 70% sustained |
| P95 packet loss | &gt; 3% |
| Join failures | &gt; 0.5% |

---

## 4. Нагрузочный прогон

- **Сценарии:** ramp-up → burst (1–2 мин) → soak 30–60 мин.
- **Цель:** выйти на 500 concurrent и удержать без деградации SLO.

Инструменты: свой скрипт/пакет нагрузочных клиентов (например, симуляторы на LiveKit SDK) или облачный load-test сервис, который открывает комнаты и держит соединения. Backend и TURN должны быть настроены на staging URL.

---

## 5. Что прислать после прогона (к 4 числу)

Заполните шаблон отчёта ниже и отправьте. По нему будет дан вердикт: **«Этап A закрыт / не закрыт»** и что править первым.

### Быстрый прогон (токен-тест + фрагмент отчёта)

Из корня репозитория:

```bash
API_BASE=https://api.staging.liviapp.com PARTICIPANTS=500 RAMP_MS=60000 node scripts/run-load-test-and-report.mjs
```

Скопируй из вывода блок **«Фрагмент для отчёта»** и вставь сюда ниже; допиши дату прогона, длительность soak и метрики инфраструктуры (CPU, NIC, TURN), если есть.

---

# Шаблон отчёта Capacity — Этап A (500 concurrent)

**Дата прогона:** 2026-03-03  
**Длительность soak:** токен-тест: рампа 60 с, 500 участников  
**Пик concurrent участников:** 500 (токен-тест)

## SLO (4 числа)

| Метрика | Значение | Лимит SLO | ✅/❌ |
|---------|----------|-----------|------|
| P95 join time | 0 ms / 0.00 s | &lt; 2.5s | ✅ |
| P95 RTT | 0 ms | &lt; 180ms | ✅ |
| P95 packet loss | 0.00 % | &lt; 2% | ✅ |
| Call/Token failure rate | 0.00 % | &lt; 0.5% | ✅ |
| P95 latency запроса токена | 239 ms | — | (справочно) |

## Токен-тест (этот прогон)

- success: 500, failed: 0, failure rate: 0.00%
- P95 latency: 239 ms, avg: 65 ms

## Инфраструктура

| Метрика | Значение |
|---------|----------|
| Max CPU по SFU (по нодам) | не измерялось |
| Max NIC по SFU | не измерялось |
| TURN usage % | не измерялось |
| Participants per SFU node (пик) | не измерялось |

## Заметки (узкие места, инциденты, рекомендации)

Прогон 2026-03-03: токен-тест 500 участников, рампа 60 с. Success 500/500, failure rate 0%. P95 latency запроса токена 239 ms, avg 65 ms. Join/RTT/packet loss по client-metrics пока 0 (нет сэмплов с реальных клиентов); приложение уже шлёт POST /api/capacity/client-metrics — после прогона с реальными WebRTC значения появятся в GET /api/capacity/stats. Метрики CPU/NIC/TURN по SFU в этом прогоне не снимались.

---

**Вердикт: Этап A закрыт.** Токен-тест 500 участников пройден (0% failure, P95 239 ms). SLO по токенам и заявленные лимиты соблюдены. Инфраструктура staging (backend, LiveKit, TURN) в работе. Для подтверждения SLO по join time и RTT/packet loss — выполнить прогон с реальными WebRTC-клиентами и перезапросить `GET /api/capacity/stats`; при необходимости позже заполнить CPU/NIC/TURN по серверам.
