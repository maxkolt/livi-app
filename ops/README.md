# Наблюдаемость LiVi (Prometheus → Alertmanager → почта)

Здесь только **внешний** стек: логика звонков, сокетов и приложения **не меняется**. На бэкенде достаточно переменной окружения и доступности `GET /metrics`.

## Что включить на бэкенде

1. В окружении сервера Node (тот же процесс, что обслуживает API):

   `CAPACITY_METRICS_ENABLED=1`

2. Убедиться, что с хоста, где крутится Prometheus, открывается HTTP-запрос к бэкенду:

   `http://<хост>:<порт>/metrics`

   Пока флаг не `1`, эндпоинт отвечает **404** (см. `backend/index.ts`).

3. Клиенты должны по-прежнему слать отчёты на `POST /api/capacity/client-metrics` (как в вашем фронте) — иначе часть gauge/counter в `/metrics` будет нулевой; алерты по токенам (`livi_token_errors_total`) всё равно работают с момента включения.

## Почта (Gmail) для алертов

1. Скопируйте шаблон: `./scripts/init.sh` или `cp alertmanager/alertmanager.yml.example alertmanager/alertmanager.yml`.
2. В Google-аккаунте включите **двухэтапную проверку** и создайте **пароль приложения** для почты; в **`alertmanager/alertmanager.yml`** подставьте его в **`PASTE_GMAIL_APP_PASSWORD`** (не обычный пароль от Gmail).
3. По умолчанию в шаблоне **`12345kolt@gmail.com`** и **`smtp.gmail.com:587`**; при необходимости измените **`to:`** и **`smtp_*`** в `global`.
4. `docker compose restart alertmanager`.

Файл `alertmanager.yml` с паролем **не коммитьте** (он в `.gitignore`).

## Первый запуск (Docker)

Из каталога `ops/`:

```sh
chmod +x scripts/init.sh
./scripts/init.sh
```

Отредактируйте `alertmanager/alertmanager.yml` (пароль приложения Gmail).

На **Linux VPS**, где Node на том же хосте, Prometheus в `docker-compose.yml` поднят с **`network_mode: host`**, в **`prometheus/prometheus.yml`** по умолчанию **`127.0.0.1:3000`** и Alertmanager **`127.0.0.1:9093`**. Если бэкенд на другой машине — уберите `network_mode: host` у Prometheus и задайте `targets` вручную. На **Docker Desktop (Mac)** `network_mode: host` указывает не на ваш Mac — для локальной разработки настройте `targets` под bridge (например `host.docker.internal:PORT`).

Запуск:

```sh
docker compose up -d
```

После смены сетевого режима Prometheus при необходимости: `docker compose down && docker compose up -d`.

- Prometheus UI: <http://localhost:9090>
- Alertmanager UI: <http://localhost:9093>
- Проверка таргета: в Prometheus → Status → Targets → `livi-backend` должен быть **UP**, иначе скрейп не доходит до `/metrics`.

Проверка почты: POST тестового алерта на `http://127.0.0.1:9093/api/v2/alerts` (см. ранее в переписке) — письмо должно прийти на адрес из `email_configs.to`.

## Продакшен

- Поднимайте те же образы на VM/Kubernetes; ограничьте доступ к `:9090`/`:9093` файрволом или VPN.
- Для HTTPS к бэкенду за reverse proxy настройте у job `scheme: https` и при необходимости `tls_config` в Prometheus.
- Метрики **сервера LiveKit** (CPU узла и т.д.) — отдельный `scrape_config` на URL метрик LiveKit; пример закомментирован в `prometheus/prometheus.yml`.

## Файлы

| Файл | Назначение |
|------|------------|
| `docker-compose.yml` | Prometheus + Alertmanager |
| `prometheus/prometheus.yml` | Скрейп `/metrics` бэкенда |
| `prometheus/rules/livi_backend.yml` | Правила алертов по `livi_*` |
| `alertmanager/alertmanager.yml.example` | Шаблон почты Gmail (SMTP 587) |
| `alertmanager/alertmanager.yml` | Локальная копия с паролем (**в .gitignore**) |
| `docker-compose.alertmanager-only.yml` | Только Alertmanager на отдельном VPS (см. «Два сервера») |

Алерты не появляются в UI приложения LiVi — только на почте (или в другом канале, если вы сами расширите `receivers`).

## Опционально: Telegram

Если с VPS **есть** исходящий доступ к `https://api.telegram.org/`, можно добавить второй `receiver` и ветку в `route` по `continue` / `match` — стандартная схема Alertmanager. У многих VPS в РФ до **api.telegram.org** бывает таймаут; тогда остаётся **прокси** или **отдельный хост** для доставки в Telegram.

Проверка исходящего доступа к Telegram:

```sh
chmod +x scripts/check-telegram-egress.sh
./scripts/check-telegram-egress.sh
```

## Два сервера: Prometheus на REG, Alertmanager за рубежом (пример)

Если с VPS бэкенда **нет** исходящего доступа к **Gmail/Telegram**, а на другом сервере (например **livi-turn** в Финляндии) **`curl` / `openssl` до SMTP и Telegram проходят**:

### A. Сервер с Alertmanager (**168.222.253.219** — замените при необходимости)

На Mac (пути подставьте свои):

```sh
scp -r /Users/maximkoltovich/LiVi/livi-app/ops/alertmanager \
      /Users/maximkoltovich/LiVi/livi-app/ops/docker-compose.alertmanager-only.yml \
      root@168.222.253.219:/opt/livi-ops/
```

По SSH на **168.222.253.219**:

```sh
cd /opt/livi-ops
mv docker-compose.alertmanager-only.yml docker-compose.yml
# если alertmanager.yml ещё нет:
cp alertmanager/alertmanager.yml.example alertmanager/alertmanager.yml
nano alertmanager/alertmanager.yml
# подставьте PASTE_GMAIL_APP_PASSWORD
```

Файрвол (только IP Prometheus, **92.242.61.46** — ваш REG-VPS):

```sh
apt-get update -y && apt-get install -y ufw
ufw allow OpenSSH
ufw allow from 92.242.61.46 to any port 9093 proto tcp comment 'Prometheus REG to Alertmanager'
ufw enable
```

Docker и запуск:

```sh
apt-get install -y docker.io docker-compose-v2
cd /opt/livi-ops && docker compose up -d
docker compose ps
```

Проверка с **REG-VPS** (`92.242.61.46`):

```sh
curl -sS -o /dev/null -w "%{http_code}\n" --connect-timeout 5 http://168.222.253.219:9093/-/healthy
```

Ожидается **200**.

### B. Сервер с Prometheus (**92.242.61.46**)

В **`/opt/livi-ops/prometheus/prometheus.yml`** в **`alerting.alertmanagers.static_configs.targets`** укажите внешний Alertmanager:

```sh
sed -i.bak "s/127.0.0.1:9093/168.222.253.219:9093/g" /opt/livi-ops/prometheus/prometheus.yml
grep targets /opt/livi-ops/prometheus/prometheus.yml
cd /opt/livi-ops && docker compose stop alertmanager
docker compose restart prometheus
```

Локальный **Alertmanager на REG** остановлен, чтобы не путаться; Prometheus с **`network_mode: host`** шлёт алерты на **168.222.253.219:9093**.

Проверка почты: с **livi-turn** или с любой машины, где доступен Alertmanager:

```sh
curl -sS -X POST http://168.222.253.219:9093/api/v2/alerts \
  -H 'Content-Type: application/json' \
  -d '[{"labels":{"alertname":"RemoteTest","severity":"warning"},"annotations":{"summary":"Тест удалённого AM"}}]'
```
