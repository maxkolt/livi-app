/**
 * Резервный адрес сигналинга LiveKit через основной API-домен.
 *
 * Некоторые VPN пропускают api.liviapp.com, но блокируют отдельный домен LiveKit.
 * В таком случае медиа ещё может пройти через TURN, однако до ICE дело не доходит:
 * сначала SDK обязан открыть WebSocket /rtc. Бэкенд проксирует этот WebSocket по
 * /livekit/rtc, поэтому клиент может повторить connect через уже доступный API-домен.
 */

export function buildLiveKitSignalProxyUrl(apiBase: string): string | null {
  try {
    const parsed = new URL(String(apiBase || '').trim());
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else return null;

    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/livekit`;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Ошибка произошла до PeerConnection — не открылся signaling WebSocket. */
export function isLikelyLiveKitSignalError(message: string): boolean {
  const value = String(message || '');
  return (
    /room connection has timed out\s*\(signal\)/i.test(value) ||
    /signal(?:ing)?[^\n]*(?:timed?\s*out|timeout|failed|error|closed)/i.test(value) ||
    /websocket[^\n]*(?:timed?\s*out|timeout|failed|error|closed|connect)/i.test(value) ||
    /(?:failed|unable) to connect[^\n]*(?:livekit|room|server)/i.test(value) ||
    /network request failed/i.test(value) ||
    /unable to resolve host|ename_not_resolved|host lookup/i.test(value)
  );
}

export function isLiveKitSignalProxyUrl(url: string, apiBase: string): boolean {
  const proxyUrl = buildLiveKitSignalProxyUrl(apiBase);
  if (!proxyUrl) return false;
  return String(url || '').replace(/\/+$/, '') === proxyUrl;
}
