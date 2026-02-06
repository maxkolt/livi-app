# 📱 Сборка AAB в Android Studio

## Шаг 1: Открыть проект

1. Откройте Android Studio
2. **File → Open**
3. Выберите папку: `frontend/android`
4. Дождитесь синхронизации Gradle

## Шаг 2: Проверить версию

1. Откройте файл: `app/build.gradle`
2. Проверьте:
   ```gradle
   versionCode 7
   versionName "1.0.6"
   ```

## Шаг 3: Собрать AAB

### Вариант 1: Через меню (рекомендуется)

1. **Build → Generate Signed Bundle / APK**
2. Выберите **Android App Bundle**
3. Нажмите **Next**
4. Выберите ваш keystore файл (если есть)
   - Если нет keystore, создайте новый:
     - **Create new...**
     - Заполните данные
     - Сохраните keystore в безопасном месте!
5. Введите пароли keystore
6. Нажмите **Next**
7. Выберите **release** build variant
8. Нажмите **Create**
9. Дождитесь завершения сборки

### Вариант 2: Через Gradle (быстрее)

1. Откройте **Terminal** в Android Studio (внизу)
2. Выполните:
   ```bash
   ./gradlew bundleRelease
   ```
3. AAB будет в: `app/build/outputs/bundle/release/app-release.aab`

## Шаг 4: Найти AAB файл

После сборки файл находится в:
```
frontend/android/app/build/outputs/bundle/release/app-release.aab
```

## Шаг 5: Загрузить в Google Play

1. Откройте [Google Play Console](https://play.google.com/console)
2. Выберите ваше приложение
3. Перейдите в **Внутреннее тестирование** (или нужный трек)
4. Нажмите **Создать новый релиз**
5. Загрузите файл `app-release.aab`
6. Заполните описание изменений
7. Нажмите **Сохранить**

## Шаг 6: Проверить логи после установки

После того как приложение будет доступно для скачивания:

1. Установите приложение на тестовое устройство
2. Подключите устройство через USB
3. Включите USB отладку
4. Выполните в терминале (из корня проекта):
   ```bash
   adb logcat | grep -E "ReactNative|com.kolt12max.livi"
   ```
5. Откройте приложение на устройстве
6. Скопируйте логи с ошибками

## 🔍 Альтернативный способ получения логов

Если нет доступа к ADB, можно использовать:

1. **Android Studio → Logcat**
   - Подключите устройство
   - Откройте вкладку **Logcat**
   - Фильтр: `package:com.kolt12max.livi`

2. **Сохранить логи в файл:**
   ```bash
   adb logcat -d > app-logs.txt
   ```

## ⚠️ Важно

- **Keystore файл** - сохраните в безопасном месте! Без него нельзя обновлять приложение
- **versionCode** должен быть больше предыдущего (7 > 6)
- **versionName** можно менять как угодно (1.0.6)

## 🐛 Если сборка не работает

1. **Очистить проект:**
   ```bash
   ./gradlew clean
   ```

2. **Пересобрать:**
   ```bash
   ./gradlew bundleRelease
   ```

3. **Проверить ошибки в Build Output**
