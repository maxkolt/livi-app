import { Platform, NativeModules } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute, mapRouteForEnterVideoUi, normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { beginBackgroundMediaSuppression } from './backgroundMediaSuppression';
import { applyNativeVoiceCallSpeaker, applyNativeVoiceCallRoute } from './voiceCallAudioRoute';
import { logger } from './logger';
import {
  applySystemPiPReturnMediaSnapshot,
  captureCallAudioRouteFromUi,
  isAppInCallBackgroundState,
  isAudioOnlyOngoingCallContext,
  peekSystemPiPReturnMediaSnapshot,
  type SystemPiPReturnMediaSnapshot,
  resolveActiveCallInCallMedia,
  resolvePersistedCallAudioRouteForReapply,
  readInAppPiPAudioOutputRoute,
  readAuthoritativeCallAudioRouteAfterPiP,
  readLastAppliedCallAudioRoute,
  readActiveExternalCallAudioRoute,
  rememberManualBuiltinCallAudioRoute,
  markDirectCallVideoMediaActive,
  restoreOngoingCallMicrophoneIfEnabled,
  isOngoingCallSession,
  isInCallAudioSessionStarted,
  markInCallAudioSessionStarted,
  readUserSelectedCallAudioRoute,
  readUserLockedBuiltinCallAudioRoute,
  userExplicitlyPinnedBuiltinCallAudio,
  readUserSelectedExternalCallAudioRoute,
  readConnectedExternalCallAudioRoute,
  setUserSelectedCallAudioRoute,
  markUserSelectedExternalCallAudioRoute,
  isDirectAudioEarpieceStabilizeWindow,
  ongoingCallPrefersVideoMedia,
  isPiPBuiltinCallAudioRouteLockActive,
  releaseInAppPiPBuiltinAudioLockForFullVideoUi,
  resetDirectCallVideoUiGlobalsAfterCallEnd,
} from './activeCallSession';
import { getCallMediaHint } from './directCallMediaHint';
import { isInAudioOnlyCallUi } from './callAudioOnlyUiContext';
import {
  isDirectCallVideoExpandGuardActive,
  prepareDirectCallVideoReturnFromPiP,
  clearStaleDirectCallVideoExpandGlobalHints,
  finishDirectCallVideoExpandInFlight,
  markDirectCallUserRequestedVideoExpand,
} from './directCallVideoExpandGuard';
import { isInAppPiPExplicitBuiltinRouteChoiceActive, isInAppPiPManualRouteLockActive } from './inAppPiPExplicitBuiltinRoute';
import {
  resolveCallRouteAfterHeadsetDisconnect,
  rememberBuiltinCallRouteBeforeHeadset,
  readDirectCallAudioRouteBeforeVideo,
  isInSystemPiPMode,
  isInAppPiPVideoPathContext,
} from './callHeadsetAudioFallback';
import {
  readNativeProbedExternalRoute,
  mergeNativeProbeIntoGlobal,
  probeNativeCallAudioRoutes,
  isCallAudioBootstrapPending,
  isBluetoothHeadsetActiveForCall,
} from './nativeCallAudioProbe';
import {
  isCallAudioPiPTransitionWindow,
  armCallAudioPreservePriority,
  armCallAudioRouteUiLock,
  readCallAudioRouteUiLock,
  clearCallAudioRouteUiLock,
  armCallAudioNativeTransitionLock,
  isCallAudioNativeTransitionLocked,
  shouldSkipScheduledReturnToAudioUiReapply,
  armCallAudioPreferAudioModeQuiet,
} from './callAudioRouteTransitionGuards';
import { readRootCurrentRouteName } from './safeRootNavigation';
import { notifyInAppPiPAudioRouteUi } from './callInAppPiPAudioRouteUi';
export {
  isCallAudioPiPTransitionWindow,
  armCallAudioPreservePriority,
  armCallAudioRouteUiLock,
  readCallAudioRouteUiLock,
  clearCallAudioRouteUiLock,
  armCallAudioNativeTransitionLock,
  isCallAudioNativeTransitionLocked,
  markCallAudioReturnToUiSyncApplied,
  shouldSkipScheduledReturnToAudioUiReapply,
  armCallAudioPreferAudioModeQuiet,
} from './callAudioRouteTransitionGuards';

function readAvailableAudioDeviceList(): string[] {
  try {
    const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
    return Array.isArray(av) ? av.map((s: unknown) => String(s)) : [];
  } catch {
    return [];
  }
}

/** Свежий вход на VideoCall (incoming / accept): сбросить «хвосты» PiP без активной плашки. */
export function clearStaleInAppPiPAudioContextForFreshCallNav(
  reason: string,
  callId?: string | null,
): void {
  if (reason !== 'incoming_navigate' && reason !== 'call_accepted' && reason !== 'flush_pending' && reason !== 'callkeep_answer') {
    return;
  }
  try {
    const g = global as any;
    const pipActive =
      g.__pipVisibleRef?.current === true || g.__pipInSystemModeRef?.current === true;
    const cid = String(callId ?? '').trim();
    const audioFreshCall = !!cid && getCallMediaHint(cid) === 'audio';

    if (audioFreshCall || !pipActive) {
      resetDirectCallVideoUiGlobalsAfterCallEnd();
      clearStaleDirectCallVideoExpandGlobalHints();
      g.__stayOnVideoCallUiRef = g.__stayOnVideoCallUiRef || { current: false };
      g.__stayOnVideoCallUiRef.current = false;
    }
    if (audioFreshCall) {
      g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || {
        current: false,
      };
      g.__preferAudioOnlyUiOnNextVideoCallRef.current = true;
      g.__inAudioOnlyUiRef = g.__inAudioOnlyUiRef || { current: false };
      g.__inAudioOnlyUiRef.current = true;
      g.__pipAudioOnlyPlaceholderRef = g.__pipAudioOnlyPlaceholderRef || { current: false };
      g.__pipAudioOnlyPlaceholderRef.current = true;
      g.__pipInAppRtcFromAudioOnlyRef = g.__pipInAppRtcFromAudioOnlyRef || { current: false };
      g.__pipInAppRtcFromAudioOnlyRef.current = false;
      const params = g.__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.inAudioOnlyUi = true;
        params.preferVideoCallUi = false;
        params.localCamOn = false;
        if (cid) params.callId = cid;
      }
    } else if (!pipActive) {
      if (cid && getCallMediaHint(cid) === 'audio') {
        g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || {
          current: false,
        };
        g.__preferAudioOnlyUiOnNextVideoCallRef.current = true;
        g.__inAudioOnlyUiRef = g.__inAudioOnlyUiRef || { current: false };
        g.__inAudioOnlyUiRef.current = true;
        g.__pipAudioOnlyPlaceholderRef = g.__pipAudioOnlyPlaceholderRef || { current: false };
        g.__pipAudioOnlyPlaceholderRef.current = true;
      }
    }
    if (pipActive && !audioFreshCall) {
      return;
    }
    releaseInAppPiPBuiltinAudioLockForFullVideoUi();
    g.__callAudioPreservePriorityUntilRef = g.__callAudioPreservePriorityUntilRef || { current: 0 };
    g.__callAudioPreservePriorityUntilRef.current = 0;
    g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
    if (Number(g.__returningFromSystemPiPUntilRef.current || 0) <= Date.now()) {
      g.__returningFromSystemPiPUntilRef.current = 0;
    }
    clearScheduledReapplies({ preserveReasonPrefixes: ['preserve_in_app_pip_headset'] });
    cancelScheduledCallAudioRouteReappliesMatching(['audio_home']);
    if (cid && getCallMediaHint(cid) === 'audio') {
      clearStaleHomeAudioRouteBeforeDirectCallAccept();
    }
  } catch {}
}

/** Не применять SPEAKER на audio-first accept без явного cycle на текущем callId. */
function coerceDirectAudioAcceptBuiltinRoute(route: InCallAudioRoute): InCallAudioRoute {
  if (route !== 'SPEAKER_PHONE') return route;
  if (userExplicitlyPinnedBuiltinCallAudio()) return route;
  if (isDirectAudioEarpieceStabilizeWindow()) return 'EARPIECE';
  try {
    const cid = String((global as any).__activeCallAudioRouteCallIdRef?.current || '').trim();
    if (cid && getCallMediaHint(cid) === 'audio') return 'EARPIECE';
  } catch {}
  return route;
}

/** После endCall: отменить отложенные reapply и снять carryover маршрута. */
export function clearDirectCallAudioRouteCarryoverAfterCallEnd(): void {
  cancelScheduledCallAudioRouteReappliesMatching([
    'return_to_audio_ui',
    'direct_call_accept_audio_route',
    'direct_call_video_ui_route',
    'audio_home',
  ]);
  try {
    const g = global as any;
    g.__inCallSelectedAudioRouteRef = g.__inCallSelectedAudioRouteRef || { current: null };
    g.__inCallSelectedAudioRouteRef.current = null;
    if (g.__audioUiExplicitCycleRouteRef) g.__audioUiExplicitCycleRouteRef.current = null;
    if (g.__inAppPiPExplicitToggleRouteRef) g.__inAppPiPExplicitToggleRouteRef.current = null;
    g.__activeCallAudioRouteCallIdRef = g.__activeCallAudioRouteCallIdRef || { current: '' };
    g.__activeCallAudioRouteCallIdRef.current = '';
  } catch {}
  clearCallAudioRouteUiLock();
}

/** Новый direct audio accept: не тащить SPEAKER с Home/прошлого звонка. */
export function clearStaleHomeAudioRouteBeforeDirectCallAccept(): void {
  try {
    cancelScheduledCallAudioRouteReappliesMatching([
      'return_to_audio_ui',
      'direct_call_accept_audio_route',
      'audio_home',
    ]);
    const g = global as any;
    if (g.__audioCallHomeSpeakerPinRef) {
      g.__audioCallHomeSpeakerPinRef.current = false;
    }
    g.__callAudioPreservePriorityUntilRef = g.__callAudioPreservePriorityUntilRef || { current: 0 };
    g.__callAudioPreservePriorityUntilRef.current = 0;
    if (readUserSelectedExternalCallAudioRoute()) return;
    const ext = readConnectedExternalCallAudioRoute();
    if (ext && isExternalHeadsetRoute(ext)) return;
    clearCallAudioRouteUiLock();
    setUserSelectedCallAudioRoute(null);
    if (g.__manualBuiltinCallAudioRouteRef) g.__manualBuiltinCallAudioRouteRef.current = null;
    if (g.__userSelectedCallAudioRouteRef) g.__userSelectedCallAudioRouteRef.current = null;
    if (g.__explicitBuiltInCallAudioRouteRef) g.__explicitBuiltInCallAudioRouteRef.current = false;
    g.__inCallSelectedAudioRouteRef = g.__inCallSelectedAudioRouteRef || { current: null };
    g.__inCallSelectedAudioRouteRef.current = 'EARPIECE';
    if (g.__audioUiExplicitCycleRouteRef) g.__audioUiExplicitCycleRouteRef.current = null;
    setPersistedCallAudioRoute('EARPIECE');
    g.__lastAppliedCallAudioRouteRef = { current: 'EARPIECE' };
  } catch {}
}

function readExplicitInAppPiPBuiltinRoute(): InCallAudioRoute | null {
  try {
    const g = global as any;
    const explicit = normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || '');
    if (explicit === 'EARPIECE' || explicit === 'SPEAKER_PHONE') {
      return explicit;
    }
  } catch {}
  return null;
}

function resolveReturnToAudioUiReapplyRoute(): InCallAudioRoute {
  const uiLock = readCallAudioRouteUiLock();
  if (
    uiLock === 'EARPIECE' ||
    uiLock === 'SPEAKER_PHONE' ||
    isExternalHeadsetRoute(uiLock)
  ) {
    return coercePersistedRouteForAvailableDevices(uiLock);
  }
  try {
    const fromUi = normalizeInCallRoute(
      (global as any).__inCallSelectedAudioRouteRef?.current || '',
    );
    if (fromUi === 'EARPIECE' || fromUi === 'SPEAKER_PHONE') {
      return coercePersistedRouteForAvailableDevices(fromUi);
    }
  } catch {}
  const lastApplied = readLastAppliedCallAudioRoute();
  if (lastApplied === 'EARPIECE' || lastApplied === 'SPEAKER_PHONE') {
    return coercePersistedRouteForAvailableDevices(lastApplied);
  }
  const plaqueExplicit = readExplicitInAppPiPBuiltinRoute();
  const userSel = readUserSelectedCallAudioRoute();
  const livePiP = readInAppPiPAudioOutputRoute();

  if (plaqueExplicit === 'EARPIECE' || userSel === 'EARPIECE') {
    return 'EARPIECE';
  }
  if (
    livePiP === 'EARPIECE' &&
    plaqueExplicit !== 'SPEAKER_PHONE' &&
    userSel !== 'SPEAKER_PHONE'
  ) {
    return 'EARPIECE';
  }

  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked === 'SPEAKER_PHONE' || locked === 'EARPIECE') {
    return locked;
  }
  const ext =
    readUserSelectedExternalCallAudioRoute() ||
    readActiveExternalCallAudioRoute(null);
  if (isExternalHeadsetRoute(ext)) {
    return ext;
  }
  const authoritative = readAuthoritativeCallAudioRouteAfterPiP();
  if (authoritative === 'EARPIECE') {
    return 'EARPIECE';
  }
  if (plaqueExplicit === 'SPEAKER_PHONE') {
    return 'SPEAKER_PHONE';
  }
  if (userSel === 'SPEAKER_PHONE') {
    return 'SPEAKER_PHONE';
  }
  if (livePiP === 'SPEAKER_PHONE') {
    return 'SPEAKER_PHONE';
  }
  if (authoritative === 'SPEAKER_PHONE') {
    return 'SPEAKER_PHONE';
  }
  const beforeVideo = readDirectCallAudioRouteBeforeVideo();
  if (beforeVideo === 'SPEAKER_PHONE') {
    return 'SPEAKER_PHONE';
  }
  if (beforeVideo === 'EARPIECE') {
    return 'EARPIECE';
  }
  const persisted = getPersistedCallAudioRoute();
  if (persisted === 'SPEAKER_PHONE') {
    return 'SPEAKER_PHONE';
  }
  return 'EARPIECE';
}

/** Реальный PiP / system PiP return — не окно armCallAudioPreservePriority при accept. */
export function hasRealInAppPiPOrSystemReturnContext(): boolean {
  try {
    const g = global as any;
    if (Number(g.__returningFromSystemPiPUntilRef?.current || 0) > Date.now()) return true;
    if (g.__pipInSystemModeRef?.current === true) return true;
    if (g.__pipSuspendedForSystemPiPRef?.current === true) return true;
    if (g.__restoringInAppPiPFromSystemRef?.current === true) return true;
    if (shouldPreserveCallAudioRouteInInAppPiP()) return true;
  } catch {}
  return false;
}

