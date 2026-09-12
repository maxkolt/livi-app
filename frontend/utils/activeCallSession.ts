import { AppState, NativeModules, Platform } from 'react-native';
import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  normalizeInCallRoute,
} from '../components/VideoChat/hooks/audioRouteTypes';
import { isInAudioOnlyCallUi, setPipAudioOnlyPlaceholderSticky } from './callAudioOnlyUiContext';
import { readConnectedExternalCallAudioRoute } from './callConnectedExternalAudioRoute';
import { readCallAudioRouteUiLock, clearCallAudioRouteUiLock } from './callAudioRouteTransitionGuards';
import { readNativeProbedExternalRoute, isBluetoothHeadsetActiveForCall } from './nativeCallAudioProbe';
import { readRootCurrentRouteName } from './safeRootNavigation';
import { getCallMediaHint } from './directCallMediaHint';
import {
  isDirectCallUserRequestedVideoExpand,
  isDirectCallVideoExpandGuardActive,
  clearFreshDirectCallAudioAcceptCall,
  clearDirectCallAudioAcceptBootstrapped,
} from './directCallVideoExpandGuard';
import {
  getOutgoingCallId,
  getWebrtcSession,
  isCallEndedFromPiPNoOpen,
  isEndingCallInProgress,
  isEndingFromPiPButton,
  isInAudioOnlyUi,
  isInCallAudioSessionStarted as isInCallAudioSessionStartedRuntime,
  isPipAudioOnlyPlaceholder,
  isPipInSystemMode,
  isPipVisible,
  isPreferAudioOnlyUiOnNextVideoCall,
  isStayOnVideoCallUi,
  isVideoCallActive,
  isVideoCallActiveExplicitlyFalse,
  setEndingCallInProgress,
  setInAudioOnlyUi,
  setInCallAudioSessionStarted,
  setPreferAudioOnlyUiOnNextVideoCall,
  setStayOnVideoCallUi,
} from './callRuntime';

function isActiveDirectCallAudioFirstWithoutUserVideo(): boolean {
  try {
    const session = getWebrtcSession();
    const cid = String(
      session?.getCallId?.() ?? (global as any).__activeCallAudioRouteCallIdRef?.current ?? '',
    ).trim();
    if (!cid || getCallMediaHint(cid) !== 'audio') return false;
    return !isDirectCallUserRequestedVideoExpand();
  } catch {
    return false;
  }
}

/** Direct-call / video UI: сброс sticky audio-only refs (Home/PiP не должны включать audio_home speaker). */
export function markDirectCallVideoMediaActive(): void {
  try {
    if (isActiveDirectCallAudioFirstWithoutUserVideo()) return;
    // Явный return-to-audio без stayOnVideo: не переворачивать globals обратно на video.
    // При expand на video stayOn уже true — пропускаем дальше даже если preferAudioOnly ещё sticky.
    const stayOnVideo = isStayOnVideoCallUi();
    if (!stayOnVideo && isPreferAudioOnlyUiOnNextVideoCall()) return;
    if (!stayOnVideo && isInAudioOnlyUi()) return;
    clearDirectAudioEarpieceStabilizeWindow();
    setStayOnVideoCallUi(true);
    setPipAudioOnlyPlaceholderSticky(false);
    setInAudioOnlyUi(false);
    setPreferAudioOnlyUiOnNextVideoCall(false);
    const params = (global as any).__currentCallPiPParamsRef?.current;
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
    const until = Number(g.__directAudioEarpieceStabilizeUntilRef?.current || 0);
    if (!until || Date.now() >= until) return false;
    return true;
  } catch {}
  return false;
}

export type OngoingCallMediaState = {
  activeCallId: string;
  callMediaHintIsAudio: boolean;
  directCallUserRequestedVideoExpand: boolean;
  directCallVideoExpandGuardActive: boolean;
  expandToVideoCallUiFromPiP: boolean;
  sessionExists: boolean;
  sessionIsEnded: boolean;
  sessionCamOn: boolean;
  sessionDeferRemoteVideoSubscription: boolean | undefined;
  sessionDirectCallAudioOnlyConsumerDefer: boolean | undefined;
  sessionIsCameraSuspendedForAppBackground: boolean | undefined;
  paramsLocalCamOn: unknown;
  paramsPreferVideoCallUi: unknown;
  paramsInAudioOnlyUi: unknown;
  stayOnVideoCallUi: boolean;
  isDirectAudioEarpieceStabilizeWindowFlag: boolean;
  isInAudioOnlyCallUiFlag: boolean;
  isInAudioOnlyUiRuntimeFlag: boolean;
  isPipInSystemModeFlag: boolean;
};

/**
 * Снимок session/globals для ongoingCallPrefersVideoMedia / resolveActiveCallInCallMedia.
 * Все session-геттеры здесь — чистые чтения полей (проверено в VideoCallSession.ts), поэтому
 * их можно безопасно вызывать один раз заранее, а не лениво внутри решающей функции.
 */
