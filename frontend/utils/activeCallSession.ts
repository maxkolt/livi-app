import { AppState, NativeModules, Platform } from 'react-native';
import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  normalizeInCallRoute,
} from '../components/VideoChat/hooks/audioRouteTypes';
import { isInAudioOnlyCallUi, setPipAudioOnlyPlaceholderSticky } from '../src/pip/pipPlaceholderOnly';
import { readNativeProbedExternalRoute } from './nativeCallAudioProbe';

/** Direct-call / video UI: сброс sticky audio-only refs (Home/PiP не должны включать audio_home speaker). */
export function markDirectCallVideoMediaActive(): void {
  try {
    clearDirectAudioEarpieceStabilizeWindow();
    const g = global as any;
    g.__stayOnVideoCallUiRef = g.__stayOnVideoCallUiRef || { current: false };
    g.__stayOnVideoCallUiRef.current = true;
    setPipAudioOnlyPlaceholderSticky(false);
    if (g.__inAudioOnlyUiRef) g.__inAudioOnlyUiRef.current = false;
    g.__preferAudioOnlyUiOnNextVideoCallRef =
      g.__preferAudioOnlyUiOnNextVideoCallRef || { current: false };
    g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.inAudioOnlyUi = false;
      params.preferVideoCallUi = true;
    }
  } catch {}
}

const DIRECT_AUDIO_EARPIECE_STABILIZE_MS = 3200;

/** После accept direct audio: не давать foreground/reapply/poll переключать на громкую связь. */
export function armDirectAudioEarpieceStabilizeWindow(ms = DIRECT_AUDIO_EARPIECE_STABILIZE_MS): void {
  try {
    const g = global as any;
    g.__directAudioEarpieceStabilizeUntilRef = g.__directAudioEarpieceStabilizeUntilRef || { current: 0 };
    g.__directAudioEarpieceStabilizeUntilRef.current = Math.max(
      Number(g.__directAudioEarpieceStabilizeUntilRef.current || 0),
      Date.now() + ms,
    );
  } catch {}
}

export function clearDirectAudioEarpieceStabilizeWindow(): void {
  try {
    const g = global as any;
    if (g.__directAudioEarpieceStabilizeUntilRef) {
      g.__directAudioEarpieceStabilizeUntilRef.current = 0;
    }
  } catch {}
}

export function isDirectAudioEarpieceStabilizeWindow(): boolean {
  try {
    const g = global as any;
    if (Date.now() >= Number(g.__directAudioEarpieceStabilizeUntilRef?.current || 0)) return false;
    if (isInAudioOnlyCallUi()) return true;
    if (g.__inAudioOnlyUiRef?.current === true) return true;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.inAudioOnlyUi === true) return true;
    if (params?.preferVideoCallUi === false && params?.callMedia !== 'video') return true;
  } catch {}
  return false;
}

/** Активный звонок уже на video UI / с камерой — не трактовать как audio-only для маршрута. */
export function ongoingCallPrefersVideoMedia(): boolean {
  try {
    const g = global as any;
    if (g.__stayOnVideoCallUiRef?.current === true) return true;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.preferVideoCallUi === true) return true;
    if (params?.localCamOn === true) return true;
    const session = g.__webrtcSessionRef?.current;
    if (!session) return false;
    if (typeof session.isEnded === 'function' && session.isEnded()) return false;
    if (typeof session.getIsCamOn === 'function' && session.getIsCamOn()) return true;
    const defer = session.getDeferRemoteVideoSubscription?.();
    const audioDefer = session.getDirectCallAudioOnlyConsumerDefer?.();
    if (defer === false && audioDefer === false) return true;
    return false;
  } catch {
    return false;
  }
}

