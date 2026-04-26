# Call Orchestration Rollout

This document describes the safe rollout path for call orchestration in production.

## Feature Flags

- `CALL_ORCHESTRATION_ENABLED` (`1` by default): enables state machine + timeline.
- `CALL_PROVIDER_MODE` (`none` by default): provider path mode.
  - `none`: disable external call provider path (recommended for RU-only production).
  - `custom`: enable generic provider webhook adapter.
- `CALL_PROVIDER_SIGNALING_ENABLED` (legacy): backward-compatible switch; if `1` and `CALL_PROVIDER_MODE` is unset, mode becomes `custom`.
- `CALL_PUSH_FALLBACK_ENABLED` (`1` by default): marks push fallback policy in telemetry.
- `CALL_ROLLOUT_PERCENT` (`100` by default): deterministic rollout bucket by `callerId:calleeId`.
- `CALL_OBSERVABILITY_API_KEY` (optional): protects observability endpoints.
- `CALL_PROVIDER_WEBHOOK_SECRET` (optional): protects provider delivery webhook endpoint.
- `APNS_KEY_ID`, `APNS_TEAM_ID`: Apple APNs auth key identifiers for iOS VoIP pushes.
- `APNS_AUTH_KEY_PATH` or `APNS_AUTH_KEY_BASE64`: `.p8` private key for APNs VoIP provider.
- `APNS_BUNDLE_ID` (default `com.kolt12max.livi`): iOS bundle id used for `${bundleId}.voip` topic.
- `APNS_PRODUCTION` (`true` by default): switch APNs provider between sandbox and production.

## What Was Added

- Server-side call state machine (`invited -> incoming_shown -> accepted|declined|canceled|timeout`).
- Idempotent transitions for HTTP + socket races (`accept/decline/cancel/timeout`).
- Event timeline by `callId` (`invite_sent`, `push_sent`, `push_retry`, `push_escalated`, `incoming_shown`, `accepted|declined|canceled|timeout`, `end_reason`).
- Provider delivery hook endpoint for future provider integration.
- Runtime metrics for rollout control and rollback decisions.
- iOS VoIP push path:
  - backend stores `voipToken` per iOS install;
  - incoming call can be delivered via APNs VoIP and shown through CallKit before JS wakes up;
  - `call_canceled` / `call_ended` can close the same CallKit call by deterministic `callKitId`.

## Observability Endpoints

- `GET /api/calls/metrics?windowMin=60`
  - Returns totals and rates:
    - `incomingShownRate`
    - `answeredSuccessRate`
    - `missedDueToDeliveryRate` (timeouts without incoming shown)
  - Includes `latencyMs.incomingShownP95` for SLO check (`<= 3000ms` target).
  - Returns `source=db|memory` (DB is default, memory is fallback if DB read fails).
- `GET /api/calls/:callId/timeline`
  - Returns in-memory orchestration timeline for active/recent calls.
- `GET /api/calls/:callId/timeline-db`
  - Returns persistent Mongo timeline for historical/debug cases.
- `POST /api/calls/provider-delivered`
  - Body: `{ callId, provider, ...payload }`
  - Header: `x-provider-webhook-secret`
  - If `CALL_PROVIDER_MODE=none`, endpoint returns `provider_disabled`.
- `GET /api/debug/push-log`
  - Ring buffer of recent push delivery decisions (`FCM`, `Expo`, `APNs VoIP`, retry, escalation).
  - Useful for quick correlation while rolling out iOS VoIP or checking Android retry/escalation behavior.

## iOS VoIP Checklist

Before relying on iOS incoming calls in background / terminated state:

1. In Apple Developer, enable Push Notifications for the app id.
2. Ensure the provisioning profile contains APS entitlement.
3. Generate an APNs auth key (`.p8`) and configure backend envs listed above.
4. Build the iOS app with:
   - `Push Notifications` capability enabled,
   - `Background Modes -> Voice over IP`,
   - `Background Modes -> Remote notifications`.
5. Install on a real device. Simulator is not a valid verification target for PushKit/CallKit.
6. Open the app once after install and confirm `/api/push-token` registration includes `voipToken`.
7. Place an incoming call while the app is:
   - foreground,
   - background,
   - terminated,
   - device locked.
8. Confirm stale delayed delivery shows no live incoming UI after call expiry.

## Manual Acceptance Signals

Expected during healthy rollout:

- `/api/debug/push-log` contains `call_push_sent_via_apns_voip` for iOS installs that registered `voipToken`.
- `/api/calls/metrics` keeps `incomingShownP95 <= 3000ms`.
- For delayed/offline delivery, `missedDueToDeliveryRate` should not spike.
- A stale iOS delayed push must not open a live CallKit screen after `expiresAt`.

## Rollout Sequence

1. Set `CALL_ORCHESTRATION_ENABLED=1`, `CALL_ROLLOUT_PERCENT=5`.
2. Verify metrics and random timeline samples every 2-4 hours.
3. Increase to `20 -> 50 -> 100` only if SLO stays stable.
4. Keep instant rollback path: set `CALL_ORCHESTRATION_ENABLED=0`.

## SLO Targets

- `incoming_shown` in <= 3s (p95).
- Stable `answeredSuccessRate`.
- `missedDueToDeliveryRate` below agreed error budget.