export function gatherOngoingCallMediaState(): OngoingCallMediaState {
  const g = global as any;
  let session: any = null;
  try {
    session = getWebrtcSession();
  } catch {}
  let params: any = null;
  try {
    params = g.__currentCallPiPParamsRef?.current;
  } catch {}
  let activeCallId = '';
  try {
    activeCallId = String(
      session?.getCallId?.() ?? g.__activeCallAudioRouteCallIdRef?.current ?? '',
    ).trim();
  } catch {}
  let sessionIsEnded = false;
  let sessionCamOn = false;
  let sessionDeferRemoteVideoSubscription: boolean | undefined;
  let sessionDirectCallAudioOnlyConsumerDefer: boolean | undefined;
  let sessionIsCameraSuspendedForAppBackground: boolean | undefined;
  try {
    if (session) {
      if (typeof session.isEnded === 'function') sessionIsEnded = !!session.isEnded();
      if (typeof session.getIsCamOn === 'function') sessionCamOn = !!session.getIsCamOn();
      if (typeof session.getDeferRemoteVideoSubscription === 'function') {
        // ВАЖНО: НЕ приводить через !! — исходная логика различает false и undefined
        // (оба геттера должны вернуть буквально false, иначе видео считается активным).
        sessionDeferRemoteVideoSubscription = session.getDeferRemoteVideoSubscription();
      }
      if (typeof session.getDirectCallAudioOnlyConsumerDefer === 'function') {
        sessionDirectCallAudioOnlyConsumerDefer = session.getDirectCallAudioOnlyConsumerDefer();
      }
      if (typeof session.isCameraSuspendedForAppBackground === 'function') {
        sessionIsCameraSuspendedForAppBackground = !!session.isCameraSuspendedForAppBackground();
      }
    }
  } catch {}
  let expandToVideoCallUiFromPiP = false;
  try {
    expandToVideoCallUiFromPiP = g.__expandToVideoCallUiFromPiPRef?.current === true;
  } catch {}
  let callMediaHintIsAudio = false;
  try {
    callMediaHintIsAudio = !!activeCallId && getCallMediaHint(activeCallId) === 'audio';
  } catch {}
  let directCallUserRequestedVideoExpand = false;
  try {
    directCallUserRequestedVideoExpand = isDirectCallUserRequestedVideoExpand();
  } catch {}
  let directCallVideoExpandGuardActive = false;
  try {
    directCallVideoExpandGuardActive = isDirectCallVideoExpandGuardActive();
  } catch {}
  let stayOnVideoCallUi = false;
  try {
    stayOnVideoCallUi = isStayOnVideoCallUi();
  } catch {}
  let isDirectAudioEarpieceStabilizeWindowFlag = false;
  try {
    isDirectAudioEarpieceStabilizeWindowFlag = isDirectAudioEarpieceStabilizeWindow();
  } catch {}
  let isInAudioOnlyCallUiFlag = false;
  try {
    isInAudioOnlyCallUiFlag = isInAudioOnlyCallUi();
  } catch {}
  let isInAudioOnlyUiRuntimeFlag = false;
  try {
    isInAudioOnlyUiRuntimeFlag = isInAudioOnlyUi();
  } catch {}
  let isPipInSystemModeFlag = false;
  try {
    isPipInSystemModeFlag = isPipInSystemMode();
  } catch {}
  return {
    activeCallId,
    callMediaHintIsAudio,
    directCallUserRequestedVideoExpand,
    directCallVideoExpandGuardActive,
    expandToVideoCallUiFromPiP,
    sessionExists: !!session,
    sessionIsEnded,
    sessionCamOn,
    sessionDeferRemoteVideoSubscription,
    sessionDirectCallAudioOnlyConsumerDefer,
    sessionIsCameraSuspendedForAppBackground,
    paramsLocalCamOn: params?.localCamOn,
    paramsPreferVideoCallUi: params?.preferVideoCallUi,
    paramsInAudioOnlyUi: params?.inAudioOnlyUi,
    stayOnVideoCallUi,
    isDirectAudioEarpieceStabilizeWindowFlag,
    isInAudioOnlyCallUiFlag,
    isInAudioOnlyUiRuntimeFlag,
    isPipInSystemModeFlag,
  };
}

function isActiveDirectCallAudioFirstWithoutUserVideoFromState(state: OngoingCallMediaState): boolean {
  if (!state.activeCallId || !state.callMediaHintIsAudio) return false;
  return !state.directCallUserRequestedVideoExpand;
}

/** Чистая версия ongoingCallPrefersVideoMedia: та же логика, но на явном snapshot вместо чтения globals/session. */
export function ongoingCallPrefersVideoMediaFromState(state: OngoingCallMediaState): boolean {
  if (isActiveDirectCallAudioFirstWithoutUserVideoFromState(state)) {
    if (state.directCallVideoExpandGuardActive) return true;
    if (state.expandToVideoCallUiFromPiP) return true;
    if (state.sessionCamOn) return true;
    if (state.paramsLocalCamOn === true) return true;
    return false;
  }
  if (state.stayOnVideoCallUi) return true;
  if (state.paramsPreferVideoCallUi === true) return true;
  if (state.paramsLocalCamOn === true) return true;
  if (!state.sessionExists) return false;
  if (state.sessionIsEnded) return false;
  if (state.sessionCamOn) return true;
  if (
    state.sessionDeferRemoteVideoSubscription === false &&
    state.sessionDirectCallAudioOnlyConsumerDefer === false
  ) {
    return true;
  }
  return false;
}

/** Активный звонок уже на video UI / с камерой — не трактовать как audio-only для маршрута. */
export function ongoingCallPrefersVideoMedia(): boolean {
  try {
    return ongoingCallPrefersVideoMediaFromState(gatherOngoingCallMediaState());
  } catch {
    return false;
  }
}

/** Сброс JS + native «завершение звонка» (блокирует system PiP в onUserLeaveHint). */
export function clearEndingCallInProgress(): void {
  setEndingCallInProgress(false);
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
    if (isEndingCallInProgress()) return true;
    if (isInCallAudioSessionStartedRuntime()) return true;
    const session = getWebrtcSession();
    if (session && typeof session.isEnded === 'function' && !session.isEnded()) return true;
  } catch {}
  return isOngoingCallSession();
}

