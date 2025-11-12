# Управление логами в приложении

## Настройки логирования

По умолчанию приложение настроено на минимальное количество логов для лучшей производительности и читаемости консоли.

### Frontend (React Native)

**Переменные окружения:**
- `LOG_LEVEL` - уровень логирования (debug, info, warn, error)
- По умолчанию: `warn` (только предупреждения и ошибки)

**Примеры использования:**
```bash
# Показать только ошибки
LOG_LEVEL=error npx react-native start

# Показать все логи (включая debug)
LOG_LEVEL=debug npx react-native start
```

### Backend (Node.js)

**Переменные окружения:**
- `DEBUG_LOGS` - включить debug логи (true/false)
- `INFO_LOGS` - включить info логи (true/false)
- `NODE_ENV` - режим работы (production/development)

**Примеры использования:**
```bash
# Минимальные логи (по умолчанию)
npm run dev

# Включить info логи
INFO_LOGS=true npm run dev

# Включить debug логи
DEBUG_LOGS=true npm run dev

# Включить все логи
DEBUG_LOGS=true INFO_LOGS=true npm run dev
```

### MediaSoup

**Настройки сервера:**
- `logLevel: 'error'` - только ошибки
- `logTags: ['error']` - только теги ошибок

**Настройки клиента:**
- ICE кандидаты не логируются (закомментированы)
- Только важные события логируются

## Рекомендации

1. **Для разработки:** Используйте `LOG_LEVEL=warn` на фронтенде и `INFO_LOGS=true` на бэкенде
2. **Для отладки:** Включите `DEBUG_LOGS=true` и `LOG_LEVEL=debug`
3. **Для продакшена:** Оставьте настройки по умолчанию (только ошибки и предупреждения)

## Восстановление полного логирования

Если нужно вернуть полное логирование:

1. **Frontend:** Установите `LOG_LEVEL=debug`
2. **Backend:** Установите `DEBUG_LOGS=true INFO_LOGS=true`
3. **MediaSoup:** Измените `logLevel` на `'warn'` и добавьте нужные `logTags`


