import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { logger } from './logger';
import { trackReleaseEvent } from './telemetry';

const LOG_TAG = '[LIVI][SYSPIP][home]';

/** Включить: `(global as any).__LIVI_SYS_PIP_HOME_TRACE__ = true` (см. scripts/capture-pip-debug-logs.sh). */
function isSysPiPHomeTraceEnabled(): boolean {
  try {
    return (global as any).__LIVI_SYS_PIP_HOME_TRACE__ === true;
  } catch {
    return false;
  }
}

export type HomePiPTracePhase =
  | 'native_on_user_leave_hint'
  | 'native_skip'
  | 'native_enter_attempt'
  | 'native_enter_result'
  | 'js_about_to_enter'
  | 'js_about_to_enter_skip'
  | 'js_leave_hint_arm'
  | 'js_leave_hint_disarm'
  | 'js_frame_ready'
  | 'js_mode_changed'
  | 'js_hide_in_app_for_system'
  | 'outcome';

type TracePayload = Record<string, unknown> & {
  traceId?: string;
  phase?: string;
  callId?: string | null;
  roomId?: string | null;
};

type OutcomeState = {
  traceId: string;
  startedAt: number;
  sawEnter: boolean;
  sawExit: boolean;
  enterAt: number;
  exitAt: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

const outcomes = new Map<string, OutcomeState>();

function resolveIds(): { callId: string | null; roomId: string | null } {
  try {
    const g = global as any;
    const p = g.__currentCallPiPParamsRef?.current;
    const session = g.__webrtcSessionRef?.current;
    const callId = String(
      p?.callId || (typeof session?.getCallId === 'function' ? session.getCallId() : '') || '',
    ).trim();
    const roomId = String(
      p?.roomId || (typeof session?.getRoomId === 'function' ? session.getRoomId() : '') || '',
    ).trim();
    return { callId: callId || null, roomId: roomId || null };
  } catch {
    return { callId: null, roomId: null };
  }
}

export function logHomePiPTrace(phase: HomePiPTracePhase | string, payload: TracePayload = {}): void {
  if (!isSysPiPHomeTraceEnabled()) return;
  const ids = resolveIds();
  const body = {
    phase,
    ...ids,
    ...payload,
    traceId: payload.traceId ?? (global as any).__activeHomePiPTraceIdRef?.current ?? null,
    ts: Date.now(),
  };
  logger.info(LOG_TAG, body);
  trackReleaseEvent('sys_pip_home', body);
}

export function setActiveHomePiPTraceId(traceId: string | null): void {
  try {
    const g = global as any;
    g.__activeHomePiPTraceIdRef = g.__activeHomePiPTraceIdRef || { current: null };
    g.__activeHomePiPTraceIdRef.current = traceId;
  } catch (_) {}
}

export function beginHomePiPOutcomeWatch(traceId: string): void {
  if (!isSysPiPHomeTraceEnabled() || !traceId) return;
  const prev = outcomes.get(traceId);
  if (prev?.timeoutId) clearTimeout(prev.timeoutId);
  const state: OutcomeState = {
    traceId,
    startedAt: Date.now(),
    sawEnter: false,
    sawExit: false,
    enterAt: 0,
    exitAt: 0,
    timeoutId: null,
  };
  state.timeoutId = setTimeout(() => finalizeHomePiPOutcome(traceId, 'timeout'), 5000);
  outcomes.set(traceId, state);
}

export function noteHomePiPModeChanged(traceId: string | null, inPiP: boolean): void {
  const id =
    traceId ||
    (global as any).__activeHomePiPTraceIdRef?.current ||
    '';
  if (!id) return;
  let state = outcomes.get(id);
  if (!state) {
    beginHomePiPOutcomeWatch(id);
    state = outcomes.get(id)!;
  }
  if (inPiP) {
    state.sawEnter = true;
    state.enterAt = Date.now();
  } else if (state.sawEnter) {
    state.sawExit = true;
    state.exitAt = Date.now();
    finalizeHomePiPOutcome(id, 'exit_after_enter');
  }
}

function finalizeHomePiPOutcome(traceId: string, reason: string): void {
  const state = outcomes.get(traceId);
  if (!state) return;
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
  const g = global as any;
  const inSystemNow = g.__pipInSystemModeRef?.current === true;
  let outcome: string;
  if (state.sawEnter && !state.sawExit && inSystemNow) {
    outcome = 'system_pip_visible';
  } else if (state.sawEnter && state.sawExit && state.exitAt - state.enterAt < 2000) {
    outcome = 'flicker_enter_exit';
  } else if (state.sawEnter && state.sawExit) {
    outcome = 'entered_then_exited';
  } else if (state.sawEnter) {
    outcome = 'entered_unclear';
  } else {
    outcome = 'never_entered_system_pip';
  }
  logHomePiPTrace('outcome', {
    traceId,
    outcome,
    reason,
    durationMs: Date.now() - state.startedAt,
    sawEnter: state.sawEnter,
    sawExit: state.sawExit,
    inSystemNow,
    pipVisibleRef: g.__pipVisibleRef?.current === true,
    inSystemModeRef: g.__pipInSystemModeRef?.current === true,
    device:
      Platform.OS === 'android'
        ? `${String((Platform.constants as any)?.Brand ?? '')}_${String((Platform.constants as any)?.Model ?? '')}`.replace(/^_|_$/g, '') || undefined
        : undefined,
  });
  outcomes.delete(traceId);
  if ((global as any).__activeHomePiPTraceIdRef?.current === traceId) {
    setActiveHomePiPTraceId(null);
  }
}

/** Завершить трассу раньше (native_skip, явный отказ). */
export function finishHomePiPTraceEarly(traceId: string | null | undefined, reason: string): void {
  if (!traceId) return;
  finalizeHomePiPOutcome(traceId, reason);
}

let traceListenerInstalled = false;

/** Слушает нативные шаги Home → system PiP (logcat: SysPiPHome). */
export function installSystemPiPHomeTraceListener(): void {
  if (Platform.OS !== 'android' || traceListenerInstalled) return;
  traceListenerInstalled = true;
  try {
    const emitter = new NativeEventEmitter(NativeModules.LiviAppModule);
    emitter.addListener(
      'SystemPiPHomeTrace',
      (payload: {
        traceId?: string;
        phase?: string;
        shouldEnterPiP?: boolean;
        placeholderOnly?: boolean;
        success?: boolean;
        reason?: string;
        attempt?: number;
        waitedMs?: number;
        frameReady?: boolean;
        isInPiP?: boolean;
      }) => {
        if (!isSysPiPHomeTraceEnabled()) return;
        const traceId = payload?.traceId ? String(payload.traceId) : null;
        if (traceId) setActiveHomePiPTraceId(traceId);
        if (traceId && payload?.phase === 'native_on_user_leave_hint') {
          beginHomePiPOutcomeWatch(traceId);
        }
        logHomePiPTrace(payload?.phase || 'native', {
          traceId: traceId ?? undefined,
          ...payload,
        });
        if (traceId && payload?.phase === 'native_skip') {
          const skipReason = String(payload.reason ?? 'native_skip');
          setTimeout(() => finishHomePiPTraceEarly(traceId, skipReason), 400);
        }
        if (payload?.phase === 'native_enter_result' && payload.success === true) {
          noteHomePiPModeChanged(traceId, true);
        }
        if (payload?.phase === 'native_enter_result' && payload.success === false) {
          // Оставляем outcome watch — возможны ретраи; timeout 5s зафиксирует never_entered.
        }
      },
    );
  } catch (_) {}
}
