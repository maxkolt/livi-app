# Expo Dev Client + Metro (Android, без вечных AAB)

Этот проект уже настроен под Expo Dev Client (`expo-dev-client`) и имеет удобные скрипты в `frontend/package.json`.

## 1) Один раз ставим Dev Client на устройство

Вариант A (локально через Android SDK, без EAS):
- Подключите Android по USB, включите **USB debugging**
- В папке `frontend/`:

```bash
npm run android:dev
```

Это соберёт и установит **dev build** на устройство. Дальше вы больше не обязаны собирать/заливать AAB ради правок JS/TS — всё будет обновляться через Metro.

### Почему `android:dev`, а не `android`
Если на телефоне уже стоит прод‑версия из Play Store (`com.kolt12max.livi`), то debug/dev-client с другой подписью не сможет установиться поверх неё и вы увидите ошибку вида:
`INSTALL_FAILED_UPDATE_INCOMPATIBLE: ... signatures do not match ...`

`android:dev` ставит dev‑клиент **рядом**, с отдельным package id `com.kolt12max.livi.dev`.

Вариант B (если хотите поставить dev build на несколько девайсов без локальной сборки):
- Соберите development build через EAS и поставьте APK один раз
- Далее подключайтесь к Metro (см. ниже)

## 2) Запуск Metro/Expo и подключение Android

### Способ 1 (рекомендую): LAN (девайсы в той же Wi‑Fi сети)

В `frontend/`:

```bash
npm run start:lan
```

Далее на телефоне откройте **ваш Dev Client** и отсканируйте QR/откройте development server из списка.

Если LAN вдруг не работает:
- проверьте, что телефон и Mac в одной Wi‑Fi сети
- macOS firewall должен разрешать входящие на порт `8081`

### Способ 2: USB (самый стабильный)

Подключите телефон по USB, затем в `frontend/`:

```bash
npm run start:usb
```

Этот режим делает `adb reverse tcp:8081 tcp:8081`, и Dev Client подключается к `localhost`.

### Способ 3: Tunnel (когда сети разные/сложные)

В `frontend/`:

```bash
npm run start:tunnel
```

## 3) Где смотреть логи

- **JS логи (`console.log`)**: в терминале, где запущен `expo start` (Metro), и в DevTools/inspector.
- **Нативные логи**: при необходимости

```bash
adb logcat
```

## 4) Быстрые подсказки

- Почистить кэш Metro:

```bash
npm run start:lan:clean
```

или

```bash
npm run start:usb:clean
```

