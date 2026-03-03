# Команды на сервере: nginx + SSL для staging (liviapp.com)

Выполняй по порядку **на сервере** (SSH: `ssh root@92.242.61.46`).

---

## 1. Посмотреть текущий nginx-конфиг

```bash
cat /etc/nginx/sites-enabled/livi
# или
ls -la /etc/nginx/sites-enabled/
cat /etc/nginx/sites-available/livi
```

Убедись, что в конфиге используется домен **liviapp.com** (не YOUR_DOMAIN.com). Если у тебя другой путь к конфигу — подставь его в команды ниже.

---

## 2. Добавить staging-блоки в конфиг

Либо скопировать обновлённый `nginx.conf` из репозитория на сервер (в нём уже есть блоки для `api.staging.YOUR_DOMAIN.com` и `livekit.staging.YOUR_DOMAIN.com`), либо вручную добавить в конец текущего конфига блоки из `nginx.conf` (секция «STAGING»).

**Важно:** в конфиге на сервере везде должно быть **liviapp.com**, а не YOUR_DOMAIN.com. Например:
- `server_name api.staging.liviapp.com;`
- `ssl_certificate /etc/letsencrypt/live/api.staging.liviapp.com/fullchain.pem;`
- и т.д. для livekit.staging.liviapp.com.

---

## 3. Выдать SSL-сертификаты для staging (Let's Encrypt)

Сначала nginx должен быть без ошибок (можно временно закомментировать staging server { } блоки, выдать серты, потом раскомментировать). Либо выдать серты до добавления staging-блоков:

```bash
sudo certbot certonly --nginx -d api.staging.liviapp.com -d livekit.staging.liviapp.com
```

Если certbot попросит выбрать домен — укажи оба или вызовы по одному:

```bash
sudo certbot certonly --nginx -d api.staging.liviapp.com
sudo certbot certonly --nginx -d livekit.staging.liviapp.com
```

---

## 4. Проверить конфиг и перезагрузить nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Если `nginx -t` выдал ошибку (например, нет сертификатов) — сначала выполни шаг 3, затем снова 4.

---

## 5. Проверка

В браузере или с другой машины:

```bash
curl -I https://api.staging.liviapp.com/health
curl -I https://livekit.staging.liviapp.com/
```

Ожидается ответ 200 или 301/302 без ошибки SSL.

---

## Итог

- **api.staging.liviapp.com** → прокси на `localhost:3000` (тот же backend, что и prod; для отдельного staging позже смени порт на 3001).
- **livekit.staging.liviapp.com** → прокси на `localhost:7880` (тот же LiveKit; для отдельного staging — на 7881).

В конфиге staging backend задай: `LIVEKIT_URL=wss://livekit.staging.liviapp.com`, `TURN_HOST=turn.staging.liviapp.com` (если используешь TURN по этому домену).
