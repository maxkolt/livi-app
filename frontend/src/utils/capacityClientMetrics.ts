/**
 * Capacity: отправка client-metrics на backend для SLO (join time, RTT, packet loss, failure).
 * POST /api/capacity/client-metrics
 * Отключено: ранее отправлялось только на staging; staging убран из проекта.
 */
export type ClientMetricsPayload = {
  joinTimeMs?: number;
  remoteMediaFirstSeenMs?: number;
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
};

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