/** Сброс JS + native «завершение звонка» (блокирует system PiP в onUserLeaveHint). */
export function clearEndingCallInProgress(): void {
  try {
    const g = global as any;
    g.__endingCallInProgressRef = g.__endingCallInProgressRef || { current: false };
    g.__endingCallInProgressRef.current = false;
  } catch {}
  if (Platform.OS === 'android') {
    try {
      NativeModules.LiviAppModule?.setEndingCallInProgress?.(false);
    } catch {}
  }
}

/**
 * Не вызывать InCallManager.stop / сброс маршрута при unmount дубликата VideoCall
 * или во время отложенного teardown (иначе мерцание earpiece/speaker между звонками).
 */
export function shouldDeferCallAudioStopOnHookUnmount(): boolean {
  try {
    const g = global as any;
    if (g.__endingCallInProgressRef?.current === true) return true;
    if (g.__inCallAudioSessionStartedRef?.current === true) return true;
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.isEnded === 'function' && !session.isEnded()) return true;
  } catch {}
  return isOngoingCallSession();
}

/** Активный direct / VideoCall (не teardown, сессия не ended). */
export function isOngoingCallSession(): boolean {
  try {
    const g = global as any;
    if (g.__endingCallInProgressRef?.current === true) return false;
    if (g.__callEndedFromPiPNoOpenRef?.current === true) return false;
    if (g.__videoCallActiveRef?.current === false) return false;
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.isEnded === 'function' && session.isEnded()) return false;
    if (session) return true;
    return g.__videoCallActiveRef?.current === true;
  } catch {
    return false;
  }
}

/** InCallManager.start уже поднят (не делать stop/start при remount VideoCall). */
export function markInCallAudioSessionStarted(started: boolean): void {
  try {
    (global as any).__inCallAudioSessionStartedRef = { current: started };
  } catch {}
}

export function isInCallAudioSessionStarted(): boolean {
  try {
    return (global as any).__inCallAudioSessionStartedRef?.current === true;
  } catch {
    return false;
  }
}

function isIncomingAnswerTransitionActive(): boolean {
  try {
    const incomingTransition = (global as any).__incomingAnswerTransitionRef?.current;
    return !!incomingTransition && Number(incomingTransition.expiresAt || 0) > Date.now();
  } catch {
    return false;
  }
}

/**
 * Не сбрасывать InCallManager / не резать random-chat при уходе в фон:
 * звонок, переход на accept, нативные incoming/outgoing экраны.
 */
export function shouldKeepInCallAudioOnAppBackground(): boolean {
  try {
    const g = global as any;
    if (g.__endingCallInProgressRef?.current === true) return false;
    if (g.__callEndedFromPiPNoOpenRef?.current === true) return false;
    if (g.__endingFromPiPButtonRef?.current === true) return false;

    const session = g.__webrtcSessionRef?.current;
    const sessionLive =
      !!session &&
      (typeof session.isEnded !== 'function' || !session.isEnded());
    if (sessionLive) return true;

    if (isOngoingCallSession()) return true;
    if (isIncomingAnswerTransitionActive()) return true;

    const outgoingCallId = String(g.__outgoingCallIdRef?.current || '').trim();
    if (outgoingCallId) return true;

    if (g.__incomingCallScreenVisibleRef?.current === true) return true;
    if (g.__outgoingCallScreenVisibleRef?.current === true) return true;
    if (g.__socketActiveVideoCallRef?.current === true) return true;

    if (g.__videoCallActiveRef?.current === true) {
      const params = g.__currentCallPiPParamsRef?.current;
      if (params?.callId || params?.roomId) return true;
    }

    const route = g.__navRef?.getCurrentRoute?.()?.name;
    if (route === 'VideoCall' && g.__videoCallActiveRef?.current !== false) {
      return true;
    }
  } catch {}
  return false;
}

/** Random chat: не стопать поиск/комнату, пока идёт или подключается direct-call. */
export function shouldDeferRandomChatStopOnAppBackground(): boolean {
  return shouldKeepInCallAudioOnAppBackground();
}

