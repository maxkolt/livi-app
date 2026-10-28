#!/usr/bin/env bash
# Звонки на двух устройствах: CALLER звонит другу FRIEND, CALLEE принимает или отклоняет в разных
# состояниях. Maestro нажимает кнопки (flows/), adb проверяет то, чего не видно на экране:
# режим звука, служба входящего (FGS), уведомление входящего.
#
#   CALLER=emulator-5554 CALLEE=RFCX306PWLE FRIEND=Ron frontend/e2e/call-matrix.sh [сценарий ...]
#
# Без аргументов — все сценарии по порядку. Экран CALLEE должен быть включён и разблокирован.
# Сценарии: killed_decline killed_answer reopen_after_answer native_decline_foreground
#           native_decline_overlay video_pip_earpiece video_pip_speaker
# Для убитого приложения Android сам решает, разрешить ли фоновый старт экрана входящего: показывается
# нативный экран или плашка с кнопками. Подходят оба пути — скрипт пишет, какой был.
set -u

CALLER=${CALLER:-emulator-5554}
CALLEE=${CALLEE:-RFCX306PWLE}
FRIEND=${FRIEND:-Ron}
PKG=com.kolt12max.livi.dev
MAESTRO=${MAESTRO:-$HOME/.maestro/maestro/bin/maestro}
FLOWS="$(cd "$(dirname "$0")" && pwd)/flows"
LOG_DIR=${LOG_DIR:-$(mktemp -d -t livi-call-matrix)}
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true

FAILS=()
CURRENT=""

ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILS+=("$CURRENT: $1"); }

# flow <устройство> <файл> [-e KEY=VALUE ...]
flow() {
  local dev=$1 file=$2; shift 2
  local log="$LOG_DIR/$CURRENT-$(basename "$file" .yaml)-$dev.log"
  if "$MAESTRO" --device "$dev" test "$@" "$FLOWS/$file" >"$log" 2>&1; then
    ok "$file ($dev)"
    return 0
  fi
  bad "$file ($dev) — лог: $log"
  return 1
}

audio_mode() { adb -s "$1" shell dumpsys audio | grep -A1 'Audio mode:' | tail -1 | grep -oE 'MODE_[A-Z_]+'; }
incoming_fgs() { adb -s "$1" shell dumpsys activity services "$PKG" | grep -c IncomingCallForegroundService; }
incoming_notif() { adb -s "$1" shell dumpsys notification --noredact | grep -c "pkg=$PKG.*id=1001"; }

# expect_mode <устройство> <режим> <секунд> — режим звука устанавливается не позже срока.
expect_mode() {
  local dev=$1 want=$2 secs=$3 got=""
  for _ in $(seq 1 $((secs * 2))); do
    got=$(audio_mode "$dev")
    [ "$got" = "$want" ] && { ok "режим звука $want ($dev)"; return 0; }
    sleep 0.5
  done
  bad "режим звука $got вместо $want ($dev)"
}

route() { adb -s "$1" shell dumpsys audio | grep 'Active communication device' | grep -oE 'type:[a-z_]+' | head -1 | cut -d: -f2; }
# Последняя запись журнала камеры для пакета: «: CONNECT device …» — камера открыта, иначе нет.
camera_open() { adb -s "$1" shell dumpsys media.camera | grep -m1 "client for package $PKG" | grep -q ': CONNECT device'; }
pinned() { adb -s "$1" shell dumpsys activity activities | grep -q "A=[0-9]*:$PKG.*mode=pinned"; }
reopen() { adb -s "$1" shell am start -n "$PKG/com.kolt12max.livi.MainActivity" >/dev/null 2>&1; }

# Маршрут звука (earpiece/speaker) не меняется сам при видео, «пузыре» и системном PiP.
expect_route() {
  local dev=$1 want=$2 got
  got=$(route "$dev")
  [ "$got" = "$want" ] && ok "звук: $want ($dev)" || bad "звук: $got вместо $want ($dev)"
}

expect_camera() {
  local dev=$1 want=$2 secs=$3 now
  for _ in $(seq 1 $((secs * 2))); do
    camera_open "$dev" && now=on || now=off
    [ "$now" = "$want" ] && { ok "камера $want ($dev)"; return 0; }
    sleep 0.5
  done
  bad "камера $now вместо $want ($dev)"
}

expect_pinned() {
  local dev=$1 want=$2 secs=$3 now
  for _ in $(seq 1 $((secs * 2))); do
    pinned "$dev" && now=yes || now=no
    [ "$now" = "$want" ] && { ok "системный PiP: $want ($dev)"; return 0; }
    sleep 0.5
  done
  bad "системный PiP: $now вместо $want ($dev)"
}

