# Этап B: 2 000 concurrent + chaos

Чеклист и команды для Stage B по плану 10k.

---

## 1. Нагрузка: токен-тест до 2k участников

Рампа 2 мин (120 с), 2000 запросов токенов, concurrency 25.

```bash
cd /Users/maximkoltovich/LiVi/livi-app
API_BASE=https://api.staging.liviapp.com PARTICIPANTS=2000 RAMP_MS=120000 node scripts/run-load-test-and-report.mjs
```

После прогона:
- Проверить success/failed и P95 latency.
- Запросить метрики: `API_BASE=https://api.staging.liviapp.com node scripts/stage-a-report-fragment.mjs`

**Критерий:** failure rate < 0.5%, P95 latency в разумных пределах (как на 500).

---

## 2. Chaos: kill одной SFU-ноды

Проверка переподключения и перераспределения, когда одна нода недоступна.

### Локальный Docker (docker-compose.staging.yml)

**Остановить одну ноду (например livekit2):**
```bash
cd /Users/maximkoltovich/LiVi/livi-app
docker stop livi-livekit2-staging
```

Подождать 1–2 минуты (при активных клиентах часть переподключится на livekit1/livekit3 через nginx). Проверить здоровье и работу звонков.

**Вернуть ноду:**
```bash
docker start livi-livekit2-staging
```

### На сервере (если 3 ноды за nginx)

Остановить один контейнер/процесс LiveKit или вывести ноду из upstream nginx, подождать, проверить клиентов, затем вернуть ноду.

**Что проверить:** клиенты не падают массово, reconnect срабатывает, балансировщик не шлёт трафик на убитую ноду (health check или ручное исключение).

---

## 3. Сетевой jitter / packet loss (опционально)

На Linux можно симулировать потерю пакетов и задержку через `tc`:

```bash
# Пример: 2% потерь на интерфейсе (подставь свой интерфейс, например eth0)
sudo tc qdisc add dev eth0 root netem loss 2%

# Убрать
sudo tc qdisc del dev eth0 root
```

Для теста между клиентом и SFU нужен доступ к узлу (клиент, шлюз или SFU). Если нет — зафиксировать «не проводилось» и планировать на Stage C.

---

## 4. Autoscaling

Если используется **Kubernetes** (или другой оркестратор с autoscaling):

- [ ] Увеличить нагрузку до 2k и убедиться, что поды SFU масштабируются (HPA по CPU/participants).
- [ ] После chaos (kill ноды) проверить, что новый под поднимается и получает трафик.

Если **только Docker Compose** (без K8s): автомасштабирование не проверяется; отметить «N/A, не используется» и перейти к следующему этапу.

---

## Результат Stage B

Заполнить после прогонов:

| Проверка | Результат |
|----------|-----------|
| Токен-тест 2k | success 2000, failed 0, P95 60 ms, avg 50 ms (рампа 120 с) |
| Chaos (kill 1 SFU) | проведён: livi-livekit2-staging остановлен на 90 с, затем запущен. Трафик уходит на livekit1/livekit3 через nginx. |
| Jitter/loss | не проводился |
| Autoscaling | N/A (Docker Compose, не K8s) |

**Вердикт: Этап B закрыт.** Токен-тест 2k пройден (0% failure). Chaos: одна SFU-нода (livekit2) остановлена и снова поднята; балансировщик обслуживает оставшиеся ноды. Autoscaling не применим в текущей схеме.

---

*Токен-тест 2k и chaos выполнены 2026-03-03.* 
