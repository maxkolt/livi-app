# Call Push Regression Matrix

Use this matrix for release verification of incoming call delivery.

## Core States

- `foreground`
- `background`
- `terminated`
- `locked screen`
- `device offline -> online`
- `VPN on`

## Android Checks

1. `foreground + online`
   - incoming UI appears once
   - no duplicate incoming screen from dual-signal FCM
2. `background + online`
   - native incoming UI appears
   - answer/decline actions work
3. `terminated + online`
   - native incoming UI appears from FCM
4. `offline for > ring timeout, then online`
   - no live incoming UI
   - only missed-call path is allowed
5. `socket reconnect during active ringing`
   - stale replay must not reopen expired call
6. `VPN on / unstable network`
   - retry + escalation path works
   - if `incoming_shown` is never acked, server logs retry/escalation

## iOS Checks

1. `foreground + online`
   - CallKeep / CallKit incoming appears once
2. `background + online`
   - CallKit appears from VoIP push
3. `terminated + online`
   - CallKit appears before JS is awake
4. `locked screen + online`
   - CallKit appears on lock screen
5. `offline for > ring timeout, then online`
   - stale delayed push does not show a live CallKit incoming
6. `caller canceled before answer`
   - CallKit closes promptly
7. `peer ended active call`
   - active CallKit call closes promptly

## Server Checks

For sampled calls, verify:

1. `/api/calls/metrics?windowMin=60`
   - `incomingShownRate`
   - `answeredSuccessRate`
   - `missedDueToDeliveryRate`
   - `latencyMs.incomingShownP95`
2. `/api/debug/push-log`
   - `call_push_sent_via_FCM`
   - `call_push_sent_via_FCM_notification_signal`
   - `call_push_sent_via_apns_voip`
   - `call_push_retry_data_only`
   - `call_push_retry_escalation`
3. `/api/calls/:callId/timeline-db`
   - `invite_sent`
   - `incoming_shown` or terminal reason
   - no impossible transitions

## Release Gate

Do not ship wider rollout if any of these fail:

- stale delayed delivery opens a live incoming UI
- duplicate incoming UI for same `callId`
- answer/decline from system UI does not reach server
- `incomingShownP95 > 3000ms`
- `missedDueToDeliveryRate` regresses versus baseline