/** Активный direct / VideoCall (не teardown, сессия не ended). */
export function isOngoingCallSession(): boolean {
  try {
    if (isEndingCallInProgress()) return false;
    if (isCallEndedFromPiPNoOpen()) return false;
    if (isVideoCallActiveExplicitlyFalse()) return false;
    const session = getWebrtcSession();
    if (session && typeof session.isEnded === 'function' && session.isEnded()) return false;
    if (session) return true;
    return isVideoCallActive();
  } catch {
    return false;
  }
}

/** InCallManager.start уже поднят (не делать stop/start при remount VideoCall). */
export function markInCallAudioSessionStarted(started: boolean): void {
  setInCallAudioSessionStarted(!!started);
}

export function isInCallAudioSessionStarted(): boolean {
  return isInCallAudioSessionStartedRuntime();
}

/** Accept с нативного Incoming → VideoCall: не уводить в in-app/system PiP от task-switch. */
export function isIncomingAnswerTransitionActive(): boolean {
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
    if (isEndingCallInProgress()) return false;
    if (isCallEndedFromPiPNoOpen()) return false;
    if (isEndingFromPiPButton()) return false;

    const session = getWebrtcSession();
    const sessionLive =
      !!session &&
      (typeof session.isEnded !== 'function' || !session.isEnded());
    if (sessionLive) return true;

    if (isOngoingCallSession()) return true;
    if (isIncomingAnswerTransitionActive()) return true;

    if (getOutgoingCallId()) return true;

    if (g.__incomingCallScreenVisibleRef?.current === true) return true;
    if (g.__outgoingCallScreenVisibleRef?.current === true) return true;
    if (g.__socketActiveVideoCallRef?.current === true) return true;

    if (isVideoCallActive()) {
      const params = g.__currentCallPiPParamsRef?.current;
      if (params?.callId || params?.roomId) return true;
    }

    const route = readRootCurrentRouteName();
    if (route === 'VideoCall' && !isVideoCallActiveExplicitlyFalse()) {
      return true;
    }
  } catch {}
  return false;
}

/** Random chat: не стопать поиск/комнату, пока идёт или подключается direct-call. */
export function shouldDeferRandomChatStopOnAppBackground(): boolean {
  return shouldKeepInCallAudioOnAppBackground();
}

/** Чистая версия resolveActiveCallInCallMedia: та же логика, но на явном snapshot. */
export function resolveActiveCallInCallMediaFromState(state: OngoingCallMediaState): 'audio' | 'video' {
  if (state.isDirectAudioEarpieceStabilizeWindowFlag) return 'audio';
  if (ongoingCallPrefersVideoMediaFromState(state)) return 'video';
  if (state.isInAudioOnlyCallUiFlag) return 'audio';
  if (state.isInAudioOnlyUiRuntimeFlag) return 'audio';
  if (state.paramsInAudioOnlyUi === true) return 'audio';
  if (state.paramsPreferVideoCallUi === false) return 'audio';
  if (state.sessionIsCameraSuspendedForAppBackground === true) return 'audio';
  if (state.isPipInSystemModeFlag) {
    if (state.paramsLocalCamOn === false) return 'audio';
  }
  return 'video';
}

export function resolveActiveCallInCallMedia(): 'audio' | 'video' {
  try {
    return resolveActiveCallInCallMediaFromState(gatherOngoingCallMediaState());
  } catch {
    return 'video';
  }
}

export function isAppInCallBackgroundState(): boolean {
  const s = AppState.currentState;
  return s === 'background' || s === 'inactive';
}

/**
 * Снимок для решения «какой маршрут восстанавливать» (reapply после фона / PiP).
 * Расширяет OngoingCallMediaState: audio-only контекст звонка строится поверх
 * того же media-снимка, поэтому media переиспользуется, а не собирается заново.
 */
export type CallAudioRouteReapplyState = {
  media: OngoingCallMediaState;
  appInBackground: boolean;
  ongoingCallSession: boolean;
  pipAudioOnlyPlaceholder: boolean;
  now: number;
  returningFromSystemPiPUntil: number;
  systemPiPEntryInProgressUntil: number;
  callAudioPreservePriorityUntil: number;
};

export function gatherCallAudioRouteReapplyState(
  media: OngoingCallMediaState = gatherOngoingCallMediaState(),
): CallAudioRouteReapplyState {
  const g = global as any;
  const readUntil = (key: string): number => {
    try {
      return Number(g[key]?.current || 0);
    } catch {
      return 0;
    }
  };
  let appInBackground = false;
  try {
    appInBackground = isAppInCallBackgroundState();
  } catch {}
  let ongoingCallSession = false;
  try {
    ongoingCallSession = isOngoingCallSession();
  } catch {}
  let pipAudioOnlyPlaceholder = false;
  try {
    pipAudioOnlyPlaceholder = isPipAudioOnlyPlaceholder();
  } catch {}
  return {
    media,
    appInBackground,
    ongoingCallSession,
    pipAudioOnlyPlaceholder,
    now: Date.now(),
    returningFromSystemPiPUntil: readUntil('__returningFromSystemPiPUntilRef'),
    systemPiPEntryInProgressUntil: readUntil('__systemPiPEntryInProgressUntilRef'),
    callAudioPreservePriorityUntil: readUntil('__callAudioPreservePriorityUntilRef'),
  };
}

