#!/usr/bin/env bash
# Снять последние логи по PiP (декор, оверлей, Back, системный PiP) для разбора без участия пользователя.
# Запускать ПОСЛЕ теста на устройстве, подключённом по USB.
# Использование:
#   ./scripts/capture-pip-debug-logs.sh           # снять с обоих устройств (pip-debug-SERIAL1.log, pip-debug-SERIAL2.log)
#   ./scripts/capture-pip-debug-logs.sh SERIAL    # снять с одного устройства в pip-debug-YYYYMMDD-HHMMSS.log
#
# Проверка логов: после теста вызови "проверь логи" — ассистент запустит скрипт и прочитает файлы.

set -e
SERIAL="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
LOG_DIR="$(pwd)/logs_devices"
mkdir -p "$LOG_DIR"
TS=$(date +%Y%m%d-%H%M%S)
GREP_PIP='getDecorViewSize|requestEnterPictureInPicture|sourceRect|LiviAppModule|PiPOverlay|PiPContext|updatePiPState|AboutToEnterSystemPiP|applyPending|scheduleSystemPiP|applyDecorAndPending|prepSystemPiPUI|System PiP layout|decorSize|usePreventRemove|PreventRemove Back|VideoCall root|ReactNativeJS'

if [ -n "$SERIAL" ]; then
  OUT="$LOG_DIR/pip-debug-$TS.log"
  echo "Сбор с устройства $SERIAL -> $OUT"
  adb -s "$SERIAL" logcat -d -t 8000 2>/dev/null | grep -E "$GREP_PIP" > "$OUT" || true
  echo "Строк: $(wc -l < "$OUT" 2>/dev/null || echo 0)"
  echo "$OUT"
else
  DEVICES=($(adb devices -l | awk '$2=="device" {print $1}'))
  if [ ${#DEVICES[@]} -eq 0 ]; then
    echo "Нет подключённых устройств."
    exit 1
  fi
  for s in "${DEVICES[@]}"; do
    OUT="$LOG_DIR/pip-debug-$s.log"
    echo "Сбор с $s -> $OUT"
    adb -s "$s" logcat -d -t 8000 2>/dev/null | grep -E "$GREP_PIP" > "$OUT" || true
    echo "  строк: $(wc -l < "$OUT" 2>/dev/null || echo 0)"
  done
  echo "Готово. Файлы: $LOG_DIR/pip-debug-*.log"
fi
