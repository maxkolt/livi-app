#!/bin/bash
# Снимает с одного устройства логи logcat и оставляет только строки, касающиеся LiVi.
# Использование:
#   ./scripts/dump-livi-logs-one-device.sh              # единственное подключённое устройство
#   ./scripts/dump-livi-logs-one-device.sh SERIAL       # указанный серийник
#   ./scripts/dump-livi-logs-one-device.sh A35          # устройство с моделью A35 (Samsung)
#
# Результат: frontend/livi-logs-<device>-YYYYMMDD-HHMM.log (только LiVi).

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
LOG_DIR="$(pwd)"
WHEN="$(date +%Y%m%d-%H%M)"

# Фильтр тегов/пакетов LiVi (релиз и отладка)
LIVI_GREP='LiviAppModule|OutgoingCallActivity|LiviFirebaseMessagingService|MainActivity|kolt12max\.livi|ReactNativeJS.*livi|IncomingCallActivity|ActiveCallForegroundService|IncomingCallForegroundService|LiviOngoingCallHelper|LiviOutgoingCallService|LiviFCM|CallKeep|FCM|Firebase.*livi'

SERIAL="${1:-}"
DEVICE_ID="device"

# Сначала проверяем, есть ли вообще устройства
DEVICE_COUNT=$(adb devices | grep -c "device$" || true)
if [ "$DEVICE_COUNT" -eq 0 ]; then
  echo "adb не видит ни одного устройства (сейчас: 0)."
  echo ""
  echo "Проверь:"
  echo "  1. Телефон подключён по USB и разблокирован."
  echo "  2. Включена «Отладка по USB»: Настройки → О телефоне → 7 раз «Номер сборки» → Настройки → Для разработчиков → Отладка по USB."
  echo "  3. На телефоне при подключении нажато «Разрешить» (и отмечено «Всегда с этого компьютера»)."
  echo "  4. Режим USB: «Передача файлов» или «PTP», не «Только зарядка»."
  echo "  5. Кабель поддерживает данные (не только зарядку)."
  echo ""
  adb devices -l
  exit 1
fi

if [ -n "$SERIAL" ]; then
  if [ "$SERIAL" = "A35" ] || [ "$SERIAL" = "a35" ]; then
    # Найти устройство с моделью A35 в adb devices -l
    FOUND=$(adb devices -l | awk '$2=="device" {for(i=3;i<=NF;i++) if($i~/model:A35/ || $i~/model:a35/) {print $1; exit}}')
    if [ -z "$FOUND" ]; then
      # Попробовать по product (Samsung часто SM-A356B и т.д.)
      FOUND=$(adb devices -l | awk '$2=="device" {for(i=3;i<=NF;i++) if($i~/A35/ || $i~/a35/) {print $1; exit}}')
    fi
    if [ -z "$FOUND" ]; then
      echo "Устройство с моделью A35 не найдено среди $DEVICE_COUNT устройств (подключи Samsung A35 или укажи серийник)."
      adb devices -l
      exit 1
    fi
    SERIAL="$FOUND"
    DEVICE_ID="a35"
  fi
  ADB="adb -s $SERIAL"
else
  COUNT=$(adb devices | grep -c "device$" || true)
  if [ "$COUNT" -eq 0 ]; then
    echo "Нет подключённых устройств. Подключи телефон и разреши отладку по USB."
    adb devices -l
    exit 1
  fi
  if [ "$COUNT" -gt 1 ]; then
    echo "Подключено несколько устройств. Укажи серийник или A35: $0 SERIAL"
    adb devices -l
    exit 1
  fi
  SERIAL=$(adb devices | awk '$2=="device" {print $1; exit}')
  ADB="adb -s $SERIAL"
  # Проверяем, не A35 ли это
  adb devices -l | grep -q "A35\|a35" && DEVICE_ID="a35" || true
fi

OUTPUT="${LOG_DIR}/livi-logs-${DEVICE_ID}-${WHEN}.log"
echo "Устройство: $SERIAL -> только логи LiVi: $OUTPUT"
echo "Дамп буфера logcat и фильтр по LiVi..."
$ADB logcat -d -v time 2>/dev/null | grep -E "$LIVI_GREP" > "$OUTPUT" || true
LINES=$(wc -l < "$OUTPUT")
echo "Готово. Строк (LiVi): $LINES"
echo "Файл: $OUTPUT"
if [ "$LINES" -gt 0 ]; then
  echo "--- первые 50 строк ---"
  head -50 "$OUTPUT"
fi