/** Чистая версия: активный аудиозвонок (экран или sticky после Home), не video UI. */
export function isAudioOnlyOngoingCallContextFromState(state: CallAudioRouteReapplyState): boolean {
  if (ongoingCallPrefersVideoMediaFromState(state.media)) return false;
  if (state.media.isInAudioOnlyCallUiFlag) return true;
  if (!state.ongoingCallSession) return false;
  if (state.media.paramsInAudioOnlyUi === true) return true;
  if (state.pipAudioOnlyPlaceholder) return true;
  return false;
}

/** Чистая версия resolvePersistedCallAudioRouteForActiveUi. */
export function resolvePersistedCallAudioRouteForActiveUiFromState(
  route: InCallAudioRoute | null,
  state: CallAudioRouteReapplyState,
): InCallAudioRoute | null {
  if (!route) return null;
  if (isExternalHeadsetRoute(route)) return route;
  if (state.media.isInAudioOnlyCallUiFlag) return route;
  if (state.media.isDirectAudioEarpieceStabilizeWindowFlag) return route;
  if (route === 'EARPIECE') return 'SPEAKER_PHONE';
  return route;
}

/** Идёт переход enter/exit system PiP — маршрут в этом окне не переписываем. */
export function isSystemPiPRouteTransitionFromState(state: CallAudioRouteReapplyState): boolean {
  return (
    state.now < state.returningFromSystemPiPUntil ||
    state.media.isPipInSystemModeFlag ||
    state.now < state.systemPiPEntryInProgressUntil ||
    state.now < state.callAudioPreservePriorityUntil
  );
}

/** Чистая версия resolvePersistedCallAudioRouteForReapply. */
export function resolvePersistedCallAudioRouteForReapplyFromState(
  route: InCallAudioRoute | null,
  state: CallAudioRouteReapplyState,
): InCallAudioRoute | null {
  if (state.appInBackground && isAudioOnlyOngoingCallContextFromState(state)) {
    if (isSystemPiPRouteTransitionFromState(state)) {
      if (route && isExternalHeadsetRoute(route)) return route;
      if (route === 'EARPIECE' || route === 'SPEAKER_PHONE') return route;
      return route || 'EARPIECE';
    }
    if (route && isExternalHeadsetRoute(route)) return route;
    return 'SPEAKER_PHONE';
  }
  return resolvePersistedCallAudioRouteForActiveUiFromState(route, state);
}

/** На video UI не восстанавливаем разговорный из persist (кроме audio-only экрана). */
export function resolvePersistedCallAudioRouteForActiveUi(
  route: InCallAudioRoute | null,
): InCallAudioRoute | null {
  return resolvePersistedCallAudioRouteForActiveUiFromState(
    route,
    gatherCallAudioRouteReapplyState(),
  );
}

/** Активный аудиозвонок (экран или sticky после Home), не video UI. */
export function isAudioOnlyOngoingCallContext(): boolean {
  try {
    return isAudioOnlyOngoingCallContextFromState(gatherCallAudioRouteReapplyState());
  } catch {
    return false;
  }
}

/**
 * Reapply / capture при уходе в фон: audio-only → громкая связь, кроме Bluetooth.
 * На экране аудиозвонка (foreground) маршрут не меняем.
 */
export function resolvePersistedCallAudioRouteForReapply(
  route: InCallAudioRoute | null,
): InCallAudioRoute | null {
  return resolvePersistedCallAudioRouteForReapplyFromState(
    route,
    gatherCallAudioRouteReapplyState(),
  );
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
    if (available.length && !available.includes(route)) {
      // ICM lag: native probe / BT cache ещё держат гарнитуру.
      try {
        const probe = (global as any).__nativeCallAudioRoutesRef?.current as
          | { available?: string[] }
          | undefined;
        if (Array.isArray(probe?.available) && probe.available.includes(route)) {
          if (route === 'BLUETOOTH') {
            const cached = (global as any).__callBtHeadsetConnectedRef?.current;
            if (cached === false) return null;
          }
          return route;
        }
      } catch {}
      return null;
    }
    return route;
  } catch {
    return null;
  }
}

export function captureCallAudioRouteFromUi(): void {
  try {
    const g = global as any;
    const userBuiltin = readUserSelectedCallAudioRoute();
    if (userBuiltin === 'SPEAKER_PHONE' || userBuiltin === 'EARPIECE') {
      g.__persistedCallAudioRouteRef = g.__persistedCallAudioRouteRef || { current: null };
      g.__persistedCallAudioRouteRef.current = userBuiltin;
      g.__lastAppliedCallAudioRouteRef = { current: userBuiltin };
      const params = g.__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = userBuiltin;
      }
      return;
    }
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
    const available = readInCallAvailableAudioRoutesList();
    const candidates = [
      readUserSelectedExternalCallAudioRoute(),
      normalizeInCallRoute(liveUserRoute || ''),
      readLastAppliedCallAudioRoute(),
      normalizeInCallRoute((global as any).__currentCallPiPParamsRef?.current?.audioOutputRoute || ''),
      normalizeInCallRoute((global as any).__persistedCallAudioRouteRef?.current || ''),
    ];
    const found = candidates.find((r) => r && isExternalHeadsetRoute(r)) || null;
    if (!found) return null;
    if (available.length && !available.includes(found)) {
      try {
        const probe = (global as any).__nativeCallAudioRoutesRef?.current as
          | { available?: string[] }
          | undefined;
        if (Array.isArray(probe?.available) && probe.available.includes(found)) {
          if (found === 'BLUETOOTH') {
            const cached = (global as any).__callBtHeadsetConnectedRef?.current;
            if (cached === false) return null;
          }
          return found;
        }
      } catch {}
      return null;
    }
    return found;
  } catch {
    return null;
  }
}