expect_clean_incoming() {
  local fgs notif
  fgs=$(incoming_fgs "$CALLEE"); notif=$(incoming_notif "$CALLEE")
  [ "$fgs" = 0 ] && ok "служба входящего остановлена" || bad "служба входящего жива ($fgs)"
  [ "$notif" = 0 ] && ok "уведомление входящего убрано" || bad "уведомление входящего осталось"
}

kill_callee() {
  adb -s "$CALLEE" shell input keyevent KEYCODE_WAKEUP
  adb -s "$CALLEE" shell input keyevent KEYCODE_HOME
  sleep 2
  for _ in 1 2 3; do
    adb -s "$CALLEE" shell am kill "$PKG"
    sleep 2
    [ -z "$(adb -s "$CALLEE" shell pidof "$PKG")" ] && return 0
  done
  bad "процесс на $CALLEE не убивается"
}

start_call() { flow "$CALLER" call-start.yaml -e FRIEND="$FRIEND"; }

# Чем Android показал входящий: нативный экран (IncomingCallActivity) или плашка (уведомление FGS).
report_incoming_path() {
  local top
  for _ in $(seq 1 30); do
    top=$(adb -s "$CALLEE" shell dumpsys activity activities | grep -m1 topResumedActivity)
    case "$top" in *IncomingCallActivity*) echo "  · путь: нативный экран"; return;; esac
    [ "$(incoming_notif "$CALLEE")" != 0 ] && { echo "  · путь: плашка с кнопками"; return; }
    sleep 0.5
  done
  echo "  · путь: входящий не появился"
}

# Перед следующим сценарием оба телефона свободны: нет входящего, службы звонка и режима звонка.
wait_idle() {
  local busy
  for _ in $(seq 1 60); do
    busy=0
    adb -s "$CALLEE" shell dumpsys activity activities | grep -m1 topResumedActivity | grep -q IncomingCallActivity && busy=1
    adb -s "$CALLEE" shell dumpsys activity services "$PKG" | grep -qE 'IncomingCallForegroundService|ActiveCallForegroundService' && busy=1
    [ "$(audio_mode "$CALLEE")" = MODE_NORMAL ] || busy=1
    [ "$(audio_mode "$CALLER")" = MODE_NORMAL ] || busy=1
    [ $busy = 0 ] && return 0
    sleep 1
  done
  echo "  ! телефоны не освободились за 60 с — следующий сценарий может упасть из-за этого"
}

scenario_killed_decline() {
  kill_callee
  start_call || return
  report_incoming_path
  flow "$CALLEE" incoming-decline.yaml
  flow "$CALLER" call-gone.yaml
  expect_mode "$CALLEE" MODE_NORMAL 4
  expect_clean_incoming
}

scenario_killed_answer() {
  kill_callee
  start_call || return
  report_incoming_path
  flow "$CALLEE" incoming-answer.yaml || return
  flow "$CALLER" in-call.yaml
  expect_mode "$CALLEE" MODE_IN_COMMUNICATION 4
  flow "$CALLEE" hangup.yaml
  flow "$CALLER" call-gone.yaml
  expect_mode "$CALLEE" MODE_NORMAL 4
}

# Ответ из убитого приложения кладёт extras ответа в intent задачи; повторное открытие после смерти
# процесса не должно показывать экран звонка (было ~0.7 с мелькания на каждом открытии).
scenario_reopen_after_answer() {
  kill_callee
  sleep 25
  flow "$CALLEE" reopen-home.yaml
  expect_mode "$CALLEE" MODE_NORMAL 2
}

scenario_native_decline_foreground() {
  flow "$CALLEE" smoke.yaml || return
  start_call || return
  flow "$CALLEE" native-decline.yaml
  flow "$CALLER" call-gone.yaml
  expect_mode "$CALLEE" MODE_NORMAL 4
}

# Убитое приложение с разрешением «поверх других приложений»: FCM открывает экран сам, без FGS и
# без JS — после отказа телефон раньше оставался в MODE_RINGTONE.
scenario_native_decline_overlay() {
  local before
  before=$(adb -s "$CALLEE" shell appops get "$PKG" SYSTEM_ALERT_WINDOW | grep -oE 'allow|ignore|deny|default' | head -1)
  adb -s "$CALLEE" shell appops set "$PKG" SYSTEM_ALERT_WINDOW allow
  kill_callee
  if start_call; then
    flow "$CALLEE" native-decline.yaml
    flow "$CALLER" call-gone.yaml
    expect_mode "$CALLEE" MODE_NORMAL 4
    expect_clean_incoming
  fi
  adb -s "$CALLEE" shell appops set "$PKG" SYSTEM_ALERT_WINDOW "${before:-default}"
}

