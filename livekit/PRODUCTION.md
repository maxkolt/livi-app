# LiveKit в проде

Локально ты запускаешь LiveKit через `brew` (без Docker). В проде — на **Linux-сервере** через Docker (там нет зависаний).

---

## 1. Сервер LiveKit (отдельная машина или та же, где backend)

### livekit.yaml на проде

- **use_external_ip: true** — обязательно, иначе клиенты не достучатся до медиа.
- Диапазон UDP: **50000–60000** (полный, не 100 портов).

Скопируй `livekit.yaml` на сервер и поправь:

```yaml
port: 7880
log_level: info

rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true   # в проде обязательно true

keys:
  lk_XXXX: "твой_секрет"   # те же ключи, что в backend .env
```

### Docker на проде

В `docker-compose.yml` на сервере LiveKit раскомментируй/добавь UDP и запускай только нужные сервисы. Пример для **одного** сервера (backend + LiveKit + redis):

Сервис `livekit-sfu` на проде должен иметь порты:

```yaml
ports:
  - "127.0.0.1:7880:7880"
  - "127.0.0.1:7881:7881"
  - "127.0.0.1:50000-60000:50000-60000/udp"
```

И `livekit.yaml` на проде с `use_external_ip: true` и `port_range_end: 60000`.

Запуск: `docker compose up -d` (или только `livekit-sfu` на машине, где крутится только LiveKit).

---

## 2. Прокси (Nginx или Caddy)

Домен, например: **livekit.твойдомен.com** → порт **7880**.

**Caddy:**
```
livekit.твойдомен.com {
    reverse_proxy 127.0.0.1:7880
}
```

**Nginx** — в `location /` для этого сервера: `proxy_pass http://127.0.0.1:7880;` и заголовки WebSocket (`Upgrade`, `Connection`).

Перезагрузи конфиг и проверь: `curl -I https://livekit.твойдомен.com` (должен быть 101 или ответ от LiveKit).

---

## 3. Файрвол на сервере LiveKit

Открыты:

- **7880/tcp** — сигнал (если прокси на той же машине — только localhost).
- **7881/tcp** — WebRTC TCP fallback.
- **50000–60000/udp** — медиа; эти порты должны быть доступны **с интернета** (до сервера или до балансировщика, который пробрасывает UDP на этот хост).

---

## 4. Backend (.env на проде)

```env
LIVEKIT_URL=wss://livekit.твойдомен.com
LIVEKIT_API_KEY=lk_XXXX
LIVEKIT_API_SECRET=твой_секрет
```

Те же ключи, что в `livekit.yaml` на сервере LiveKit. Перезапусти backend после смены `.env`.

---

## 5. Приложение (сборка для прода)

В EAS / `.env` / `eas.json` для production-профиля:

```env
EXPO_PUBLIC_LIVEKIT_URL=wss://livekit.твойдомен.com
```

Пересобери приложение после смены переменной.

---

## 6. Проверка

1. **Токен:**  
   `POST https://api.твойдомен.com/api/livekit/token` с `userId`, `roomName` — в ответе `token` и `url: wss://livekit...`.
2. **Звонок:** два устройства в одной комнате — видео/аудио идут через LiveKit.

---

## Кратко

| Где            | Что сделать |
|----------------|-------------|
| **livekit.yaml на проде** | `use_external_ip: true`, `port_range_end: 60000` |
| **docker-compose на проде** | Публиковать UDP `50000-60000` для сервиса livekit-sfu |
| **Nginx/Caddy** | `livekit.домен` → `127.0.0.1:7880` |
| **Файрвол** | 7880, 7881 tcp; 50000–60000 udp |
| **Backend .env** | `LIVEKIT_URL=wss://livekit.домен`, те же ключи |
| **Приложение** | `EXPO_PUBLIC_LIVEKIT_URL=wss://livekit.домен` |
