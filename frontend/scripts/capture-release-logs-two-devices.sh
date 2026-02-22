#!/bin/bash
# Снимает логи с двух подключённых устройств (release или dev сборка).
# Использование:
#   1. Подключи два телефона по USB (установи нужную сборку: release или dev).
#   2. ./scripts/capture-release-logs-two-devices.sh          # фильтр по тегам приложения
#      ./scripts/capture-release-logs-two-devices.sh full    # все логи (как для релиза)
#      ./scripts/capture-release-logs-two-devices.sh full dev   # все логи, файлы livi-dev-*
#   3. Воспроизведи сценарий (звонок, ответ, завершение, повторный звонок).
#   4. Ctrl+C чтобы остановить и сохранить логи.
#
# Логи по умолчанию: livi-release-device1.log, livi-release-device2.log
#   full — все логи: livi-release-device1-full.log (или livi-dev-device1-full.log при dev)
#   dev  — второй аргумент: пишем в livi-dev-device1.log, чтобы не путать с релизом.
#
# Как искать: grep -E 'Error|Exception|FATAL|LiviAppModule|OutgoingCall|Glide' livi-*-device1*.log

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
LOG_DIR="$(pwd)"
ARG1="${1:-}"
ARG2="${2:-}"
if [ "$ARG1" = "full" ] || [ "$ARG1" = "all" ]; then
  FILTER=""
  LOG_SUFFIX="-full"
else
  FILTER="-s LiviAppModule:D -s OutgoingCallActivity:D -s LiviFirebaseMessagingService:D -s MainActivity:D"
  LOG_SUFFIX=""
fi
if [ "$ARG1" = "dev" ] || [ "$ARG2" = "dev" ]; then
  BUILD_PREFIX="livi-dev"
else
  BUILD_PREFIX="livi-release"
fi

DEVICES=($(adb devices -l | awk '$2=="device" {print $1}' | head -2))
if [ ${#DEVICES[@]} -lt 2 ]; then
  echo "Нужно 2 подключённых устройства. Сейчас: ${#DEVICES[@]}"
  adb devices -l
  exit 1
fi

LOG1="${LOG_DIR}/${BUILD_PREFIX}-device1${LOG_SUFFIX}.log"
LOG2="${LOG_DIR}/${BUILD_PREFIX}-device2${LOG_SUFFIX}.log"
echo "Устройство 1: ${DEVICES[0]} -> $LOG1"
echo "Устройство 2: ${DEVICES[1]} -> $LOG2"
[ -n "$LOG_SUFFIX" ] && echo "Режим: ВСЕ логи (файлы большие)."
[ "$BUILD_PREFIX" = "livi-dev" ] && echo "Сборка: dev (файлы livi-dev-*)."
echo "Воспроизведи сценарий, затем Ctrl+C."
echo ""

adb -s "${DEVICES[0]}" logcat -c
adb -s "${DEVICES[1]}" logcat -c

if [ -n "$FILTER" ]; then
  adb -s "${DEVICES[0]}" logcat -v time $FILTER 2>&1 | tee "$LOG1" &
  PID1=$!
  adb -s "${DEVICES[1]}" logcat -v time $FILTER 2>&1 | tee "$LOG2" &
  PID2=$!
else
  adb -s "${DEVICES[0]}" logcat -v time 2>&1 | tee "$LOG1" &
  PID1=$!
  adb -s "${DEVICES[1]}" logcat -v time 2>&1 | tee "$LOG2" &
  PID2=$!
fi

trap "kill $PID1 $PID2 2>/dev/null; echo 'Логи сохранены.'; exit 0" INT TERM
wait
