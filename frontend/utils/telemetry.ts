import { NativeModules } from 'react-native';
import { logger } from './logger';
import { recordReleaseDiagnostic } from './releaseDiagnosticBridge';
import { redactLogValue } from './redactLog';

type Correlation = {
  callId?: string | null;
  roomId?: string | null;
  userId?: string | null;
};

type TelemetryPayload = Record<string, unknown> & Correlation;

const LOG_PREFIX = '[LIVI][REL]';
const ERROR_CATEGORIES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
  'AggregateError', 'AbortError', 'NetworkError', 'TimeoutError', 'SecurityError', 'NotAllowedError',
  'NotFoundError', 'InvalidStateError', 'OperationError', 'NotSupportedError', 'QuotaExceededError',
]);

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

function sanitizeTelemetryPayload(payload: TelemetryPayload): TelemetryPayload {
  const redacted = redactLogValue(normalizeCorrelation(payload));
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? redacted as TelemetryPayload
    : {};
}

function errorCategory(error: unknown): string {
  // An error message can contain arbitrary user content; pattern matching cannot make it safe.
  // Only known categories cross the native bridge, including for caller-defined Error names.
  return error instanceof Error && ERROR_CATEGORIES.has(error.name) ? error.name : 'Error';
}

function logRelease(tag: string, message: string, payload: TelemetryPayload = {}): void {
  const normalized = normalizeCorrelation(payload);
  logger.info(`${LOG_PREFIX}[${tag}] ${message}`, normalized);
}

export function trackReleaseEvent(event: string, payload: TelemetryPayload = {}): void {
  recordReleaseDiagnostic(event, 'info', payload);
  const normalized = sanitizeTelemetryPayload(payload);
  logRelease('event', event, normalized);
  try {
    NativeModules.LiviAppModule?.trackAppEvent?.(String(event), toJsonSafe(normalized));
  } catch {}
}

export function trackReleaseError(event: string, error: unknown, payload: TelemetryPayload = {}): void {
  const errorName = errorCategory(error);
  recordReleaseDiagnostic(event, 'error', { ...payload, errorName });
  const normalized = sanitizeTelemetryPayload({ ...payload, errorName });

  logger.warn(`${LOG_PREFIX}[error] ${event}`, normalized);
  try {
    NativeModules.LiviAppModule?.trackAppError?.(
      String(event),
      errorName,
      toJsonSafe(normalized)
    );
  } catch {}
}
