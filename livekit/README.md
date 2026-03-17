# LiveKit (локально на Mac без Docker)

На macOS Docker Desktop часто зависает при запуске/остановке контейнера LiveKit. Для локальной разработки удобнее запускать LiveKit **напрямую**, без Docker.

## Установка (один раз)

```bash
brew install livekit
```

## Запуск

Из корня проекта:

```bash
livekit-server --config "$(pwd)/livekit/livekit.yaml"
```

Или из папки `livekit`:

```bash
cd livekit
livekit-server --config livekit.yaml
```

Сервер слушает **7880** (WS) и **7881** (TCP). Остановка: **Ctrl+C**.

## Проверка

- Backend и приложение подключаются к `ws://127.0.0.1:7880` или `wss://...` (если настроен прокси).
- В `backend/.env` и в приложении для локальной разработки укажи `LIVEKIT_URL=ws://127.0.0.1:7880` (или оставь тот URL, который отдаёт backend).

## Прод (сервер)

На Linux-сервере используй Docker и `docker-compose.yml` — там контейнер LiveKit работает нормально. В `livekit.yaml` на проде включи `use_external_ip: true` и верни диапазон UDP 50000–60000 в compose.