export function readInCallAvailableAudioRoutesForCycle(): string[] {
  try {
    const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
    return Array.isArray(av) ? av.map((s: unknown) => String(s)) : [];
  } catch {
    return [];
  }
}

function readInCallAvailableAudioRoutesList(): string[] {
  return readInCallAvailableAudioRoutesForCycle();
}

export { readConnectedExternalCallAudioRoute } from './callConnectedExternalAudioRoute';

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

/** После endCall: не наследовать video/PiP UI на следующий audio-first mount. */
export function resetDirectCallVideoUiGlobalsAfterCallEnd(): void {
  try {
    clearFreshDirectCallAudioAcceptCall();
    clearDirectCallAudioAcceptBootstrapped();
  } catch {}
  try {
    const g = global as any;
    g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
    g.__expandToVideoCallUiFromPiPRef.current = false;
    g.__stayOnVideoCallUiRef = g.__stayOnVideoCallUiRef || { current: false };
    g.__stayOnVideoCallUiRef.current = false;
    g.__directCallUserRequestedVideoExpandRef =
      g.__directCallUserRequestedVideoExpandRef || { current: false };
    g.__directCallUserRequestedVideoExpandRef.current = false;
    g.__directCallVideoExpandUntilRef = g.__directCallVideoExpandUntilRef || { current: 0 };
    g.__directCallVideoExpandUntilRef.current = 0;
    g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || {
      current: false,
    };
    g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
    g.__pipInAppRtcFromAudioOnlyRef = g.__pipInAppRtcFromAudioOnlyRef || { current: false };
    g.__pipInAppRtcFromAudioOnlyRef.current = false;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.inAudioOnlyUi = false;
      params.preferVideoCallUi = false;
    }
  } catch {}
}

