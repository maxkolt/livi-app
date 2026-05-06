import { OUTGOING_CALL_TIMEOUT_MS } from './callKeep';

function toFiniteMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function resolveIncomingCallExpiresAtMs(input: { expiresAt?: unknown; ts?: unknown }): number | null {
  const expiresAtMs = toFiniteMs(input?.expiresAt);
  if (expiresAtMs != null) return expiresAtMs;
  const createdAtMs = toFiniteMs(input?.ts);
  if (createdAtMs == null) return null;
  return createdAtMs + OUTGOING_CALL_TIMEOUT_MS;
}

/**
 * Ring window ended on the server (expiresAt is absolute ms in the push / socket payload).
 * Uses inclusive boundary to match backend expiry checks; no extra grace after expiresAt —
 * a grace window caused delayed FCM to still open native incoming briefly after a missed call.
 */
export function isIncomingCallExpired(input: { expiresAt?: unknown; ts?: unknown }, nowMs: number = Date.now()): boolean {
  const expiresAtMs = resolveIncomingCallExpiresAtMs(input);
  if (expiresAtMs == null) return false;
  return nowMs >= expiresAtMs;
}
