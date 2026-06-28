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
  isDirectAudioEarpieceStabilizeWindow,
  ongoingCallPrefersVideoMedia,
  isPiPBuiltinCallAudioRouteLockActive,
  releaseInAppPiPBuiltinAudioLockForFullVideoUi,
} from './activeCallSession';
import { isInAudioOnlyCallUi, prepareDirectCallVideoReturnFromPiP } from '../src/pip/pipPlaceholderOnly';
import {
  resolveCallRouteAfterHeadsetDisconnect,
  rememberBuiltinCallRouteBeforeHeadset,
  readDirectCallAudioRouteBeforeVideo,
  isInSystemPiPMode,
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
} from './callAudioRouteTransitionGuards';
import { readRootCurrentRouteName } from './safeRootNavigation';
import { notifyInAppPiPAudioRouteUi } from './callInAppPiPAudioRouteUi';
export {
  isCallAudioPiPTransitionWindow,
  armCallAudioPreservePriority,
  armCallAudioRouteUiLock,
  readCallAudioRouteUiLock,
  clearCallAudioRouteUiLock,
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
export function clearStaleInAppPiPAudioContextForFreshCallNav(reason: string): void {
  if (reason !== 'incoming_navigate' && reason !== 'call_accepted' && reason !== 'flush_pending') {
    return;
  }
  try {
    const g = global as any;
    if (g.__pipVisibleRef?.current === true || g.__pipInSystemModeRef?.current === true) {
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

/** Video UI из in-app плашки (VideoCall уже на экране): UI-флаги + динамик/BT без earpiece. */
export function prepareDirectCallVideoExpandFromInAppPiP(): void {
  releaseInAppPiPBuiltinAudioLockForFullVideoUi();
  prepareDirectCallVideoReturnFromPiP();
  clearCallAudioRouteUiLock();
  markDirectCallVideoMediaActive();
  try {
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
    !!lockedBuiltin || userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE';
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

/** Полный video UI: гарнитура/BT как в плашке; встроенное ухо → громкая. */
export function resolveFullVideoCallScreenAudioRoute(): InCallAudioRoute {
  const ext =
    readUserSelectedExternalCallAudioRoute() ||
    readActiveExternalCallAudioRoute(readInAppPiPAudioOutputRoute());
  if (isExternalHeadsetRoute(ext)) {
    return ext;
  }
  const plaque =
    readInAppPiPAudioOutputRoute() || getPersistedCallAudioRoute() || readLastAppliedCallAudioRoute();
  if (isExternalHeadsetRoute(plaque)) {
    return plaque;
  }
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
  return resolveVideoInAppPiPAudioRoute(
    getPersistedCallAudioRoute() ||
      readInAppPiPAudioOutputRoute() ||
      readLastAppliedCallAudioRoute(),
    { mapForEnterVideoUi: !inAppPiP },
  );
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
  await applyNativeOutputRoute(route, media, { forceBuiltIn: true });
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
let lastNativeInCallSignature = '';
const REAPPLY_DEDUP_MS = 900;

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

/** Синхронно с PiP toggle / явным выбором — не ждать reapply chain. */
export async function applyCallAudioOutputRouteNow(
  route: InCallAudioRoute,
  opts?: { media?: 'audio' | 'video'; forceBuiltIn?: boolean },
): Promise<void> {
  const media = opts?.media ?? resolveActiveCallInCallMedia();
  await applyNativeOutputRoute(route, media, { forceBuiltIn: opts?.forceBuiltIn ?? true });
  try {
    const g = global as any;
    g.__lastAppliedCallAudioRouteRef = { current: route };
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
  } catch {}
}

async function applyNativeOutputRoute(
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
    if (lock === 'EARPIECE') {
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

/** System PiP из audio UI / audio-плашки: сохраняем ear или speaker пользователя, не подменяем на video-политику. */
function isSystemPiPFromAudioOnlyCallContext(): boolean {
  try {
    const snap = peekSystemPiPReturnMediaSnapshot();
    if (snap?.preferAudioOnlyUi) return true;
    if (isInAudioOnlyCallUi()) return true;
    const g = global as any;
    if (g.__preferAudioOnlyUiOnNextVideoCallRef?.current === true) return true;
    if (g.__pipInAppRtcFromAudioOnlyRef?.current === true) return true;
    if (
      g.__pipAudioOnlyPlaceholderRef?.current === true &&
      g.__stayOnVideoCallUiRef?.current !== true
    ) {
      return true;
    }
  } catch {}
  return false;
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
    route = resolveSystemPiPAudioOnlyBuiltinRoute();
    media = 'audio';
    try {
      armCallAudioRouteUiLock(route, 8500);
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
    const media = resolveActiveCallInCallMedia();
    const resolved = resolveSystemPiPEnterPlaqueRoute();
    const external =
      readActiveExternalCallAudioRoute(resolved) ||
      (isExternalHeadsetRoute(resolved) ? resolved : null);
    if (external && isExternalHeadsetRoute(external)) {
      pinBuiltinRouteForPiPContext(external);
      void applyCallAudioOutputRouteNow(external, { media, forceBuiltIn: false });
      scheduleReapplyPersistedCallAudioRoute('system_pip_enter_preserve_headset', {
        media,
        delaysMs: [0, 450],
        skipInCallRestart: true,
        honorUserRoute: true,
      });
      return;
    }
    const target: InCallAudioRoute =
      resolved === 'SPEAKER_PHONE' || resolved === 'EARPIECE' ? resolved : 'EARPIECE';
    pinBuiltinRouteForPiPContext(target);
    void applyCallAudioOutputRouteNow(target, { media, forceBuiltIn: true });
    const enterReason =
      target === 'SPEAKER_PHONE'
        ? 'system_pip_enter_loud_speaker'
        : 'system_pip_enter_preserve_builtin';
    scheduleReapplyPersistedCallAudioRoute(enterReason, {
      media,
      delaysMs: [0, 450],
      skipInCallRestart: target !== 'SPEAKER_PHONE',
      honorUserRoute: true,
    });
  } catch {}
}

export async function reapplyPersistedCallAudioRoute(
  reason: string,
  opts?: { media?: 'audio' | 'video'; honorUserRoute?: boolean; skipInCallRestart?: boolean },
): Promise<void> {
  reapplyChain = reapplyChain
    .then(async () => {
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
      const skipInCallRestart =
        opts?.skipInCallRestart ??
        (isInCallAudioSessionStarted() && isOngoingCallSession() && !reason.includes('bootstrap'));

      if (reason === 'audio_ui_route_cycle' || reason === 'in_app_pip_audio_route_toggle') {
        let route: InCallAudioRoute | null = null;
        let explicitBuiltin: InCallAudioRoute | null = null;
        try {
          const g = global as any;
          const explicit = normalizeInCallRoute(
            reason === 'audio_ui_route_cycle'
              ? g.__audioUiExplicitCycleRouteRef?.current || ''
              : g.__inAppPiPExplicitToggleRouteRef?.current || '',
          );
          if (explicit) {
            route = explicit;
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
        if (!explicitBuiltin) {
          const ext =
            readUserSelectedExternalCallAudioRoute() ||
            (isExternalHeadsetRoute(route) ? route : null) ||
            readActiveExternalCallAudioRoute(route);
          if (isExternalHeadsetRoute(ext)) {
            route = ext;
          }
        }
        route = coercePersistedRouteForAvailableDevices(route || 'EARPIECE');
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
          opts?.skipInCallRestart ??
          (route !== 'SPEAKER_PHONE' && skipInCallRestart);
        if (!toggleSkipInCallRestart) {
          try {
            if (Platform.OS === 'android') beginBackgroundMediaSuppression();
            InCallManager.start({ media, ringback: '' });
            markInCallAudioSessionStarted(true);
            try {
              (InCallManager as any).requestAudioFocus?.();
            } catch {}
          } catch {}
        }
        await applyNativeOutputRoute(route, media, { forceBuiltIn: true });
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
        const route = resolvePiPPlaqueReapplyRoute('EARPIECE');
        pinBuiltinRouteForPiPContext(route);
        const media =
          opts?.media ??
          ((global as any).__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi()
            ? 'audio'
            : resolveActiveCallInCallMedia());
        const plaqueSkip =
          opts?.skipInCallRestart ??
          (route !== 'SPEAKER_PHONE' && skipInCallRestart);
        if (!plaqueSkip) {
          try {
            if (Platform.OS === 'android') beginBackgroundMediaSuppression();
            InCallManager.start({ media, ringback: '' });
            markInCallAudioSessionStarted(true);
            try {
              (InCallManager as any).requestAudioFocus?.();
            } catch {}
          } catch {}
        }
        await applyNativeOutputRoute(route, media, { forceBuiltIn: true });
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
        await applyNativeOutputRoute(ext, media, { forceBuiltIn: false });
        lastNativeInCallSignature = `${ext}|${media}|${reason}`;
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
        try {
          const g = global as any;
          g.__lastAppliedCallAudioRouteRef = { current: ext };
          g.__applyCallAudioRouteFromParentRef?.current?.(ext, reason);
        } catch {}
        await applyNativeOutputRoute(ext, media, { forceBuiltIn: false });
        lastNativeInCallSignature = `${ext}|${media}|${reason}`;
        logger.info('[callAudioRoutePersist] reapply headset light', { reason, route: ext, media });
        return;
      }

      if (reason === 'preserve_in_app_pip_headset') {
        if (!hasRealInAppPiPOrSystemReturnContext()) {
          logger.debug('[callAudioRoutePersist] reapply skipped (no PiP context)', { reason });
          return;
        }
        const onFullVideoUi =
          ongoingCallPrefersVideoMedia() ||
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
          })();
        let route = onFullVideoUi
          ? resolveFullVideoCallScreenAudioRoute()
          : resolvePlaqueReapplyRespectingActiveCallUi('EARPIECE');
        if (
          onFullVideoUi &&
          !isExternalHeadsetRoute(route) &&
          route === 'EARPIECE'
        ) {
          route = 'SPEAKER_PHONE';
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
        if (!plaqueSkip) {
          try {
            if (Platform.OS === 'android') beginBackgroundMediaSuppression();
            InCallManager.start({ media, ringback: '' });
            markInCallAudioSessionStarted(true);
            try {
              (InCallManager as any).requestAudioFocus?.();
            } catch {}
          } catch {}
        }
        await applyNativeOutputRoute(route, media, { forceBuiltIn: true });
        lastNativeInCallSignature = `${route}|${media}|${reason}`;
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
        let route = await resolveHeadsetFirstReapplyRoute(
          readCallAudioRouteUiLock() || resolveReturnToAudioUiReapplyRoute() || 'EARPIECE',
        );
        const uiLock = readCallAudioRouteUiLock();
        if (
          !isExternalHeadsetRoute(route) &&
          uiLock &&
          readUserLockedBuiltinCallAudioRoute() &&
          (uiLock === 'EARPIECE' || uiLock === 'SPEAKER_PHONE')
        ) {
          route = uiLock;
        }
        if (route === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall()) {
          route = coercePersistedRouteForAvailableDevices(route);
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
        const media = opts?.media ?? 'audio';
        const signature = `${route}|${media}|return_audio_ui`;
        const now = Date.now();
        lastReapplySignature = signature;
        lastReapplyAt = now;
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
        return;
      }

      if (reason === 'direct_call_accept_audio_route') {
        const route = await resolveHeadsetFirstReapplyRoute('EARPIECE');
        setPersistedCallAudioRoute(route);
        if (isExternalHeadsetRoute(route)) {
          setUserSelectedCallAudioRoute(route);
        } else if (route === 'SPEAKER_PHONE' || route === 'EARPIECE') {
          setUserSelectedCallAudioRoute(route);
          if (readUserLockedBuiltinCallAudioRoute()) {
            rememberManualBuiltinCallAudioRoute(route);
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
        const media = opts?.media ?? 'audio';
        const signature = `${route}|${media}|accept_audio`;
        const now = Date.now();
        lastReapplySignature = signature;
        lastReapplyAt = now;
        await applyNativeOutputRoute(route, media, { forceBuiltIn: true });
        lastNativeInCallSignature = signature;
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
        await applyNativeOutputRoute(videoRoute, media, { forceBuiltIn: true });
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
        const videoRoute = resolveVideoInAppPiPAudioRoute(
          getPersistedCallAudioRoute() || readInAppPiPAudioOutputRoute(),
          { mapForEnterVideoUi: false },
        );
        await applyVideoContextNativeRoute(
          reason,
          videoRoute,
          opts?.media ?? 'video',
          skipInCallRestart,
        );
        return;
      }

      if (reason === 'video_call_return_from_pip') {
        const videoRoute = resolveFullVideoCallScreenAudioRoute();
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
        await reapplySystemPiPExitOrReturnRoute(reason, {
          media: opts?.media,
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
      if (signature === lastReapplySignature && now - lastReapplyAt < REAPPLY_DEDUP_MS) {
        if (!honorUser || reason !== 'in_app_pip_audio_route_toggle') {
          logger.debug('[callAudioRoutePersist] reapply skipped (duplicate)', { reason, route, media });
          return;
        }
      }
      lastReapplySignature = signature;
      lastReapplyAt = now;

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

      if (!skipInCallRestart) {
        try {
          if (Platform.OS === 'android') beginBackgroundMediaSuppression();
          InCallManager.start({ media, ringback: '' });
          markInCallAudioSessionStarted(true);
          try {
            (InCallManager as any).requestAudioFocus?.();
          } catch {}
        } catch {}
      }

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
  const defaultDelays =
    reason === 'in_app_pip_audio_route_toggle' || reason === 'audio_ui_route_cycle'
      ? [0, 450]
      : /^in_app_pip_from_|system_pip_|video_call_return_from_pip|return_to_audio_ui|direct_call_(video|accept)/.test(reason)
        ? [0, 450]
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
      void reapplyPersistedCallAudioRoute(reason, reapplyOpts);
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
  if (token) {
    g.__systemPiPReturnMediaRestoreTokenRef.current = token;
  }
  scheduleReapplyPersistedCallAudioRoute('system_pip_return_media', {
    media: resolveActiveCallInCallMedia(),
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
    delaysMs: external ? (lightPlaque ? [0, 450] : [0, 500, 1500]) : lightPlaque ? [0, 450] : [0, 300, 900, 1500],
  });
  restoreOngoingCallMicrophoneIfEnabled();
  if (Platform.OS === 'android') {
    try {
      NativeModules.LiviAppModule?.maintainActiveCallVoiceAudio?.();
    } catch {}
  }
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
