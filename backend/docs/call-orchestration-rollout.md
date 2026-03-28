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

## What Was Added

- Server-side call state machine (`invited -> incoming_shown -> accepted|declined|canceled|timeout`).
- Idempotent transitions for HTTP + socket races (`accept/decline/cancel/timeout`).
- Event timeline by `callId` (`invite_sent`, `push_sent`, `push_retry`, `push_escalated`, `incoming_shown`, `accepted|declined|canceled|timeout`, `end_reason`).
- Provider delivery hook endpoint for future provider integration.
- Runtime metrics for rollout control and rollback decisions.

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

## Rollout Sequence

1. Set `CALL_ORCHESTRATION_ENABLED=1`, `CALL_ROLLOUT_PERCENT=5`.
2. Verify metrics and random timeline samples every 2-4 hours.
3. Increase to `20 -> 50 -> 100` only if SLO stays stable.
4. Keep instant rollback path: set `CALL_ORCHESTRATION_ENABLED=0`.

## SLO Targets

- `incoming_shown` in <= 3s (p95).
- Stable `answeredSuccessRate`.
- `missedDueToDeliveryRate` below agreed error budget.
