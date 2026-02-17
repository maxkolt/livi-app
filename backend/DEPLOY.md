# Деплой бэкенда на сервер

## Почему «ничего не меняется» после git pull

Сервис запускает **скомпилированный** `dist/index.js`, а не исходники. Без **сборки** после pull в `dist/` остаётся старый код — изменения в TypeScript не применяются.

**Обязательно после каждого `git pull` выполнять сборку в backend.**

---

## Команды деплоя

Если на сервере в `/opt/backend` лежит полный репозиторий (livi-app):

```bash
cd /opt/backend
git pull origin main
cd backend && npm run build
systemctl restart livi-backend
```

Одной строкой:

```bash
cd /opt/backend && git pull origin main && cd backend && npm run build && systemctl restart livi-backend
```

Если в `/opt/backend` только папка backend (свой `package.json` с `"build": "tsc"`):

```bash
cd /opt/backend && git pull origin main && npm run build && systemctl restart livi-backend
```

---

## Проверка, что поднялась новая версия

При старте в логах должна появиться строка:

```
[backend] push v2: missed=call_ended only, call_canceled Expo=iOS only — deploy built OK
```

Если этой строки нет — сборка не выполнялась или сервис запускает старый процесс.

```bash
journalctl -u livi-backend -n 30
```

После отмены/таймаута звонка в логах должно быть `v2: call_ended only` и не должно быть `sendPushToUser: sending ... kind: call` по каллею:

```bash
journalctl -u livi-backend -n 100 | grep -E "v2|sendPushToUser|missed"
```
