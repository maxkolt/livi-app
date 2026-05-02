/**
 * Метрики для capacity Stage A: join time, RTT, packet loss, token success/failure.
 * In-memory агрегация; клиент присылает sample через POST /api/capacity/client-metrics.
 * В проде отключено: задать CAPACITY_METRICS_ENABLED=1 для включения.
 */

const CAPACITY_METRICS_ENABLED = String(process.env.CAPACITY_METRICS_ENABLED || '').trim() === '1';

export function isCapacityMetricsEnabled(): boolean {
  return CAPACITY_METRICS_ENABLED;
}

const MAX_SAMPLES = 10_000;
const joinTimeSamples: number[] = [];
const remoteMediaFirstSeenSamples: number[] = [];
const acceptAckLatencySamples: number[] = [];
const livekitConnectLatencySamples: number[] = [];
const publishLatencySamples: number[] = [];
const subscribeLatencySamples: number[] = [];
const timeToFirstRemoteFrameSamples: number[] = [];
const remoteMediaNoParticipantAttemptsSamples: number[] = [];
const rttSamples: number[] = [];
const packetLossSamples: number[] = [];

let tokenRequestsTotal = 0;
let tokenErrorsTotal = 0;
let clientReconnectCount = 0;
let clientJoinSuccessCount = 0;
let clientJoinFailureCount = 0;
let clientRoomReconnectingCount = 0;
let clientRoomReconnectedCount = 0;
let clientRemoteParticipantConnectedCount = 0;
let clientRemoteMediaTimeoutCount = 0;
let clientRemoteMediaRecoveredCount = 0;
let clientRelayFallbackCount = 0;
let clientRemoteMediaNoParticipantTimeoutCount = 0;
let clientRemoteMediaStageBreakdownCount = 0;

function pushSample(arr: number[], value: number, max: number) {
  arr.push(value);
  if (arr.length > max) arr.shift();
}

function p95(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95) || 0;
  return sorted[idx] ?? 0;
}

export function recordTokenSuccess() {
  if (!CAPACITY_METRICS_ENABLED) return;
  tokenRequestsTotal += 1;
}

export function recordTokenFailure() {
  if (!CAPACITY_METRICS_ENABLED) return;
  tokenRequestsTotal += 1;
  tokenErrorsTotal += 1;
}

export function recordClientMetrics(data: {
  joinTimeMs?: number;
  remoteMediaFirstSeenMs?: number;
  acceptAckLatencyMs?: number;
  livekitConnectLatencyMs?: number;
  publishLatencyMs?: number;
  subscribeLatencyMs?: number;
  timeToFirstRemoteFrameMs?: number;
  remoteMediaStageBreakdown?: boolean;
  rttMs?: number;
  packetLoss?: number;
  reconnect?: boolean;
  joinSuccess?: boolean;
  joinFailure?: boolean;
  roomReconnecting?: boolean;
  roomReconnected?: boolean;
  remoteParticipantConnected?: boolean;
  remoteMediaTimeout?: boolean;
  remoteMediaRecovered?: boolean;
  relayFallback?: boolean;
  remoteMediaNoParticipantTimeout?: boolean;
  remoteMediaNoParticipantAttempts?: number;
}) {
  if (!CAPACITY_METRICS_ENABLED) return;
  if (typeof data.joinTimeMs === 'number' && data.joinTimeMs >= 0) {
    pushSample(joinTimeSamples, data.joinTimeMs, MAX_SAMPLES);
  }
  if (typeof data.remoteMediaFirstSeenMs === 'number' && data.remoteMediaFirstSeenMs >= 0) {
    pushSample(remoteMediaFirstSeenSamples, data.remoteMediaFirstSeenMs, MAX_SAMPLES);
  }
  if (typeof data.acceptAckLatencyMs === 'number' && data.acceptAckLatencyMs >= 0) {
    pushSample(acceptAckLatencySamples, data.acceptAckLatencyMs, MAX_SAMPLES);
  }
  if (typeof data.livekitConnectLatencyMs === 'number' && data.livekitConnectLatencyMs >= 0) {
    pushSample(livekitConnectLatencySamples, data.livekitConnectLatencyMs, MAX_SAMPLES);
  }
  if (typeof data.publishLatencyMs === 'number' && data.publishLatencyMs >= 0) {
    pushSample(publishLatencySamples, data.publishLatencyMs, MAX_SAMPLES);
  }
  if (typeof data.subscribeLatencyMs === 'number' && data.subscribeLatencyMs >= 0) {
    pushSample(subscribeLatencySamples, data.subscribeLatencyMs, MAX_SAMPLES);
  }
  if (typeof data.timeToFirstRemoteFrameMs === 'number' && data.timeToFirstRemoteFrameMs >= 0) {
    pushSample(timeToFirstRemoteFrameSamples, data.timeToFirstRemoteFrameMs, MAX_SAMPLES);
  }
  if (data.remoteMediaStageBreakdown) clientRemoteMediaStageBreakdownCount += 1;
  if (typeof data.rttMs === 'number' && data.rttMs >= 0) {
    pushSample(rttSamples, data.rttMs, MAX_SAMPLES);
  }
  if (typeof data.packetLoss === 'number' && data.packetLoss >= 0) {
    pushSample(packetLossSamples, data.packetLoss, MAX_SAMPLES);
  }
  if (data.reconnect) clientReconnectCount += 1;
  if (data.joinSuccess) clientJoinSuccessCount += 1;
  if (data.joinFailure) clientJoinFailureCount += 1;
  if (data.roomReconnecting) clientRoomReconnectingCount += 1;
  if (data.roomReconnected) clientRoomReconnectedCount += 1;
  if (data.remoteParticipantConnected) clientRemoteParticipantConnectedCount += 1;
  if (data.remoteMediaTimeout) clientRemoteMediaTimeoutCount += 1;
  if (data.remoteMediaRecovered) clientRemoteMediaRecoveredCount += 1;
  if (data.relayFallback) clientRelayFallbackCount += 1;
  if (data.remoteMediaNoParticipantTimeout) clientRemoteMediaNoParticipantTimeoutCount += 1;
  if (
    typeof data.remoteMediaNoParticipantAttempts === 'number' &&
    data.remoteMediaNoParticipantAttempts >= 0
  ) {
    pushSample(remoteMediaNoParticipantAttemptsSamples, data.remoteMediaNoParticipantAttempts, MAX_SAMPLES);
  }
}

