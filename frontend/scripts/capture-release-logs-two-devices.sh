#!/bin/bash
# Снимает логи релизной сборки с двух подключённых устройств.
# Использование:
#   1. Подключи два телефона по USB (release build установлен).
#   2. ./scripts/capture-release-logs-two-devices.sh
#   3. Воспроизведи сценарий: первый звонок → ответ → завершение → повторный звонок тому же.
#   4. Ctrl+C чтобы остановить и сохранить логи.
#
# Логи: livi-release-device1.log, livi-release-device2.log (по порядку adb devices).

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
LOG_DIR="$(pwd)"
FILTER="-s LiviAppModule:D -s OutgoingCallActivity:D -s LiviFirebaseMessagingService:D -s MainActivity:D"

DEVICES=($(adb devices -l | awk '$2=="device" {print $1}' | head -2))
if [ ${#DEVICES[@]} -lt 2 ]; then
  echo "Нужно 2 подключённых устройства. Сейчас: ${#DEVICES[@]}"
  adb devices -l
  exit 1
fi

echo "Устройство 1: ${DEVICES[0]} -> ${LOG_DIR}/livi-release-device1.log"
echo "Устройство 2: ${DEVICES[1]} -> ${LOG_DIR}/livi-release-device2.log"
echo "Воспроизведи сценарий (повторный вызов), затем Ctrl+C."
echo ""

adb -s "${DEVICES[0]}" logcat -c
adb -s "${DEVICES[1]}" logcat -c

adb -s "${DEVICES[0]}" logcat $FILTER 2>&1 | tee "${LOG_DIR}/livi-release-device1.log" &
PID1=$!
adb -s "${DEVICES[1]}" logcat $FILTER 2>&1 | tee "${LOG_DIR}/livi-release-device2.log" &
PID2=$!

trap "kill $PID1 $PID2 2>/dev/null; echo 'Логи сохранены.'; exit 0" INT TERM
wait