const DIRECT_CALL_VIDEO_EXPAND_AUDIO_PREPARED_MS = 3200;

function touchDirectCallVideoExpandAudioPrepared(): void {
  try {
    const g = global as any;
    g.__directCallVideoExpandAudioPreparedAtRef =
      g.__directCallVideoExpandAudioPreparedAtRef || { current: 0 };
    g.__directCallVideoExpandAudioPreparedAtRef.current = Date.now();
  } catch {}
}

/** Недавно вызван prepareDirectCallVideoExpandFromInAppPiP — не дублировать native reapply. */
export function isDirectCallVideoExpandAudioPreparedRecently(
  windowMs = DIRECT_CALL_VIDEO_EXPAND_AUDIO_PREPARED_MS,
): boolean {
  try {
    const at = Number((global as any).__directCallVideoExpandAudioPreparedAtRef?.current || 0);
    return at > 0 && Date.now() - at < windowMs;
  } catch {
    return false;
  }
}

/** Явный «громкий» в video in-app PiP — только если плашка/persist сейчас громкий (не stale lock/toggle). */
function readVideoInAppPiPExplicitSpeakerBeforeExpand(): boolean {
  const authoritative = normalizeInCallRoute(
    readInAppPiPAudioOutputRoute() ||
      readUserSelectedCallAudioRoute() ||
      getPersistedCallAudioRoute() ||
      '',
  );
  if (authoritative === 'BLUETOOTH' || authoritative === 'WIRED_HEADSET') {
    return false;
  }
  if (authoritative === 'EARPIECE') {
    return false;
  }
  return authoritative === 'SPEAKER_PHONE';
}

/** Video UI из in-app плашки (VideoCall уже на экране): UI-флаги + динамик/BT без earpiece. */
export function prepareDirectCallVideoExpandFromInAppPiP(): void {
  markDirectCallUserRequestedVideoExpand();
  const plaqueNow = normalizeInCallRoute(
    readInAppPiPAudioOutputRoute() || getPersistedCallAudioRoute() || '',
  );
  const userChoseSpeakerInPiP = readVideoInAppPiPExplicitSpeakerBeforeExpand();
  if (!userChoseSpeakerInPiP) {
    releaseInAppPiPBuiltinAudioLockForFullVideoUi();
  }
  if (Platform.OS === 'android') {
    armCallAudioNativeTransitionLock(900);
  }
  armCallAudioPreservePriority(5000);
  cancelScheduledCallAudioRouteReappliesMatching([
    'in_app_pip_from_',
    'direct_call_video_ui_route',
    'video_call_return_from_pip',
    'preserve_in_app_pip_headset',
  ]);
  touchDirectCallVideoExpandAudioPrepared();
  prepareDirectCallVideoReturnFromPiP();
  if (!userChoseSpeakerInPiP) {
    clearCallAudioRouteUiLock();
  }
  markDirectCallVideoMediaActive();
  try {
    if (isExternalHeadsetRoute(plaqueNow)) {
      clearCallAudioRouteUiLock();
      setPersistedCallAudioRoute(plaqueNow);
      setUserSelectedCallAudioRoute(plaqueNow);
      markUserSelectedExternalCallAudioRoute(plaqueNow);
      try {
        const g = global as any;
        g.__explicitBuiltInCallAudioRouteRef = { current: false };
        g.__lastAppliedCallAudioRouteRef = { current: plaqueNow };
      } catch {}
      void applyCallAudioOutputRouteNow(plaqueNow, { media: 'video', forceBuiltIn: false });
      return;
    }
    if (userChoseSpeakerInPiP) {
      setPersistedCallAudioRoute('SPEAKER_PHONE');
      setUserSelectedCallAudioRoute('SPEAKER_PHONE');
      rememberManualBuiltinCallAudioRoute('SPEAKER_PHONE');
      armCallAudioRouteUiLock('SPEAKER_PHONE');
      try {
        const g = global as any;
        g.__userSelectedExternalCallAudioRouteRef = { current: null };
        g.__explicitBuiltInCallAudioRouteRef = { current: true };
      } catch {}
      void applyCallAudioOutputRouteNow('SPEAKER_PHONE', { media: 'video', forceBuiltIn: true });
      return;
    }
    const ext =
      readUserSelectedExternalCallAudioRoute() ||
      readActiveExternalCallAudioRoute(readInAppPiPAudioOutputRoute());
    if (isExternalHeadsetRoute(ext)) {
      setPersistedCallAudioRoute(ext);
      setUserSelectedCallAudioRoute(ext);
      void applyCallAudioOutputRouteNow(ext, { media: 'video', forceBuiltIn: false });
      return;
    }
    pinVideoCallLoudSpeakerRoute();
    setUserSelectedCallAudioRoute(null);
    armCallAudioRouteUiLock('SPEAKER_PHONE');
    void applyCallAudioOutputRouteNow('SPEAKER_PHONE', { media: 'video', forceBuiltIn: true });
  } catch {}
}

export function readPreferredCallAudioRouteForTransition(): InCallAudioRoute {
  const snap = peekSystemPiPReturnMediaSnapshot();
  const fromSnap = normalizeInCallRoute(snap?.audioRoute || '');
  if (fromSnap) return fromSnap;
  return readInAppPiPAudioOutputRoute();
}

/** Громкая связь на Home только для audio-only без гарнитуры и вне PiP-переходов. */
export function shouldApplyHomeLoudSpeakerPin(): boolean {
  try {
    if (isInAppPiPContextIncludingSuspended()) return false;
  } catch {}
  if (!isAudioOnlyOngoingCallContext()) return false;
  if (resolveActiveCallInCallMedia() === 'video') return false;
  if (readActiveExternalCallAudioRoute()) return false;
  if (isCallAudioPiPTransitionWindow()) return false;

  const preferred = readPreferredCallAudioRouteForTransition();
  if (isExternalHeadsetRoute(preferred)) return false;
  if (preferred === 'EARPIECE') return false;
  return true;
}

/** На экране звонка во время bootstrap не пушить EARPIECE из PiP «preferred». */
export function shouldDeferPreserveDuringCallBootstrap(): boolean {
  if (readUserLockedBuiltinCallAudioRoute()) return false;
  if (!isCallAudioBootstrapPending()) return false;
  if (isAppInCallBackgroundState()) return false;
  try {
    const routeName = readRootCurrentRouteName();
    if (routeName === 'VideoCall') return true;
  } catch {}
  return false;
}

function resolvePreserveCallAudioRoute(): InCallAudioRoute {
  const lockedBuiltin = readUserLockedBuiltinCallAudioRoute();
  if (lockedBuiltin) return lockedBuiltin;
  if (ongoingCallPrefersVideoMedia()) {
    const userSel = readUserSelectedCallAudioRoute();
    if (userSel && (isExternalHeadsetRoute(userSel) || userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE')) {
      if (isExternalHeadsetRoute(userSel)) return userSel;
      if (shouldPreserveCallAudioRouteInInAppPiP()) return userSel;
      return mapRouteForEnterVideoUi(userSel);
    }
    const persisted = getPersistedCallAudioRoute();
    if (persisted) {
      return resolveVideoInAppPiPAudioRoute(persisted, {
        mapForEnterVideoUi: !shouldPreserveCallAudioRouteInInAppPiP(),
      });
    }
    return 'SPEAKER_PHONE';
  }
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE') return userSel;
  const last = readLastAppliedCallAudioRoute();
  if (last === 'SPEAKER_PHONE' || last === 'EARPIECE') return last;
  const persisted = getPersistedCallAudioRoute();
  if (persisted === 'SPEAKER_PHONE' || persisted === 'EARPIECE') return persisted;
  return readPreferredCallAudioRouteForTransition();
}

function schedulePreserveCallAudioRoute(reason: string, media?: 'audio' | 'video'): void {
  if (shouldDeferPreserveDuringCallBootstrap()) {
    armCallAudioPreservePriority();
    scheduleReapplyPersistedCallAudioRoute('audio_home_preserve_route_deferred', {
      media: media ?? resolveActiveCallInCallMedia(),
      delaysMs: [2600, 3400],
    });
    return;
  }
  const lockedBuiltin = readUserLockedBuiltinCallAudioRoute();
  const userSel = readUserSelectedCallAudioRoute();
  const honorUser =
    !!lockedBuiltin ||
    ((userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE') &&
      !(
        userSel === 'SPEAKER_PHONE' &&
        isDirectAudioEarpieceStabilizeWindow() &&
        !lockedBuiltin &&
        !userExplicitlyPinnedBuiltinCallAudio()
      ));
  const route = resolvePreserveCallAudioRoute();
  setPersistedCallAudioRoute(route);
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    (global as any).__lastAppliedCallAudioRouteRef = { current: route };
  } catch {}
  armCallAudioPreservePriority();
  scheduleReapplyPersistedCallAudioRoute(reason, {
    media: media ?? resolveActiveCallInCallMedia(),
    delaysMs: [0, 400, 1200],
    honorUserRoute: honorUser,
    skipInCallRestart: honorUser && isInCallAudioSessionStarted() && isOngoingCallSession(),
  });
}

/** In-app PiP, suspend под system PiP или restore с system PiP — плашка «активна» для audio guards. */
export function isInAppPiPContextIncludingSuspended(): boolean {
  try {
    const g = global as any;
    return (
      g.__pipVisibleRef?.current === true ||
      g.__pipSuspendedForSystemPiPRef?.current === true ||
      g.__restoringInAppPiPFromSystemRef?.current === true
    );
  } catch {
    return false;
  }
}

function shouldKeepExternalRouteDespiteMissingFromList(route: InCallAudioRoute): boolean {
  if (!isExternalHeadsetRoute(route)) return false;
  if (route === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall()) return false;
  try {
    const list = readAvailableAudioDeviceList();
    if (list.length && !list.includes(route)) return false;

    const nativeExt = readNativeProbedExternalRoute();
    if (nativeExt === route && (!list.length || list.includes(route))) return true;

    if (list.includes(route)) {
      if (readLastAppliedCallAudioRoute() === route && isOngoingCallSession()) return true;
      if (readUserSelectedExternalCallAudioRoute() === route) return true;
      if (readActiveExternalCallAudioRoute() === route) return true;
    }
  } catch {}
  return false;
}

function coercePersistedRouteForAvailableDevices(route: InCallAudioRoute): InCallAudioRoute {
  try {
    const list = readAvailableAudioDeviceList();
    const bluetoothInactive =
      route === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall();
    if (!list.length) {
      if (bluetoothInactive) {
        const locked = readUserLockedBuiltinCallAudioRoute();
        if (locked) return locked;
        const last = readLastAppliedCallAudioRoute();
        if (last === 'SPEAKER_PHONE' || last === 'EARPIECE') return last;
        const persistedBuiltin = getPersistedCallAudioRoute();
        if (persistedBuiltin === 'SPEAKER_PHONE' || persistedBuiltin === 'EARPIECE') {
          return persistedBuiltin;
        }
        return resolveCallRouteAfterHeadsetDisconnect();
      }
      return route;
    }
    if (!list.includes(route) && shouldKeepExternalRouteDespiteMissingFromList(route)) {
      return route;
    }
    if (route === 'BLUETOOTH' && (bluetoothInactive || !list.includes('BLUETOOTH'))) {
      if (isInSystemPiPMode()) return resolveCallRouteAfterHeadsetDisconnect();
      const locked = readUserLockedBuiltinCallAudioRoute();
      if (locked) return locked;
      const last = readLastAppliedCallAudioRoute();
      if (last === 'SPEAKER_PHONE' || last === 'EARPIECE') return last;
      const persistedBuiltin = getPersistedCallAudioRoute();
      if (persistedBuiltin === 'SPEAKER_PHONE' || persistedBuiltin === 'EARPIECE') {
        return persistedBuiltin;
      }
      return resolveCallRouteAfterHeadsetDisconnect();
    }
    if (route === 'WIRED_HEADSET' && !list.includes('WIRED_HEADSET')) {
      if (isInSystemPiPMode()) return resolveCallRouteAfterHeadsetDisconnect();
      const locked = readUserLockedBuiltinCallAudioRoute();
      if (locked) return locked;
      return resolveCallRouteAfterHeadsetDisconnect();
    }
  } catch {}
  return route;
}

export function setPersistedCallAudioRoute(route: InCallAudioRoute): void {
  try {
    const g = global as any;
    g.__persistedCallAudioRouteRef = g.__persistedCallAudioRouteRef || { current: null };
    g.__persistedCallAudioRouteRef.current = route;
  } catch {}
}

export function getPersistedCallAudioRoute(): InCallAudioRoute | null {
  try {
    return normalizeInCallRoute((global as any).__persistedCallAudioRouteRef?.current || '');
  } catch {
    return null;
  }
}

export function clearPersistedCallAudioRoute(): void {
  try {
    const g = global as any;
    if (g.__persistedCallAudioRouteRef) g.__persistedCallAudioRouteRef.current = null;
    if (g.__userSelectedCallAudioRouteRef) g.__userSelectedCallAudioRouteRef.current = null;
    if (g.__userSelectedExternalCallAudioRouteRef) g.__userSelectedExternalCallAudioRouteRef.current = null;
    if (g.__manualBuiltinCallAudioRouteRef) g.__manualBuiltinCallAudioRouteRef.current = null;
    if (g.__explicitBuiltInCallAudioRouteRef) g.__explicitBuiltInCallAudioRouteRef.current = false;
  } catch {}
  lastNativeInCallSignature = '';
  lastReapplySignature = '';
}

/** Home / фон с экрана «Аудиозвонок»: громкая связь (кроме Bluetooth / провода). */
export function pinLoudSpeakerForAudioCallLeavingToBackground(): void {
  try {
    if (isInAppPiPContextIncludingSuspended()) return;
  } catch {}
  if (!isAudioOnlyOngoingCallContext()) return;
  if (resolveActiveCallInCallMedia() === 'video') return;
  const externalIntent = readActiveExternalCallAudioRoute();
  if (externalIntent) {
    setPersistedCallAudioRoute(externalIntent);
    try {
      const params = (global as any).__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = externalIntent;
      }
      (global as any).__lastAppliedCallAudioRouteRef = { current: externalIntent };
    } catch {}
    scheduleReapplyPersistedCallAudioRoute('pin_preserve_headset', {
      media: 'audio',
      delaysMs: [0, 400, 1200],
    });
    return;
  }
  captureCallAudioRouteFromUi();
  const fromParams = normalizeInCallRoute(
    (global as any).__currentCallPiPParamsRef?.current?.audioOutputRoute || '',
  );
  const stored = getPersistedCallAudioRoute();
  const lastApplied = readLastAppliedCallAudioRoute();
  const route =
    (lastApplied && isExternalHeadsetRoute(lastApplied) ? lastApplied : null) ||
    fromParams ||
    stored ||
    'EARPIECE';
  if (isExternalHeadsetRoute(route)) return;

  const available = readAvailableAudioDeviceList();
  if (available.includes('BLUETOOTH')) {
    setPersistedCallAudioRoute('BLUETOOTH');
    try {
      const params = (global as any).__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = 'BLUETOOTH';
      }
    } catch {}
    return;
  }
  if (available.includes('WIRED_HEADSET')) {
    setPersistedCallAudioRoute('WIRED_HEADSET');
    try {
      const params = (global as any).__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = 'WIRED_HEADSET';
      }
    } catch {}
    return;
  }

  if (!shouldApplyHomeLoudSpeakerPin()) {
    const keep = readPreferredCallAudioRouteForTransition();
    setPersistedCallAudioRoute(keep);
    try {
      const params = (global as any).__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = keep;
      }
      (global as any).__lastAppliedCallAudioRouteRef = { current: keep };
    } catch {}
    return;
  }

  setPersistedCallAudioRoute('SPEAKER_PHONE');
  try {
    const g = global as any;
    g.__audioCallHomeSpeakerPinRef = g.__audioCallHomeSpeakerPinRef || { current: false };
    g.__audioCallHomeSpeakerPinRef.current = true;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = 'SPEAKER_PHONE';
    }
  } catch {}
}

