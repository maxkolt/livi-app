/**
 * Perf-трассировка accept → VideoCall / кнопки звонка.
 * Фильтр в Metro: `[call-perf]`
 * Два телефона на одном Metro различаем по `dev` (хвост userId / install tag).
 */
import { logger } from './logger';

const TAG = '[call-perf]';

export type CallPerfRole = 'caller' | 'callee' | 'unknown';

type TraceState = {
  callId: string;
  role: CallPerfRole;
  reason: string;
  startedAt: number;
  lastAt: number;
  lastPhase: string;
  seq: number;
};

function g(): any {
  return global as any;
}

function ensureDeviceTag(): string {
  try {
    const ref = (g().__callPerfDeviceTagRef = g().__callPerfDeviceTagRef || { current: '' });
    if (ref.current) return String(ref.current);
    const uid = String(
      g().__currentUserIdRef?.current ||
        g().__myUserIdRef?.current ||
        '',
    ).trim();
    if (uid.length >= 4) {
      ref.current = uid.slice(-4);
      return ref.current;
    }
  } catch {}
  return '?';
}

/** Вызвать после известного userId / installId, чтобы логи двух устройств не смешивались. */
export function setCallPerfDeviceTag(tag: string): void {
  try {
    const t = String(tag || '').trim();
    if (!t) return;
    g().__callPerfDeviceTagRef = g().__callPerfDeviceTagRef || { current: '' };
    g().__callPerfDeviceTagRef.current = t.length > 8 ? t.slice(-8) : t;
  } catch {}
}

function activeTrace(): TraceState | null {
  try {
    return (g().__callPerfTraceRef?.current as TraceState | null) || null;
  } catch {
    return null;
  }
}

function setActiveTrace(next: TraceState | null): void {
  try {
    g().__callPerfTraceRef = g().__callPerfTraceRef || { current: null };
    g().__callPerfTraceRef.current = next;
  } catch {}
}

function emit(phase: string, extra?: Record<string, unknown>): void {
  const tr = activeTrace();
  const now = Date.now();
  const seq = tr ? ++tr.seq : 0;
  const sinceStartMs = tr ? now - tr.startedAt : null;
  const sinceLastMs = tr ? now - tr.lastAt : null;
  if (tr) {
    tr.lastAt = now;
    tr.lastPhase = phase;
  }
  try {
    logger.info(TAG, {
      phase,
      seq,
      sinceStartMs,
      sinceLastMs,
      callId: tr?.callId ?? (extra?.callId as string | undefined) ?? null,
      role: tr?.role ?? (extra?.role as CallPerfRole | undefined) ?? 'unknown',
      reason: tr?.reason ?? null,
      dev: ensureDeviceTag(),
      ...extra,
      ts: now,
    });
  } catch {}
}

export function beginCallPerfTrace(opts: {
  callId: string;
  role: CallPerfRole;
  reason: string;
  extra?: Record<string, unknown>;
}): void {
  const callId = String(opts.callId || '').trim();
  if (!callId) {
    emit('begin_skipped_no_callId', { role: opts.role, reason: opts.reason, ...opts.extra });
    return;
  }
  const now = Date.now();
  const prev = activeTrace();
  if (prev && prev.callId === callId) {
    emit('begin_reuse', {
      role: opts.role,
      reason: opts.reason,
      prevRole: prev.role,
      prevReason: prev.reason,
      ...opts.extra,
    });
    prev.role = opts.role !== 'unknown' ? opts.role : prev.role;
    prev.reason = opts.reason || prev.reason;
    return;
  }
  if (prev && prev.callId !== callId) {
    emit('begin_replace', {
      prevCallId: prev.callId,
      prevRole: prev.role,
      prevPhase: prev.lastPhase,
      prevElapsedMs: now - prev.startedAt,
    });
  }
  setActiveTrace({
    callId,
    role: opts.role,
    reason: opts.reason,
    startedAt: now,
    lastAt: now,
    lastPhase: 'begin',
    seq: 0,
  });
  emit('begin', { role: opts.role, reason: opts.reason, ...opts.extra });
}

export function markCallPerf(phase: string, extra?: Record<string, unknown>): void {
  emit(phase, extra);
}

/** Одноразовый span: mark start + end с elapsedMs. */
export function callPerfSpan(
  phase: string,
  extra?: Record<string, unknown>,
): { end: (endExtra?: Record<string, unknown>) => void } {
  const t0 = Date.now();
  emit(`${phase}:start`, extra);
  return {
    end: (endExtra?: Record<string, unknown>) => {
      emit(`${phase}:done`, { ...extra, ...endExtra, elapsedMs: Date.now() - t0 });
    },
  };
}

export function endCallPerfTrace(phase = 'end', extra?: Record<string, unknown>): void {
  const tr = activeTrace();
  emit(phase, {
    ...extra,
    totalMs: tr ? Date.now() - tr.startedAt : null,
  });
  setActiveTrace(null);
}

/** Компактная метка audio-route (фильтр: phase=audio_route). */
export function markCallPerfAudioRoute(
  reason: string,
  route: string,
  extra?: Record<string, unknown>,
): void {
  emit('audio_route', { routeReason: reason, route, ...extra });
}