export function resolveActiveCallInCallMedia(): 'audio' | 'video' {
  try {
    if (isDirectAudioEarpieceStabilizeWindow()) return 'audio';
    if (ongoingCallPrefersVideoMedia()) return 'video';
    if (isInAudioOnlyCallUi()) return 'audio';
    const g = global as any;
    if (g.__inAudioOnlyUiRef?.current === true) return 'audio';
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.inAudioOnlyUi === true) return 'audio';
    if (params?.preferVideoCallUi === false) return 'audio';
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.isCameraSuspendedForAppBackground === 'function') {
      if (session.isCameraSuspendedForAppBackground()) return 'audio';
    }
    if (g.__pipInSystemModeRef?.current === true) {
      const localCamOn = params?.localCamOn;
      if (localCamOn === false) return 'audio';
    }
  } catch {}
  return 'video';
}

/** На video UI не восстанавливаем разговорный из persist (кроме audio-only экрана). */
export function resolvePersistedCallAudioRouteForActiveUi(
  route: InCallAudioRoute | null,
): InCallAudioRoute | null {
  if (!route) return null;
  if (isExternalHeadsetRoute(route)) return route;
  if (isInAudioOnlyCallUi()) return route;
  if (isDirectAudioEarpieceStabilizeWindow()) return route;
  if (route === 'EARPIECE') return 'SPEAKER_PHONE';
  return route;
}

/** Активный аудиозвонок (экран или sticky после Home), не video UI. */
export function isAudioOnlyOngoingCallContext(): boolean {
  if (ongoingCallPrefersVideoMedia()) return false;
  if (isInAudioOnlyCallUi()) return true;
  try {
    if (!isOngoingCallSession()) return false;
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.inAudioOnlyUi === true) return true;
    if (g.__pipAudioOnlyPlaceholderRef?.current === true) return true;
  } catch {}
  return false;
}

export function isAppInCallBackgroundState(): boolean {
  const s = AppState.currentState;
  return s === 'background' || s === 'inactive';
}

/**
 * Reapply / capture при уходе в фон: audio-only → громкая связь, кроме Bluetooth.
 * На экране аудиозвонка (foreground) маршрут не меняем.
 */
export function resolvePersistedCallAudioRouteForReapply(
  route: InCallAudioRoute | null,
): InCallAudioRoute | null {
  const inBackground = isAppInCallBackgroundState();
  if (inBackground && isAudioOnlyOngoingCallContext()) {
    try {
      const g = global as any;
      const now = Date.now();
      const pipTransition =
        now < Number(g.__returningFromSystemPiPUntilRef?.current || 0) ||
        g.__pipInSystemModeRef?.current === true ||
        now < Number(g.__systemPiPEntryInProgressUntilRef?.current || 0) ||
        now < Number(g.__callAudioPreservePriorityUntilRef?.current || 0);
      if (pipTransition) {
        if (route && isExternalHeadsetRoute(route)) return route;
        if (route === 'EARPIECE' || route === 'SPEAKER_PHONE') return route;
        return route || 'EARPIECE';
      }
    } catch {}
    if (route && isExternalHeadsetRoute(route)) return route;
    return 'SPEAKER_PHONE';
  }
  return resolvePersistedCallAudioRouteForActiveUi(route);
}

/** Сохранить маршрут из PiP params / persisted перед уходом в фон. */
export function readLastAppliedCallAudioRoute(): InCallAudioRoute | null {
  try {
    return normalizeInCallRoute((global as any).__lastAppliedCallAudioRouteRef?.current || '');
  } catch {
    return null;
  }
}

export function markUserSelectedExternalCallAudioRoute(route: InCallAudioRoute, ttlMs = 10000): void {
  if (!isExternalHeadsetRoute(route)) return;
  try {
    const g = global as any;
    g.__userSelectedExternalCallAudioRouteRef = {
      current: {
        route,
        until: Date.now() + ttlMs,
      },
    };
  } catch {}
}