/** После возврата с Home: снова разговорный на экране «Аудиозвонок». */
export function restoreAudioCallEarpieceAfterHomeReturn(): void {
  try {
    const g = global as any;
    if (g.__audioCallHomeSpeakerPinRef?.current !== true) return;
    g.__audioCallHomeSpeakerPinRef.current = false;
    if (!isAudioOnlyOngoingCallContext()) return;
    const snapRoute = normalizeInCallRoute(peekSystemPiPReturnMediaSnapshot()?.audioRoute || '');
    if (snapRoute && isExternalHeadsetRoute(snapRoute)) {
      setPersistedCallAudioRoute(snapRoute);
      const params = g.__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = snapRoute;
      }
      return;
    }
    const persisted = getPersistedCallAudioRoute();
    if (persisted && isExternalHeadsetRoute(persisted)) return;
    const lastApplied = readLastAppliedCallAudioRoute();
    if (lastApplied && isExternalHeadsetRoute(lastApplied)) {
      setPersistedCallAudioRoute(lastApplied);
      const params = g.__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = lastApplied;
      }
      return;
    }
    setPersistedCallAudioRoute('EARPIECE');
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = 'EARPIECE';
    }
  } catch {}
}

/** Video PiP / полный video UI: ear-hearing → громкий; BT/провод и явный выбор пользователя — без авто-BT. */
export function resolveVideoInAppPiPAudioRoute(
  preferred?: InCallAudioRoute | string | null,
  opts?: { mapForEnterVideoUi?: boolean },
): InCallAudioRoute {
  const mapForVideo = opts?.mapForEnterVideoUi !== false;
  const userSel = readUserSelectedCallAudioRoute();
  let route: InCallAudioRoute =
    userSel ||
    normalizeInCallRoute(preferred || '') ||
    readInAppPiPAudioOutputRoute();
  if (mapForVideo) {
    route = mapRouteForEnterVideoUi(route);
  }
  if (isExternalHeadsetRoute(route)) {
    return route;
  }
  return route || 'SPEAKER_PHONE';
}

/** Громкий с video in-app PiP (явный выбор) — не отбирать BT на full video. */
export function readExplicitVideoCallBuiltInRoute(): InCallAudioRoute | null {
  const plaque = normalizeInCallRoute(readInAppPiPAudioOutputRoute() || '');
  const userSel = readUserSelectedCallAudioRoute();
  const persisted = normalizeInCallRoute(getPersistedCallAudioRoute() || '');
  if (
    userSel === 'BLUETOOTH' ||
    userSel === 'WIRED_HEADSET' ||
    plaque === 'BLUETOOTH' ||
    plaque === 'WIRED_HEADSET' ||
    persisted === 'BLUETOOTH' ||
    persisted === 'WIRED_HEADSET'
  ) {
    return null;
  }
  const uiLock = readCallAudioRouteUiLock();
  if (uiLock === 'SPEAKER_PHONE') return 'SPEAKER_PHONE';
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked === 'SPEAKER_PHONE') return 'SPEAKER_PHONE';
  let explicitPiP: InCallAudioRoute | null = null;
  try {
    explicitPiP = normalizeInCallRoute(
      (global as any).__inAppPiPExplicitToggleRouteRef?.current || '',
    );
  } catch {}
  const speakerMarked =
    plaque === 'SPEAKER_PHONE' ||
    userSel === 'SPEAKER_PHONE' ||
    persisted === 'SPEAKER_PHONE' ||
    explicitPiP === 'SPEAKER_PHONE';
  if (!speakerMarked) return null;
  const pinned =
    userExplicitlyPinnedBuiltinCallAudio() ||
    isInAppPiPExplicitBuiltinRouteChoiceActive() ||
    isPiPBuiltinCallAudioRouteLockActive();
  if (pinned || speakerMarked) return 'SPEAKER_PHONE';
  return null;
}

/** Полный video UI: гарнитура/BT как в плашке; встроенное ухо → громкая. */
export function resolveFullVideoCallScreenAudioRoute(): InCallAudioRoute {
  const userSel = readUserSelectedCallAudioRoute();
  if (isExternalHeadsetRoute(userSel)) {
    return userSel;
  }
  const plaqueRaw =
    readInAppPiPAudioOutputRoute() || getPersistedCallAudioRoute() || readLastAppliedCallAudioRoute();
  const plaque = normalizeInCallRoute(plaqueRaw || '');
  if (isExternalHeadsetRoute(plaque)) {
    return plaque;
  }
  const explicitSpeaker = readExplicitVideoCallBuiltInRoute();
  if (explicitSpeaker === 'SPEAKER_PHONE') return 'SPEAKER_PHONE';
  const ext =
    readUserSelectedExternalCallAudioRoute() ||
    readActiveExternalCallAudioRoute(readInAppPiPAudioOutputRoute());
  if (isExternalHeadsetRoute(ext)) {
    return ext;
  }
  return 'SPEAKER_PHONE';
}

/** Video UI → in-app PiP: BT/провод если активны, иначе громкая (не ухо). */
export function resolveVideoInAppPiPPreserveRoute(): InCallAudioRoute {
  const explicitSpeaker = readExplicitVideoCallBuiltInRoute();
  if (explicitSpeaker === 'SPEAKER_PHONE') return 'SPEAKER_PHONE';
  const plaqueBuiltin = normalizeInCallRoute(
    readInAppPiPAudioOutputRoute() || getPersistedCallAudioRoute() || '',
  );
  if (plaqueBuiltin === 'SPEAKER_PHONE') return 'SPEAKER_PHONE';
  const ext = readPersistedOrUserExternalRoute();
  if (isExternalHeadsetRoute(ext)) {
    const coerced = coercePersistedRouteForAvailableDevices(ext);
    if (isExternalHeadsetRoute(coerced)) return coerced;
  }
  const plaque =
    readInAppPiPAudioOutputRoute() ||
    normalizeInCallRoute(getPersistedCallAudioRoute() || '') ||
    readLastAppliedCallAudioRoute();
  if (isExternalHeadsetRoute(plaque)) {
    const coerced = coercePersistedRouteForAvailableDevices(plaque);
    if (isExternalHeadsetRoute(coerced)) return coerced;
  }
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked === 'SPEAKER_PHONE') return 'SPEAKER_PHONE';
  return 'SPEAKER_PHONE';
}

/** Полный video UI: earpiece→speaker; in-app PiP с видео: сохранить выбор (в т.ч. earpiece). */
export function resolveOngoingVideoCallAudioRoute(): InCallAudioRoute {
  const inAppPiP = shouldPreserveCallAudioRouteInInAppPiP();
  const fromAudioPiP = (() => {
    try {
      return (global as any).__pipInAppRtcFromAudioOnlyRef?.current === true;
    } catch {
      return false;
    }
  })();
  const audioOnlyUi = isInAudioOnlyCallUi();
  if (ongoingCallPrefersVideoMedia() || !fromAudioPiP) {
    if (!inAppPiP && !audioOnlyUi) {
      return resolveFullVideoCallScreenAudioRoute();
    }
  }
  if (fromAudioPiP && (inAppPiP || audioOnlyUi) && !ongoingCallPrefersVideoMedia()) {
    return (
      normalizeInCallRoute(readInAppPiPAudioOutputRoute()) ||
      getPersistedCallAudioRoute() ||
      'EARPIECE'
    );
  }
  if (!inAppPiP && !audioOnlyUi) {
    return resolveFullVideoCallScreenAudioRoute();
  }
  return resolveVideoInAppPiPPreserveRoute();
}

async function applyVideoContextNativeRoute(
  reason: string,
  route: InCallAudioRoute,
  media: 'audio' | 'video',
  skipInCallRestart: boolean,
): Promise<void> {
  setPersistedCallAudioRoute(route);
  try {
    const g = global as any;
    g.__lastAppliedCallAudioRouteRef = { current: route };
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    g.__onInAppPiPAudioRouteChanged?.(route);
    g.__applyCallAudioRouteFromParentRef?.current?.(route, reason);
  } catch {}
  const signature = `${route}|${media}|${reason}`;
  const now = Date.now();
  lastReapplySignature = signature;
  lastReapplyAt = now;
  await runInCallRestartIfNeeded(media, skipInCallRestart, reason);
  await applyNativeOutputRoute(route, media, {
    forceBuiltIn: !isExternalHeadsetRoute(route),
  });
  lastNativeInCallSignature = signature;
  logger.info('[callAudioRoutePersist] reapply', {
    reason,
    route,
    media,
    skipInCallRestart,
    honorUser: true,
  });
}

function writeVideoCallPiPRouteToParams(route: InCallAudioRoute): void {
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
      params.preferVideoCallUi = true;
      params.inAudioOnlyUi = false;
    }
  } catch {}
}

/** Video in-app PiP: сохранить маршрут (в т.ч. Bluetooth) в persist и params. */
export function persistVideoInAppPiPAudioRoute(
  preferred?: InCallAudioRoute | string | null,
  opts?: { mapForEnterVideoUi?: boolean },
): void {
  if (isInAudioOnlyCallUi()) return;
  markDirectCallVideoMediaActive();
  const route = resolveVideoInAppPiPAudioRoute(preferred, opts);
  if (isExternalHeadsetRoute(route)) {
    const hint =
      readLastAppliedCallAudioRoute() ||
      getPersistedCallAudioRoute() ||
      normalizeInCallRoute(preferred || '');
    rememberBuiltinCallRouteBeforeHeadset(hint, false);
  }
  setPersistedCallAudioRoute(route);
  writeVideoCallPiPRouteToParams(route);
}

/** Video UI / PiP с видео: громкая связь в persist и PiP params (не audio-only). */
export function pinVideoCallLoudSpeakerRoute(): void {
  if (isInAudioOnlyCallUi()) return;
  persistVideoInAppPiPAudioRoute('SPEAKER_PHONE');
}

let reapplyChain = Promise.resolve();
type ScheduledReapplyTimer = { timer: ReturnType<typeof setTimeout>; reason: string };
let scheduledReapplyTimers: ScheduledReapplyTimer[] = [];
let lastReapplySignature = '';
let lastReapplyAt = 0;
let lastReapplyRouteMediaKey = '';
let lastReapplyReasonKey = '';
let lastNativeInCallSignature = '';
const REAPPLY_DEDUP_MS = 900;

function isManualCycleReapplyReason(reason: string): boolean {
  return (
    reason === 'in_app_pip_audio_route_toggle' ||
    reason === 'audio_ui_route_cycle' ||
    reason === 'in_app_pip_from_audio' ||
    reason === 'in_app_pip_from_video'
  );
}

function shouldSkipDuplicateReapply(
  route: InCallAudioRoute,
  media: 'audio' | 'video',
  reason: string,
  now: number,
): boolean {
  if (isManualCycleReapplyReason(reason)) return false;
  if (now - lastReapplyAt >= REAPPLY_DEDUP_MS) return false;
  const routeMedia = `${route}|${media}`;
  const reasonKey = `${routeMedia}|${reason}`;
  if (reasonKey === lastReapplyReasonKey) return true;
  if (routeMedia === lastReapplyRouteMediaKey) return true;
  return false;
}

function rememberReapplyDedup(route: InCallAudioRoute, media: 'audio' | 'video', reason: string): void {
  const honorTag = 'honor';
  lastReapplySignature = `${route}|${media}|${honorTag}`;
  lastReapplyRouteMediaKey = `${route}|${media}`;
  lastReapplyReasonKey = `${lastReapplyRouteMediaKey}|${reason}`;
  lastReapplyAt = Date.now();
}

/** Локальный audio UI — не тянуть direct_call_video_ui / video speaker pin. */
function shouldSkipDirectCallVideoUiReapply(): boolean {
  try {
    if ((global as any).__inAudioOnlyUiRef?.current === true) return true;
  } catch {}
  return isInAudioOnlyCallUi();
}

function readPersistedOrUserExternalRoute(): InCallAudioRoute | null {
  const userExt = readUserSelectedExternalCallAudioRoute();
  if (isExternalHeadsetRoute(userExt)) return userExt;
  const userSel = readUserSelectedCallAudioRoute();
  if (isExternalHeadsetRoute(userSel)) return userSel;
  const persisted = normalizeInCallRoute(getPersistedCallAudioRoute() || '');
  if (isExternalHeadsetRoute(persisted)) return persisted;
  const probed = readNativeProbedExternalRoute();
  if (isExternalHeadsetRoute(probed)) return probed;
  return null;
}

export function userExplicitlyChoseLoudSpeakerForCall(): boolean {
  if (!userExplicitlyPinnedBuiltinCallAudio()) return false;
  const userSel = normalizeInCallRoute(readUserSelectedCallAudioRoute() || '');
  if (userSel === 'SPEAKER_PHONE') return true;
  try {
    const g = global as any;
    const cycled = normalizeInCallRoute(g.__lastCycleUserRouteResultRef?.current || '');
    return cycled === 'SPEAKER_PHONE';
  } catch {
    return false;
  }
}

export function resolveReapplyMediaInCallContext(fallback?: 'audio' | 'video'): 'audio' | 'video' {
  if (isInAudioOnlyCallUi()) return 'audio';
  try {
    const g = global as any;
    if (g.__inAudioOnlyUiRef?.current === true) return 'audio';
    if (
      g.__pipAudioOnlyPlaceholderRef?.current === true &&
      g.__stayOnVideoCallUiRef?.current !== true
    ) {
      return 'audio';
    }
  } catch {}
  return fallback ?? resolveActiveCallInCallMedia();
}

function coerceAudioOnlySystemPiPExitRoute(route: InCallAudioRoute): InCallAudioRoute {
  const ext = readPersistedOrUserExternalRoute();
  if (isExternalHeadsetRoute(ext)) {
    return coercePersistedRouteForAvailableDevices(ext);
  }
  if (route === 'SPEAKER_PHONE' && !userExplicitlyChoseLoudSpeakerForCall()) {
    return coercePersistedRouteForAvailableDevices('EARPIECE');
  }
  return route;
}

