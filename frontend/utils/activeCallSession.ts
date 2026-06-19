import { AppState, NativeModules, Platform } from 'react-native';
import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  normalizeInCallRoute,
} from '../components/VideoChat/hooks/audioRouteTypes';
import { isInAudioOnlyCallUi, setPipAudioOnlyPlaceholderSticky } from '../src/pip/pipPlaceholderOnly';

/** Direct-call / video UI: сброс sticky audio-only refs (Home/PiP не должны включать audio_home speaker). */
export function markDirectCallVideoMediaActive(): void {
  try {
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

export function captureCallAudioRouteFromUi(): void {
  try {
    const g = global as any;
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

/** Маршрут из PiP params + persist ref (без импорта callAudioRoutePersist — без циклов). */
export function readInAppPiPAudioOutputRoute(): InCallAudioRoute {
  try {
    const g = global as any;
    const fromParams = normalizeInCallRoute(g.__currentCallPiPParamsRef?.current?.audioOutputRoute || '');
    const stored = normalizeInCallRoute(g.__persistedCallAudioRouteRef?.current || '');
    return fromParams || stored || 'EARPIECE';
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