export function markActiveCallAudioRouteCallId(callId?: string | null): void {
  try {
    const g = global as any;
    const nextCallId = String(callId || '').trim();
    const prevCallId = String(g.__activeCallAudioRouteCallIdRef?.current || '').trim();
    if (nextCallId && nextCallId !== prevCallId) {
      if (g.__manualBuiltinCallAudioRouteRef) g.__manualBuiltinCallAudioRouteRef.current = null;
      if (g.__userSelectedCallAudioRouteRef) g.__userSelectedCallAudioRouteRef.current = null;
      if (g.__explicitBuiltInCallAudioRouteRef) g.__explicitBuiltInCallAudioRouteRef.current = false;
      if (g.__persistedCallAudioRouteRef) g.__persistedCallAudioRouteRef.current = null;
      if (g.__lastAppliedCallAudioRouteRef) g.__lastAppliedCallAudioRouteRef.current = null;
      if (g.__userSelectedExternalCallAudioRouteRef) {
        g.__userSelectedExternalCallAudioRouteRef.current = null;
      }
      if (g.__builtinCallAudioRouteBeforeHeadsetRef) {
        g.__builtinCallAudioRouteBeforeHeadsetRef.current = null;
      }
      if (g.__directCallAudioRouteBeforeVideoRef) {
        g.__directCallAudioRouteBeforeVideoRef.current = null;
      }
      if (g.__directAudioInitialRouteNormalizedKeyRef) {
        g.__directAudioInitialRouteNormalizedKeyRef.current = '';
      }
      if (g.__directCallIncomingAcceptAudioBootstrapRef) {
        g.__directCallIncomingAcceptAudioBootstrapRef.current = null;
      }
      if (g.__lastCycleUserRouteCallIdRef) {
        g.__lastCycleUserRouteCallIdRef.current = null;
      }
      if (g.__lastCycleUserRouteResultRef) {
        g.__lastCycleUserRouteResultRef.current = null;
      }
      if (g.__audioUiExplicitCycleRouteRef) {
        g.__audioUiExplicitCycleRouteRef.current = null;
      }
      if (g.__inAppPiPExplicitToggleRouteRef) {
        g.__inAppPiPExplicitToggleRouteRef.current = null;
      }
      g.__inCallSelectedAudioRouteRef = g.__inCallSelectedAudioRouteRef || { current: null };
      g.__inCallSelectedAudioRouteRef.current = null;
      try {
        clearCallAudioRouteUiLock();
      } catch {}
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
  const userSelNow = readUserSelectedCallAudioRoute();
  if (isExternalHeadsetRoute(userSelNow)) return null;
  if (readUserSelectedExternalCallAudioRoute()) return null;
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

/** Cycle/toggle/PiP toggle — не авто-BT. Продуктовый earpiece при accept/bootstrap сюда не входит. */
export function userExplicitlyPinnedBuiltinCallAudio(): boolean {
  try {
    const g = global as any;
    const cycled = normalizeInCallRoute(g.__lastCycleUserRouteResultRef?.current || '');
    const cycledAt = Number(g.__lastCycleUserRouteAtRef?.current || 0);
    const cycledCallId = String(g.__lastCycleUserRouteCallIdRef?.current || '').trim();
    const activeCallId = String(g.__activeCallAudioRouteCallIdRef?.current || '').trim();
    if (
      (cycled === 'SPEAKER_PHONE' || cycled === 'EARPIECE') &&
      activeCallId &&
      cycledCallId === activeCallId &&
      Date.now() - cycledAt < 120_000
    ) {
      return true;
    }
    const explicitCycle = normalizeInCallRoute(g.__audioUiExplicitCycleRouteRef?.current || '');
    if (
      (explicitCycle === 'SPEAKER_PHONE' || explicitCycle === 'EARPIECE') &&
      activeCallId &&
      cycledCallId === activeCallId
    ) {
      return true;
    }
    const pipToggle = normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || '');
    if (
      (pipToggle === 'SPEAKER_PHONE' || pipToggle === 'EARPIECE') &&
      activeCallId &&
      cycledCallId === activeCallId
    ) {
      return true;
    }
  } catch {}
  return false;
}

/** Снять pin уха/громкой — перед авто-переходом на BT/провод при подключении. */
export function clearBuiltinPinForExternalHeadsetConnect(): void {
  try {
    const g = global as any;
    if (g.__manualBuiltinCallAudioRouteRef) g.__manualBuiltinCallAudioRouteRef.current = null;
    g.__explicitBuiltInCallAudioRouteRef = g.__explicitBuiltInCallAudioRouteRef || { current: false };
    g.__explicitBuiltInCallAudioRouteRef.current = false;
    g.__audioUiExplicitCycleRouteRef = { current: null };
    g.__inAppPiPExplicitToggleRouteRef = { current: null };
    g.__lastCycleUserRouteResultRef = { current: null };
    g.__lastCycleUserRouteAtRef = { current: 0 };
  } catch {}
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

export function isPiPBuiltinCallAudioRouteLockActive(): boolean {
  try {
    return Number((global as any).__pipBuiltinRouteLockUntilRef?.current || 0) > Date.now();
  } catch {
    return false;
  }
}

/** Полный video UI: выбор «ухо» в audio-плашке не должен держать earpiece / manual lock. */
export function releaseInAppPiPBuiltinAudioLockForFullVideoUi(): void {
  try {
    const g = global as any;
    g.__pipBuiltinRouteLockUntilRef = g.__pipBuiltinRouteLockUntilRef || { current: 0 };
    g.__pipBuiltinRouteLockUntilRef.current = 0;
    g.__inAppPiPExplicitToggleRouteRef = g.__inAppPiPExplicitToggleRouteRef || { current: null };
    const explicit = normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || '');
    if (explicit === 'EARPIECE' || explicit === 'SPEAKER_PHONE') {
      g.__inAppPiPExplicitToggleRouteRef.current = null;
    }
    g.__explicitBuiltInCallAudioRouteRef = g.__explicitBuiltInCallAudioRouteRef || { current: false };
    g.__explicitBuiltInCallAudioRouteRef.current = false;
    g.__manualBuiltinCallAudioRouteRef = { current: null };
  } catch {}
}

/** После PiP / system PiP: выбор в плашке и persist важнее устаревшего lastApplied. */
export function readAuthoritativeCallAudioRouteAfterPiP(): InCallAudioRoute | null {
  try {
    const g = global as any;
    if (isPiPBuiltinCallAudioRouteLockActive()) {
      const explicit = normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || '');
      if (
        explicit === 'SPEAKER_PHONE' ||
        explicit === 'EARPIECE' ||
        isExternalHeadsetRoute(explicit)
      ) {
        return explicit;
      }
    }
    const explicitIdle = normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || '');
    const pipPlaqueRoute = readInAppPiPAudioOutputRoute();
    const audioOrPlaqueCtx =
      isInAudioOnlyCallUi() ||
      (() => {
        try {
          return isPipVisible() && !isPipInSystemMode();
        } catch {
          return false;
        }
      })();
    if (isInAudioOnlyCallUi()) {
      try {
        if (!isPipVisible()) {
          const fullUiSel = readUserSelectedCallAudioRoute();
          if (fullUiSel === 'SPEAKER_PHONE' && !userExplicitlyPinnedBuiltinCallAudio()) {
            // stale native/UI — не авторитет для audio-first
          } else if (
            fullUiSel === 'SPEAKER_PHONE' ||
            fullUiSel === 'EARPIECE' ||
            isExternalHeadsetRoute(fullUiSel)
          ) {
            return fullUiSel;
          }
        }
      } catch {}
    }
    if (audioOrPlaqueCtx) {
      if (
        pipPlaqueRoute === 'EARPIECE' ||
        pipPlaqueRoute === 'SPEAKER_PHONE' ||
        isExternalHeadsetRoute(pipPlaqueRoute)
      ) {
        return pipPlaqueRoute;
      }
    }
    const userSelEarly = readUserSelectedCallAudioRoute();
    if (
      (isInAudioOnlyCallUi() || isPiPBuiltinCallAudioRouteLockActive()) &&
      userSelEarly === 'EARPIECE'
    ) {
      return 'EARPIECE';
    }
    const candidates = [
      readUserSelectedCallAudioRoute(),
      explicitIdle === 'SPEAKER_PHONE' || explicitIdle === 'EARPIECE' ? explicitIdle : null,
      pipPlaqueRoute,
      normalizeInCallRoute(g.__persistedCallAudioRouteRef?.current || ''),
      readLastAppliedCallAudioRoute(),
    ];
    for (const r of candidates) {
      if (!r) continue;
      if (
        r === 'SPEAKER_PHONE' &&
        isInAudioOnlyCallUi() &&
        !userExplicitlyPinnedBuiltinCallAudio()
      ) {
        continue;
      }
      if (r === 'SPEAKER_PHONE' || r === 'EARPIECE' || isExternalHeadsetRoute(r)) {
        return r;
      }
    }
  } catch {}
  return null;
}

/**
 * Снимок для readInAppPiPAudioOutputRoute — самой сложной функции выбора маршрута
 * (какой динамик показывать/включать в in-app PiP-плашке).
 * Все чтения здесь без побочных эффектов: nativeCallAudioProbe/BT-кэш/ICM-список
 * только читаются, поэтому их безопасно снять один раз заранее.
 */
