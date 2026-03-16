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
const rttSamples: number[] = [];
const packetLossSamples: number[] = [];

let tokenRequestsTotal = 0;
let tokenErrorsTotal = 0;
let clientReconnectCount = 0;
let clientJoinSuccessCount = 0;
let clientJoinFailureCount = 0;

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
  rttMs?: number;
  packetLoss?: number;
  reconnect?: boolean;
  joinSuccess?: boolean;
  joinFailure?: boolean;
}) {
  if (!CAPACITY_METRICS_ENABLED) return;
  if (typeof data.joinTimeMs === 'number' && data.joinTimeMs >= 0) {
    pushSample(joinTimeSamples, data.joinTimeMs, MAX_SAMPLES);
  }
  if (typeof data.rttMs === 'number' && data.rttMs >= 0) {
    pushSample(rttSamples, data.rttMs, MAX_SAMPLES);
  }
  if (typeof data.packetLoss === 'number' && data.packetLoss >= 0) {
    pushSample(packetLossSamples, data.packetLoss, MAX_SAMPLES);
  }
  if (data.reconnect) clientReconnectCount += 1;
  if (data.joinSuccess) clientJoinSuccessCount += 1;
  if (data.joinFailure) clientJoinFailureCount += 1;
}

export function getStats() {
  const totalJoins = clientJoinSuccessCount + clientJoinFailureCount;
  const joinFailureRate = totalJoins > 0 ? (clientJoinFailureCount / totalJoins) * 100 : 0;
  return {
    tokenRequestsTotal,
    tokenErrorsTotal,
    tokenFailureRate: tokenRequestsTotal > 0 ? (tokenErrorsTotal / tokenRequestsTotal) * 100 : 0,
    joinTimeMs: { p95: p95(joinTimeSamples), samples: joinTimeSamples.length },
    rttMs: { p95: p95(rttSamples), samples: rttSamples.length },
    packetLoss: { p95: p95(packetLossSamples), samples: packetLossSamples.length },
    clientReconnectCount,
    clientJoinSuccessCount,
    clientJoinFailureCount,
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
  ];
  return lines.join('\n') + '\n';
}
