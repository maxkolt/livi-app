/**
 * Capacity: отправка client-metrics на backend для SLO (join time, RTT, packet loss, failure).
 * POST /api/capacity/client-metrics
 * Отключено: ранее отправлялось только на staging; staging убран из проекта.
 */
export type ClientMetricsPayload = {
  joinTimeMs?: number;
  remoteMediaFirstSeenMs?: number;
  /** Ответ сервера на call:accept до продолжения ( callee ). */
  acceptAckLatencyMs?: number;
  /** Room.connect до состояния connected ( LiveKit ). */
  livekitConnectLatencyMs?: number;
  /** Публикация локальных треков после join. */
  publishLatencyMs?: number;
  /** Первый удалённый трек после publish (или после join, если publish не зафиксирован ). */
  subscribeLatencyMs?: number;
  /** От начала call:accept ack до первого удалённого медиа ( friend call ). */
  timeToFirstRemoteFrameMs?: number;
  /** Пакет стадий при remote media first seen (сервер может агрегировать по флагу ). */
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
};

function optNonNegInt(n: unknown): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

export async function sendClientMetrics(
  apiBase: string,
  payload: ClientMetricsPayload
): Promise<void> {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!base) return;

  const normalized: ClientMetricsPayload = {
    joinTimeMs: typeof payload.joinTimeMs === 'number' && payload.joinTimeMs >= 0 ? payload.joinTimeMs : undefined,
    remoteMediaFirstSeenMs:
      typeof payload.remoteMediaFirstSeenMs === 'number' && payload.remoteMediaFirstSeenMs >= 0
        ? payload.remoteMediaFirstSeenMs
        : undefined,
    acceptAckLatencyMs:
      typeof payload.acceptAckLatencyMs === 'number' && payload.acceptAckLatencyMs >= 0
        ? payload.acceptAckLatencyMs
        : undefined,
    livekitConnectLatencyMs:
      typeof payload.livekitConnectLatencyMs === 'number' && payload.livekitConnectLatencyMs >= 0
        ? payload.livekitConnectLatencyMs
        : undefined,
    publishLatencyMs:
      typeof payload.publishLatencyMs === 'number' && payload.publishLatencyMs >= 0
        ? payload.publishLatencyMs
        : undefined,
    subscribeLatencyMs:
      typeof payload.subscribeLatencyMs === 'number' && payload.subscribeLatencyMs >= 0
        ? payload.subscribeLatencyMs
        : undefined,
    timeToFirstRemoteFrameMs:
      typeof payload.timeToFirstRemoteFrameMs === 'number' && payload.timeToFirstRemoteFrameMs >= 0
        ? payload.timeToFirstRemoteFrameMs
        : undefined,
    remoteMediaStageBreakdown: payload.remoteMediaStageBreakdown ? true : undefined,
    rttMs: typeof payload.rttMs === 'number' && payload.rttMs >= 0 ? payload.rttMs : undefined,
    packetLoss: typeof payload.packetLoss === 'number' && payload.packetLoss >= 0 ? payload.packetLoss : undefined,
    reconnect: !!payload.reconnect || undefined,
    joinSuccess: !!payload.joinSuccess || undefined,
    joinFailure: !!payload.joinFailure || undefined,
    roomReconnecting: !!payload.roomReconnecting || undefined,
    roomReconnected: !!payload.roomReconnected || undefined,
    remoteParticipantConnected: !!payload.remoteParticipantConnected || undefined,
    remoteMediaTimeout: !!payload.remoteMediaTimeout || undefined,
    remoteMediaRecovered: !!payload.remoteMediaRecovered || undefined,
    relayFallback: !!payload.relayFallback || undefined,
    remoteMediaNoParticipantTimeout: !!payload.remoteMediaNoParticipantTimeout || undefined,
    remoteMediaNoParticipantAttempts: optNonNegInt(payload.remoteMediaNoParticipantAttempts),
  };

  const hasData = Object.values(normalized).some((value) => value !== undefined);
  if (!hasData) return;

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 4000) : null;

  try {
    await fetch(`${base}/api/capacity/client-metrics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(normalized),
      signal: controller?.signal,
    } as any);
  } catch {
    // Best-effort only: metrics must never affect call flow.
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
