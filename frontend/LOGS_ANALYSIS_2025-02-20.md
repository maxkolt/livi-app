# Анализ логов LiVi за 20.02.2025

## Критические проблемы (влияют на звонки и уведомления)

### 1. **Background Activity Launch (BAL) — экран входящего звонка не показывается**

**Суть:** Android блокирует запуск `IncomingCallActivity`, когда приложение в фоне.

- **Время:** 16:31:48 (при получении FCM push о звонке) и 16:32:25 (при таймауте 20 с).
- **Ошибка:** `ActivityTaskManager: Background activity launch blocked! ... (BAL_BLOCK) result code=102`
- **Intent:** `cmp=com.kolt12max.livi/.IncomingCallActivity`
- **Причина:** На Android 14+ (targetSdk 35) приложение не может из фона/сервиса поднимать Activity без разрешения (BAL). FCM приходит, приложение в фоне → система блокирует показ полноэкранного экрана входящего вызова.
- **Что видно в логах:** FCM push получен (`LiviFCM: FCM onMessageReceived type=call`), код пытается запустить `IncomingCallActivity` и `IncomingCallForegroundService`. FGS разрешён (`Background started FGS: Allowed`), но **запуск Activity блокируется** (result code=102). В итоге показывается только уведомление в шторке (full-screen intent запрошен, но FSI_REQUESTED_BUT_DENIED в notification), а не полноэкранный экран. Через 20 с срабатывает таймаут: `IncomingCallForegroundService: timeout 20s, closing native screen and stopping`.

**Рекомендация:** Использовать разрешение на запуск из фона для входящих звонков (например, через full-screen intent с правильными флагами и/или использование [BAL exemptions для звонков](https://developer.android.com/about/versions/14/changes/fgs-types-required#full-screen-intent)), либо поднимать приложение через системный звонок (ConnectionService/Telecom), а не только через свою Activity.

---

### 2. **Ограничение доступа у Foreground Service при старте из фона**

- **Время:** 16:31:48.
- **Текст:** `Foreground service started from background can not have location/camera/microphone access: service com.kolt12max.livi/.IncomingCallForegroundService`
- **Смысл:** FGS запущен из фона (по FCM). В таком режиме системе разрешено ограничивать доступ к камере/микрофону/геолокации. Для видеозвонка это может привести к тому, что камера/микрофон не будут доступны сразу при принятии из уведомления.

**Рекомендация:** Убедиться, что после того как пользователь открывает приложение (тап по уведомлению/по экрану), запрос разрешений и доступ к камере/микрофону выполняются уже от имени видимой Activity.

---

### 3. **Уведомления: NotifHistoryProto — имя пакета не в кэше**

- **Время:** 12:36:30.
- **Текст:** `NotifHistoryProto: notification package name (com.kolt12max.livi) not found in string cache` (2 раза).
- **Смысл:** Внутренний кэш системы для истории уведомлений не содержал имя пакета. Обычно не ломает доставку, но может влиять на отображение истории уведомлений в настройках/на панели.

---

### 4. **Firebase: аналитика не логируется**

- **Время:** 16:33:12.
- **Текст:** `FirebaseMessaging: Unable to log event: analytics library is missing`
- **Смысл:** Firebase Analytics не подключён/не инициализирован, поэтому FCM не может отправлять события аналитики. Сами push-уведомления при этом доставляются (логи FCM и NotificationManager есть).

---

## Ошибки приложения и библиотек (без прямого влияния на соединение/уведомления)

### 5. **Reanimated: NoSuchFieldException (mIsFinished)**

- **Время:** 16:52:47.
- **Текст:** `java.lang.NoSuchFieldException: No field mIsFinished in class Lcom/facebook/react/bridge/queue/MessageQueueThreadImpl;`
- **Стек:** `WorkletsMessageQueueThreadBase.quitSynchronous` → `NativeProxy.initHybrid` (react-native-reanimated).
- **Смысл:** Несовместимость react-native-reanimated с текущей версией React Native (внутреннее API MessageQueueThreadImpl изменилось). Может влиять на анимации, не на сеть/звонки.

---

### 6. **expo-av: JSI bindings не установлены**

- **Время:** 16:52:47.
- **Текст:** `AVManager: Cannot install JSI bindings for AV module because JS context is not available`
- **Смысл:** Модуль expo-av инициализируется до готовности JS-контекста. Может влиять на воспроизведение/запись звука в определённых сценариях. Дополнительно: в логах есть предупреждение о deprecation — `expo-av` помечен как устаревший в пользу `expo-audio` / `expo-video`.

---

### 7. **SafeAreaView: таймаут layout**

- **Время:** 16:52:53.
- **Текст:** `SafeAreaView: Timed out waiting for layout.`
- **Смысл:** Компонент не получил layout в ожидаемое время. Возможны сдвиги/обрезание UI, не критично для соединения.

---

### 8. **Long monitor contention (UI-поток)**

- **Время:** 16:52:53.
- **Текст:** `Long monitor contention with owner main (23246) at NativeViewHierarchyManager.manageChildren ... in getRootViewNum() for 504ms`
- **Смысл:** Блокировка на нативном UI-менеджере ~504 ms. Может давать краткие подвисания интерфейса, не ошибка сети/звонков.

---

### 9. **Chromium/WebView: Seed missing signature**

- **Время:** 16:52:47.
- **Текст:** `chromium: [ERROR:android_webview/.../variations_seed_loader.cc:39] Seed missing signature.`
- **Смысл:** Внутренняя ошибка WebView (Chrome), часто на конкретных прошивках. Обычно не влияет на логику приложения, если не используете сложные сценарии в WebView.

---

### 10. **Классические предупреждения (низкий приоритет)**

- **classes.dex:** `Failed to find entry 'classes.dex': Entry not found` — типично для split APK, не ошибка.
- **jdwp:** `Not starting debugger since process cannot load the jdwp agent` — в release-сборках норма.
- **SoLoader:** `SoLoader already initialized` — повторная инициализация, не критично.
- **ashmem:** `Pinning is deprecated since Android Q` — предупреждение из нативного кода (например, React Native/Hermes).
- **ViewManagerPropertyUpdater:** множество `Could not find generated setter` — типично для React Native, не влияет на соединение/уведомления.
- **AudioCapabilities / VideoCapabilities:** неподдерживаемые MIME-типы — норма для устройств, которые не поддерживают часть кодеков.
- **WindowManager destroySurfaces / UsageStatsService / ProcessStats** — системные сообщения по другим приложениям или общему состоянию системы, не специфичны для LiVi.

---

## Резюме по соединению и уведомлениям

| Проблема | Влияние |
|----------|--------|
| **BAL_BLOCK для IncomingCallActivity** | Пользователь не видит полноэкранный экран входящего звонка при вызове из фона; показывается только уведомление. Через 20 с сервис закрывается по таймауту. |
| **FGS без доступа к камере/микрофону из фона** | Риск, что при принятии звонка из уведомления камера/микрофон не включатся до открытия приложения. |
| **Firebase Analytics missing** | Нет аналитики по событиям FCM; доставка push не страдает. |
| **NotifHistoryProto (string cache)** | Возможные артефакты в истории уведомлений системы. |

Главная причина, по которой «не показывается экран входящего звонка» при вызове в фоне — **блокировка Background Activity Launch (BAL)** и связанное с этим **FSI_REQUESTED_BUT_DENIED** для full-screen уведомления. Исправление нужно искать в том, как запускается входящий звонок с фона (разрешения BAL, тип FGS, использование Telecom/ConnectionService, full-screen intent).
