#!/usr/bin/env bash
# Захват логов с телефона (USB) для отладки пушей входящего звонка в релизе.
# Запуск: ./scripts/capture-push-logs.sh
# Воспроизведение: 1) Запусти скрипт  2) Сверни/закрой LiVi на телефоне  3) Позвони на этот номер с другого  4) Ctrl+C

set -e
OUTPUT_DIR="${1:-.}"
LOG_FILE="$OUTPUT_DIR/livi-push-debug-$(date +%Y%m%d-%H%M%S).log"
FILTERED="$OUTPUT_DIR/livi-push-filtered-$(date +%Y%m%d-%H%M%S).log"

echo "=== LiVi Push Log Capture ==="
echo "Убедись: телефон по USB, включена отладка по USB, на телефоне установлен релиз LiVi."
echo ""

if ! command -v adb &> /dev/null; then
  echo "Ошибка: adb не найден. Установи Android SDK platform-tools (brew install android-platform-tools)."
  exit 1
fi

DEVICES=$(adb devices | grep -v "List" | grep "device$" | wc -l)
if [ "$DEVICES" -eq 0 ]; then
  echo "Ошибка: ни одно устройство не найдено. Подключи телефон и разреши отладку по USB."
  adb devices
  exit 1
fi

echo "Устройство найдено. Логи пишутся в: $LOG_FILE"
echo "Воспроизведи проблему (сверни приложение, позвони на этот телефон), затем нажми Ctrl+C."
echo ""

# Очищаем буфер logcat
adb logcat -c

# Пишем ВСЕ логи в файл; в консоль — только релевантные теги
FILTER_RE='ReactNativeJS|Firebase|FCM|GCM|expo|push|call|notification|RemoteMessage|NotificationsService|categoryId|incoming_call|kolt12max\.livi'
adb logcat -v time 2>&1 | tee "$LOG_FILE" | grep --line-buffered -iE "$FILTER_RE" || true

echo ""
echo "Логи сохранены: $LOG_FILE"
echo "Релевантные строки в: $FILTERED"
grep -iE "$FILTER_RE" "$LOG_FILE" > "$FILTERED" 2>/dev/null || true
wc -l "$FILTERED" 2>/dev/null || true
echo ""
echo "Проверка уведомления:"
echo "  1. Пуш не пришёл — в FILTERED нет FirebaseMessaging/onMessageReceived; проверь backend (call:initiate, sendPushToUser)."
echo "  2. Показывается «старое» уведомление — возможно один и тот же tag/ID переиспользуется или не сбрасывается; ищи в логе 'postNotification' для com.kolt12max.livi."
echo ""
echo "Команды для разбора после Ctrl+C:"
echo "  grep -i 'FirebaseMessaging\\|RemoteMessage\\|onMessageReceived' $FILTERED"
echo "  grep -i 'kolt12max.livi.*[Nn]otif' $LOG_FILE"
