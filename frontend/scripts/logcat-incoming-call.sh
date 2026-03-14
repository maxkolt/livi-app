#!/usr/bin/env bash
# Снять logcat во время входящего звонка и проверить, доходит ли пуш до LiviFCM.
# Если в логе нет строк LiviFCM — пуш идёт через Expo (notification payload), нативный экран с кнопками не показывается.
#
# Использование:
#   1. Запусти: ./scripts/logcat-incoming-call.sh [SERIAL]
#   2. Сверни/закрой LiVi на устройстве-получателе, перейди на домашний экран.
#   3. С другого устройства позвони на это.
#   4. Подожди 10–15 сек или нажми Ctrl+C.
#   5. Скрипт сохранит лог и выведет: есть ли LiviFCM (наш FCM-сервис вызван) или нет.
#
# Без SERIAL — используется первое подключённое устройство (получатель должен быть по USB).

set -e
SERIAL="${1:-}"
ADB="adb"
if [ -n "$SERIAL" ]; then
  ADB="adb -s $SERIAL"
fi

OUTPUT_DIR="${2:-.}"
STAMP=$(date +%Y%m%d-%H%M%S)
RAW_LOG="$OUTPUT_DIR/logcat_incoming_call_${STAMP}.txt"
SUMMARY_LOG="$OUTPUT_DIR/logcat_incoming_call_${STAMP}_LiviFCM.txt"

echo "=== LiVi: logcat при входящем звонке ==="
echo ""

if ! command -v adb &>/dev/null; then
  echo "Ошибка: adb не найден."
  exit 1
fi

DEVICES=$(adb devices | grep -v "List" | grep "device$" | wc -l)
if [ "$DEVICES" -eq 0 ]; then
  echo "Ошибка: нет подключённых устройств."
  adb devices
  exit 1
fi

if [ -z "$SERIAL" ] && [ "$DEVICES" -gt 1 ]; then
  echo "Подключено устройств: $DEVICES. Укажи серийник: $0 SERIAL"
  adb devices -l
  exit 1
fi

echo "Устройство: $($ADB shell getprop ro.product.model 2>/dev/null || echo $SERIAL)"
echo "Лог (полный): $RAW_LOG"
echo "Лог (LiviFCM): $SUMMARY_LOG"
echo ""
echo "Сверни LiVi, позвони на это устройство в течение 30 сек, затем Ctrl+C."
echo ""

$ADB logcat -c
$ADB logcat -v time 2>&1 | tee "$RAW_LOG" &
LOGCAT_PID=$!
trap "kill $LOGCAT_PID 2>/dev/null; exit 0" INT TERM
sleep 30
kill $LOGCAT_PID 2>/dev/null || true
trap - INT TERM

echo ""
echo "--- Результат ---"
LIVI_LINES=$(grep -c "LiviFCM\|LiviFCM:" "$RAW_LOG" 2>/dev/null) || LIVI_LINES=0
if [ "${LIVI_LINES:-0}" -gt 0 ]; then
  grep -E "LiviFCM|FCM onMessageReceived|INCOMING_CALL" "$RAW_LOG" > "$SUMMARY_LOG" 2>/dev/null || true
  echo "LiviFCM найден в логе ($LIVI_LINES строк). Пуш пришёл в наш сервис — ожидаем уведомление с кнопками."
  echo "Фрагмент: $SUMMARY_LOG"
else
  grep -iE "FirebaseMessaging|FCM-Notification|com.kolt12max.livi.*1003|channel=calls" "$RAW_LOG" | head -20 > "$SUMMARY_LOG" 2>/dev/null || true
  echo "LiviFCM в логе НЕТ. Пуш доставлен через Expo (notification) — нативный экран не вызывается."
  echo "Что сделать: убедиться, что на бэкенд уходит fcmToken (в Metro при загрузке приложения смотри '[push] token registered' { hasFcmToken: true })."
  echo "Фрагмент системных уведомлений: $SUMMARY_LOG"
fi
echo ""
wc -l "$RAW_LOG" "$SUMMARY_LOG" 2>/dev/null || true
