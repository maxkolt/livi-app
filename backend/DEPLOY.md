# Деплой бэкенда на сервер

Если сервер — полный клон репозитория (livi-app) в `/opt/backend`:

```bash
cd /opt/backend
git pull origin main
cd backend && npm run build
systemctl restart livi-backend
```

Если на сервере в `/opt/backend` лежит только папка backend (и там есть `package.json` с `"build": "tsc"`):

```bash
cd /opt/backend
git pull origin main
npm run build
systemctl restart livi-backend
```

Проверка после рестарта: при отмене/таймауте звонка в логах должно быть `v2: call_ended only` и не должно быть `sendPushToUser: sending ... kind: call` по каллею.

```bash
journalctl -u livi-backend -n 100 | grep -E "v2|sendPushToUser|missed"
```