# Видеозвонок и все переходы окна на стороне CALLEE; после каждого — звонок жив, камера, маршрут звука.
# want_route: earpiece (по умолчанию у звонка) или speaker (включаем кнопкой «Динамик»).
video_pip_round() {
  local want_route=$1
  flow "$CALLEE" smoke.yaml || return
  start_call || return
  flow "$CALLEE" native-answer.yaml || return
  flow "$CALLER" in-call.yaml
  if [ "$want_route" = speaker ]; then
    flow "$CALLEE" call-speaker.yaml
  fi
  expect_route "$CALLEE" "$want_route"

  echo "  · камера"
  flow "$CALLEE" call-camera.yaml
  expect_camera "$CALLEE" on 4
  flow "$CALLER" call-camera.yaml
  expect_camera "$CALLER" on 4
  expect_route "$CALLEE" "$want_route"

  echo "  · «пузырь» и обратно"
  flow "$CALLEE" call-minimize.yaml
  expect_mode "$CALLEE" MODE_IN_COMMUNICATION 2
  expect_camera "$CALLEE" on 2
  expect_route "$CALLEE" "$want_route"
  flow "$CALLEE" pip-expand.yaml
  expect_route "$CALLEE" "$want_route"

  echo "  · «Домой» с экрана звонка → системный PiP → назад"
  adb -s "$CALLEE" shell input keyevent KEYCODE_HOME
  expect_pinned "$CALLEE" yes 5
  expect_mode "$CALLEE" MODE_IN_COMMUNICATION 2
  expect_route "$CALLEE" "$want_route"
  reopen "$CALLEE"
  flow "$CALLEE" back-in-call.yaml
  expect_pinned "$CALLEE" no 5
  expect_route "$CALLEE" "$want_route"

  echo "  · «пузырь» → «Домой» → системный PiP → назад"
  flow "$CALLEE" call-minimize.yaml
  adb -s "$CALLEE" shell input keyevent KEYCODE_HOME
  expect_pinned "$CALLEE" yes 5
  expect_route "$CALLEE" "$want_route"
  reopen "$CALLEE"
  flow "$CALLEE" back-in-call.yaml
  expect_route "$CALLEE" "$want_route"

  echo "  · «Недавние» → системный PiP → назад"
  adb -s "$CALLEE" shell input keyevent KEYCODE_APP_SWITCH
  expect_pinned "$CALLEE" yes 5
  expect_route "$CALLEE" "$want_route"
  adb -s "$CALLEE" shell input keyevent KEYCODE_HOME
  sleep 1
  reopen "$CALLEE"
  flow "$CALLEE" back-in-call.yaml
  expect_route "$CALLEE" "$want_route"
  expect_camera "$CALLEE" on 2

  echo "  · камера выкл и отбой"
  flow "$CALLEE" call-camera.yaml
  expect_camera "$CALLEE" off 4
  flow "$CALLEE" hangup.yaml
  flow "$CALLER" call-gone.yaml
  expect_mode "$CALLEE" MODE_NORMAL 4
  expect_mode "$CALLER" MODE_NORMAL 4
  expect_camera "$CALLER" off 4
}

scenario_video_pip_earpiece() { video_pip_round earpiece; }
scenario_video_pip_speaker() { video_pip_round speaker; }

# Экран CALLEE не гаснет и не блокируется посреди прогона; исходная настройка возвращается в конце.
STAY_ON_BEFORE=$(adb -s "$CALLEE" shell settings get global stay_on_while_plugged_in | tr -d '\r')
adb -s "$CALLEE" shell settings put global stay_on_while_plugged_in 7
trap 'adb -s "$CALLEE" shell settings put global stay_on_while_plugged_in "${STAY_ON_BEFORE:-0}"' EXIT
adb -s "$CALLEE" shell input keyevent KEYCODE_WAKEUP

ALL=(killed_decline killed_answer reopen_after_answer native_decline_foreground native_decline_overlay
  video_pip_earpiece video_pip_speaker)
SCENARIOS=("$@")
[ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=("${ALL[@]}")

echo "caller=$CALLER callee=$CALLEE friend=$FRIEND логи: $LOG_DIR"
for s in "${SCENARIOS[@]}"; do
  CURRENT=$s
  echo "▶ $s"
  "scenario_$s"
  wait_idle
done

echo
if [ ${#FAILS[@]} -eq 0 ]; then
  echo "ВСЁ ПРОШЛО (${#SCENARIOS[@]} сценариев)"
  exit 0
fi
echo "ПРОВАЛЕНО: ${#FAILS[@]}"
printf '  %s\n' "${FAILS[@]}"
exit 1
