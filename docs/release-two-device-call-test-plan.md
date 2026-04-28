# Release Test Plan (2 Devices)

This checklist is optimized for a release validation run where logs are captured from one Android device.

## Preconditions

- Both devices are on the same production release build.
- Test account A and B are ready (no personal identifiers in logs).
- Log capture enabled on device A (single source of truth).
- Notification permissions granted on both devices.
- Battery optimization status noted for both devices.

## Observability Checklist

- Verify logs include `[LIVI][REL]` prefix for:
  - signaling reconnect (`signal_reconnect`)
  - PiP transitions (`pip_enter_exit`)
  - notification taps (`notification_tap`)
  - CometChat login problems (`cometchat_login_failed`)
  - foreground service in background (`fgs_start_background`)
- Verify Firebase Analytics receives `livi_*` events.
- Verify Crashlytics receives non-fatal telemetry for failure branches.

## Network Scenarios

- **Wi-Fi -> LTE handover**
  - Start active video call, switch device A from Wi-Fi to LTE.
  - Expect reconnect and media recovery without forced call end.
- **LTE -> Wi-Fi handover**
  - Repeat in reverse direction.
- **VPN on/off**
  - Start call with VPN enabled, then disable VPN during call.
  - Repeat from no VPN to VPN enabled.
- **30-60s network drop**
  - Disable data + Wi-Fi on one device for 30-60 seconds.
  - Re-enable connectivity and verify reconnect behavior.

## Background / Incoming Flow

- Put app to background on device B.
- Trigger incoming call from device A.
- Verify incoming UI path + FGS behavior on device B.
- Verify `fgs_start_background` is logged once per background start path.

## Notification Interaction During Call

- While active call is ongoing, tap a message notification on one device.
- Verify call state is preserved and navigation remains deterministic.
- Verify `notification_tap` event contains correlation fields (`callId`, `roomId`, `userId` when available).

## PiP Scenarios

- Enter in-app PiP, then Home -> system PiP.
- Exit PiP via:
  - expand,
  - close (X),
  - remote hangup.
- Verify `pip_enter_exit` sequence is consistent and no double-source UI state conflicts occur.

## Exact Alarm Disabled Scenario

- Disable exact alarms in system settings (Android 12+).
- Trigger call/message notification flows.
- Verify app remains functional with fallback behavior and no hard failures.

## Pass Criteria

- No fatal crashes in all scenarios.
- No duplicate finish/navigation loops.
- Reconnect scenarios recover media/session as expected.
- Telemetry events are visible and correlated for triage.