export type PiPAudioOutputRouteState = {
  pipVisible: boolean;
  fromParams: InCallAudioRoute | null;
  userSel: InCallAudioRoute | null;
  icmSelected: InCallAudioRoute | null;
  stored: InCallAudioRoute | null;
  lastApplied: InCallAudioRoute | null;
  explicitToggle: InCallAudioRoute | null;
  extLocked: InCallAudioRoute | null;
  availableRoutes: string[];
  btHeadsetActiveForCall: boolean;
  uiLockRoute: InCallAudioRoute | null;
  pipInAppRtcFromAudioOnly: boolean;
  paramsInAudioOnlyUi: unknown;
  paramsPreferVideoCallUi: unknown;
  /** readConnectedExternalCallAudioRoute(hint) || readActiveExternalCallAudioRoute(hint) */
  externalForHint: InCallAudioRoute | null;
};

export function gatherPiPAudioOutputRouteState(): PiPAudioOutputRouteState {
  const g = global as any;
  function read<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }
  const params = read<any>(() => g.__currentCallPiPParamsRef?.current, null);
  const fromParams = read(() => normalizeInCallRoute(params?.audioOutputRoute || ''), null);
  const userSel = read(() => readUserSelectedCallAudioRoute(), null);
  const icmSelected = read(
    () => normalizeInCallRoute(g.__inCallSelectedAudioRouteRef?.current || ''),
    null,
  );
  const stored = read(() => normalizeInCallRoute(g.__persistedCallAudioRouteRef?.current || ''), null);
  const lastApplied = read(() => readLastAppliedCallAudioRoute(), null);
  const explicitToggle = read(
    () => normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || ''),
    null,
  );
  const extLocked = read(() => readUserSelectedExternalCallAudioRoute(), null);
  const hint = fromParams || userSel || stored || lastApplied;
  return {
    pipVisible: read(() => g.__pipVisibleRef?.current === true, false),
    fromParams,
    userSel,
    icmSelected,
    stored,
    lastApplied,
    explicitToggle,
    extLocked,
    availableRoutes: read(() => readInCallAvailableAudioRoutesList(), []),
    btHeadsetActiveForCall: read(() => isBluetoothHeadsetActiveForCall(), false),
    uiLockRoute: read(() => readCallAudioRouteUiLock(), null),
    pipInAppRtcFromAudioOnly: read(() => g.__pipInAppRtcFromAudioOnlyRef?.current === true, false),
    paramsInAudioOnlyUi: read<unknown>(() => params?.inAudioOnlyUi, undefined),
    paramsPreferVideoCallUi: read<unknown>(() => params?.preferVideoCallUi, undefined),
    externalForHint: read(
      () => readConnectedExternalCallAudioRoute(hint) || readActiveExternalCallAudioRoute(hint),
      null,
    ),
  };
}

/** Гарнитура реально числится доступной в текущем звонке (ICM-список + BT-кэш). */
export function isExternalRouteListedInCallFromState(
  route: InCallAudioRoute | null | undefined,
  state: PiPAudioOutputRouteState,
): boolean {
  if (!route || !isExternalHeadsetRoute(route)) return false;
  if (route === 'BLUETOOTH' && !state.btHeadsetActiveForCall) return false;
  if (!state.availableRoutes.length) return false;
  return state.availableRoutes.includes(route);
}

/** Встроенный маршрут, когда выбранная гарнитура недоступна. */
export function readPiPBuiltinWhenExternalUnavailableFromState(
  state: PiPAudioOutputRouteState,
): InCallAudioRoute {
  const lock = state.uiLockRoute;
  if (lock === 'EARPIECE' || lock === 'SPEAKER_PHONE') return lock;
  const fromAudioPiP = state.pipInAppRtcFromAudioOnly;
  if (fromAudioPiP || state.paramsInAudioOnlyUi === true) return 'EARPIECE';
  if (state.stored === 'EARPIECE' || state.stored === 'SPEAKER_PHONE') return state.stored;
  if (state.lastApplied === 'EARPIECE' || state.lastApplied === 'SPEAKER_PHONE') {
    return state.lastApplied;
  }
  if (state.paramsPreferVideoCallUi === true && !fromAudioPiP) return 'SPEAKER_PHONE';
  return 'EARPIECE';
}

