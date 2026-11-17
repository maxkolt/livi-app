const REFRESH_MARGIN_MS = 30_000;

export const isTurnUrl = (url: string): boolean => /^turns?:/i.test(url);

export function turnCredentialExpiry(server: RTCIceServer): number | null {
  // Our TURN REST usernames contain the expiration timestamp, not an account ID.
  const match = typeof server.username === 'string' ? server.username.match(/^(\d{10})(?::.*)?$/) : null;
  return match ? Number(match[1]) * 1000 : null;
}

export function hasFreshTurnCredentials(server: RTCIceServer, now: number): boolean {
  if (!server.username || !server.credential) return false;
  const until = turnCredentialExpiry(server);
  return until === null || until > now + REFRESH_MARGIN_MS;
}

export function iceCacheDeadline(servers: RTCIceServer[], ttl: unknown, requestedAt: number): number {
  const seconds = Number(ttl);
  const duration = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 300;
  let until = requestedAt + duration * 900;
  for (const server of servers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (!urls.some(isTurnUrl)) continue;
    const expiresAt = turnCredentialExpiry(server);
    if (expiresAt !== null) until = Math.min(until, expiresAt - REFRESH_MARGIN_MS);
  }
  return until;
}
