# Чеклист закрытия этапа A (500 concurrent)

Используй этот чеклист, чтобы полностью завершить этап A: инфраструктура, нагрузочный тест, SLO и отчёт.

---

## 1. Инфраструктура staging

- [ ] **3 SFU (LiveKit)** развёрнуты за одним URL (nginx/Caddy upstream на порт 7880).
  - Локально: `docker-compose.staging.yml` (livekit1/2/3 + nginx-livekit).
  - На сервере: развернуть 3 ноды или подтвердить конфиг (см. `docs/capacity/nginx-livekit-3node.conf`, `STAGING_DEPLOY_RUNBOOK.md`).
- [ ] **TURN** настроен отдельно от SFU (отдельный сервер/пул, multi-AZ по требованию).
  - Локально: coturn в compose. На сервере: `turn.liviapp.com` (уже используется).
- [ ] **Managed Redis** с failover подключён к staging backend.
  - В `backend/.env` (staging): `REDIS_URL=...` указывает на managed Redis.
  - Очередь/состояние используют Redis (см. `queueStoreRedis.ts`).
- [ ] **DoD staging**: см. `docs/capacity/DOD_STAGING_INFRASTRUCTURE.md`.

**Как проверить:** health backend 200, Redis connected (логи), получение токена и вход в комнату LiveKit работают.

---

## 2. Нагрузочный тест (soak 30–60 мин, 500 concurrent WebRTC)

- [ ] Запустить **токен-тест** (рампа 500 участников, опционально 60 мин soak):
  ```bash
  API_BASE=https://api.staging.liviapp.com PARTICIPANTS=500 RAMP_MS=60000 node scripts/run-load-test-and-report.mjs
  ```
- [ ] Для **реальных WebRTC** метрик: использовать реальных клиентов (приложение с включённой отправкой client-metrics) или симулятор, который джойнится в комнаты и держит 500 участников 30–60 мин.
  - Приложение уже шлёт `POST /api/capacity/client-metrics` при успешном/неуспешном подключении к комнате (joinTimeMs, joinSuccess, joinFailure).
- [ ] После прогона запросить агрегат: `GET /api/capacity/stats` (или скрипт ниже).

**Фрагмент отчёта по stats (без повторного токен-теста):**
```bash
API_BASE=https://api.staging.liviapp.com node scripts/stage-a-report-fragment.mjs
```

---

## 3. SLO (4 числа)

| Метрика              | Лимит SLO | Где взять значение                          |
|----------------------|-----------|---------------------------------------------|
| P95 join time        | < 2.5 s  | `GET /api/capacity/stats` → `joinTimeMs.p95` |
| P95 RTT              | < 180 ms | `GET /api/capacity/stats` → `rttMs.p95`      |
| P95 packet loss      | < 2 %    | `GET /api/capacity/stats` → `packetLoss.p95`|
| Call/join failure rate | < 0.5 % | `GET /api/capacity/stats` → `joinFailureRate` |

- [ ] Все четыре показателя укладываются в лимиты (или зафиксировать исключения в отчёте).

---

## 4. Отчёт

- [ ] Заполнить шаблон в `docs/capacity/STAGE_A_500_CONCURRENT.md`:
  - Дата прогона, длительность soak, пик concurrent.
  - Таблица SLO (4 числа + ✅/❌).
  - Инфраструктура: max CPU по SFU (по нодам), max NIC, TURN usage %, participants per SFU node.
  - Заметки (узкие места, инциденты, рекомендации).
- [ ] Вердикт: **«Этап A закрыт»** или **«Этап A не закрыт»** + что править первым.

---

## Быстрые команды

```bash
# Токен-тест + фрагмент отчёта
API_BASE=https://api.staging.liviapp.com PARTICIPANTS=500 RAMP_MS=60000 node scripts/run-load-test-and-report.mjs

# Только фрагмент отчёта по текущим /api/capacity/stats (после soak с реальными клиентами)
API_BASE=https://api.staging.liviapp.com node scripts/stage-a-report-fragment.mjs
```
