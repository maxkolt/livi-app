# Чеклист: backend на сервере не грузится / не работает

Проверки по SSH. Подставьте свой домен и путь к backend.

---

## Порты (что должно слушаться)

| Порт | Кто слушает | Зачем |
|------|-------------|--------|
| **3000** | Backend (Node) | API, Socket.IO, health. Nginx проксирует сюда с 443. |
| **7880** | LiveKit | WebRTC SFU. Nginx проксирует сюда с 443 для livekit.* |
| **80** | nginx | HTTP → редирект на HTTPS (или прокси до получения SSL). |
| **443** | nginx | HTTPS → proxy_pass на 3000 (api) и 7880 (livekit). |

Если backend «не грузит» — чаще всего либо **3000 не слушается**, либо **nginx не проксирует** на 3000, либо **80/443 закрыты** файрволом.

---

## 1. Backend слушает 3000?

На сервере:

```bash
# Кто слушает 3000
ss -tlnp | grep 3000
# или
netstat -tlnp | grep 3000
```

Если пусто — процесс backend не запущен или упал.

- **systemd:**  
  `systemctl status livi-backend`  
  При необходимости: `systemctl restart livi-backend`  
  Логи: `journalctl -u livi-backend -n 100 --no-pager`
- **Вручную:** из каталога backend: `node dist/index.js` (или `npm start`). В `.env` не должно быть `PORT=...` с другим портом, иначе nginx не совпадёт с реальным портом.

Проверка с самого сервера:

```bash
curl -s http://127.0.0.1:3000/health
```

Должен вернуться JSON с `ok` или статусом. Если тут не отвечает — чинить сначала backend (MongoDB, .env, логи).

---

## 2. Nginx запущен и конфиг без ошибок?

```bash
systemctl status nginx
nginx -t
```

Если `nginx -t` ругается — править конфиг (часто путь типа `/etc/nginx/sites-enabled/livi` или `sites-available/livi`). После правок: `systemctl reload nginx`.

---

## 3. Nginx проксирует на 3000 и 7880

В конфиге для **api** (api.liviapp.com или api.staging.liviapp.com) должно быть:

- `proxy_pass http://localhost:3000;` (или `http://127.0.0.1:3000;`) в `location /` и в `location /socket.io/`.

Для **livekit** (livekit.*):

- `proxy_pass http://localhost:7880;` в `location /`.

Если у вас backend на другом порту (например 3001) — везде заменить 3000 на этот порт и перезапустить backend так, чтобы он реально слушал этот порт.

Проверка с сервера после запуска nginx:

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/health
curl -s -H "Host: api.staging.liviapp.com" http://127.0.0.1/health
```

Второй запрос идёт через nginx (порт 80); если для api настроен редирект на HTTPS, тогда проверять уже `https://api.staging.liviapp.com/health` с хоста (см. п. 5).

---

## 4. Файрвол: 80 и 443 открыты

На сервере:

```bash
# ufw
sudo ufw status
sudo ufw allow 80
sudo ufw allow 443
sudo ufw reload

# или iptables — порты 80, 443 должны быть ACCEPT
```

В облаке (AWS/GCP и т.д.) — в security group / firewall правила: входящие 80 и 443 с 0.0.0.0/0 (или нужных IP).

---

## 5. DNS и SSL

- В DNS для сервера: **api.staging.liviapp.com** и **livekit.staging.liviapp.com** должны указывать на **IP этого сервера** (A-запись или CNAME).
- SSL: для `api.staging.*` и `livekit.staging.*` в nginx должны быть указаны реальные пути к сертификатам (Let's Encrypt и т.д.), и конфиг должен быть загружен без ошибок (`nginx -t`).

Проверка с вашего компьютера:

```bash
curl -s -o /dev/null -w "%{http_code}" https://api.staging.liviapp.com/health
```

Код 200 или 301 — обычно норма; 502/503 — смотреть логи nginx и что backend на 3000 отвечает.

---

## 6. Скрипт диагностики

В репозитории есть скрипт, который проверяет порты, nginx, systemd и локальный /health:

```bash
# На сервере (скопировать скрипт и запустить)
cd /path/to/livi-app
bash scripts/server-check.sh
```

Если backend в другом каталоге:

```bash
BACKEND_DIR=/opt/backend/backend bash scripts/server-check.sh
```

По выводу будет видно: слушается ли 3000/7880, активен ли nginx, отвечает ли /health.

---

## Кратко: «ничего не грузит»

1. **Backend:** `systemctl restart livi-backend`, проверить `curl http://127.0.0.1:3000/health` и логи `journalctl -u livi-backend -f`.
2. **Nginx:** `nginx -t`, `systemctl reload nginx`, в конфиге `proxy_pass http://localhost:3000` для api.
3. **Порты:** 80 и 443 открыты в firewall и в панели облака.
4. **DNS:** api.* и livekit.* указывают на IP сервера.
5. **SSL:** сертификаты есть и указаны в nginx, `nginx -t` без ошибок.

После этого снаружи должен открываться `https://api.staging.liviapp.com` (и приложение — подключаться к API и LiveKit).
