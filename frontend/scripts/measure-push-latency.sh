#!/bin/bash
# Замер задержки доставки звонкового пуша на Android.
#
# Читает строки [PUSH_DELIVERY], которые LiviFirebaseMessagingService пишет при каждом
# входящем звонке, и показывает их вместе с состоянием энергосбережения на устройстве.
#
# Dev-сборка (assembleDebug) ставится как com.kolt12max.livi.dev — отдельный пакет
# со своим состоянием Doze и своим App Standby Bucket. Скрипт проверяет оба пакета,
# какие найдёт на устройстве.
#
# Использование:
#   ./scripts/measure-push-latency.sh                 # все устройства, оба пакета
#   ./scripts/measure-push-latency.sh SERIAL          # одно устройство
#   ./scripts/measure-push-latency.sh -f [SERIAL]     # follow: смотреть в реальном времени
#
# Что смотреть:
#   totalMs   — от создания звонка до показа входящего. Ring timeout 27 000 мс:
#               всё, что выше ~20 000, — звонок почти наверняка сорвался.
#   queuedMs  — сколько пуш пролежал в очереди Google. Большое значение = соединение
#               GMS с FCM было мертво, типично для глубокого Doze.
#   bucket    — 10 ACTIVE (без лимита), 20 WORKING_SET, 30 FREQUENT, 40 RARE, 45 RESTRICTED.
#   battOptIgnored=true — приложение исключено из оптимизации батареи. Цель — именно это.

set -e
PKGS="com.kolt12max.livi com.kolt12max.livi.dev"

FOLLOW=0
if [ "$1" = "-f" ] || [ "$1" = "--follow" ]; then
  FOLLOW=1
  shift
fi

SERIALS="${1:-}"
if [ -z "$SERIALS" ]; then
  SERIALS=$(adb devices | awk '$2=="device" {print $1}')
fi
if [ -z "$SERIALS" ]; then
  echo "adb не видит подключённых устройств."
  adb devices -l
  exit 1
fi

for S in $SERIALS; do
  MODEL=$(adb -s "$S" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
  echo "=============== $MODEL ($S) ==============="
  WHITELIST=$(adb -s "$S" shell dumpsys deviceidle whitelist 2>/dev/null || true)

  for PKG in $PKGS; do
    if ! adb -s "$S" shell pm list packages 2>/dev/null | tr -d '\r' | grep -qx "package:$PKG"; then
      continue
    fi
    LABEL="$PKG"
    [ "$PKG" = "com.kolt12max.livi.dev" ] && LABEL="$PKG (dev)"
    echo "  $LABEL"

    # Формат строки: "user,<package>,<uid>" — пакет в середине, якорь на конец строки не сработает.
    if echo "$WHITELIST" | grep -q ",$PKG,"; then
      echo "    Doze whitelist : ✅ исключено из оптимизации батареи"
    else
      echo "    Doze whitelist : ❌ НЕ исключено — пуши будут опаздывать в глубоком Doze"
    fi

    BUCKET=$(adb -s "$S" shell am get-standby-bucket "$PKG" 2>/dev/null | tr -d '\r ')
    case "$BUCKET" in
      5)  BL="EXEMPTED (исключено из Doze — квоты не действуют)";;
      10) BL="ACTIVE (квота high-priority FCM не режется)";;
      20) BL="WORKING_SET";;
      30) BL="FREQUENT (жёсткая суточная квота high-priority FCM)";;
      40) BL="RARE (жёсткая квота)";;
      45) BL="RESTRICTED (жёсткая квота)";;
      *)  BL="неизвестно";;
    esac
    echo "    Standby bucket : $BUCKET — $BL"
  done
  echo
done

if [ "$FOLLOW" = "1" ]; then
  S=$(echo $SERIALS | awk '{print $1}')
  echo "Слежу за [PUSH_DELIVERY] на $S. Звони на этот телефон. Ctrl+C для выхода."
  exec adb -s "$S" logcat -v time -s LiviFCM:I | grep --line-buffered "PUSH_DELIVERY"
fi

for S in $SERIALS; do
  MODEL=$(adb -s "$S" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
  echo "--- замеры из буфера: $MODEL ($S) ---"
  FOUND=$(adb -s "$S" logcat -d -v time 2>/dev/null | grep "PUSH_DELIVERY" || true)
  if [ -z "$FOUND" ]; then
    echo "  (нет записей — нужен билд с этим кодом и хотя бы один входящий звонок)"
  else
    echo "$FOUND"
  fi
  echo
done