export function readUserSelectedExternalCallAudioRoute(): InCallAudioRoute | null {
  try {
    const entry = (global as any).__userSelectedExternalCallAudioRouteRef?.current;
    const route = normalizeInCallRoute(entry?.route || '');
    if (!route || !isExternalHeadsetRoute(route)) return null;
    if (Number(entry?.until || 0) <= Date.now()) return null;
    const available = (() => {
      try {
        const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
        return Array.isArray(av) ? av.map((s: unknown) => String(s)) : [];
      } catch {
        return [];
      }
    })();
    if (available.length && !available.includes(route)) return null;
    return route;
  } catch {
    return null;
  }
}

export function captureCallAudioRouteFromUi(): void {
  try {
    const g = global as any;
    const external = readConnectedExternalCallAudioRoute() || readActiveExternalCallAudioRoute();
    if (external) {
      g.__persistedCallAudioRouteRef = g.__persistedCallAudioRouteRef || { current: null };
      g.__persistedCallAudioRouteRef.current = external;
      g.__lastAppliedCallAudioRouteRef = { current: external };
      const params = g.__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = external;
      }
      return;
    }
    const fromParams = normalizeInCallRoute(g.__currentCallPiPParamsRef?.current?.audioOutputRoute || '');
    const stored = normalizeInCallRoute(g.__persistedCallAudioRouteRef?.current || '');
    const lastApplied = readLastAppliedCallAudioRoute();
    const base =
      (lastApplied && isExternalHeadsetRoute(lastApplied) ? lastApplied : null) ||
      fromParams ||
      stored;
    const effective = resolvePersistedCallAudioRouteForReapply(base);
    if (effective) {
      g.__persistedCallAudioRouteRef = g.__persistedCallAudioRouteRef || { current: null };
      g.__persistedCallAudioRouteRef.current = effective;
    }
  } catch {}
}

/** BT / провод из lastApplied, params, persist и live user route (VideoCall). */
export function readActiveExternalCallAudioRoute(
  liveUserRoute?: InCallAudioRoute | string | null,
): InCallAudioRoute | null {
  try {
    const candidates = [
      readUserSelectedExternalCallAudioRoute(),
      normalizeInCallRoute(liveUserRoute || ''),
      readLastAppliedCallAudioRoute(),
      normalizeInCallRoute((global as any).__currentCallPiPParamsRef?.current?.audioOutputRoute || ''),
      normalizeInCallRoute((global as any).__persistedCallAudioRouteRef?.current || ''),
    ];
    return candidates.find((r) => r && isExternalHeadsetRoute(r)) || null;
  } catch {
    return null;
  }
}

function readInCallAvailableAudioRoutesList(): string[] {
  try {
    const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
    return Array.isArray(av) ? av.map((s: unknown) => String(s)) : [];
  } catch {
    return [];
  }
}

/**
 * Гарнитура, которая реально в списке InCallManager (persist + selected + hint).
 * Нужно для in-app PiP, когда persist на миг EARPIECE, а BT уже в available/selected.
 */
export function readConnectedExternalCallAudioRoute(
  hint?: InCallAudioRoute | string | null,
): InCallAudioRoute | null {
  const nativeExt = readNativeProbedExternalRoute();
  if (nativeExt) return nativeExt;
  const available = readInCallAvailableAudioRoutesList();
  const fromPersist = readActiveExternalCallAudioRoute(hint);
  if (fromPersist && (!available.length || available.includes(fromPersist))) {
    return fromPersist;
  }
  try {
    const selected = normalizeInCallRoute((global as any).__inCallSelectedAudioRouteRef?.current || '');
    if (isExternalHeadsetRoute(selected) && available.includes(selected)) {
      return selected;
    }
  } catch {}
  const hintNorm = normalizeInCallRoute(hint || '');
  if (hintNorm === 'BLUETOOTH' && available.includes('BLUETOOTH')) return 'BLUETOOTH';
  if (hintNorm === 'WIRED_HEADSET' && available.includes('WIRED_HEADSET')) return 'WIRED_HEADSET';
  return null;
}

