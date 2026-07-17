import { NativeModules } from 'react-native';
import { logger } from './logger';

type Correlation = {
  callId?: string | null;
  roomId?: string | null;
  userId?: string | null;
};

type TelemetryPayload = Record<string, unknown> & Correlation;

const LOG_PREFIX = '[LIVI][REL]';

function normalizeCorrelation(payload: TelemetryPayload): TelemetryPayload {
  const normalized: TelemetryPayload = { ...payload };
  if (normalized.callId != null) normalized.callId = String(normalized.callId || '').trim() || null;
  if (normalized.roomId != null) normalized.roomId = String(normalized.roomId || '').trim() || null;
  if (normalized.userId != null) normalized.userId = String(normalized.userId || '').trim() || null;
  return normalized;
}

function toJsonSafe(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return '{}';
  }
}

export function logRelease(tag: string, message: string, payload: TelemetryPayload = {}): void {
  const normalized = normalizeCorrelation(payload);
  logger.info(`${LOG_PREFIX}[${tag}] ${message}`, normalized);
}

export function trackReleaseEvent(event: string, payload: TelemetryPayload = {}): void {
  const normalized = normalizeCorrelation(payload);
  logRelease('event', event, normalized);
  try {
    NativeModules.LiviAppModule?.trackAppEvent?.(String(event), toJsonSafe(normalized));
  } catch {}
}

export function trackReleaseError(event: string, error: unknown, payload: TelemetryPayload = {}): void {
  const normalized = normalizeCorrelation(payload);
  const errorMessage =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error || 'unknown_error');

  logger.warn(`${LOG_PREFIX}[error] ${event}`, { ...normalized, errorMessage });
  try {
    NativeModules.LiviAppModule?.trackAppError?.(
      String(event),
      String(errorMessage).slice(0, 500),
      toJsonSafe(normalized)
    );
  } catch {}
}
