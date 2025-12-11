# Команды для запуска Frontend приложения

## Базовый запуск

```bash
cd frontend
npm start
```

или

```bash
cd frontend
expo start
```

## Запуск для iOS

```bash
cd frontend
npm run ios
```

или

```bash
cd frontend
expo run:ios
```

## Запуск для Android

```bash
cd frontend
npm run android
```

или

```bash
cd frontend
expo run:android
```

## Запуск для веб-браузера

```bash
cd frontend
npm run web
```

## Запуск с LAN (для тестирования на реальных устройствах)

```bash
cd frontend
npm run start:lan
```

## Первый запуск (установка зависимостей)

Если еще не установлены зависимости:

```bash
cd frontend
npm install
npm start
```

## Полезные команды

- **Очистить кэш**: `expo start -c` или `npm start -- --clear`
- **Запуск в туннеле**: `expo start --tunnel`
- **Запуск на конкретном порту**: `expo start --port 8081`
