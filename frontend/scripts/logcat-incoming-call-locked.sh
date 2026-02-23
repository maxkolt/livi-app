#!/usr/bin/env bash
# Логи входящего звонка при заблокированном экране (два устройства).
# Запусти скрипт, заблокируй экран УСТРОЙСТВА-ПОЛУЧАТЕЛЯ, затем позвони с другого.
# Остановка: Ctrl+C. Ищи в логах: [INCOMING_CALL], [INCOMING_FGS], FSI_REQUESTED_BUT_DENIED, BAL_BLOCK.
#
# Использование:
#   ./scripts/logcat-incoming-call-locked.sh              # оба устройства, фильтр по тегам
#   ./scripts/logcat-incoming-call-locked.sh full         # оба устройства, все логи (большие файлы)
#   ./scripts/logcat-incoming-call-locked.sh <SERIAL>     # одно устройство (получатель)

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
LOG_DIR="$(pwd)"

ARG1="${1:-}"
if [ "$ARG1" = "full" ]; then
  FILTER=""
  SUFFIX="-full"
else
  # Наши теги (E уровень чтобы видеть [INCOMING_CALL] / [INCOMING_FGS]) + системные для FSI/BAL
  SUFFIX=""
fi

single_device() {
  local SERIAL="$1"
  local LOG_FILE="$2"
  adb -s "$SERIAL" logcat -c
  if [ "$ARG1" = "full" ]; then
    echo "Device $SERIAL -> $LOG_FILE (all logs)"
    adb -s "$SERIAL" logcat -v time 2>&1 | tee "$LOG_FILE"
  else
    echo "Device $SERIAL -> $LOG_FILE (incoming call + FSI/BAL tags)"
    adb -s "$SERIAL" logcat -v time \
      LiviFCM:E IncomingCallFGS:E RNCallKeep:V \
      ActivityTaskManager:I NotificationService:I \
      *:S 2>&1 | tee "$LOG_FILE"
  fi
}

DEVICES=($(adb devices -l | awk '$2=="device" {print $1}'))
if [ -n "$ARG1" ] && [ "$ARG1" != "full" ]; then
  SERIAL="$ARG1"
  LOG_FILE="${LOG_DIR}/livi-incoming-$(echo "$SERIAL" | tr -d ' ').log"
  echo "Одно устройство: $SERIAL"
  echo "Заблокируй экран на этом устройстве и позвони с другого. Ctrl+C — стоп."
  echo ""
  single_device "$SERIAL" "$LOG_FILE"
  exit 0
fi

if [ ${#DEVICES[@]} -lt 2 ]; then
  echo "Подключи 2 устройства (или укажи серийник: $0 SERIAL). Сейчас: ${#DEVICES[@]}"
  adb devices -l
  exit 1
fi

LOG1="${LOG_DIR}/livi-incoming-${DEVICES[0]}${SUFFIX}.log"
LOG2="${LOG_DIR}/livi-incoming-${DEVICES[1]}${SUFFIX}.log"
echo "Устройство 1: ${DEVICES[0]} -> $LOG1"
echo "Устройство 2: ${DEVICES[1]} -> $LOG2"
echo ""
echo "Заблокируй экран на УСТРОЙСТВЕ-ПОЛУЧАТЕЛЕ, затем сделай видеозвонок с другого."
echo "В логах ищи: [INCOMING_CALL] keyguardLocked= [INCOMING_FGS] FSI_REQUESTED_BUT_DENIED BAL_BLOCK"
echo "Ctrl+C — остановить и сохранить логи."
echo ""

adb -s "${DEVICES[0]}" logcat -c
adb -s "${DEVICES[1]}" logcat -c

if [ "$ARG1" = "full" ]; then
  adb -s "${DEVICES[0]}" logcat -v time 2>&1 | tee "$LOG1" &
  adb -s "${DEVICES[1]}" logcat -v time 2>&1 | tee "$LOG2" &
else
  adb -s "${DEVICES[0]}" logcat -v time LiviFCM:E IncomingCallFGS:E RNCallKeep:V ActivityTaskManager:I NotificationService:I *:S 2>&1 | tee "$LOG1" &
  adb -s "${DEVICES[1]}" logcat -v time LiviFCM:E IncomingCallFGS:E RNCallKeep:V ActivityTaskManager:I NotificationService:I *:S 2>&1 | tee "$LOG2" &
fi
PID1=$!
PID2=$!

trap "kill $PID1 $PID2 2>/dev/null; echo 'Логи сохранены в $LOG_DIR/livi-incoming-*.log'; exit 0" INT TERM
wait