/** Явный выбор маршрута (PiP / cycle) — не перебивать авто-BT в UI. */
export function readUserSelectedCallAudioRoute(): InCallAudioRoute | null {
  try {
    return normalizeInCallRoute((global as any).__userSelectedCallAudioRouteRef?.current || '');
  } catch {
    return null;
  }
}

function readActiveCallAudioRouteCallId(): string {
  try {
    const g = global as any;
    return String(
      g.__activeCallAudioRouteCallIdRef?.current ||
        g.__currentCallPiPParamsRef?.current?.callId ||
        '',
    ).trim();
  } catch {
    return '';
  }
}

export function markActiveCallAudioRouteCallId(callId?: string | null): void {
  try {
    const g = global as any;
    const nextCallId = String(callId || '').trim();
    const prevCallId = String(g.__activeCallAudioRouteCallIdRef?.current || '').trim();
    if (nextCallId && prevCallId && nextCallId !== prevCallId) {
      if (g.__manualBuiltinCallAudioRouteRef) g.__manualBuiltinCallAudioRouteRef.current = null;
      if (g.__userSelectedCallAudioRouteRef) g.__userSelectedCallAudioRouteRef.current = null;
      if (g.__explicitBuiltInCallAudioRouteRef) g.__explicitBuiltInCallAudioRouteRef.current = false;
    }
    g.__activeCallAudioRouteCallIdRef = g.__activeCallAudioRouteCallIdRef || { current: '' };
    g.__activeCallAudioRouteCallIdRef.current = nextCallId;
  } catch {}
}

export function rememberManualBuiltinCallAudioRoute(route: InCallAudioRoute): void {
  if (route !== 'SPEAKER_PHONE' && route !== 'EARPIECE') return;
  try {
    const g = global as any;
    g.__manualBuiltinCallAudioRouteRef = {
      current: {
        route,
        callId: readActiveCallAudioRouteCallId(),
        at: Date.now(),
      },
    };
  } catch {}
}

export function readManualBuiltinCallAudioRoute(maxAgeMs = 120_000): InCallAudioRoute | null {
  try {
    const g = global as any;
    const record = g.__manualBuiltinCallAudioRouteRef?.current;
    const route = normalizeInCallRoute(record?.route || '');
    if (route !== 'SPEAKER_PHONE' && route !== 'EARPIECE') return null;
    const at = Number(record?.at || 0);
    if (!at || Date.now() - at > maxAgeMs) return null;
    const activeCallId = readActiveCallAudioRouteCallId();
    const recordCallId = String(record?.callId || '').trim();
    if (!activeCallId || !recordCallId || activeCallId !== recordCallId) return null;
    return route;
  } catch {
    return null;
  }
}

/** Builtin (ухо/громкая), зафиксированный пользователем через cycle — не перебивать reapply/poll. */
export function readUserLockedBuiltinCallAudioRoute(): InCallAudioRoute | null {
  const manual = readManualBuiltinCallAudioRoute();
  if (manual) return manual;
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel !== 'SPEAKER_PHONE' && userSel !== 'EARPIECE') return null;
  try {
    if ((global as any).__explicitBuiltInCallAudioRouteRef?.current) {
      return userSel;
    }
  } catch {}
  return null;
}

export function setUserSelectedCallAudioRoute(route: InCallAudioRoute | null): void {
  try {
    const g = global as any;
    g.__userSelectedCallAudioRouteRef = g.__userSelectedCallAudioRouteRef || { current: null };
    g.__userSelectedCallAudioRouteRef.current = route;
    if (!route || route === 'EARPIECE' || route === 'SPEAKER_PHONE') {
      if (g.__userSelectedExternalCallAudioRouteRef) {
        g.__userSelectedExternalCallAudioRouteRef.current = null;
      }
    }
    if (route) {
      g.__lastAppliedCallAudioRouteRef = { current: route };
    }
  } catch {}
}

