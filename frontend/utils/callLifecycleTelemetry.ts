/**
 * Телеметрия машины состояний звонка (utils/callLifecycle) — в релиз, на поведение не влияет.
 *
 * call_outcome — одно событие на звонок: чем кончился (соединился / принят, но медиа не пошло /
 * не ответили) и сколько длились дозвон, соединение и разговор. Из него считаются доля
 * состоявшихся звонков и время от ответа до медиа.
 *
 * call_lifecycle_mismatch — теневая сверка: старые флаги и машина ответили по-разному. Это данные
 * для перевода читателей на машину; logger.warn в релизе никуда не уходит.
 */
import { getCallLifecycle, isCallMediaLive, subscribeCallLifecycle } from './callLifecycle';
import { logger } from './logger';
import { trackReleaseError, trackReleaseEvent } from './telemetry';

type CallOutcome = 'connected' | 'connect_failed' | 'not_answered';

/** null в JSON доходит до Firebase строкой "null" — пустые поля не отправляем. */
function withoutEmpty(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

let unsubscribeOutcome: (() => void) | null = null;

export function installCallOutcomeTelemetry(): void {
  if (unsubscribeOutcome) return;
  let callId: string | null = null;
  let role: string | null = null;
  // 0 — фазу не проходили (ответ из убитого приложения начинается сразу с connecting).
  let ringAt = 0;
  let acceptedAt = 0;
  let activeAt = 0;
  let endingAt = 0;
  unsubscribeOutcome = subscribeCallLifecycle((next, prev) => {
    if (prev.phase === 'idle') {
      callId = null;
      role = null;
      ringAt = acceptedAt = activeAt = endingAt = 0;
    }
    if (next.callId) callId = next.callId;
    if (next.role) role = next.role;
    if (next.phase === prev.phase) return;
    if (next.phase === 'outgoing' || next.phase === 'incoming') ringAt = next.since;
    else if (next.phase === 'connecting') acceptedAt = next.since;
    else if (next.phase === 'active') activeAt = next.since;
    else if (next.phase === 'ending') endingAt = next.since;
    else {
      const end = endingAt || next.since;
      const outcome: CallOutcome = activeAt ? 'connected' : acceptedAt ? 'connect_failed' : 'not_answered';
      trackReleaseEvent(
        'call_outcome',
        withoutEmpty({
          outcome,
          reason: next.endReason,
          role,
          callId,
          ringMs: ringAt ? (acceptedAt || end) - ringAt : null,
          connectMs: acceptedAt && activeAt ? activeAt - acceptedAt : null,
          talkMs: activeAt ? end - activeAt : null,
        }),
      );
    }
  });
}

const MISMATCH_REPORT_CAP = 10;
let mismatchReports = 0;
let openMismatch: { key: string; at: number; reported: boolean } | null = null;

/**
 * Теневая сверка «идёт ли звонок»: ответ флагов (legacy) против машины. Ничего не меняет — сообщает
 * о начале расхождения (Crashlytics, со снимком флагов) и о его конце (сколько длилось).
 */
export function shadowCompareWithLifecycle(
  reader: string,
  legacy: boolean,
  describeFlags: () => Record<string, unknown>,
): void {
  const lc = getCallLifecycle();
  const machine = isCallMediaLive();
  const key = legacy === machine ? '' : `${legacy}|${lc.phase}|${lc.callId ?? ''}`;
  if (key === (openMismatch?.key ?? '')) return;
  const now = Date.now();
  if (openMismatch?.reported) {
    trackReleaseEvent('call_lifecycle_mismatch_end', { reader, durationMs: now - openMismatch.at });
  }
  openMismatch = null;
  if (!key) return;
  logger.warn(`[callLifecycle] shadow mismatch ${reader}`, { legacy, phase: lc.phase, callId: lc.callId });
  const reported = mismatchReports < MISMATCH_REPORT_CAP;
  openMismatch = { key, at: now, reported };
  if (!reported) return;
  mismatchReports += 1;
  let flags: Record<string, unknown> = {};
  try {
    flags = describeFlags();
  } catch {}
  trackReleaseError(
    'call_lifecycle_mismatch',
    `${reader} flags=${legacy} machine=${machine}`,
    withoutEmpty({
      reader,
      legacy,
      phase: lc.phase,
      role: lc.role,
      callId: lc.callId,
      msInPhase: lc.since ? now - lc.since : null,
      ...flags,
    }),
  );
}

/** Только для тестов. */
export function __resetCallLifecycleTelemetryForTests(): void {
  unsubscribeOutcome?.();
  unsubscribeOutcome = null;
  mismatchReports = 0;
  openMismatch = null;
}
