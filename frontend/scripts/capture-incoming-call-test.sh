#!/usr/bin/env bash
# Снимок logcat со всех подключённых устройств + GET /api/debug/push-log с бэкенда.
# Сценарий: свернуть/убить приложение на получателе → звонок → сразу запустить этот скрипт.
#
# Использование:
#   cd frontend && ./scripts/capture-incoming-call-test.sh
#   CLEAR_LOGCAT=1 ./scripts/capture-incoming-call-test.sh   # перед тестом: очистить буфер на всех девайсах
#   BACKEND_URL=http://localhost:3000 ./scripts/capture-incoming-call-test.sh
#
set -eo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
OUT_DIR="$(pwd)/log-captures"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKEND_URL="${BACKEND_URL:-https://api.liviapp.com}"

# Тот же фильтр, что в dump-livi-logs-one-device.sh
LIVI_GREP='LiviAppModule|OutgoingCallActivity|LiviFirebaseMessagingService|MainActivity|kolt12max\.livi|ReactNativeJS.*livi|IncomingCallActivity|ActiveCallForegroundService|IncomingCallForegroundService|IncomingCallFGS|LiviOngoingCallHelper|LiviOutgoingCallService|LiviFCM|CallKeep|FCM|Firebase.*livi|INCOMING_CALL|INCOMING_FGS|RNCallKeep|headless'

echo "=== LiVi: logcat (все устройства) + push-log с бэка ==="
echo "Время: $STAMP"
echo "Backend: $BACKEND_URL"
echo ""

if ! command -v adb &>/dev/null; then
  echo "adb не найден"; exit 1
fi

SERIALS=$(adb devices | awk '$2=="device" {print $1}')
if [ -z "$SERIALS" ]; then
  echo "Нет подключённых устройств."; adb devices -l; exit 1
fi

if [ "${CLEAR_LOGCAT:-0}" = "1" ]; then
  echo "Очистка буфера logcat на устройствах..."
  for s in $SERIALS; do
    adb -s "$s" logcat -c
    echo "  $s: ok"
  done
  echo ""
fi

for s in $SERIALS; do
  F="$OUT_DIR/livi-${s}-${STAMP}.log"
  adb -s "$s" logcat -d -v time 2>/dev/null | grep -E "$LIVI_GREP" > "$F" || true
  echo "logcat: $s -> $F ($(wc -l < "$F" | tr -d ' ') строк)"
done

PUSH_JSON="$OUT_DIR/push-log-${STAMP}.json"
echo ""
echo "Запрос push-log..."
if curl -sS --connect-timeout 8 "$BACKEND_URL/api/debug/push-log" -o "$PUSH_JSON" 2>/dev/null; then
  if [ -s "$PUSH_JSON" ] && grep -q '"ok"' "$PUSH_JSON" 2>/dev/null; then
    echo "  -> $PUSH_JSON"
  else
    echo "  -> ответ не ok или пусто: $PUSH_JSON"
    head -c 500 "$PUSH_JSON" 2>/dev/null; echo ""
  fi
else
  echo "  -> curl не удался (неверный URL или бэкенд недоступен)"
  rm -f "$PUSH_JSON" 2>/dev/null || true
fi

echo ""
echo "--- Быстрая проверка (входящий call в FCM?) ---"
for s in $SERIALS; do
  F="$OUT_DIR/livi-${s}-${STAMP}.log"
  n=$(grep -cE 'LiviFCM.*call|INCOMING_CALL|type.:..call|FCM onMessageReceived.*call' "$F" 2>/dev/null) || n=0
  echo "  $s: совпадений по call/INCOMING: $n"
done

echo ""
echo "Готово. Файлы в: $OUT_DIR"