/** Снять video SPEAKER ui_lock при переходе на audio UI (если пользователь не выбирал громкую). */
export function clearStaleVideoSpeakerUiLockForAudioOnlyUi(): void {
  const lock = readCallAudioRouteUiLock();
  if (
    lock === 'SPEAKER_PHONE' &&
    !readUserLockedBuiltinCallAudioRoute() &&
    !userExplicitlyChoseLoudSpeakerForCall()
  ) {
    clearCallAudioRouteUiLock();
  }
}

/** Отменить отложенные reapply с video-политикой, когда локально audio UI. */
export function cancelDeferredVideoMediaAudioReappliesForLocalAudioUi(): void {
  cancelScheduledCallAudioRouteReappliesMatching([
    'system_pip_return_media',
    'system_pip_exit_preserve_route',
    'direct_call_video_ui_route',
    'video_call_return_from_pip',
  ]);
}

export function armLocalAudioOnlyUiAudioRoutingQuiet(ms = 600): void {
  armCallAudioPreferAudioModeQuiet(ms);
  armCallAudioPreservePriority(ms);
}

/** BT/провод с native probe; иначе locked builtin или fallback (без форса EARPIECE поверх гарнитуры). */
async function resolveHeadsetFirstReapplyRoute(
  fallback: InCallAudioRoute,
): Promise<InCallAudioRoute> {
  if (Platform.OS === 'android') {
    try {
      const probe = await probeNativeCallAudioRoutes();
      mergeNativeProbeIntoGlobal(probe);
    } catch {}
  }
  const ext =
    readUserSelectedExternalCallAudioRoute() ||
    readNativeProbedExternalRoute() ||
    readConnectedExternalCallAudioRoute(fallback) ||
    readActiveExternalCallAudioRoute(fallback);
  if (isExternalHeadsetRoute(ext)) return ext;
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked && userExplicitlyPinnedBuiltinCallAudio()) return locked;
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE') return userSel;
  const persisted = getPersistedCallAudioRoute();
  if (persisted === 'SPEAKER_PHONE') return 'SPEAKER_PHONE';
  return fallback;
}

function isHonorUserRouteReason(reason: string): boolean {
  if (
    reason === 'audio_ui_route_cycle' ||
    reason === 'in_app_pip_audio_route_toggle' ||
    reason === 'return_to_audio_ui' ||
    reason === 'direct_call_accept_audio_route' ||
    reason === 'preserve_in_app_pip_headset' ||
    reason === 'direct_call_video_ui_route' ||
    reason === 'system_pip_enter_preserve_headset' ||
    reason === 'system_pip_enter_loud_speaker' ||
    reason === 'system_pip_enter_preserve_builtin' ||
    reason === 'system_pip_exit_preserve_route' ||
    reason === 'system_pip_return_media' ||
    reason === 'in_app_pip_from_audio' ||
    reason === 'in_app_pip_from_video' ||
    reason === 'preserve_in_app_pip_headset' ||
    reason === 'audio_ui_headset_connect' ||
    reason === 'in_app_pip_headset_connect'
  ) {
    return true;
  }
  if (reason === 'audio_home_preserve_route') {
    if (readUserLockedBuiltinCallAudioRoute()) return true;
    const userSel = readUserSelectedCallAudioRoute();
    if (userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE') return true;
  }
  if (reason === 'preserve_in_app_pip_headset') {
    const userSel = readUserSelectedCallAudioRoute();
    if (userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE') return true;
    const persisted = getPersistedCallAudioRoute();
    if (persisted === 'SPEAKER_PHONE' || persisted === 'EARPIECE') return true;
  }
  return false;
}

const NATIVE_OUTPUT_COALESCE_MS = 56;
const PROBE_MISMATCH_RETRY_MS = 450;

type PendingNativeOutput = {
  route: InCallAudioRoute;
  media: 'audio' | 'video';
  forceBuiltIn: boolean;
};

let nativeOutputCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingNativeOutput: PendingNativeOutput | null = null;
let nativeOutputCoalesceResolvers: Array<() => void> = [];
let lastMaintainVoiceAudioAt = 0;

function nativeOutputSignature(route: InCallAudioRoute, media: 'audio' | 'video', forceBuiltIn: boolean): string {
  return `${route}|${media}|${forceBuiltIn ? '1' : '0'}`;
}

function maybeMaintainActiveCallVoiceAudioOnce(): void {
  if (Platform.OS !== 'android' || !isOngoingCallSession()) return;
  const now = Date.now();
  if (now - lastMaintainVoiceAudioAt < 400) return;
  lastMaintainVoiceAudioAt = now;
  try {
    NativeModules.LiviAppModule?.maintainActiveCallVoiceAudio?.();
  } catch {}
}

function isHeavyInCallRestartBlockedForReason(reason: string): boolean {
  if (Platform.OS !== 'android' || !isCallAudioNativeTransitionLocked()) return false;
  if (
    reason.includes('bootstrap') ||
    reason.includes('accept') ||
    reason.includes('headset_connect') ||
    reason === 'audio_ui_route_cycle' ||
    reason === 'in_app_pip_audio_route_toggle' ||
    reason === 'audio_home_preserve_route_deferred'
  ) {
    return false;
  }
  return true;
}

async function applyNativeOutputRouteImmediate(
  route: InCallAudioRoute,
  media: 'audio' | 'video',
  opts: { forceBuiltIn?: boolean },
): Promise<void> {
  const forceBuiltIn = !!opts.forceBuiltIn;
  if (route === 'EARPIECE') {
    const lock = readCallAudioRouteUiLock();
    const userSel = readUserSelectedCallAudioRoute();
    if (lock === 'SPEAKER_PHONE' || userSel === 'SPEAKER_PHONE') {
      return;
    }
  }
  if (isExternalHeadsetRoute(route)) {
    try {
      (InCallManager as any).setForceSpeakerphoneOn?.(false);
      InCallManager.setSpeakerphoneOn(false);
      await (InCallManager as any).chooseAudioRoute?.(route);
      await applyNativeVoiceCallRoute(route);
    } catch {}
    return;
  }
  if (route === 'SPEAKER_PHONE') {
    const lock = readCallAudioRouteUiLock();
    const userSel = readUserSelectedCallAudioRoute();
    if (lock === 'EARPIECE' && userSel !== 'SPEAKER_PHONE') {
      return;
    }
    try {
      (InCallManager as any).setForceSpeakerphoneOn?.(true);
      InCallManager.setSpeakerphoneOn(true);
      void (InCallManager as any).chooseAudioRoute?.('SPEAKER_PHONE');
    } catch {}
    await applyNativeVoiceCallSpeaker(true, { forceBuiltIn });
    return;
  }
  if (route === 'EARPIECE') {
    try {
      (InCallManager as any).setForceSpeakerphoneOn?.(false);
      InCallManager.setSpeakerphoneOn(false);
      void (InCallManager as any).chooseAudioRoute?.('EARPIECE');
    } catch {}
    await applyNativeVoiceCallSpeaker(false, { forceBuiltIn });
  }
}

function flushCoalescedNativeOutput(): void {
  nativeOutputCoalesceTimer = null;
  const job = pendingNativeOutput;
  const resolvers = nativeOutputCoalesceResolvers;
  pendingNativeOutput = null;
  nativeOutputCoalesceResolvers = [];
  if (!job) {
    resolvers.forEach((r) => r());
    return;
  }
  const sig = nativeOutputSignature(job.route, job.media, job.forceBuiltIn);
  if (sig === lastNativeInCallSignature) {
    resolvers.forEach((r) => r());
    return;
  }
  void applyNativeOutputRouteImmediate(job.route, job.media, { forceBuiltIn: job.forceBuiltIn })
    .then(() => {
      lastNativeInCallSignature = sig;
      maybeMaintainActiveCallVoiceAudioOnce();
    })
    .catch(() => {})
    .finally(() => {
      resolvers.forEach((r) => r());
    });
}

async function applyNativeOutputRoute(
  route: InCallAudioRoute,
  media: 'audio' | 'video',
  opts: { forceBuiltIn?: boolean; skipCoalesce?: boolean },
): Promise<void> {
  const forceBuiltIn = !!opts.forceBuiltIn;
  if (opts.skipCoalesce) {
    const sig = nativeOutputSignature(route, media, forceBuiltIn);
    if (sig === lastNativeInCallSignature) return;
    await applyNativeOutputRouteImmediate(route, media, { forceBuiltIn });
    lastNativeInCallSignature = sig;
    maybeMaintainActiveCallVoiceAudioOnce();
    return;
  }
  pendingNativeOutput = { route, media, forceBuiltIn };
  return new Promise<void>((resolve) => {
    nativeOutputCoalesceResolvers.push(resolve);
    if (nativeOutputCoalesceTimer) {
      clearTimeout(nativeOutputCoalesceTimer);
    }
    nativeOutputCoalesceTimer = setTimeout(flushCoalescedNativeOutput, NATIVE_OUTPUT_COALESCE_MS);
  });
}

async function runInCallRestartIfNeeded(
  media: 'audio' | 'video',
  skipInCallRestart: boolean,
  reason: string,
): Promise<boolean> {
  let skip = skipInCallRestart;
  if (!skip && isHeavyInCallRestartBlockedForReason(reason)) {
    skip = true;
  }
  if (skip) return false;
  try {
    if (Platform.OS === 'android') beginBackgroundMediaSuppression();
    InCallManager.start({ media, ringback: '' });
    markInCallAudioSessionStarted(true);
    try {
      (InCallManager as any).requestAudioFocus?.();
    } catch {}
  } catch {}
  return true;
}

const PIP_BURST_REAPPLY_RE =
  /^in_app_pip_from_|^in_app_pip_preserve_|^preserve_in_app_pip_|^video_call_return_from_pip$|^return_to_audio_ui$/;

function isPipBurstReapplyReason(reason: string): boolean {
  return PIP_BURST_REAPPLY_RE.test(reason);
}

function isProbeMismatchFollowUpReason(reason: string): boolean {
  if (reason.endsWith('_probe_retry')) return false;
  if (reason === 'in_app_pip_audio_route_toggle' || reason === 'audio_ui_route_cycle') return false;
  return (
    isPipBurstReapplyReason(reason) ||
    reason.startsWith('system_pip_') ||
    reason === 'direct_call_accept_audio_route' ||
    reason === 'preserve_in_app_pip_headset' ||
    reason === 'direct_call_video_ui_route'
  );
}

async function nativeOutputDiffersFromTarget(target: InCallAudioRoute): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const probe = await probeNativeCallAudioRoutes();
    mergeNativeProbeIntoGlobal(probe);
    const preferred = probe.preferred;
    if (isExternalHeadsetRoute(target)) {
      if (target === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall()) return false;
      if (preferred === target) return false;
      if (probe.available.includes(target)) {
        if (target === 'BLUETOOTH' && isBluetoothHeadsetActiveForCall()) {
          return false;
        }
        return preferred != null && preferred !== target;
      }
      return true;
    }
    if (target === 'SPEAKER_PHONE') {
      return preferred !== 'SPEAKER_PHONE' && preferred !== null;
    }
    if (target === 'EARPIECE') {
      return preferred === 'SPEAKER_PHONE';
    }
  } catch {}
  return false;
}

function scheduleProbeMismatchRetryIfNeeded(
  reason: string,
  route: InCallAudioRoute,
  opts?: { media?: 'audio' | 'video'; honorUserRoute?: boolean; skipInCallRestart?: boolean },
): void {
  if (!isProbeMismatchFollowUpReason(reason)) return;
  if (reason.includes('headset') && reason !== 'preserve_in_app_pip_headset') return;
  void nativeOutputDiffersFromTarget(route).then((mismatch) => {
    if (!mismatch) return;
    scheduleReapplyPersistedCallAudioRoute(`${reason}_probe_retry`, {
      media: opts?.media,
      honorUserRoute: opts?.honorUserRoute,
      skipInCallRestart: opts?.skipInCallRestart ?? true,
      delaysMs: [PROBE_MISMATCH_RETRY_MS],
    });
  });
}

/** Один reapply на переход in-app PiP (enter): UI уже обновлён в showPiP. */
export function scheduleInAppPiPAudioTransitionReapply(
  kind: 'from_audio' | 'from_video',
  opts?: {
    media?: 'audio' | 'video';
    honorUserRoute?: boolean;
    skipInCallRestart?: boolean;
  },
): void {
  if (Platform.OS === 'android') {
    armCallAudioNativeTransitionLock();
  }
  armCallAudioPreservePriority(4000);
  cancelScheduledCallAudioRouteReappliesMatching([
    'in_app_pip_from_',
    'in_app_pip_preserve_external',
    'preserve_in_app_pip_headset',
    'direct_call_accept_audio_route',
    'direct_call_video_ui_route',
  ]);
  const reason = kind === 'from_audio' ? 'in_app_pip_from_audio' : 'in_app_pip_from_video';
  scheduleReapplyPersistedCallAudioRoute(reason, {
    media: opts?.media,
    honorUserRoute: opts?.honorUserRoute,
    skipInCallRestart: opts?.skipInCallRestart ?? true,
    delaysMs: [0],
  });
}

/** Resume native routing после PiP return / focus VideoCall без второго bootstrap. */
export function scheduleVideoCallReturnFromPiPAudioReapply(opts?: {
  media?: 'audio' | 'video';
  honorUserRoute?: boolean;
  skipInCallRestart?: boolean;
}): void {
  if (
    isDirectCallVideoExpandGuardActive() ||
    isDirectCallVideoExpandAudioPreparedRecently()
  ) {
    logger.debug('[callAudioRoutePersist] skip video_call_return (video expand prepared)', {});
    return;
  }
  if (Platform.OS === 'android') {
    armCallAudioNativeTransitionLock();
  }
  armCallAudioPreservePriority(4000);
  cancelScheduledCallAudioRouteReappliesMatching([
    'video_call_return_from_pip',
    'preserve_in_app_pip_headset',
    'in_app_pip_from_',
  ]);
  scheduleReapplyPersistedCallAudioRoute('video_call_return_from_pip', {
    media: opts?.media ?? 'video',
    honorUserRoute: opts?.honorUserRoute ?? true,
    skipInCallRestart: opts?.skipInCallRestart ?? true,
    delaysMs: [0],
  });
}

/** Синхронно с PiP toggle / явным выбором — не ждать reapply chain. */
export async function applyCallAudioOutputRouteNow(
  route: InCallAudioRoute,
  opts?: { media?: 'audio' | 'video'; forceBuiltIn?: boolean },
): Promise<void> {
  const media = opts?.media ?? resolveActiveCallInCallMedia();
  await applyNativeOutputRoute(route, media, {
    forceBuiltIn: opts?.forceBuiltIn ?? true,
    skipCoalesce: true,
  });
  try {
    const g = global as any;
    g.__lastAppliedCallAudioRouteRef = { current: route };
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
  } catch {}
}

