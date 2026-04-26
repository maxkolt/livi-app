import { OUTGOING_CALL_TIMEOUT_MS } from './callKeep';

const INCOMING_CALL_STALE_GRACE_MS = 2_000;

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

export function isIncomingCallExpired(input: { expiresAt?: unknown; ts?: unknown }, nowMs: number = Date.now()): boolean {
  const expiresAtMs = resolveIncomingCallExpiresAtMs(input);
  if (expiresAtMs == null) return false;
  return nowMs > expiresAtMs + INCOMING_CALL_STALE_GRACE_MS;
}