/** Маршрут из PiP params + persist ref (без импорта callAudioRoutePersist — без циклов). */
export function readInAppPiPAudioOutputRoute(): InCallAudioRoute {
  try {
    const g = global as any;
    const userSel = readUserSelectedCallAudioRoute();
    if (userSel) {
      return userSel;
    }
    const fromParams = normalizeInCallRoute(g.__currentCallPiPParamsRef?.current?.audioOutputRoute || '');
    const stored = normalizeInCallRoute(g.__persistedCallAudioRouteRef?.current || '');
    const lastApplied = readLastAppliedCallAudioRoute();
    const intent = fromParams || stored || lastApplied;
    if (intent === 'SPEAKER_PHONE' || intent === 'EARPIECE') {
      return intent;
    }
    if (intent && isExternalHeadsetRoute(intent)) {
      const available = readInCallAvailableAudioRoutesList();
      if (!available.length || available.includes(intent)) {
        return intent;
      }
    }
    const external =
      readConnectedExternalCallAudioRoute(intent) ||
      readActiveExternalCallAudioRoute(intent);
    if (external) return external;
    return intent || 'EARPIECE';
  } catch {
    return 'EARPIECE';
  }
}

/** Намерение пользователя по микрофону (единый источник для UI / PiP). */
export function readOngoingCallMicOn(): boolean | null {
  try {
    const session = (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.getIsMicOn === 'function') {
      return session.getIsMicOn();
    }
  } catch {}
  return null;
}

/** Локальный mute для PiP: намерение пользователя (session), не track.enabled. */
export function resolvePiPLocalMutedState(fallbackMicOn?: boolean): boolean {
  try {
    const session = (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.getIsMicOn === 'function') {
      return !session.getIsMicOn();
    }
  } catch {}
  if (typeof fallbackMicOn === 'boolean') {
    return !fallbackMicOn;
  }
  try {
    const muteLocal = (global as any).__currentCallPiPParamsRef?.current?.muteLocal;
    if (typeof muteLocal === 'boolean') return muteLocal;
  } catch {}
  return false;
}

export type SystemPiPReturnMediaSnapshot = {
  micOn: boolean;
  camOn: boolean;
  audioRoute: InCallAudioRoute;
  preferAudioOnlyUi: boolean;
  capturedAt: number;
};

/** Состояние mic / cam / динамика до Home → system PiP (до pin громкой связи в фоне). */
export function captureSystemPiPReturnMediaSnapshot(): void {
  try {
    const g = global as any;
    const session = g.__webrtcSessionRef?.current;
    if (!session) return;
    const micOn =
      typeof session.getIsMicOn === 'function' ? session.getIsMicOn() : true;
    const camOn =
      typeof session.getIsCamOn === 'function' ? session.getIsCamOn() : false;
    const preferAudioOnlyUi = isInAudioOnlyCallUi();
    const fromParams = normalizeInCallRoute(
      g.__currentCallPiPParamsRef?.current?.audioOutputRoute || '',
    );
    const stored = normalizeInCallRoute(g.__persistedCallAudioRouteRef?.current || '');
    const routeFromPiP = readInAppPiPAudioOutputRoute();
    const audioRoute = preferAudioOnlyUi
      ? routeFromPiP
      : fromParams || stored || routeFromPiP || 'EARPIECE';
    const snap: SystemPiPReturnMediaSnapshot = {
      micOn: !!micOn,
      camOn: !!camOn,
      audioRoute,
      preferAudioOnlyUi,
      capturedAt: Date.now(),
    };
    g.__systemPiPReturnMediaSnapshotRef = snap;
    g.__systemPiPReturnMediaRestoreTokenRef =
      g.__systemPiPReturnMediaRestoreTokenRef || { current: 0 };
    g.__systemPiPReturnMediaRestoreTokenRef.current = 0;
  } catch {}
}