/** Отменить отложенные preserve/return — перед ручным переключением на аудио-экране. */
export function clearScheduledCallAudioRouteReapplies(): void {
  clearScheduledReapplies();
}

/** Отменить отложенные reapply с указанными reason (например return_to_audio_ui после BT). */
export function cancelScheduledCallAudioRouteReappliesMatching(reasonPrefixes: string[]): void {
  if (!reasonPrefixes.length) return;
  const kept: ScheduledReapplyTimer[] = [];
  for (const entry of scheduledReapplyTimers) {
    const cancel = reasonPrefixes.some(
      (p) => entry.reason === p || entry.reason.startsWith(p),
    );
    if (cancel) {
      try {
        clearTimeout(entry.timer);
      } catch {}
    } else {
      kept.push(entry);
    }
  }
  scheduledReapplyTimers = kept;
}

function clearScheduledReapplies(opts?: { preserveReasonPrefixes?: string[] }): void {
  const prefixes = opts?.preserveReasonPrefixes ?? [];
  if (!prefixes.length) {
    for (const entry of scheduledReapplyTimers) {
      try {
        clearTimeout(entry.timer);
      } catch {}
    }
    scheduledReapplyTimers = [];
    return;
  }
  const kept: ScheduledReapplyTimer[] = [];
  for (const entry of scheduledReapplyTimers) {
    const preserve = prefixes.some((p) => entry.reason.startsWith(p));
    if (preserve) {
      kept.push(entry);
    } else {
      try {
        clearTimeout(entry.timer);
      } catch {}
    }
  }
  scheduledReapplyTimers = kept;
}

function pinBuiltinRouteForPiPContext(route: InCallAudioRoute): void {
  setPersistedCallAudioRoute(route);
  if (route === 'SPEAKER_PHONE' || route === 'EARPIECE') {
    setUserSelectedCallAudioRoute(route);
    rememberManualBuiltinCallAudioRoute(route);
    try {
      const g = global as any;
      g.__explicitBuiltInCallAudioRouteRef =
        g.__explicitBuiltInCallAudioRouteRef || { current: false };
      g.__explicitBuiltInCallAudioRouteRef.current = true;
    } catch {}
  } else if (isExternalHeadsetRoute(route)) {
    setUserSelectedCallAudioRoute(route);
  }
  try {
    const g = global as any;
    g.__lastAppliedCallAudioRouteRef = { current: route };
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    g.__onInAppPiPAudioRouteChanged?.(route);
  } catch {}
}

function resolvePiPPlaqueReapplyRoute(fallback: InCallAudioRoute = 'EARPIECE'): InCallAudioRoute {
  try {
    const g = global as any;
    if (isInAudioOnlyCallUi() && g.__pipVisibleRef?.current !== true) {
      const lock = readCallAudioRouteUiLock();
      if (
        lock === 'SPEAKER_PHONE' ||
        lock === 'EARPIECE' ||
        isExternalHeadsetRoute(lock)
      ) {
        return coercePersistedRouteForAvailableDevices(lock);
      }
      const onFullAudioUi =
        readLastAppliedCallAudioRoute() ||
        normalizeInCallRoute(g.__inCallSelectedAudioRouteRef?.current || '') ||
        readUserSelectedCallAudioRoute() ||
        getPersistedCallAudioRoute() ||
        normalizeInCallRoute(g.__audioUiExplicitCycleRouteRef?.current || '');
      if (
        onFullAudioUi === 'SPEAKER_PHONE' ||
        onFullAudioUi === 'EARPIECE' ||
        isExternalHeadsetRoute(onFullAudioUi)
      ) {
        return coercePersistedRouteForAvailableDevices(onFullAudioUi);
      }
    }
    if (Number(g.__pipBuiltinRouteLockUntilRef?.current || 0) > Date.now()) {
      const explicit = normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || '');
      if (
        explicit === 'SPEAKER_PHONE' ||
        explicit === 'EARPIECE' ||
        isExternalHeadsetRoute(explicit)
      ) {
        return coercePersistedRouteForAvailableDevices(explicit);
      }
    }
  } catch {}
  const authoritative = readAuthoritativeCallAudioRouteAfterPiP();
  if (authoritative) {
    return coercePersistedRouteForAvailableDevices(authoritative);
  }
  const ext =
    readUserSelectedExternalCallAudioRoute() ||
    readActiveExternalCallAudioRoute(readInAppPiPAudioOutputRoute());
  if (isExternalHeadsetRoute(ext)) {
    return coercePersistedRouteForAvailableDevices(ext);
  }
  const merged =
    readUserSelectedCallAudioRoute() ||
    getPersistedCallAudioRoute() ||
    readInAppPiPAudioOutputRoute() ||
    fallback;
  return coercePersistedRouteForAvailableDevices(merged || fallback);
}

/** Reapply из плашки: на полном video UI встроенный earpiece → громкая. */
function resolvePlaqueReapplyRespectingActiveCallUi(
  fallback: InCallAudioRoute = 'EARPIECE',
): InCallAudioRoute {
  let route = resolvePiPPlaqueReapplyRoute(fallback);
  try {
    const g = global as any;
    const fromAudioPiP = g.__pipInAppRtcFromAudioOnlyRef?.current === true;
    const audioOnlyPlaque =
      isInAudioOnlyCallUi() &&
      (fromAudioPiP || g.__preferAudioOnlyUiOnNextVideoCallRef?.current === true);
    if (!audioOnlyPlaque && ongoingCallPrefersVideoMedia() && !isExternalHeadsetRoute(route)) {
      route = mapRouteForEnterVideoUi(route);
    }
  } catch {}
  return route;
}

/** Ухо/громкая с плашки или audio UI — не подменять на BT через resolveHeadsetFirstReapplyRoute. */
function resolveExplicitPiPOrAudioUiBuiltinRoute(
  fallback: InCallAudioRoute = 'EARPIECE',
): InCallAudioRoute {
  const uiLock = readCallAudioRouteUiLock();
  if (uiLock === 'EARPIECE' || uiLock === 'SPEAKER_PHONE') {
    return coercePersistedRouteForAvailableDevices(uiLock);
  }
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked === 'EARPIECE' || locked === 'SPEAKER_PHONE') {
    return coercePersistedRouteForAvailableDevices(locked);
  }
  const userSel = readUserSelectedCallAudioRoute();
  if (isExternalHeadsetRoute(userSel)) {
    return coercePersistedRouteForAvailableDevices(userSel);
  }
  if (
    (userSel === 'EARPIECE' || userSel === 'SPEAKER_PHONE') &&
    (userExplicitlyPinnedBuiltinCallAudio() || isInAppPiPExplicitBuiltinRouteChoiceActive())
  ) {
    return coercePersistedRouteForAvailableDevices(userSel);
  }
  const persistedExt = normalizeInCallRoute(getPersistedCallAudioRoute() || '');
  if (isExternalHeadsetRoute(persistedExt)) {
    return coercePersistedRouteForAvailableDevices(persistedExt);
  }
  try {
    const explicit = normalizeInCallRoute(
      (global as any).__inAppPiPExplicitToggleRouteRef?.current || '',
    );
    if (explicit === 'EARPIECE' || explicit === 'SPEAKER_PHONE') {
      return coercePersistedRouteForAvailableDevices(explicit);
    }
  } catch {}
  const plaque = resolvePlaqueReapplyRespectingActiveCallUi(fallback);
  if (isExternalHeadsetRoute(plaque)) {
    return coercePersistedRouteForAvailableDevices(plaque);
  }
  if (plaque === 'EARPIECE' || plaque === 'SPEAKER_PHONE') {
    return plaque;
  }
  return fallback;
}

/** Accept audio-first: earpiece по умолчанию; SPEAKER только при явном lock/cycle на текущем callId. */
export function resolveDirectCallAcceptAudioReapplyRoute(): InCallAudioRoute {
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked === 'EARPIECE') {
    return coercePersistedRouteForAvailableDevices(locked);
  }
  if (locked === 'SPEAKER_PHONE') {
    return coercePersistedRouteForAvailableDevices(
      coerceDirectAudioAcceptBuiltinRoute(locked),
    );
  }
  if (userExplicitlyPinnedBuiltinCallAudio()) {
    const pinned = normalizeInCallRoute(readUserSelectedCallAudioRoute() || '');
    if (pinned === 'EARPIECE' || pinned === 'SPEAKER_PHONE') {
      return coercePersistedRouteForAvailableDevices(pinned);
    }
  }
  const userExt = readUserSelectedExternalCallAudioRoute();
  if (isExternalHeadsetRoute(userExt)) {
    return coercePersistedRouteForAvailableDevices(userExt);
  }
  const nativeExt = readNativeProbedExternalRoute();
  if (nativeExt && isExternalHeadsetRoute(nativeExt)) {
    return coercePersistedRouteForAvailableDevices(nativeExt);
  }
  const connected = readConnectedExternalCallAudioRoute();
  if (connected && isExternalHeadsetRoute(connected)) {
    return coercePersistedRouteForAvailableDevices(connected);
  }
  return 'EARPIECE';
}

/** Audio UI: партнёр ушёл в video — не менять BT / ухо / громкий пользователя. */
export function resolveStayOnAudioUiRouteWhenPartnerEntersVideo(): InCallAudioRoute {
  const userExt = readUserSelectedExternalCallAudioRoute();
  if (isExternalHeadsetRoute(userExt)) {
    return coercePersistedRouteForAvailableDevices(userExt);
  }
  const userSel = normalizeInCallRoute(readUserSelectedCallAudioRoute() || '');
  if (isExternalHeadsetRoute(userSel)) {
    return coercePersistedRouteForAvailableDevices(userSel);
  }
  const uiLock = readCallAudioRouteUiLock();
  if (
    uiLock === 'EARPIECE' ||
    uiLock === 'SPEAKER_PHONE' ||
    isExternalHeadsetRoute(uiLock)
  ) {
    return coercePersistedRouteForAvailableDevices(uiLock);
  }
  const persisted = normalizeInCallRoute(getPersistedCallAudioRoute() || '');
  if (isExternalHeadsetRoute(persisted)) {
    return coercePersistedRouteForAvailableDevices(persisted);
  }
  if (persisted === 'EARPIECE' || persisted === 'SPEAKER_PHONE') {
    return persisted;
  }
  if (userSel === 'EARPIECE' || userSel === 'SPEAKER_PHONE') {
    return userSel;
  }
  const last = readLastAppliedCallAudioRoute();
  if (isExternalHeadsetRoute(last)) {
    return coercePersistedRouteForAvailableDevices(last);
  }
  if (last === 'EARPIECE' || last === 'SPEAKER_PHONE') {
    return last;
  }
  return resolveExplicitPiPOrAudioUiBuiltinRoute('EARPIECE');
}

/** System PiP из audio UI / audio-плашки: сохраняем ear или speaker пользователя, не подменяем на video-политику. */
function isSystemPiPFromAudioOnlyCallContext(): boolean {
  try {
    const snap = peekSystemPiPReturnMediaSnapshot();
    if (snap?.preferAudioOnlyUi) return true;
    if (isInAudioOnlyCallUi()) return true;
    const g = global as any;
    if (g.__preferAudioOnlyUiOnNextVideoCallRef?.current === true) return true;
    if (g.__pipInAppRtcFromAudioOnlyRef?.current === true) return true;
    if (g.__pipAudioOnlyPlaceholderRef?.current === true) return true;
  } catch {}
  return false;
}

function allowAutoLoudSpeakerOnSystemPiPEnter(): boolean {
  if (isSystemPiPFromAudioOnlyCallContext() || isInAudioOnlyCallUi()) return false;
  try {
    if ((global as any).__pipAudioOnlyPlaceholderRef?.current === true) return false;
  } catch {}
  return ongoingCallPrefersVideoMedia();
}

function readAuthoritativeAudioUiBuiltinRoute(): InCallAudioRoute | null {
  const lock = readCallAudioRouteUiLock();
  if (
    lock === 'EARPIECE' ||
    lock === 'SPEAKER_PHONE' ||
    isExternalHeadsetRoute(lock)
  ) {
    return coercePersistedRouteForAvailableDevices(lock);
  }
  try {
    const fromUi = normalizeInCallRoute(
      (global as any).__inCallSelectedAudioRouteRef?.current || '',
    );
    if (fromUi === 'EARPIECE' || fromUi === 'SPEAKER_PHONE') {
      return coercePersistedRouteForAvailableDevices(fromUi);
    }
  } catch {}
  const last = readLastAppliedCallAudioRoute();
  if (last === 'EARPIECE' || last === 'SPEAKER_PHONE') {
    return coercePersistedRouteForAvailableDevices(last);
  }
  return null;
}

function resolveSystemPiPAudioOnlyBuiltinRoute(): InCallAudioRoute {
  const ext =
    readUserSelectedExternalCallAudioRoute() ||
    readActiveExternalCallAudioRoute(readUserSelectedCallAudioRoute());
  if (isExternalHeadsetRoute(ext)) {
    return coercePersistedRouteForAvailableDevices(ext);
  }
  const authoritativeUi = readAuthoritativeAudioUiBuiltinRoute();
  if (authoritativeUi) {
    return authoritativeUi;
  }
  const snap = peekSystemPiPReturnMediaSnapshot();
  if (snap?.preferAudioOnlyUi) {
    const fromSnap = normalizeInCallRoute(snap.audioRoute || '');
    if (isExternalHeadsetRoute(fromSnap)) {
      return coercePersistedRouteForAvailableDevices(fromSnap);
    }
    if (fromSnap === 'SPEAKER_PHONE' || fromSnap === 'EARPIECE') {
      return coercePersistedRouteForAvailableDevices(fromSnap);
    }
  }
  return resolvePiPPlaqueReapplyRoute('EARPIECE');
}

/** Возврат из system PiP на полный video UI — громкая связь (кроме явного ear / BT). */
function resolveSystemPiPReturnToVideoBuiltinRoute(): InCallAudioRoute {
  try {
    const snap =
      peekSystemPiPReturnMediaSnapshot() ||
      ((global as any).__lastAppliedSystemPiPSnapRef as
        | SystemPiPReturnMediaSnapshot
        | undefined);
    const fromSnap = normalizeInCallRoute(snap?.audioRoute || '');
    if (isExternalHeadsetRoute(fromSnap)) {
      return coercePersistedRouteForAvailableDevices(fromSnap);
    }
    if (fromSnap === 'EARPIECE') {
      return coercePersistedRouteForAvailableDevices(
        mapRouteForEnterVideoUi('EARPIECE'),
      );
    }
  } catch {}
  const plaqueExplicit = readExplicitInAppPiPBuiltinRoute();
  if (plaqueExplicit === 'EARPIECE') {
    return coercePersistedRouteForAvailableDevices(
      mapRouteForEnterVideoUi('EARPIECE'),
    );
  }
  return coercePersistedRouteForAvailableDevices('SPEAKER_PHONE');
}

