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
  resolveActiveCallInCallMedia,
  resolvePersistedCallAudioRouteForReapply,
  readInAppPiPAudioOutputRoute,
  readLastAppliedCallAudioRoute,
  readActiveExternalCallAudioRoute,
  markDirectCallVideoMediaActive,
  restoreOngoingCallMicrophoneIfEnabled,
  isOngoingCallSession,
  isInCallAudioSessionStarted,
  markInCallAudioSessionStarted,
  readUserSelectedCallAudioRoute,
  readUserLockedBuiltinCallAudioRoute,
  readUserSelectedExternalCallAudioRoute,
  isDirectAudioEarpieceStabilizeWindow,
} from './activeCallSession';
import { isInAudioOnlyCallUi } from '../src/pip/pipPlaceholderOnly';
import { resolveCallRouteAfterHeadsetDisconnect, rememberBuiltinCallRouteBeforeHeadset } from './callHeadsetAudioFallback';
import {
  readNativeProbedExternalRoute,
  mergeNativeProbeIntoGlobal,
  probeNativeCallAudioRoutes,
  isCallAudioBootstrapPending,
} from './nativeCallAudioProbe';

function readAvailableAudioDeviceList(): string[] {
  try {
    const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
    return Array.isArray(av) ? av.map((s: unknown) => String(s)) : [];
  } catch {
    return [];
  }
}

const CALL_AUDIO_PRESERVE_PRIORITY_MS = 4000;

/** Окно enter/exit system PiP и возврата — не форсить громкую связь поверх earpiece/BT. */
export function isCallAudioPiPTransitionWindow(): boolean {
  try {
    const g = global as any;
    const now = Date.now();
    if (now < Number(g.__returningFromSystemPiPUntilRef?.current || 0)) return true;
    if (g.__pipInSystemModeRef?.current === true) return true;
    if (now < Number(g.__systemPiPEntryInProgressUntilRef?.current || 0)) return true;
    if (now < Number(g.__callAudioPreservePriorityUntilRef?.current || 0)) return true;
  } catch {}
  return false;
}

export function armCallAudioPreservePriority(ms = CALL_AUDIO_PRESERVE_PRIORITY_MS): void {
  try {
    const g = global as any;
    g.__callAudioPreservePriorityUntilRef = g.__callAudioPreservePriorityUntilRef || { current: 0 };
    g.__callAudioPreservePriorityUntilRef.current = Math.max(
      Number(g.__callAudioPreservePriorityUntilRef.current || 0),
      Date.now() + ms,
    );
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
function shouldDeferPreserveDuringCallBootstrap(): boolean {
  if (readUserLockedBuiltinCallAudioRoute()) return false;
  if (!isCallAudioBootstrapPending()) return false;
  if (isAppInCallBackgroundState()) return false;
  try {
    const routeName = (global as any).__navRef?.getCurrentRoute?.()?.name;
    if (routeName === 'VideoCall') return true;
  } catch {}
  return false;
}

function resolvePreserveCallAudioRoute(): InCallAudioRoute {
  const lockedBuiltin = readUserLockedBuiltinCallAudioRoute();
  if (lockedBuiltin) return lockedBuiltin;
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
  try {
    if (readNativeProbedExternalRoute() === route) return true;
    const lastApplied = readLastAppliedCallAudioRoute();
    if (lastApplied === route && isOngoingCallSession()) return true;
    const g = global as any;
    if (shouldPreserveCallAudioRouteInInAppPiP() || isInAppPiPContextIncludingSuspended()) return true;
    if (g.__pipInSystemModeRef?.current === true) return true;
    if (readActiveExternalCallAudioRoute() === route) return true;
  } catch {}
  return false;
}

function coercePersistedRouteForAvailableDevices(route: InCallAudioRoute): InCallAudioRoute {
  try {
    const list = readAvailableAudioDeviceList();
    if (!list.length) return route;
    if (!list.includes(route) && shouldKeepExternalRouteDespiteMissingFromList(route)) {
      return route;
    }
    if (route === 'BLUETOOTH' && !list.includes('BLUETOOTH')) {
      if (readNativeProbedExternalRoute() === 'BLUETOOTH') return route;
      return resolveCallRouteAfterHeadsetDisconnect();
    }
    if (route === 'WIRED_HEADSET' && !list.includes('WIRED_HEADSET')) {
      if (readNativeProbedExternalRoute() === 'WIRED_HEADSET') return route;
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
let scheduledReapplyTimers: ReturnType<typeof setTimeout>[] = [];
let lastReapplySignature = '';
let lastReapplyAt = 0;
let lastNativeInCallSignature = '';
const REAPPLY_DEDUP_MS = 900;

function isHonorUserRouteReason(reason: string): boolean {
  if (
    reason === 'in_app_pip_audio_route_toggle' ||
    reason === 'return_to_audio_ui' ||
    reason === 'direct_call_video_ui_route' ||
    reason === 'system_pip_enter_preserve_headset'
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

async function applyNativeOutputRoute(
  route: InCallAudioRoute,
  media: 'audio' | 'video',
  opts: { forceBuiltIn?: boolean },
): Promise<void> {
  const forceBuiltIn = !!opts.forceBuiltIn;
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

function clearScheduledReapplies(): void {
  for (const t of scheduledReapplyTimers) {
    try {
      clearTimeout(t);
    } catch {}
  }
  scheduledReapplyTimers = [];
}

export async function reapplyPersistedCallAudioRoute(
  reason: string,
  opts?: { media?: 'audio' | 'video'; honorUserRoute?: boolean; skipInCallRestart?: boolean },
): Promise<void> {
  reapplyChain = reapplyChain
    .then(async () => {
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
          route = liveExt;
          setPersistedCallAudioRoute(liveExt);
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
        await applyNativeOutputRoute(route, media, { forceBuiltIn: false });
        lastNativeInCallSignature = signature;
        logger.info('[callAudioRoutePersist] reapply headset light', { reason, route, media });
        return;
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
      scheduledReapplyTimers.push(t);
    }
    return;
  }
  if (reason === 'audio_home_loud_speaker' && !shouldApplyHomeLoudSpeakerPin()) {
    schedulePreserveCallAudioRoute('audio_home_preserve_route', opts?.media);
    return;
  }
  clearScheduledReapplies();
  const defaultDelays =
    reason === 'in_app_pip_audio_route_toggle'
      ? [0]
      : /^in_app_pip_from_|system_pip_|video_call_return_from_pip|return_to_audio_ui|direct_call_video/.test(reason)
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
      scheduledReapplyTimers = scheduledReapplyTimers.filter((t) => t !== timer);
      void reapplyPersistedCallAudioRoute(reason, reapplyOpts);
    }, ms);
    scheduledReapplyTimers.push(timer);
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
  setPersistedCallAudioRoute(route);
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