export function getStats() {
  const totalJoins = clientJoinSuccessCount + clientJoinFailureCount;
  const joinFailureRate = totalJoins > 0 ? (clientJoinFailureCount / totalJoins) * 100 : 0;
  return {
    tokenRequestsTotal,
    tokenErrorsTotal,
    tokenFailureRate: tokenRequestsTotal > 0 ? (tokenErrorsTotal / tokenRequestsTotal) * 100 : 0,
    joinTimeMs: { p95: p95(joinTimeSamples), samples: joinTimeSamples.length },
    remoteMediaFirstSeenMs: { p95: p95(remoteMediaFirstSeenSamples), samples: remoteMediaFirstSeenSamples.length },
    acceptAckLatencyMs: { p95: p95(acceptAckLatencySamples), samples: acceptAckLatencySamples.length },
    livekitConnectLatencyMs: { p95: p95(livekitConnectLatencySamples), samples: livekitConnectLatencySamples.length },
    publishLatencyMs: { p95: p95(publishLatencySamples), samples: publishLatencySamples.length },
    subscribeLatencyMs: { p95: p95(subscribeLatencySamples), samples: subscribeLatencySamples.length },
    timeToFirstRemoteFrameMs: { p95: p95(timeToFirstRemoteFrameSamples), samples: timeToFirstRemoteFrameSamples.length },
    remoteMediaNoParticipantAttempts: {
      p95: p95(remoteMediaNoParticipantAttemptsSamples),
      samples: remoteMediaNoParticipantAttemptsSamples.length,
    },
    clientRemoteMediaNoParticipantTimeoutCount,
    clientRemoteMediaStageBreakdownCount,
    rttMs: { p95: p95(rttSamples), samples: rttSamples.length },
    packetLoss: { p95: p95(packetLossSamples), samples: packetLossSamples.length },
    clientReconnectCount,
    clientJoinSuccessCount,
    clientJoinFailureCount,
    clientRoomReconnectingCount,
    clientRoomReconnectedCount,
    clientRemoteParticipantConnectedCount,
    clientRemoteMediaTimeoutCount,
    clientRemoteMediaRecoveredCount,
    clientRelayFallbackCount,
    joinFailureRate,
  };
}