async function reapplySystemPiPExitOrReturnRoute(
  reason: string,
  opts?: { media?: 'audio' | 'video'; skipInCallRestart?: boolean },
): Promise<void> {
  const snap = peekSystemPiPReturnMediaSnapshot();
  const fromAudioCtx =
    snap?.preferAudioOnlyUi === true ||
    isSystemPiPFromAudioOnlyCallContext() ||
    isInAudioOnlyCallUi();
  const returningToVideo = !fromAudioCtx;
  let route: InCallAudioRoute;
  let media: 'audio' | 'video';
  if (returningToVideo) {
    route = resolveSystemPiPReturnToVideoBuiltinRoute();
    media = opts?.media ?? 'video';
    try {
      markDirectCallVideoMediaActive();
    } catch {}
  } else {
    route = coerceAudioOnlySystemPiPExitRoute(resolveSystemPiPAudioOnlyBuiltinRoute());
    media = 'audio';
    try {
      if (isExternalHeadsetRoute(route)) {
        clearCallAudioRouteUiLock();
      } else if (route === 'EARPIECE' || userExplicitlyChoseLoudSpeakerForCall()) {
        armCallAudioRouteUiLock(route, 8500);
      } else {
        clearStaleVideoSpeakerUiLockForAudioOnlyUi();
      }
    } catch {}
  }
  pinBuiltinRouteForPiPContext(route);
  const skip =
    opts?.skipInCallRestart ??
    (route !== 'SPEAKER_PHONE' || !returningToVideo);
  await applyVideoContextNativeRoute(reason, route, media, skip);
}

/** System PiP: audio-плашка — как выбрано; video-плашка — громкая, кроме явного earpiece в плашке. */
function resolveSystemPiPEnterPlaqueRoute(): InCallAudioRoute {
  if (isSystemPiPFromAudioOnlyCallContext()) {
    return resolveSystemPiPAudioOnlyBuiltinRoute();
  }
  const media = resolveActiveCallInCallMedia();
  const fromAudioPiP = (() => {
    try {
      return (global as any).__pipInAppRtcFromAudioOnlyRef?.current === true;
    } catch {
      return false;
    }
  })();
  if (media !== 'video' || fromAudioPiP || isInAudioOnlyCallUi()) {
    return resolvePiPPlaqueReapplyRoute('EARPIECE');
  }
  if (isPiPBuiltinCallAudioRouteLockActive()) {
    return resolvePiPPlaqueReapplyRoute('SPEAKER_PHONE');
  }
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === 'EARPIECE') {
    return coercePersistedRouteForAvailableDevices('EARPIECE');
  }
  if (userSel === 'SPEAKER_PHONE' || isExternalHeadsetRoute(userSel)) {
    return coercePersistedRouteForAvailableDevices(
      resolveVideoInAppPiPAudioRoute(userSel, { mapForEnterVideoUi: false }),
    );
  }
  const plaque = normalizeInCallRoute(
    (global as any).__currentCallPiPParamsRef?.current?.audioOutputRoute || '',
  );
  if (plaque === 'EARPIECE') {
    return coercePersistedRouteForAvailableDevices('EARPIECE');
  }
  const persisted = getPersistedCallAudioRoute();
  if (persisted === 'EARPIECE') {
    return coercePersistedRouteForAvailableDevices('EARPIECE');
  }
  return coercePersistedRouteForAvailableDevices(
    resolveVideoInAppPiPAudioRoute(
      plaque || persisted || readAuthoritativeCallAudioRouteAfterPiP() || 'SPEAKER_PHONE',
      { mapForEnterVideoUi: false },
    ),
  );
}

/** Синхронно до app_state_background: маршрут in-app PiP / громкая в system PiP. */
export function prepareSystemPiPEnterCallAudioRoute(): void {
  if (Platform.OS !== 'android' || !isOngoingCallSession()) return;
  try {
    const g = global as any;
    g.__lastSystemPiPAudioPrepareAtRef = g.__lastSystemPiPAudioPrepareAtRef || { current: 0 };
    const now = Date.now();
    if (now - Number(g.__lastSystemPiPAudioPrepareAtRef.current || 0) < 800) {
      return;
    }
    g.__lastSystemPiPAudioPrepareAtRef.current = now;
    armCallAudioPreservePriority(6000);
    const audioOnlyCtx = isSystemPiPFromAudioOnlyCallContext();
    const media = audioOnlyCtx ? 'audio' : resolveActiveCallInCallMedia();
    const resolved = resolveSystemPiPEnterPlaqueRoute();
    const external =
      readActiveExternalCallAudioRoute(resolved) ||
      (isExternalHeadsetRoute(resolved) ? resolved : null);
    if (external && isExternalHeadsetRoute(external)) {
      pinBuiltinRouteForPiPContext(external);
      void applyCallAudioOutputRouteNow(external, { media, forceBuiltIn: false });
      scheduleReapplyPersistedCallAudioRoute('system_pip_enter_preserve_headset', {
        media,
        delaysMs: [0],
        skipInCallRestart: true,
        honorUserRoute: true,
      });
      return;
    }
    let target: InCallAudioRoute =
      resolved === 'SPEAKER_PHONE' || resolved === 'EARPIECE' ? resolved : 'EARPIECE';
    if (
      target === 'SPEAKER_PHONE' &&
      !userExplicitlyChoseLoudSpeakerForCall() &&
      !allowAutoLoudSpeakerOnSystemPiPEnter()
    ) {
      target = audioOnlyCtx
        ? resolveSystemPiPAudioOnlyBuiltinRoute()
        : coercePersistedRouteForAvailableDevices('EARPIECE');
      if (target === 'SPEAKER_PHONE' && !userExplicitlyChoseLoudSpeakerForCall()) {
        target = 'EARPIECE';
      }
    }
    pinBuiltinRouteForPiPContext(target);
    void applyCallAudioOutputRouteNow(target, {
      media,
      forceBuiltIn: !isExternalHeadsetRoute(target),
    });
    const enterReason =
      target === 'SPEAKER_PHONE' &&
      (userExplicitlyChoseLoudSpeakerForCall() || allowAutoLoudSpeakerOnSystemPiPEnter())
        ? 'system_pip_enter_loud_speaker'
        : 'system_pip_enter_preserve_builtin';
    scheduleReapplyPersistedCallAudioRoute(enterReason, {
      media,
      delaysMs: [0],
      skipInCallRestart: target !== 'SPEAKER_PHONE',
      honorUserRoute: true,
    });
  } catch {}
}

