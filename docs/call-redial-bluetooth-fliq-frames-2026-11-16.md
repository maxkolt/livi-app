# Call redial, Bluetooth, Fliq notice and call avatar frames — 2026-11-16

## Changes

- Call history now reaches the central call-start guard instead of dropping taps against a render-time lock. On Android, an orphaned incoming/busy flag is cleared only when the native ringing snapshot is explicitly null, no live session/PiP/outgoing attempt exists, and the incoming revision remains unchanged. Probe failure or timeout preserves the lock. A new incoming from the same peer also invalidates recovery.
- Bluetooth AUDIO_CONNECTING no longer emits an unplug. A lagging native poll during ACL → HFP/SCO setup cannot undo the selected BT route. Physical unplug and manual builtin choices invalidate pending reconnect work; late ICM list gains cannot resurrect a removed headset. Raw SCO rising requires a paired headset.
- Fliq shows one dismissible, ten-second notice per visit when YouTube cannot load over an otherwise connected network. Copy says access may be restricted by country or network and suggests enabling VPN. Language is not used as a country signal. Offline state, unavailable-video codes, renderer death and HTML5 media errors do not trigger the notice. Playback success hides it; stale async results cannot affect a later visit. The existing player recovery/seek/advance logic is unchanged.
- CallScreenChrome uses the shared AvatarImage and receives the partner user ID, including the incoming connecting cover. This restores the user's applied frame while retaining the 54 dp photo and existing placement.
- Safe diagnostic events retain call-start failure codes and recovery of stale call UI flags.

## Automated validation

- Frontend Jest: 127 suites, 1279 tests passed.
- TypeScript `tsc --noEmit`: passed.
- ESLint on all changed TS/TSX sources/tests: passed.
- Android `:app:testDebugUnitTest`: 4 suites, 12 tests, zero failures/errors.
- Android dev `:app:assembleDebug` for arm64-v8a: passed; installed on both test phones.
- `git diff --check`: passed.

## Physical devices

- S25 Ultra SM-S938B: R5GL550T4TB, LiVi Dev (`com.kolt12max.livi.dev`).
- A35 SM-A356E: RFCX306PWLE, LiVi Dev, user-confirmed owned test contact Ron.
- Production app data was not modified. Existing unrelated visual/build-number worktree edits were retained.

### Missed call

A35 called S25 while its dev process had been killed. The caller cancelled without an answer. After the actual missed notification appeared, the S25 process was killed again and the notification tapped. Calls opened with the Missed filter and the new row. One row tap started a real redial, which connected to Ron. A separate injected stale incoming-UI flag was cleared by the central native-confirmed guard; the subsequent attempt reached networking and showed the existing explicit connection-error UI during the VPN DNS outage. This injection validates the recovery path; it does not prove that the user's historical incident had the same cause.

### Bluetooth

Before the polling fix, device sampling recorded EAR → BT → EAR → BT during one physical connect, matching the user's observed flicker. After the fix, a fresh call recorded a single EAR → BT change and the user reported that it worked well. Additional case testing exposed stale reconnect completions and an ICM gain after unplug; generation checks and stricter reconnect gates were added. In the final fresh call, the user performed the requested connect/listen/case cycle and replied that it was done. The rendered button made exactly EAR → BT → EAR, with no return to BT for more than 40 seconds after the physical disconnect. The BT icon appeared approximately 104 ms after native ACL_CONNECTED; SCO became connected about 2.2 seconds after ACL. Returning to the case produced one final phone icon. The earlier clean connection was explicitly reported by the user as working well; the final response did not separately describe audibility in each direction. A route/SCO report alone is not proof of human audibility.

### Fliq / VPN

With the existing Privata VPN, real Shorts playback was visible and the notice absent. Without VPN, the actual YouTube load failed and the new notice appeared above the app navigation; a screenshot was saved. A reconnect of Privata initially produced a system DNS failure (including api.liviapp.com); a second reconnect restored DNS. LiVi displayed its existing explicit connection-error dialog during this outage. The VPN remained enabled afterward, and another fresh Fliq session visibly played a Short without the notice. Automatic recovery of the same previously stalled video across this prolonged VPN outage was not confirmed.

### Avatar frame

A fresh established S25 → Ron call showed Ron's live fire frame around the existing header avatar. The frame remains outside the photo and does not require changing call media/signalling.

## Cleanup

The final call was ended. Both phones returned to MODE_NORMAL (no call-mode owner). S25 reported no live session, no active-call flag, no PiP and no outgoing attempt. Temporary polling/diagnostic variables and the local logcat collector were stopped. Privata VPN was left connected with working DNS.

## Evidence

Local debug captures and logs are under `/private/tmp/livi-*20261116*` and `/private/tmp/livi-s25-*`, including the missed notification, missed filter, successful redial, Fliq with/without VPN, and framed call header. Bluetooth samples were collected from actual rendered icon props every 100 ms alongside native logcat events. They do not exclude a visual transient shorter than the sampling interval.

## Release boundary

Changes are in the working tree/dev app. No production deployment or commit/push was performed for this task. Shipping these client/native changes requires a new release build. This run does not certify other headset models, VPN providers, countries, or release-build lifecycle behavior.
