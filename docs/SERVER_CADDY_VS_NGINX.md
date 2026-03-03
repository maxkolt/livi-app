# Сервер: Caddy занял 80/443, nginx не стартует

Если на сервере порты 80 и 443 слушает **Caddy**, а не nginx, то nginx падает с ошибкой:
`bind() to 0.0.0.0:80 failed (98: Address already in use)`.

**Вариант A: Оставить Caddy, настроить прокси для LiVi**

Нужно, чтобы Caddy проксировал:
- `api.liviapp.com` / `api.staging.liviapp.com` → `http://127.0.0.1:3000`
- `livekit.liviapp.com` / `livekit.staging.liviapp.com` → `http://127.0.0.1:7880`

Пример Caddyfile (дополнить или создать, обычно `/etc/caddy/Caddyfile`):

```
api.staging.liviapp.com {
    reverse_proxy 127.0.0.1:3000
}

livekit.staging.liviapp.com {
    reverse_proxy 127.0.0.1:7880
}
```

Для WebSocket и upload часто хватает стандартного reverse_proxy; при необходимости добавьте header Upgrades.

После правок:
```bash
sudo systemctl reload caddy
# или
caddy reload --config /etc/caddy/Caddyfile
```

**Вариант B: Использовать nginx вместо Caddy**

Тогда нужно освободить 80/443 и отключить Caddy:

```bash
sudo systemctl stop caddy
sudo systemctl disable caddy
sudo systemctl start nginx
sudo systemctl enable nginx
```

Проверка: `curl -s -o /dev/null -w "%{http_code}" https://api.staging.liviapp.com/health`
