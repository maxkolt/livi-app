# Запуск без Docker Desktop

Backend и фронт можно разрабатывать и запускать без Docker.

---

## Backend на ноутбуке

**1. Установить Node.js 20** (если ещё нет):  
https://nodejs.org или `brew install node@20`

**2. Перейти в каталог backend и поставить зависимости:**
```bash
cd /Users/maximkoltovich/LiVi/livi-app/backend
npm install
```

**3. Файл `.env`**  
Используется `backend/.env`. Должны быть заданы минимум:
- `MONGO_URI` — строка подключения к MongoDB (облако или локальная)
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — можно от прод/staging сервера
- `TURN_HOST`, `TURN_SECRET` — по желанию (без них TURN в креденшалах не будет)

Redis не обязателен: если `REDIS_URL` не задан, backend работает с in-memory хранилищем (удобно для локальной разработки).

**4. Запуск в режиме разработки:**
```bash
cd /Users/maximkoltovich/LiVi/livi-app/backend
npm run dev
```

Backend будет доступен на **http://localhost:3000**. Проверка: `curl http://localhost:3000/health`.

---

## Фронт (приложение)

- **Вариант A:** Приложение уже ходит на **сервер** (api.staging.liviapp.com) — ничего локально поднимать не нужно, просто правите код и деплоите бэкенд на сервер.
- **Вариант B:** Локальный бэкенд — в настройках приложения или в `frontend/.env` укажите API на `http://ВАШ_IP:3000` (для телефона в той же сети — IP ноутбука, для эмулятора часто `http://localhost:3000` или `http://10.0.2.2:3000` на Android).

Expo/React Native запуск как обычно:
```bash
cd /Users/maximkoltovich/LiVi/livi-app/frontend
npm install
npx expo start
```

---

## Redis локально (по желанию)

Если нужен Redis без Docker:

```bash
brew install redis
brew services start redis
```

В `backend/.env` добавить: `REDIS_URL=redis://127.0.0.1:6379` и перезапустить `npm run dev`.

---

## Итого без Docker

| Что        | Как |
|-----------|-----|
| Backend   | `cd backend && npm run dev` (порт 3000) |
| MongoDB   | Облачный (Mongo Atlas) или локальный установленный |
| Redis     | Не обязателен; при необходимости: `brew install redis` + `REDIS_URL=redis://127.0.0.1:6379` |
| LiveKit   | Использовать ваш сервер (livekit.staging.liviapp.com) |
| Фронт     | `cd frontend && npx expo start`; API в настройках — сервер или localhost |

Docker Desktop для этого не нужен.