export function peekSystemPiPReturnMediaSnapshot(): SystemPiPReturnMediaSnapshot | null {
  try {
    const snap = (global as any).__systemPiPReturnMediaSnapshotRef as
      | SystemPiPReturnMediaSnapshot
      | undefined;
    if (!snap || Date.now() - snap.capturedAt > 120_000) return null;
    return snap;
  } catch {
    return null;
  }
}

/** Восстановить mic / маршрут из снимка (камера — через session.restoreLocalCameraAfterPiPReturn). */
export function applySystemPiPReturnMediaSnapshot(): boolean {
  try {
    const g = global as any;
    const snap = g.__systemPiPReturnMediaSnapshotRef as SystemPiPReturnMediaSnapshot | undefined;
    if (!snap || Date.now() - snap.capturedAt > 120_000) {
      g.__systemPiPReturnMediaSnapshotRef = null;
      return false;
    }
    const session = g.__webrtcSessionRef?.current;
    if (!session || (typeof session.isEnded === 'function' && session.isEnded())) {
      g.__systemPiPReturnMediaSnapshotRef = null;
      return false;
    }
    const targetMic = !!snap.micOn;
    if (typeof session.getIsMicOn === 'function' && typeof session.toggleMic === 'function') {
      if (session.getIsMicOn() !== targetMic) {
        session.toggleMic();
      }
    }
    const route = normalizeInCallRoute(snap.audioRoute || '');
    if (route) {
      g.__persistedCallAudioRouteRef = g.__persistedCallAudioRouteRef || { current: null };
      g.__persistedCallAudioRouteRef.current = route;
      const params = g.__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = route;
        params.muteLocal = !targetMic;
        params.localCamOn = !!snap.camOn;
        if (snap.preferAudioOnlyUi) {
          params.inAudioOnlyUi = true;
          params.preferVideoCallUi = false;
        }
      }
      if (g.__audioCallHomeSpeakerPinRef) {
        g.__audioCallHomeSpeakerPinRef.current = false;
      }
    }
    if (snap.preferAudioOnlyUi) {
      g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || {
        current: false,
      };
      g.__preferAudioOnlyUiOnNextVideoCallRef.current = true;
      g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
      g.__expandToVideoCallUiFromPiPRef.current = false;
      g.__inAudioOnlyUiRef = g.__inAudioOnlyUiRef || { current: false };
      g.__inAudioOnlyUiRef.current = true;
      g.__stayOnVideoCallUiRef = g.__stayOnVideoCallUiRef || { current: false };
      g.__stayOnVideoCallUiRef.current = false;
      g.__pipAudioOnlyPlaceholderRef = g.__pipAudioOnlyPlaceholderRef || { current: false };
      g.__pipAudioOnlyPlaceholderRef.current = true;
    } else {
      g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || {
        current: false,
      };
      g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
      g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
      g.__expandToVideoCallUiFromPiPRef.current = true;
      g.__stayOnVideoCallUiRef = g.__stayOnVideoCallUiRef || { current: false };
      g.__stayOnVideoCallUiRef.current = true;
    }
    g.__lastAppliedSystemPiPSnapRef = { ...snap };
    const pipUpdate = g.__pipUpdateStateRef?.current;
    if (typeof pipUpdate === 'function') {
      pipUpdate({ isMuted: !targetMic });
    }
    g.__systemPiPReturnMediaSnapshotRef = null;
    return true;
  } catch {
    return false;
  }
}

/** После PiP/фона: поднять mic uplink, если пользователь не выключал микрофон. */
export function restoreOngoingCallMicrophoneIfEnabled(): void {
  try {
    const session = (global as any).__webrtcSessionRef?.current;
    if (!session || typeof session.getIsMicOn !== 'function' || !session.getIsMicOn()) return;
    if (typeof session.restoreMicrophoneAfterAppBackground === 'function') {
      void session.restoreMicrophoneAfterAppBackground();
    }
  } catch {}
}