export async function reapplyPersistedCallAudioRoute(
  reason: string,
  opts?: { media?: 'audio' | 'video'; honorUserRoute?: boolean; skipInCallRestart?: boolean },
): Promise<void> {
  const baseReason = reason.replace(/_probe_retry$/, '');
  reapplyChain = reapplyChain
    .then(async () => {
      const reason = baseReason;
      if (
        reason === 'preserve_in_app_pip_headset' &&
        shouldDeferPreserveDuringCallBootstrap()
      ) {
        logger.debug('[callAudioRoutePersist] reapply skipped (bootstrap preserve)', { reason });
        return;
      }
      if (
        reason === 'audio_home_preserve_route' &&
        shouldDeferPreserveDuringCallBootstrap()
      ) {
        logger.debug('[callAudioRoutePersist] reapply skipped (bootstrap preserve)', { reason });
        return;
      }
      let honorUser =
        opts?.honorUserRoute ??
        (isHonorUserRouteReason(reason) || reason === 'in_app_pip_audio_route_toggle');
      const lockedBuiltin = readUserLockedBuiltinCallAudioRoute();
      if (lockedBuiltin) {
        honorUser = true;
      }
      if (
        honorUser &&
        (reason === 'audio_home_preserve_route' || reason === 'audio_home_loud_speaker') &&
        isDirectAudioEarpieceStabilizeWindow() &&
        !userExplicitlyPinnedBuiltinCallAudio() &&
        !readUserSelectedExternalCallAudioRoute()
      ) {
        honorUser = false;
      }
      const skipInCallRestart =
        opts?.skipInCallRestart ??
        (isInCallAudioSessionStarted() && isOngoingCallSession() && !reason.includes('bootstrap'));

      if (reason === 'audio_ui_route_cycle' || reason === 'in_app_pip_audio_route_toggle') {
        let route: InCallAudioRoute | null = null;
        let explicitBuiltin: InCallAudioRoute | null = null;
        let explicitFromUserToggle: InCallAudioRoute | null = null;
        try {
          const g = global as any;
          const explicit = normalizeInCallRoute(
            reason === 'audio_ui_route_cycle'
              ? g.__audioUiExplicitCycleRouteRef?.current || ''
              : g.__inAppPiPExplicitToggleRouteRef?.current || '',
          );
          if (explicit) {
            route = explicit;
            explicitFromUserToggle = explicit;
            if (explicit === 'EARPIECE' || explicit === 'SPEAKER_PHONE') {
              explicitBuiltin = explicit;
            }
          }
        } catch {}
        if (!route) {
          route =
            readUserSelectedCallAudioRoute() ||
            getPersistedCallAudioRoute() ||
            readInAppPiPAudioOutputRoute();
        }
        if (!explicitBuiltin && !explicitFromUserToggle) {
          const ext =
            readUserSelectedExternalCallAudioRoute() ||
            (isExternalHeadsetRoute(route) ? route : null) ||
            readActiveExternalCallAudioRoute(route);
          if (isExternalHeadsetRoute(ext)) {
            route = ext;
          }
        }
        if (isInAppPiPManualRouteLockActive() && route) {
          // Не переписывать выбор из-за кратковременного probe без BT в списке.
        } else {
          route = coercePersistedRouteForAvailableDevices(route || 'EARPIECE');
        }
        setPersistedCallAudioRoute(route);
        try {
          const g = global as any;
          g.__lastAppliedCallAudioRouteRef = { current: route };
          const params = g.__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = route;
          }
          g.__onInAppPiPAudioRouteChanged?.(route);
        } catch {}
        const media =
          opts?.media ??
          ((global as any).__pipInAppRtcFromAudioOnlyRef?.current === true ||
          isInAudioOnlyCallUi()
            ? 'audio'
            : resolveActiveCallInCallMedia());
        const signature = `${route}|${media}|pip_toggle`;
        const now = Date.now();
        lastReapplySignature = signature;
        lastReapplyAt = now;
        const toggleSkipInCallRestart =
          reason === 'in_app_pip_audio_route_toggle' || reason === 'audio_ui_route_cycle'
            ? true
            : opts?.skipInCallRestart ??
              (route !== 'SPEAKER_PHONE' && skipInCallRestart);
        await runInCallRestartIfNeeded(media, toggleSkipInCallRestart, reason);
        await applyNativeOutputRoute(route, media, {
          forceBuiltIn: !isExternalHeadsetRoute(route),
          skipCoalesce: true,
        });
        lastNativeInCallSignature = signature;
        logger.info('[callAudioRoutePersist] reapply', {
          reason,
          route,
          media,
          skipInCallRestart: toggleSkipInCallRestart,
          honorUser: true,
        });
        return;
      }

      if (reason === 'in_app_pip_from_audio') {
        if (isDirectCallVideoExpandGuardActive()) {
          logger.debug('[callAudioRoutePersist] reapply skipped (video expand guard)', { reason });
          return;
        }
        if (isInAppPiPExplicitBuiltinRouteChoiceActive()) {
          const plaqueBuiltin = readUserSelectedCallAudioRoute();
          if (plaqueBuiltin === 'EARPIECE' || plaqueBuiltin === 'SPEAKER_PHONE') {
            logger.debug('[callAudioRoutePersist] reapply skipped (plaque builtin choice)', {
              reason,
              route: plaqueBuiltin,
            });
            return;
          }
        }
        const plaqueUser = readUserSelectedCallAudioRoute();
        const plaqueExt = readUserSelectedExternalCallAudioRoute();
        if (
          (global as any).__pipVisibleRef?.current === true &&
          (isExternalHeadsetRoute(plaqueUser) || isExternalHeadsetRoute(plaqueExt))
        ) {
          logger.debug('[callAudioRoutePersist] reapply skipped (plaque external route)', {
            reason,
            route: plaqueExt || plaqueUser,
          });
          return;
        }
        const route = resolvePlaqueReapplyRespectingActiveCallUi('EARPIECE');
        const mediaPre =
          opts?.media ??
          ((global as any).__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi()
            ? 'audio'
            : resolveActiveCallInCallMedia());
        const sigPre = `${route}|${mediaPre}|${reason}`;
        if (sigPre === lastNativeInCallSignature && Date.now() - lastReapplyAt < REAPPLY_DEDUP_MS) {
          logger.debug('[callAudioRoutePersist] reapply skipped (native unchanged)', {
            reason,
            route,
          });
          return;
        }
        pinBuiltinRouteForPiPContext(route);
        const media =
          opts?.media ??
          ((global as any).__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi()
            ? 'audio'
            : resolveActiveCallInCallMedia());
        const plaqueSkip =
          opts?.skipInCallRestart ??
          (route !== 'SPEAKER_PHONE' && skipInCallRestart);
        await runInCallRestartIfNeeded(media, plaqueSkip, reason);
        await applyNativeOutputRoute(route, media, {
          forceBuiltIn: !isExternalHeadsetRoute(route),
        });
        lastNativeInCallSignature = `${route}|${media}|${reason}`;
        logger.info('[callAudioRoutePersist] reapply', {
          reason,
          route,
          media,
          skipInCallRestart: plaqueSkip,
          honorUser: true,
        });
        try {
          if ((global as any).__pipVisibleRef?.current === true) {
            notifyInAppPiPAudioRouteUi(route);
          }
        } catch {}
        return;
      }

      if (reason === 'in_app_pip_headset_connect') {
        const ext =
          readUserSelectedExternalCallAudioRoute() ||
          readActiveExternalCallAudioRoute(readInAppPiPAudioOutputRoute());
        if (!isExternalHeadsetRoute(ext)) return;
        if (ext === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall()) return;
        const media =
          opts?.media ??
          ((global as any).__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi()
            ? 'audio'
            : resolveActiveCallInCallMedia());
        const sig = nativeOutputSignature(ext, media, false);
        if (sig === lastNativeInCallSignature) {
          logger.debug('[callAudioRoutePersist] reapply skipped (headset native unchanged)', {
            reason,
            route: ext,
            media,
          });
          return;
        }
        await applyNativeOutputRoute(ext, media, { forceBuiltIn: false, skipCoalesce: true });
        lastNativeInCallSignature = sig;
        notifyInAppPiPAudioRouteUi(ext);
        logger.info('[callAudioRoutePersist] reapply headset light', { reason, route: ext, media });
        return;
      }

      if (reason === 'audio_ui_headset_connect') {
        const ext =
          readUserSelectedExternalCallAudioRoute() ||
          readNativeProbedExternalRoute() ||
          readActiveExternalCallAudioRoute(readLastAppliedCallAudioRoute());
        if (!isExternalHeadsetRoute(ext)) return;
        if (ext === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall()) return;
        const media = opts?.media ?? 'audio';
        const sig = nativeOutputSignature(ext, media, false);
        if (sig === lastNativeInCallSignature && Date.now() - lastReapplyAt < REAPPLY_DEDUP_MS) {
          logger.debug('[callAudioRoutePersist] reapply skipped (headset connect unchanged)', {
            reason,
            route: ext,
          });
          return;
        }
        try {
          const g = global as any;
          g.__lastAppliedCallAudioRouteRef = { current: ext };
          g.__applyCallAudioRouteFromParentRef?.current?.(ext, reason);
        } catch {}
        await applyNativeOutputRoute(ext, media, { forceBuiltIn: false });
        lastNativeInCallSignature = sig;
        logger.info('[callAudioRoutePersist] reapply headset light', { reason, route: ext, media });
        return;
      }

      if (reason === 'preserve_in_app_pip_headset') {
        if (!hasRealInAppPiPOrSystemReturnContext()) {
          logger.debug('[callAudioRoutePersist] reapply skipped (no PiP context)', { reason });
          return;
        }
        const localAudioUi = shouldSkipDirectCallVideoUiReapply();
        const onFullVideoUi =
          !localAudioUi &&
          (ongoingCallPrefersVideoMedia() ||
          (() => {
            try {
              const g = global as any;
              return (
                g.__stayOnVideoCallUiRef?.current === true ||
                g.__expandToVideoCallUiFromPiPRef?.current === true
              );
            } catch {
              return false;
            }
          })());
        const externalPreserve = readPersistedOrUserExternalRoute();
        let route: InCallAudioRoute;
        if (!onFullVideoUi && isExternalHeadsetRoute(externalPreserve)) {
          route = coercePersistedRouteForAvailableDevices(externalPreserve);
        } else {
          route = onFullVideoUi
            ? resolveFullVideoCallScreenAudioRoute()
            : resolveExplicitPiPOrAudioUiBuiltinRoute('EARPIECE');
        }
        if (
          !onFullVideoUi &&
          !isExternalHeadsetRoute(route) &&
          route !== 'EARPIECE' &&
          route !== 'SPEAKER_PHONE'
        ) {
          route = await resolveHeadsetFirstReapplyRoute(route);
        } else if (
          !onFullVideoUi &&
          !isExternalHeadsetRoute(route) &&
          (route === 'EARPIECE' || route === 'SPEAKER_PHONE') &&
          isExternalHeadsetRoute(externalPreserve) &&
          !isInAppPiPExplicitBuiltinRouteChoiceActive() &&
          !userExplicitlyPinnedBuiltinCallAudio() &&
          !readUserLockedBuiltinCallAudioRoute()
        ) {
          route = coercePersistedRouteForAvailableDevices(externalPreserve);
        }
        if (
          onFullVideoUi &&
          !isExternalHeadsetRoute(route) &&
          route === 'EARPIECE'
        ) {
          route = 'SPEAKER_PHONE';
        }
        pinBuiltinRouteForPiPContext(route);
        const media =
          opts?.media ?? resolveReapplyMediaInCallContext(onFullVideoUi ? 'video' : 'audio');
        const plaqueSkip =
          opts?.skipInCallRestart ??
          (route !== 'SPEAKER_PHONE' && skipInCallRestart);
        await runInCallRestartIfNeeded(media, plaqueSkip, reason);
        await applyNativeOutputRoute(route, media, {
          forceBuiltIn: !isExternalHeadsetRoute(route),
        });
        try {
          const g = global as any;
          g.__lastAppliedCallAudioRouteRef = { current: route };
          g.__onInAppPiPAudioRouteChanged?.(route);
          g.__applyCallAudioRouteFromParentRef?.current?.(route, reason);
        } catch {}
        scheduleProbeMismatchRetryIfNeeded(reason, route, {
          media,
          honorUserRoute: true,
          skipInCallRestart: plaqueSkip,
        });
        lastNativeInCallSignature = nativeOutputSignature(
          route,
          media,
          !isExternalHeadsetRoute(route),
        );
        logger.info('[callAudioRoutePersist] reapply', {
          reason,
          route,
          media,
          skipInCallRestart: plaqueSkip,
          honorUser: true,
        });
        return;
      }

      if (reason === 'return_to_audio_ui') {
        let route = resolveExplicitPiPOrAudioUiBuiltinRoute(
          readCallAudioRouteUiLock() || resolveReturnToAudioUiReapplyRoute() || 'EARPIECE',
        );
        route = coerceDirectAudioAcceptBuiltinRoute(route);
        if (
          !isExternalHeadsetRoute(route) &&
          route !== 'EARPIECE' &&
          route !== 'SPEAKER_PHONE'
        ) {
          route = await resolveHeadsetFirstReapplyRoute(route);
        } else if (
          isExternalHeadsetRoute(route) &&
          route === 'BLUETOOTH' &&
          !isBluetoothHeadsetActiveForCall()
        ) {
          route = coercePersistedRouteForAvailableDevices(route);
        }
        const uiLock = readCallAudioRouteUiLock();
        if (
          !isExternalHeadsetRoute(route) &&
          uiLock &&
          (uiLock === 'EARPIECE' || uiLock === 'SPEAKER_PHONE')
        ) {
          route = uiLock;
        }
        if (route === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall()) {
          route = coercePersistedRouteForAvailableDevices(route);
        }
        const media = opts?.media ?? 'audio';
        const now = Date.now();
        if (shouldSkipScheduledReturnToAudioUiReapply(route)) {
          logger.debug('[callAudioRoutePersist] reapply skipped (return sync applied)', { reason, route });
          return;
        }
        if (shouldSkipDuplicateReapply(route, media, reason, now)) {
          logger.debug('[callAudioRoutePersist] reapply skipped (duplicate)', { reason, route, media });
          return;
        }
        setPersistedCallAudioRoute(route);
        if (route === 'SPEAKER_PHONE' || route === 'EARPIECE') {
          setUserSelectedCallAudioRoute(route);
          if (readUserLockedBuiltinCallAudioRoute()) {
            rememberManualBuiltinCallAudioRoute(route);
          }
        } else if (isExternalHeadsetRoute(route)) {
          setUserSelectedCallAudioRoute(route);
        }
        try {
          const g = global as any;
          g.__lastAppliedCallAudioRouteRef = { current: route };
          const params = g.__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = route;
            params.inAudioOnlyUi = true;
            params.preferVideoCallUi = false;
          }
          g.__onInAppPiPAudioRouteChanged?.(route);
          g.__applyCallAudioRouteFromParentRef?.current?.(route, reason);
        } catch {}
        rememberReapplyDedup(route, media, reason);
        await applyNativeOutputRoute(route, media, {
          forceBuiltIn: !isExternalHeadsetRoute(route),
        });
        lastNativeInCallSignature = `${route}|${media}|return_audio_ui`;
        logger.info('[callAudioRoutePersist] reapply', {
          reason,
          route,
          media,
          skipInCallRestart,
          honorUser: true,
        });
        return;
      }

      if (reason === 'direct_call_accept_audio_route') {
        if (
          !isInAudioOnlyCallUi() &&
          (shouldPreserveCallAudioRouteInInAppPiP() || isInAppPiPVideoPathContext())
        ) {
          logger.debug('[callAudioRoutePersist] reapply skipped (in-app video PiP)', { reason });
          return;
        }
        if (!isInAudioOnlyCallUi()) {
          const extOnly =
            readUserSelectedExternalCallAudioRoute() ||
            readUserSelectedCallAudioRoute();
          if (!isExternalHeadsetRoute(extOnly)) {
            logger.debug('[callAudioRoutePersist] reapply skipped (full video UI)', { reason });
            return;
          }
        }
        let route: InCallAudioRoute;
        if (isInAudioOnlyCallUi()) {
          route = resolveDirectCallAcceptAudioReapplyRoute();
        } else {
          route = await resolveHeadsetFirstReapplyRoute('EARPIECE');
        }
        route = coerceDirectAudioAcceptBuiltinRoute(route);
        const media = opts?.media ?? 'audio';
        const acceptNow = Date.now();
        if (shouldSkipDuplicateReapply(route, media, reason, acceptNow)) {
          logger.debug('[callAudioRoutePersist] reapply skipped (duplicate)', { reason, route, media });
          return;
        }
        setPersistedCallAudioRoute(route);
        if (isExternalHeadsetRoute(route)) {
          setUserSelectedCallAudioRoute(route);
        } else if (route === 'SPEAKER_PHONE' || route === 'EARPIECE') {
          const userPinned =
            readUserLockedBuiltinCallAudioRoute() === route ||
            (route === 'SPEAKER_PHONE' && userExplicitlyPinnedBuiltinCallAudio());
          if (userPinned) {
            setUserSelectedCallAudioRoute(route);
            rememberManualBuiltinCallAudioRoute(route);
          } else if (route === 'EARPIECE') {
            setUserSelectedCallAudioRoute(null);
          }
        }
        try {
          const g = global as any;
          g.__lastAppliedCallAudioRouteRef = { current: route };
          const params = g.__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = route;
          }
          g.__onInAppPiPAudioRouteChanged?.(route);
          g.__applyCallAudioRouteFromParentRef?.current?.(route, reason);
        } catch {}
        rememberReapplyDedup(route, media, reason);
        await applyNativeOutputRoute(route, media, {
          forceBuiltIn: !isExternalHeadsetRoute(route),
        });
        lastNativeInCallSignature = `${route}|${media}|accept_audio`;
        logger.info('[callAudioRoutePersist] reapply', {
          reason,
          route,
          media,
          skipInCallRestart,
          honorUser: true,
        });
        return;
      }

      if (reason === 'direct_call_video_ui_route') {
        if (shouldSkipDirectCallVideoUiReapply()) {
          logger.debug('[callAudioRoutePersist] reapply skipped (audio-only UI)', { reason });
          return;
        }
        if (isDirectCallVideoExpandAudioPreparedRecently()) {
          logger.debug('[callAudioRoutePersist] reapply skipped (expand audio prepared)', {
            reason,
          });
          return;
        }
        const videoRoute = resolveFullVideoCallScreenAudioRoute();
        setPersistedCallAudioRoute(videoRoute);
        try {
          const g = global as any;
          g.__lastAppliedCallAudioRouteRef = { current: videoRoute };
          const params = g.__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = videoRoute;
          }
          g.__onInAppPiPAudioRouteChanged?.(videoRoute);
          g.__applyCallAudioRouteFromParentRef?.current?.(videoRoute, reason);
        } catch {}
        const media = opts?.media ?? 'video';
        const signature = `${videoRoute}|${media}|video_ui`;
        const now = Date.now();
        lastReapplySignature = signature;
        lastReapplyAt = now;
        await applyNativeOutputRoute(videoRoute, media, {
          forceBuiltIn: !isExternalHeadsetRoute(videoRoute),
        });
        lastNativeInCallSignature = signature;
        logger.info('[callAudioRoutePersist] reapply', {
          reason,
          route: videoRoute,
          media,
          skipInCallRestart,
          honorUser: true,
        });
        return;
      }

      if (reason === 'in_app_pip_from_video') {
        if (isInAppPiPManualRouteLockActive()) {
          logger.debug('[callAudioRoutePersist] reapply skipped (pip manual lock)', { reason });
          return;
        }
        const videoRoute = resolveVideoInAppPiPPreserveRoute();
        if (isExternalHeadsetRoute(videoRoute)) {
          setUserSelectedCallAudioRoute(videoRoute);
          markUserSelectedExternalCallAudioRoute(videoRoute);
        } else {
          setUserSelectedCallAudioRoute(null);
          try {
            (global as any).__userSelectedExternalCallAudioRouteRef = { current: null };
          } catch {}
        }
        await applyVideoContextNativeRoute(
          reason,
          videoRoute,
          opts?.media ?? 'video',
          skipInCallRestart,
        );
        return;
      }

      if (reason === 'in_app_pip_headset_unplug') {
        if (isInAppPiPManualRouteLockActive()) {
          logger.debug('[callAudioRoutePersist] reapply skipped (pip manual lock)', { reason });
          return;
        }
        let route = normalizeInCallRoute(
          readUserSelectedCallAudioRoute() || getPersistedCallAudioRoute() || '',
        ) as InCallAudioRoute;
        if (!route || isExternalHeadsetRoute(route)) {
          route = resolveCallRouteAfterHeadsetDisconnect();
        }
        if (route === 'SPEAKER_PHONE' && (isInAppPiPVideoPathContext() || ongoingCallPrefersVideoMedia())) {
          rememberBuiltinCallRouteBeforeHeadset('SPEAKER_PHONE', false);
        }
        const media = resolveReapplyMediaInCallContext(opts?.media);
        setPersistedCallAudioRoute(route);
        setUserSelectedCallAudioRoute(route);
        try {
          const g = global as any;
          g.__lastAppliedCallAudioRouteRef = { current: route };
          g.__userSelectedExternalCallAudioRouteRef = { current: null };
          const params = g.__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = route;
          }
          g.__onInAppPiPAudioRouteChanged?.(route);
          g.__applyCallAudioRouteFromParentRef?.current?.(route, reason);
        } catch {}
        await applyNativeOutputRoute(route, media, { forceBuiltIn: true, skipCoalesce: true });
        lastNativeInCallSignature = `${route}|${media}|${reason}`;
        logger.info('[callAudioRoutePersist] reapply', {
          reason,
          route,
          media,
          skipInCallRestart: true,
          honorUser: true,
        });
        return;
      }

      if (reason === 'video_call_return_from_pip') {
        if (
          isDirectCallVideoExpandGuardActive() ||
          isDirectCallVideoExpandAudioPreparedRecently()
        ) {
          logger.debug('[callAudioRoutePersist] reapply skipped (expand prepared)', { reason });
          return;
        }
        const videoRoute = resolveFullVideoCallScreenAudioRoute();
        if (videoRoute === 'SPEAKER_PHONE') {
          setUserSelectedCallAudioRoute('SPEAKER_PHONE');
          rememberManualBuiltinCallAudioRoute('SPEAKER_PHONE');
          armCallAudioRouteUiLock('SPEAKER_PHONE');
          try {
            (global as any).__userSelectedExternalCallAudioRouteRef = { current: null };
            (global as any).__explicitBuiltInCallAudioRouteRef = { current: true };
          } catch {}
        } else if (isExternalHeadsetRoute(videoRoute)) {
          clearCallAudioRouteUiLock();
          setUserSelectedCallAudioRoute(videoRoute);
          markUserSelectedExternalCallAudioRoute(videoRoute);
        }
        await applyVideoContextNativeRoute(
          reason,
          videoRoute,
          opts?.media ?? 'video',
          skipInCallRestart,
        );
        return;
      }

      if (reason === 'system_pip_enter_loud_speaker' || reason === 'system_pip_enter_preserve_builtin') {
        const media = opts?.media ?? resolveActiveCallInCallMedia();
        let route = resolveSystemPiPEnterPlaqueRoute();
        pinBuiltinRouteForPiPContext(route);
        const systemSkip =
          opts?.skipInCallRestart ??
          (route !== 'SPEAKER_PHONE' && skipInCallRestart);
        await applyVideoContextNativeRoute(reason, route, media, systemSkip);
        return;
      }

      if (reason === 'system_pip_exit_preserve_route' || reason === 'system_pip_return_media') {
        if (shouldSkipDirectCallVideoUiReapply()) {
          logger.debug('[callAudioRoutePersist] reapply system PiP as audio-only UI', { reason });
        }
        await reapplySystemPiPExitOrReturnRoute(reason, {
          media: resolveReapplyMediaInCallContext(opts?.media),
          skipInCallRestart: opts?.skipInCallRestart,
        });
        return;
      }

      if (Platform.OS === 'android' && /foreground|pip|return/i.test(reason) && !honorUser) {
        try {
          const probe = await probeNativeCallAudioRoutes();
          mergeNativeProbeIntoGlobal(probe);
        } catch {}
      }
      if (!honorUser && !lockedBuiltin) {
        const externalBeforeCapture = readActiveExternalCallAudioRoute();
        if (!externalBeforeCapture && !isDirectAudioEarpieceStabilizeWindow()) {
          captureCallAudioRouteFromUi();
        } else if (!externalBeforeCapture && isDirectAudioEarpieceStabilizeWindow()) {
          setPersistedCallAudioRoute('EARPIECE');
          try {
            (global as any).__lastAppliedCallAudioRouteRef = { current: 'EARPIECE' };
          } catch {}
        } else {
          const externalRoute = externalBeforeCapture;
          if (!externalRoute) return;
          setPersistedCallAudioRoute(externalRoute);
          try {
            (global as any).__lastAppliedCallAudioRouteRef = { current: externalRoute };
          } catch {}
        }
      }
      let stored = getPersistedCallAudioRoute();
      const preserveInAppPiP =
        shouldPreserveCallAudioRouteInInAppPiP() && !isAppInCallBackgroundState();
      if ((preserveInAppPiP || honorUser) && !stored) {
        stored = readInAppPiPAudioOutputRoute();
        if (stored) setPersistedCallAudioRoute(stored);
      }
      const lockedExternal = readUserSelectedExternalCallAudioRoute();
      if (lockedExternal) {
        stored = lockedExternal;
        setPersistedCallAudioRoute(lockedExternal);
        try {
          const params = (global as any).__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = lockedExternal;
          }
          (global as any).__onInAppPiPAudioRouteChanged?.(lockedExternal);
        } catch {}
      }
      if (preserveInAppPiP && !honorUser) {
        const preserved = readInAppPiPAudioOutputRoute();
        if (isExternalHeadsetRoute(preserved) || preserveInAppPiP) {
          stored = preserved;
          setPersistedCallAudioRoute(preserved);
        }
      }
      let route =
        lockedBuiltin ||
        (honorUser ? resolvePreserveCallAudioRoute() : null) ||
        (preserveInAppPiP || honorUser || isExternalHeadsetRoute(stored)
          ? stored || readInAppPiPAudioOutputRoute()
          : resolvePersistedCallAudioRouteForReapply(stored));
      if (!route) return;
      if (
        (reason === 'audio_home_loud_speaker' || reason === 'audio_home_preserve_route') &&
        !shouldApplyHomeLoudSpeakerPin() &&
        !honorUser &&
        !lockedBuiltin
      ) {
        route = resolvePreserveCallAudioRoute();
        setPersistedCallAudioRoute(route);
      }
      if (
        !honorUser &&
        !(route === 'SPEAKER_PHONE' || route === 'EARPIECE')
      ) {
        const extAfterResolve = readActiveExternalCallAudioRoute(route);
        if (
          extAfterResolve &&
          isExternalHeadsetRoute(extAfterResolve) &&
          !isExternalHeadsetRoute(route) &&
          (isCallAudioPiPTransitionWindow() || reason.includes('foreground') || reason.includes('pip'))
        ) {
          route = extAfterResolve;
          setPersistedCallAudioRoute(extAfterResolve);
        }
      }
      route = coercePersistedRouteForAvailableDevices(route || 'EARPIECE');
      if (
        !honorUser &&
        isDirectAudioEarpieceStabilizeWindow() &&
        !readUserSelectedCallAudioRoute() &&
        !readUserSelectedExternalCallAudioRoute()
      ) {
        const liveExt = readActiveExternalCallAudioRoute(route);
        if (!isExternalHeadsetRoute(liveExt)) {
          route = 'EARPIECE';
        }
      }
      if (
        isOngoingCallSession() &&
        isAudioOnlyOngoingCallContext() &&
        !lockedBuiltin &&
        !readUserSelectedExternalCallAudioRoute() &&
        (route === 'EARPIECE' || route === 'SPEAKER_PHONE') &&
        (reason === 'audio_home_preserve_route' ||
          reason === 'stopSpeaker_skip_active_call' ||
          reason === 'audio_home_loud_speaker')
      ) {
        logger.info('[callAudioRoutePersist] reapply skipped auto built-in', {
          reason,
          route,
          honorUser,
        });
        return;
      }
      if (route !== stored) {
        setPersistedCallAudioRoute(route);
        try {
          const params = (global as any).__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = route;
          }
          (global as any).__onInAppPiPAudioRouteChanged?.(route);
        } catch {}
      }

      if (
        !honorUser &&
        (route === 'EARPIECE' || route === 'SPEAKER_PHONE')
      ) {
        const liveExt =
          readActiveExternalCallAudioRoute(route) ||
          readNativeProbedExternalRoute() ||
          (isExternalHeadsetRoute(readLastAppliedCallAudioRoute())
            ? readLastAppliedCallAudioRoute()
            : null);
        if (isExternalHeadsetRoute(liveExt)) {
          if (liveExt === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall()) {
            // keep builtin route
          } else {
            route = liveExt;
            setPersistedCallAudioRoute(liveExt);
          }
        }
      }

      const media =
        opts?.media ??
        (isDirectAudioEarpieceStabilizeWindow() || isInAudioOnlyCallUi()
          ? 'audio'
          : resolveActiveCallInCallMedia());
      const signature = `${route}|${media}|${honorUser ? 'honor' : 'auto'}`;
      const now = Date.now();
      if (shouldSkipDuplicateReapply(route, media, reason, now)) {
        logger.debug('[callAudioRoutePersist] reapply skipped (duplicate)', { reason, route, media });
        return;
      }
      lastReapplySignature = signature;
      rememberReapplyDedup(route, media, reason);

      const forceBuiltIn =
        (honorUser && (route === 'EARPIECE' || route === 'SPEAKER_PHONE')) ||
        !!lockedBuiltin;

      if (isExternalHeadsetRoute(route) && isOngoingCallSession()) {
        if (route === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall()) {
          route = coercePersistedRouteForAvailableDevices(route);
          setPersistedCallAudioRoute(route);
          try {
            const params = (global as any).__currentCallPiPParamsRef?.current;
            if (params && typeof params === 'object') {
              params.audioOutputRoute = route;
            }
            notifyInAppPiPAudioRouteUi(route);
          } catch {}
        }
        if (isExternalHeadsetRoute(route)) {
          await applyNativeOutputRoute(route, media, { forceBuiltIn: false });
          lastNativeInCallSignature = signature;
          logger.info('[callAudioRoutePersist] reapply headset light', { reason, route, media });
          return;
        }
      }

      const skipHeavyNative =
        !honorUser &&
        !lockedBuiltin &&
        signature === lastNativeInCallSignature &&
        (isExternalHeadsetRoute(route) || route === 'EARPIECE');

      if (skipHeavyNative) {
        if (isExternalHeadsetRoute(route)) {
          try {
            (InCallManager as any).setForceSpeakerphoneOn?.(false);
            InCallManager.setSpeakerphoneOn(false);
            await (InCallManager as any).chooseAudioRoute?.(route);
          } catch {}
        }
        logger.debug('[callAudioRoutePersist] reapply light (native unchanged)', { reason, route, media });
        return;
      }

      await runInCallRestartIfNeeded(media, skipInCallRestart, reason);

      await applyNativeOutputRoute(route, media, { forceBuiltIn });

      lastNativeInCallSignature = signature;
      logger.info('[callAudioRoutePersist] reapply', { reason, route, media, skipInCallRestart, honorUser });
    })
    .catch(() => {});
}

