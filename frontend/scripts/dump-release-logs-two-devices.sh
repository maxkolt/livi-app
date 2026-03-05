#!/bin/bash
# Сбрасывает текущий буфер logcat с двух устройств в файлы.
# Использование: ./scripts/dump-release-logs-two-devices.sh
# Логи: livi-release-device1-dump-YYYYMMDD-HHMM.log, livi-release-device2-dump-YYYYMMDD-HHMM.log
# Важно: в буфере только последние записи (минуты/часы), за прошлые дни — только если не перезагружали.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
LOG_DIR="$(pwd)"
WHEN="$(date +%Y%m%d-%H%M)"

DEVICES=($(adb devices -l | awk '$2=="device" {print $1}' | head -2))
if [ ${#DEVICES[@]} -lt 2 ]; then
  echo "Нужно 2 подключённых устройства. Сейчас: ${#DEVICES[@]}"
  adb devices -l
  exit 1
fi

LOG1="${LOG_DIR}/livi-release-device1-dump-${WHEN}.log"
LOG2="${LOG_DIR}/livi-release-device2-dump-${WHEN}.log"
echo "Устройство 1: ${DEVICES[0]} -> $LOG1"
echo "Устройство 2: ${DEVICES[1]} -> $LOG2"
echo "Дамп буфера logcat (все логи, что ещё в памяти)..."
echo ""

adb -s "${DEVICES[0]}" logcat -d -v time > "$LOG1"
adb -s "${DEVICES[1]}" logcat -d -v time > "$LOG2"

echo "Готово. Строк: device1=$(wc -l < "$LOG1"), device2=$(wc -l < "$LOG2")"
echo "Чтобы оставить только LiVi: grep -E 'LiviAppModule|OutgoingCall|LiviFirebase|MainActivity|kolt12max.livi' $LOG1"
