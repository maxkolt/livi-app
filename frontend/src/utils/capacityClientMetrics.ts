/**
 * Capacity: отправка client-metrics на backend для SLO (join time, RTT, packet loss, failure).
 * POST /api/capacity/client-metrics
 * Отключено: ранее отправлялось только на staging; staging убран из проекта.
 */
export type ClientMetricsPayload = {
  joinTimeMs?: number;
  rttMs?: number;
  packetLoss?: number;
  reconnect?: boolean;
  joinSuccess?: boolean;
  joinFailure?: boolean;
};

export async function sendClientMetrics(
  _apiBase: string,
  _payload: ClientMetricsPayload
): Promise<void> {
  // Отключено: staging убран из проекта.
}