/** Чистая версия readInAppPiPAudioOutputRoute: тот же приоритет источников, но на snapshot. */
export function readInAppPiPAudioOutputRouteFromState(
  state: PiPAudioOutputRouteState,
): InCallAudioRoute {
  const { fromParams, userSel, icmSelected, stored, lastApplied, explicitToggle, extLocked } = state;
  const listed = (r: InCallAudioRoute | null | undefined): boolean =>
    isExternalRouteListedInCallFromState(r, state);
  const builtinFallback = (): InCallAudioRoute =>
    readPiPBuiltinWhenExternalUnavailableFromState(state);

  if (state.pipVisible) {
    if (extLocked && listed(extLocked)) {
      return extLocked;
    }
    if (
      explicitToggle &&
      (isExternalHeadsetRoute(explicitToggle) ||
        explicitToggle === 'EARPIECE' ||
        explicitToggle === 'SPEAKER_PHONE')
    ) {
      if (isExternalHeadsetRoute(explicitToggle)) {
        if (listed(explicitToggle)) return explicitToggle;
      } else {
        return explicitToggle;
      }
    }
  }

  if (
    state.pipVisible &&
    (icmSelected === 'EARPIECE' || icmSelected === 'SPEAKER_PHONE') &&
    isExternalHeadsetRoute(fromParams) &&
    !listed(fromParams)
  ) {
    return icmSelected;
  }

  if (userSel && isExternalHeadsetRoute(userSel) && listed(userSel)) {
    return userSel;
  }
  if (fromParams && isExternalHeadsetRoute(fromParams) && listed(fromParams)) {
    return fromParams;
  }
  if (lastApplied && isExternalHeadsetRoute(lastApplied) && listed(lastApplied)) {
    return lastApplied;
  }

  if (userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE') return userSel;

  // Video→in-app PiP: ICM часто ещё EARPIECE после audio-only, пока persist/params уже SPEAKER.
  if (state.pipVisible && !state.pipInAppRtcFromAudioOnly) {
    const videoBuiltin =
      (fromParams === 'SPEAKER_PHONE' || fromParams === 'EARPIECE' ? fromParams : null) ||
      (lastApplied === 'SPEAKER_PHONE' || lastApplied === 'EARPIECE' ? lastApplied : null) ||
      (stored === 'SPEAKER_PHONE' || stored === 'EARPIECE' ? stored : null);
    if (videoBuiltin === 'SPEAKER_PHONE') return 'SPEAKER_PHONE';
    if (videoBuiltin === 'EARPIECE' && icmSelected !== 'SPEAKER_PHONE') return 'EARPIECE';
  }

  if (icmSelected === 'SPEAKER_PHONE' || icmSelected === 'EARPIECE') return icmSelected;

  if (fromParams && isExternalHeadsetRoute(fromParams) && !listed(fromParams)) {
    return builtinFallback();
  }
  if (userSel && isExternalHeadsetRoute(userSel) && !listed(userSel)) {
    return builtinFallback();
  }

  const builtinPersisted =
    (stored === 'SPEAKER_PHONE' || stored === 'EARPIECE' ? stored : null) ||
    (lastApplied === 'SPEAKER_PHONE' || lastApplied === 'EARPIECE' ? lastApplied : null);
  if (builtinPersisted) return builtinPersisted;

  if (userSel && listed(userSel)) return userSel;

  if (fromParams === 'SPEAKER_PHONE' || fromParams === 'EARPIECE') return fromParams;

  if (fromParams && listed(fromParams)) return fromParams;

  const hint = fromParams || userSel || stored || lastApplied;
  const external = state.externalForHint;
  if (external && listed(external)) return external;

  if (
    (userSel && isExternalHeadsetRoute(userSel)) ||
    (fromParams && isExternalHeadsetRoute(fromParams)) ||
    (hint && isExternalHeadsetRoute(hint))
  ) {
    return builtinFallback();
  }

  const intent = fromParams || stored || lastApplied;
  if (intent === 'SPEAKER_PHONE' || intent === 'EARPIECE') return intent;
  if (isExternalHeadsetRoute(intent)) {
    return builtinFallback();
  }
  return intent || 'EARPIECE';
}

/** Маршрут из PiP params + persist ref (без импорта callAudioRoutePersist — без циклов). */
export function readInAppPiPAudioOutputRoute(): InCallAudioRoute {
  try {
    return readInAppPiPAudioOutputRouteFromState(gatherPiPAudioOutputRouteState());
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
    const preferAudioOnlyUi = (() => {
      if (isInAudioOnlyCallUi()) return true;
      try {
        const gg = global as any;
        if (gg.__preferAudioOnlyUiOnNextVideoCallRef?.current === true) return true;
        if (gg.__pipInAppRtcFromAudioOnlyRef?.current === true) return true;
        if (
          gg.__pipAudioOnlyPlaceholderRef?.current === true &&
          gg.__stayOnVideoCallUiRef?.current !== true
        ) {
          return true;
        }
      } catch {}
      return false;
    })();
    const fromParams = normalizeInCallRoute(
      g.__currentCallPiPParamsRef?.current?.audioOutputRoute || '',
    );
    const stored = normalizeInCallRoute(g.__persistedCallAudioRouteRef?.current || '');
    const routeFromPiP = readInAppPiPAudioOutputRoute();
    const userSel = readUserSelectedCallAudioRoute();
    const extSel =
      readUserSelectedExternalCallAudioRoute() ||
      readActiveExternalCallAudioRoute(userSel || routeFromPiP);
    let audioRoute: InCallAudioRoute;
    if (preferAudioOnlyUi) {
      if (isExternalHeadsetRoute(extSel)) {
        audioRoute = extSel;
      } else {
        const uiLock = readCallAudioRouteUiLock();
        if (
          uiLock === 'EARPIECE' ||
          uiLock === 'SPEAKER_PHONE' ||
          isExternalHeadsetRoute(uiLock)
        ) {
          audioRoute = uiLock;
        } else {
          const fromUiSelected = normalizeInCallRoute(
            g.__inCallSelectedAudioRouteRef?.current || '',
          );
          const merged =
            readLastAppliedCallAudioRoute() ||
            (fromUiSelected === 'EARPIECE' || fromUiSelected === 'SPEAKER_PHONE'
              ? fromUiSelected
              : null) ||
            routeFromPiP ||
            stored ||
            fromParams ||
            normalizeInCallRoute(g.__audioUiExplicitCycleRouteRef?.current || '') ||
            userSel ||
            'EARPIECE';
          const norm = normalizeInCallRoute(String(merged));
          if (norm === 'SPEAKER_PHONE' || norm === 'EARPIECE') {
            audioRoute = norm;
          } else if (isExternalHeadsetRoute(norm)) {
            audioRoute = norm;
          } else {
            audioRoute = 'EARPIECE';
          }
        }
      }
    } else {
      audioRoute = (fromParams || stored || routeFromPiP || 'SPEAKER_PHONE') as InCallAudioRoute;
    }
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
    let route = normalizeInCallRoute(snap.audioRoute || '');
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
