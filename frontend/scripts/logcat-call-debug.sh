#!/usr/bin/env bash
# Снять логи FCM и OutgoingCall на устройстве инициатора при тесте «принятие вызова».
# Запустить ПЕРЕД тестом, затем принять вызов на втором устройстве.
# Использование: ./scripts/logcat-call-debug.sh [SERIAL]
# Без SERIAL — на первом подключённом устройстве.

set -e
SERIAL="${1:-}"
ADB="adb"
[ -n "$SERIAL" ] && ADB="adb -s $SERIAL"

echo "Очистка буфера logcat..."
$ADB logcat -c

echo "Логи LiviFCM и OutgoingCallActivity (Ctrl+C для остановки)..."
# Несколько тегов: LiviFCM:V OutgoingCallActivity:V *:S (остальное скрыто)
$ADB logcat LiviFCM:V OutgoingCallActivity:V *:S 2>/dev/null || \
  $ADB logcat 2>/dev/null | grep --line-buffered -E "LiviFCM|OutgoingCallActivity|CLOSE_OUTGOING|call_accepted"
