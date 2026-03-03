# Нагрузочное тестирование (Stage A — 500 concurrent)

## Что от тебя требуется (кратко)

1. **Запустить нагрузочный тест** (с твоего компьютера, staging должен быть доступен):
   ```bash
   cd <корень репозитория livi-app>
   API_BASE=https://api.staging.liviapp.com PARTICIPANTS=500 RAMP_MS=60000 node scripts/run-load-test-and-report.mjs
   ```
2. **Скопировать вывод** блока «Фрагмент для отчёта» из консоли.
3. **Вставить** в `docs/capacity/STAGE_A_500_CONCURRENT.md` в секцию «Шаблон отчёта Capacity», заполнить дату и длительность soak.
4. **Дописать метрики инфраструктуры** (CPU/NIC/TURN по нодам SFU), если есть доступ к серверам или дашборду.
5. Отправить отчёт (вердикт: Этап A закрыт / не закрыт).

---

## 1. Тест токенов (backend)

Нагрузка на выдачу токенов без реальных WebRTC-соединений:

```bash
API_BASE=https://api.staging.liviapp.com PARTICIPANTS=500 RAMP_MS=60000 node scripts/load-test-tokens.mjs
```

Либо **тест + сбор метрик + фрагмент отчёта** одним скриптом:

```bash
API_BASE=https://api.staging.liviapp.com PARTICIPANTS=500 RAMP_MS=60000 node scripts/run-load-test-and-report.mjs
```

- `PARTICIPANTS` — число запросов токенов (по умолчанию 500).
- `RAMP_MS` — время рампы в мс (по умолчанию 60 с).
- `CONCURRENCY` — параллельных запросов в батче (по умолчанию 25).

Скрипт выводит success/failed, failure rate, P95 и среднюю задержку запроса токена.

## 2. Полная нагрузка на SFU (500 WebRTC-клиентов)

Чтобы нагрузить именно SFU (LiveKit) и TURN, нужны реальные подключения к комнатам:

- **Вариант A:** 500 реальных устройств с приложением (staging build), сценарий: вход в random/friend call и удержание 30–60 мин.
- **Вариант B:** Инструменты вроде [LiveKit Load Tester](https://github.com/livekit/load-tester) или свой скрипт на `livekit-client` с поддержкой WebRTC в среде (браузер/Playwright).
- **Вариант C:** Несколько инстансов скрипта по 50–100 участников на инстанс (каждый инстанс — отдельный процесс/машина).

Токены для нагрузочных клиентов можно получать так же через `POST /api/livekit/token` с `userId`/`roomName` вида `loadtest_<n>` (для таких комнат проверка участника в backend пропускается).

## 3. Метрики после прогона

- **Сразу после скрипта:** `run-load-test-and-report.mjs` сам запрашивает `GET /api/capacity/stats` и выводит фрагмент отчёта.
- **Вручную:** `curl -s https://api.staging.liviapp.com/api/capacity/stats` — JSON с P95 join time, RTT, packet loss, token/join failure rate.
- Prometheus: скрейпить `GET /metrics` с backend и SFU (LiveKit).
- Отчёт: вставить сгенерированный фрагмент в `docs/capacity/STAGE_A_500_CONCURRENT.md` (секция «Шаблон отчёта Capacity»), дописать дату, soak, CPU/NIC/TURN.
