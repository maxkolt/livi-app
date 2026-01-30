# My Video Chat App

# Разработка

1. Установи EAS CLI, если ещё нет:
```bash
npm install -g eas-cli
```

2. Инициализируй EAS в проекте:
```bash
eas init
```

3. Собери девелоперский билд:
```bash
eas build --profile development --platform android
```
или
```bash
eas build --profile development --platform ios
```

4. Установи билд на телефон (QR-код или напрямую).

5. Запусти Metro-сервер:
```bash
npx expo start --dev-client
```

Теперь приложение поддерживает WebRTC и другие нативные модули, включая `react-native-webrtc`. Все функции видеочата будут работать как задумано.

## TURN (важно для VPN/моб.сети/CGNAT)

Если в логах видишь `⚠️ NO TURN SERVER - NAT traversal may fail!`, это означает, что сервер не отдаёт TURN-кандидаты и часть пользователей может **не соединяться** в видеозвонке.

В проекте TURN-креды берутся с backend endpoint `GET /api/turn-credentials`.  
Инструкция и примеры конфигурации coturn лежат в `backend/turn/README.md`.
