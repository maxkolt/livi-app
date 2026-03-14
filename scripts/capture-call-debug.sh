#!/usr/bin/env bash
# Снять logcat с обоих устройств и лог пуша с бэкенда после теста входящего звонка.
# Использование:
#   1. Запусти бэкенд (если локально) или используй деплой с /api/debug/push-log.
#   2. Запусти: BACKEND_URL=https://api.liviapp.com ./scripts/capture-call-debug.sh
#      или для локального бэкенда: BACKEND_URL=http://localhost:3000 ./scripts/capture-call-debug.sh
#   3. Выполни сценарий на устройствах (входящий звонок).
#   4. Когда готово — снова запусти скрипт с суффиксом "done" или просто подожди и запусти ещё раз:
#      ./scripts/capture-call-debug.sh done
#      Скрипт снимет текущий logcat и запросит push-log с бэкенда.
#
# Без "done": скрипт только снимает logcat и push-log один раз (моментальный снимок).
# С "done": то же самое (для удобства после теста).

set -e
BACKEND_URL="${BACKEND_URL:-https://api.liviapp.com}"
OUTPUT_DIR="${OUTPUT_DIR:-.}"
STAMP=$(date +%Y%m%d-%H%M%S)

echo "=== LiVi: снимок logcat + push-log ==="
echo "Backend URL: $BACKEND_URL"
echo ""

# Устройства (серийники из adb devices)
DEV1="RF8RC03M85W"
DEV2="RFCX306PWLE"

capture_logcat() {
  local serial=$1
  local out=$2
  if adb -s "$serial" devices 2>/dev/null | grep -q "device$"; then
    adb -s "$serial" logcat -d -t 8000 > "$out" 2>&1
    echo "  $serial -> $(wc -l < "$out") lines -> $out"
  else
    echo "  $serial -> not connected, skip"
  fi
}

# 1. Logcat с обоих устройств
echo "1. Снимаю logcat..."
LOG1="$OUTPUT_DIR/logcat_${DEV1}_${STAMP}.txt"
LOG2="$OUTPUT_DIR/logcat_${DEV2}_${STAMP}.txt"
capture_logcat "$DEV1" "$LOG1"
capture_logcat "$DEV2" "$LOG2"

# 2. Push-log с бэкенда
PUSH_LOG="$OUTPUT_DIR/backend_push_log_${STAMP}.json"
echo ""
echo "2. Запрашиваю /api/debug/push-log..."
if curl -s -S --connect-timeout 5 "$BACKEND_URL/api/debug/push-log" -o "$PUSH_LOG" 2>/dev/null; then
  if [ -s "$PUSH_LOG" ] && grep -q '"ok":\s*true' "$PUSH_LOG" 2>/dev/null; then
    echo "  -> $PUSH_LOG"
    if command -v jq &>/dev/null; then
      echo "  Last events:"
      jq -r '.entries[-15:] | .[] | "   \(.ts) \(.event) \(.payload // {})"' "$PUSH_LOG" 2>/dev/null || true
    fi
  elif [ -s "$PUSH_LOG" ] && grep -q "Cannot GET\|Error\|<!DOCTYPE" "$PUSH_LOG" 2>/dev/null; then
    echo "  -> endpoint not deployed (deploy backend with /api/debug/push-log or use BACKEND_URL=http://localhost:3000 for local)"
    rm -f "$PUSH_LOG"
  else
    echo "  -> empty or unknown response"
  fi
else
  echo "  -> failed (backend not reachable or endpoint missing)"
fi

echo ""
echo "--- Проверка ---"
echo "LiviFCM в logcat (должны быть при доставке через FCM data-only):"
grep -c "LiviFCM\|FCM onMessageReceived\|INCOMING_CALL" "$LOG1" 2>/dev/null || echo "  0 in $LOG1"
grep -c "LiviFCM\|FCM onMessageReceived\|INCOMING_CALL" "$LOG2" 2>/dev/null || echo "  0 in $LOG2"
echo ""
echo "В push-log ищи: call_push_sent_via_FCM (хорошо) или call_push_sending_via_Expo / call_push_FCM_failed_fallback_Expo (тогда пуши идут через Expo — нет кнопок)."
echo ""
echo "Файлы: $LOG1 $LOG2 $PUSH_LOG"