export function scheduleReapplyPersistedCallAudioRoute(
  reason: string,
  opts?: { media?: 'audio' | 'video'; delaysMs?: number[]; honorUserRoute?: boolean; skipInCallRestart?: boolean },
): void {
  if (reason === 'audio_home_preserve_route_deferred') {
    clearScheduledReapplies();
    const delays = opts?.delaysMs ?? [2600, 3400];
    for (const ms of delays) {
      const t = setTimeout(() => {
        schedulePreserveCallAudioRoute('audio_home_preserve_route', opts?.media);
      }, ms);
      scheduledReapplyTimers.push({ timer: t, reason: 'audio_home_preserve_route_deferred' });
    }
    return;
  }
  if (reason === 'audio_home_loud_speaker' && !shouldApplyHomeLoudSpeakerPin()) {
    schedulePreserveCallAudioRoute('audio_home_preserve_route', opts?.media);
    return;
  }
  if (reason === 'return_to_audio_ui' && shouldSkipScheduledReturnToAudioUiReapply()) {
    logger.debug('[callAudioRoutePersist] schedule skipped (return sync applied)', { reason });
    return;
  }
  const preserveSystemPiP =
    reason === 'app_state_background' && isCallAudioPiPTransitionWindow();
  const mergeSystemPiPEnter = reason.startsWith('system_pip_enter_');
  clearScheduledReapplies(
    preserveSystemPiP || mergeSystemPiPEnter
      ? { preserveReasonPrefixes: ['system_pip_enter_'] }
      : undefined,
  );
  if (preserveSystemPiP) {
    return;
  }
  if (isPipBurstReapplyReason(reason)) {
    cancelScheduledCallAudioRouteReappliesMatching([
      'in_app_pip_from_',
      'in_app_pip_preserve_',
      'preserve_in_app_pip_',
      'video_call_return_from_pip',
    ]);
  }
  const defaultDelays =
    reason === 'in_app_pip_audio_route_toggle' || reason === 'audio_ui_route_cycle'
      ? [0]
      : reason === 'in_app_pip_headset_connect' ||
          reason === 'in_app_pip_headset_unplug' ||
          reason === 'audio_ui_headset_connect'
        ? [0]
      : reason.endsWith('_probe_retry')
        ? [PROBE_MISMATCH_RETRY_MS]
        : isPipBurstReapplyReason(reason) ||
            /^system_pip_enter_|^video_call_return_from_pip$|^return_to_audio_ui$|^direct_call_(video|accept)/.test(
              reason,
            )
          ? [0]
          : [0, 300, 900, 1500, 2500];
  const delays = opts?.delaysMs ?? defaultDelays;
  const reapplyOpts = {
    media: opts?.media,
    honorUserRoute: opts?.honorUserRoute,
    skipInCallRestart:
      opts?.skipInCallRestart ??
      (reason === 'return_to_audio_ui' && isInCallAudioSessionStarted() && isOngoingCallSession()),
  };
  for (const ms of delays) {
    const timer = setTimeout(() => {
      scheduledReapplyTimers = scheduledReapplyTimers.filter((e) => e.timer !== timer);
      void reapplyPersistedCallAudioRoute(reason, reapplyOpts).then(() => {
        if (reason.includes('headset') && reason !== 'preserve_in_app_pip_headset') return;
        const applied = readLastAppliedCallAudioRoute();
        if (applied) {
          scheduleProbeMismatchRetryIfNeeded(
            reason.replace(/_probe_retry$/, ''),
            applied,
            reapplyOpts,
          );
        }
      });
    }, ms);
    scheduledReapplyTimers.push({ timer, reason });
  }
}

/** In-app PiP: сохранить earpiece / speaker / BT / провод при reapply. */
export function shouldPreserveCallAudioRouteInInAppPiP(): boolean {
  try {
    const g = global as any;
    if (g.__pipVisibleRef?.current !== true) return false;
    if (g.__pipInSystemModeRef?.current === true) return false;
    return true;
  } catch {
    return false;
  }
}

/** После разворота system PiP: mic + динамик как до ухода на Home. */
export function restoreCallMediaAfterSystemPiPReturn(): boolean {
  const g = global as any;
  const token = Number(g.__systemPiPReturnTokenRef?.current || 0);
  g.__systemPiPReturnMediaRestoreTokenRef =
    g.__systemPiPReturnMediaRestoreTokenRef || { current: 0 };
  if (token && g.__systemPiPReturnMediaRestoreTokenRef.current === token) {
    return false;
  }
  if (!applySystemPiPReturnMediaSnapshot()) return false;
  if (shouldSkipDirectCallVideoUiReapply()) {
    return false;
  }
  if (token) {
    g.__systemPiPReturnMediaRestoreTokenRef.current = token;
  }
  scheduleReapplyPersistedCallAudioRoute('system_pip_return_media', {
    media: resolveReapplyMediaInCallContext(),
    delaysMs: [0, 250, 800, 1500],
  });
  return true;
}

/**
 * Home + in-app PiP (VideoCall в стеке, но не на экране): переприменить маршрут и InCall после system PiP / фона.
 */
export function restoreCallAudioForInAppPiPPlaque(reason: string): void {
  if (!isOngoingCallSession()) return;
  try {
    const g = global as any;
    const plaqueActive =
      g.__pipVisibleRef?.current === true ||
      g.__pipSuspendedForSystemPiPRef?.current === true ||
      g.__restoringInAppPiPFromSystemRef?.current === true;
    if (!plaqueActive) return;
  } catch {
    return;
  }
  captureCallAudioRouteFromUi();
  const route = readInAppPiPAudioOutputRoute();
  pinBuiltinRouteForPiPContext(route);
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    (global as any).__lastAppliedCallAudioRouteRef = { current: route };
    (global as any).__onInAppPiPAudioRouteChanged?.(route);
  } catch {}
  const media = resolveActiveCallInCallMedia();
  const external = isExternalHeadsetRoute(route);
  const lightPlaque =
    reason.includes('stopSpeaker') ||
    reason.includes('in_app_pip') ||
    reason.includes('restore_in_app');
  scheduleReapplyPersistedCallAudioRoute(reason, {
    media,
    skipInCallRestart: lightPlaque,
    delaysMs: external ? (lightPlaque ? [0] : [0, 500, 1500]) : lightPlaque ? [0] : [0, 300, 900, 1500],
  });
  restoreOngoingCallMicrophoneIfEnabled();
  try {
    const g = global as any;
    if (typeof g.__syncDirectCallAudioRouteRef?.current === 'function') {
      const external = isExternalHeadsetRoute(route);
      if (!external) {
        g.__syncDirectCallAudioRouteRef.current();
      }
    }
  } catch {}
}