/** Prometheus text format для /metrics */
export function getPrometheusText(): string {
  const s = getStats();
  const lines: string[] = [
    '# HELP livi_token_requests_total Total LiveKit token requests',
    '# TYPE livi_token_requests_total counter',
    `livi_token_requests_total ${s.tokenRequestsTotal}`,
    '# HELP livi_token_errors_total Total LiveKit token errors',
    '# TYPE livi_token_errors_total counter',
    `livi_token_errors_total ${s.tokenErrorsTotal}`,
    '# HELP livi_join_time_ms_p95 P95 join time (ms) from client reports',
    '# TYPE livi_join_time_ms_p95 gauge',
    `livi_join_time_ms_p95 ${s.joinTimeMs.p95}`,
    '# HELP livi_remote_media_first_seen_ms_p95 P95 time to first remote media after room connect (ms)',
    '# TYPE livi_remote_media_first_seen_ms_p95 gauge',
    `livi_remote_media_first_seen_ms_p95 ${s.remoteMediaFirstSeenMs.p95}`,
    '# HELP livi_accept_ack_latency_ms_p95 P95 call:accept ack latency (ms)',
    '# TYPE livi_accept_ack_latency_ms_p95 gauge',
    `livi_accept_ack_latency_ms_p95 ${s.acceptAckLatencyMs.p95}`,
    '# HELP livi_livekit_connect_latency_ms_p95 P95 LiveKit Room.connect latency (ms)',
    '# TYPE livi_livekit_connect_latency_ms_p95 gauge',
    `livi_livekit_connect_latency_ms_p95 ${s.livekitConnectLatencyMs.p95}`,
    '# HELP livi_publish_latency_ms_p95 P95 publish latency after join (ms)',
    '# TYPE livi_publish_latency_ms_p95 gauge',
    `livi_publish_latency_ms_p95 ${s.publishLatencyMs.p95}`,
    '# HELP livi_subscribe_latency_ms_p95 P95 subscribe latency (ms)',
    '# TYPE livi_subscribe_latency_ms_p95 gauge',
    `livi_subscribe_latency_ms_p95 ${s.subscribeLatencyMs.p95}`,
    '# HELP livi_time_to_first_remote_frame_ms_p95 P95 time from accept ack to first remote frame (ms)',
    '# TYPE livi_time_to_first_remote_frame_ms_p95 gauge',
    `livi_time_to_first_remote_frame_ms_p95 ${s.timeToFirstRemoteFrameMs.p95}`,
    '# HELP livi_remote_media_stage_breakdown_total Bundled stage-breakdown payloads from clients',
    '# TYPE livi_remote_media_stage_breakdown_total counter',
    `livi_remote_media_stage_breakdown_total ${s.clientRemoteMediaStageBreakdownCount}`,
    '# HELP livi_remote_media_no_participant_timeout_total Watchdog: no remote participant in room',
    '# TYPE livi_remote_media_no_participant_timeout_total counter',
    `livi_remote_media_no_participant_timeout_total ${s.clientRemoteMediaNoParticipantTimeoutCount}`,
    '# HELP livi_rtt_ms_p95 P95 RTT (ms) from client reports',
    '# TYPE livi_rtt_ms_p95 gauge',
    `livi_rtt_ms_p95 ${s.rttMs.p95}`,
    '# HELP livi_packet_loss_p95 P95 packet loss from client reports',
    '# TYPE livi_packet_loss_p95 gauge',
    `livi_packet_loss_p95 ${s.packetLoss.p95}`,
    '# HELP livi_client_reconnects_total Client reconnect count',
    '# TYPE livi_client_reconnects_total counter',
    `livi_client_reconnects_total ${s.clientReconnectCount}`,
    '# HELP livi_join_success_total Client join success count',
    '# TYPE livi_join_success_total counter',
    `livi_join_success_total ${s.clientJoinSuccessCount}`,
    '# HELP livi_join_failures_total Client join failure count',
    '# TYPE livi_join_failures_total counter',
    `livi_join_failures_total ${s.clientJoinFailureCount}`,
    '# HELP livi_room_reconnecting_total Client room reconnecting events',
    '# TYPE livi_room_reconnecting_total counter',
    `livi_room_reconnecting_total ${s.clientRoomReconnectingCount}`,
    '# HELP livi_room_reconnected_total Client room reconnected events',
    '# TYPE livi_room_reconnected_total counter',
    `livi_room_reconnected_total ${s.clientRoomReconnectedCount}`,
    '# HELP livi_remote_participant_connected_total Remote participant connected events observed by clients',
    '# TYPE livi_remote_participant_connected_total counter',
    `livi_remote_participant_connected_total ${s.clientRemoteParticipantConnectedCount}`,
    '# HELP livi_remote_media_timeouts_total Connected calls where remote media did not arrive in time',
    '# TYPE livi_remote_media_timeouts_total counter',
    `livi_remote_media_timeouts_total ${s.clientRemoteMediaTimeoutCount}`,
    '# HELP livi_remote_media_recovered_total Remote media watchdog recoveries that eventually received media',
    '# TYPE livi_remote_media_recovered_total counter',
    `livi_remote_media_recovered_total ${s.clientRemoteMediaRecoveredCount}`,
    '# HELP livi_relay_fallback_total Relay-only fallback attempts triggered by clients',
    '# TYPE livi_relay_fallback_total counter',
    `livi_relay_fallback_total ${s.clientRelayFallbackCount}`,
  ];
  return lines.join('\n') + '\n';
}
