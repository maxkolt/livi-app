# Отдельный staging: что делать и где

Отдельный staging — это **отдельные инстансы** backend/SFU/TURN/Redis и **отдельные URL** (api.staging.*, livekit.staging.*). Ниже — где что делается: терминал, DNS, облако.

**Формальный DoD (Definition of Done):** 3 SFU, TURN pool (отдельно от SFU, multi-AZ), managed Redis — чеклист и подтверждение: [DOD_STAGING_INFRASTRUCTURE.md](./DOD_STAGING_INFRASTRUCTURE.md).

---

## 1. Где у тебя сейчас крутится prod?

- **Если prod на своих серверах (VPS/VM):** staging можно поднять на **других** серверах (или на том же хосте в других контейнерах с другими портами).
- **Если prod в облаке (K8s, ECS, etc.):** staging — отдельный namespace / отдельный кластер / отдельный stack с теми же сервисами.

Итого: **staging = отдельные машины/контейнеры/namespace**, не те же, что prod.

---

## 2. DNS (не в терминале — в панели DNS-провайдера)

Нужны два имени, которые указывают на твой staging:

| Запись | Куда ведёт |
|--------|------------|
| `api.staging.liviapp.com` | IP или CNAME твоего **staging backend** (или балансировщика перед ним) |
| `livekit.staging.liviapp.com` | IP или CNAME твоего **staging SFU** (LiveKit) |

**Где делать:** панель того, у кого куплен домен (Cloudflare, Route53, reg.ru и т.д.) — добавить A- или CNAME-записи для этих имён.

Без этого приложение и нагрузочные скрипты не смогут ходить на staging по «нормальным» URL.

---

## 3. Терминал / деплой

Зависит от того, **как** ты поднимаешь сервисы.

### Вариант A: Один сервер (VPS), Docker

- На **отдельной** машине (или отдельном VPS для staging):
  1. Клонировать/скопировать проект, перейти в корень репо.
  2. Создать конфиги (см. п. 4).
  3. В терминале на этом сервере:
     ```bash
     docker compose -f docker-compose.staging.yml up -d
     ```
  4. Убедиться, что порты 3000 (backend), 7880/7881 (LiveKit), 6379 (Redis) либо открыты снаружи, либо за reverse proxy. В DNS (п. 2) указать этот сервер (или proxy перед ним).

### Вариант B: Облако (K8s, ECS, Terraform)

- Создать **отдельный** namespace / stack для staging.
- Задеплоить туда backend, LiveKit (3 ноды для Stage A), TURN, Redis (managed Redis лучше поднять через облако и подставить `REDIS_URL`).
- В терминале обычно что-то вроде:
  - `kubectl apply -f k8s/staging/`
  - или `terraform apply -var env=staging`
  - или через CI/CD (отдельный job «deploy staging»).

Точные команды зависят от твоего способа деплоя; главное — деплой идёт **в staging-контур**, не в prod.

### Вариант C: Только проверить локально

- В терминале в корне проекта:
  ```bash
  docker compose -f docker-compose.staging.yml up
  ```
- Это поднимет staging **локально** (backend на 3000, LiveKit на 7880). URL будут `http://localhost:3000` и `ws://localhost:7880`, а не api.staging.* / livekit.staging.*. Для теста Stage A с 500 concurrent этого обычно мало — нужен реальный сервер/облако и DNS из п. 2.

---

## 4. Конфиги (файлы, не только терминал)

- **Backend staging:** создать `backend/.env.staging` с переменными для **staging** (отдельная MongoDB, отдельный LiveKit, отдельный TURN, Redis):
  - `MONGO_URI`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `TURN_HOST`, `TURN_SECRET`, `TURN_PORT`, `REDIS_URL`
- **LiveKit staging:** конфиг, например `livekit/livekit.staging.yaml`, и `.env.staging` с ключами для staging (в `docker-compose.staging.yml` уже указаны `livekit/.env.staging` и `livekit/livekit.staging.yaml`).

После деплоя backend должен слушать запросы по тому адресу, который ты указал в DNS для `api.staging.liviapp.com`, а LiveKit — для `livekit.staging.liviapp.com`.

---

## 5. Краткий порядок действий

1. **DNS:** в панели домена добавить `api.staging.liviapp.com` и `livekit.staging.liviapp.com` на твой staging backend и SFU.
2. **Конфиги:** подготовить `backend/.env.staging` и конфиг LiveKit для staging (и при необходимости TURN).
3. **Терминал/деплой:** поднять сервисы staging (например `docker compose -f docker-compose.staging.yml up -d` на staging-сервере или через K8s/Terraform/CI).
4. **Проверка:** в браузере или `curl`: `https://api.staging.liviapp.com/health` и что приложение подключается к `wss://livekit.staging.liviapp.com`.

Если напишешь, где у тебя сейчас prod (одна VM, K8s, что-то ещё), можно сузить до «конкретно эти 2–3 команды и эти 2 файла».
