/**
 * Capacity Stage A: отправка client-metrics на backend для SLO (join time, RTT, packet loss, failure).
 * POST /api/capacity/client-metrics
 * Отправляем только на staging (apiBase содержит "staging"), в проде не шлём.
 */
export type ClientMetricsPayload = {
  joinTimeMs?: number;
  rttMs?: number;
  packetLoss?: number;
  reconnect?: boolean;
  joinSuccess?: boolean;
  joinFailure?: boolean;
};

function isStagingApi(apiBase: string): boolean {
  const base = (apiBase || '').toLowerCase();
  return base.includes('staging');
}

export async function sendClientMetrics(
  apiBase: string,
  payload: ClientMetricsPayload
): Promise<void> {
  if (!isStagingApi(apiBase)) return;
  const url = `${apiBase.replace(/\/+$/, '')}/api/capacity/client-metrics`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Не логируем в консоль при ошибке, чтобы не засорять прод
      __DEV__ && console.warn('[capacityClientMetrics] POST failed', res.status, await res.text());
    }
  } catch (e) {
    __DEV__ && console.warn('[capacityClientMetrics]', (e as Error)?.message);
  }
}
