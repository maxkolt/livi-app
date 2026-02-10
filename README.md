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

Теперь приложение поддерживает WebRTC и другие нативные модули, включая `react-native-webrtc`. Все функции видеочата будут работать как задумано. Нативный экран входящего видеозвонка (CallKeep/Telecom) тоже требует такого билда — в Expo Go и чистом Managed Workflow он недоступен (нужны iOS CallKit/PushKit и Android FCM + Telecom API).

### Нативный экран входящего звонка (Android) не показывается

1. **Бэкенд:** В логах при звонке ищи `[push] sendCallPushToRecipient` — должны быть `hasFirebase: true` и `androidTokensWithFcm: 1` (или больше). Если `hasFirebase: false` — задай на сервере `FIREBASE_SERVICE_ACCOUNT_JSON` (JSON ключа сервисного аккаунта Firebase) и перезапусти бэкенд. Если `androidTokensWithFcm: 0` — открой приложение на телефоне получателя, дождись успешной регистрации пуша (в логах приложения `token register response: ok: true`), затем проверь снова.
2. **Приложение получателя:** Должен быть установлен dev-билд (не Expo Go), с разрешением «Доступ к звонкам» (READ_PHONE_NUMBERS). При входящем звонке в фоне/убитом приложении в logcat должны появляться строки `LiviFCM: FCM onMessageReceived` и `[headless] RNCallKeepBackgroundMessage received`. Если их нет — пуш идёт через Expo (см. п. 1).

## TURN (важно для VPN/моб.сети/CGNAT)

Если в логах видишь `⚠️ NO TURN SERVER - NAT traversal may fail!`, это означает, что сервер не отдаёт TURN-кандидаты и часть пользователей может **не соединяться** в видеозвонке.

В проекте TURN-креды берутся с backend endpoint `GET /api/turn-credentials`.  
Инструкция и примеры конфигурации coturn лежат в `backend/turn/README.md`.
