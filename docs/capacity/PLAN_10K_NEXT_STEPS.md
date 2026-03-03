# План 10k concurrent — что делать дальше

Этап A (500 concurrent) закрыт. Ниже — следующие шаги по плану до 10k.

---

## Сделано

| Пункт плана | Статус |
|-------------|--------|
| Staging: 3 SFU + TURN + Redis | Частично: staging работает (backend, LiveKit, TURN). На сервере — 1 LiveKit; для формального DoD нужно 3 ноды за LB и managed Redis с REDIS_URL. |
| Токен-тест 500 concurrent | ✅ Пройден (500/500, P95 239 ms). |
| SLO и отчёт | ✅ Метрики в GET /api/capacity/stats, client-metrics с приложения, отчёт Stage A заполнен. |
| adaptiveStream / dynacast | В коде включены через env: `EXPO_PUBLIC_LIVEKIT_ADAPTIVE_STREAM`, dynacast по умолчанию ON в VideoCall. В RandomChat adaptiveStream выключен по умолчанию (стабильность). |
| Bitrate | Ограничения есть: 1.2 Mbps / 2.5 Mbps (high), FPS 30. Явной лестницы poor/mid/high по плану нет. |

---

## Что сделать дальше (по приоритету)

### 1. Этап B: 2 000 concurrent

- [ ] **Нагрузка:** прогнать токен-тест и/или реальные клиенты до 2k участников.
- [ ] **Chaos:** kill одной SFU-ноды, сетевой jitter/packet loss — проверить переподключение и перераспределение.
- [ ] **Autoscaling:** если используется K8s/автомасштабирование — проверить, что сессии переезжают и масштаб реагирует.

**Команды и чеклист:** [STAGE_B_2000_CONCURRENT.md](./STAGE_B_2000_CONCURRENT.md). Chaos (kill одной ноды): `./scripts/chaos-kill-one-sfu.sh`.

### 2. Инфраструктура под масштаб

- [ ] **3 SFU на staging:** развернуть за одним URL (nginx/Caddy upstream) или подтвердить конфиг (см. DOD_STAGING_INFRASTRUCTURE.md).
- [ ] **Managed Redis:** подключить Redis с failover, выставить REDIS_URL в backend/.env.staging.
- [ ] **TURN:** убедиться, что пул отдельный и при необходимости multi-AZ.

### 3. Bitrate-профили и адаптивность

- [ ] Ввести явные профили по плану: **poor** 300–500 kbps, **mid** 700–1200 kbps, **high** 1500–2500 kbps (только адаптивно).
- [ ] Привязать профили к типу сети (Wi‑Fi / cellular) и ограничить FPS 24/30.
- [ ] На staging включить `EXPO_PUBLIC_LIVEKIT_ADAPTIVE_STREAM=1` и прогнать тесты; при стабильности — оставить для масштаба.

### 4. Наблюдаемость

- [ ] **Дашборды:** SFU CPU/RAM/NIC, rooms/node, participants/node; RTT, jitter, packet loss; join time, reconnect rate.
- [ ] **Алерты:** по примеру `docs/capacity/prometheus-alerts.example.yml` (CPU > 70%, packet loss > 3%, join failures > 0.5%, reconnect spikes).
- [ ] **Логи/трассировка:** по callId/roomId для разбора инцидентов.

### 5. Capacity model

- [ ] После Stage B (2k) снять фактические метрики: **participants/node**, CPU/NIC на SFU, долю TURN.
- [ ] Заполнить [CAPACITY_CALCULATOR_10K.md](./CAPACITY_CALCULATOR_10K.md) и получить оценку числа нод на 10k.

### 6. Дальше по плану

- **Этап C:** 5k concurrent — пики, hot partitions, Redis failover.
- **Этап D:** 10k concurrent — full-scale soak 2–4 часа, SLO стабильно.

---

## Конкретно на эту неделю

1. Решить по инфра: 3 SFU на staging + managed Redis (и при необходимости обновить DOD).
2. Прогнать тест до 2k (токены и/или реальные клиенты) — **Stage B**.
3. Включить/проверить adaptiveStream на staging и зафиксировать bitrate-профили (хотя бы в коде/конфиге).
4. Поднять дашборды и алерты (хотя бы по примеру prometheus-alerts.example.yml).
5. По результатам Stage B заполнить capacity calculator и оценить число нод на 10k.

Подробный шаблон расчёта нод: [CAPACITY_CALCULATOR_10K.md](./CAPACITY_CALCULATOR_10K.md).
